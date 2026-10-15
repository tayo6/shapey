# Shapey multiplayer staging

This test environment is separate from production.

- **Staging game page:** https://tayo6.github.io/shapey/staging/
- **Staging Worker health check:** https://shapey-multiplayer-staging.hellohuman100.workers.dev/health
- **Staging Worker:** `shapey-multiplayer-staging`
- **Staging Durable Object namespace:** `shapey-multiplayer-staging_Room` (SQLite-backed)
- **Protocol:** version 1
- **Production Worker:** `shapey-multiplayer` — unchanged
- **Production Durable Object namespace:** `shapey-multiplayer_Room` — unchanged

The staging game page is an additional path on the site's static hosting. The existing home page and `src/main.js` are not changed; only `staging/main.js` points to the staging Worker. The staging Worker has its own namespace and does not share game-room storage with production.

## What to test

1. Open the staging game page on two different devices and play **Player 1 vs Player 2**.
2. Confirm turns alternate, scores agree on both devices, and the other player's turn cannot be played.
3. Open a fresh Tag room on four devices. Confirm team scores and turn order: P1 → P3 → P2 → P4.
4. Confirm a face-down tile does not reveal its shape, then test reconnecting a player to the same seat.
5. Leave the normal game home page untouched during these tests.

The review branch now adds a public Live Games directory at `/api/rooms` (GET), read-only spectator WebSockets, room chat, and live Tag audience polls. The staging audience page is `staging/audience.html`; it displays the board without hidden tile identities, lists available PvP/Tag rooms, lets spectators chat and vote while a Tag poll is open, and links directly to individual rooms. These features are source-controlled and covered by local Worker integration/CI, but must still be deployed to the staging Worker before the public directory can work there. Score Strike and Cancel Counter remain unsupported online.

## Redeploy staging

From the `worker/` directory, with Wrangler authenticated to the Shapey Cloudflare account:

```sh
npx wrangler@4.151.0 deploy --config wrangler.staging.jsonc
```

Do not deploy `wrangler.jsonc` for this task. It names the live `shapey-multiplayer` Worker and its existing `ROOMS` namespace. The staging config uses a separate Worker name and has its own new `v1` SQLite migration.

The staging Worker is not a production release. Use it only for testing; it may create isolated test rooms and staging storage.
