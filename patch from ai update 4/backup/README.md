# Backup of files deleted by patch 0007

Patch 0007 (`0007-chore-remove-orphaned-files-shipped-to-the-live-site.patch`)
deletes 5 files (845 lines total). This folder contains an **exact copy of every
deleted file**, extracted from the unmodified upstream `main` branch
(commit `6dd6490`, verified current on 2026-10-25), so the deletion is fully
reversible even without git history. Nothing in this review package is merged,
pushed or deployed, so all five files also still exist on the remote
`main` branch itself — this backup is a second, independent copy.

## What is being deleted and why it is safe

### `New from ai/` (4 files)

Stale AI-generated variants of files that already exist in the canonical
locations (`src/` and the repo root). Nothing references this folder —
`git grep -n "New from ai" origin/main` (excluding the folder itself) returns
no matches — yet GitHub Pages serves it publicly at
`https://tayo6.github.io/shapey/New%20from%20ai/`.

| Deleted file | Lines | Kept counterpart | Evidence of no unique work |
|---|---|---|---|
| `New from ai/boot.js` | 25 | `src/scenes/boot.js` | **Byte-identical** to the kept file |
| `New from ai/loading-bar.js` | 240 | `src/loading-bar.js` | **Byte-identical** to the kept file |
| `New from ai/load.js` | 219 | `src/scenes/load.js` | Differs **only in comments** (5 comment lines reworded; see `diff-vs-kept-load.js.diff`). After stripping comments the files are functionally identical |
| `New from ai/index.html` | 74 | `index.html` (repo root) | Differs **only inside HTML/CSS comments** (see `diff-vs-kept-index.html.diff`). After stripping comments the files are functionally identical |

The "functionally identical" claims above were verified mechanically: all
comments (`//`, `/* */`, `<!-- -->`) were stripped from both versions and the
remaining code/markup compared byte-for-byte — equal in all four cases.
`boot.js` and `loading-bar.js` are byte-identical even *with* comments. The
`New from ai/` copies carry *older* comment wording (e.g. they describe "three
boot-screen images" while the current root `index.html` says "two"), which is
consistent with them being an earlier snapshot of files that were later
improved in place. **No unique functional work exists in this folder.**

### `staging/demo-room.js` (1 file, 287 lines)

The original in-browser "AI vs AI" demo room, made obsolete by the Worker-side
demo mode (`POST /rooms/demo`, patch 0009 keeps it in
`worker/src/room-demo.js`). Its own header comment says:
"TO REMOVE AFTER DEVELOPMENT: delete this file and its `<script>` tag in
audience.html. Nothing else depends on it." Verified on upstream `main`:
`git grep -n "demo-room" origin/main` (excluding the file itself) finds **no
references**, and `staging/audience.html` loads only `staging/audience.js`.
It is not a copy of any kept file, so an exact backup copy is included here
(`staging-demo-room.js`).

## Contents of this folder

```
backup/
  new-from-ai/boot.js                    exact copy from main 6dd6490
  new-from-ai/index.html                 exact copy from main 6dd6490
  new-from-ai/load.js                    exact copy from main 6dd6490
  new-from-ai/loading-bar.js             exact copy from main 6dd6490
  staging-demo-room.js                   exact copy from main 6dd6490
  diff-vs-kept-load.js.diff              deleted load.js vs src/scenes/load.js
  diff-vs-kept-index.html.diff           deleted index.html vs root index.html
  README.md                              this file
```

(`boot.js` and `loading-bar.js` have no diff files because they are
byte-identical to their counterparts — there is nothing to diff.)

## How to restore any of these files

Any of the following works:

1. **From this backup** (no git needed):
   `cp backup/new-from-ai/boot.js "New from ai/boot.js"` (from the repo root,
   recreating the folder), or `cp backup/staging-demo-room.js staging/demo-room.js`.
2. **From git history after applying the patches**: the commit created by patch
   0007 has the files in its parent, e.g.
   `git checkout 0007^ -- "New from ai/" staging/demo-room.js`.
3. **From upstream main** (while the series remains unmerged — the current
   state): `git checkout origin/main -- "New from ai/" staging/demo-room.js`.
