// Unit tests for src/utils.js (pure helpers: shuffle, randomItem, formatClock,
// planShuffle, randomBoardShape). Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { shuffle, randomItem, formatClock, planShuffle, randomBoardShape } from '../src/utils.js';
import { SHAPE_KEYS, DUMMY_SPAWN_CHANCE, SHUFFLE_SKIP_CHANCE } from '../src/constants.js';

// Deterministic PRNG (mulberry32) so shuffle/planShuffle tests are reproducible.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('shuffle returns a permutation without mutating the input', () => {
  const input = [1, 2, 3, 4, 5, 6, 7, 8];
  const copy = input.slice();
  const out = shuffle(input);
  assert.deepEqual(input, copy, 'input must not be mutated');
  assert.deepEqual([...out].sort((a, b) => a - b), copy, 'output is a permutation');
});

test('shuffle of empty and single-element lists is safe', () => {
  assert.deepEqual(shuffle([]), []);
  assert.deepEqual(shuffle(['x']), ['x']);
});

test('randomItem returns a member of the list', () => {
  const list = ['a', 'b', 'c'];
  for (let i = 0; i < 20; i++) assert.ok(list.includes(randomItem(list)));
});

test('formatClock rounds up, clamps at zero and pads to MM:SS', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(-5000), '00:00');      // never negative
  assert.equal(formatClock(45000), '00:45');
  assert.equal(formatClock(44001), '00:45');      // rounds up
  assert.equal(formatClock(59999), '01:00');      // 59.999s rounds up to a minute
  assert.equal(formatClock(60000), '01:00');
  assert.equal(formatClock(3661000), '61:01');    // minutes are not capped at 59
});

test('planShuffle: fewer than 2 tiles plans nothing', () => {
  assert.deepEqual(planShuffle(0), { steps: [], skipped: [] });
  assert.deepEqual(planShuffle(1), { steps: [], skipped: [] });
});

test('planShuffle: N tiles give N-1 valid swap steps', () => {
  for (const count of [2, 3, 4, 5, 8]) {
    const rng = seeded(count * 7919);
    const { steps, skipped } = planShuffle(count, rng, SHUFFLE_SKIP_CHANCE);
    assert.equal(steps.length, count - 1, `${count} tiles`);
    for (const [a, b] of steps) {
      assert.ok(a !== b, 'a swap never pairs a tile with itself');
      assert.ok(a >= 0 && a < count && b >= 0 && b < count, 'indexes stay inside the batch');
    }
    for (const i of skipped) assert.ok(i >= 0 && i < count);
    // Same seed, same plan: the planner is fully driven by the injected rng.
    assert.deepEqual(planShuffle(count, seeded(count * 7919), SHUFFLE_SKIP_CHANCE), { steps, skipped });
  }
});

test('planShuffle: skipChance 0 involves everyone, skipChance 1 still involves at least 3', () => {
  const none = planShuffle(5, seeded(1), 0);
  assert.equal(none.skipped.length, 0);
  assert.equal(none.steps.length, 4);
  const all = planShuffle(5, seeded(2), 1);
  // Every tile rolled a skip, but the minimum-player rule pulls (up to) 3 back in.
  assert.ok(all.skipped.length <= 2, 'at most 2 of 5 tiles sit out when everything rolls a skip');
  assert.equal(all.steps.length, 4);
});

test('randomBoardShape returns a dummy DUMMY_SPAWN_CHANCE-share of the time', () => {
  const realRandom = Math.random;
  try {
    Math.random = () => 0; // below every threshold -> dummy
    assert.equal(randomBoardShape(), 'dummy');
    Math.random = () => 0.999; // above the dummy chance -> a spawnable shape key
    assert.ok(SHAPE_KEYS.includes(randomBoardShape()));
    assert.notEqual(randomBoardShape(), 'dummy');
  } finally {
    Math.random = realRandom;
  }
});
