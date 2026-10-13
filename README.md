<p align="center"><img src="assets/ui/shapey%20logo.webp" alt="Shapey" width="360" /></p>

# Shapey

A memory-and-matching game built with Phaser 3. Play it at https://tayo6.github.io/shapey/

Pick a mode on the opening menu:

- **Play alone** - no timer or attempt limit. You lose only when your score reaches -15.
- **Player vs AI** - take turns against the computer; first to **100 points** wins. Choose **Easy** or **Professional** first.
- **Player 1 vs Player 2** - two players on one device, 45 seconds per turn; first to **100 points** wins.
- **Tag: 2 vs 2** - two teams share one device and one score per team; partners alternate turns (Player 1, Player 3, Player 2, Player 4, ...). First team to **200 points** wins.

Hazard (skull) tiles have a 10% spawn chance in every mode. In Player vs AI, Player vs Player and Tag, a hazard picked first does no damage and flips back; picked after other shapes it costs 1 point and destroys itself and the shapes picked before it, with no reward. In Play alone a hazard never costs anything: it always destroys itself and any picked shapes.

See `GAMEPLAY.md` for the rules and `DEVELOPER_GUIDE.md` for how the code is organised. Handy URL options for testing: `?mode=alone|ai|pvp|tag`, `?level=easy|pro` (with `?mode=ai`), `?review=3000`, `?reveal=2000`, `?swap=500`, `?turn=10000`, `?hazard=0.5` (values clamp to 0–1; invalid values use the 10% default).
