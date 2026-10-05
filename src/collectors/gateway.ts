import type { BufferedEvent, Json } from "../static/types";

// biome-ignore lint/suspicious/noExplicitAny: raw gateway payloads are untyped JSON
type Payload = { t?: string | null; d?: any };

/**
 * Turns a raw gateway dispatch into a buffered event, keeping only allow-listed fields.
 * @returns undefined for event types data-cord does not use (messages, presences, ...).
 */
export function fromGateway(packet: Payload, shardId: number): BufferedEvent | undefined {
  const d = packet.d;
  const base = { type: packet.t as string, ts: Date.now(), shard_id: shardId };

  switch (packet.t) {
    case "GUILD_CREATE":
      // joined_at lets the server tell a new install from a reconnect, and backfill tenure.
      return { ...base, guild_id: d.id, data: { name: d.name, member_count: d.member_count, joined_at: d.joined_at } };
    case "GUILD_UPDATE":
      return { ...base, guild_id: d.id, data: { name: d.name } };
    case "GUILD_DELETE":
      // unavailable: true is an outage, not a removal.
      return { ...base, guild_id: d.id, data: { unavailable: d.unavailable === true } };
    case "INTERACTION_CREATE":
      // The interaction token, option values and custom_ids are never read.
      return {
        ...base,
        guild_id: d.guild_id ?? undefined,
        user_id: d.member?.user?.id ?? d.user?.id,
        data: {
          interaction_id: d.id,
          interaction_type: d.type,
          command: commandPath(d.data),
          component_type: d.data?.component_type ?? null,
        },
      };
  }
}

/** "settings", "settings set" or "settings role add": command name plus subcommand group/subcommand. */
// biome-ignore lint/suspicious/noExplicitAny: see Payload
function commandPath(data: any): Json {
  if (typeof data?.name !== "string") return null;
  const path = [data.name];
  let option = data.options?.[0];
  while (option && (option.type === 1 || option.type === 2)) {
    path.push(option.name);
    option = option.options?.[0];
  }
  return path.join(" ");
}
