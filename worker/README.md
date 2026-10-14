# Shapey multiplayer Worker

This directory contains the source retrieved from the deployed `shapey-multiplayer` Cloudflare Worker and the Wrangler configuration for its existing `ROOMS` Durable Objects class.

## Current development-branch scope

The `feat/authoritative-online-gameplay` branch now contains an early authoritative game-state engine, Worker WebSocket wiring, and a Phaser client integration for the existing online-only modes:
- PvP: 2 devices, target 100.
- Tag: 4 devices; Team 1 = Players 1 and 2, Team 2 = Players 3 and 4; turn order P1 → P3 → P2 → P4; target 200.
- The server owns the canonical board, active turn, score, hazards, timeout resolution, and the currently supported Extra Time and Double Play actions.
- Hidden tile shapes are omitted from player snapshots while tiles are face-down.
- Room creation requires an allowed origin and is limited to 5 requests per client IP per rolling 10 minutes. This is a basic abuse barrier, not full DDoS protection.

This is **not yet approved for release**. CI now exercises the local Worker with two PvP clients and four Tag clients, and runs a local Playwright smoke test using two separate browser contexts. Those checks are not a substitute for real-device and staging tests. Reconnecting clients use a random per-room seat token: the browser stores the token locally and the Worker stores only its hash, so a returning player receives the same seat and current match state. If that browser storage is cleared or unavailable, the seat cannot be recovered; create a new room. A seat stays reserved for that room's lifetime. Audience Poll, Score Strike, Cancel Counter, spectators and chat are not implemented online. The live deployed Worker remains the older lobby prototype until a separately reviewed deployment is completed.

## Changes in this source-controlled version

- The Worker module was retrieved from the live Cloudflare script and brought under version control before deployment changes.
- New room seats receive 256-bit random reconnect tokens. Only SHA-256 token hashes are persisted in the Durable Object; the token is not placed in a URL. A reconnect with the token restores the original player number and the current match snapshot.
- WebSocket handshakes explicitly validate the `Origin` header against the same allowlist used for CORS.
- WebSocket messages are capped at 4 KiB and throttled to 60 messages per connection per 10-second window; the first message beyond this limit closes that socket.
- Empty rooms expire after 30 minutes of inactivity. Rooms have a six-hour hard maximum lifetime. Expiry uses Durable Object alarms; the idle timeout does not remove active connected rooms.
- Existing mode capacities remain unchanged: PvP = 2; Tag = 4. No new game mode is introduced.

## Local tests

Use Node.js 22 or later for the current Wrangler runtime. Install the test dependency once:

```sh
npm install --no-audit --no-fund
npm test
```

`npm test` runs the unit tests for protocol policy and (on the authoritative-gameplay branch) server game rules. To run the Worker WebSocket smoke test locally, start a local Worker in one terminal and run the smoke script in another:

```sh
npx --yes wrangler@4.151.0 dev --local --ip 127.0.0.1 --port 8787
node integration-smoke.mjs
```

The integration test exercises local PvP/Tag sockets, seat-token reconnect/state recovery, and does not deploy a Worker. CI also drives two browser contexts through a PvP match. Both run against a local Worker only. They still need to be complemented by real-device staging tests.

## Existing Cloudflare binding

`wrangler.jsonc` records the existing Worker name, Durable Object binding name/class, compatibility date, and an expected legacy `v1` SQLite-class migration. The live `ROOMS` namespace and its SQLite backing were read-only verified, but the exact remote migration tag could not be independently confirmed. **This PR does not deploy it.** Before any future deployment, verify Wrangler's remote migration comparison and dry-run output against the live account. Stop if Wrangler proposes creating a replacement namespace, creating a new migration, or deleting/migrating existing state unexpectedly.

Before a future production deployment:
1. Run the local tests and config validation.
2. Inspect the Wrangler dry-run/binding plan and verify the existing `ROOMS` namespace is reused without creating a new migration.
3. Run integration smoke tests in a staging Worker using two PvP clients and four Tag clients.
4. Deploy production only after gameplay, reconnection, lifecycle, and regression tests are passing.

Never put API tokens or secret values in this directory.
