# Test results — Shapey review package, revision 6 (final)

Every result below was produced on a **fresh clone of the actual current
`main`** with the full 13-patch series applied by `git am`. Exact provenance:

| | |
|---|---|
| Base commit (GitHub `main`, re-fetched for this revision) | `4121769816f3a35c2110434dcfd387555b6abe61` ("Extract AI update 4 review package") |
| Base tree | `237342a3e33e0cc9afb08e89559708eae2240abe` |
| Patches applied | 13 of 13, in order, `git am`, zero conflicts (three consecutive fresh-clone applications: `logs/18`, `logs/22`) |
| Resulting tree (**final, this revision**) | `185b6cba7b312c29fbd88a4ed48a266509284fda` |
| Resulting tree (revision 5, superseded) | `6fb5d6f7f7f3e5c5ce13ba20ae506086e81e88ad` |
| Node / Playwright / wrangler | node 24.21.0 (CI uses 22), playwright 1.64.0 (lockfile), wrangler 4.151.0 |

What changed between the previously verified base `6dd6490` and the current
`main` `4121769`: **only** additions under `patch from ai update 4/` (the
review-package extraction — 99 files, 21 540 insertions, all `A` status). No
game source, no Worker source, no workflow, no asset changed, so the 11
verified patches were expected to apply unchanged — and they did,
byte-identically. Patches 0012 and 0013 were new in revision 5 (see §10);
revision 6 re-verified them and hardened the two smoke scripts they add (§14).

Revision 6 (this final round) re-verified the whole series on fresh clones
and hardened the two new browser smokes after reproduced flakes (§14):
the delivered tree is now `185b6cb`, which differs from the revision-5 tree
`6fb5d6f` **only** by test-robustness edits inside the two smoke scripts
themselves (+37/−12 lines — `git diff 6fb5d6f 185b6cb --stat` is exactly
`worker/audience-smoke.mjs` and `worker/clock-skew-smoke.mjs`, zero game,
Worker, workflow, test or doc changes). The r5-era logs (`00–17`) were
produced on trees content-identical to `6fb5d6f` for everything those logs
touch (§1–§10 logs `01–10` ran on a tree differing only in the two smoke
scripts' earlier revisions; §5–§8 logs `11–16` ran on `98e7538`, which is
`6fb5d6f` plus two untracked-style scratch verification scripts) and remain
valid evidence. The authoritative run set for the **delivered** series is
`logs/18–25`.

---

## 1. Client unit tests

Command: `node --test tests/*.test.js tests/*.test.mjs` (the exact step in
`pages.yml` and `local-gameplay-tests.yml`)

```
ℹ tests 83
ℹ pass 83
ℹ fail 0
```

73 of these are the pre-existing suites (identical to plain `main`); 10 are
the new `tests/clock-sync.test.js` (patch 0012). Raw log: `logs/01-client-tests.log`.

## 2. Worker unit tests

Command: `cd worker && npm ci && npm test` (the exact step in `worker-tests.yml`;
`npm ci` from the tracked lockfile doubles as the clean-checkout dependency proof)

```
ℹ tests 37
ℹ pass 37
ℹ fail 0
```

Plain `main` has 36; patch 0002 adds the Dummy+Hazard test. Raw log:
`logs/02-worker-tests.log`.

## 3. All four CI syntax-check loops

Each workflow's own loop, run verbatim against the patched tree
(`node --check` each file; ESM detection as on node 22):

| Workflow | Loop | Files checked | Result |
|---|---|---|---|
| `pages.yml` | `src/*.js src/scenes/*.js src/game/*.js staging/audience/*.js` | 33 | all pass |
| `local-gameplay-tests.yml` | same + `tools/build-memes-manifest.js` | 34 | all pass |
| `worker-tests.yml` | `src/*.js src/scenes/*.js staging/audience/*.js` | 25 | all pass |
| `staging-preview.yml` | `src/*.js src/scenes/*.js staging/audience/*.js worker/src/index.js` | 26 | all pass |

Raw log: `logs/03-syntax-loops.log`. The new files land in loops that already
cover their directories (`src/game/clock-sync.js` in pages +
local-gameplay; `staging/audience/*` edits in all four; the two new
`worker/*.mjs` smokes are exercised at runtime, not by syntax loops — same as
the existing three smokes).

## 4. Other static CI steps

| Check | Command (as in the workflow) | Result |
|---|---|---|
| Meme manifest | `node tools/build-memes-manifest.js --check` | "assets/memes/manifest.json is up to date." |
| Wrangler configs | the `worker-tests.yml` node one-liner parsing both jsonc files | both valid JSON |
| Worker bundle | `wrangler@4.151.0 deploy --dry-run` on `wrangler.jsonc` and `wrangler.staging.jsonc` | both bundle (75.13 KiB / gzip 16.79 KiB); `env.ROOMS (Room) Durable Object` binding present in both |
| ES module imports | static walk of every relative `import`/`export from` under `src`, `staging/audience`, `tools`, `tests`, `worker/src`, `worker/test` | 118 imports resolved, 0 broken |
| `staging-preview.yml` smoke step | every curl + grep of that step, run verbatim against a local static server | all pass — including `grep -F "https://shapey-multiplayer-staging.hellohuman100.workers.dev" staging/audience/state.js`, which still passes because patch 0013 keeps the deployed URL as the hard-coded default; the new shared module `src/game/clock-sync.js` is also served |

Raw logs: `logs/04-meme-manifest.log`, `logs/05-wrangler-json.log`,
`logs/06-wrangler-dryrun.log`, `logs/07-imports.log`, `logs/08-staging-preview-sim.log`.

Workflow **path filters** after the splits (0008–0010) and the new patches
(0012–0013), checked against each workflow's `on.push.paths` /
`on.pull_request.paths`:

- `src/game/*.js` (new in 0008, extended in 0012): covered by `src/**` in
  `worker-tests.yml`, `pages.yml` (push), `staging-preview.yml` and
  `local-gameplay-tests.yml`; also directly listed in the pages and
  local-gameplay syntax loops.
- `staging/audience/*.js` (new in 0010, edited in 0012/0013): covered by
  `staging/audience/**` in `worker-tests.yml` and `staging-preview.yml`, and
  directly listed in all four syntax loops.
- `worker/clock-skew-smoke.mjs`, `worker/audience-smoke.mjs`,
  `tests/clock-sync.test.js` (new in 0012/0013): covered by `worker/**` /
  `tests/**` path filters.
- One stale-but-harmless entry: `worker-tests.yml` and `staging-preview.yml`
  still list `staging/audience.js`, which patch 0010 deletes. A filter entry
  for a deleted path simply never matches; it cannot break a run.

## 5. The CI jobs, simulated locally job-by-job

GitHub Actions itself cannot run for a review package (that would require
pushing). Each job's steps were therefore executed verbatim on the patched
tree with the same commands, node setup and server lifetimes the YAML
defines:

- **`worker-tests.yml` / `worker-unit-tests` job** — npm ci, playwright
  install, both dry-runs, `npm test` (37/37), one `wrangler dev` + static
  server lifetime running `integration-smoke.mjs`, `browser-smoke.mjs`,
  `tag-browser-smoke.mjs`, wrangler JSON validation, `tests/turn-rules.test.js`,
  `tests/rules.test.js`, the syntax loop: **every step passes**.
- **`worker-tests.yml` / `worker-clock-and-audience-tests` job** (new in patch
  0013) — npm ci, playwright install, a fresh `wrangler dev` + static server
  lifetime running `clock-skew-smoke.mjs` then `audience-smoke.mjs`:
  **every step passes**.
- **`pages.yml`** — unit tests (83/83), syntax loop (33 files), meme manifest:
  **every step passes** (the deploy steps are GitHub Pages actions with no
  local equivalent and are out of scope for a review package; the upload path
  is the repo root, unchanged).
- **`local-gameplay-tests.yml`** — unit tests, syntax loop, meme manifest:
  **every step passes**.
- **`staging-preview.yml`** — rules tests, syntax loop, the full local
  smoke-step curl/grep list (§4): **every step passes**. The two
  informational steps that probe the *deployed* preview/Worker
  (`PREVIEW_URL` health checks) are about live infrastructure, not the
  patched tree; the second one is already warning-only by design.

Raw logs: `logs/11-job1-smokes.log`, `logs/12-job2-smokes.log`, plus
`logs/01…08`.

Why the new smokes are a separate CI job: the Worker rate-limits room
creation (5 rooms per 10 minutes per client — and a local `wrangler dev`
shares one bucket for every creator). `integration-smoke` creates 3 rooms and
the PvP/Tag browser smokes one each, i.e. the existing job already uses
exactly 5 of 5. Adding two more smokes to the same job would have made the
CI job fail on room #6 with HTTP 429 (reproduced locally during this
revision: `POST /api/rooms 429 Too Many Requests`). The second job gets its
own ephemeral Worker state and bucket; the workflow change is part of patch
0013.

## 6. Device-clock-skew regression coverage (reviewer point 2)

**Unit tests** — `tests/clock-sync.test.js`, 10/10 pass (included in the 83):

- converges to the true offset minus the best observed downstream latency;
- never reports an offset above the true offset (deadlines never run early);
- alternating 10 ms / 300 ms network jitter does not wobble a converted
  deadline (swing 0 ms; the naive per-snapshot estimate would swing ~290 ms);
- downward drift eases at ≤ 100 ms per snapshot (no visible forward jumps);
- forward and backward device-clock corrections are adopted on the first
  snapshot afterwards;
- window expiry, `serverToLocal()` round-tripping, replay-safety and
  non-finite handling.

**Latency analysis and the estimation improvement (patch 0012)** — a snapshot
stamped `serverNow = S` only reaches the handler `L` ms later, so the naive
`serverNow - Date.now()` under-reads the true offset by the jittering `L`,
and every snapshot moved every displayed deadline by the jitter. The
estimator in `src/game/clock-sync.js` keeps the maximum sample inside a 15 s
sliding window (the sample with the least latency), so displayed deadlines
run at most `min(L)` late and never early. Documented tolerance: < 50 ms
against a local Worker, < 300 ms over the internet; turn switching is always
server-authoritative (the Durable Object alarm), so no client estimate can
extend a player's turn.

Two further defects found and fixed while writing the test:

- the scene-restart replay of the cached snapshot re-measured the offset from
  a stale `serverNow` (under-reading it by the snapshot's age);
- the `game_started` snapshot that launches the scene was consumed by the
  menu before any measurement, so a skewed device showed the whole 15 s
  study countdown wrong (0:00 on a fast clock) until the first live
  broadcast. The menu now captures the arrival time and passes it through
  the scene launch.

**Behavioural browser test** — `worker/clock-skew-smoke.mjs`, PASS on the
delivered tree: twice consecutively on the final tree `185b6cb`
(`logs/24-r6-final-job2-smokes.log`, `logs/25-r6-final-job2-smokes-stability.log`),
plus `logs/17-final-clock-skew.log` and the isolated re-run `logs/21` on the
revision-5 tree (first full-pass log `logs/12-job2-smokes.log`; one reproduced
flake and its fix are documented in §14). Two online PvP clients with `Date.now()`
overridden +25 s (ahead) and −25 s (behind):

- both devices measure the skew from `serverNow` (offsets ≈ ∓25 000 ms
  within the 1 s tolerance);
- the study/memorize countdown agrees with the server truth and between the
  devices on both skewed clocks;
- across 6 consecutive samples of the 45 s turn clock: displayed remaining
  time matches the server truth within 2 s, never exceeds it by more than
  the tolerance (no turn extension), never regains more than 2 s between
  snapshots (no jumps), and the server deadline itself is unchanged between
  snapshots; the rendered mm:ss text matches too;
- a real audience poll opened through the real polls button: the ~30 s poll
  countdown reads correctly on both skewed devices, the poll-only overlay
  appears on the starting side only, the server-driven turn pause (~30 s) is
  reflected identically on both devices, and the poll closes at its
  server-authoritative deadline with the turn resuming correctly;
- a real match (3 tiles + Submit): the reveal→shuffle `movingUntil`
  animations last ≥ 600 ms continuously on both skewed devices (an
  uncorrected +25 s clock snaps instantly) and agree within 2 s of each
  other;
- the resumed turn expires with no input: the server switches at the
  deadline (observed within [deadline − 0.5 s, deadline + 3 s]), never
  before it, both devices flip together, the turn index advances, and the
  new turn runs on both skewed clocks;
- zero uncaught page errors.

## 7. Audience frontend against the local refactored Worker (reviewer point 3)

Patch 0013 adds the test-only `?api=http://127.0.0.1:8787` override to
`staging/audience/state.js` — allowed only on pages served from `localhost` /
`127.0.0.1`, mirroring the override `src/config.js` has always had; every
deployed origin ignores the parameter and keeps the hard-coded production
API (the `staging-preview.yml` grep of that URL still passes, §4). The
embedded game frame, the copied watch link and the leave-room navigation
carry the override while local testing is active so a reload stays pointed at
the local Worker.

`worker/audience-smoke.mjs`, PASS — run entirely against the local Worker:
twice consecutively on the final tree `185b6cb` (`logs/24`, `logs/25`), plus
`logs/12-job2-smokes.log` on the revision-5 tree (one reproduced flake in
the Tag handover and its fix are documented in §14). Verified:

- **room discovery**: the live-games directory lists the four-player Tag room
  (code, "4/4 players");
- **joining and spectating**: the watch view renders the 49-tile board, the
  embedded game frame loads and the players see the spectator count rise;
- **chat delivery**: a message sent from audience device A appears on device
  B and A;
- **Tag's four-player view**: the roster lists Team 1 · Player 1/2 and
  Team 2 · Player 3/4, and the HUD follows the P1 → P3 → P2 rotation;
- **poll voting and expiry**: both audience devices vote from the board
  tiles, both countdowns read ~30 s (device B runs a **40 s-skewed clock**
  and agrees with A within 2 s — the audience-side clock sync), the poll
  closes within [30 s, 34 s] of opening and reveals "2 votes" with the most
  popular tile, and the paused player turn resumes;
- **reconnect**: reloading an audience device restores the room, board and
  chat history; reloading Player 4 and rejoining through the room dialog
  restores seat 4 into the live game;
- **zero uncaught page errors and zero console errors** on all six pages.

Additionally `verification/audience-local-verify.mjs` (the light-weight
package check) passes against the local Worker (demo room, board, poll,
footnote, 0 errors — `logs/16-audience-local-verify.log`), and
`verification/watch-verify.mjs` now also runs against the local Worker
(5/5, `logs/15-watch-verify.log`). The deployed staging service was not used
as a substitute anywhere in this revision.

## 8. The repo's own online suites (all against the local Worker)

One server lifetime per CI job pattern; raw logs `logs/11-job1-smokes.log`
and `logs/12-job2-smokes.log`:

| Suite | Result |
|---|---|
| `worker/integration-smoke.mjs` (origin guard, PvP scoring/reconnect, polls, chat, demo auto-play) | PASS |
| `worker/browser-smoke.mjs` (two-browser PvP) | PASS |
| `worker/tag-browser-smoke.mjs` (four-browser Tag, P1→P3→P2→P4) | PASS |
| `worker/clock-skew-smoke.mjs` (new, §6) | PASS |
| `worker/audience-smoke.mjs` (new, §7) | PASS |

## 9. Package verification scripts (features at behaviour level)

Run on the same patched tree (`logs/13…16`):

| Script | Result |
|---|---|
| `hazard-verify.mjs` (agreed Hazard rules in the real scene) | 14/14 PASS |
| `feature-verify.mjs` (loading screen, board sizes 5/6/7 via the picker, Play Alone scoring, spawn animation, versus-AI countdown, turn hand-over, AI turn 6.1 s ≈ 5 s + spare loop) | 17/17 PASS |
| `watch-verify.mjs` (`?watch=` redirect + embedded live match) | 5/5 PASS |
| `audience-local-verify.mjs` (audience page vs local Worker) | PASS |

## 10. What changed in this revision (patches 0012 and 0013)

Patches 0001–0011 are **byte-identical** to the series the owner extracted
into `patch from ai update 4/patches/` on `main` (verified file-by-file
against `4121769`). The two new patches:

- **0012 — fix(online): harden the device-clock-skew estimate and pin it with
  tests**: new shared estimator `src/game/clock-sync.js` (used by the game
  and the audience page), receipt-time capture in the socket handlers, the
  menu→scene launch receipt fix, replay-safety, `tests/clock-sync.test.js`
  (10 tests), `worker/clock-skew-smoke.mjs` (two ±25 s-skewed browsers).
- **0013 — test(audience): point the audience frontend at a local Worker for
  testing**: the localhost-only `?api=` override in
  `staging/audience/state.js` (+ URL propagation in `watch.js`,
  `util.js`, `directory.js`), `worker/audience-smoke.mjs` (six pages against
  the local Worker incl. a 40 s-skewed audience device), both new smokes
  wired into a new second CI job in `worker-tests.yml` (the room-creation
  rate limit makes a single job impossible — see §5), `worker/README.md`
  documentation.

No gameplay rule, timing, scoring or UI behaviour is changed by either
patch: they touch only clock estimation for display, test-only API routing,
tests and CI. The agreed rules were re-verified on the final tree —
`AI_TURN_MS = 5000`, `TURN_MS = 45_000`, `TAG_TURN_MS = 30_000`,
`INITIAL_REVIEW_MS = 15_000`, `NEW_TILE_REVEAL_MS = 5_000`,
`SHUFFLE_STEP_MS = 2_000`, `AUDIENCE_POLL_MS = 30_000`,
`MAX_AUDIENCE_POLLS_PER_PLAYER = 3`, `SUPPORTED_BOARD_SIZES = [5, 6, 7]`
(`logs/09-rules.log`), Hazard rules 14/14, the AI turn measured at ~6.1 s
including its spare loop, and the full Worker/client suites above.

## 11. "New from ai/" backups (reviewer point 6)

All five files scheduled for deletion by patch 0007 remain backed up in
`backup/` and were re-verified **byte-identical** against the copies on the
current `main` (`4121769`) during this revision (`logs/10-backups.log`):
`new-from-ai/boot.js`, `new-from-ai/index.html`, `new-from-ai/load.js`,
`new-from-ai/loading-bar.js`, `staging-demo-room.js`. Nothing was deleted
from `main` as part of this review; the owner's own `patch from ai update 4/`
extraction additionally preserves a second copy of every one of these files
inside the repository itself. The restoration instructions in
`backup/README.md` are unchanged and remain valid.

## 12. Not testable in a review package (unchanged from rev 4, restated)

- **GitHub Actions runners themselves** — running the real workflows would
  require pushing a branch. §5 is the closest possible equivalent: every
  step of every relevant job executed verbatim locally, including both new
  CI jobs.
- **Deployed-production behaviour** — nothing was deployed (review-only
  constraint). The `staging-preview.yml` informational steps that probe the
  deployed preview/Worker are live-infrastructure checks, not patched-tree
  checks.
- **Patch 0006's mask-leak fix** — not observable in a short browser session;
  code-inspected (the shutdown handler destroys the Graphics object).
- **Patch 0003's goBig branch** — statistical by nature; the PRO-level AI
  turn in `feature-verify.mjs` exercises the spare-time pick loop it belongs
  to.

## 13. Reproduce everything

```bash
git clone https://github.com/tayo6/shapey.git shapey-check && cd shapey-check
git checkout 4121769816f3a35c2110434dcfd387555b6abe61
git am /path/to/patches/*.patch          # 13 patches, in order
cd worker && npm ci && npx playwright install chromium && cd ..

# static checks + unit tests
node --test tests/*.test.js tests/*.test.mjs   # 83 pass
(cd worker && npm test)                         # 37 pass
for f in src/*.js src/scenes/*.js src/game/*.js staging/audience/*.js; do node --check "$f"; done
node tools/build-memes-manifest.js --check

# browser suites — servers and suites must share one process lifetime (CI pattern)
python3 -m http.server 8080 --bind 127.0.0.1 --directory . &
cd worker
npx --yes wrangler@4.151.0 dev --config wrangler.jsonc --local --ip 127.0.0.1 --port 8787 &
node integration-smoke.mjs && node browser-smoke.mjs && node tag-browser-smoke.mjs
# then, against a FRESH Worker state (rate limit — see §5):
#   kill the worker, rm -rf .wrangler, start it again, then:
node clock-skew-smoke.mjs && node audience-smoke.mjs
```

## 14. Revision 6: definitive re-verification and smoke hardening (final round)

This section documents the final review round: a first-hand re-verification
of the delivered series against a freshly fetched `main`, two reproduced
flakes in the new browser smokes, their root causes, the test-only fix, and
the final evidence for the delivered series.

**Log map for this round** (all in `logs/`):

| Log | Tree | What it shows |
|---|---|---|
| `18-r6-definitive-apply.log` | `6fb5d6f` | fresh clone of `4121769` + the revision-5 delivered patches: 13/13 apply, tree bit-identical to the r5-verified tree |
| `19-r6-static-definitive.log` | `6fb5d6f` | the full §1–§4 static suite re-run on that tree: 83/83, 37/37, all four syntax loops, manifest, wrangler JSON + both dry-runs, 141 imports resolved, the staging-preview curl/grep simulation, rules constants, 5/5 backups |
| `20-r6-job2-smokes.log` | `6fb5d6f` | CI job-2 pattern: audience-smoke PASS; clock-skew-smoke **FAIL** in the poll phase (flake #1) |
| `21-r6-clock-skew-rerun.log` | `6fb5d6f` | clock-skew-smoke isolated re-run on identical code: PASS (board/timing dependent, not a code defect) |
| `22-r6-final-apply.log` | `185b6cb` | fresh clone of `4121769` + the **final** delivered patches (hardened 0013): 13/13 apply, final tree `185b6cba7b312c29fbd88a4ed48a266509284fda` |
| `23-r6-final-static.log` | `185b6cb` | the full static suite on the final tree: 83/83, 37/37, syntax loops 33/34/25/26 (+5 `worker/*.mjs`), manifest, wrangler JSON + dry-runs, 141 imports, staging-preview simulation, rules constants, 5/5 backups |
| `24-r6-final-job2-smokes.log` | `185b6cb` | both smokes PASS on the final tree |
| `25-r6-final-job2-smokes-stability.log` | `185b6cb` | both smokes PASS again, back to back — stability confirmation after the fixes |

**Flake #1 — clock-skew-smoke, poll phase** (`logs/20`). The single-shot
press of the polls button produced no poll within 10 s on one run and passed
on the next with identical code. Root causes identified in the script:

1. a single canvas press can be swallowed by the pick flip animation or a
   momentarily reconnecting socket (the smoke's own `clickWorldUntil` helper
   exists for exactly this class of miss and was already used for the join
   and room-creation clicks — but not for the polls button);
2. the poll anchor tile could be the neutral **Cancel** shape (the capture
   excluded only hazard/dummy): a Cancel pick clears the selection 350 ms
   later server-side, after which the Worker rightly refuses to open a poll
   ("Pick one first shape…"), making the phase impossible on such a board.

**Flake #2 — audience-smoke, Tag handover** (reproduced during the fix
verification of #1). The audience phases (directory, two joins, chat, roster)
run inside Player 1's 30-second Tag turn; on a loaded runner they can consume
it, the server then rotates the turn at its authoritative deadline, and the
subsequent submit press by the no-longer-active player is rejected forever
("Repeated clicks never achieved: submitting the empty turn"). The rotation
the test actually verifies — what the **audience pages display** — had
already happened, by the server-authoritative path.

**The fix (test-only, inside patch 0013):**

- both smokes anchor the poll on a real match shape (Cancel excluded, with a
  comment explaining why) and press the polls button through
  `clickWorldUntil` until the poll actually opens (a real player simply
  presses again; a redundant press while a poll is open is a no-op
  server-side);
- `handover()` accepts a turn the server already rotated at its deadline
  (`turnIndex > before || activePlayerNumber !== actor`); a genuinely broken
  submit button is still caught on any fresh turn, and `tag-browser-smoke`
  covers the button's causal effect independently;
- `waitForScene`'s timeout dump now reports the socket state, selected-tile
  count and polls used, so any future flake is diagnosable from the log.

`git diff 6fb5d6f 185b6cb --stat` is exactly the two smoke files
(`worker/audience-smoke.mjs`, `worker/clock-skew-smoke.mjs`, +37/−12) —
**no game, Worker production, workflow, unit-test or documentation file
changed** in this round. The agreed rules were re-confirmed unchanged on the
final tree (`logs/23`, §B9) and all five "New from ai/" backups re-verified
byte-identical against `4121769` (`logs/23`, §B10).

**Honest disclosure:** the two flakes were reproduced once each on this
machine under back-to-back load; each passed on immediate re-run with
identical code before the fix, and the fixed pair has passed twice
consecutively (`logs/24`, `logs/25`). Neither flake indicated a game or
Worker defect — both were the test harness clicking at the wrong moment.
