/** Any JSON value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * An event waiting in the buffer. Holds the raw user ID (never sent);
 * the transport swaps it for user_hash when the batch is built.
 */
export type BufferedEvent = {
  type: string;
  ts: number; // epoch ms
  shard_id?: number;
  guild_id?: string;
  user_id?: string;
  data?: { [key: string]: Json };
};

export type Options = {
  /** API key from the data-cord dashboard. */
  key: string;
  /** Ingest server URL, e.g. https://ingest.example.com */
  endpoint: string;
  /** Max events held in memory while the server is unreachable. Oldest are dropped first. Default 10 000. */
  maxBuffer?: number;
  /** How often to send a batch, in ms. Default 10 000. */
  flushInterval?: number;
};
