import { createHmac, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { BufferedEvent } from "../static/types";

const gzipAsync = promisify(gzip);

type Batch = { body: Buffer };

/**
 * Talks to the ingest server: fetches the bot's salt, builds gzipped batches, retries failed ones.
 * Never throws; every failure is kept for retry or silently dropped.
 */
export class Transport {
  private salt?: Buffer;
  /** A batch that failed with a retryable error; resent as-is (same batch_id) so the server dedupes it. */
  private pending?: Batch;
  private warnedKey = false;

  constructor(
    private readonly endpoint: string,
    private readonly key: string,
  ) {}

  get ready() {
    return this.salt !== undefined;
  }

  get hasPending() {
    return this.pending !== undefined;
  }

  /** Fetches the per-bot salt for hashing user IDs. Retried on the next flush if it fails. */
  async fetchSalt() {
    if (this.salt) return;
    const res = await this.request("/v1/config", { method: "GET" });
    if (res?.ok) this.salt = Buffer.from(((await res.json()) as { salt: string }).salt, "hex");
  }

  /** Builds a batch from these events. Raw user IDs are hashed here and never leave the process. */
  async build(events: BufferedEvent[], dropped: number) {
    const salt = this.salt!;
    const wire = events.map(({ user_id, ...e }) =>
      user_id ? { ...e, user_hash: createHmac("sha256", salt).update(user_id).digest("hex") } : e,
    );
    const json = JSON.stringify({ batch_id: randomUUID(), dropped, events: wire });
    this.pending = { body: await gzipAsync(json) };
  }

  /** Sends the pending batch. @returns true when it was delivered or rejected for good. */
  async sendPending() {
    if (!this.pending) return true;
    const res = await this.request("/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: this.pending.body,
    });
    // Retry on network errors, 5xx and 429; any other 4xx will never succeed, so drop the batch.
    if (!res || res.status >= 500 || res.status === 429) return false;
    this.pending = undefined;
    return true;
  }

  private async request(path: string, init: RequestInit) {
    try {
      const res = await fetch(new URL(path, this.endpoint), {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${this.key}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401 && !this.warnedKey) {
        this.warnedKey = true;
        console.warn("[data-cord] API key rejected; analytics are not being recorded.");
      }
      return res;
    } catch {
      return undefined;
    }
  }
}
