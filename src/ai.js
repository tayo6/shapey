// Shapey - the AI opponent's memory and decisions (Player vs AI).
//
// GameScene (scenes/game.js) owns the timing and the visible taps: runAITurn /
// aiTap / aiAttempt decide WHEN to act. This module owns WHAT the AI knows and
// WHAT it reaches for:
//   * memory: every tile it has seen - partly wrong (level.mistake) and partly
//     forgotten (rolled once per game from level.recall); a swapped tile may be
//     forgotten (level.forgetOnSwap). Memory is kept per tile (not per grid
//     cell), so it follows tiles as they fall.
//   * decisions: which remembered group to reach for (biggest at Hard), and
//     plausible guesses otherwise (never a remembered dummy/hazard/cancel).
//
// Pure data in / data out: no Phaser, no clocks, no DOM. The injected `rand`
// (defaults to Math.random) makes the memory deterministic under test.
// Unit-tested in tests/ai.test.mjs.
// A tile the AI may tap right now: on the board, not picked, not moving, still face-down.

import { MIN_MATCH, SHAPE_KEYS } from './constants.js';
import { randomItem } from './utils.js';

export function aiCanTap(tile) {
  return tile.active && !tile.selected && !tile.swapping && !tile.faceUp;
}

export class AIPlayer {
  constructor(level, rand = Math.random) {
    this.level = level;
    this.rand = rand;
    this.memory = new Map(); // tile -> shape the AI believes it is
    this.recall = level.recall[0] + rand() * (level.recall[1] - level.recall[0]);
  }

  // Records a glimpse of a tile. `certain` tiles (its own picks) are always remembered;
  // other glimpses are kept only recall-share of the time, and a remembered tile may
  // be recalled as the wrong shape (level.mistake).
  see(tile, certain = false) {
    if (!certain && this.rand() > this.recall) return;
    const slip = !certain && this.rand() < this.level.mistake;
    this.memory.set(tile, slip ? randomItem(SHAPE_KEYS) : tile.shape);
  }

  // A shuffled tile is forgotten forgetOnSwap-share of the time.
  forgetSwapped(tile) {
    if (this.rand() < this.level.forgetOnSwap) this.memory.delete(tile);
  }

  // Remembered, still available tiles of one shape.
  known(shape) {
    const list = [];
    for (const [tile, remembered] of this.memory) {
      if (!tile.active) this.memory.delete(tile);
      else if (remembered === shape && aiCanTap(tile)) list.push(tile);
    }
    return list;
  }

  // Remembered, still available tiles grouped by shape: one list per shape
  // (never dummies, hazards or cancels).
  groups() {
    const groups = {};
    for (const [tile, shape] of this.memory) {
      if (!tile.active) { this.memory.delete(tile); continue; }
      if (shape === 'dummy' || shape === 'hazard' || shape === 'cancel' || !aiCanTap(tile)) continue;
      (groups[shape] = groups[shape] || []).push(tile);
    }
    return Object.values(groups);
  }

  // A shape it remembers at least 3 of. Easy rarely goes for the biggest group;
  // Professional always does.
  chooseGroup() {
    const ready = this.groups().filter((list) => list.length >= MIN_MATCH);
    if (!ready.length) return null;
    ready.sort((a, b) => b.length - a.length);
    return this.rand() < this.level.bestGroupChance ? ready[0] : randomItem(ready);
  }

  // A plausible guess: any hidden tile it doesn't remember as something else (and never
  // a remembered dummy/hazard/cancel). Professional starts a fresh attempt on a tile it
  // has no memory of, where it can still learn something.
  guess(shape = null, tiles = []) {
    const pool = [];
    for (const row of tiles) {
      for (const tile of row) {
        if (!tile || !aiCanTap(tile)) continue;
        const remembered = this.memory.get(tile);
        if (remembered === 'dummy' || remembered === 'hazard' || remembered === 'cancel') continue;
        if (shape && remembered && remembered !== shape) continue;
        pool.push(tile);
      }
    }
    if (!shape && this.level.preferUnknown) {
      const unknown = pool.filter((tile) => !this.memory.has(tile));
      if (unknown.length) return randomItem(unknown);
    }
    return pool.length ? randomItem(pool) : null;
  }
}
