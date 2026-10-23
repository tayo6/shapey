// Shapey - starting-board generation and the spawning shuffle bag.
// Pure data in / data out (no Phaser, no DOM); unit-tested in tests/board.test.mjs.


// Starting board: include at least three copies of each chosen scoring shape without
// overflowing the smaller boards. Every board size keeps about 10% hazards.
// The caller passes the live grid size (GameScene reads it from config.js), so this
// module stays free of page state and testable from Node.

import { MATCH_SHAPE_KEYS } from './constants.js';
import { randomBoardShape, shuffle } from './utils.js';

export function makeInitialBoard(rows, cols, hazardChance = 0) {
  const total = rows * cols;
  const wantedHazards = Math.min(total, Math.round(total * hazardChance));
  const guaranteedShapeCount = Math.min(MATCH_SHAPE_KEYS.length, Math.floor((total - wantedHazards) / 3));
  const startingShapes = shuffle(MATCH_SHAPE_KEYS).slice(0, guaranteedShapeCount);
  const bag = [];
  startingShapes.forEach((k) => bag.push(k, k, k));
  const hazards = Math.min(total - bag.length, Math.round(total * hazardChance));
  for (let i = 0; i < hazards; i++) bag.push('hazard');
  while (bag.length < total) bag.push(randomBoardShape());
  const flat = shuffle(bag);
  return Array.from({ length: rows }, (_, r) => flat.slice(r * cols, (r + 1) * cols));
}

// Spawning uses a "shuffle bag" instead of pure randomness: every shape is dealt once per round in a
// random order, so the same shape is never dealt twice in a row and no shape can dominate a refill.
// Shapes that are short on the board (fewer than MIN_MATCH) get one extra copy per round, so
// matches stay possible without flooding the board with the shape that was just removed.
export class ShapeBag {
  constructor(keys) {
    this.keys = keys;
    this.queue = [];
    this.last = null;
  }
  next(scarce = []) {
    if (!this.queue.some((k) => k !== this.last)) {
      this.queue.push(...shuffle([...this.keys, ...scarce.filter((k) => this.keys.includes(k))]));
    }
    let i = this.queue.length - 1;
    while (this.queue[i] === this.last) i--; // skip a repeat of the previous shape
    const [shape] = this.queue.splice(i, 1);
    this.last = shape;
    return shape;
  }
}
