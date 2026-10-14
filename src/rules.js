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

  // In Play Alone every hazard blasts; in multiplayer, a first-pick hazard is harmless.
  function hazardAction(twoPlayerMode, selectedCount) {
    return !twoPlayerMode || selectedCount > 0 ? 'blast' : 'hit';
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

  // Only Professional AI uses the shorter 30-second turn; all other versus turns use 45 seconds.
  function turnDurationForMode(mode, difficulty, standardMs = 45000, professionalMs = 30000) {
    return mode === 'ai' && difficulty === 'pro' ? professionalMs : standardMs;
  }

  // Side turns always alternate. Tag partner identity is derived from normal-turn number;
  // Double Play intentionally does not increment that number.
  function nextVersusPlayer(activePlayer) {
    if (activePlayer !== 0 && activePlayer !== 1) return null;
    return 1 - activePlayer;
  }

  function tagMemberForTurn(turnNumber) {
    if (!Number.isInteger(turnNumber) || turnNumber < 0) return 0;
    return Math.floor(turnNumber / 2) % 2;
  }

  function shouldGrantDoublePlay(isBonusTurn, pendingPlayer, activePlayer) {
    return isBonusTurn !== true && pendingPlayer === activePlayer;
  }

  // Fixed versus targets: AI/PvP race to 100; Tag teams race to 200.
  function targetScoreForMode(mode) {
    if (mode === 'tag') return 200;
    if (mode === 'ai' || mode === 'pvp') return 100;
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
    hazardAction,
    penaltyToApply,
    targetScoreForMode,
    turnDurationForMode,
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
