// Shapey - reveal countdowns, the safety heal, and the new-tile shuffle animation.
// Extracted from GameScene (scenes/game.js) as a prototype mixin.

import { STUCK_UP_MS, SHUFFLE_ARC_PX } from '../constants.js';
import { TILE_SIZE, SPAWN_REVEAL_MS, SHUFFLE_STEP_MS } from '../config.js';
import { planShuffle } from '../utils.js';

export const BoardMotionMixin = {
  // Starts the "memorize" countdown for a batch of tiles. It runs on its own deadline, at the same time
  // as the turn clock, and is not affected by whose turn it is. Spawned tiles (shuffle = true) are
  // shuffled once they are face-down; the opening board is not.
  startReview(batch, ms = SPAWN_REVEAL_MS, shuffle = true) {
    this.reveals.add(batch, ms, shuffle);
  },

  // Once a batch's reveal time is over, flip its tiles to mystery one after the other, then shuffle them.
  // Tiles the player is currently using stay face-up.
  hideFinishedReveals() {
    for (const batch of this.reveals.takeDue()) {
      batch.tiles.forEach((tile, i) => {
        if (tile.active && !tile.selected) this.flipTile(tile, false, i * 35);
      });
      if (batch.shuffle) {
        const token = this.shuffleToken;
        Promise.all(batch.tiles.map((t) => t.flipChain)).then(() => {
          if (token === this.shuffleToken) this.runShuffle(batch.tiles, token);
        });
      }
    }
  },

  // Safety net: a tile may only be face-up while it is picked, being revealed (opening study / new tiles), mid-swap,
  // or briefly shown by a dummy/hazard tap. Anything else that has been face-up for STUCK_UP_MS is flipped back down,
  // so a mismatch can never leave shapes showing, whatever the cause.
  healStuckTiles() {
    const now = this.time.now;
    for (const row of this.tiles) {
      for (const tile of row) {
        if (!tile || !tile.active || !tile.faceUp || tile.selected || tile.swapping) continue;
        if (!tile.upSince || now - tile.upSince < STUCK_UP_MS) continue;
        if (this.reveals.batches.some((b) => b.tiles.includes(tile))) continue;
        this.flipTile(tile, false);
      }
    }
  },

  // ------------------------------------------------------------- shuffle
  // A tile can take part in a swap when it is on the board and not picked by the player.
  canShuffle(tile) {
    return tile.active && !tile.selected && !tile.swapping;
  },

  // Performs the planned swaps of a batch strictly one after another, SHUFFLE_STEP_MS each.
  // The rest of the board stays playable; only the two tiles in motion can't be tapped.
  async runShuffle(tiles, token) {
    this.shuffling++;
    try {
      for (const [i, j] of planShuffle(tiles.length).steps) {
        if (token !== this.shuffleToken) break;
        const a = tiles[i];
        const b = tiles[j];
        if (this.canShuffle(a) && this.canShuffle(b)) await this.swapTiles(a, b);
      }
    } finally {
      this.shuffling--;
    }
  },

  // Stops all shuffling (a match is being resolved and the board is about to change).
  // A swap in progress snaps to its end position so the board is consistent.
  cancelShuffles() {
    this.shuffleToken++;
    this.reveals.cancelShuffles();
    if (this.activeSwap) this.activeSwap.finishNow();
  },

  // Swaps two tiles' places over SHUFFLE_STEP_MS. The tiles bow in opposite directions so they pass each
  // other, and a square stroke follows each of them.
  swapTiles(a, b) {
    return new Promise((resolve) => {
      // Start and end points are the tiles' grid cells, so a swap always lands exactly on the grid.
      const ax = this.cellX(a.col), ay = this.cellY(a.row);
      const bx = this.cellX(b.col), by = this.cellY(b.row);
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const px = -(by - ay) / len;
      const py = (bx - ax) / len;

      // Watching tiles trade places confuses the AI: it may forget what it knew about them.
      if (this.modeCfg.ai) [a, b].forEach((t) => this.aiPlayer.forgetSwapped(t));

      // Board data changes first, so the grid always says where each tile belongs.
      const [aRow, aCol, bRow, bCol] = [a.row, a.col, b.row, b.col];
      this.tiles[bRow][bCol] = a;
      this.tiles[aRow][aCol] = b;
      a.row = bRow; a.col = bCol;
      b.row = aRow; b.col = aCol;

      const makeBox = (tile) => {
        const box = this.add.graphics({ x: tile.x, y: tile.y }).setDepth(14);
        box.lineStyle(5, 0x66e0ff, 1);
        box.strokeRect(-TILE_SIZE / 2 - 2, -TILE_SIZE / 2 - 2, TILE_SIZE + 4, TILE_SIZE + 4);
        return box;
      };
      a.swapping = b.swapping = true;
      const boxA = makeBox(a);
      const boxB = makeBox(b);
      const prevDepth = [a.depth, b.depth];
      a.setDepth(11); b.setDepth(11);

      const place = (t) => {
        const bow = t >= 1 ? 0 : Math.sin(Math.PI * t) * SHUFFLE_ARC_PX; // exact landing on the grid
        a.x = ax + (bx - ax) * t + px * bow; a.y = ay + (by - ay) * t + py * bow;
        b.x = bx + (ax - bx) * t - px * bow; b.y = by + (ay - by) * t - py * bow;
        boxA.x = a.x; boxA.y = a.y; boxB.x = b.x; boxB.y = b.y;
      };
      const state = { t: 0 };
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        place(1);
        boxA.destroy(); boxB.destroy();
        a.swapping = b.swapping = false;
        a.setDepth(prevDepth[0]); b.setDepth(prevDepth[1]);
        if (this.activeSwap && this.activeSwap.tween === tween) this.activeSwap = null;
        resolve();
      };
      const tween = this.tweens.add({
        targets: state, t: 1, duration: SHUFFLE_STEP_MS, ease: 'Sine.easeInOut',
        onUpdate: () => place(state.t), onComplete: finish,
      });
      this.activeSwap = { tween, finishNow: () => { tween.stop(); finish(); } };
    });
  },

};
