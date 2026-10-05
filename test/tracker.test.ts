import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Client } from "discord.js";
import { init } from "../src";

const SALT = "07".repeat(32);
const TOKEN = "aW50ZXJhY3Rpb246MTIzOlNFQ1JFVA";
const GUILD = "123456789012345678";
const USER = "222222222222222222";
const INTERACTION = "333333333333333333";

// Stub ingest server: records every batch it receives.
type Batch = { batch_id: string; dropped: number; events: Record<string, unknown>[] };
let batches: Batch[] = [];
let ingestStatus = 200;
const ingest = Bun.serve({
  port: 0,
  routes: {
    "/v1/config": () => Response.json({ salt: SALT }),
    "/v1/events": {
      POST: async (req) => {
        batches.push(JSON.parse(gunzipSync(Buffer.from(await req.arrayBuffer())).toString()));
        return Response.json({}, { status: ingestStatus });
      },
    },
  },
});
afterAll(() => ingest.stop());

// A discord.js client that never logs in; REST goes to a fake makeRequest instead of Discord.
let client: Client;
let tracker: ReturnType<typeof init>;
const fakeResponse = () => ({
  status: 200,
  ok: true,
  statusText: "OK",
  headers: new Headers({ "content-type": "application/json" }),
  body: null,
  bodyUsed: false,
  json: async () => ({}),
  text: async () => "{}",
  arrayBuffer: async () => new ArrayBuffer(0),
});

function start(options: { endpoint?: string; maxBuffer?: number } = {}) {
  client = new Client({ intents: [] });
  client.rest.setToken("bot-token");
  client.rest.options.makeRequest = async () => fakeResponse();
  tracker = init(client, { key: "dc_test", endpoint: ingest.url.href, flushInterval: 60_000, ...options });
}
const raw = (t: string, d: unknown, shard = 0) => client.emit("raw" as never, { op: 0, t, d } as never, shard as never);
const sent = () => batches.flatMap((b) => b.events);

beforeEach(() => {
  batches = [];
  ingestStatus = 200;
  start();
});
afterEach(() => tracker.stop());

test("GUILD_CREATE keeps only allow-listed fields", async () => {
  raw(
    "GUILD_CREATE",
    { id: GUILD, name: "Test", member_count: 42, joined_at: "2026-01-01T00:00:00Z", channels: [{}], members: [{}] },
    3,
  );
  await tracker.flush();
  expect(sent()).toEqual([
    {
      type: "GUILD_CREATE",
      ts: expect.any(Number),
      shard_id: 3,
      guild_id: GUILD,
      data: { name: "Test", member_count: 42, joined_at: "2026-01-01T00:00:00Z" },
    },
  ]);
});

test("GUILD_DELETE marks outages", async () => {
  raw("GUILD_DELETE", { id: GUILD, unavailable: true });
  raw("GUILD_DELETE", { id: GUILD });
  await tracker.flush();
  expect(sent().map((e) => e.data)).toEqual([{ unavailable: true }, { unavailable: false }]);
});

test("interactions: token, option values and raw user IDs never leave the bot", async () => {
  raw("INTERACTION_CREATE", {
    id: INTERACTION,
    type: 2,
    token: TOKEN,
    guild_id: GUILD,
    member: { user: { id: USER, username: "someone" }, nick: "nick" },
    data: {
      name: "settings",
      options: [{ type: 1, name: "set", options: [{ type: 3, name: "v", value: "secret text" }] }],
    },
  });
  await tracker.flush();

  const body = JSON.stringify(batches);
  for (const secret of [TOKEN, USER, "secret text", "someone", "nick"]) expect(body).not.toContain(secret);
  expect(sent()[0]).toMatchObject({
    user_hash: createHmac("sha256", Buffer.from(SALT, "hex")).update(USER).digest("hex"),
    data: { interaction_id: INTERACTION, interaction_type: 2, command: "settings set" },
  });
});

test("REST calls are recorded with tokens stripped from the route", async () => {
  await client.rest.post(`/interactions/${INTERACTION}/${TOKEN}/callback`, { body: { type: 4 }, auth: false });
  await client.rest.get(`/channels/${GUILD}/messages`);
  await tracker.flush();

  expect(JSON.stringify(batches)).not.toContain(TOKEN);
  expect(sent().map((e) => e.data)).toEqual([
    {
      method: "POST",
      route: "/interactions/:id/:param/callback",
      status: 200,
      latency_ms: expect.any(Number),
      interaction_id: INTERACTION,
    },
    { method: "GET", route: "/channels/:id/messages", status: 200, latency_ms: expect.any(Number) },
  ]);
});

test("unused event types are dropped in the SDK", async () => {
  raw("MESSAGE_CREATE", { content: "hello", author: { id: USER } });
  raw("PRESENCE_UPDATE", { user: { id: USER } });
  await tracker.flush();
  expect(batches).toEqual([]);
});

test("a failed batch is retried with the same batch_id", async () => {
  ingestStatus = 500;
  raw("GUILD_DELETE", { id: GUILD });
  await tracker.flush();
  ingestStatus = 200;
  await tracker.flush();
  expect(batches).toHaveLength(2);
  expect(batches[1]!.batch_id).toBe(batches[0]!.batch_id);
  await tracker.flush();
  expect(batches).toHaveLength(2); // delivered, nothing left
});

test("a full buffer drops the oldest events and reports the count", async () => {
  await tracker.stop();
  start({ maxBuffer: 10 });
  for (let i = 0; i < 15; i++) raw("GUILD_UPDATE", { id: GUILD, name: `n${i}` });
  await tracker.flush();
  expect(batches[0]!.dropped).toBe(5);
  expect(sent().at(-1)!.data).toEqual({ name: "n14" });
});

test("an unreachable server never breaks the bot", async () => {
  await tracker.stop();
  start({ endpoint: "http://127.0.0.1:1" });
  raw("GUILD_CREATE", { id: GUILD });
  expect(await client.rest.get(`/channels/${GUILD}`)).toEqual({});
  await tracker.flush(); // resolves, does not throw
});

test("stop() restores discord.js's makeRequest", async () => {
  const wrapped = client.rest.options.makeRequest;
  await tracker.stop();
  expect(client.rest.options.makeRequest).not.toBe(wrapped);
  start(); // can attach again after stopping
});
