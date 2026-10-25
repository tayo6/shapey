# Browser verification scripts

Four Playwright scripts that drive the real game in headless Chromium against a
locally served build. They are review tooling — they are **not** part of the
patch series and add nothing to the repository history; you copy them into a
checkout to run them and can delete them afterwards.

| Script | What it verifies | Needs | Result (rev 4) |
|---|---|---|---|
| `hazard-verify.mjs` | The agreed Hazard rules end-to-end in the real GameScene: (A) Play Alone first-pick Hazard = exactly -1, hazard destroyed, play continues; (B) Dummy then Hazard = exactly -1 more, both destroyed; (C) versus first-pick Hazard = 0 points, turn passes to the AI; (D) versus shapes+Hazard = 0 points, all picked destroyed, turn passes; plus zero uncaught page errors. 14 checks total. | static server :8080 | 14/14 PASS |
| `feature-verify.mjs` | The important features through the **real UI** (real canvas clicks): loading screen (markup, plank artwork reveal, clean handoff), menu + board-size selection (5x5 / 6x6 / 7x7 all through the picker), Play Alone scoring (+1 match, -1 wrong shape, refill), the falling spawn animation observed mid-refill, versus AI with a ticking countdown, turn hand-over, the AI's fixed ~5 s turn (easy + pro), zero page errors. 17 checks total. | static server :8080 | 17/17 PASS |
| `watch-verify.mjs` | The `?watch=CODE` spectating path (the reachable behaviour of patch 0004): creates an AI-vs-AI demo room through the Worker API, follows the redirect from `index.html?watch=CODE` to the audience wrapper, confirms the embedded iframe renders the live 49-tile match via postMessage snapshots and that the match progresses while watched. 5 checks total. | static server :8080 (backend: the deployed staging Worker — see note below) | 5/5 PASS |
| `audience-verify.mjs` | The audience `boardFootnote` TypeError fix and the ES-module split working together: board renders, a real audience poll opens, the poll footnote appears, zero page errors. | static server :8080 (backend: the deployed staging Worker — see note below) | PASS |

## Which backend do the scripts talk to?

- `hazard-verify.mjs` and `feature-verify.mjs` are **pure client** runs — only
  the static server is involved.
- The repo's own Worker suites (`worker/integration-smoke.mjs`,
  `browser-smoke.mjs`, `tag-browser-smoke.mjs`) run against the **local
  refactored Worker** (`wrangler dev` on :8787); see TEST-RESULTS.md §7.
- `watch-verify.mjs` and `audience-verify.mjs` exercise the **audience
  wrapper**, and `staging/audience/state.js` hardcodes its multiplayer API to
  the deployed staging Worker (`https://shapey-multiplayer-staging.hellohuman100.workers.dev`)
  and ignores `?api=` — on the live site and locally alike. These two scripts
  therefore create/watch rooms on that same deployed staging Worker, exactly
  like the page's own buttons do (`http://127.0.0.1:8080` is in the Worker's
  `ALLOWED_ORIGINS`). An earlier revision of this README wrongly claimed the
  audience script ran "against the local Worker" — corrected. No local Worker
  is needed for either script.

## Placement requirement (important)

All scripts import Playwright through a **repository-relative path**:

```js
import { chromium } from "../worker/node_modules/playwright/index.mjs";
```

That path is resolved relative to the script file's own location, so the
`verification/` folder must sit **inside the repository checkout, next to
`worker/`** — exactly as it does in this review package layout. Do not run the
scripts from an unrelated directory; the import would not resolve. This was
verified from a clean checkout: `cd worker && npm ci` (from the tracked
lockfile), then run the scripts — no absolute paths anywhere.

## How to run (from a clean checkout)

```bash
# 1. Clean checkout of main with the 11-patch series applied (see REVIEW.md),
#    then install the Worker dependencies (installs playwright 1.64.0):
cd worker && npm ci && npx playwright install chromium && cd ..

# 2. Copy this folder into the repo root:
cp -r /path/to/review-package/verification ./verification

# 3. Serve the repo root statically on :8080 (any static server works):
python3 -m http.server 8080 --bind 127.0.0.1 --directory . &

# 4. Client-side suites:
node verification/hazard-verify.mjs      # 14/14
node verification/feature-verify.mjs     # 17/17
node verification/watch-verify.mjs       # 5/5
node verification/audience-verify.mjs    # pass

# 5. Worker-side suites (keep servers and suites in one process lifetime, like CI):
cd worker
npx --yes wrangler@4.151.0 dev --config wrangler.jsonc --local --ip 127.0.0.1 --port 8787 &
node integration-smoke.mjs && node browser-smoke.mjs && node tag-browser-smoke.mjs
```

All scripts exit non-zero on any failed check and print one `PASS`/`FAIL`
line per check. `feature-verify.mjs` and `watch-verify.mjs` also save evidence
screenshots (`evidence-r4-*.png`) into the directory they are run from.

Note: `npm ci` installs the Playwright npm package; the Chromium binaries it
drives are cached per-user (default `~/.cache/ms-playwright`). If you have
never run Playwright on the machine, run `cd worker && npx playwright install chromium`
once beforehand (playwright 1.64.0 needs chromium build 1248).
