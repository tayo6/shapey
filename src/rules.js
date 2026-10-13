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

  // Resolve a Play Alone attempt/checkpoint without mutating scene state.
  function resolveAloneAttempt({
    attemptsInWindow, windowPoints, gained, score, scoreFloor, attemptWindow, pointsRequired,
  }) {
    const nextAttempts = attemptsInWindow + 1;
    const nextPoints = windowPoints + gained;
    const result = { attemptsInWindow: nextAttempts, windowPoints: nextPoints, status: 'continue' };

    if (score <= scoreFloor) return { ...result, status: 'score-floor' };
    if (nextAttempts < attemptWindow) return result;
    if (nextPoints < pointsRequired) return { ...result, status: 'failed-window' };
    return { ...result, status: 'checkpoint', checkpointPoints: nextPoints };
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
    resolveAloneAttempt,
    parseProbabilityOverride,
  });
});
