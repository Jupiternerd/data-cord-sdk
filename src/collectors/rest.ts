import type { RateLimitData } from "discord.js";
import type { BufferedEvent } from "../static/types";

/**
 * Generalises a REST path so no tokens or user content can leave the bot.
 * Allow-list per segment: literal words stay, numeric IDs become :id, anything else becomes :param.
 * /interactions/123/aW50…/callback → /interactions/:id/:param/callback
 */
export function normalizeRoute(path: string) {
  return path
    .split("?")[0]!
    .split("/")
    .map((seg) => (seg === "" || /^:?[a-z@_-]+$/.test(seg) ? seg : /^\d+$/.test(seg) ? ":id" : ":param"))
    .join("/");
}

/** One network attempt made by discord.js (retries are separate events). */
export function fromResponse(url: string, method: string, status: number, latencyMs: number): BufferedEvent {
  const path = new URL(url).pathname.replace(/^\/api\/v\d+/, "");
  // Kept so the server can tell whether the bot answered an interaction, and how fast.
  const interactionId = /^\/interactions\/(\d+)\//.exec(path)?.[1];
  return {
    type: "REST",
    ts: Date.now(),
    data: {
      method: method.toUpperCase(),
      route: normalizeRoute(path),
      status,
      latency_ms: Math.round(latencyMs),
      ...(interactionId && { interaction_id: interactionId }),
    },
  };
}

export function fromRateLimit(info: RateLimitData): BufferedEvent {
  return {
    type: "RATE_LIMIT",
    ts: Date.now(),
    data: {
      method: info.method.toUpperCase(),
      route: normalizeRoute(info.route),
      global: info.global,
      scope: info.scope,
      retry_after_ms: info.retryAfter,
    },
  };
}
