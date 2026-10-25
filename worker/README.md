# Shapey multiplayer Worker

This folder contains the Cloudflare Worker and Durable Object source for Shapey's online rooms and audience experience. The Worker is authoritative for online boards, scores, turn order, deadlines, hazards, room membership, polls, and reconnect state.

## Supported room types and rules

- **Player 1 vs Player 2:** two separate devices; first side to **50 points** wins; a normal player turn has a 45-second deadline.
- **Tag: 2 vs 2:** four separate devices; Team 1 is Players 1 + 2 and Team 2 is Players 3 + 4; partners rotate **P1 → P3 → P2 → P4**; first team to **100 points** wins; each player turn has a 30-second deadline. Tag uses a 7×7 board.
- **AI-vs-AI audience demo:** a server-run sample match for spectators, with a deliberately short target of 10 points and a **five-second turn deadline**. This demo target is not the Player 1 vs Player 2 target.
- **Play Alone and Player vs AI:** local client modes; the Worker is not the authority for these local games.

The opening study phase is 15 seconds. Newly spawned tiles are revealed for 5 seconds before they flip down and shuffle. Audience polls run for 30 seconds and are limited to three free uses per player per game; polls are not purchasable with Stars. A Hazard always destroys itself and all selected tiles, including Dummies. Online modes do not lose points for a Hazard; only Play Alone applies the one-point penalty.

The server hides unrevealed tile shapes from player and spectator snapshots. WebSocket handshakes validate the request origin, messages are size- and rate-limited, room creation is limited to five requests per client IP per rolling 10 minutes, and inactive rooms expire. The origin check is a browser-abuse barrier, not authentication or full DDoS protection.

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

On 2026-10-25, the tested Worker modules from `main` were uploaded to both existing Cloudflare Workers: `shapey-multiplayer-staging` and `shapey-multiplayer`. Both deployments are at 100% traffic and retain their existing `ROOMS` Durable Object namespace; no new Durable Object migration was applied. The upload used the same module source as the passing local Worker/browser CI checks.

GitHub Pages deploys automatically from `main`, but Cloudflare Worker uploads are **not** automatically triggered by repository changes. For future Worker changes, run the local tests and Wrangler dry run, then deploy to staging first and verify it before promoting the same tested source to production. Do not point staging pages at the production Worker.

Automated browser tests do not replace the remaining real-device check: Player 1 vs Player 2 should be tested on two separate devices and Tag on four separate devices before declaring multiplayer fully verified.
