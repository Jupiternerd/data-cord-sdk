# data-cord-sdk

Analytics SDK for Discord bots (discord.js 14). Hooks the bot's gateway and REST traffic, strips sensitive fields, and sends batches to the data-cord ingest server.

```js
import { init } from "data-cord-sdk";

init(client, { key: process.env.DATACORD_KEY, endpoint: "https://ingest.example.com" });
```

Call it once per client, before `client.login()`. Each shard process calls it for its own client.

## What is sent

| Event | Fields |
|---|---|
| `GUILD_CREATE` | server ID, name, member count, `joined_at` |
| `GUILD_UPDATE` | server ID, name |
| `GUILD_DELETE` | server ID, whether it was an outage (`unavailable`) |
| `INTERACTION_CREATE` | server ID, hashed user ID, interaction ID and type, command path (`settings set`), component type |
| `REST` (each request discord.js makes) | method, route with IDs and tokens replaced (`/channels/:id/messages`), status, latency |
| `RATE_LIMIT` | method, route, global, scope, retry after |

Every event also carries a timestamp and the shard ID.

**Never sent:** message content, usernames, nicknames, interaction tokens, command option values, component custom IDs, any other event type. User IDs are hashed with a per-bot salt before they leave the process.

## Behaviour

- Events are buffered in memory and sent as one gzipped batch every 10s, or as soon as 1000 are waiting.
- If the server is unreachable, batches are retried. When the buffer is full (10 000 events by default), the oldest events are dropped and the drop count is reported.
- The SDK never throws into your bot and never keeps the process alive. Call `await tracker.stop()` on shutdown to send what is left.
