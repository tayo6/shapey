# Shapey online multiplayer: implementation plan

## Current verified baseline

The deployed `shapey-multiplayer` Cloudflare Worker supports room creation, room information, WebSocket joins, player-number assignment, `ping`, and `ready` messages. It does not yet synchronize gameplay actions. The Worker is configured with a `ROOMS` Durable Object binding and the `Room` class.

The browser game in `src/main.js` already has online room-creation and room-connection UI, and its existing modes include:
- Player vs AI (local; not an online room mode)
- Player 1 vs Player 2 (online, 2 players; target score 100)
- Tag (online, 4 player connections, 2 teams of 2; target score 200)

Do not add another game mode. Keep GitHub Pages as the frontend host and Cloudflare Workers + Durable Objects as the initial online backend.

## Implementation sequence

### 1. Bring the deployed Worker under source control
- Add the exact deployed Worker source to the repository, without changing production.
- Add a reproducible Wrangler configuration for the existing `ROOMS` Durable Object binding and migration.
- Document a staging deployment and smoke-test procedure.

### 2. Harden room and connection lifecycle
- Validate WebSocket `Origin` against the same explicit allowlist as the web app.
- Add idle expiration for empty rooms and a bounded room lifetime; verify cleanup behavior in Durable Objects.
- Add rate limits / abuse controls for room creation and connection attempts.
- Give players reconnect identities so a disconnect/reconnect does not silently change their player number.
- Ensure malformed messages and invalid room states fail safely.

### 3. Implement server-authoritative online gameplay
- Define a versioned WebSocket message protocol for game start, action submission, turn changes, board updates, scores, hazards, game over, and reconnect/state resync.
- Keep the server authoritative for turn ownership, scoring, hazards, win conditions, and accepted actions; clients should render the accepted state rather than independently deciding outcomes.
- Preserve the current game rules and UI. In online Player 1 vs Player 2, the target is 100. In Tag, the two teams share the team score and the target is 200.
- A normal turn passes to the next player. Do not let a player take another turn just because their browser is still active. Preserve the explicitly designed inventory shopping exception for a double play only if that rule is already supported by the game logic.
- Do not change local Play Alone or Player vs AI behavior while integrating online modes.

### 4. Test before production deployment
- Add protocol/unit tests for valid and invalid messages, player limits, turn order, scoring, hazards, and win conditions.
- Test two separate browser sessions for Player 1 vs Player 2 and four sessions for Tag.
- Test full rooms, wrong mode, disconnect/reconnect, expired rooms, and a late join.
- Deploy to staging first, run smoke tests, and only then promote to production.

### 5. Add audience features after core gameplay is reliable
- Add spectator/guest identities and a controlled spectator limit.
- Add text chat with message size/rate limits.
- Add audience polls with a 20-second voting window while tiles are face-down, ranked results, and player selection of a ranked tile to auto-flip.
- Enforce a maximum of five polls per player per game.
- Keep these features in the same Cloudflare architecture initially; evaluate a separate database only if a concrete requirement emerges.

## Data/storage decision

Supabase is not required for the current milestone. Durable Objects are suitable for live room state and coordination. Consider adding a database later only for persistent accounts, long-term match history, or analytics that must survive room expiration. Do not create or modify the unrelated `social-content-db` as part of this work.

## Production safety

Do not deploy changes directly to the live Worker until the source, tests, binding/migration configuration, and staging smoke tests are in place. Keep production unchanged while implementation is reviewed.
