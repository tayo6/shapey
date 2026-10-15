const test = require('node:test');
const assert = require('node:assert/strict');
const RULES = require('../src/rules.js');

test('versus sides alternate Player vs AI and Player 1 vs Player 2', () => {
  for (const mode of ['ai', 'pvp']) {
    let active = 0;
    const seen = [];
    for (let i = 0; i < 8; i++) {
      seen.push(active);
      active = RULES.nextVersusPlayer(active);
    }
    assert.deepEqual(seen, [0, 1, 0, 1, 0, 1, 0, 1], mode);
  }
});

test('Tag side and partner sequence is Player 1, Player 3, Player 2, Player 4', () => {
  let side = 0;
  const seen = [];
  for (let turn = 0; turn < 8; turn++) {
    seen.push({ side, member: RULES.tagMemberForTurn(turn) });
    side = RULES.nextVersusPlayer(side);
  }
  assert.deepEqual(seen, [
    { side: 0, member: 0 },
    { side: 1, member: 0 },
    { side: 0, member: 1 },
    { side: 1, member: 1 },
    { side: 0, member: 0 },
    { side: 1, member: 0 },
    { side: 0, member: 1 },
    { side: 1, member: 1 },
  ]);
});

test('Double Play is granted only to its owner on a normal turn and cannot chain', () => {
  assert.equal(RULES.shouldGrantDoublePlay(false, 0, 0), true);
  assert.equal(RULES.shouldGrantDoublePlay(false, 1, 0), false);
  assert.equal(RULES.shouldGrantDoublePlay(true, 0, 0), false);
  assert.equal(RULES.shouldGrantDoublePlay(true, 1, 1), false);
  assert.equal(RULES.shouldGrantDoublePlay(false, null, 0), false);
});

test('invalid side numbers cannot be handed to the next turn', () => {
  assert.equal(RULES.nextVersusPlayer(0), 1);
  assert.equal(RULES.nextVersusPlayer(1), 0);
  assert.equal(RULES.nextVersusPlayer(-1), null);
  assert.equal(RULES.nextVersusPlayer(2), null);
});

test('versus target scores remain fixed', () => {
  assert.equal(RULES.targetScoreForMode('ai'), 100);
  assert.equal(RULES.targetScoreForMode('pvp'), 100);
  assert.equal(RULES.targetScoreForMode('tag'), 200);
  assert.equal(RULES.targetScoreForMode('alone'), 100);
});
