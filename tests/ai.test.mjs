// Unit tests for src/ai.js (the AI opponent's memory and decisions).
// AIPlayer takes an injected rand, so recall/mistake/forget rolls are exact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AIPlayer, aiCanTap } from '../src/ai.js';
import { AI_LEVELS, SHAPE_KEYS, MIN_MATCH } from '../src/constants.js';

// A tile stub with the fields aiCanTap and the memory read: active/selected/swapping/faceUp/shape.
function tile(shape = 'star', over = {}) {
  return { shape, active: true, selected: false, swapping: false, faceUp: false, ...over };
}

// Sequence rng: returns the given values in order, then repeats the last one.
function seq(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

test('aiCanTap accepts only available face-down tiles', () => {
  assert.equal(aiCanTap(tile()), true);
  assert.equal(aiCanTap(tile('star', { active: false })), false);
  assert.equal(aiCanTap(tile('star', { selected: true })), false);
  assert.equal(aiCanTap(tile('star', { swapping: true })), false);
  assert.equal(aiCanTap(tile('star', { faceUp: true })), false);
});

test('certain glimpses (its own taps) are always remembered correctly', () => {
  const ai = new AIPlayer(AI_LEVELS.easy, seq([1]));
  const t = tile('circle');
  ai.see(t, true);
  assert.equal(ai.memory.get(t), 'circle');
});

test('glimpses beyond the rolled recall share are forgotten', () => {
  // recall rolls to ~0.6 (Easy); a later roll of 0.99 fails the recall check.
  const ai = new AIPlayer(AI_LEVELS.easy, seq([0.5, 0.99]));
  const t = tile('circle');
  ai.see(t);
  assert.equal(ai.memory.has(t), false);
});

test('a remembered glimpse may be recalled as the wrong shape (mistake)', () => {
  const realRandom = Math.random;
  try {
    // Easy mistake chance 0.1: roll 0.05 passes recall (recall = 0.525) and slips.
    Math.random = () => 0; // randomItem then picks SHAPE_KEYS[0]
    const ai = new AIPlayer(AI_LEVELS.easy, seq([0.5, 0.05]));
    const t = tile('star');
    ai.see(t);
    assert.equal(ai.memory.get(t), SHAPE_KEYS[0]);
    assert.notEqual(ai.memory.get(t), 'star');
  } finally {
    Math.random = realRandom;
  }
});

test('forgetSwapped drops a tile only forgetOnSwap-share of the time', () => {
  const kept = new AIPlayer(AI_LEVELS.pro, seq([0.5, 0.9])); // pro forgetOnSwap 0.1
  const a = tile();
  kept.see(a, true);
  kept.forgetSwapped(a);
  assert.equal(kept.memory.has(a), true, '0.9 >= 0.1: the memory survives the swap');

  const forgotten = new AIPlayer(AI_LEVELS.easy, seq([0.5, 0.05])); // easy forgetOnSwap 0.5
  const b = tile();
  forgotten.see(b, true);
  forgotten.forgetSwapped(b);
  assert.equal(forgotten.memory.has(b), false, '0.05 < 0.5: the swap wiped the memory');
});

test('known() lists remembered tappable tiles of one shape and forgets dead ones', () => {
  const ai = new AIPlayer(AI_LEVELS.pro, seq([1]));
  const t1 = tile('star');
  const t2 = tile('star');
  const t3 = tile('star', { selected: true }); // remembered but currently picked
  const dead = tile('circle', { active: false });
  [t1, t2, t3, dead].forEach((t) => ai.see(t, true));
  assert.deepEqual(ai.known('star'), [t1, t2]);
  assert.equal(ai.memory.has(dead), false, 'dead tiles are pruned from memory');
  assert.deepEqual(ai.known('circle'), []);
});

test('groups() never offers dummies, hazards, cancels or untappable tiles', () => {
  const ai = new AIPlayer(AI_LEVELS.pro, seq([1]));
  const stars = [tile('star'), tile('star'), tile('star')];
  const dummies = [tile('dummy'), tile('dummy')];
  const hazard = tile('hazard');
  const cancel = tile('cancel');
  const shown = tile('square', { faceUp: true });
  [...stars, ...dummies, hazard, cancel, shown].forEach((t) => ai.see(t, true));
  const groups = ai.groups();
  assert.equal(groups.length, 1, 'only the star group is offered');
  assert.deepEqual(groups[0], stars);
});

test('chooseGroup reaches for a full match; Professional always takes the biggest', () => {
  const ai = new AIPlayer(AI_LEVELS.pro, seq([0.99])); // 0.99 < bestGroupChance 1 -> biggest group
  const three = [tile('circle'), tile('circle'), tile('circle')];
  const four = [tile('square'), tile('square'), tile('square'), tile('square')];
  [...three, ...four].forEach((t) => ai.see(t, true));
  assert.deepEqual(ai.chooseGroup(), four); // same tiles; groups() builds fresh arrays
  // With nothing at MIN_MATCH remembered, there is nothing to choose.
  const fresh = new AIPlayer(AI_LEVELS.pro, seq([1]));
  const pair = [tile('circle'), tile('circle')];
  pair.forEach((t) => fresh.see(t, true));
  assert.equal(fresh.chooseGroup(), null);
  assert.ok(pair.length < MIN_MATCH);
});

test('guess() avoids remembered specials and tiles remembered as another shape', () => {
  const realRandom = Math.random;
  try {
    Math.random = () => 0; // randomItem picks the first pool candidate: deterministic
    const ai = new AIPlayer(AI_LEVELS.pro, seq([1]));
    const unrememberedCircle = tile('circle');
    const rememberedDummy = tile('dummy');
    const rememberedStar = tile('star');
    ai.see(rememberedDummy, true);
    ai.see(rememberedStar, true);
    const board = [[unrememberedCircle, rememberedDummy, rememberedStar]];
    // Reaching for stars: the star it remembers is the best start; the remembered
    // dummy is never a candidate. An unremembered tile may also be guessed at.
    const forStars = ai.guess('star', board);
    assert.ok(forStars === rememberedStar || forStars === unrememberedCircle);
    assert.notEqual(forStars, rememberedDummy);
    // Reaching for circles: the tile remembered as a star is excluded, the remembered dummy too.
    const forCircles = ai.guess('circle', board);
    assert.equal(forCircles, unrememberedCircle);
    // Open-ended guess never returns the remembered dummy either.
    for (let i = 0; i < 20; i++) {
      Math.random = () => i / 20;
      assert.notEqual(ai.guess(null, board), rememberedDummy);
    }
  } finally {
    Math.random = realRandom;
  }
});

test('guess() with preferUnknown starts on tiles it can still learn from', () => {
  const realRandom = Math.random;
  try {
    Math.random = () => 0; // randomItem picks the first candidate
    const ai = new AIPlayer(AI_LEVELS.pro, seq([1])); // preferUnknown: true
    const known = tile('circle');
    ai.see(known, true);
    const board = [[known, tile('square')]];
    assert.equal(ai.guess(null, board), board[0][1], 'the unknown tile is preferred');
    const easy = new AIPlayer(AI_LEVELS.easy, seq([1])); // preferUnknown: false
    assert.equal(easy.guess(null, board), known, 'Easy just takes the first plausible tile');
  } finally {
    Math.random = realRandom;
  }
});

test('guess() returns null when nothing is plausible', () => {
  const ai = new AIPlayer(AI_LEVELS.pro, seq([1]));
  assert.equal(ai.guess(null, []), null);
  const dead = [[tile('circle', { faceUp: true })]];
  assert.equal(ai.guess(null, dead), null);
});
