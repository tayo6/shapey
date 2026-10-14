# Shapey multiplayer Worker

This directory contains the source retrieved from the deployed `shapey-multiplayer` Cloudflare Worker and the Wrangler configuration for its existing `ROOMS` Durable Objects class.

## Current development-branch scope

The `feat/authoritative-online-gameplay` branch now contains an early authoritative game-state engine, Worker WebSocket wiring, and a Phaser client integration for the existing online-only modes:
- PvP: 2 devices, target 100.
- Tag: 4 devices; Team 1 = Players 1 and 2, Team 2 = Players 3 and 4; turn order P1 → P3 → P2 → P4; target 200.
- The server owns the canonical board, active turn, score, hazards, timeout resolution, and the currently supported Extra Time and Double Play actions.
- Hidden tile shapes are omitted from player snapshots while tiles are face-down.

This is **not yet approved for release**. Browser/two-device end-to-end and staging tests have not been completed. Reconnection can return the current board, but stable player-seat identity after reconnect is not yet implemented. Room-creation abuse controls and full game integration tests remain outstanding. Audience Poll, Score Strike, Cancel Counter, spectators and chat are not implemented online. The live deployed Worker remains the older lobby prototype until a separately reviewed deployment is completed.

## Changes in this source-controlled version

- The Worker module was retrieved from the live Cloudflare script and brought under version control before deployment changes.
- WebSocket handshakes explicitly validate the `Origin` header against the same allowlist used for CORS.
- WebSocket messages are capped at 4 KiB and throttled to 60 messages per connection per 10-second window; the first message beyond this limit closes that socket.
- Empty rooms expire after 30 minutes of inactivity. Rooms have a six-hour hard maximum lifetime. Expiry uses Durable Object alarms; the idle timeout does not remove active connected rooms.
- Existing mode capacities remain unchanged: PvP = 2; Tag = 4. No new game mode is introduced.

## Local tests

Requires Node.js 20 or later; no external test package is needed:

```sh
npm test
```

Tests cover origin allowlisting, supported modes/capacities, room-code format, and the expiry policy. They do not replace end-to-end tests against a local Worker runtime.

## Existing Cloudflare binding

`wrangler.jsonc` records the existing Worker name, Durable Object binding name/class, compatibility date, and migration tag observed on the deployed script. It uses Wrangler's legacy `migrations` configuration to match the existing `v1` class migration. **This PR does not deploy it.** Before any future deployment, verify Wrangler's remote migration comparison and dry-run output. Stop if Wrangler proposes creating a replacement namespace, creating a new migration, or deleting/migrating existing state unexpectedly.

Before a future production deployment:
1. Run the local tests and config validation.
2. Inspect the Wrangler dry-run/binding plan and verify the existing `ROOMS` namespace is reused without creating a new migration.
3. Run integration smoke tests in a staging Worker using two PvP clients and four Tag clients.
4. Deploy production only after gameplay, reconnection, lifecycle, and regression tests are passing.

Never put API tokens or secret values in this directory.
