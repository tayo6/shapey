# Shapey review deliverables (revision 4)

- `REVIEW.md` — the full review report. Revision 4 (§ at the top) covers the final
  verification round: compatibility with the **actual current `main`** (fresh fetch + fresh
  clone, all 11 patches apply, bit-identical tree), the explanation and reproduction of the
  73-client/37-worker test totals, the re-verified `New from ai/` backups, the feature-level
  verification matrix, and the honest passed/failed/not-testable report. Earlier revision
  sections follow below it.
- `TEST-RESULTS.md` — the exact verification report for this revision: every command verbatim,
  every result, the baseline-vs-patched test-total table, per-file test breakdowns, and full
  disclosure of the corrections made during this round. Nothing is described as passed that
  did not run and exit 0.
- `patches/` — **11** git patches (0001–0011). Apply in order on top of `main`:
  `git am patches/*.patch`. Verified in this revision against a fresh clone of the current
  `main` (`6dd6490`, confirmed 2026-10-25): zero conflicts, tree `1672727…` (bit-identical to
  the previously verified build).
- `changed-files/` — every added/modified file in its repo-relative path (42 files, verified
  to match the patched tree), if you prefer copying files instead of applying patches
  (deleted files are listed in the patches only — and backed up, see below).
- `verification/` — **four** scripted in-browser checks: `hazard-verify.mjs` (14 checks),
  `feature-verify.mjs` (17 checks, new — real-UI sweep of loading screen, board-size
  selection, Play Alone, versus AI, countdowns, spawn animations), `watch-verify.mjs`
  (5 checks, new — the `?watch=CODE` spectating path) and `audience-verify.mjs`, plus a
  README with the exact commands and which backend each script talks to. All scripts import
  Playwright **relative to their own location** (`../worker/node_modules/playwright/index.mjs`)
  and were proven to run from a clean checkout with `npm ci`-installed dependencies.
- `logs/` — raw output of every test run behind TEST-RESULTS.md (unit tests, smoke suites,
  browser verifications, wrangler logs), so the results can be audited without re-running.
- `backup/` — exact copies of the five files patch 0007 deletes (the four `New from ai/` files
  and `staging/demo-room.js`), extracted from upstream `main` (`6dd6490`) and **re-verified
  byte-identical against a fresh clone of the current `main` in this revision**, plus diff
  evidence that the `New from ai/` files contain no unique functional work, plus restore
  instructions.
- `evidence-r4-*.png` — screenshots captured during this revision's clean-checkout
  verification runs: loading screen/menu, the board-size picker, the 5×5 Play Alone board,
  versus AI on 6×6 (easy) and 7×7 (hard), control back to the player, and the embedded
  watch view. (`evidence-hazard-*.png` / `evidence-audience-poll-v2.png` are the
  revision-3 captures kept for continuity.)

Patch order: fixes (0001–0007), modularisations (0008–0010), repo hygiene (0011).

Scope note: this is a **review package only** — nothing was merged into `main`, pushed,
deployed to the live site, branched or PR'd. No patch touches `node_modules`, `.wrangler`
state or any other machine-generated artifact; `.gitignore` and the tracked
`worker/package-lock.json` are kept. The Hazard rules match the agreed spec everywhere: game,
Worker, rules module, docs and tests. AI turns remain five seconds.
