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

test('only Play Alone loses a point to a Hazard; Dummy tiles never cost points of their own', () => {
  assert.equal(rules.hazardPenalty(false), 0);
  assert.equal(rules.hazardPenalty(false, 1), 0);
  assert.equal(rules.hazardPenalty(true), 1);
  assert.equal(rules.hazardPenalty(true, 2), 2);
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

test('versus handoff alternates between Player 1 and Player 2', () => {
  assert.equal(rules.nextVersusPlayer(0), 1);
  assert.equal(rules.nextVersusPlayer(1), 0);
  assert.equal(rules.nextVersusPlayer(null), null);
  assert.equal(rules.nextVersusPlayer(2), null);
});

test('Tag partner rotation is Player 1, Player 3, Player 2, Player 4, then repeats', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(rules.tagMemberForTurn),
    [0, 0, 1, 1, 0, 0, 1, 1]);
});

test('Double Play grants exactly one bonus turn and cannot chain', () => {
  assert.equal(rules.shouldGrantDoublePlay(false, 0, 0), true);
  assert.equal(rules.shouldGrantDoublePlay(false, 1, 0), false);
  assert.equal(rules.shouldGrantDoublePlay(false, 1, 1), true);
  assert.equal(rules.shouldGrantDoublePlay(true, 0, 0), false);
  assert.equal(rules.shouldGrantDoublePlay(false, null, 0), false);
});

test('turn durations follow AI difficulty and Tag has a 30-second pick timer', () => {
  assert.equal(rules.turnDurationForMode('ai', 'easy'), 45000);
  assert.equal(rules.turnDurationForMode('ai', 'pro'), 30000);
  assert.equal(rules.turnDurationForMode('pvp', 'pro'), 45000);
  assert.equal(rules.turnDurationForMode('tag', 'easy'), 30000);
  assert.equal(rules.turnDurationForMode('tag', 'pro'), 30000);
  // Explicit test/development overrides are honored for every timed mode.
  assert.equal(rules.turnDurationForMode('ai', 'pro', 10000, 10000), 10000);
  assert.equal(rules.turnDurationForMode('tag', 'easy', 10000, 10000, 10000), 10000);
});

test('a new profile gets exactly one starter Star but saved balances are preserved', () => {
  assert.equal(rules.initialStarBalance(null), 1);
  assert.equal(rules.initialStarBalance(''), 1);
  assert.equal(rules.initialStarBalance('not-a-number'), 1);
  assert.equal(rules.initialStarBalance('0'), 0);
  assert.equal(rules.initialStarBalance('4'), 4);
});

test('score targets are fixed by mode', () => {
  assert.equal(rules.targetScoreForMode('alone'), 50);
  assert.equal(rules.targetScoreForMode('ai'), 50);
  assert.equal(rules.targetScoreForMode('pvp'), 50);
  assert.equal(rules.targetScoreForMode('tag'), 100);
  assert.equal(rules.targetScoreForMode('unknown'), null);
});

test('mode navigation only exposes the actions allowed by each mode', () => {
  assert.deepEqual(rules.navigationForMode('alone'), ['settings', 'submit']);
  assert.deepEqual(rules.navigationForMode('ai'), ['settings', 'submit', 'inventory']);
  assert.deepEqual(rules.navigationForMode('pvp'), ['settings', 'submit', 'polls', 'inventory']);
  assert.deepEqual(rules.navigationForMode('tag'), ['settings', 'submit', 'polls', 'inventory']);
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


test('match streaks reward +1, +2, and +3 Stars at streak lengths 3, 4, and 5 for consecutive successful turns', () => {
  assert.deepEqual(rules.nextMatchStreak(0, 0, true), {
    streak: 1, lastRewardedStreak: 0, reward: 0,
  });
  assert.deepEqual(rules.nextMatchStreak(1, 0, true), {
    streak: 2, lastRewardedStreak: 0, reward: 0,
  });
  assert.deepEqual(rules.nextMatchStreak(2, 0, true), {
    streak: 3, lastRewardedStreak: 3, reward: 1,
  });
  assert.deepEqual(rules.nextMatchStreak(3, 3, true), {
    streak: 4, lastRewardedStreak: 4, reward: 2,
  });
  assert.deepEqual(rules.nextMatchStreak(4, 4, true), {
    streak: 5, lastRewardedStreak: 5, reward: 3,
  });
});

test('a failed turn resets a match streak so a later three-match streak can earn Stars again', () => {
  assert.deepEqual(rules.nextMatchStreak(4, 4, false), {
    streak: 0, lastRewardedStreak: 0, reward: 0,
  });
  assert.deepEqual(rules.nextMatchStreak(0, 0, true), {
    streak: 1, lastRewardedStreak: 0, reward: 0,
  });
  assert.deepEqual(rules.nextMatchStreak(1, 0, true), {
    streak: 2, lastRewardedStreak: 0, reward: 0,
  });
  assert.deepEqual(rules.nextMatchStreak(2, 0, true), {
    streak: 3, lastRewardedStreak: 3, reward: 1,
  });
});
