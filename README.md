<p align="center"><img src="assets/ui/shapey%20logo.webp" alt="Shapey" width="360" /></p>

# Shapey

A memory-and-matching game built with Phaser 3. Play it at https://tayo6.github.io/shapey/

Pick a mode on the opening menu:

- **Play alone** - no turn timer or attempt limit. Reach **100 points** to win; reaching **−15 points** loses the game.
- **Player vs AI** - take turns against the computer; first to **100 points** wins. Choose **Easy** or **Professional** first.
- **Player 1 vs Player 2** - online-only; two players on **two separate devices**, 45 seconds per turn; first to **100 points** wins.
- **Tag: 2 vs 2** - online-only; four players on **four separate devices**. Team 1 is Players 1 and 2; Team 2 is Players 3 and 4. Turns rotate Player 1 → Player 3 → Player 2 → Player 4, with 30 seconds per pick. First team to **200 points** wins.

Hazard (skull) tiles have a 10% spawn chance in every mode. In Player vs AI, Player vs Player and Tag, a hazard picked first does no damage and flips back; picked after other shapes it costs 1 point and destroys itself and the shapes picked before it, with no reward. In Play alone a hazard never costs anything: it always destroys itself and any picked shapes.

Online play (Player 1 vs Player 2 and Tag) uses the authoritative multiplayer Worker documented in `worker/STAGING.md`; the game at the home page now connects to that Worker. The earlier production Worker (`shapey-multiplayer`) is no longer used by the game. Before relying on online matches, test Player 1 vs Player 2 on two real devices and Tag on four. See `GAMEPLAY.md` for the rules and `DEVELOPER_GUIDE.md` for how the code is organised. Handy URL options for testing: `?mode=alone|ai|pvp|tag`, `?level=easy|pro` (with `?mode=ai`), `?review=3000`, `?reveal=2000`, `?swap=500`, `?turn=10000`, `?hazard=0.5` (values clamp to 0–1; invalid values use the 10% default).
