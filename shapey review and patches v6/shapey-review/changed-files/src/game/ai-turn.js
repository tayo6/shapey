// Shapey - the visible AI turn loop (pauses, taps, attempts). Memory and decisions
// live in src/ai.js; this mixin owns only the timing inside GameScene.
// Extracted from GameScene (scenes/game.js) as a prototype mixin.

import { MIN_MATCH, AI_SPARE_MS } from '../constants.js';
import { RULES } from '../config.js';
import { randomItem } from '../utils.js';

export const AITurnMixin = {
  // ------------------------------------------------------------------ AI (Easy / Professional)
  // The AI only knows what it has seen: the opening board, new tiles while they are face-up, and every
  // tile that gets flipped. What it keeps and what it reaches for live in src/ai.js (AIPlayer, tested in
  // tests/ai.test.mjs); this scene only owns the turn loop below (runAITurn / aiTap / aiAttempt) and
  // records what the AI gets to see through this thin adapter.
  aiSee(tile, certain = false) {
    if (!this.modeCfg.ai || !tile.active) return;
    this.aiPlayer.see(tile, certain);
  },

  async aiIdle(alive) {
    while (this.busy && alive()) await this.sleep(100);
  },

  // One visible tap after a human-like pause.
  async aiTap(tile, alive) {
    await this.sleep(this.ai.tapMs[0] + Math.random() * (this.ai.tapMs[1] - this.ai.tapMs[0]));
    await this.aiIdle(alive);
    if (!alive()) return false;
    this.onTileTap(tile, true);
    await this.sleep(250);
    await this.aiIdle(alive); // a wrong tap resets the attempt before the AI carries on
    return alive();
  },

  // One match attempt. Returns true when it submitted a match (submit() then ends the turn).
  async aiAttempt(alive) {
    const alreadyPicking = this.selection.length > 0;
    let group = alreadyPicking ? this.aiPlayer.known(this.selectedShape) : this.aiPlayer.chooseGroup();
    if (!alreadyPicking && !group && this.ai.followHunch) {
      // No full match remembered: start from the shape it remembers most copies of (two or more), so it
      // has fewer new tiles left to find.
      const partial = this.aiPlayer.groups().sort((a, b) => b.length - a.length)[0];
      if (partial && partial.length >= 2) group = partial;
    }
    const first = alreadyPicking
      ? (group.length ? randomItem(group) : (this.aiPlayer.guess(this.selectedShape, this.tiles) || this.aiPlayer.guess(null, this.tiles)))
      : (group ? group[0] : this.aiPlayer.guess(null, this.tiles));
    if (!first || !(await this.aiTap(first, alive))) return false;

    // How many tiles it reaches for: 5 (the 5+ score) for Professional, 3 or sometimes 4 for Easy.
    const goal = this.ai.goBig ? 5 : (Math.random() < 0.3 ? 4 : MIN_MATCH);
    while (alive() && (this.selection.length > 0 || this.dummySelection.length > 0)) {
      const have = this.selection.length;
      const known = have ? this.aiPlayer.known(this.selectedShape) : [];
      // Once it has a match it only keeps going while it remembers more tiles of that shape and has time to spare.
      if (have >= MIN_MATCH && (have >= goal || !known.length || this.turnClock.remaining() < AI_SPARE_MS)) break;
      // Dummies do not count: if a shape is already selected, keep seeking that shape. If none is known,
      // make a plausible guess (and a genuine mismatch ends the AI's turn like any other player's).
      const next = have === 0 ? this.aiPlayer.guess(null, this.tiles)
        : (known.length ? randomItem(known) : (this.aiPlayer.guess(this.selectedShape, this.tiles) || this.aiPlayer.guess(null, this.tiles)));
      if (!next || !(await this.aiTap(next, alive))) break;
    }
    if (!alive()) return false;
    if (RULES.isValidMatchSize(this.selection.length, MIN_MATCH)) {
      await this.sleep(this.ai.submitMs);
      await this.submit(true);
      return true;
    }
    return false;
  },

  async runAITurn(turnId) {
    const alive = () => turnId === this.turnId && !this.turnEnding &&
      !this.timeoutHandling && !this.gameOver && !this.turnClock.expired();
    await this.sleep(this.ai.thinkMs);
    // Keep participating until a match, mismatch, Hazard explosion, or clock expiry.
    // Cancel-first and Dummy-only picks never award points.
    while (alive()) {
      await this.aiIdle(alive);
      if (!alive()) return;
      if (await this.aiAttempt(alive)) return;
      if (!alive()) return;
      await this.sleep(this.ai.gapMs);
    }
    // The frame update resolves an expired clock, including any valid selection eligible for auto-submit.
  },

};
