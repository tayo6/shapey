# Shapey review deliverables (revision 6, final)

- `REVIEW.md` — the full review report. Revision 6 (§ at the top) documents the final
  verification round: a first-hand re-application of the delivered series against a freshly
  fetched `main` (`4121769`), two reproduced flakes in the new browser smokes with root-cause
  analysis and a **test-only** fix, and the full verification of the final delivered tree
  (`185b6cb…`). Revision 5 below it answers the seven review points (latest-main verification,
  the **device-clock-skew regression test**, the **audience frontend tested against the local
  Worker** through a test-only API override, the **CI workflows verified step by step**, the
  confirmed preservation of every agreed Shapey rule, and the re-verified `New from ai/`
  backups). Earlier revision sections follow below it.
- `TEST-RESULTS.md` — the exact verification report for this revision: provenance (base
  commit, patch application, resulting tree hashes), every command verbatim, every result,
  the log map for revisions 5 and 6, and full disclosure of the corrections made during both
  rounds (including the two smoke flakes and their fix, §14). Nothing is described as passed
  that did not run and exit 0.
- `patches/` — **13** git patches (0001–0013). Apply in order on top of `main`:
  `git am patches/*.patch`. Patches 0001–0011 are **byte-identical** to the series the owner
  extracted onto `main` as `patch from ai update 4/patches/` (verified file by file against
  `4121769`); 0012 (clock-skew hardening + regression tests) and 0013 (audience local-Worker
  testing + the new CI job, hardened in revision 6 — test-robustness only) are new. Verified
  on fresh clones of the current `main`
  (`4121769816f3a35c2110434dcfd387555b6abe61`): zero conflicts, final delivered tree
  `185b6cb…`.
- `changed-files/` — every added/modified file in its repo-relative path (48 files, verified
  to match the patched tree), if you prefer copying files instead of applying patches
  (deleted files are listed in the patches only — and backed up, see below).
- `verification/` — **five** scripted in-browser checks: `hazard-verify.mjs` (14 checks),
  `feature-verify.mjs` (17 checks — real-UI sweep of loading screen, board-size selection,
  Play Alone, versus AI, countdowns, spawn animations), `watch-verify.mjs` (5 checks — the
  `?watch=CODE` spectating path, now against the local Worker), `audience-verify.mjs`
  (deployed-default configuration, kept from rev 4) and `audience-local-verify.mjs`
  (new — the audience page against the local Worker through the `?api=` override), plus a
  README with the exact commands and which backend each script talks to. All scripts import
  Playwright **relative to their own location** (`../worker/node_modules/playwright/index.mjs`)
  and were proven to run from a clean checkout with `npm ci`-installed dependencies.
- `logs/` — raw output of every test run behind TEST-RESULTS.md (`00`–`25`: the rev-5 runs,
  then the rev-6 definitive applications, static re-runs, the reproduced smoke flakes with
  their re-runs, and the final-tree smoke passes; the rev-4 logs are kept alongside), so the
  results can be audited without re-running.
- `backup/` — exact copies of the five files patch 0007 deletes (the four `New from ai/` files
  and `staging/demo-room.js`), extracted from upstream `main` and **re-verified
  byte-identical against the current `main` (`4121769`) in revisions 5 and 6**, plus diff
  evidence that the `New from ai/` files contain no unique functional work, plus restore
  instructions.
- `evidence-r4-*.png` — screenshots captured during the rev-4 clean-checkout verification
  runs: loading screen/menu, the board-size picker, the 5×5 Play Alone board, versus AI on
  6×6 (easy) and 7×7 (hard), control back to the player, and the embedded watch view.
  (`evidence-hazard-*.png` / `evidence-audience-poll-v2.png` are the revision-3 captures
  kept for continuity.)

Patch order: fixes (0001–0007), modularisations (0008–0010), repo hygiene (0011),
clock-skew hardening + regression tests (0012), audience local-Worker testing + CI job
(0013).

Scope note: this is a **review package only** — nothing was merged into `main`, pushed,
deployed to the live site, branched or PR'd, and nothing was deleted from `main`. No patch
touches `node_modules`, `.wrangler` state, credentials or any other machine-generated
artifact; `.gitignore` and the tracked `worker/package-lock.json` are kept. The Hazard
rules match the agreed spec everywhere: game, Worker, rules module, docs and tests. AI
turns remain five seconds; human turn times, reveal timings, Tag turn order, board-size
restrictions and score targets are unchanged; audience polls remain three free uses per
player per game and are never purchasable.
