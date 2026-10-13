'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../src/rules.js');

test('scoreFor applies the documented match rewards', () => {
  assert.equal(rules.scoreFor(0), 0);
  assert.equal(rules.scoreFor(2), 0);
  assert.equal(rules.scoreFor(3), 1);
  assert.equal(rules.scoreFor(4), 2);
  assert.equal(rules.scoreFor(5), 5);
  assert.equal(rules.scoreFor(9), 5);
});

test('only selections at or above the minimum are submittable matches', () => {
  assert.equal(rules.isValidMatchSize(2, 3), false);
  assert.equal(rules.isValidMatchSize(3, 3), true);
  assert.equal(rules.isValidMatchSize(4, 3), true);
  assert.equal(rules.isValidMatchSize(NaN, 3), false);
});

test('first pick accepts any shape, later picks must match', () => {
  assert.equal(rules.selectionMatches(0, null, 'circle'), true);
  assert.equal(rules.selectionMatches(1, 'circle', 'circle'), true);
  assert.equal(rules.selectionMatches(1, 'circle', 'square'), false);
});

test('hazards always blast in Play Alone and only hit harmlessly when picked first in multiplayer', () => {
  assert.equal(rules.hazardAction(false, 0), 'blast');
  assert.equal(rules.hazardAction(false, 2), 'blast');
  assert.equal(rules.hazardAction(true, 0), 'hit');
  assert.equal(rules.hazardAction(true, 1), 'blast');
});

test('penalty arithmetic respects the configured score floor', () => {
  assert.equal(rules.penaltyToApply(5, 2, 0), 2);
  assert.equal(rules.penaltyToApply(1, 2, 0), 1);
  assert.equal(rules.penaltyToApply(0, 1, -Infinity), 1);
  assert.equal(rules.penaltyToApply(-2, 1, -Infinity), 1);
  assert.equal(rules.penaltyToApply(5, 0, 0), 0);
});

test('Play Alone attempt resolution continues until its checkpoint window is complete', () => {
  const result = rules.resolveAloneAttempt({
    attemptsInWindow: 2, windowPoints: 4, gained: 1, score: 5, scoreFloor: -15,
    attemptWindow: 15, pointsRequired: 15,
  });
  assert.deepEqual(result, { attemptsInWindow: 3, windowPoints: 5, status: 'continue' });
});

test('Play Alone attempt resolution distinguishes failed and cleared checkpoint windows', () => {
  const base = {
    attemptsInWindow: 14, score: 5, scoreFloor: -15, attemptWindow: 15, pointsRequired: 15,
  };
  assert.deepEqual(
    rules.resolveAloneAttempt({ ...base, windowPoints: 13, gained: 1 }),
    { attemptsInWindow: 15, windowPoints: 14, status: 'failed-window' },
  );
  assert.deepEqual(
    rules.resolveAloneAttempt({ ...base, windowPoints: 14, gained: 1 }),
    { attemptsInWindow: 15, windowPoints: 15, status: 'checkpoint', checkpointPoints: 15 },
  );
});

test('score-floor loss takes priority over checkpoint evaluation', () => {
  assert.equal(rules.resolveAloneAttempt({
    attemptsInWindow: 14, windowPoints: 100, gained: 1, score: -15, scoreFloor: -15,
    attemptWindow: 15, pointsRequired: 15,
  }).status, 'score-floor');
});

test('hazard URL overrides reject invalid input and clamp finite values to 0–1', () => {
  assert.equal(rules.parseProbabilityOverride(null, false), null);
  assert.equal(rules.parseProbabilityOverride(''), null);
  assert.equal(rules.parseProbabilityOverride('   '), null);
  assert.equal(rules.parseProbabilityOverride('abc'), null);
  assert.equal(rules.parseProbabilityOverride('NaN'), null);
  assert.equal(rules.parseProbabilityOverride('Infinity'), null);
  assert.equal(rules.parseProbabilityOverride('0.1'), 0.1);
  assert.equal(rules.parseProbabilityOverride('-2'), 0);
  assert.equal(rules.parseProbabilityOverride('1.5'), 1);
});
