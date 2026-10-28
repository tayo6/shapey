# Shapey multiplayer Worker

This folder contains the Cloudflare Worker and Durable Object source for Shapey's online rooms and audience experience. The Worker is authoritative for online boards, scores, turn order, deadlines, hazards, room membership, polls, and reconnect state.

## Supported room types and rules

- **Player 1 vs Player 2:** two separate devices; first side to **50 points** wins; a normal player turn has a 45-second deadline.
- **Tag: 2 vs 2:** four separate devices; Team 1 is Players 1 + 2 and Team 2 is Players 3 + 4; partners rotate **P1 → P3 → P2 → P4**; first team to **100 points** wins; each player turn has a 30-second deadline. Tag uses a 7×7 board.
- **AI-vs-AI audience demo:** a server-run sample match for spectators, with a deliberately short target of 10 points and a **five-second turn deadline**. This demo target is not the Player 1 vs Player 2 target.
- **Play Alone and Player vs AI:** local client modes; the Worker is not the authority for these local games.

The opening study phase is 15 seconds. Newly spawned tiles are revealed for 5 seconds before they flip down and shuffle. Audience polls run for 30 seconds and are limited to three free uses per player per game; polls are not purchasable with Stars. A Hazard always destroys itself and all selected tiles, including Dummies. Online modes do not lose points for a Hazard; only Play Alone applies the one-point penalty.

The server hides unrevealed tile shapes from player and spectator snapshots. WebSocket handshakes validate the request origin and apply Cloudflare rate limits. New sockets must join within 10 seconds; unjoined sockets do not occupy player seats. A returning player presenting the valid saved seat token can reclaim the seat and close a stale socket. Ping/pong keepalives do not persist room activity, room activity timestamps are persisted at most once a minute, and unchanged alarms are not rewritten. Chat messages have a 1.5-second per-connection cooldown.

Waiting rooms are not published in the public directory; players can still join via a valid invite code. Room creation uses expiring reservations in the directory Durable Object and is capped at 100 active rooms, including AI demos, with at most 10 active demos. A demo stops itself 60 seconds after its last spectator leaves, or 60 seconds after creation if nobody starts watching. Public room-list reads are limited to about 60 per minute per client prefix, room-info lookups to 120 per minute, and WebSocket upgrades to 120 per minute. Cloudflare also provides a 5-per-minute room-creation burst limit. A stricter transactional guard caps room creation at five per 10 minutes per hashed IPv4 address or IPv6 /64. Cloudflare's binding limits are approximate and per location; the 100-room transactional cap is the global capacity guardrail. The origin check is a browser-abuse barrier, not authentication or full DDoS protection. API failures are returned as JSON 503 responses instead of raw runtime error pages.

The public audience-preview Worker is now static-only: it proxies static files from GitHub Pages but returns HTTP 410 for API and WebSocket paths, so it no longer relays multiplayer traffic into staging.

## Local tests

Use Node.js 22 or later. From this folder, install the pinned dependencies and run the Worker unit tests:

```sh
npm ci
npm test
```

The browser smoke tests use Playwright. Install Chromium once:

```sh
npx playwright install chromium
```

To run the Worker locally, start this from the `worker/` folder:

```sh
npx --yes wrangler@4.151.0 dev --config wrangler.jsonc --local --ip 127.0.0.1 --port 8787
```

In another terminal, serve the repository root on port 8080:

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory .
```

From `worker/`, the local Worker suites are:

- `node integration-smoke.mjs` — Worker policy, scoring, polls, chat, and reconnects.
- `node browser-smoke.mjs` — two-browser Player 1 vs Player 2.
- `node tag-browser-smoke.mjs` — four-browser Tag and P1 → P3 → P2 → P4 rotation.
- `node clock-skew-smoke.mjs` — correct display of turn, study, poll, and movement timers on devices with clocks skewed by +25 and −25 seconds.
- `node audience-smoke.mjs` — local audience directory, spectating, chat, Tag roster, poll expiry, reconnects, root `?watch=` redirection, and the five-second demo deadline.

The room-creation rate limit is shared within a local Worker instance. The CI workflow runs the clock-skew and audience browser suites in a separate job with fresh Worker state.

## Deployment status and release checks

On 2026-10-28, the hardening modules from `main` were uploaded to both existing Cloudflare Workers, `shapey-multiplayer-staging` and `shapey-multiplayer`. The Cloudflare API accepted both uploads and their settings were checked afterward. Both retain their original `ROOMS` Durable Object namespace; no new Durable Object migration was requested. The staging Worker has sampled traces enabled; production traces remain disabled to avoid unnecessary observability overhead while the account's plan is unconfirmed.

The deployed `shapey-audience-preview` Worker has also been changed to the source-controlled static-only implementation. The preview source and configuration now live at `worker/src/preview.js` and `worker/wrangler.preview.jsonc`.

Worker uploads are not automatically triggered by repository changes. The CI workflows now run on pushes to `main` and cover local Worker tests, bundle/config validation, the hosted preview relay check, and deployed health/smoke checks. Do not announce unrestricted public promotion until the latest CI runs are green and the remaining two-device Player 1 vs Player 2 and four-device Tag checks have been performed.

Automated browser tests do not replace the remaining real-device check: Player 1 vs Player 2 should be tested on two separate devices and Tag on four separate devices before declaring multiplayer fully verified.
