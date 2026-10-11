# Shapey — Gameplay & Rules Design

This document describes the recommended rules for turning the current Phaser prototype into a competitive memory game. It is a design specification, not a claim that these features are already implemented.

## 1. Core loop

- The board is 7 × 7. At the beginning of a game, all normal shapes are visible for 15 seconds, then turn face-down.
- Players alternate turns. Each turn lasts **45 seconds**.
- On a turn, the player taps hidden tiles to reveal their shapes and tries to collect 3 or more of the same normal shape. Matches do not need to be adjacent.
- A valid submitted match ends that player's turn, awards points, removes those tiles, and causes the board to cascade. Newly spawned tiles are shown for 15 seconds before hiding.
- A wrong shape resets the current selection, but does not immediately end the turn. This preserves the memory challenge without making one mis-tap fatal.
- If the timer expires without a valid submitted match, award no points and pass the turn.
- The Submit button confirms a valid group. Remove the current prototype's separate 10-second idle auto-submit; the 45-second turn timer should be the only automatic deadline.
- The match is a race to a target score chosen before play. The default target is **100 points**; players can choose any target from 100 to **1,000**. In a two-player match, the first player to reach the selected target wins. Use a short victory sequence and a rematch option. In online play, the server—not the browser timer—must be authoritative.

### Suggested scoring

| Normal shapes matched | Points |
|---|---:|
| 3 | 1 |
| 4 | 2 |
| 5 or more | 5 |

Keep these existing values initially so the new mechanics can be tested without changing two parts of the game's balance at once. Track score separately for each player.

## 2. Game modes

### Play against AI

After selecting AI, show **Easy** and **Hard**. The opponent should take a visible turn, reveal tiles with a short delay, submit its match, and then return control to the player.

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

Both difficulties should use the same board, turn duration, scoring, and power-up rules. Do not secretly change the board odds for Hard.

### Play online

Online Human-vs-Human needs a shared real-time game service. GitHub Pages can host the client, but it cannot by itself coordinate live rooms, protect scores and inventory from browser tampering, or collect live audience votes. Use a service such as **Supabase Realtime** or **Firebase** for room codes, presence, turn state, server-side deadlines, inventory, match results, and fan votes.

Recommended lobby flow:
1. Choose **Play Online** and create a private room or enter a room code.
2. Wait for the second player; show both names and a ready state.
3. Start with a shared board seed/state and randomly choose who goes first.
4. Send each valid move to the backend and broadcast the accepted result to both clients.
5. Reconnect gracefully after a network drop; a short reconnection grace period is better than instantly awarding a win.

A same-device **Pass & Play** mode is a useful interim option while the online service is being connected. Hide the board during hand-off so the next human cannot see the previous player's picks.

## 3. Stars, streaks, and the inventory

Treat **Stars as a persistent currency**, not as the five decorative icons beside the score. Every player starts with **1 free Star**. The inventory screen displays the actual spendable balance and owned item cards.

### Match streak rewards (the recommended clear rule)

This streak is about successful matching turns, not winning whole games:
- Each completed turn that successfully matches **3 or more normal matching tiles** increases that player's match streak by 1. A match of 4 or 5+ also counts as one successful matching instance.
- A player's third successful matching turn in a row awards **3 Stars**. Their fourth successful matching turn in the same streak awards **4 additional Stars**; the fifth awards **5 additional Stars**, and so on.
- A turn that expires without a valid match breaks the streak and resets the streak counter to 0. The next successful match starts a new streak at 1. A wrong tap alone does **not** break the streak if the player later completes a valid match during that same turn.
- **Stars already earned are never taken away when a streak breaks.** Only the streak counter resets. For example, a player starts with 1 Star, gets three successful matching turns and earns 3 (balance 4), then times out on their next turn: they keep 4 Stars, but their next successful match starts a fresh streak at 1.
- Award a reward only once when the player first reaches each streak length. Display a clear toast such as “3-match streak! +3 Stars” or “4-match streak! +4 Stars”.
- Store star balance and inventory per account online. For the offline prototype, local storage can be used for testing, but it is not secure or transferable across devices.

### Power-up shop and costs

Buying an item deducts its Stars immediately and puts a card into the player's inventory. The player can save cards and select one when its use is legal. Do not charge again when consuming a card.

| Item | Cost | Effect |
|---|---:|---|
| **Audience Pick** | 3 Stars | Starts a short fan poll to recommend one of the candidate shapes for the current attempt. |
| **Double Time** | 3 Stars | Makes the player's next turn 90 seconds instead of 45. |
| **Double Play** | 4 Stars | After the current turn, the player immediately gets one extra 45-second turn before control passes to the opponent. |
| **Score Strike** | 5 Stars | Subtracts 10 points from the opponent, with their score floored at 0. Limit it to once per player per match. |

Double Play must not chain into another Double Play during its bonus turn. Double Time and Double Play should show a visible active badge so players know what is in effect. If a match ends, unused inventory items should remain owned.

### Audience Pick (the “Who Wants to Be a Millionaire?” moment)

- The player chooses Audience Pick from inventory while making a match.
- The poll asks the audience which shape to pursue from the available candidates; show a short countdown and a live vote bar/percentage.
- Each eligible fan can vote once. Do not let the opponent or the active player vote in their own poll.
- Do not reveal exact hidden tile coordinates. The poll is advice, not a cheat that guarantees a match.
- If no real audience is connected, label the feature **Practice Audience** and simulate an explicitly fictional vote. Never present generated votes as real fans.
- Real fan polls require a backend, vote validation, rate limiting, and a policy for who may join a poll (for example, invited spectators or followers).

## 4. Special tiles: Wooden Dummy and Cancel Counter

### Blank wooden dummy = no effect

The new `assets/shapes/dummy.png` is a plain wooden tile with no symbol or shape. It is a **neutral dummy**, not a scoring shape and not a power-up.

- It can be flipped/revealed during a player's normal selection sequence.
- It never adds or subtracts points, never counts toward the minimum of 3 matching normal shapes, and never breaks a selection or forces the player to restart.
- Treat it as though it was not picked for matching. For example, `🟨 🟨 [blank wood] 🟨 🟨` is still a four-yellow match.
- It should appear occasionally, not dominate the board.

### Existing Cancel tile = defensive inventory card

The existing `cancel.png` represents the **Cancel Counter**. It is not a normal scoring shape and must not be matchable for points. When collected, it grants a Cancel Counter card to the player's inventory. The player can deliberately use that card to cancel an opponent's **Score Strike (-10), Double Time, or Double Play** before the effect takes place.

- The card is consumed only when it successfully cancels one of those effects.
- It does not cancel Audience Pick, and it does not itself add or subtract score.
- Show the card in inventory and provide a clear response window before the opponent's power-up resolves.
- In online play, the backend must validate card ownership and resolve timing so both clients agree on whether the counter was used in time.

The blank wooden dummy and the Cancel Counter are therefore separate: one does nothing, while the other is a defensive item.

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

- `src/main.js` currently has one real `this.score` value; Player 2's score is not part of a real turn system.
- The 45-second timer is a static `00:45` label. There is no running countdown, turn deadline, timeout, or turn hand-off.
- The star rows are currently decorative; there is no starting free Star, successful-match streak tracker, or inventory currency.
- Only Submit has a click handler. Polls, Inventory, and Settings do not yet open working panels.
- There is no AI, online lobby, live audience/poll service, rematch flow, or match-winner state.
- The blank wooden dummy now has its own `dummy.png` asset and neutral tap behavior. The existing `cancel.png` should become a defensive inventory card rather than a normal scoring shape; its collection, inventory display, and counter-use flow still need implementation.
- The current idle auto-submit runs after a valid selection has been idle for 10 seconds, even though the design needs a 45-second turn timer. That timer should be removed or repurposed.
- Player mode, scoring, turn deadline, inventory, streak, and board resolution should be owned by a small game-state layer instead of being scattered across animation callbacks. UI animations should react to resolved state, not decide the result themselves.

## 7. Recommended implementation order

1. **Core rules:** active player, score per player, 45-second countdown, turn timeout, match end/rematch, correct reset on wrong tiles.
2. **AI modes:** Easy and Hard using only information each player could reasonably observe.
3. **Stars and inventory:** 1 starting Star, successful-match streak rewards, persistent wallet, buy/use flows, Double Time, Double Play, Score Strike, and the rare Counter Shield.
4. **Audience Pick:** begin with a clearly labelled practice audience; replace it with real voting only after a live backend exists.
5. **Online play:** room codes, presence, authoritative turn/move validation, persistent accounts and inventory, reconnect handling, and spectator voting.
6. **Polish:** short tutorial, sound toggle, reduced-motion option, turn hand-off screen, match history, streak celebration, and a post-match rematch button.

The order matters: the power-ups depend on reliable turn and score rules, and real online polls depend on the backend. Building those in the reverse order would create features that appear to work but can be exploited or desynchronise between clients.
