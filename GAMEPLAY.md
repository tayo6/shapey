# Shapey — Gameplay & Rules Design

This document describes the recommended rules for turning the current Phaser prototype into a competitive memory game. It is a design specification, not a claim that these features are already implemented.

## 1. Core loop

- The board is 7 × 7. At the beginning of a game, all normal shapes are visible for 15 seconds, then turn face-down. Face-up tiles can't be picked while they are showing (a shape is only revealed by the player flipping it), and the first turn's clock starts after this study phase.
- Versus turns alternate. Player vs AI Easy and Player 1 vs Player 2 use **45 seconds per turn**; Player vs AI Professional and each Tag pick use **30 seconds per turn**. The opening study phase is not charged to the first turn.
- On a turn, the player taps hidden tiles to reveal their shapes and tries to collect 3 or more of the same normal shape. Matches do not need to be adjacent.
- A valid submitted match awards points, removes the matched shapes, causes the board to cascade, and ends the turn. Newly spawned tiles are shown for 5 seconds, flip face-down, and are then shuffled (see "New-tile shuffle" below).
- In versus modes, picking a different normal shape resets the selection and ends the turn immediately. Submitting fewer than 3 shapes awards no points but still ends the turn. Play Alone is different: a wrong normal shape costs 1 point and play continues.
- When a versus clock expires, a selected group of 3 or more matching shapes is **auto-submitted**. If there is no valid group, the selection is cleared and the turn passes without a reward.
- **Two clocks run at the same time.** The turn clock and the 5-second "memorize" reveal of newly spawned tiles (followed by their shuffle) are independent; a reveal or shuffle never pauses, resets, or extends a turn.
- The Submit button ends the active versus turn even if the player still has time or selected fewer than 3 shapes. **Double Play** is the sole exception: using it grants that same player one extra 45-second turn; it cannot chain. The turn deadline auto-submits any valid selected match.
- **Versus targets are fixed by mode:** Player vs AI and Player 1 vs Player 2 end when a side first reaches or exceeds **50 points**; Tag ends when a team first reaches or exceeds **100 points**. Play Alone wins at **50 points** and loses at **−15 points**; it has no attempt-based checkpoint or turn countdown. Online, the server—not the browser—must authoritatively resolve scores and winners.

### Which shapes spawn (shuffle bag)

New tiles are not picked purely at random. A shuffle bag deals every normal shape once per round in random order, so the same shape is never dealt twice in a row and a refill is always varied. Shapes with fewer than 3 tiles left on the board get one extra copy per round so matches stay possible. (The earlier rule gave every new tile to the shape that had just been matched away, so refills were all one shape.) Hazards and wooden dummies are rolled first, then the bag supplies the shape. As a safety net, if a refill leaves no shape with 3 tiles, some new tiles are converted to the most common shape.

### New-tile shuffle (fairness rule)

Showing new tiles for 15 seconds would favour whoever is playing. Instead:

1. New tiles spawn face-up for **5 seconds**, then flip face-down (mystery side up). The opening 15-second study phase is unchanged and is not shuffled.
2. The new tiles then **swap places with each other** (only new tiles move; older tiles are never touched). N new tiles give **N − 1 swaps** (3 tiles = 2, 4 = 3, 5 = 4 ...), with no upper limit.
3. Swaps happen **one after another, 2 seconds each** (never at the same time). The two tiles of a swap travel to each other's cell along a slight arc, each with a square stroke around it.
4. Chain rule: after A swaps with B, the next tile (C) swaps with A or B. Once every tile has taken part, remaining swaps re-shuffle tiles that already moved. The same pair is not swapped back-to-back.
5. About **10%** of new tiles sit the shuffle out (at least 3 tiles, or all of them if fewer, always take part).
6. A tile the player has already picked does not move; swaps that involve it are skipped. A tile that is mid-swap can't be tapped; the rest of the board stays playable.
7. If a match is submitted during a shuffle, the shuffle stops, the swap in progress settles on its end position, and the board resolves.

### Suggested scoring

| Normal shapes matched | Points |
|---|---:|
| 3 | 1 |
| 4 | 2 |
| 5 or more | 5 |

Keep these existing values initially so the new mechanics can be tested without changing two parts of the game's balance at once. Track score separately for each player.

## 2. Game modes

### Mode menu (implemented)

The game has four modes: **Play Alone**, **Player vs AI**, **Player 1 vs Player 2**, and **Tag: 2 vs 2**. Player vs AI opens a **Choose difficulty** panel (Easy / Professional / Back). Product requirement: Player 1 vs Player 2 and Tag are online-only. In the authoritative-gameplay development branch, the Worker and Phaser client are wired together and CI tests a local two-browser PvP match plus local Worker integration for two-player PvP and four-player Tag. Real-device and staging validation remain outstanding. For local-mode testing, `?mode=alone` or `?mode=ai` skips the menu; online-only Player 1 vs Player 2 and Tag must go through the room lobby. `?mode=ai` starts on Easy unless `?level=pro` is added.

### Tag: 2 vs 2 (authoritative engine integrated in development branch; validation outstanding)

Tag is the online 2-vs-2 mode. Team 1 is Player 1 and Player 2; Team 2 is Player 3 and Player 4. The server-side engine enforces the turn order P1 → P3 → P2 → P4 and keeps one shared score per team. Local Worker integration verifies all four player seats and their turn sequence, but the browser presentation and physical four-device flow still require staging/end-to-end testing.

- **Turn order:** the teams alternate, and each team's partners take turns, so the sequence is Player 1 → Player 3 → Player 2 → Player 4 → Player 1 → ... A partner "tags in" every other turn.
- **One score per team.** A match scores for the team of whoever played it, so partners add to the same score. The header planks read TEAM 1 / TEAM 2, and a line under the timer names the team and partner whose turn it is (for example "TEAM 1: PLAYER 2"). The turn toast says the same.
- **Everything else matches Player 1 vs Player 2:** 45-second turns, 10% hazards, same scoring, shuffle and timeout rules. A timeout passes to the next player in the sequence. First team to 100 points wins.
- **Inventory limit is per player:** each of the four players has their own 2-opens-per-5-minutes allowance (`limiterSlot()`).
- Fixed score targets and the local winner screen are implemented. Stars, streaks and inventory still use one shared balance, and there is no hand-off screen hiding the board between players.

### Play alone (implemented)

- One player, no turn countdown, and no Player 2 score plank. The header shows the number of tries and the score floor.
- A try is one attempt at a match: a submitted match, a wrong shape, or a submit with fewer than 3 tiles. Hazards and wooden-dummy flips do not count.
- There is **no 15-attempt checkpoint or minimum-points requirement**. You can continue playing indefinitely regardless of how many points you earn in a series of attempts.
- A wrong normal shape costs 1 point; submitting fewer than 3 tiles is free. Hazards never cost points in Play Alone. The game ends only when the score reaches **−15**.
- The end screen shows the final score and tries, with Play Again and Main Menu.
- Constants: ALONE_SCORE_FLOOR and ALONE_MISS_PENALTY.

### Hazard tile (implemented)

`hazard.webp` (skull and crossbones) is a special tile, not a normal shape: it never matches, never joins the selection and is excluded from the guaranteed-three distribution. What it does depends on whether other shapes are already picked:

- **Versus modes:** picked first it does no damage, reveals briefly and flips back, and the turn goes on. Picked after real shapes it costs **1 point** (`HAZARD_BLAST_PENALTY`) and destroys itself and all picked tiles without a reward. A Dummy does not count as a real shape; Dummy + Hazard destroys both without a penalty.
- **Play alone:** a hazard never costs anything. Whether picked first or after shapes, it destroys itself and every shape currently picked (it is not counted as an attempt).
- In every mode the destroyed tiles burst with the normal effect, the board falls and refills, the new tiles get the usual 5-second reveal and shuffle, and the turn is spent like a match. A wrong shape only flips the picks back, and a match pays points.

In the two-player and Tag modes a hazard blast always costs 1 point, even at 0, so a score can go negative (set `TWO_PLAYER_SCORE_FLOOR` in `src/constants.js` to 0 to stop that).

| Mode | Hazard share of tiles |
|---|---:|
| All modes (`HAZARD_CHANCE`) | 10% |

The starting board gets about that share of hazards, and every newly spawned tile has that chance (`MODES[...].hazard`; `?hazard=0.5` overrides it for testing, clamped to 0–1; invalid values are ignored and fall back to the 10% default).

### Play against AI

**Status:** both levels and the difficulty picker are implemented. After choosing Player vs AI the player picks **Easy** or **Professional** (the "Hard" design below, named Professional in the game). The level is shown on the AI's plank ("AI Easy" / "AI Pro") and is kept by Restart and Play again. Every number that differs between the levels lives in the `AI_LEVELS` table in `src/constants.js` (see `AIPlayer` in `src/ai.js` and `aiAttempt` in `src/scenes/game.js`). The opponent takes a visible turn, reveals tiles with a short delay, submits its match, and then returns control to the player.

| | Easy | Professional |
|---|---|---|
| Share of seen tiles remembered | 45–60% | 95–100% |
| Remembers a tile as the wrong shape | 10% | 1% |
| Forgets a shuffled tile | 50% | 10% |
| Thinking pause / pause per tap | 1.4 s / 0.7–1.2 s | 0.9 s / 0.45–0.8 s |
| Turn duration | 45 seconds | 30 seconds |
| Picks the biggest remembered group | 20% of the time | always |
| Reaches for | 3 tiles, sometimes 4 | 5 tiles (the 5+ score) |
| With no full match remembered | guesses | starts from the shape it remembers most copies of, then explores tiles it has no memory of |

Neither level reaches for a bigger match when under 6 seconds of the turn is left (`AI_SPARE_MS`). The AI keeps acting during its turn until it submits a match, makes a real mismatch, or the clock expires. At timeout, any valid selected match auto-submits. Double Play is usable by a human player; other power-up effects are not yet active.

**Easy**
- Remembers roughly 45–60% of the tiles it saw, with intentional memory mistakes.
- Selects a valid match when it remembers one; otherwise it makes plausible guesses.
- Uses a little of the turn rather than responding instantly.
- Rarely prioritizes the largest possible match.
- Never sees the hidden board state that a human could not have observed.

**Hard**
- Remembers almost all tiles it legitimately saw, but still has no access to unseen information.
- Tracks the tile identities as tiles fall after a cascade, so its memory follows the actual pieces rather than stale grid coordinates.
- Prioritizes a remembered 5+ match, then 4, then 3, while keeping enough time to finish the play.
- Uses inventory powers strategically, with clear limits and the same star costs as a human.
- Has realistic tap delays, so difficulty comes from better memory and decisions rather than implausibly instant actions.

Both difficulties use the same board, scoring, hazards, and match rules. The Professional level has a shorter 30-second turn by design; Easy has 45 seconds. Do not secretly change the board odds for Professional.

### Play online

Online Human-vs-Human uses a Cloudflare Worker with Durable Objects; GitHub Pages hosts the Phaser client. The authoritative-gameplay development branch contains the server-side board, turn/scoring/hazard/timeout rules and client message integration for PvP and Tag. The live deployed Worker is still the earlier lobby prototype until a separately reviewed deployment is completed. Do not consider online matches release-ready before a real two-device PvP test, a four-device Tag test, security/reconnect checks and a verified non-destructive Cloudflare migration/deployment plan. Online Audience Polls, Score Strike, Cancel Counter, spectator access and chat remain unimplemented. Supabase is not required for live room/gameplay state; a database may be added later for persistent accounts, match history, or analytics.

Recommended lobby flow:
1. Choose **Play Online** and create a private room or enter a room code.
2. Wait for the second player; show both names and a ready state.
3. Start with a shared board seed/state and randomly choose who goes first.
4. Send each valid move to the backend and broadcast the accepted result to both clients.
5. Reconnect with the same per-room seat token and restore the latest server state after a network drop. The current draft reserves that seat for the room's lifetime; a polished reconnect/abandoned-player grace policy still needs design and real-device testing.

**Product decision:** Player 1 vs Player 2 and Tag are online-only modes. Do not add a same-device Pass & Play alternative. Each participant must use their own device; keep the room lobby status clear until synchronized gameplay is available.

## 3. Stars, streaks, and the inventory

Treat **Stars as a persistent currency**. A new local browser profile starts with **exactly 1 free Star** and **one free Audience Pick**. The score planks show one star icon and a dynamic multiplier (for example, ⭐*1 or ⭐*4) reflecting that profile's spendable balance. In the current prototype, balances and inventory are stored in that browser's LocalStorage; account-based per-player wallets await online gameplay integration.

### Inventory access limit (anti-stalling)

- Each player may **open the inventory at most 2 times in any rolling 5-minute window**. Only a successful open counts; a refused attempt is not recorded, and buying an item while the shop is open does not count as another open.
- The turn clock **keeps running while the inventory is open** (the shop shows the live turn clock). If the turn times out while the shop is open, the shop closes and the turn passes.
- When the limit is reached, show a short message with when the inventory is available again.
- Limits are per player. Opening is attributed to the player whose turn it is.

### Match streak rewards (the recommended clear rule)

This streak is about successful matching turns, not winning whole games:
- Each completed turn that successfully matches **3 or more normal matching tiles** increases that player's match streak by 1. A match of 4 or 5+ also counts as one successful matching instance.
- Every player starts with **1 Star**. The third consecutive successful matching turn awards **+1 Star**, the fourth awards **+2 additional Stars**, the fifth awards **+3 additional Stars**, and so on (streak length minus 2).
- A turn that expires without a valid match breaks the streak and resets the streak counter to 0. The next successful match starts a new streak at 1. A wrong tap alone does **not** break the streak if the player later completes a valid match during that same turn.
- **Stars already earned are never taken away when a streak breaks.** Only the streak counter resets. For example, a player starts with 1 Star, gets three successful matching turns and earns 1 more (balance 2), then times out on their next turn: they keep 2 Stars, but their next successful match starts a fresh streak at 1.
- Award a reward only once when the player first reaches each streak length. Display a clear toast such as “3-match streak! +1 Star”, “4-match streak! +2 Stars”, or “5-match streak! +3 Stars”.
- Store star balance and inventory per account online. For the offline prototype, local storage can be used for testing, but it is not secure or transferable across devices.

### Power-up shop and costs

Buying an item deducts its Stars immediately and puts a card into the player's inventory. The player can save cards and select one when its use is legal. Do not charge again when consuming a card.

| Item | Cost | Effect |
|---|---:|---|
| **Audience Pick** | 3 Stars | Additional uses cost 3 Stars; a new local profile receives one free use. It opens a clearly labeled simulated Practice Audience poll. |
| **Extra Time (+45s)** | 3 Stars | Each use adds 45 seconds to the current turn's remaining deadline, including in Professional AI mode. | 
| **Double Play** | 4 Stars | After the current turn, the player immediately gets one extra 45-second turn before control passes to the opponent. |
| **Score Strike** | 5 Stars | Subtracts 10 points from the opponent, with their score floored at 0. Limit it to once per player per match. |

Extra Time can be used repeatedly if the player owns multiple cards; each use adds another 45 seconds to the current turn and consumes one card. Double Play must not chain into another Double Play during its bonus turn. If a match ends, unused inventory items should remain owned.

### Audience Pick (the “Who Wants to Be a Millionaire?” moment)

- A new local profile starts with one free Audience Pick; additional poll cards cost 3 Stars.
- Using it consumes one card and displays four candidate shape names with simulated vote bars/percentages.
- The panel is explicitly labeled **Practice Audience · Simulated Votes**. These are fictional practice votes, not a live audience.
- The recommendation is advice, not a guarantee of a match; it does not reveal tile coordinates.
- Real fan polls require a backend, vote validation, rate limiting, and a policy for who may join a poll (for example, invited spectators or followers).

## 4. Special tiles: Wooden Dummy and Cancel Counter

### Blank wooden dummy = no effect

The new `assets/shapes/dummy.webp` is a plain wooden tile with no symbol or shape. It is a **neutral dummy**, not a scoring shape and not a power-up.

- It can be flipped/revealed during a player's normal selection sequence.
- It never adds or subtracts points, never counts toward the minimum of 3 matching normal shapes, and never breaks a selection or forces the player to restart.
- Treat it as though it was not picked for matching. For example, `🟨 🟨 [blank wood] 🟨 🟨` is still a four-yellow match.
- It should appear occasionally, not dominate the board.

### Existing Cancel tile = defensive inventory card

The planned `cancel.webp` pickup represents the **Cancel Counter**. The full collectible-and-counter flow is not yet implemented. When implemented, it should grant a Cancel Counter card to the player's inventory and cancel an opponent's **Score Strike (-10), Extra Time (+45s), or Double Play** before the effect takes place.

- The card is consumed only when it successfully cancels one of those effects.
- It does not cancel Audience Pick, and it does not itself add or subtract score.
- Show the card in inventory and provide a clear response window before the opponent's power-up resolves.
- In online play, the backend must validate card ownership and resolve timing so both clients agree on whether the counter was used in time.

The blank wooden dummy and the Cancel Counter are therefore separate: one does nothing, while the other is a defensive item.

### Required event logic, why it exists, and acceptance tests

This section makes the rules executable for a developer or coding AI. It distinguishes **the intended design** from **what the current prototype already does**. Do not assume a rule is implemented merely because it is documented here. Before coding, inspect the current source and compare it with the status notes in section 6. Implement each event once, in a shared game-state function where possible, rather than duplicating rules in tile-click handlers, UI buttons, and animations.

#### A. Classify every tile before handling a click

Every board tile must be classified as one of these types:

1. **Normal scoring shape** — a color/shape that can be selected as part of a match, counts toward the minimum of three, and can earn points.
2. **Wooden Dummy** — a neutral decoy. It is not a normal shape and never scores.
3. **Cancel Counter pickup** — a collectible defensive item. It is not a normal shape and never scores.
4. **Mystery tile** — keep its behavior explicitly defined by the existing game design; do not accidentally treat it as a normal scoring shape unless its rules say so.

Why this classification is necessary: if all texture keys are treated as ordinary shapes, special tiles can accidentally satisfy a match, break a valid selection, be awarded points, or appear in the “three of every shape” balancing bag. Use an explicit normal-shape allowlist for matching and guaranteed board distribution. Exclude `dummy`, `cancel`, and `mystery` from normal matching unless a later rule explicitly says otherwise. Keep tile type separate from its image filename so visual assets do not become the game rules by accident.

**Click handling order:** first check that the match is active, the current player owns the turn, the board is accepting input, the tile is face-down/revealed in a valid state, and no conflicting animation or resolution is underway. Then route the tile by type. Only normal scoring shapes should enter the normal selection/matching algorithm. A tile must not be processed twice from rapid taps or overlapping pointer events.

#### B. Wooden Dummy: reveal without interfering with a match

**Purpose:** the blank wooden tile creates a brief visual interruption and tests whether the player remembers the real shapes around it. It is deliberately neutral. It must not punish the player just because the board contains a decoy.

**Required behavior:**

1. When a player taps a face-down Wooden Dummy, reveal its wooden image briefly so the player can recognize it.
2. Do not append the dummy to the player's selected-tile list.
3. Do not set or change the selected normal shape based on the dummy.
4. Do not count it toward the minimum of three, add points, subtract points, award Stars, or consume a turn.
5. Do not clear, restart, or invalidate an existing normal-shape selection.
6. After the brief reveal, return it to the face-down state unless the tile is being handled by a separate, explicitly specified board-resolution effect.
7. During its reveal/flip animation, ignore repeated taps on that same dummy so one tap cannot trigger several animations or side effects.

**Example acceptance test:** the player selects yellow, yellow, taps a Wooden Dummy, then selects yellow, yellow. The selection contains four yellow tiles, and the player can submit those four for the normal four-tile score. The dummy is not part of the submitted group. The same rule applies if the dummy appears before the first yellow or between any two normal selections.

**Why this matters:** treating a dummy like a wrong-colored shape would reset the selection and make the player lose progress. Treating it as a normal shape could make a dummy match possible or change the scoring count. Both contradict its role as a harmless decoy.

**Spawning:** the dummy should appear occasionally, not as one of the guaranteed copies of every normal shape. Use a named, configurable spawn probability and apply it only when creating optional/random board tiles or replacements. Avoid adding the dummy to the normal-shape allowlist. Keep the spawn probability in one place so it can be tuned without changing matching logic. Initial-board generation and cascade/refill generation must use consistent classification rules.

#### C. Cancel Counter pickup: board tile becomes an inventory item

**Purpose:** the Cancel tile is a collectible defense, not a scoring shape and not the same thing as the Wooden Dummy. The dummy only interrupts visually; the Cancel pickup grants a resource that can protect the player from certain opponent power-ups later.

**Required pickup flow:**

1. When a face-down Cancel tile is encountered during an active player's turn, reveal and resolve it as a pickup rather than adding it to normal selection.
2. Grant exactly **one Cancel Counter** to that player's inventory. Store the count as an integer owned by that player, not as a global count shared by both players.
3. Resolve/remove the pickup tile from the board so it cannot be collected again. Refill that cell according to the board's normal replacement rules; if replacement tiles have a reveal period, show the replacement for the specified 15 seconds before hiding it.
4. The Cancel tile does not count toward a three-tile match, does not award or subtract points, does not award Stars, and is not submitted as part of a match.
5. Collecting it must not clear or alter an existing normal-shape selection. It should not count as a wrong shape.
6. Make the pickup idempotent: one tile instance can grant one counter at most, even if the player taps repeatedly or an animation/event fires twice.
7. Update the visible inventory count immediately after collection. Persist it for the local prototype if local saving is enabled; in online play, save it in the authoritative match/player state instead of trusting local storage.

**Why this matters:** the board tile and the inventory card are two stages of one mechanic. If the game only displays a Cancel image but never increments inventory, the player has no usable defense. If the tile remains collectible after being picked up, repeated clicks can duplicate items. If it is included in normal matching, it can corrupt selection and scoring.

**Acceptance tests:** tapping one Cancel tile increases only the active player's counter count by one; tapping it again cannot increase the count; it never changes the score; and collecting it between two matching normal shapes does not reset that selection. A player with zero counters cannot activate a counter. A player with two counters who successfully counters one eligible attack ends with one counter.

#### D. Inventory and shop: ownership, purchase, and use are different actions

Keep these concepts separate in code and UI:

- **Stars** are the currency used to buy shop power-ups.
- **Owned power-up inventory** is a count of items the player has bought and can use.
- **Cancel Counter inventory** is a defensive count gained from collecting Cancel tiles.
- **Using an item** spends one owned item; buying an item spends Stars and increases owned inventory. Buying must not automatically activate the item.

Use the documented shop prices: additional Audience Picks cost 3 Stars, Extra Time (+45s) costs 3 Stars, Double Play costs 4 Stars, and Score Strike costs 5 Stars. A new local profile begins with 1 free Star and one free Practice Audience Pick. The shop must reject purchases when the balance is below the price, must never make the balance negative, and must update the displayed balance and inventory count together after a successful purchase. If persistence is enabled, save the updated balance and counts as one coherent state change so a refresh cannot save one without the other.

A successful purchase flow is: validate price and balance → deduct the price once → increment that item's owned count once → save state → refresh the UI. A failed purchase changes nothing. A successful use flow is: validate that the item is owned and can legally be used in the current match state → create the effect or pending-effect event → consume one item according to the item's rule → update/save state. If validation fails, do not consume the item. Do not let button double-clicks purchase or spend the same item twice.

**Why this matters:** the shop screen alone is not a functioning power-up system. Clear separation prevents Stars from being deducted when an item is used, prevents free activation of unowned items, and makes it possible to test and synchronize multiplayer actions.

LocalStorage is acceptable for a local single-device prototype, but it is not secure or authoritative for online multiplayer. For an online match, the server should validate ownership, prices, timing, targets, and effects. Never trust a browser-provided score or inventory update as the final result.

#### E. Counter response: cancel eligible attacks before they take effect

A Cancel Counter is a response to an opponent's **pending** power-up, not a general undo button. Eligible attacks are **Score Strike, Extra Time (+45s), and Double Play**. **Audience Pick cannot be countered.**

Use this event sequence for each eligible attack:

1. The attacking player requests to use the power-up. Validate that the player owns it and that it is legal now.
2. Create a pending effect with a unique action ID, the attacker, the target, and the effect type. Do not apply the effect yet.
3. Notify the targeted opponent and show a clear response prompt with a short, visible deadline. A 3-second response window is a recommended default; keep the duration in one configurable constant.
4. If the targeted opponent has at least one Cancel Counter and activates it before the deadline, validate the pending action again, consume exactly one counter, mark the pending action as cancelled, and apply none of its effects.
5. If the opponent has no counter, does not respond, or the deadline expires, resolve the pending action normally. A late response must not cancel an effect that has already resolved.
6. Mark the pending action as resolved exactly once. Repeated clicks, duplicated network messages, or two competing responses must not apply the effect twice or consume multiple counters.
7. Show both players the outcome: cancelled, applied, or rejected. Keep the action result in match state so both clients render the same result.

If a counter is attempted when there is no eligible pending attack, the attack is already resolved, the attack is Audience Pick, or the player has no counters, reject the attempt and consume nothing.

**Why this matters:** without a pending state and response window, the attack might apply immediately before the defender has a chance to react. Without one unique pending-action record, latency or repeated taps can cause duplicate attacks, duplicate counters, or different results on the two players' screens.

For Score Strike, the intended effect is to subtract 10 points from the opponent, subject to the game's score floor of zero, and it can be used at most once per player per match. For Extra Time, each use adds 45 seconds to the affected player's current turn deadline. For Double Play, the intended effect is to grant the affected player one additional 45-second turn; do not allow the bonus turn to chain into another Double Play unless a future rule explicitly permits it. The code should apply these effects only after the counter window closes without a successful counter. Audience Pick follows its own voting/poll flow and does not open a Cancel Counter response window.

#### F. Keep the turn and board state consistent around special tiles

The special-tile handler must coexist with the normal turn lifecycle. It should not silently submit a match, end a turn, award a match score, or reset the timer unless a specific rule requires it. The 45-second turn timer is the normal deadline; remove the old 10-second idle auto-submit behavior. If time expires while a player has only an incomplete selection, award no match points and pass the turn. A pickup or dummy animation should not create an extra turn or allow input after the turn has ended.

For online play, the server should own the canonical board, active player, turn deadline, score, Stars, inventory, pending power-up, counter response deadline, and match result. Clients may animate and display state, but must not independently decide that an attack was cancelled, a counter was consumed, or a score changed.

#### G. Definition of done for these mechanics

Do not mark these mechanics complete just because the assets or UI exist. Test them in the actual game loop:

- [ ] Dummy can appear in initial/random replacement generation without entering the normal match-shape list.
- [ ] Dummy reveals briefly, then hides; it neither scores nor interrupts a normal selection.
- [ ] Cancel pickup grants one counter to the correct player, is removed/refilled, and cannot be collected twice.
- [ ] Cancel, dummy, and mystery are excluded from guaranteed normal-shape distribution and normal match validation.
- [ ] Shop purchases deduct the right Stars and add exactly one owned item; insufficient balance changes nothing.
- [ ] Item use validates ownership and match state; failed use consumes nothing.
- [ ] A counter blocks Score Strike, Double Time, and Double Play only when used in the response window; it cannot block Audience Pick.
- [ ] No-counter, late-counter, double-click, duplicate-event, and simultaneous-response cases resolve deterministically.
- [ ] Scores, turn timers, inventories, and the visible UI agree after each action.
- [ ] Documentation and UI distinguish implemented prototype behavior from planned behavior.

## 5. Turn-state rules and edge cases

Every turn should pass through one explicit state machine:

`READY → ACTIVE_TURN → SELECTING → RESOLVING → TURN_END → NEXT_PLAYER`

- The 45-second clock starts when ACTIVE_TURN begins, not while a menu or connection is loading.
- Only the active player may interact with tiles, use a power-up, or submit.
- A valid match must contain at least 3 normal tiles of the same shape. The cancel dummy tile may be flipped as part of the sequence but is excluded from the matching count and score. A Counter Shield tile is resolved as a rare inventory pickup, not a normal match.
- Prevent duplicate submits while animations are running.
- At timeout, ignore late taps and submissions, clear highlights, finish safe animations, and pass turn exactly once.
- Use an absolute `turnEndsAt` timestamp for UI countdowns. Online, the backend owns that timestamp.
- Resolve tile destruction and cascading before starting the next player's turn.
- If a cascade produces no suitable match, do not secretly reshuffle in a way that changes remembered tiles. Either accept the rarer board or use a clearly visible reshuffle rule.
- A Score Strike cannot make score negative. Decide and display a tie-breaker (for example, one 45-second sudden-death turn) if the match reaches its turn cap with equal scores.

## 6. Code review findings in the current prototype

- `src/main.js` retains local turn handling for Player vs AI and Play Alone. In the authoritative-gameplay development branch, Player 1 vs Player 2 and Tag open the online lobby and are wired to server snapshots/actions. The Worker is the source of truth for the board, hidden shapes, scores, active turn, hazard resolution, timeout deadlines, and match result. The live deployed Worker is still the older lobby-only version, so this branch's online gameplay is not enabled in production.
- Player vs AI Easy uses 45-second turns; Professional uses 30 seconds. Versus submit and real mismatches end turns; a valid selection auto-submits at timeout. Extra Time (+45s) adds to the current deadline. Server-authoritative deadlines remain unimplemented.
- The score-plank star display uses one star icon and the current local balance multiplier. A new local browser profile receives 1 Star and one free Practice Audience Poll; local consecutive-match Star rewards are implemented; account-based wallets are not implemented.
- Inventory opens a working shop panel. Audience Pick works as an explicitly simulated Practice Audience; Extra Time and Double Play have use actions. Other power-up effects and real audience votes remain unimplemented.
- The live deployed Worker still supports only the lobby/room prototype. The development branch contains a synchronized authoritative online game session, including a per-room seat token that restores a reconnecting player's seat and current state. A real-device/staging run is still required. There is no live audience/poll service.
- The blank wooden dummy has its own `dummy.webp` asset and neutral behavior. Cancel Counter pickup, per-player item storage in an online match, and its counter-use flow still need implementation.
- The old idle auto-submit was removed. A valid versus selection is auto-submitted at the turn deadline, rather than waiting beyond the timer for a manual Submit.
- Player mode, scoring, turn deadline, inventory, streak, and board resolution should be owned by a small game-state layer instead of being scattered across animation callbacks. UI animations should react to resolved state, not decide the result themselves.

## 7. Recommended implementation order

1. **Core rules:** active player, score per player, 45-second countdown, turn timeout, match end/rematch, correct reset on wrong tiles.
2. **AI modes:** Easy and Hard (Professional) using only information each player could reasonably observe. *(Done, except power-up use.)*
3. **Stars and inventory:** 1 starting Star plus one free Practice Audience Pick per new local profile, account wallets for online players, successful-match streak rewards, Extra Time (+45s), Double Play, Score Strike, and the rare Counter Shield.
4. **Audience Pick:** begin with a clearly labelled practice audience; replace it with real voting only after a live backend exists.
5. **Online play:** complete real-device/staging validation of the authoritative PvP and Tag game, Cloudflare migration safety, reconnect and abandoned-player policy; then implement the remaining online inventory effects, polls, spectator voting, chat, and optional persistent accounts/history.
6. **Polish:** short tutorial, sound toggle, reduced-motion option, turn hand-off screen, match history, streak celebration, and a post-match rematch button.

The order matters: the power-ups depend on reliable turn and score rules, and real online polls depend on the backend. Building those in the reverse order would create features that appear to work but can be exploited or desynchronise between clients.
