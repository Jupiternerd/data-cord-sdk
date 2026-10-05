import type { EventEmitter } from "node:events";
import type { Client, RateLimitData, RESTOptions } from "discord.js";
import { fromGateway } from "./collectors/gateway";
import { fromRateLimit, fromResponse } from "./collectors/rest";
import type { BufferedEvent, Options } from "./static/types";
import { EventBuffer } from "./utils/buffer";
import { Transport } from "./utils/transport";

const BATCH_SIZE = 1000; // events per request; the server accepts up to 5000
const attached = new WeakSet<Client>();

/**
 * Attaches to a bot's existing discord.js client, collects allow-listed events and ships them to ingest.
 * Nothing in here may throw into the bot: every hook is wrapped and every failure is swallowed.
 */
export default class Tracker {
  private readonly buffer: EventBuffer;
  private readonly transport: Transport;
  private timer?: ReturnType<typeof setInterval>;
  private flushing?: Promise<void>;
  private originalMakeRequest?: RESTOptions["makeRequest"];
  private wrappedMakeRequest?: RESTOptions["makeRequest"];

  // biome-ignore lint/suspicious/noExplicitAny: raw gateway payloads are untyped JSON
  private readonly onRaw = (packet: any, shardId: number) => this.collect(() => fromGateway(packet, shardId));
  private readonly onRateLimited = (info: RateLimitData) => this.collect(() => fromRateLimit(info));

  constructor(
    private readonly client: Client,
    private readonly options: Options,
  ) {
    if (!options?.key || !options.endpoint) throw new TypeError("data-cord: init() needs { key, endpoint }");
    this.buffer = new EventBuffer(options.maxBuffer ?? 10_000);
    this.transport = new Transport(options.endpoint, options.key);
  }

  /** Hooks the gateway and REST, then starts the flush timer. */
  activate() {
    if (attached.has(this.client)) throw new Error("data-cord: already attached to this client");
    attached.add(this.client);

    // "raw" fires for every gateway dispatch before discord.js handles it; it is not in ClientEvents' types.
    (this.client as unknown as EventEmitter).on("raw", this.onRaw);
    this.client.rest.on("rateLimited", this.onRateLimited);
    this.wrapMakeRequest();

    this.timer = setInterval(() => void this.flush(), this.options.flushInterval ?? 10_000);
    this.timer.unref(); // never keep the bot process alive
    void this.transport.fetchSalt();
    return this;
  }

  /** Detaches every hook and sends what is still buffered. */
  async stop() {
    clearInterval(this.timer);
    (this.client as unknown as EventEmitter).off("raw", this.onRaw);
    this.client.rest.off("rateLimited", this.onRateLimited);
    // Only unwrap if nobody wrapped makeRequest after us.
    if (this.client.rest.options.makeRequest === this.wrappedMakeRequest)
      this.client.rest.options.makeRequest = this.originalMakeRequest!;
    attached.delete(this.client);
    await this.flush();
  }

  /** Sends buffered events now. Concurrent calls share one run. */
  flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async drain() {
    try {
      await this.transport.fetchSalt();
      if (!this.transport.ready) return; // no salt yet: user IDs can't be hashed, so keep buffering
      while (true) {
        if (!this.transport.hasPending) {
          if (this.buffer.length === 0 && this.buffer.dropped === 0) return;
          const { events, dropped } = this.buffer.take(BATCH_SIZE);
          await this.transport.build(events, dropped);
        }
        if (!(await this.transport.sendPending())) return; // retry on the next tick
      }
    } catch {
      // never surface into the bot
    }
  }

  /** Buffers an event; a bug in mapping must never reach the bot. */
  private collect(make: () => BufferedEvent | undefined) {
    try {
      const event = make();
      if (!event) return;
      this.buffer.push(event);
      if (this.buffer.length >= BATCH_SIZE) void this.flush();
    } catch {
      // ignore
    }
  }

  /** Times every network attempt discord.js makes. The response itself is passed through untouched. */
  private wrapMakeRequest() {
    const original = this.client.rest.options.makeRequest;
    this.originalMakeRequest = original;
    this.wrappedMakeRequest = async (url, init) => {
      const start = performance.now();
      let status = 0; // 0 = network error or timeout
      try {
        const res = await original(url, init);
        status = res.status;
        return res;
      } finally {
        this.collect(() => fromResponse(url, init.method ?? "GET", status, performance.now() - start));
      }
    };
    this.client.rest.options.makeRequest = this.wrappedMakeRequest;
  }
}
