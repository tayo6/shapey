# Shapey multiplayer Worker

This directory contains the source for the deployed `shapey-multiplayer` Cloudflare Worker and its existing `ROOMS` Durable Objects namespace.

## Current scope

The service is still a **room/lobby prototype**, not a playable online game. It supports room creation for the existing `pvp` (2-player) and `tag` (4-player) modes, room status, WebSocket joins, player assignment, `ping`/ready notifications, and disconnect notifications. It does **not** yet synchronize board actions, turn order, scoring, hazards, Double Play, inventory, chat, spectators, or polls. Do not advertise online gameplay as complete until the authoritative game protocol and client integration are implemented and tested.

## Changes in this source-controlled version

- The Worker module was retrieved from the live Cloudflare script and brought under version control before deployment changes.
- WebSocket handshakes explicitly validate the `Origin` header against the same allowlist used for CORS.
- Empty rooms expire after 30 minutes of inactivity. Rooms have a six-hour hard maximum lifetime. Expiry uses Durable Object alarms; the idle timeout does not remove active connected rooms.
- Existing mode capacities remain unchanged: PvP = 2; Tag = 4. No new game mode is introduced.

## Local tests

Requires Node.js 20 or later; no external test package is needed:

```sh
npm test
```

Tests cover origin allowlisting, supported modes/capacities, room-code format, and the expiry policy. They do not replace end-to-end tests against a local Worker runtime.

## Existing Cloudflare binding

`wrangler.jsonc` targets the existing Durable Objects namespace ID recorded on the deployed Worker. It is included for review and reproducibility; **this PR does not deploy it**.

Before a future deployment:
1. Run the local tests.
2. Inspect the Wrangler dry-run/binding plan and verify it reuses the existing `ROOMS` namespace without creating a second namespace or applying a new migration.
3. Run integration smoke tests in a staging Worker using two PvP clients and four Tag clients.
4. Deploy production only after gameplay, reconnection, lifecycle, and regression tests are passing.

Never put API tokens or secret values in this directory. The namespace ID is configuration metadata, not an API token.
