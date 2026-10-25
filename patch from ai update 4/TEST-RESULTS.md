# Test results — revision 4 (full re-verification against the actual current `main`)

Every result below comes from an actual run performed on **2026-10-25 between
05:15 and 05:45 UTC** against a **brand-new clone of the current `main` branch**
(fetched from github.com/tayo6/shapey at 2026-10-25T05:15:51Z) with all 11
patches applied in order. Nothing is described as passed unless it ran and
exited 0; every command is listed verbatim so it can be reproduced. Two test
scripts needed in-flight corrections during this round (wrong-shape flow,
watch-path backend); the corrections and one earlier doc inaccuracy are
disclosed in section 10. Raw logs of every run are in `logs/`.

## Environment

| Item | Value |
|---|---|
| Upstream base commit | `6dd64903d903591047ae16f1b50f14e682bd5530` "Fix boot screen plank and synchronize loading artwork" — confirmed still the tip of `origin/main` by a fresh `git fetch` + fresh `git clone` at 2026-10-25T05:15:51Z (no earlier copy was assumed) |
| Patch series | 11 patches, `git am` applied in order 0001→0011 |
| Resulting tree | `1672727579b01a77fc26926b707b2723bef610dd` (bit-identical to the revision-3 verified build — patch application is reproducible) |
| Node | v24.21.0 |
| npm | 11.19.0 |
| Playwright | 1.64.0, chromium build 1248 (installed from `worker/package-lock.json` via `npm ci`, then `npx playwright install chromium` once) |
| Wrangler | 4.151.0 (pinned, same version as CI uses) |
| OS | Linux (Ubuntu-class container) |

## 1. Patch application against the actual current main (PASS)

```
git clone https://github.com/tayo6/shapey r4/patched
cd r4/patched && git config user.email "review@example.com" && git config user.name "Shapey Review"
git am /path/to/patches/00*.patch        # 11 patches in filename order
```

Result: **all 11 patches applied cleanly in order** — 11 `Applying:` lines, no
conflicts, no 3-way fallback. `git write-tree` of the result =
`1672727579b01a77fc26926b707b2723bef610dd`, identical to the revision-3 build,
proving the series applies reproducibly to the same tree. Nothing was merged,
pushed, branched or deployed; the clone lives in a scratch directory only.

## 2. The test totals, explained and reproduced (reviewer's point 2)

The previous report claimed 73 client + 37 Worker tests; an independent review
could not reproduce those totals. The reason is that **the totals depend on
which tree and which command you run**, and the two suites live in different
directories. All three readings below were measured in this round:

| Command | Where | Plain `main` | `main` + 11 patches |
|---|---|---|---|
| `node --test tests/*.test.js tests/*.test.mjs` (the CI command for client tests) | repo root | **73** pass | **73** pass |
| `npm test` (=`node --test`) (the CI command for Worker tests) | `worker/` | **36** pass | **37** pass |
| `node --test` with **no file arguments** (discovery mode) | repo root | **109** pass | **110** pass |

- Running the Worker suite on an **unpatched** checkout yields 36, not 37 —
  patch 0002 adds the 37th test ("a hazard destroys picked Dummy tiles, which
  never cost points of their own"). This is the most likely source of the
  discrepancy.
- A bare `node --test` from the repo root discovers **both** suites at once
  (110 on the patched tree, 109 on plain main), so its single total never
  matches "73 client + 37 Worker".
- Per-file breakdown of the patched tree, so the counts can be verified file by
  file: client — `memes.test.js` 20, `rules.test.js` 17, `turn-rules.test.js` 5,
  `ai.test.mjs` 11, `board.test.mjs` 6, `trackers.test.mjs` 6, `utils.test.mjs` 8
  (= 73); Worker — `game-engine.test.js` 24 (23 on main), `protocol.test.js` 13
  (= 37). Only `tests/rules.test.js` and `worker/test/game-engine.test.js`
  differ from main at all (both rewritten by patch 0002).

## 3. Client unit tests (73/73 PASS)

```
node --test tests/*.test.js tests/*.test.mjs
# tests 73 / pass 73 / fail 0  (duration 0.37 s)
```

## 4. Worker unit tests (37/37 PASS)

```
cd worker && npm ci --no-audit --no-fund    # added 3 packages in 0.4 s from the tracked lockfile
npm test                                     # = node --test
# tests 37 / pass 37 / fail 0  (duration 0.14 s)
```

`npm ci` from the clean checkout (using `worker/package-lock.json` tracked by
patch 0011) is itself part of the verification: the dependency installation the
reviewer asked to confirm works from a clean checkout.

## 5. All four CI syntax loops (PASS)

Run verbatim on the patched tree (same commands as the workflows):

```
for f in src/*.js src/scenes/*.js src/game/*.js staging/audience/*.js tools/build-memes-manifest.js; do node --check "$f"; done   # 33 files PASS
for f in src/*.js src/scenes/*.js staging/audience/*.js; do node --check "$f"; done                                              # 25 files PASS
for f in src/*.js src/scenes/*.js staging/audience/*.js worker/src/index.js; do node --check "$f"; done                          # 26 files PASS
for f in src/*.js src/scenes/*.js src/game/*.js staging/audience/*.js; do node --check "$f"; done                                # 32 files PASS
```

## 6. Meme manifest, Wrangler JSON, bundle dry-run (PASS)

```
node tools/build-memes-manifest.js --check          # assets/memes/manifest.json is up to date.
node -e 'for (const f of ["wrangler.jsonc","wrangler.staging.jsonc"]) { JSON.parse(require("node:fs").readFileSync(f,"utf8")); console.log(f+" is valid JSON"); }'
npx --yes wrangler@4.151.0 deploy --config worker/wrangler.jsonc --dry-run --outdir /tmp/shapey-r4-dry-run
# bundles successfully; ROOMS Durable Object binding present; exits without deploying
```

## 7. The repo's own online suites — all three, from this checkout (PASS)

Servers exactly as CI runs them (`wrangler dev --local --ip 127.0.0.1 --port
8787` from `worker/`, plus `python3 -m http.server 8080` serving the repo root;
the Worker's `/health` endpoint was polled until ready before each suite, and
servers and suites shared one process lifetime):

```
cd worker
node integration-smoke.mjs    # PASS — origin guard, PvP scoring/reconnect and audience
                              #         polls, full-board Tag polls, chat, and AI demo
                              #         auto-play/cleanup
node browser-smoke.mjs        # PASS — two separate browser contexts joined one room,
                              #         shared the same board, scored one match, and
                              #         synchronized the next turn   (P1 vs P2 online)
node tag-browser-smoke.mjs    # PASS — four separate browser contexts joined, started one
                              #         shared game, and the UI synchronized
                              #         P1 -> P3 -> P2 -> P4 -> P1   (Tag 2-vs-2 team order)
```

This closes the revision-3 gap where these two browser suites were only
referenced from the previous round: in this revision they ran against this
exact tree (log files `r4-browser-smoke.log`, `r4-tag-browser-smoke.log`).

## 8. Browser verification scripts from inside the clean checkout (PASS)

All four scripts below live in `verification/` **inside the checkout** and
import Playwright via the repository-relative path
`../worker/node_modules/playwright/index.mjs` (the fix requested in the last
round — no absolute paths remain). Prerequisites: `cd worker && npm ci`, one-time
`npx playwright install chromium`, and the static server on
`127.0.0.1:8080` (the Worker is additionally needed for hazard-verify's nothing,
and for the three repo smokes above; watch-verify and audience-verify talk to
the deployed staging Worker by design — see section 10).

| Script | Checks | Result |
|---|---|---|
| `hazard-verify.mjs` | 14 checks: Play Alone first-pick Hazard (−1, destroyed, continues), Dummy+Hazard (−1 more, dummies never cost their own points, both destroyed), versus-AI first-pick Hazard (no penalty, turn passes, AI 5-s turn, control returns), versus shapes+Hazard (no penalty, all destroyed, turn passes), 0 page errors | **14/14 PASS** |
| `feature-verify.mjs` (new in this revision) | 17 checks, see section 9 | **17/17 PASS** |
| `watch-verify.mjs` (new in this revision) | 5 checks: demo room created via Worker API, `index.html?watch=CODE` redirects to the audience wrapper with the same code, the embedded iframe renders the watched 49-tile board, the watched match progresses live (status study→playing, turn 0→1, scores 0,0→1,0), 0 page errors | **5/5 PASS** |
| `audience-verify.mjs` | board rendered, clock seen, audience poll opened, poll footnote appeared, 0 page errors | **PASS** |

## 9. Feature-level verification (reviewer's point 4) — `feature-verify.mjs`, 17/17 PASS

Drives the **real UI** (actual canvas clicks on menu buttons, board-size
buttons, tiles and the submit button — no deep links for the flows under test)
in headless Chromium against the locally served patched build:

| # | Check | Result detail |
|---|---|---|
| A1–A3 | Loading screen: `#boot` markup present at first paint; plank load-bar artwork revealed (`boot.ready` + `#bootLoadRectangle`); overlay removed cleanly once MenuScene is up | PASS |
| B1 | PLAY ALONE opens the CHOOSE BOARD SIZE picker | PASS |
| B2 | Choosing **5×5** starts Play Alone with a 25-tile board (`rows 5, cols 5, tiles 25, mode "alone"` — board-size selection reaches GameScene) | PASS |
| B3 | A submitted 3-match scores **exactly +1** in Play Alone (0→1) | PASS |
| B4 | Board refilled to 25 tiles after the match | PASS |
| B5 | **Spawn animation observed**: new tiles sampled mid-fall above their final slots during the refill | PASS |
| B6 | A wrong shape in Play Alone costs **exactly −1** and the picks flip back (1→0, selection cleared) | PASS |
| C1 | PLAYER VS AI + **6×6** + EASY starts a 36-tile board with a turn clock | PASS |
| C2 | **Countdown running**: `turnClock.remaining()` 31804 ms → 30810 ms over 900 ms | PASS |
| C3 | Submitting passes the turn to the AI (activePlayer 0→1) | PASS |
| C4 | **AI turn ≈ its fixed 5 s** (AI_TURN_MS): measured 6742 ms | PASS |
| C5 | Control returns to the player after the AI turn | PASS |
| D1 | PLAYER VS AI + **7×7** + HARD (pro, `goBig: true`) starts a 49-tile board | PASS |
| D2 | The PRO AI plays its full turn (the spare-time pick loop patch 0003 un-deadened) and returns control, measured 6080 ms | PASS |
| Z | No uncaught page errors in any scenario | PASS |

Combined with section 7's suites, every feature the reviewer listed is covered
by an actual behavioural run (see the matrix in REVIEW.md §Revision 4).

## 10. Corrections and disclosures from this round (nothing hidden)

1. **audience-verify backend correction.** The revision-3 script appended
   `?api=http://127.0.0.1:8787` to the audience URL and its header claimed it
   ran "against the local Worker". While re-verifying this round I read the
   audience app's code: `staging/audience/state.js` **hardcodes**
   `MULTIPLAYER_API` to the deployed staging Worker and ignores `?api=`
   entirely. The script therefore always exercised the deployed staging
   backend (which is also what the live site does). The verification of the
   refactored audience modules itself remains valid — the modules all executed,
   the poll/footnote/board rendered, 0 page errors — but the documentation was
   wrong and is now corrected in the script header and `verification/README.md`.
   The Worker-side logic is separately covered against the **local refactored
   Worker** by the three repo suites in section 7.
2. **feature-verify in-flight corrections** (script bugs, not game bugs): the
   wrong-shape check first assumed a submit was needed — in Shapey a
   mismatched pick resolves immediately (`failAttempt`), which the corrected
   script now asserts; and the "board settled" predicate first missed the
   post-reveal shuffle, which could make clicks land on moving tiles — the
   predicate now also requires `shuffling === 0` and no pending reveal batch,
   with a 600 ms stability confirmation.
3. **watch-verify in-flight correction**: the first version created the demo
   room on the local Worker, but the audience wrapper only ever talks to the
   deployed staging Worker, so the room was "not found". The corrected script
   creates the room where the page itself creates it (same API, same origin
   rules as the live site).

## 11. Not tested, and why (reviewer's point 5: "what could not be tested")

- **Patch 0006 (board-mask Graphics leak) at browser level.** The shutdown
  handler is verified by code inspection and the mask destroy is exercised
  implicitly every scene restart, but the leak it fixes is a slow WebGL
  resource accumulation that is not observable in a short browser session, and
  asserting "no leak" would require instrumenting Phaser internals. All
  restart flows that run during the suites (hazard scenarios, feature-verify
  menu re-entries) produce 0 page errors.
- **Deterministic assertion of the PRO AI's "go big" improvement (patch 0003).**
  The spare-time branch now executes during every PRO turn (D2 exercises it),
  but *proving* the AI picks a 4/5-match specifically would be statistical
  (it depends on the dealt board), so no deterministic assertion is made. The
  constant change itself (6000→2000, now below the 5 s turn) is a one-line
  reviewable diff.
- **Deployed-production behaviours**: Cloudflare rate limits per real IP, Durable
  Object persistence across real deployments, and GitHub Pages deployment were
  not exercised — this is a review package; nothing was deployed. The staging
  Worker endpoints used by watch-verify/audience-verify are read/room APIs on
  the existing deployed staging service, used exactly as the live site uses
  them.

## 12. Reproduction sequence (exact commands, in order)

```
git clone https://github.com/tayo6/shapey && cd shapey
git am /path/to/review-package/patches/*.patch     # 11 x "Applying:", no conflicts
cd worker && npm ci && npx playwright install chromium && cd ..
node --test tests/*.test.js tests/*.test.mjs       # 73 pass
(cd worker && npm test)                            # 37 pass
for f in src/*.js src/scenes/*.js src/game/*.js staging/audience/*.js tools/build-memes-manifest.js; do node --check "$f"; done
node tools/build-memes-manifest.js --check
cp -r /path/to/review-package/verification ./verification
python3 -m http.server 8080 --bind 127.0.0.1 --directory . &
node verification/feature-verify.mjs               # 17/17
node verification/hazard-verify.mjs                # 14/14
node verification/watch-verify.mjs                 # 5/5
node verification/audience-verify.mjs              # pass
# Worker suites (keep servers and suites in one shell/process lifetime, like CI):
cd worker
npx --yes wrangler@4.151.0 dev --config wrangler.jsonc --local --ip 127.0.0.1 --port 8787 &
node integration-smoke.mjs && node browser-smoke.mjs && node tag-browser-smoke.mjs
```
