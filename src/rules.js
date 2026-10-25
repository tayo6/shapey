(function attachShapeyRules(root, factory) {
  const rules = factory();
  if (typeof module === 'object' && module.exports) module.exports = rules;
  if (root) root.ShapeyRules = rules;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createShapeyRules() {
  'use strict';

  // Pure game rules: no Phaser objects, clocks, DOM access, or animation side effects.
  const scoreFor = (count) => (count >= 5 ? 5 : count === 4 ? 2 : count === 3 ? 1 : 0);

  function isValidMatchSize(count, minimum = 3) {
    return Number.isFinite(count) && count >= minimum;
  }

  function selectionMatches(selectionLength, selectedShape, pickedShape) {
    return selectionLength === 0 || pickedShape === selectedShape;
  }

  // A Hazard is a bomb in every mode: it always destroys itself (and everything picked with
  // it), and picking one first still ends the turn. Only Play Alone loses a point for it;
  // versus modes never subtract score, and Dummy tiles never incur a penalty of their own.
  function hazardPenalty(isPlayAlone, penalty = 1) {
    return isPlayAlone ? penalty : 0;
  }

  function penaltyToApply(score, requestedPoints, floor = -Infinity) {
    if (!Number.isFinite(score) || !Number.isFinite(requestedPoints) || requestedPoints <= 0) return 0;
    return Math.max(0, score - Math.max(floor, score - requestedPoints));
  }

  // A genuinely new local profile starts with 1 Star. Stored zero remains zero.
  function initialStarBalance(raw) {
    if (raw == null || String(raw).trim() === '') return 1;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : 1;
  }

  // Advance or reset the consecutive successful-turn streak. The 3rd, 4th, 5th, etc.
  // successful matching turns award 1, 2, 3, ... bonus Stars, once per streak length.
  function nextMatchStreak(streak, lastRewardedStreak, matched) {
    if (!matched) return { streak: 0, lastRewardedStreak: 0, reward: 0 };
    const current = Number.isInteger(streak) && streak > 0 ? streak : 0;
    const rewarded = Number.isInteger(lastRewardedStreak) && lastRewardedStreak >= 0
      ? lastRewardedStreak : 0;
    const next = current + 1;
    const reward = next >= 3 && next > rewarded ? next - 2 : 0;
    return {
      streak: next,
      lastRewardedStreak: reward > 0 ? next : rewarded,
      reward,
    };
  }

  // Polls require real audience participation, so only online PvP and Tag show the Polls control.
  // Play Alone has neither polls nor inventory; Player vs AI has inventory but no Polls control.
  function navigationForMode(mode) {
    if (mode === 'alone') return ['settings', 'submit'];
    if (mode === 'ai') return ['settings', 'submit', 'inventory'];
    if (mode === 'pvp' || mode === 'tag') return ['settings', 'submit', 'polls', 'inventory'];
    return ['settings', 'submit', 'inventory'];
  }

  // Ordinary versus turns alternate between the two sides. Return null for an invalid owner
  // so endTurn() can stop safely instead of starting a turn for an undefined player.
  function nextVersusPlayer(activePlayer) {
    if (activePlayer === 0) return 1;
    if (activePlayer === 1) return 0;
    return null;
  }

  // Tag rotates partners every other turn: P1, P3, P2, P4, then repeat.
  // turnNumber is zero-based and only advances for normal turns, not Double Play turns.
  function tagMemberForTurn(turnNumber) {
    if (!Number.isInteger(turnNumber) || turnNumber < 0) return 0;
    return Math.floor(turnNumber / 2) % 2;
  }

  // Double Play grants exactly one repeated turn, never a chain of bonus turns.
  function shouldGrantDoublePlay(isBonusTurn, doublePlayPendingPlayer, activePlayer) {
    return !isBonusTurn && Number.isInteger(activePlayer) && doublePlayPendingPlayer === activePlayer;
  }

  // Tag uses 30 seconds per pick; Professional AI uses 30 seconds, other versus turns use 45.
  function turnDurationForMode(mode, difficulty, standardMs = 45000, professionalMs = 30000, tagMs = 30000) {
    if (mode === 'tag') return tagMs;
    return mode === 'ai' && difficulty === 'pro' ? professionalMs : standardMs;
  }

  // Play Alone and AI/PvP target 50; Tag teams target 100.
  function targetScoreForMode(mode) {
    if (mode === 'tag') return 100;
    if (mode === 'alone' || mode === 'ai' || mode === 'pvp') return 50;
    return null;
  }

  function hasReachedTarget(score, target) {
    return Number.isFinite(score) && Number.isFinite(target) && target > 0 && score >= target;
  }

  function hasReachedScoreFloor(score, floor) {
    return Number.isFinite(score) && Number.isFinite(floor) && score <= floor;
  }

  // A missing/invalid override falls back to the mode default; valid numbers are bounded to probabilities.
  function parseProbabilityOverride(raw, isPresent = true) {
    if (!isPresent || raw == null || String(raw).trim() === '') return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.min(1, value));
  }

  return Object.freeze({
    scoreFor,
    isValidMatchSize,
    selectionMatches,
    hazardPenalty,
    penaltyToApply,
    targetScoreForMode,
    turnDurationForMode,
    navigationForMode,
    nextVersusPlayer,
    tagMemberForTurn,
    shouldGrantDoublePlay,
    initialStarBalance,
    nextMatchStreak,
    hasReachedTarget,
    hasReachedScoreFloor,
    parseProbabilityOverride,
  });
});
