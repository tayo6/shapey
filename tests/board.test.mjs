// Unit tests for src/board.js (makeInitialBoard, ShapeBag).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeInitialBoard, ShapeBag } from '../src/board.js';
import { SHAPE_KEYS, MATCH_SHAPE_KEYS, MIN_MATCH } from '../src/constants.js';

const VALID = new Set([...SHAPE_KEYS, 'hazard', 'dummy']); // the board spawns shape keys, hazards and dummies

test('makeInitialBoard builds a rows x cols grid of valid tiles', () => {
  for (const [rows, cols] of [[7, 7], [6, 6], [5, 5]]) {
    const board = makeInitialBoard(rows, cols, 0.1);
    assert.equal(board.length, rows);
    board.forEach((row) => assert.equal(row.length, cols));
    const flat = board.flat();
    assert.equal(flat.length, rows * cols);
    flat.forEach((shape) => assert.ok(VALID.has(shape), `unexpected tile ${shape}`));
  }
});

test('makeInitialBoard keeps the requested hazard share (rounded)', () => {
  // 49 tiles at 10% -> Math.round(4.9) = 5 hazards; the rest are shapes/dummies.
  assert.equal(makeInitialBoard(7, 7, 0.1).flat().filter((s) => s === 'hazard').length, 5);
  assert.equal(makeInitialBoard(5, 5, 0).flat().filter((s) => s === 'hazard').length, 0);
  assert.equal(makeInitialBoard(6, 6, 1).flat().filter((s) => s === 'hazard').length, 36);
});

test('makeInitialBoard guarantees three copies of several scoring shapes', () => {
  const counts = {};
  for (const shape of makeInitialBoard(7, 7, 0.1).flat()) counts[shape] = (counts[shape] || 0) + 1;
  const guaranteed = Object.entries(counts)
    .filter(([shape]) => MATCH_SHAPE_KEYS.includes(shape) && counts[shape] >= MIN_MATCH);
  // (49 - 5 hazards) / 3 = 14 slots -> up to 11 shapes get an exact triple to start from.
  assert.ok(guaranteed.length >= 8, `expected several guaranteed shapes, got ${guaranteed.length}`);
});

test('ShapeBag never deals the same shape twice in a row', () => {
  const bag = new ShapeBag(['a', 'b', 'c']);
  let last = null;
  for (let i = 0; i < 200; i++) {
    const shape = bag.next();
    assert.ok(['a', 'b', 'c'].includes(shape));
    assert.notEqual(shape, last, 'a shape is never dealt twice in a row');
    last = shape;
  }
});

test('ShapeBag keeps working with a single shape', () => {
  const bag = new ShapeBag(['x']);
  for (let i = 0; i < 10; i++) assert.equal(bag.next(), 'x');
});

test('ShapeBag boosts scarce shapes with an extra copy per round', () => {
  // With three keys and 'a' scarce, every refill queue is [a, b, c, a]: each round deals
  // every shape once plus one extra 'a' (the never-deal-twice rule only reorders, it
  // cannot hide the boost with three or more keys). Seeded so the counts are stable.
  const realRandom = Math.random;
  let seed = 0x2a; // xorshift32
  Math.random = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) / 4294967296);
  };
  try {
    const bag = new ShapeBag(['a', 'b', 'c']);
    const counts = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 300; i++) counts[bag.next(['a'])] += 1;
    assert.equal(counts.a + counts.b + counts.c, 300);
    assert.ok(counts.a > 130, `scarce 'a' should be dealt roughly half the time: ${JSON.stringify(counts)}`);
    assert.ok(counts.b < counts.a && counts.c < counts.a, `both others behind 'a': ${JSON.stringify(counts)}`);
    // Without the scarce boost the three shapes would even out around 100 each.
  } finally {
    Math.random = realRandom;
  }
});
