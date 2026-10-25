<p align="center"><img src="assets/ui/shapey%20logo.webp" alt="Shapey" width="360" /></p>

# Shapey

A memory-and-matching game built with Phaser 3. Play it at https://tayo6.github.io/shapey/

Pick a mode on the opening menu:

- **Play alone** - no turn timer or attempt limit. Reach **50 points** to win; reaching **−15 points** loses the game.
- **Player vs AI** - take turns against the computer; first to **50 points** wins. Choose **Easy** or **Professional** first.
- **Player 1 vs Player 2** - online-only; two players on **two separate devices**, 45 seconds per turn; first to **50 points** wins.
- **Tag: 2 vs 2** - online-only; four players on **four separate devices**. Team 1 is Players 1 and 2; Team 2 is Players 3 and 4. Turns rotate Player 1 → Player 3 → Player 2 → Player 4, with 30 seconds per pick. First team to **100 points** wins.

Hazard (skull) tiles have a 10% spawn chance in every mode. A Hazard always destroys itself, together with every tile picked before it (Dummy tiles included), and picking one first still ends the turn - the same player never gets a free retry. Only Play Alone loses a point (1) when a Hazard detonates; the versus modes never subtract score for a Hazard, and Dummy tiles never cost points of their own.

Audience polls: Player vs AI, Player 1 vs Player 2 and Tag have a **Polls** button, with 3 free polls per player per game (never bought with Stars). Against the AI the votes are a labelled practice audience; online they are live spectator votes. Play Alone has no polls.

Online play (Player 1 vs Player 2 and Tag) uses the authoritative multiplayer Worker documented in `worker/STAGING.md`; the game at the home page now connects to that Worker. The earlier production Worker (`shapey-multiplayer`) is no longer used by the game. Before relying on online matches, test Player 1 vs Player 2 on two real devices and Tag on four. See `GAMEPLAY.md` for the rules and `DEVELOPER_GUIDE.md` for how the code is organised. Handy URL options for testing: `?mode=alone|ai|pvp|tag`, `?level=easy|pro` (with `?mode=ai`), `?review=3000`, `?reveal=2000`, `?swap=500`, `?turn=10000`, `?hazard=0.5` (values clamp to 0–1; invalid values use the 10% default).
