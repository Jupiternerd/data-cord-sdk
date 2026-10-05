import type { Client } from "discord.js";
import type { Options } from "./static/types";
import Tracker from "./tracker";

/**
 * Starts data-cord analytics on a discord.js client. Call once per client (each shard process calls it).
 * @example init(client, { key: process.env.DATACORD_KEY, endpoint: "https://ingest.example.com" })
 */
export function init(client: Client, options: Options) {
  return new Tracker(client, options).activate();
}

export type { Options, Tracker };
