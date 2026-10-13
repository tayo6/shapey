# Shapey — Developer Guide

> **Purpose:** A hand-off document for a developer who has never played Shapey. It explains the intended game, the rules, the current prototype, and the work still required.  
> **Important:** This guide separates **designed behavior** from **implemented behavior**. A feature described as a rule is not necessarily implemented in the current code.

## 1. Project overview

Shapey is intended to be a competitive, turn-based memory-and-matching game with a candy-crush-style board cascade. Players study a board of symbols, wait for the symbols to turn face-down, then use memory to uncover three or more tiles of the same normal shape. Players race to a score target. The long-term design supports:

- Player versus AI, with Easy and Professional (Hard) difficulty.
- Tag: two teams of two on one device (same-device for now).
- Online human versus human using a shared backend.
- A configurable score target.
- Stars, streak rewards, an inventory/shop, and tactical power-ups.
- Rare special tiles, including a neutral blank wooden dummy and a Cancel Counter pickup.
- Audience Pick voting, eventually with real spectators.
- Match end, winner display, and rematch.

The current app is a static Phaser 3 browser prototype hosted on GitHub Pages. `src/main.js` owns scene/UI orchestration, while pure game decisions live in `src/rules.js` and are covered by `node --test tests/rules.test.js`. The design specification is `GAMEPLAY.md`. GitHub Pages serves files but does not provide authoritative multiplayer state, secure currency, or live voting.

- Repository: https://github.com/tayo6/shapey
- Hosted prototype: https://tayo6.github.io/shapey/
- Main client: `src/main.js`
- Rule specification: `GAMEPLAY.md`

## 2. Board, tiles, and memory phase

### Board dimensions

- The board has **7 columns × 7 rows = 49 tile positions**.
- The Phaser canvas is designed at **720 × 1280** and scales to the browser viewport.
- Each tile is drawn at approximately 90 × 90 pixels, with a 91-pixel centre-to-centre pitch.
- At the start of a game, the board is face-up for **15 seconds** so players can study the positions.
- After the study phase, tiles flip to the hidden `mystery` face.
- Newly spawned tiles after a valid match are revealed for **5 seconds** (`SPAWN_REVEAL_MS`), flip face-down, then **shuffle**: N new tiles give N − 1 swaps, each `SHUFFLE_STEP_MS` (2 seconds), strictly one after another (see `planShuffle`, `runShuffle`, `swapTiles`). Chain rule: each newly involved tile swaps with an already shuffled one; extra swaps re-shuffle; about 10% of tiles (`SHUFFLE_SKIP_CHANCE`) sit out, with at least 3 taking part. Picked tiles never move and tiles mid-swap can't be tapped. A submitted match cancels the shuffle and settles the swap in progress.
- Test overrides (milliseconds): `?review=3000` shortens the opening study phase, `?reveal=2000` the spawned-tile reveal, `?swap=500` each swap.
- The reveal countdown runs **concurrently** with the 45-second turn clock. Each batch of revealed tiles has its own absolute deadline (`RevealTracker`), separate from the turn deadline (`Countdown`), so neither can pause or extend the other. The header shows a "MEMORIZE" countdown while any tiles are face-up.
- Other test overrides (milliseconds): `?turn=10000` shortens the turn, `?invwindow=20000` shortens the inventory-limit window.
- Mode and hazard test overrides: `?mode=alone|ai|pvp|tag` skips the mode menu, `?level=easy|pro` picks the AI difficulty when `?mode=ai` is used (default Easy), `?hazard=0.5` sets the hazard spawn chance, clamped to 0–1; invalid values are ignored and fall back to the 10% default.

### Scenes, modes and loading

- Loading is two stages. `BootScene` fetches only the two loading-screen images (`assets/ui/shapey logo.webp`, `assets/ui/load rectangle.webp`); `LoadScene` then draws the logo and the load bar (gold fill inside the bar's dark slot, with a bobbing logo and pulsing fill as the load animation), loads everything else, and opens `MenuScene` (or `GameScene` directly with `?mode=`). `index.html` shows the same logo and bar in plain HTML/CSS immediately, so the screen is never blank while Phaser downloads; keep its numbers in sync with `LOGO_*` / `LOAD_BAR_*` / `LOAD_TRACK` in `src/main.js`. The custom font loads in parallel and never blocks the game for more than 2.5 s.
- **Branding rule:** the Shapey logo image (`shapey logo.webp`) is used for every Shapey logo (loading screens, menu, README, favicon `shapey icon.webp`); do not draw "SHAPEY" as text. The load rectangle image is the only loading bar.
- Landing dust (`assets/fx/dusty.webp`) is 7 equal 304 x 156 cells, each puff centred on its cell's middle and sitting on the bottom edge, so the cloud grows in place instead of drifting sideways. If the sheet is replaced, repack it the same way (equal cells, shared anchor) rather than slicing on a guessed grid.
- Art is stored at about 1.5x its on-screen size (the canvas itself is 720 px wide) to keep downloads and GPU memory small. Keep that in mind before swapping in new art: `setDisplaySize`/`fitToWidth` do the scaling, so any size works, but oversized files slow loading on phones.
- `MODES` (top of `src/main.js`) defines the four modes. Pure rules in `src/rules.js` decide match scoring/size, whether a pick matches the current selection, hazard routing, penalty arithmetic, valid hazard URL overrides, and Play Alone checkpoint outcomes. Phaser scene methods still own animations, UI updates and state changes. Run the rule tests with `node --test tests/rules.test.js`.
- **Sides vs players.** `activePlayer` is the *side* that is playing (0 or 1) and drives scores, planks, dimming and the AI. In Tag a side is a team, and `activeMember` (0 or 1, from `turnNumber`) says which partner is playing; `turnLabel()` turns the pair into "Team 1: Player 2" and `limiterSlot()` gives each of the four players their own inventory-limit slot. `startTurn()` is the only place that advances `turnNumber`. `TEAM_PLAYERS` holds the names.
- **Difficulty.** Player vs AI opens a "Choose difficulty" panel (`MenuScene.openDifficulty()`) built from `AI_LEVELS`, then starts `GameScene` with `{ mode: 'ai', difficulty }`. `GameScene.init()` stores it as `this.difficulty` and `this.ai` (the level's settings object); Restart and Play again pass it back so the level survives.
- **Flip-back safety net.** `healStuckTiles()` (run every frame) flips back down any tile that has been face-up for `STUCK_UP_MS` (2.5 s) without a legitimate reason: it is not picked, not in a reveal batch, not mid-swap. A wrong shape resets the picks as before; this only guarantees nothing is ever left showing, whatever the cause.
- Spawning: `pickShape()` rolls hazard, then dummy, then draws from `ShapeBag` (see GAMEPLAY.md). `ensureMatchPossible()` is the safety net after a refill.
- **Hazards.** `onTileTap()` routes a hazard to `hazardBlast()` when something is already picked, or always in Play alone (costs `HAZARD_BLAST_PENALTY` = 1 point in the two-player modes and nothing in Play alone; the hazard and all picked tiles are destroyed with no reward, then the board refills and the turn ends) and to `hazardHit()` when nothing is picked (no damage, the hazard flips back, the turn continues). The blast reuses `destroyTiles()` and `cascade()` from the submit path, and calls `cancelShuffles()` first for the same reason `submit()` does.
- The AI (`aiSee`, `aiGroups`, `aiChooseGroup`, `aiGuess`, `aiAttempt`, `runAITurn`) only uses tiles it has actually seen, keyed by tile object so memory follows tiles as they fall. Everything that differs between Easy and Professional is a field of the `AI_LEVELS` entry in `this.ai`; do not branch on the difficulty name in the code.

The memory challenge is based on tile identity and location. Do not show exact hidden positions to a player through UI, logs, AI logic, or audience polling.

### Normal shape tiles

The assets are mapped in `SHAPE_FILES` in `src/main.js`. The current mapping includes:

| Code key | Asset filename |
|---|---|
| `capsule` | `capsule.webp` |
| `circle` | `circle.webp` |
| `cross` | `cross.webp` |
| `divide` | `divide.webp` |
| `corner` | `four corner.webp` |
| `marked` | `marked.webp` |
| `pointer` | `shield.webp` |
| `shield` | `pointer.webp` |
| `sphere` | `sphere.webp` |
| `square` | `square.webp` |
| `star` | `star .webp` (note the space before the dot) |
| `x` | `x.webp` |

Some asset names and code keys are intentionally non-obvious; preserve exact paths unless assets are deliberately renamed. `mystery` is the hidden tile face and is not a matchable shape. `dummy` is the blank wooden tile and is not a normal shape. `cancel` currently maps to `cancel.webp`, but it must be removed from the normal scoring-shape pool and handled as a special pickup (see section 7).

### Initial board generation

The current `makeInitialBoard()` implementation creates a bag containing at least three of every key in `SHAPE_KEYS`, fills remaining slots using `randomBoardShape()`, shuffles the bag, and slices it into seven rows. This guarantees possible matches of the normal keys but does not guarantee every player can immediately identify a match after the board is hidden.

**Implementation warning:** `SHAPE_KEYS` currently excludes `mystery` and `dummy`, but includes `cancel`. That is inconsistent with the intended Cancel Counter rule. Change board generation so Cancel is a separate rare pickup and is never counted as a normal scoring shape. Ensure the initial-board guaranteed-three logic applies only to normal matchable shapes.

## 3. Turn flow and selection rules

The intended game is turn-based. Only one player is active at a time.

Recommended state sequence:

`READY → ACTIVE_TURN → SELECTING → RESOLVING → TURN_END → NEXT_PLAYER`

The UI should reflect this state rather than deciding game outcomes itself.

### Turn duration

- Standard turn duration: **45 seconds**.
- The timer starts when a player's turn actually begins, not while a menu, lobby, or loading screen is open.
- Use a deadline timestamp such as `turnEndsAt` and calculate the visible countdown from it.
- A timeout with no valid submitted match awards no points, clears the selection, and passes the turn exactly once.
- Ignore taps and submissions after the deadline.
- Online, the backend must be the authoritative clock; a browser countdown is display-only.
- The prototype now runs a real countdown from an absolute `turnClock` deadline and passes the turn to the other player (same-device pass-and-play) after a submitted match or a timeout. A turn that expires while an animation is resolving waits for it, then ends exactly once. Late taps and submits are ignored. A timeout clears any unsubmitted selection and awards no points.
- Not yet implemented: the 90-second Double Time turn and an authoritative (server) clock.

### Picking tiles

- The player taps hidden tiles to reveal them.
- The aim is to select at least **three normal tiles of the same shape**.
- Tiles do **not** need to be adjacent.
- A player may make a wrong pick. A wrong normal shape resets the current match attempt/selection, but does not immediately end the turn; the player can try again while time remains.
- A wrong tap by itself does not reset a successful-match streak. A timeout/no valid match does.
- The Submit button confirms the current valid selection. Do not resolve a match merely because the player has selected three tiles; keep the explicit Submit action.
- Prevent double submits and tile taps while a resolution animation is running.
- The old 10-second idle auto-submit has been **removed** (along with its `?auto=` test parameter). A valid selection is only ever submitted with the Submit button, and the 45-second turn deadline is the only automatic deadline.

### Valid match and scoring

Only normal matchable shapes contribute to match count and score.

| Number of matching normal tiles | Score |
|---:|---:|
| 3 | 1 point |
| 4 | 2 points |
| 5 or more | 5 points |

The scoring helper currently follows these values: `scoreFor(count)`. A valid group must contain at least three normal tiles all sharing the same shape key. Non-matching tiles must not be included in the score count.

On successful Submit:

1. Validate the active player, deadline, and selection.
2. Confirm at least three normal tiles of one shape are selected.
3. Compute the score using the table above.
4. Add the points to that player's score.
5. Update streak rewards if applicable (section 5).
6. Remove the matched normal tiles and play the tile-destroy effect.
7. Let tiles above empty positions fall and spawn replacement tiles.
8. Reveal new tiles for 5 seconds, hide them, then shuffle them (section 2).
9. Check whether the target score has been reached.
10. If the game has not ended, complete the turn and pass control to the other player, except when Double Play grants a bonus turn.

A match of four or five-plus is still only **one successful matching instance** for streak purposes; it does not count as multiple turns.

### Cascades and board consistency

A successful match removes its tiles and triggers the candy-crush-style cascade animation. New tiles fill the vacancies. Each new tile must have a stable identity, shape, and current grid position.

For AI memory, remember tile identities rather than only stale row/column coordinates. When tiles fall, update their remembered locations based on the actual resolved board. A hidden tile should not become known merely because it fell or moved.

Resolve tile destruction, gravity, spawning, reveal/hide timing, and score updates before handing the turn to the next player. Avoid changing hidden tiles or secretly reshuffling the board, because that invalidates what players memorized. If a reshuffle is ever introduced, make it explicit and visible.

## 4. Target score, victory, and ties

- The match is a race to a player-selected target.
- Default target: **100 points**.
- Supported target range: **100–1,000 points**.
- In a two-player match, the first player to reach or exceed the target wins.
- After a win, stop the turn clock and input, show a short victory sequence, and offer a rematch.
- Score Strike cannot reduce a score below zero.
- If a match has a turn cap and finishes with equal scores, use a clearly communicated tie-breaker, such as one 45-second sudden-death turn. If there is no turn cap, define the tie policy before adding one.
- Scores must be stored separately for each player. The current prototype has a real `this.score` for one score only; the two score displays are not yet backed by a complete two-player state.

## 5. Stars and match streak rewards

Stars are spendable currency, not merely the decorative row of star icons in the header.

### Starting balance and persistence

- Each player starts with **1 free Star**.
- In the offline prototype, the shop currently loads/saves `shapey-stars` in browser local storage.
- Owned shop items are currently stored under `shapey-inventory`.
- This is device/browser-local test storage. It is not secure, does not follow a player to another device, and must not be trusted for online play.
- Online, store balance and inventory per account on the backend. Never let a client decide its own authoritative balance.

### Successful-match streak

Track a separate consecutive-success counter for each player.

- Each turn completed with a valid match of three or more normal matching tiles increments that player's streak by one.
- On the **third** successful matching turn in a row, award **3 Stars**.
- On the **fourth** successful matching turn in the same streak, award **4 additional Stars**.
- On the **fifth**, award **5 additional Stars**, and continue the pattern: the reward equals the streak length once the streak reaches three.
- A timeout without a valid match resets the streak counter to zero.
- A wrong tap does not break the streak if the player still completes a valid match during that turn.
- Resetting a streak never removes Stars already earned.
- Award each streak-length reward only once, and show a toast such as “3-match streak! +3 Stars”.
- Streaks are per player; one player's timeout must not reset the opponent's streak.

Example: A player starts with 1 Star. Their first and second successful matching turns earn no streak reward. Their third consecutive successful matching turn grants +3, bringing the balance to 4. If they then time out, their balance stays 4; only the streak resets.

## 6. Shop and offensive power-ups

Buying an item immediately deducts its Star cost and adds one owned item to inventory. Using an item consumes one owned card; it must not charge the player a second time. Unused items remain owned after a match unless the product design is explicitly changed.

| Item | Price | Intended effect |
|---|---:|---|
| Audience Pick | 3 Stars | Ask an audience/poll which candidate shape to pursue. |
| Double Time | 3 Stars | Extend the player's next turn from 45 to 90 seconds. |
| Double Play | 4 Stars | After the player's current turn, grant one extra 45-second turn before control passes to the opponent. |
| Score Strike | 5 Stars | Subtract 10 points from the opponent, with their score floored at 0. Limit use to once per player per match. |

Rules and edge cases:

- Double Time changes only the eligible next turn, and should show a visible active indicator.
- Double Play gives exactly one bonus turn. It cannot chain into another Double Play during its bonus turn.
- Score Strike cannot make the opponent's score negative and is limited to once per player per match.
- Before Score Strike, Double Time, or Double Play resolves against an opponent, allow a brief response window for that opponent to use a Cancel Counter (section 7).
- Audience Pick is not counterable by Cancel Counter.
- If the match ends before an item is used, retain the card in inventory.
- **Inventory access limit (anti-stalling):** each player may open the inventory at most **2 times per rolling 5 minutes** (`INVENTORY_OPEN_LIMIT`, `INVENTORY_WINDOW_MS`, enforced by `InventoryLimiter`). Only successful opens count: refused attempts and in-shop refreshes after a purchase do not. The turn clock keeps running while the inventory is open, and the shop closes if the turn times out. A refused open shows a message with the time until the next allowed open. Online, the server must enforce this limit.
- Make the effect timing explicit. For example, a queued Double Time should activate when the next eligible turn starts, not retroactively alter a turn already in progress.

### Audience Pick details

Audience Pick is intended to add a “Who Wants to Be a Millionaire?” audience moment.

- The active player starts Audience Pick from inventory during a legal match attempt.
- Present candidate shapes and a short countdown, then show vote bars/percentages.
- Each eligible spectator may vote once per poll.
- Exclude the active player and opponent from voting in their own match poll.
- Do not expose exact hidden tile coordinates or guarantee a match; the audience is advice, not hidden-board access.
- Until real spectators and backend voting exist, any simulated poll must be clearly labelled **Practice Audience**. Never claim fictional votes are real.
- Real polls need backend vote validation, rate limiting, and a defined spectator eligibility rule.

## 7. Special tiles: wooden dummy and Cancel Counter

These are two distinct concepts and must not be confused.

### Blank wooden dummy — neutral decoy

Asset: `assets/shapes/dummy.webp`; code key: `dummy`.

- A blank wooden tile with no symbol.
- It is occasionally spawned as a neutral decoy; current configured chance is **8%** when `randomBoardShape()` is used.
- It can be flipped/revealed during a selection sequence.
- It adds zero points, subtracts zero points, and never counts toward the three-tile minimum.
- It must **not** reset, break, or join a player's matching selection.
- Example: yellow, yellow, dummy, yellow, yellow still counts as four yellows.
- It is not a power-up and does not enter inventory.
- The current tap handler reveals a dummy briefly (about 1.1 seconds) and flips it back without adding it to the selection.

### Cancel tile / Cancel Counter — defensive pickup

Asset: `assets/shapes/cancel.webp`; code key: `cancel`.

- This is **not** a normal scoring shape.
- It should spawn occasionally as a separate pickup, not as one of the guaranteed-three match shapes.
- When a player collects it, add one **Cancel Counter** card to that player's inventory.
- The player can use the card to cancel an opponent's **Score Strike, Double Time, or Double Play** if the card is used during the response window and before the effect resolves.
- It cannot cancel Audience Pick.
- It does not add or subtract score itself.
- Consume the card only when it successfully cancels a supported effect. If no eligible effect is pending, do not consume it.
- The UI must make clear when an effect is pending and how long the response window lasts.
- In online play, the backend resolves the timing and checks card ownership so both players see the same result.

**Known code issue:** `SHAPE_KEYS` currently includes `cancel`, so the current board generator may treat it as an ordinary shape. Correct this before considering special-pickup behavior complete. The collection, inventory count, and counter response flow are not yet implemented.

## 8. AI opponent design

The game offers **Easy** and **Professional** (the "Hard" design below) through a difficulty panel after Player vs AI is chosen. **Both are implemented**, except for using inventory items (power-ups have no in-match effect yet, for humans either). Both use the same board odds, score rules, timers, and item costs as a human. The exact numbers are in `AI_LEVELS` in `src/main.js` and are tabulated in `GAMEPLAY.md`.

### Easy AI

- Remembers roughly 45–60% of tiles it legitimately saw.
- Makes intentional memory mistakes and plausible guesses.
- Uses a remembered match if it has one; otherwise it explores.
- Uses realistic tap delays rather than instantly completing a turn.
- Rarely optimizes for the largest match.

### Hard AI (Professional in the game)

- Remembers almost all tiles it legitimately saw (95–100%, with a 1% chance of misremembering a tile; when it taps a tile that turns out to be a different shape it adapts to what it now knows rather than giving up).
- Still cannot inspect hidden board state it has not observed.
- Prioritizes known matches of 5+, then 4, then 3, while leaving enough time to submit.
- Tracks tile identities through cascades so memory follows moved pieces.
- Uses inventory items strategically within the same rules as a human.
- Has realistic delays so difficulty comes from memory and decision-making, not impossible speed.

AI memory must be separate from the actual board state. Do not give the AI direct access to hidden tile identities when selecting its next move.

## 9. Online multiplayer architecture

GitHub Pages can host the front-end files, but cannot coordinate a live shared match on its own. Online PvP needs a backend such as Firebase or Supabase Realtime, with trusted server-side validation or equivalent secure functions.

Recommended flow:

1. Player chooses Play Online and creates a private room or enters a room code.
2. Both players join, see names/readiness, and confirm they are ready.
3. Backend creates the shared board state/seed and randomly chooses who goes first.
4. Backend owns the active player, score, target, timer deadline, inventory, streaks, pending power-up, and match status.
5. Client submits a proposed action; backend validates player, turn, deadline, selection, item ownership, and legality.
6. Backend resolves scoring and board changes and broadcasts the accepted state to both clients.
7. Reconnect after network drops using the authoritative room state. Consider a short reconnection grace period rather than instantly awarding a win.
8. Persist account-level Stars and inventory server-side.

Do not trust a client-supplied score, item count, deadline, winner, or hidden board state. A browser-only prototype can simulate these features locally, but it is not secure online multiplayer.

Same-device **Pass & Play** can be an interim mode. During hand-off, cover the board so the next player cannot see the previous player's picks.

## 10. Current implementation status

The following reflects the current repository state at the time this guide was written; re-check the code before relying on it after future changes.

### Implemented in the prototype

- Phaser 3 canvas/layout and game art.
- 7×7 starting board.
- Shape asset loading and mystery tile face.
- Initial reveal/hide behavior and cascade/destroy visual effects.
- Basic tile selection and Submit/match-scoring flow.
- Score values of 1 / 2 / 5 for groups of 3 / 4 / 5+.
- Neutral wooden dummy asset and tap behavior, including brief reveal then hide.
- Inventory & Shop overlay opened by the Inventory button.
- Shop purchases for Audience Pick, Double Time, Double Play, and Score Strike.
- Local storage of Star balance and item counts using `shapey-stars` and `shapey-inventory`.
- Shop starts with 1 Star if no saved balance exists.
- A descriptive Cancel Counter card/explanation in the shop.
- Per-player scores, an active-player indicator, and turn hand-over after a submitted match or timeout (same-device pass-and-play).
- A running 45-second turn countdown that works concurrently with the 5-second "MEMORIZE" reveal countdown for new tiles, followed by the sequential 2-second-per-swap shuffle with square strokes around the swapping pair.
- Inventory access limit: 2 opens per player per rolling 5 minutes, with the turn clock still running while the shop is open.
- Four-mode menu: Play alone, Player vs AI, Player 1 vs Player 2 and **Tag: 2 vs 2**.
- **Tag mode:** two teams of two on one device, partners alternating (Player 1, 3, 2, 4), one shared score per team, a header line naming the active player, and a separate inventory limit for each of the four players.
- **AI difficulty picker** (Easy / Professional) and a distinct **Professional AI**; both levels are configured by `AI_LEVELS`.
- **Hazard rules:** hazards are 20% of tiles in every mode (`HAZARD_CHANCE`). Two-player modes: picked first = no damage; picked after shapes = -1 and destroys itself and the picked tiles, no reward (`hazardBlast()`). Play alone: always destroys, never costs.

### Not yet implemented or incomplete

- Per-player stars, inventory, and streaks (the shop still uses one shared balance), plus a hand-off screen that hides the board between pass-and-play turns.
- The 90-second Double Time turn and authoritative (server) turn deadlines.
- Player-selected target score, complete victory flow, rematch, and tie policy.
- Successful-match streak and Star reward logic.
- In-match use/effects for the purchased power-ups.
- Real Cancel tile pickup, Counter inventory item, and response/cancellation flow.
- Removing Cancel from normal match generation.
- AI use of inventory items (Easy and Professional play without power-ups).
- Online Tag/PvP; a hand-off screen between the four same-device Tag players.
- Online rooms, shared board, server-authoritative state, reconnect handling, accounts, and secure persistent inventory.
- Audience Pick interaction, Practice Audience voting, and real spectator voting.
- Complete settings and sound controls.
- Full validation of edge cases across animations, timers, and repeated inputs.

The shop's purchase flow is currently a local prototype: purchasing deducts Stars and increments a local item count, but the purchased item does not yet perform its in-match effect. The Cancel Counter card description is informational, not a working counter mechanic.

## 11. Recommended implementation architecture

Keep the game rules in a small state/model layer and let Phaser handle presentation and animation.

Suggested state data:

- `board`: current grid with stable tile IDs and shape keys.
- `players[2]`: player ID/name, score, Stars, inventory, match streak, used-once flags.
- `activePlayerIndex`: whose turn it is.
- `targetScore`: selected match target.
- `turnEndsAt`: absolute deadline for the current turn.
- `turnDurationMs`: 45 seconds normally, 90 seconds for an eligible Double Time turn.
- `phase`: ready, study, active turn, resolving, hand-off, finished.
- `pendingPowerUp`: power-up awaiting a Cancel Counter response, if any.
- `matchStatus`: active, won, draw, or abandoned.
- `turnNumber`: incremented once per resolved turn.
- `boardVersion`: optional version counter to reject stale client actions.

Prefer pure functions for validation/scoring where possible: e.g. `validateSelection`, `scoreFor`, `applyScoreStrike`, `resolveTimeout`, and `advanceTurn`. The UI should request an action and then animate the accepted result; animation callbacks should not be the source of truth for scores or turn ownership.

Guard all state transitions so timeout, Submit, animation completion, and power-up cancellation cannot resolve the same turn twice.

## 12. Suggested development order

1. **Core turn engine:** two independent scores, active player, real 45-second countdown, timeout, valid-submit resolution, and input locks.
2. **Board resolution:** stable tile identities, correct match removal/cascade/spawn/reveal, and remembered-tile handling.
3. **Match lifecycle:** configurable target, victory, end-state input lock, and rematch.
4. **Stars/streaks:** per-player streak, rewards, timeout reset, and balance display.
5. **Inventory use:** consume cards correctly and implement Double Time, Double Play, Score Strike, and Cancel Counter response windows.
6. **Special pickups:** remove Cancel from normal shapes and implement its separate collection path.
7. **AI:** Easy then Hard, both limited to observed information.
8. **Audience Pick:** clearly labelled Practice Audience first; real votes only after backend integration.
9. **Online backend:** rooms, authoritative moves/timers, account persistence, reconnect handling, and server-side item validation.
10. **Polish/testing:** settings, audio, accessibility, tutorial, turn hand-off, animation races, and regression tests.

## 13. Minimum acceptance tests

Before calling the core rules complete, test at least these cases:

- Exactly three identical normal shapes score 1; four score 2; five or more score 5.
- Non-adjacent matching tiles are valid.
- A group of two is rejected and scores nothing.
- A wrong normal shape resets the current attempt but does not end the turn.
- A dummy between matching tiles is ignored and does not reset the attempt or count toward the minimum.
- A dummy never scores.
- Cancel never scores and never counts as a normal match.
- Collecting Cancel grants exactly one Counter card.
- Cancel blocks only Score Strike, Double Time, and Double Play, and is consumed only on a successful counter.
- Audience Pick cannot be countered by Cancel.
- Score Strike floors the opponent's score at zero and can be used only once per player per match.
- Double Time grants 90 seconds only to the next eligible turn.
- Double Play grants one extra 45-second turn and cannot chain during that bonus turn.
- A timeout with no valid match awards no points, resets only that player's streak, and advances exactly once.
- A successful match advances the streak once, regardless of whether 3, 4, or 5+ tiles were matched.
- Breaking a streak does not remove Stars already earned.
- Reaching the target ends the match and blocks further moves.
- Taps during resolution, after timeout, or from the inactive player are ignored.
- Online clients cannot forge scores, inventory, turn deadlines, or hidden board information.

---

For current visual/layout details, start in `src/main.js`. For the shorter player-facing rule design and original feature decisions, see `GAMEPLAY.md`. Keep this guide updated whenever a rule changes, especially where implemented behavior differs from the design.
