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

test('Play Alone loses only when the score reaches its floor', () => {
  assert.equal(rules.hasReachedScoreFloor(0, -15), false);
  assert.equal(rules.hasReachedScoreFloor(-14, -15), false);
  assert.equal(rules.hasReachedScoreFloor(-15, -15), true);
  assert.equal(rules.hasReachedScoreFloor(-16, -15), true);
});

test('turn durations follow the versus mode and AI difficulty', () => {
  assert.equal(rules.turnDurationForMode('ai', 'easy'), 45000);
  assert.equal(rules.turnDurationForMode('ai', 'pro'), 30000);
  assert.equal(rules.turnDurationForMode('pvp', 'pro'), 45000);
  assert.equal(rules.turnDurationForMode('tag', 'pro'), 45000);
  // Explicit test/development overrides are honored for both AI levels.
  assert.equal(rules.turnDurationForMode('ai', 'pro', 10000, 10000), 10000);
});

test('versus mode targets are fixed by mode', () => {
  assert.equal(rules.targetScoreForMode('alone'), null);
  assert.equal(rules.targetScoreForMode('ai'), 100);
  assert.equal(rules.targetScoreForMode('pvp'), 100);
  assert.equal(rules.targetScoreForMode('tag'), 200);
  assert.equal(rules.targetScoreForMode('unknown'), null);
});

test('a side wins as soon as its score reaches or exceeds its target', () => {
  assert.equal(rules.hasReachedTarget(99, 100), false);
  assert.equal(rules.hasReachedTarget(100, 100), true);
  assert.equal(rules.hasReachedTarget(101, 100), true);
  assert.equal(rules.hasReachedTarget(199, 200), false);
  assert.equal(rules.hasReachedTarget(200, 200), true);
  assert.equal(rules.hasReachedTarget(205, 200), true);
  assert.equal(rules.hasReachedTarget(-1, 100), false);
  assert.equal(rules.hasReachedTarget(100, null), false);
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
