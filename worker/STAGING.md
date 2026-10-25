# Shapey multiplayer environments

Shapey has separate production and staging Cloudflare Workers and Durable Object namespaces. The live game must use production; the staging test page must use staging.

## Current environment map

- **Live game:** https://tayo6.github.io/shapey/
- **Staging game page:** https://tayo6.github.io/shapey/staging/
- **Production Worker:** `shapey-multiplayer`
- **Production health check:** https://shapey-multiplayer.hellohuman100.workers.dev/health
- **Staging Worker:** `shapey-multiplayer-staging`
- **Staging health check:** https://shapey-multiplayer-staging.hellohuman100.workers.dev/health
- **Audience page:** `staging/audience.html`; live watch links use production by default, and links launched from the staging game carry `env=staging`.

On 2026-10-25, the same tested Worker modules from `main` were uploaded to both existing Workers. Cloudflare reports each deployment at 100% traffic. The upload retained each Worker’s existing `ROOMS` binding and Durable Object namespace; no new migration was applied. The two namespaces remain separate and do not share room storage.

The live game now defaults to the production Worker. The staging game sets `window.SHAPEY_ENV = { staging: true, memesStandardWindow: 3 }` and defaults to the staging Worker. The audience redirect preserves that environment so staging rooms do not accidentally use production. The test-only `?api=http://127.0.0.1:8787` override is for local browser tests.

## What to verify on real devices

Automated unit and browser tests pass against a local Worker, but this is not a replacement for testing on real devices:

1. Open the staging game page on two separate devices and play **Player 1 vs Player 2**.
2. Confirm turns alternate, both scores agree, and the non-active player cannot select tiles.
3. Open a Tag room on four separate devices. Confirm teams (Players 1 + 2 versus Players 3 + 4), shared team scores, and turn order P1 → P3 → P2 → P4.
4. Confirm hidden tiles stay hidden and test reconnecting a player to the same seat.
5. Test audience chat and polls from separate audience devices.

## Redeploying after future Worker changes

Worker source changes in GitHub do not automatically deploy to Cloudflare. From the `worker/` directory:

First test and deploy staging:

```sh
npm ci
npm test
npx wrangler@4.151.0 deploy --config wrangler.staging.jsonc --dry-run
npx wrangler@4.151.0 deploy --config wrangler.staging.jsonc
```

After the staging browser and real-device checks pass, deploy production with its own config:

```sh
npx wrangler@4.151.0 deploy --config wrangler.jsonc --dry-run
npx wrangler@4.151.0 deploy --config wrangler.jsonc
```

Never use the production config as a shortcut for staging tests. Keep the existing `ROOMS` namespace binding for each environment; do not re-create or migrate the Durable Object class unless the change explicitly requires it.
