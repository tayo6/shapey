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

  // Only Professional AI uses the shorter 30-second turn; all other versus turns use 45 seconds.
  function turnDurationForMode(mode, difficulty, standardMs = 45000, professionalMs = 30000) {
    return mode === 'ai' && difficulty === 'pro' ? professionalMs : standardMs;
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
    hasReachedTarget,
    hasReachedScoreFloor,
    parseProbabilityOverride,
  });
});
