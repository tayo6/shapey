# Shapey multiplayer staging

This configuration is intentionally isolated from production.

- Worker name: `shapey-multiplayer-staging`
- Durable Object binding: `ROOMS`
- Durable Object class: `Room`
- Migration: a new `v1` SQLite-backed `Room` class for this new Worker only
- No production Worker name or production namespace ID is referenced here.

## Deploy to staging

From the `worker/` directory, with Wrangler authenticated to the Shapey Cloudflare account:

```sh
npx wrangler@4.151.0 deploy --config wrangler.staging.jsonc
```

Do not change `wrangler.jsonc` for this staging task and do not deploy it. That file names the live `shapey-multiplayer` Worker and its existing `ROOMS` namespace.

## Checks after staging deploy

1. Open `https://shapey-multiplayer-staging.<account-subdomain>.workers.dev/health`; it must report `protocolVersion: 1`.
2. Verify room creation, PvP with two separate clients, and Tag with four separate clients.
3. Verify turn order, score updates, hidden tile privacy, reconnect, out-of-turn rejection, and room expiry.
4. Keep production unchanged until the staging frontend and real-device tests pass.

The staging Worker is not a production release. It may create isolated test rooms and staging storage only.
