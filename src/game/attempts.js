// Shapey - tile picking, attempt resolution (match / mismatch / hazard), submit and
// scoring. Extracted from GameScene (scenes/game.js) as a prototype mixin.

import { GAME_WIDTH, MIN_MATCH, ALONE_MISS_PENALTY, ALONE_SCORE_FLOOR, HAZARD_BLAST_PENALTY, TWO_PLAYER_SCORE_FLOOR, MATCH_SHAPE_KEYS, BASE_TILE_SIZE } from '../constants.js';
import { RULES, TILE_SIZE } from '../config.js';

export const AttemptFlowMixin = {
  // -------------------------------------------------------------- picking
  addRing(tile) {
    tile.ring = this.add.graphics({ x: tile.x, y: tile.y }).setDepth(12);
    const scale = TILE_SIZE / BASE_TILE_SIZE;
    const ringSize = TILE_SIZE - 4 * scale;
    tile.ring.lineStyle(5 * scale, 0xffe066, 1);
    tile.ring.strokeRoundedRect(-ringSize / 2, -ringSize / 2, ringSize, ringSize, 14 * scale);
  },

  removeRing(tile) {
    if (tile.ring) { tile.ring.destroy(); tile.ring = null; }
  },

  onTileTap(tile, fromAI = false) {
    if (this.online) {
      if (!tile || !tile.active || !tile.serverId || this.gameOver ||
          tile.faceUp || tile.selected || tile.moving || tile.swapping) return;
      if (this.sendOnlineAction({ type: 'pick', tileId: tile.serverId }) && this.memes) this.memes.noteActivity();
      return;
    }
    // Taps are ignored during hand-over, once the turn clock has run out, after game over and while a
    // menu is open. Tiles in the middle of a swap can't be tapped, and a human can't tap during the AI's turn.
    if (this.busy || this.turnEnding || this.gameOver || this.turnClock.expired() || !tile.active || tile.selected || tile.swapping || tile.faceUp) return; // a face-up tile can't be picked: a shape is only revealed by the player's own flip
    if (!fromAI && (this.panelOpen || this.isAITurn())) return;

    if (!fromAI && this.memes) this.memes.noteActivity(); // the human is taking part in this turn
    this.aiSee(tile, fromAI); // the AI sees every tile that gets flipped over (certainly its own, only partly the human's)

    // A Hazard is a bomb in every mode: it always destroys itself and everything already
    // picked (Dummy tiles included), and picking one first still ends the turn - the same
    // player never gets another chance. Only Play Alone loses a point (rules.hazardPenalty);
    // versus modes never do.
    if (tile.shape === 'hazard') {
      this.hazardBlast(tile, { fromAI });
      return;
    }

    // Dummy stays face-up until this attempt resolves. It is tracked separately so it cannot
    // set the match shape, count toward a match, trigger a mismatch, or affect the score.
    if (tile.shape === 'dummy') {
      tile.selected = true; // keeps the picked Dummy from shuffling or being auto-hidden
      this.dummySelection.push(tile);
      this.addRing(tile);
      this.flipTile(tile, true);
      return;
    }

    // Cancel picked first cancels the current selection (including any Dummies), flips back down,
    // and never scores or subtracts points. It does not consume the turn.
    if (tile.shape === 'cancel' && this.selection.length === 0) {
      this.busy = true;
      tile.selected = true;
      this.selection.push(tile);
      this.selectedShape = tile.shape;
      this.addRing(tile);
      this.flipTile(tile, true).then(async () => {
        await this.sleep(350);
        await this.resetSelection();
        this.busy = false;
      });
      return;
    }

    const isFirst = this.selection.length === 0;
    const matches = RULES.selectionMatches(this.selection.length, this.selectedShape, tile.shape);

    tile.selected = true;
    this.selection.push(tile);
    this.addRing(tile);
    if (isFirst) this.selectedShape = tile.shape;

    if (matches) {
      this.flipTile(tile, true); // a valid match is only submitted with the Submit button
    } else {
      this.failAttempt(tile);
    }
  },

  // A different shape was picked: show it briefly, then flip everything back. No points (play alone: -1).
  async failAttempt(wrongTile) {
    this.busy = true;
    await this.flipTile(wrongTile, true);
    await this.sleep(500);
    await this.resetSelection();
    this.penalizeMiss();
    this.busy = false;
    this.recordAttempt(0);
    if (!this.modeCfg.twoPlayers) {
      this.breakLocalMatchStreak();
      if (this.memes && !this.gameOver) this.memes.attemptResult('lose'); // Play Alone has no turn hand-over to report this
    }
    // In versus modes a wrong pair ends the turn immediately. Play Alone remains continuous.
    if (this.modeCfg.twoPlayers && !this.gameOver) this.endTurn('mismatch');
  },

  // Hazards always detonate, destroying the bomb and all shapes/Dummies currently picked.
  // Play Alone loses one point per explosion (rules.hazardPenalty); versus modes receive no
  // Hazard penalty, and Dummy tiles never incur a penalty of their own.
  async hazardBlast(hazard, options = {}) {
    const suppressHazardCommentary = Boolean(options.fromAI && this.mode === 'ai');
    this.busy = true;
    this.cancelShuffles();
    const tiles = [...this.selection, ...this.dummySelection, hazard];
    this.selection = [];
    this.dummySelection = [];
    this.selectedShape = null;
    hazard.selected = true;
    await this.flipTile(hazard, true);
    const lost = this.applyPenalty(RULES.hazardPenalty(!this.modeCfg.twoPlayers, HAZARD_BLAST_PENALTY));
    if (!suppressHazardCommentary) {
      this.showToast('Hazard! It destroys everything you picked.\n' +
        (lost > 0 ? '−' + lost + ' point, no reward.' : 'No reward.'));
    }
    this.tweens.add({ targets: hazard, angle: { from: -8, to: 8 }, duration: 70, yoyo: true, repeat: 3,
      onComplete: () => { if (hazard.active) hazard.setAngle(0); } });
    await this.sleep(900);
    await Promise.all(tiles.map((tile) => tile.flipChain));
    await this.destroyTiles(tiles);
    await this.cascade();
    this.busy = false;
    if (!this.modeCfg.twoPlayers && RULES.hasReachedScoreFloor(this.scores[0], ALONE_SCORE_FLOOR)) {
      this.endGame('Your score reached ' + ALONE_SCORE_FLOOR + '.');
      return;
    }
    this.endTurn('hazard', { suppressHazardCommentary });
  },

  // Legacy internal alias retained for any existing callback: a standalone Hazard also detonates.
  async hazardHit(tile) {
    return this.hazardBlast(tile);
  },

  // Play alone: a wrong shape costs a point (a too-small submit is free). (Two-player modes keep failed attempts free.)
  penalizeMiss() {
    if (!this.modeCfg.twoPlayers) this.applyPenalty(ALONE_MISS_PENALTY);
  },

  // Flip actual picked shapes and neutral Dummies back down when an attempt is cancelled or fails.
  async resetSelection() {
    const tiles = [...this.selection, ...this.dummySelection];
    this.selection = [];
    this.dummySelection = [];
    this.selectedShape = null;
    await Promise.all(
      tiles.map(async (tile, i) => {
        await this.flipTile(tile, false, i * 140);
        tile.selected = false;
        this.removeRing(tile);
      })
    );
  },

  // A successful match destroys only the matched shapes; picked Dummies simply flip back down.
  async resetDummies() {
    const tiles = this.dummySelection;
    this.dummySelection = [];
    await Promise.all(
      tiles.map(async (tile, i) => {
        await this.flipTile(tile, false, i * 140);
        tile.selected = false;
        this.removeRing(tile);
      })
    );
  },

  // -------------------------------------------------------------- submit
  async submit(fromAI = false, forced = false, queued = false) {
    if (this.online) {
      const state = this.onlineState;
      if (!forced && !fromAI && state && state.status === 'playing' &&
          state.activePlayerNumber === this.onlinePlayerNumber && state.pendingEffect) {
        const alreadyQueued = Boolean(this.pendingOnlineSubmitKey);
        this.queueOnlineSubmit(state);
        if (!alreadyQueued) this.showToast('Submit queued until the current move finishes.', 1800);
        return;
      }
      const sent = this.sendOnlineAction({ type: 'submit' });
      if (sent) {
        this.pendingOnlineSubmitKey = null;
        // Freeze the submitting player's display until the authoritative next-turn state arrives.
        this.onlineSubmitPending = true;
        this.turnClock.stop();
      }
      return;
    }
    // If Submit is tapped during a flip, hazard or other board animation, remember the request
    // instead of silently ignoring it. The same turn will be submitted when it becomes idle.
    if (this.turnEnding || this.gameOver || (this.turnClock.expired() && !forced && !queued)) return;
    if (this.busy) {
      if (!forced && !fromAI && !queued && this.modeCfg.twoPlayers && !this.isAITurn()) {
        this.pendingSubmitTurnId = this.turnId;
        if (this.modeCfg.turnClock) this.turnClock.stop();
        this.showToast('Submit queued until the current move finishes.', 1800);
      }
      return;
    }
    if (!forced && !fromAI && !queued && (this.panelOpen || this.isAITurn())) return;

    // The outgoing player's clock must not consume time spent resolving a submitted move.
    // startTurn() starts a fresh deadline for the next player after board resolution.
    if (this.modeCfg.turnClock) this.turnClock.stop();

    // Even a Dummy-only or empty manual submit ends a versus turn; it never changes the score.
    if (this.selection.length === 0) {
      if (this.dummySelection.length > 0) {
        this.busy = true;
        await this.resetDummies();
        this.busy = false;
      }
      if (this.modeCfg.twoPlayers) this.endTurn(forced ? 'timeout' : 'submit');
      return;
    }

    this.busy = true;
    const tiles = this.selection;
    if (!RULES.isValidMatchSize(tiles.length, MIN_MATCH)) {
      // not enough for a match: flip back, no score (the -1 is only for a wrong shape)
      await this.resetSelection();
      this.busy = false;
      if (this.modeCfg.twoPlayers) {
        this.endTurn(forced ? 'timeout' : 'submit');
      } else {
        this.recordAttempt();
        this.breakLocalMatchStreak();
        if (this.memes && !this.gameOver) this.memes.attemptResult('lose'); // too few shapes in Play Alone
      }
      return;
    }

    const matchShape = tiles[0] && tiles[0].shape;
    if (!MATCH_SHAPE_KEYS.includes(matchShape) || !tiles.every((tile) => tile.shape === matchShape)) {
      // Safety net: Cancel/Hazard/Dummy can never be submitted as a scoring match.
      await this.resetSelection();
      this.busy = false;
      return;
    }

    this.cancelShuffles(); // the board is about to change: stop any shuffle and settle the swap in progress
    await Promise.all(tiles.map((t) => t.flipChain)); // let any flips finish
    this.selection = [];
    this.selectedShape = null;
    await this.resetDummies(); // Dummies never get destroyed or counted as part of a successful match.

    const points = RULES.scoreFor(tiles.length);
    this.addScore(points);
    this.advanceLocalMatchStreak();
    await this.destroyTiles(tiles);
    await this.cascade();
    this.busy = false;
    if (RULES.hasReachedTarget(this.scores[this.activePlayer], this.modeCfg.targetScore)) {
      this.endGame(this.modeCfg.twoPlayers
        ? 'First to ' + this.modeCfg.targetScore + ' points wins.'
        : 'You reached ' + this.modeCfg.targetScore + ' points. You win!');
      return;
    }
    this.recordAttempt();
    this.endTurn('match'); // a valid match ends the turn; the new tiles keep revealing during the next turn
  },

  // Points go to the player whose turn it is.
  addScore(points) {
    const player = this.activePlayer;
    const label = player === 0 ? this.p1Score : this.p2Score;
    this.scores[player] += points;
    label.setText(String(this.scores[player]));
    this.tweens.add({ targets: label, scale: 1.35, duration: 120, yoyo: true });

    const pop = this.numberText(GAME_WIDTH / 2, this.tray.y, '+' + points, 90).setDepth(20);
    this.tweens.add({
      targets: pop, y: pop.y - 120, alpha: 0, duration: 900, ease: 'Sine.easeOut',
      onComplete: () => pop.destroy(),
    });
  },

  // Takes points off the active player and returns how many were actually lost. Two-player modes are limited only by TWO_PLAYER_SCORE_FLOOR (none by default); play alone can go
  // negative (and the game ends at ALONE_SCORE_FLOOR).
  applyPenalty(points) {
    const player = this.activePlayer;
    const floor = this.modeCfg.twoPlayers ? TWO_PLAYER_SCORE_FLOOR : -Infinity;
    const lost = RULES.penaltyToApply(this.scores[player], points, floor);
    if (lost <= 0) return 0;
    this.scores[player] -= lost;
    const label = player === 0 ? this.p1Score : this.p2Score;
    label.setText(String(this.scores[player]));
    this.tweens.add({ targets: label, scale: 1.35, duration: 120, yoyo: true });

    const pop = this.numberText(GAME_WIDTH / 2, this.tray.y, '\u2212' + lost, 90).setDepth(20).setColor('#ff8a7a');
    this.tweens.add({
      targets: pop, y: pop.y - 120, alpha: 0, duration: 900, ease: 'Sine.easeOut',
      onComplete: () => pop.destroy(),
    });
    return lost;
  },

  // Attempts in Play Alone are shown for statistics only; there is no checkpoint or attempt limit.
  recordAttempt() {
    if (this.modeCfg.twoPlayers || this.gameOver) return;
    this.totalAttempts++;
    this.updateAloneHUD();
    if (RULES.hasReachedScoreFloor(this.scores[0], ALONE_SCORE_FLOOR)) {
      this.endGame('Your score reached ' + ALONE_SCORE_FLOOR + '.');
    }
  },

};
