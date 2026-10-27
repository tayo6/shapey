// Shapey - GameScene: the match itself - board, tiles, turns, scoring, hazards, inventory,
// audience polls, the online client and the AI turn loop. Pure decisions live in
// rules.js / board.js / trackers.js / ai.js; this scene owns Phaser orchestration only.

import { GAME_WIDTH, GAME_HEIGHT, FONT, normalizeBoardSize, BASE_BOARD_SIZE, MIN_MATCH, AI_TURN_MS, INVENTORY_OPEN_LIMIT, PLAYER_NAMES, ALONE_SCORE_FLOOR, TEAM_PLAYERS, AI_LEVELS, SHAPE_KEYS, MATCH_SHAPE_KEYS } from '../constants.js';
import { RULES, LAYOUT, urlParams, REVIEW_MS, TURN_MS, INVENTORY_WINDOW_MS, MODE_TARGET_SCORE, MODES, START_MODE, HAZARD_OVERRIDE, TEST_OVERRIDES_ENABLED, TILE_SIZE, TILE_PITCH, GRID_COLS, GRID_ROWS, setBoardMetrics } from '../config.js';
import { hasTestOverride } from '../game/test-overrides.js';
import { formatClock } from '../utils.js';
import { makeInitialBoard, ShapeBag } from '../board.js';
import { Countdown, RevealTracker, InventoryLimiter } from '../trackers.js';
import { woodButton } from '../ui.js';
import { AIPlayer } from '../ai.js';

// Extracted method groups: each module in src/game/ adds a slice of this scene's behaviour.
import { InventoryMixin } from '../game/inventory.js';
import { createServerClockSync } from '../game/clock-sync.js';
import { AudiencePollMixin } from '../game/polls.js';
import { OnlineClientMixin } from '../game/online.js';
import { BoardMotionMixin } from '../game/board-motion.js';
import { AttemptFlowMixin } from '../game/attempts.js';
import { FxMixin } from '../game/fx.js';
import { AITurnMixin } from '../game/ai-turn.js';
import { RevealPrivacyMixin } from '../game/reveal-privacy.js';

export class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
  }

  init(data) {
    this.online = Boolean(data && data.online);
    this.spectator = Boolean(data && data.spectator);
    // Server wall-clock minus local clock, measured from every freshly received snapshot's
    // serverNow (see src/game/clock-sync.js for the latency analysis and tolerances). All
    // Worker deadlines (turnEndsAt, reveals, polls, movingUntil) are server timestamps and
    // must pass through serverToLocal() before being compared with Date.now().
    this.serverClockSync = createServerClockSync();
    this.audienceMode = data && data.audienceMode || '';
    this.audienceSoundMuted = (() => { try { return localStorage.getItem('shapey-audience-muted') === 'true'; } catch { return false; } })();
    this.onlineSocket = (data && data.onlineSocket) || null;
    this.onlinePlayerNumber = (data && data.onlinePlayerNumber) || null;
    this.onlineRoomCode = (data && data.onlineRoomCode) || null;
    this.onlineState = (data && data.onlineState) || null;
    // Arrival time of the launch snapshot (captured by the menu): replaying it below measures
    // the device-clock offset immediately instead of waiting for the first live broadcast.
    this.onlineStateReceivedAt = (data && data.onlineStateReceivedAt) || null;
    this.mode = (data && data.mode) || (this.onlineState && this.onlineState.mode) || START_MODE || 'pvp';
    const requestedBoardSize = normalizeBoardSize((data && data.boardSize) ||
      (this.onlineState && this.onlineState.boardSize) || urlParams.get('size'));
    this.boardSize = this.mode === 'tag' ? BASE_BOARD_SIZE : requestedBoardSize;
    // Applies the chosen board size to the live metrics in config.js (TILE_SIZE/PITCH, GRID_COLS/ROWS).
    setBoardMetrics(this.boardSize);
    this.modeCfg = MODES[this.mode];
    // Player vs AI difficulty comes from the picker (or ?level=pro for testing); Easy is the default.
    const level = (data && data.difficulty) || urlParams.get('level');
    this.difficulty = AI_LEVELS[level] ? level : 'easy';
    this.ai = AI_LEVELS[this.difficulty];
    const hardHumanTurnMs = hasTestOverride(urlParams, 'turn', TEST_OVERRIDES_ENABLED) ? TURN_MS : 30000;
    const tagTurnMs = hasTestOverride(urlParams, 'turn', TEST_OVERRIDES_ENABLED) ? TURN_MS : 30000;
    this.turnDurationMs = this.mode === 'tag' ? tagTurnMs
      : this.mode === 'ai'
        ? RULES.turnDurationForMode('ai', this.difficulty, TURN_MS, hardHumanTurnMs)
        : TURN_MS;
  }

  create() {
    this.scores = [0, 0];      // one score per player
    this.activePlayer = 0;     // 0 = Player 1, 1 = Player 2
    this.selection = [];      // actual shapes picked for the current attempt
    this.dummySelection = [];  // Dummies stay face-up during the attempt but never count as shapes
    this.selectedShape = null; // the shape the current attempt is matching
    this.busy = false;        // true while animations run (input is ignored)
    this.names = this.spectator && this.audienceMode === 'demo' ? ['AI 1', 'AI 2']
      : this.modeCfg.teams ? ['TEAM 1', 'TEAM 2']
        : this.modeCfg.ai ? ['Player 1', 'AI ' + this.ai.tag] : PLAYER_NAMES.slice();
    this.turnNumber = -1;            // counts normal turns from 0; a Double Play bonus keeps the same member
    this.activeMember = 0;           // Tag: which partner (0 or 1) of the active team is playing
    this.timeoutHandling = false;   // prevents duplicate timeout resolution across render frames
    this.doublePlayPendingPlayer = null;
    this.isBonusTurn = false;
    this.hazardChance = HAZARD_OVERRIDE !== null ? HAZARD_OVERRIDE : this.modeCfg.hazard;
    this.shapeBag = new ShapeBag(SHAPE_KEYS);
    this.gameOver = false;
    this.panelOpen = false;
    this.panelUI = [];
    this.turnId = 0;                 // bumped on every turn so a stale AI loop can tell its turn is over
    this.pendingSubmitTurnId = null;  // a Submit tap during an animation must be honoured when that animation finishes
    this.pendingOnlineSubmitKey = null;
    this.onlineSubmitPending = false;
    this.totalAttempts = 0;          // Play Alone statistic only; never a loss condition
    this.aiPlayer = new AIPlayer(this.ai); // memory + decisions (src/ai.js); this.ai stays the level table
    this.starBalance = this.loadStarBalance();
    // Track streaks per player seat even though the local prototype shares its Star wallet.
    this.matchStreaks = new Map();
    this.pendingStreakToast = null;
    this.inventoryItems = this.loadInventoryItems();
    // Audience polls are free, per player, and reset for each new game.
    this.audiencePollsUsedByPlayer = new Map();
    this.inventoryUI = [];
    this.inventoryOpen = false;
    this.inventoryTimerText = null;
    this.toast = null;
    this.toastTween = null;

    // Two independent countdowns that run at the same time (see TURN_MS above).
    this.turnClock = new Countdown();   // the active player's TURN_MS turn
    this.reveals = new RevealTracker(); // each batch's SPAWN_REVEAL_MS reveal
    this.turnEnding = false;            // true while a turn is being handed over: taps/submits are ignored
    this.shuffleToken = 0;              // bumped to cancel shuffles that are queued or running
    this.shuffling = 0;                 // number of shuffles running (for the SHUFFLING label)
    this.activeSwap = null;
    // Limits are per player: two players normally, four in Tag.
    this.inventoryLimiter = new InventoryLimiter(INVENTORY_OPEN_LIMIT, INVENTORY_WINDOW_MS, this.modeCfg.teams ? 4 : PLAYER_NAMES.length);

    // Meme commentary (src/memes.js). Optional: the game plays the same without it.
    this.memeSlot = LAYOUT.memeSlot; // where pictures are fitted (depends on the layout preset)
    this.memes = window.ShapeyMemes ? window.ShapeyMemes.attach(this) : null;

    this.createBackground();
    this.createHeader();
    this.createBottomButtons();
    this.createFx();
    this.createBoard();
    this.initRevealPrivacy({ gridCols: GRID_COLS, gridRows: GRID_ROWS, tilePitch: TILE_PITCH, fontFamily: FONT });
    if (this.spectator && urlParams.get('embed') === '1') {
      // Wait two animation frames so the first real board frame is painted before the parent
      // reveals Chat / Polls / Settings navigation.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        try { window.parent.postMessage({ type: 'shapey-game-ready' }, window.location.origin); } catch {}
      }));
    }
    if (this.online) {
      this.attachOnlineSocket();
      if (!this.spectator) this.showToast('Online match connected. Waiting for the server state.', 3200);
      if (this.spectator) {
        this.sound.mute = this.audienceSoundMuted;
        this.audienceMuteHandler = (event) => {
          if (event.data && event.data.type === 'shapey-audience-mute') {
            this.audienceSoundMuted = Boolean(event.data.muted);
            this.sound.mute = this.audienceSoundMuted;
            try { localStorage.setItem('shapey-audience-muted', String(this.audienceSoundMuted)); } catch {}
          }
        };
        window.addEventListener('message', this.audienceMuteHandler);
      }
      this.events.once('shutdown', () => {
        if (this.audienceMuteHandler) window.removeEventListener('message', this.audienceMuteHandler);
        if (this.onlineSocket) {
          try { this.onlineSocket.close(); } catch {}
          this.onlineSocket = null;
        }
      });
    } else {
      this.startTurn(0);
      if (!this.modeCfg.twoPlayers) {
        this.updateAloneHUD();
        this.showToast('No timer. You lose when your score reaches ' + ALONE_SCORE_FLOOR + '.', 4000);
      } else if (this.modeCfg.teams) {
        this.showToast('Tag: partners tag in on every other turn.\n' + this.turnLabel() + ' starts.', 4000);
      }
    }
  }

  // Runs every frame: flips tiles whose reveal is over, redraws both clocks, and ends the turn on timeout.
  update() {
    if (!this.turnClock) return;
    this.updateRevealPrivacy();
    if (this.memes) this.memes.tick();
    // GIFs are attached only after loading, so reposition an existing message every frame too.
    if (this.toast) {
      const toastY = this.memes && this.memes.visualVisible() ? LAYOUT.memeToastY : LAYOUT.toastY;
      if (this.toast.y !== toastY) this.toast.setY(toastY);
    }
    if (!this.online) {
      this.hideFinishedReveals();
      this.healStuckTiles();
    }
    this.refreshClocks();
    // A manual Submit is a request, not a tap we silently discard. If an animation was already
    // resolving, service that request as soon as the same turn is idle. A mismatch/hazard/match
    // that ends the turn first invalidates the queued request in startTurn().
    if (!this.online && this.pendingSubmitTurnId !== null) {
      if (this.pendingSubmitTurnId !== this.turnId || this.turnEnding || this.gameOver || !this.modeCfg.twoPlayers) {
        this.pendingSubmitTurnId = null;
      } else if (!this.busy) {
        this.pendingSubmitTurnId = null;
        this.submit(false, false, true);
      }
    }
    // The online server resolves expired turns and broadcasts the accepted state.
    // Local play resolves its own deadline after any in-flight animation finishes.
    if (!this.online && this.modeCfg.turnClock && !this.turnEnding && !this.timeoutHandling && this.turnClock.expired() && !this.busy) {
      this.timeoutHandling = true;
      this.submit(this.isAITurn(), true);
    }
  }

  // ---------------------------------------------------------------- layout
  // Scales an image so its width is exactly `width`, keeping the aspect ratio.
  fitToWidth(image, width = GAME_WIDTH) {
    image.setScale(width / image.width);
    return image;
  }

  // Layers from bottom to top: BG -> header shadow -> header plank 1
  //                            -> tray shadow -> tray -> bottom navigation
  createBackground() {
    this.bg = this.fitToWidth(this.add.image(0, 0, 'bg').setOrigin(0, 0)).setDepth(0);

    this.headerShadow = this.fitToWidth(
      this.add.image(GAME_WIDTH / 2, LAYOUT.headerShiftY, 'headerShadow').setOrigin(0.5, 0)
    ).setDepth(1);

    this.headerPlank = this.fitToWidth(
      this.add.image(GAME_WIDTH / 2, LAYOUT.headerShiftY, 'headerPlank1').setOrigin(0.5, 0)
    ).setDepth(2);

    this.trayShadow = this.fitToWidth(
      this.add.image(GAME_WIDTH / 2, GAME_HEIGHT / 2 + LAYOUT.trayShiftY, 'trayShadow')
    ).setDepth(3);

    this.tray = this.fitToWidth(
      this.add.image(this.trayShadow.x, this.trayShadow.y, 'tray')
    ).setDepth(4);

    this.bottomNav = this.fitToWidth(
      this.add.image(GAME_WIDTH / 2, GAME_HEIGHT + LAYOUT.navShiftY, 'bottomNav').setOrigin(0.5, 1)
    ).setDepth(5);
  }

  numberText(x, y, text, size) {
    return this.add.text(x, y, text, {
      fontFamily: FONT,
      fontSize: size + 'px',
      color: '#ffffff',
      stroke: '#3a2412',
      strokeThickness: Math.round(size / 4.5),
    }).setOrigin(0.5).setDepth(11);
  }

  // Score planks, timer and stars.
  createHeader() {
    const dy = LAYOUT.headerShiftY; // the whole header assembly moves together
    // The plank art is stored at about 1.5x its on-screen size (186 x 147 and 198 x 161).
    const p1 = this.add.image(105, 20 + dy, 'playerPlank1').setOrigin(0.5, 0).setDisplaySize(186.24, 147.36).setDepth(10);
    this.p1Score = this.numberText(p1.x + 2, p1.y + p1.displayHeight * 0.35, '0', 46);
    this.p1Name = this.numberText(p1.x - 4, p1.y + p1.displayHeight * 0.83, this.names[0], 21);

    const p2 = this.add.image(612, 20 + dy, 'playerPlank2').setOrigin(0.5, 0).setDisplaySize(197.76, 160.56).setDepth(10);
    this.p2Score = this.numberText(p2.x - 4, p2.y + p2.displayHeight * 0.35, '0', 46);
    this.p2Name = this.numberText(p2.x - 4, p2.y + p2.displayHeight * 0.83, this.names[1], 21);

    const timer = this.fitToWidth(this.add.image(GAME_WIDTH / 2, 101 + dy, 'timerPlank'), 262).setDepth(10);
    this.timerText = this.numberText(timer.x + 24, timer.y + 2, formatClock(this.turnDurationMs), 46);

    // Countdown for newly spawned tiles. It sits under the turn timer and only shows while tiles are face-up.
    this.revealText = this.numberText(GAME_WIDTH / 2, 190 + dy, '', 26).setVisible(false);

    // Play Alone shows attempts and its score floor here. In Tag the same spot names the team and partner whose turn it is.
    this.goalText = this.numberText(GAME_WIDTH / 2, 166 + dy, '', 21)
      .setVisible(!this.modeCfg.twoPlayers || !!this.modeCfg.teams);

    this.p1Stars = this.createStars(38, 213 + dy, this.starBalance);
    this.p2Stars = this.createStars(546, 213 + dy, this.modeCfg.ai ? 0 : this.starBalance);

    // Everything that belongs to one player, so the inactive player can be dimmed.
    this.playerUI = [
      [p1, this.p1Score, this.p1Name, ...this.p1Stars],
      [p2, this.p2Score, this.p2Name, ...this.p2Stars],
    ];

    // Play alone has no second player, so nothing of Player 2 is shown.
    if (!this.modeCfg.twoPlayers) this.playerUI[1].forEach((object) => object.setVisible(false));
  }

  // Play Alone has no clock or attempt limit; the centre panel shows attempts and the score floor.
  updateAloneHUD() {
    if (this.modeCfg.twoPlayers) return;
    this.timerText.setFontSize(23); // "TRIES: 17" must fit the timer plank; half the previous 46px size.
    this.timerText.setText('TRIES: ' + this.totalAttempts);
    this.goalText.setText('WIN ' + MODE_TARGET_SCORE.alone + ' · LOSE AT ' + ALONE_SCORE_FLOOR);
  }

  updateActivePlayerUI() {
    this.playerUI.forEach((group, player) => {
      group.forEach((object) => object.setAlpha(player === this.activePlayer ? 1 : 0.55));
    });
  }

  // A short message in the free strip between the header and the board.
  showToast(message, holdMs = 2600) {
    if (this.toastTween) this.toastTween.stop();
    if (this.toast) this.toast.destroy();
    // Keep text below the tray and above the bottom navigation while a GIF is visible.
    const toastY = this.memes && this.memes.visualVisible() ? LAYOUT.memeToastY : LAYOUT.toastY;
    const toast = this.add.text(GAME_WIDTH / 2, toastY, message, {
      fontFamily: FONT, fontSize: '24px', color: '#fff2c7',
      stroke: '#3a2412', strokeThickness: 5, align: 'center', wordWrap: { width: 660 },
    }).setOrigin(0.5).setDepth(200);
    this.toast = toast;
    this.toastTween = this.tweens.add({
      targets: toast, alpha: 0, delay: holdMs, duration: 400,
      onComplete: () => {
        toast.destroy();
        if (this.toast === toast) { this.toast = null; this.toastTween = null; }
      },
    });
  }

  // Keep the Star reward visible alongside the turn handoff message.
  showTurnToast(message, holdMs = 2600) {
    const reward = this.pendingStreakToast;
    this.pendingStreakToast = null;
    this.showToast(reward ? reward + ' · ' + message : message, reward ? 3600 : holdMs);
  }

  // ------------------------------------------------------- clocks and turns
  setClockText(textObject, value) {
    if (textObject.lastClock === value) return; // only redraw the text when it changes
    textObject.lastClock = value;
    textObject.setText(value);
  }

  // Converts a server-wall-clock timestamp to this device's clock, using the offset measured
  // from the freshest snapshots. Falls back to the raw value when no offset is known yet.
  serverToLocal(at) {
    return this.serverClockSync.serverToLocal(at);
  }

  // Both clocks are redrawn from their own deadlines, so they can never hold each other up.
  refreshClocks() {
    const now = Date.now();
    const openingStudyLeft = this.online && this.onlineState
      ? Math.max(0, this.serverToLocal(Number(this.onlineState.reviewEndsAt)) - now)
      : Number.isFinite(this.openingReviewEndsAt)
        ? Math.max(0, this.openingReviewEndsAt - now) : 0;
    const openingStudy = this.online
      ? Boolean(this.onlineState && this.onlineState.status === 'study')
      : openingStudyLeft > 0;
    const turnLeft = this.modeCfg.turnClock
      ? formatClock(Math.min(this.currentTurnDurationMs || this.turnDurationMs, this.turnClock.remaining())) : '';

    // Every mode shows the opening reveal countdown on the timer plank. Once it ends,
    // timed modes switch to the active player's pick countdown; Play Alone returns to Tries.
    if (openingStudy) {
      this.timerText.setFontSize(46);
      this.setClockText(this.timerText, formatClock(openingStudyLeft));
    } else if (this.modeCfg.turnClock) {
      this.timerText.setFontSize(46);
      this.setClockText(this.timerText, turnLeft);
    } else {
      this.timerText.setFontSize(23);
      this.setClockText(this.timerText, 'TRIES: ' + this.totalAttempts);
    }

    const revealLeft = this.online && this.onlineState
      ? Math.max(0, ...((this.onlineState.reveals || []).map((batch) => this.serverToLocal(batch.endsAt) - now)),
          this.onlineState.status === 'study' && Number.isFinite(this.onlineState.reviewEndsAt)
            ? this.serverToLocal(this.onlineState.reviewEndsAt) - now : 0)
      : this.reveals.remaining();
    const onlineShuffling = Boolean(this.online && this.onlineState && this.onlineState.shuffling);
    this.revealText.setVisible(revealLeft > 0 || this.shuffling > 0 || onlineShuffling);
    // The spawned-tile reveal has a visible numeric countdown in every mode, including Play Alone.
    if (revealLeft > 0) this.setClockText(this.revealText, 'MEMORIZE ' + formatClock(revealLeft));
    else if (this.shuffling > 0 || onlineShuffling) this.setClockText(this.revealText, 'SHUFFLING');

    // The shop covers the header, so it shows the same current timer without pausing it.
    if (this.inventoryTimerText && this.inventoryTimerText.active) {
      const shopClock = openingStudy ? 'REVEAL\n' + formatClock(openingStudyLeft)
        : this.modeCfg.turnClock ? 'TURN\n' + turnLeft : 'TRIES\n' + this.totalAttempts;
      this.setClockText(this.inventoryTimerText, shopClock);
    }
  }

  // `player` is the side that plays (0 or 1; a team in Tag). Scores, planks and the AI all work per side.
  startTurn(player, options = {}) {
    const bonus = options.bonus === true;
    this.pendingSubmitTurnId = null; // never carry a manual submit into another player's turn
    this.activePlayer = player;
    if (!bonus) this.turnNumber++;
    // Tag normal turns rotate partners: P1 → P3 → P2 → P4. A Double Play bonus repeats the same partner.
    this.activeMember = this.modeCfg.teams ? RULES.tagMemberForTurn(this.turnNumber) : 0;
    this.isBonusTurn = bonus;
    this.turnEnding = false;
    this.timeoutHandling = false;
    this.turnId++;
    // AI turns always have 5 seconds; human turns use the full duration for their mode.
    // Double Play repeats the active player's normal duration; only Extra Time adds time.
    const duration = this.mode === 'ai' && player === 1 ? AI_TURN_MS : this.turnDurationMs;
    this.currentTurnDurationMs = duration;
    if (this.modeCfg.turnClock) {
      // Give the first player the entire pick allowance after the opening reveal has ended.
      // The visible timer plank counts down the reveal separately while this deadline waits.
      const openingStudyRemaining = !bonus && Number.isFinite(this.openingReviewEndsAt)
        ? Math.max(0, this.openingReviewEndsAt - Date.now()) : 0;
      this.turnClock.start(duration + openingStudyRemaining);
    } else this.turnClock.endsAt = Infinity;
    this.updateActivePlayerUI();
    if (this.modeCfg.teams) this.goalText.setText(this.turnLabel().toUpperCase());
    if (this.modeCfg.ai && player === 1) this.runAITurn(this.turnId);
  }

  // Who is playing, for toasts and the header. Tag names the partner too: "Team 1: Player 2".
  turnLabel() {
    if (!this.modeCfg.teams) return this.names[this.activePlayer];
    return 'Team ' + (this.activePlayer + 1) + ': ' + TEAM_PLAYERS[this.activePlayer][this.activeMember];
  }

  // The inventory limit is per player, so Tag needs one slot per partner (four in all).
  limiterSlot() {
    return this.modeCfg.teams ? this.activePlayer * 2 + this.activeMember : this.activePlayer;
  }

  isAITurn() {
    return this.modeCfg.ai && this.activePlayer === 1;
  }

  // Ends the active player's turn exactly once (timeout or a submitted match) and hands over to the other player.
  async endTurn(reason, options = {}) {
    if (this.turnEnding || this.gameOver) return;
    this.turnEnding = true; // from here on, late taps and submits are ignored
    if (this.memes) this.memes.turnResult(reason); // win / lose commentary for the human who just played
    if (reason !== 'match') this.breakLocalMatchStreak();
    if (this.inventoryOpen) this.closeInventory();
    if (this.panelOpen) this.closePanel();
    this.closeAudiencePoll();
    await this.resetSelection(); // flip any picked tiles back (nothing to do after a match)
    if (this.gameOver) return;

    // Play alone: there is nobody to hand over to, so the player simply keeps playing.
    if (!this.modeCfg.twoPlayers) { this.turnEnding = false; return; }

    // Double Play is the only exception to alternating turns. It grants exactly one extra turn,
    // and the bonus turn cannot chain another Double Play.
    if (RULES.shouldGrantDoublePlay(this.isBonusTurn, this.doublePlayPendingPlayer, this.activePlayer)) {
      const samePlayer = this.activePlayer;
      this.doublePlayPendingPlayer = null;
      this.startTurn(samePlayer, { bonus: true });
      this.showTurnToast(this.turnLabel() + ' gets a Double Play bonus turn!');
      return;
    }

    const next = RULES.nextVersusPlayer(this.activePlayer);
    if (next == null) {
      console.error('Invalid versus turn owner; turn handoff stopped safely.');
      this.turnEnding = false;
      return;
    }
    this.startTurn(next);
    const prefix = reason === 'timeout' ? 'Time is up. '
      : reason === 'pass' ? 'The AI passes. '
      : reason === 'hazard' && !options.suppressHazardCommentary ? 'Hazard! No reward. '
      : reason === 'mismatch' ? 'Mismatch. '
      : reason === 'submit' ? 'Turn submitted. ' : '';
    this.showTurnToast(prefix + this.turnLabel() + '’s turn');
  }

  createStars(startX, y, count) {
    // Show the Star icon followed by its count, without a multiplier asterisk.
    const star = this.add.image(startX, y, 'starIcon').setDisplaySize(30, 30).setDepth(10);
    const multiplier = this.numberText(startX + 33, y, String(count), 23).setColor('#ffe36e');
    return [star, multiplier];
  }

  createBottomButtons() {
    if (this.spectator) {
      // The audience page supplies the chat, polls and settings icons above the read-only game.
      this.buttons = {};
      return;
    }
    const BUTTON_HEIGHT = 146;
    const BOTTOM = 1214 + LAYOUT.navShiftY; // bottom edge of the label plank
    const iconByAction = {
      settings: 'btnSettings',
      submit: 'btnSubmit',
      polls: 'btnPolls',
      inventory: 'btnInventory',
    };
    // Which icons each mode gets is decided in src/rules.js. Polls are only shown for online Player 1 vs Player 2 and Tag.
    const actions = RULES.navigationForMode(this.mode);
    // Keep each mode's icons centred and remove controls that mode does not support.
    const positions = actions.length === 2 ? [250, 470]
      : actions.length === 3 ? [175, 360, 545]
      : [136, 296, 449, 602];
    const buttons = actions.map((action, index) => [iconByAction[action], positions[index]]);
    this.buttons = {};
    for (const [key, x] of buttons) {
      const btn = this.add.image(x, BOTTOM, key).setOrigin(0.5, 1).setDepth(10);
      btn.setScale(BUTTON_HEIGHT / btn.height);
      this.buttons[key] = btn;
    }

    // Submit button: press feedback + submit the current match.
    const submit = this.buttons.btnSubmit;
    submit.setInteractive({ useHandCursor: true });
    const base = submit.scale;
    submit.on('pointerdown', () => {
      this.tweens.add({ targets: submit, scale: base * 0.93, duration: 70, yoyo: true });
      this.submit();
    });

    // Settings opens a small menu: resume, restart or go back to the mode picker.
    const settings = this.buttons.btnSettings;
    settings.setInteractive({ useHandCursor: true });
    settings.on('pointerdown', () => this.openPanel());

    // Polls are a live audience feature for online Player 1 vs Player 2 and Tag only; never simulate votes locally.
    const polls = this.buttons.btnPolls;
    if (polls) {
      polls.setInteractive({ useHandCursor: true });
      polls.on('pointerdown', () => {
        if ((this.mode === 'pvp' || this.mode === 'tag') && this.online && !this.panelOpen && !this.inventoryOpen) this.showAudiencePoll();
      });
    }

    // Inventory is not available in Play Along, so guard the optional icon.
    const inventory = this.buttons.btnInventory;
    if (inventory) {
      inventory.setInteractive({ useHandCursor: true });
      inventory.on('pointerdown', () => this.openInventory());
    }
  }

  // ------------------------------------------------------- in-game menu panel
  openPanel() {
    if (this.panelOpen || this.gameOver || this.inventoryOpen) return;
    this.panelOpen = true;
    const add = (object) => { this.panelUI.push(object); return object; };
    add(this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x120a05, 0.7)
      .setDepth(250).setInteractive());
    add(this.add.rectangle(GAME_WIDTH / 2, 640, 560, 560, 0x4b2d17, 1).setStrokeStyle(5, 0xd5ad72).setDepth(251));
    add(this.add.text(GAME_WIDTH / 2, 410, 'MENU', {
      fontFamily: FONT, fontSize: '56px', color: '#fff2c7', stroke: '#3a2412', strokeThickness: 9,
    }).setOrigin(0.5).setDepth(252));
    woodButton(this, GAME_WIDTH / 2, 530, 440, 90, 'RESUME', 36, () => this.closePanel(), 252).forEach(add);
    woodButton(this, GAME_WIDTH / 2, 645, 440, 90, this.online ? 'LEAVE MATCH' : 'RESTART', 36,
      () => this.online ? this.leaveOnlineMatch() : this.scene.restart({ mode: this.mode, difficulty: this.difficulty, boardSize: this.boardSize }), 252).forEach(add);
    woodButton(this, GAME_WIDTH / 2, 760, 440, 90, 'MAIN MENU', 36,
      () => this.online ? this.leaveOnlineMatch() : this.scene.start('MenuScene'), 252).forEach(add);
    if (this.modeCfg.turnClock) {
      add(this.add.text(GAME_WIDTH / 2, 850, 'The turn clock keeps running.', {
        fontFamily: FONT, fontSize: '20px', color: '#ffe9b8',
      }).setOrigin(0.5).setDepth(252));
    }
  }

  closePanel() {
    this.panelUI.forEach((object) => object.destroy());
    this.panelUI = [];
    this.panelOpen = false;
  }

  leaveOnlineMatch() {
    if (this.onlineSocket) {
      const socket = this.onlineSocket;
      this.onlineSocket = null;
      try { socket.close(); } catch {}
    }
    this.scene.start('MenuScene');
  }


  // ---------------------------------------------------------------- board
  cellX(col) { return this.gridX0 + col * TILE_PITCH; }
  cellY(row) { return this.gridY0 + row * TILE_PITCH; }

  // The selected square board is centred on the tray. Every tile is 90 x 90.
  createBoard() {
    this.gridX0 = this.tray.x - ((GRID_COLS - 1) * TILE_PITCH) / 2;
    this.gridY0 = this.tray.y - ((GRID_ROWS - 1) * TILE_PITCH) / 2;

    // Tiles are clipped to the tray, so new shapes can fall in from above the board.
    const maskGfx = this.make.graphics({ x: 0, y: 0, add: false });
    maskGfx.fillStyle(0xffffff);
    maskGfx.fillRect(
      this.gridX0 - TILE_PITCH / 2 - 2,
      this.gridY0 - TILE_PITCH / 2 - 2,
      GRID_COLS * TILE_PITCH + 4,
      GRID_ROWS * TILE_PITCH + 4
    );
    this.boardMask = maskGfx.createGeometryMask();
    // The mask graphics are created with add:false, so Phaser's scene shutdown never destroys
    // them. Clean them up here or every restart of this scene leaks one Graphics object
    // (and its WebGL buffers) for the lifetime of the page.
    this.events.once('shutdown', () => {
      try { this.boardMask.destroy(); } catch {}
      try { maskGfx.destroy(); } catch {}
    });

    if (this.online) {
      this.tiles = Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(null));
      this.onlineTilesById = new Map();
      this.applyOnlineState(this.onlineState, true, this.onlineStateReceivedAt);
      return;
    }

    const layout = makeInitialBoard(this.boardSize, this.boardSize, this.hazardChance);
    this.tiles = [];
    const all = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      this.tiles[r] = [];
      for (let c = 0; c < GRID_COLS; c++) {
        const tile = this.createTile(layout[r][c], r, c, this.cellX(c), this.cellY(r));
        this.tiles[r][c] = tile;
        all.push(tile);
      }
    }
    all.forEach((tile) => this.aiSee(tile)); // the AI studies the board too (and forgets about half of it)
    this.openingReviewEndsAt = Date.now() + REVIEW_MS;
    this.startReview(all, REVIEW_MS, false); // study phase: everything face-up for 15s, then flip to mystery (no shuffle)
  }


  // A new tile, created face-up.
  createTile(shape, row, col, x, y) {
    const tile = this.add.image(x, y, 'shape_' + shape).setDisplaySize(TILE_SIZE, TILE_SIZE).setDepth(10);
    tile.shape = shape;
    tile.row = row;
    tile.col = col;
    tile.faceUp = true;
    tile.upSince = this.time.now;
    tile.selected = false;
    tile.swapping = false; // true while the tile is moving in a shuffle swap
    tile.baseScale = tile.scaleX;
    tile.flipChain = Promise.resolve();
    tile.setMask(this.boardMask);
    if (!this.spectator) {
      tile.setInteractive({ useHandCursor: true });
      tile.on('pointerdown', () => this.onTileTap(tile));
    }
    return tile;
  }

  sleep(ms) {
    return new Promise((resolve) => this.time.delayedCall(ms, resolve));
  }

  tweenAsync(config) {
    return new Promise((resolve) => this.tweens.add({ ...config, onComplete: resolve }));
  }

  // Flip a tile to face-up (its shape) or face-down (mystery). Flips on one tile never overlap.
  flipTile(tile, faceUp, delay = 0) {
    tile.flipChain = tile.flipChain.then(async () => {
      if (!tile.active || tile.faceUp === faceUp) return;
      if (delay) await this.sleep(delay);
      if (!tile.active) return;
      this.playFlipSound();
      await this.tweenAsync({ targets: tile, scaleX: 0, duration: 100, ease: 'Sine.easeIn' });
      if (!tile.active) return;
      tile.setTexture('shape_' + (faceUp ? tile.shape : 'mystery'));
      tile.faceUp = faceUp;
      tile.upSince = faceUp ? this.time.now : 0;
      await this.tweenAsync({ targets: tile, scaleX: tile.baseScale, duration: 100, ease: 'Sine.easeOut' });
    });
    return tile.flipChain;
  }


  endGame(reason) {
    if (this.gameOver) return;
    this.gameOver = true;
    if (this.memes) this.memes.hide(); // the end screen covers the canvas; a picture on top of it would hide the buttons
    if (this.inventoryOpen) this.closeInventory();
    this.closePanel();
    const text = (y, message, size, color = '#ffffff') => this.add.text(GAME_WIDTH / 2, y, message, {
      fontFamily: FONT, fontSize: size + 'px', color, stroke: '#3a2412', strokeThickness: Math.round(size / 6),
      align: 'center', wordWrap: { width: 600 },
    }).setOrigin(0.5).setDepth(301);
    this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x120a05, 0.85)
      .setDepth(300).setInteractive();
    const versus = this.modeCfg.twoPlayers;
    const soloWin = !versus && RULES.hasReachedTarget(this.scores[0], this.modeCfg.targetScore);
    text(330, soloWin ? 'YOU WIN!' : versus ? this.names[this.activePlayer] + ' WINS!' : 'GAME OVER',
      76, versus || soloWin ? '#ffe36e' : '#ff8a7a');
    text(450, reason, 32, '#fff2c7');
    const summary = versus
      ? this.names[0] + ': ' + this.scores[0] + '\n' + this.names[1] + ': ' + this.scores[1] +
        '\nTarget: ' + this.modeCfg.targetScore
      : 'Score: ' + this.scores[0] + '\nAttempts: ' + this.totalAttempts +
        (this.modeCfg.targetScore ? '\nTarget: ' + this.modeCfg.targetScore : '');
    text(600, summary, 40, '#ffe36e');
    woodButton(this, GAME_WIDTH / 2, 810, 500, 110, this.online ? 'NEW ONLINE ROOM' : 'PLAY AGAIN', 44,
      () => this.online ? this.leaveOnlineMatch() : this.scene.restart({ mode: this.mode, difficulty: this.difficulty, boardSize: this.boardSize }), 301);
    woodButton(this, GAME_WIDTH / 2, 950, 500, 110, 'MAIN MENU', 44, () => this.scene.start('MenuScene'), 301);
  }


  // ------------------------------------------------------------- cascade
  // Tiles above gaps fall down, then new shapes fall in from above the board.
  async cascade() {
    const counts = {};
    for (const row of this.tiles) for (const t of row) if (t) counts[t.shape] = (counts[t.shape] || 0) + 1;

    const fallTweens = [];
    const fresh = [];

    for (let c = 0; c < GRID_COLS; c++) {
      // 1. existing tiles drop to the lowest free slots
      let write = GRID_ROWS - 1;
      for (let r = GRID_ROWS - 1; r >= 0; r--) {
        const tile = this.tiles[r][c];
        if (!tile) continue;
        if (r !== write) {
          this.tiles[write][c] = tile;
          this.tiles[r][c] = null;
          tile.row = write;
          fallTweens.push(this.fall(tile, this.cellY(write), 0));
        }
        write--;
      }

      // 2. new tiles spawn above the board (stacked) and fall into the empty slots
      const empties = write + 1;
      for (let r = empties - 1; r >= 0; r--) {
        const shape = this.pickShape(counts);
        counts[shape] = (counts[shape] || 0) + 1;
        const tile = this.createTile(shape, r, c, this.cellX(c), this.cellY(r - empties));
        this.tiles[r][c] = tile;
        fresh.push(tile);
        fallTweens.push(this.fall(tile, this.cellY(r), 40 * (empties - 1 - r), true));
      }
    }

    await Promise.all(fallTweens);
    this.ensureMatchPossible(fresh);
    fresh.forEach((tile) => this.aiSee(tile)); // the AI watches the new tiles being revealed
    if (fresh.length) this.startReview(fresh);
  }

  // Safety net: if a refill leaves no shape with 3 tiles, turn some new tiles into the most common
  // shape so the board never becomes unplayable.
  ensureMatchPossible(fresh) {
    const counts = {};
    for (const row of this.tiles) for (const tile of row) {
      if (tile && MATCH_SHAPE_KEYS.includes(tile.shape)) counts[tile.shape] = (counts[tile.shape] || 0) + 1;
    }
    if (Object.values(counts).some((count) => count >= MIN_MATCH)) return;
    const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || MATCH_SHAPE_KEYS[0];
    let need = MIN_MATCH - (counts[best] || 0);
    for (const tile of fresh) {
      if (need <= 0) break;
      if (tile.shape === best || ['hazard', 'dummy', 'cancel'].includes(tile.shape)) continue;
      tile.shape = best;
      tile.setTexture('shape_' + best);
      need--;
    }
  }


}

// The scene is composed from the mixins in src/game/: they are plain method sets
// that keep `this` (this scene), so the class above stays the orchestrator only.
Object.assign(GameScene.prototype, InventoryMixin, AudiencePollMixin, OnlineClientMixin, BoardMotionMixin, AttemptFlowMixin, FxMixin, AITurnMixin, RevealPrivacyMixin);
