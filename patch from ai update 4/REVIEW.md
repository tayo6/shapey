# Shapey Code Review — tayo6.github.io/shapey (revision 4)

**Scope:** full review of the deployed game (GitHub Pages), the Phaser client (`src/`), the audience
staging app (`staging/`), and the Cloudflare Worker multiplayer backend (`worker/`).
**Method:** static review of every source file, plus live testing — headless-browser runs, an
AI-demo watch session that reproduced a crash, real room creation against the live Worker, local
`wrangler dev` integration/browser smoke suites, the full unit-test suites (73 client + 37 worker
tests), scripted in-browser verification of every Hazard rule path (14/14 checks), a new
feature-level UI sweep (17/17 checks) and a new watch-path verification (5/5 checks).

**Result:** 7 bugs fixed (1 crash reproduced live), 3 oversized files modularised, repo hygiene
cleaned up. Everything ships as an **11-commit patch series**; the series was re-applied to a
**fresh clone of the actual current `main`** (re-fetched and confirmed unchanged at
`6dd6490`, 2026-10-25T05:15:51Z) with every check green and a bit-identical resulting tree
(`1672727…`).

---

## Revision 4 — full re-verification against the actual current `main`

The reviewer approved the substance of revisions 2–3 and asked for a final verification round:
confirm compatibility with the **real, current** `main`, make the test results reproducible,
keep the `New from ai/` backups, verify the important features behave, and report honestly what
passed, failed or could not be tested. All five points are addressed; still nothing merged,
pushed, deployed, branched or PR'd — review package only. Full detail in TEST-RESULTS.md.

### R4.1 Verified against the actual current main — not an earlier copy

A fresh `git fetch` at 2026-10-25T05:15:51Z and a brand-new `git clone` from GitHub both show
`origin/main` still at `6dd64903d903…` ("Fix boot screen plank and synchronize loading artwork").
All 11 patches were `git am`-applied in order to that fresh clone: **zero conflicts**, and the
resulting tree `1672727579b0…` is **bit-identical** to the previously verified build — the series
is reproducible. (For completeness the same three commands were also run on plain `main` to
produce the baseline totals in R4.2.)

### R4.2 The test totals are now explained and reproducible

The reviewer could not reproduce "73 client + 37 worker". The explanation, measured this round:
the Worker suite yields **36 on plain `main`** (patch 0002 adds the 37th test), a bare
`node --test` from the repo root discovers **both suites at once** (110 patched / 109 main), and
only the two CI commands (`node --test tests/*.test.js tests/*.test.mjs` at the root, `npm test`
in `worker/`) produce the reported 73/37 split. Per-file breakdowns are in TEST-RESULTS.md §2.
On the fresh patched clone: **client 73/73, worker 37/37** (worker deps installed from the tracked
lockfile with `npm ci` — the clean-checkout dependency installation the reviewer asked about).

### R4.3 `New from ai/` backups kept and re-verified

The package `backup/` folder still holds exact copies of all five files patch 0007 deletes
(four `New from ai/` files + `staging/demo-room.js`). This round they were re-diffed against the
**fresh clone of current main**: all five are **byte-identical** to upstream, so the backup is a
faithful second copy (the files also still exist on the remote `main` itself, since nothing has
been merged). The deletion analysis is unchanged: two files byte-identical to their kept
counterparts, two differing only in comments (mechanically verified by comment-stripping), one
obsolete demo script whose own header says TO REMOVE — no unique work is lost. See
`backup/README.md`.

### R4.4 The important features verified at behaviour level

The reviewer asked for more than "files parse / isolated functions work". Three new/extended
browser suites drive the real UI (real canvas clicks, the real Worker, the real watch flow):

| Feature | Behavioural evidence (all from this revision's runs) |
|---|---|
| Play Alone | `feature-verify` B1–B6: menu → board-size picker → 5×5 board (25 tiles), 3-match pays exactly +1, wrong shape costs exactly −1, board refills, 0 page errors |
| Player vs AI | `feature-verify` C1–C5 + D1–D2: 6×6/7×7 boards via the real picker, countdown ticks (31.8 s → 30.8 s), submit passes the turn, AI turn ≈ its fixed 5 s (measured 6.7 s easy / 6.1 s pro incl. resolution), control returns; PRO exercises the spare-time loop patch 0003 un-deadened |
| P1 vs P2 online | `browser-smoke` (repo's own, re-run this revision): two browser contexts, one room, shared board, scored a match, next turn synchronized |
| Tag 2 vs 2 (4 players) | `tag-browser-smoke` (repo's own, re-run this revision): four browsers, shared game, team turn order P1→P3→P2→P4→P1 |
| Scoring / Hazard / Dummy | `hazard-verify` 14/14 (all four Hazard rule paths incl. Dummy protection, in the real GameScene) + `tests/rules.test.js` 17 + worker `game-engine.test.js` 24 |
| Countdowns & turn switching | `feature-verify` C2/C3/C5 (local clock + switch), `browser-smoke`/`tag-browser-smoke` (online switch), worker tests (server clocks incl. `serverNow` skew fix, patch 0005) |
| Audience polls, chat, rooms | `integration-smoke`: polls (PvP + full-board Tag), chat delivery, room create/join/spectate/reconnect, demo auto-play/cleanup; `audience-verify`: live poll watched, footnote fixed, 0 errors |
| Board-size selection | `feature-verify` B2 (5×5), C1 (6×6), D1 (7×7) — every size through the real picker |
| Spawn animations | `feature-verify` B5: new tiles sampled mid-fall into their slots during refill |
| Loading screen | `feature-verify` A1–A3: boot markup at first paint, plank load-bar artwork revealed, clean handoff to the menu |
| Spectating via watch links | `watch-verify` 5/5 (new): `?watch=CODE` redirects to the audience wrapper, embedded iframe renders the live 49-tile match, match progresses (study→playing, turn 0→1, score 0,0→1,0) — the reachable path of patch 0004's cleanup |

Coverage of the **changed behaviour per patch** (not just parsing): 0001 → audience-verify
(footnote + poll, 0 errors); 0002 → hazard-verify 14/14 + rewritten rules/game-engine tests;
0003 → feature-verify D2 (PRO spare-time loop runs); 0004 → watch-verify 5/5 (reachable path);
0005 → worker serverNow tests + integration-smoke timers; 0006 → code-inspected (leak not
observable short-term — disclosed); 0007 → backup analysis + staging-preview smoke;
0008 (game split) → the whole feature-verify + hazard-verify suites run the mixin code;
0009 (worker split) → integration/browser/tag smokes against the local refactored Worker;
0010 (audience split) → audience-verify + watch-verify + staging-preview simulation;
0011 → `npm ci` from the clean checkout is itself the proof.

### R4.5 Final report — passed / failed / not testable

- **Passed:** 11/11 patches apply cleanly to the actual current main (bit-identical tree);
  client 73/73; worker 37/37; all four CI syntax loops; meme manifest; wrangler JSON + dry-run;
  integration-smoke, browser-smoke, tag-browser-smoke (all against the local refactored Worker);
  hazard-verify 14/14; feature-verify 17/17; watch-verify 5/5; audience-verify; `New from ai/`
  backups intact and byte-verified against current main.
- **Failed (then fixed during this round, all disclosed in TEST-RESULTS.md §10):** three script
  defects in the verification tooling itself (wrong-shape flow assumption, settle predicate
  missing the shuffle, demo room created against the wrong backend) and one documentation
  inaccuracy (audience-verify's "against the local Worker" claim — the audience app hardcodes
  the deployed staging Worker; docs corrected, verification still valid). **No game or Worker
  code defect was found in this round.**
- **Not testable here (with reasons):** patch 0006's leak fix at browser level (slow WebGL
  accumulation, not observable in short sessions — code-inspected, restart flows error-free);
  a deterministic assertion of patch 0003's go-big improvement (statistical by nature — the
  branch is exercised, the constant is a one-line reviewable diff); deployed-production
  behaviours (rate limits per real IP, DO persistence across real deploys, Pages deployment) —
  nothing was deployed, per the review-package constraint.

---

## Revision 3 — final corrections after the second review

Revision 2 was reviewed and approved in substance, with four final corrections requested. All
four are done; nothing was merged, pushed, deployed, branched or PR'd — this remains a review
package only.

### R3.1 Browser verification scripts use a repository-relative import

Both scripts in `verification/` imported Playwright through a machine-specific absolute path
(`/home/z/…/repo/worker/node_modules/playwright/index.mjs`). They now import it relative to the
script's own location:

```js
import { chromium } from "../worker/node_modules/playwright/index.mjs";
```

The scripts are therefore tied to no machine: copy `verification/` **inside** a repository
checkout (next to `worker/`), install the Worker dependencies, and run them — a new
`verification/README.md` documents the exact placement and commands, including the one-time
`npx playwright install chromium` browser download (see R3.2's second disclosure for why that
matters). **Confirmed from a clean checkout**: fresh clone of `main` + all 11 patches +
`cd worker && npm ci` + `npx playwright install chromium` + copy `verification/` in → both
scripts pass (14/14 hazard checks; audience watch with board, poll, footnote and zero page
errors).

### R3.2 Every test rerun and documented — including the failures

The entire suite was rerun from scratch on the clean-checkout build described above; every
command and its real output is in `TEST-RESULTS.md` (rewritten for this revision). Summary:
73/73 client tests, 37/37 worker tests, all four CI syntax loops, the meme manifest check, the
wrangler JSON validation, `wrangler deploy --dry-run` bundling, the Worker integration smoke
(pass), a local simulation of the fixed `staging-preview.yml` step (pass), and both browser
verification scripts (pass). Two runs failed before passing and are reported honestly in the
test report with root causes and fixes:

1. **Browser binaries**: `npm ci` installs the Playwright *package* but not its browsers; the
   first browser-script run failed with `Executable doesn't exist … chromium_headless_shell-1248`.
   Fixed by `npx playwright install chromium` (the machine cache only held an older build). This
   is exactly the prerequisite now written in `verification/README.md` — no code change.
2. **Server lifetime**: the first integration-smoke run failed because the verification harness
   reaps background processes when a command ends, so the local Worker was dead when the smoke
   started. Re-running servers and tests inside one process lifetime — the same pattern the CI
   workflow itself uses — passes cleanly. No code defect.

### R3.3 `New from ai/` files protected before deletion

Patch 0007 deletes five files; the four `New from ai/` files were analysed, backed up and
documented before the cleanup was kept:

| deleted file | kept counterpart | finding |
|---|---|---|
| `New from ai/boot.js` | `src/scenes/boot.js` | **byte-identical** |
| `New from ai/loading-bar.js` | `src/loading-bar.js` | **byte-identical** |
| `New from ai/load.js` | `src/scenes/load.js` | differs only in 5 comment lines; **functionally identical** after comment-stripping (verified mechanically) |
| `New from ai/index.html` | `index.html` | differs only inside HTML/CSS comments; **functionally identical** after comment-stripping (verified mechanically) |

**No unique functional work exists in the folder.** `staging/demo-room.js` (also deleted, 287
lines) is not a duplicate of a kept file, so it is backed up too. Two independent copies now
exist beyond git history: (1) upstream `main` still contains all five files — this series is
unmerged, nothing was pushed; (2) the package now ships a **`backup/` folder** with exact copies
extracted from `main` (`6dd6490`), the two diff-evidence files, and a README describing what is
deleted, why it is safe, and three ways to restore any file (backup copy, `git checkout 0007^`,
or `git checkout origin/main`).

### R3.4 Patch compatibility re-verified — and one real incompatibility found and fixed

All 11 patches apply cleanly in order to the **current** `main` (`6dd6490`, re-fetched from
GitHub during verification; no new upstream commits). But simulating the CI workflows against
the patched tree exposed a genuine bug **in the v2 series itself**: patch 0010 deleted
`staging/audience.js` while two CI steps still *executed* references to it —

- `worker-tests.yml`, last syntax step: `node --check staging/audience.js` → `MODULE_NOT_FOUND`
  (reproduced: `Error: Cannot find module 'staging/audience.js'`), and
- `staging-preview.yml` (which runs on PRs to `main` touching `staging/**`): its syntax loop
  glob `staging/*.js` matches nothing after the split, and its smoke step still
  `curl`s and greps the deleted monolith for `startAiDemo`, `poll_vote` and the staging URL.

The merge PR would therefore have failed both workflows. **Patch 0010 was amended** to fix all
actively-executed references: both syntax globs now point at `staging/audience/*.js`, and the
staging-preview smoke step fetches and greps the module equivalents (`main.js` for the
`startAiDemo` wiring, `watch.js` for `function startAiDemo()`, `board.js` for the `poll_vote`
message, `state.js` for the staging Worker URL). Inert `paths:`-filter entries that name the old
file were deliberately left alone: they only decide when a workflow triggers and can never fail
a run (the workflows still trigger correctly via `staging/audience/**`, which 0010 already
added). The amended step was replayed locally against the static server and passes.

Series delta vs the v2 you reviewed: **patches 0001–0009 are byte-identical**; 0010 = the two
workflow hunks above plus an accurate commit message (the old message claimed “CI syntax checks
updated” — now it actually is, for all four workflows); 0011 = rebased, content identical. The
re-verification in R3.2 ran against this amended series.

---

## Revision 2 — what changed after the first review

The first submission was reviewed and **not approved in its current form**. Three problems were
raised; all three are addressed in that revision. The v1 submission was discarded in favour of a
rebuilt series (nothing was merged, no branches were pushed, no pull request was opened).

### 0.1 Patch 0002 enforced the wrong Hazard rules — corrected (highest priority) *(revision 2)*

v1's patch 0002 changed the local game to match `GAMEPLAY.md`/`README.md`, `rules.hazardAction()`
and the Worker — giving versus modes a **harmless first-pick glimpse**. That is not the agreed
rule. The agreed rules, now enforced consistently by this series, are:

1. **A Hazard always destroys itself.**
2. **If picked with other shapes, it destroys itself and all the other picked shapes, including
   Dummy tiles.**
3. **Picking a Hazard first must not give the same player another chance to continue.** The
   Hazard is resolved and the turn ends, switching to the next player where applicable (in Play
   Alone the same player simply carries on — there is nobody to switch to).
4. **Only Play Alone receives the one-point Hazard penalty.** Other modes never lose points for
   a Hazard.
5. **Dummy tiles never incur their own score penalty** — destroying them with a Hazard costs
   nothing beyond the Hazard's own penalty.

What actually happened: the **local game already played the agreed rules** (every hazard routed to
`hazardBlast()`, Play Alone-only −1, versus modes never subtract). The documentation, the pure
rules module (`hazardAction`, unit-tested but never called by the scene), the online Worker
(900 ms `hazard-hit` glimpse for a first pick; −1 when real shapes were picked) and their tests
described and enforced the opposite. v1 "fixed" the game to match them — the wrong direction.
Documentation and Worker behaviour do not override the agreed gameplay rules.

Revision 2 therefore keeps the local game untouched (except routing its penalty through the pure
rule) and instead aligns everything else, in the new patch 0002
*fix(rules): enforce the agreed Hazard rules across client, Worker, docs and tests*:

| file | change |
|---|---|
| `src/rules.js` | `hazardAction()` (first-pick `'hit'` routing, unused by the scene) replaced by `hazardPenalty(isPlayAlone)`; GameScene now scores the blast through it, so versus modes pass 0 and `applyPenalty` is a no-op |
| `src/scenes/game.js` | one-line rewiring of the blast penalty to `RULES.hazardPenalty(...)`; all other hazard code kept exactly as the game already played it (every hazard detonates, `hazardHit()` stays a legacy alias of `hazardBlast()`) |
| `worker/src/game-engine.js` | a first-pick Hazard now detonates immediately via `applyHazardBlast()` (destroy + refill + end turn) instead of starting the 900 ms `hazard-hit` pending glimpse; the −1 deduction for picked real shapes was removed — online modes never lose score to a Hazard; Dummy + Hazard stays free |
| `worker/test/game-engine.test.js` | rewritten: "first pick destroys itself and ends the turn without a penalty", "blast after shapes destroys them without a penalty", and a new "Dummy tiles are destroyed but never cost points of their own" |
| `tests/rules.test.js` | `hazardPenalty` pinned: only Play Alone pays, Dummy tiles never of their own |
| `GAMEPLAY.md` | Hazard tile section rewritten to the five agreed rules; the Play Alone scoring bullet now includes the Hazard's −1; the "a versus blast always costs 1 point, even at 0" paragraph removed |
| `README.md` | the Hazard paragraph rewritten to the agreed rules |
| `DEVELOPER_GUIDE.md` | the Hazards bullet, the architecture note ("hazard routing" → "the Hazard penalty rule") and the quick-reference Hazard rules bullet rewritten |

Behaviour matrix after this series (verified in-browser, 14/14 checks — see `TEST-RESULTS.md`):

| situation | destruction | score | turn |
|---|---|---|---|
| Versus, Hazard picked first | hazard only | no change | ends → next player |
| Versus, shapes/Dummies then Hazard | hazard + everything picked | no change | ends → next player |
| Play Alone, Hazard first | hazard only | −1 | resolves; play continues |
| Play Alone, Dummy then Hazard | both | −1 (the Hazard's alone) | resolves; play continues |

### 0.2 Generated files removed from the patch series

The v1 series introduced and later removed machine-generated artifacts: patch 0001 accidentally
added 198 committed `worker/node_modules` files (~18.9 MB patch; removed again by 0012), and
patches 0009/0010 carried `worker/.wrangler/` miniflare SQLite dev state (removed by 0011).
None of that exists upstream on `main`.

Revision 2 rebuilds the series so that **no patch touches generated files at all**: the same
audience fix, worker split and audience split now ship without any `node_modules`/`.wrangler`
content, patch 0012 is gone entirely, and patch 0011 now only adds `.gitignore`
(`node_modules/`, `.wrangler/`, `worker/.wrangler/`) and tracks `worker/package-lock.json`
(dependency manifests, lockfile and `.gitignore` are kept as requested). The series shrank from
~44 MB to ~470 KB. Verified: `git log main..HEAD --name-only` contains zero
`node_modules`/`.wrangler` paths.

### 0.3 Existing behaviour preserved

No feature change beyond the Hazard rules was made. Verified during rebuild and re-verification:
scoring, turn switching (including Tag rotation and Double Play), countdowns, animations,
audience polls, multiplayer rooms, chat and Tag team logic are byte-identical to v1 outside the
eight hazard-related files (diff of the final trees shows exactly 9 files differing from v1, all
Hazard-related). **AI turns remain five seconds** — `AI_TURN_MS = 5000` is untouched; only
`AI_SPARE_MS` (6000 → 2000, patch 0003) changed, which affects how long before its 5-second
deadline the AI stops reaching for a bigger match, not the turn length.

---

## 1. Bugs fixed (patches 0001–0007)

### 1.1 CRITICAL — audience page crashes during every poll  (patch 0001)
*Reproduced live: 17 uncaught TypeErrors in one AI-demo session.*

`staging/audience.js` `updateBoardPollHint()` wrote to `els.boardFootnote`, but that key was never
declared in the `els` map and no `#boardFootnote` element exists in `audience.html`. The first
`audience_poll_state` message threw `TypeError: Cannot set properties of undefined (setting
'textContent')` inside the WebSocket handler; every later `game_state` threw again, skipping
`updateVeil()`, `renderPlayers()` and the poll panel update — so after the first poll the audience
page silently stopped updating.

**Fix:** added the (hidden-by-default) `#boardFootnote` element below the board with CSS, registered
it in `els`, made the hint function defensive, and clear it when a room view resets.
**Verified (v2 rerun):** an AI demo watched for 40+ s — poll opens, footnote shows "Audience poll
open…", zero page errors.

### 1.2 HIGH — Hazard rules disagreed across the codebase; aligned to the agreed rules  (patch 0002)
Full description in §0.1. In short: the local game already implemented the agreed rules; the docs,
`rules.hazardAction`, the Worker and their tests did not. This patch aligns everything to the
agreed rules and pins them with rewritten client tests, rewritten Worker tests and rewritten
documentation.
**Verified in-browser (v2):** all four rule paths exercised in the real game — versus first-pick
(destroy + pass turn, 0 points), versus after shapes (destroy all + pass turn, 0 points),
Play Alone first-pick (−1, play continues) and Play Alone Dummy+Hazard (−1 total — the Dummy never
adds its own). Online first-pick and Dummy+Hazard paths are pinned by the rewritten Worker tests.

### 1.3 HIGH — the Professional AI's "go for 5 tiles" behaviour was dead code  (patch 0003)
`AI_TURN_MS` is 5000 ms but `AI_SPARE_MS` was 6000 ms, so `turnClock.remaining() < AI_SPARE_MS` in
`aiAttempt()` was true from the first frame of every AI turn. The AI always stopped at a 3-tile
match; `AI_LEVELS.pro.goBig` ("reaches for 5 tiles", GAMEPLAY.md) could never run. Lowered the
spare threshold to 2000 ms (documented to stay below `AI_TURN_MS`) and updated GAMEPLAY.md.
The AI turn itself is still exactly 5 seconds.

### 1.4 MEDIUM — 44 lines of unreachable dead code in LoadScene  (patch 0004)
`startAudienceWatch()` redirects non-embedded `?watch=` visitors to `staging/audience.html` and
returns; the remaining path is by definition `embed === '1'`. The trailing "direct watch links"
block (fetch + WebSocket + handlers) could never execute. Removed, along with the now-unused
`MULTIPLAYER_API` import.

### 1.5 MEDIUM — online timers trust the device clock  (patch 0005)
Every online deadline (`turnEndsAt`, `reviewEndsAt`, `reveals[].endsAt`, poll `endsAt`, tile
`movingUntil`) is a **server** wall-clock timestamp, but both clients compared them with the
device's `Date.now()`. A phone with a wrong clock (minutes off is common) sees turns expire early,
poll countdowns jump, or timers freeze.

**Fix:** the Worker now stamps every game view and poll snapshot with `serverNow`; both clients
measure `serverClockOffset` per snapshot and convert every deadline through `serverToLocal()`.
Backwards compatible in both deploy orders (old workers simply don't send `serverNow`, offset stays
0). One worker test pins the new field.

### 1.6 LOW — Phaser Graphics leak on every game restart  (patch 0006)
`createBoard()` builds its geometry mask from a Graphics object created with `add: false`, so scene
shutdown never destroys it. Each Play Again / Restart leaked one Graphics object (plus WebGL
buffers) for the page lifetime. Now destroyed in a `shutdown` handler.

### 1.7 LOW — orphaned files shipped to the live site  (patch 0007)
* `New from ai/` (4 stale AI-generated variants of real files) — publicly served, referenced by
  nothing.
* `staging/demo-room.js` — the in-browser demo room replaced by the Worker-side demo; its own
  header said "TO REMOVE AFTER DEVELOPMENT", no page loads it.
Both removed.

### Repo hygiene  (patch 0011)
* No `.gitignore` existed. Added one ignoring `node_modules/`, `.wrangler/` and
  `worker/.wrangler/` so machine-generated development artifacts can never be committed.
* `worker/package-lock.json` is now tracked, so the dependency tree (playwright 1.64.0,
  ws 8.18.3 devDependencies) is reproducible from the manifests.
* No installed dependencies or dev-state files are added to the repository (revision 2 fix —
  see §0.2).

---

## 2. Minor findings (not patched, listed for awareness)

1. **`chatRoomTitle` dead reference** — `$('chatRoomTitle')` in the audience `els` map looks up an
   element that does not exist in `audience.html`; the member is never used, so it is harmless.
2. **GAMEPLAY.md AI table** — the Easy/Professional table's "Turn duration 45/30 s" row describes
   the *human's* turn in those difficulties; the AI itself always plays a fixed 5-second turn
   (`AI_TURN_MS`, correctly documented in `src/config.js` and `src/constants.js`). The prose was
   ambiguous; patch 0003 clarified the `AI_SPARE_MS` sentence only.
3. **Filename oddities** (work, but worth knowing): `assets/ui/star .webp` has a space before the
   extension, `pointer`/`shield` texture keys map to swapped filenames (commented in
   `constants.js`), and one meme file uses Unicode mathematical italic characters
   (`assets/memes/gifs/lose/𝐌𝐢𝐱.jpeg`). All are handled by `encodeURIComponent` and the manifest.
4. **Duplicated shuffle-plan logic** — `planShuffle()` (`src/utils.js`) and `makeShufflePlan()`
   (`worker/src/game-engine.js`) implement the same algorithm for the two deploy targets. Sharing
   would need a common package; left as-is.

---

## 3. Modularisation (patches 0008–0010)

Three files had grown past 1000 lines and were split along their natural seams. The technique for
the two class-based files is **prototype mixins** (plain method objects assigned onto the class
prototype), so every method keeps the same `this` and **no call site changes**; the audience app
became real ES modules with one shared `state` object. All three splits carry the corrected
Hazard behaviour from patch 0002.

### 3.1 `src/scenes/game.js` — 2095 → 744 lines + 7 modules in `src/game/`
| module | responsibility |
|---|---|
| `inventory.js` (321) | shop overlay, Star economy, streak rewards |
| `online.js` (332) | authoritative-state reconciliation, submit queue, socket wiring |
| `attempts.js` (322) | picking, match/mismatch/hazard resolution, submit, scoring |
| `polls.js` (147) | Ask-the-Audience overlay |
| `board-motion.js` (136) | reveal countdowns, stuck-tile heal, shuffle animation |
| `fx.js` (86) | sounds, destroy/dust effects, falling tiles, spawn roll |
| `ai-turn.js` (88) | visible AI turn loop |

`GameScene` keeps lifecycle, layout, HUD, clocks/turn flow, board creation and the cascade.

### 3.2 `worker/src/index.js` — 1190 lines → 8 files
`lib.js` (shared helpers), `router.js` (public HTTP/WS router), `room.js` (the Room Durable Object
core), plus `room-seats.js`, `room-polls.js`, `room-messages.js`, `room-demo.js` mixins, and a
5-line `index.js` entry re-exporting the router and `Room` for the wrangler binding.
(`worker/src/game-engine.js`, which holds the Hazard engine change, already existed as its own
module and is untouched by the split.)
**Verified:** unit tests, `wrangler deploy --dry-run` bundling, and `wrangler dev` +
`integration-smoke` (origin guard, PvP scoring/reconnect, polls, chat, Tag, demo auto-play) +
`browser-smoke` (two browser contexts playing one real PvP match through the menu UI).

### 3.3 `staging/audience.js` — 1085 lines → 10 ES modules in `staging/audience/`
`state.js` (elements, constants, the shared mutable state object), `util.js`, `badges.js`,
`chat.js`, `board.js`, `polls.js`, `ui.js`, `directory.js`, `watch.js` and `main.js` (wiring/entry).
`audience.html` loads `main.js` as a module. Two call-time-only import cycles
(`board ↔ polls`, `directory ↔ watch`) are documented in the module headers — safe with hoisted
function declarations.
**Verified end-to-end against a local Worker (v2 rerun):** directory loads, AI demo is created and
watched, the board renders/animates, the clock and poll countdown run, the poll footnote appears,
zero page errors.

CI workflows were updated to syntax-check the new directories — completed in revision 3 for all
four workflows (see the R3.4 note above).

---

## 4. Verification summary (revision 3 — see TEST-RESULTS.md for the full report)

All results from a fresh clone of current `main` (`6dd6490`) with the 11-patch series applied
(tree `1672727…`).

| check | result |
|---|---|
| Patch series `git am` on a fresh `main` clone | all 11 apply cleanly in order |
| Client unit tests (`node --test tests/*.test.js tests/*.test.mjs`) | 73/73 pass |
| Worker unit tests (`worker/npm test`) | 37/37 pass |
| Syntax checks — all four CI loops (incl. the two fixed in R3.4) | all pass (33+25+26+32 files) |
| Meme manifest `--check` | up to date |
| Wrangler JSON validation (both `.jsonc`) | valid |
| `wrangler deploy --dry-run` bundle | bundles cleanly, DO binding resolved |
| `wrangler dev` + integration-smoke | full pass |
| Fixed `staging-preview.yml` smoke step, simulated locally | pass |
| In-browser Hazard rules, all 4 paths, from the clean checkout | 14/14 checks pass (`verification/hazard-verify.mjs`) |
| Audience page + AI demo + live poll, from the clean checkout | pass; 0 page errors (`verification/audience-verify.mjs`) |
| Generated files anywhere in the series | 0 (`git log main..HEAD --name-only` checked) |
| AI turn length | still `AI_TURN_MS = 5000` (5 s), untouched |

Not rerun this round (see TEST-RESULTS.md "Not run"): the two-browser `browser-smoke` /
`tag-browser-smoke` suites — they were exercised against the identical v2 tree last round and the
tree delta since then is two CI workflow files, which those suites do not read; and the
`staging-preview.yml` steps that curl live third-party services (informational in the workflow
itself).

## 5. Applying the patches

```bash
git clone https://github.com/tayo6/shapey.git && cd shapey
git am /path/to/patches/*.patch        # all 11, in order
```

Patch order: fixes (0001–0007), modularisations (0008–0010), repo hygiene (0011).

Deploy notes (Cloudflare): the Worker change in patch 0002 is authoritative-rule enforcement. As
soon as the Worker is redeployed, online play follows the agreed Hazard rules regardless of which
client build a player has — old clients render the blast generically (state snapshot + reveals +
cascade), and the mixed-version window shows the *Worker's* rules. Client and Worker can still be
deployed in either order; re-run `npx wrangler deploy` for the Worker and push to `main` to
publish the Pages site (the Pages workflow runs the test suites before deploying). The local-mode
Hazard behaviour (Play Alone −1, versus free) ships with the Pages deploy.
