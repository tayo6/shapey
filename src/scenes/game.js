// Shapey - GameScene: the match itself - board, tiles, turns, scoring, hazards, inventory,
// audience polls, the online client and the AI turn loop. Pure decisions live in
// rules.js / board.js / trackers.js / ai.js; this scene owns Phaser orchestration only.

import { GAME_WIDTH, GAME_HEIGHT, MEME_TOAST_Y, FONT, normalizeBoardSize, BASE_BOARD_SIZE, BASE_TILE_SIZE, STUCK_UP_MS, SHUFFLE_ARC_PX, MIN_MATCH, AI_TURN_MS, INVENTORY_OPEN_LIMIT, PLAYER_NAMES, ALONE_SCORE_FLOOR, ALONE_MISS_PENALTY, HAZARD_BLAST_PENALTY, TWO_PLAYER_SCORE_FLOOR, TEAM_PLAYERS, AI_LEVELS, AI_SPARE_MS, SHAPE_KEYS, MATCH_SHAPE_KEYS, DUMMY_SPAWN_CHANCE, DESTROY_FRAME_X, DUST_FRAME_COUNT, DUST_FRAME_WIDTH, DUST_FRAME_HEIGHT, DUST_SCALE, DUST_FRAME_RATE } from '../constants.js';
import { RULES, urlParams, REVIEW_MS, SPAWN_REVEAL_MS, SHUFFLE_STEP_MS, TURN_MS, INVENTORY_WINDOW_MS, formatInventoryWindow, MODE_TARGET_SCORE, MODES, START_MODE, HAZARD_OVERRIDE, TILE_SIZE, TILE_PITCH, GRID_COLS, GRID_ROWS, setBoardMetrics } from '../config.js';
import { formatClock, randomItem, shuffle, planShuffle } from '../utils.js';
import { makeInitialBoard, ShapeBag } from '../board.js';
import { Countdown, RevealTracker, InventoryLimiter } from '../trackers.js';
import { woodButton } from '../ui.js';
import { AIPlayer } from '../ai.js';

export class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
  }

  init(data) {
    this.online = Boolean(data && data.online);
    this.spectator = Boolean(data && data.spectator);
    this.audienceMode = data && data.audienceMode || '';
    this.audienceSoundMuted = (() => { try { return localStorage.getItem('shapey-audience-muted') === 'true'; } catch { return false; } })();
    this.onlineSocket = (data && data.onlineSocket) || null;
    this.onlinePlayerNumber = (data && data.onlinePlayerNumber) || null;
    this.onlineRoomCode = (data && data.onlineRoomCode) || null;
    this.onlineState = (data && data.onlineState) || null;
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
    const hardHumanTurnMs = urlParams.has('turn') ? TURN_MS : 30000;
    const tagTurnMs = urlParams.has('turn') ? TURN_MS : 30000;
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
    this.memes = window.ShapeyMemes ? window.ShapeyMemes.attach(this) : null;

    this.createBackground();
    this.createHeader();
    this.createBottomButtons();
    this.createFx();
    this.createBoard();
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
    if (this.memes) this.memes.tick();
    // GIFs are attached only after loading, so reposition an existing message every frame too.
    if (this.toast) {
      const toastY = this.memes && this.memes.visualVisible() ? MEME_TOAST_Y : 256;
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
      this.add.image(GAME_WIDTH / 2, 0, 'headerShadow').setOrigin(0.5, 0)
    ).setDepth(1);

    this.headerPlank = this.fitToWidth(
      this.add.image(GAME_WIDTH / 2, 0, 'headerPlank1').setOrigin(0.5, 0)
    ).setDepth(2);

    this.trayShadow = this.fitToWidth(
      this.add.image(GAME_WIDTH / 2, GAME_HEIGHT / 2, 'trayShadow')
    ).setDepth(3);

    this.tray = this.fitToWidth(
      this.add.image(this.trayShadow.x, this.trayShadow.y, 'tray')
    ).setDepth(4);

    this.bottomNav = this.fitToWidth(
      this.add.image(GAME_WIDTH / 2, GAME_HEIGHT, 'bottomNav').setOrigin(0.5, 1)
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
    // The plank art is stored at about 1.5x its on-screen size (186 x 147 and 198 x 161).
    const p1 = this.add.image(105, 20, 'playerPlank1').setOrigin(0.5, 0).setDisplaySize(186.24, 147.36).setDepth(10);
    this.p1Score = this.numberText(p1.x + 2, p1.y + p1.displayHeight * 0.35, '0', 46);
    this.p1Name = this.numberText(p1.x - 4, p1.y + p1.displayHeight * 0.83, this.names[0], 21);

    const p2 = this.add.image(612, 20, 'playerPlank2').setOrigin(0.5, 0).setDisplaySize(197.76, 160.56).setDepth(10);
    this.p2Score = this.numberText(p2.x - 4, p2.y + p2.displayHeight * 0.35, '0', 46);
    this.p2Name = this.numberText(p2.x - 4, p2.y + p2.displayHeight * 0.83, this.names[1], 21);

    const timer = this.fitToWidth(this.add.image(GAME_WIDTH / 2, 101, 'timerPlank'), 262).setDepth(10);
    this.timerText = this.numberText(timer.x + 24, timer.y + 2, formatClock(this.turnDurationMs), 46);

    // Countdown for newly spawned tiles. It sits under the turn timer and only shows while tiles are face-up.
    this.revealText = this.numberText(GAME_WIDTH / 2, 190, '', 26).setVisible(false);

    // Play Alone shows attempts and its score floor here. In Tag the same spot names the team and partner whose turn it is.
    this.goalText = this.numberText(GAME_WIDTH / 2, 166, '', 21)
      .setVisible(!this.modeCfg.twoPlayers || !!this.modeCfg.teams);

    this.p1Stars = this.createStars(38, 213, this.starBalance);
    this.p2Stars = this.createStars(546, 213, this.modeCfg.ai ? 0 : this.starBalance);

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
    const toastY = this.memes && this.memes.visualVisible() ? MEME_TOAST_Y : 256;
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

  // Both clocks are redrawn from their own deadlines, so they can never hold each other up.
  refreshClocks() {
    const now = Date.now();
    const openingStudyLeft = this.online && this.onlineState
      ? Math.max(0, Number(this.onlineState.reviewEndsAt) - now)
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
      ? Math.max(0, ...((this.onlineState.reveals || []).map((batch) => batch.endsAt - now)),
          this.onlineState.status === 'study' && Number.isFinite(this.onlineState.reviewEndsAt)
            ? this.onlineState.reviewEndsAt - now : 0)
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
    const BOTTOM = 1214; // bottom edge of the label plank
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

  // ---------------------------------------------------------- inventory/shop
  loadStarBalance() {
    try {
      const raw = window.localStorage.getItem('shapey-stars');
      return RULES.initialStarBalance(raw);
    } catch (_) {
      return 1;
    }
  }

  loadInventoryItems() {
    try {
      const stored = window.localStorage.getItem('shapey-inventory');
      const items = stored ? (JSON.parse(stored) || {}) : {};
      // Preserve previously purchased Double Time cards as the new +45-second Extra Time item.
      if (Number(items.doubleTime) > 0) {
        items.extraTime = Number(items.extraTime || 0) + Number(items.doubleTime);
        delete items.doubleTime;
      }
      // Audience polls are a free per-game allowance, not a purchasable inventory item.
      delete items.audiencePick;
      try { window.localStorage.setItem('shapey-inventory', JSON.stringify(items)); } catch (_) {}
      return items;
    } catch (_) {
      return {};
    }
  }

  saveInventory() {
    try {
      window.localStorage.setItem('shapey-stars', String(this.starBalance));
      window.localStorage.setItem('shapey-inventory', JSON.stringify(this.inventoryItems));
    } catch (_) {
      // Storage may be unavailable in private browsing; the shop still works for this session.
    }
    this.updateStarDisplays();
  }

  updateStarDisplays() {
    if (this.p1Stars && this.p1Stars[1] && this.p1Stars[1].active) {
      this.p1Stars[1].setText(String(this.starBalance));
    }
    if (this.p2Stars && this.p2Stars[1] && this.p2Stars[1].active) {
      this.p2Stars[1].setText(String(this.modeCfg.ai ? 0 : this.starBalance));
    }
  }

  // The 3rd consecutive successful turn earns 3 Stars; later streak lengths earn their number.
  advanceLocalMatchStreak() {
    if (!this.modeCfg.twoPlayers) return; // Play Alone has no turn streak.
    const slot = this.limiterSlot();
    const current = this.matchStreaks.get(slot) || { streak: 0, lastRewardedStreak: 0 };
    const next = RULES.nextMatchStreak(current.streak, current.lastRewardedStreak, true);
    this.matchStreaks.set(slot, next);
    if (!next.reward || (this.modeCfg.ai && this.activePlayer === 1)) return;
    this.starBalance += next.reward;
    this.saveInventory();
    // Defer the reward message until turn handoff so the ordinary turn message cannot hide it.
    this.pendingStreakToast = next.streak + '-match streak! +' + next.reward + ' Stars';
  }

  breakLocalMatchStreak() {
    if (!this.modeCfg.twoPlayers) return;
    this.matchStreaks.set(this.limiterSlot(), RULES.nextMatchStreak(0, 0, false));
  }

  clearInventoryUI() {
    this.inventoryUI.forEach((object) => object.destroy());
    this.inventoryUI = [];
    this.inventoryTimerText = null;
  }

  addInventoryUI(object) {
    object.setDepth(100);
    this.inventoryUI.push(object);
    return object;
  }

  // Opening the inventory is limited per player (INVENTORY_OPEN_LIMIT per INVENTORY_WINDOW_MS) so it
  // can't be used to stall. Only a successful open is counted; redrawing the shop is not an open.
  openInventory() {
    if (this.inventoryOpen || this.turnEnding || this.gameOver || this.panelOpen || this.isAITurn()) return;
    if (this.online && this.onlineState &&
        this.onlineState.activePlayerNumber !== this.onlinePlayerNumber) {
      this.showToast('Only the player whose turn it is can open the inventory.', 2200);
      return;
    }
    const attempt = this.inventoryLimiter.tryOpen(this.limiterSlot());
    if (!attempt.allowed) {
      const windowText = formatInventoryWindow();
      this.showToast('Inventory limit reached (' + INVENTORY_OPEN_LIMIT + ' per ' + windowText +
        ').\nAvailable again in ' + formatClock(attempt.retryInMs));
      return;
    }
    this.inventoryOpen = true;
    this.renderInventory();
  }

  renderInventory() {
    this.clearInventoryUI();

    // Full-page shop uses the same BG.webp art as the game background.
    const pageBg = this.add.image(0, 0, 'bg').setOrigin(0, 0).setDisplaySize(GAME_WIDTH, GAME_HEIGHT);
    this.addInventoryUI(pageBg);

    // Full-screen input shield prevents taps reaching the board underneath.
    const shield = this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x160d08, 0.34)
      .setInteractive();
    this.addInventoryUI(shield);

    const title = this.add.text(GAME_WIDTH / 2, 66, 'INVENTORY & SHOP', {
      fontFamily: FONT, fontSize: '48px', color: '#fff2c7',
      stroke: '#4a2814', strokeThickness: 7,
    }).setOrigin(0.5);
    this.addInventoryUI(title);

    const balance = this.add.text(GAME_WIDTH / 2, 128, 'YOUR STARS: ' + this.starBalance, {
      fontFamily: FONT, fontSize: '31px', color: '#ffe36e',
      stroke: '#4a2814', strokeThickness: 5,
    }).setOrigin(0.5);
    this.addInventoryUI(balance);

    const closeBg = this.add.rectangle(646, 66, 82, 66, 0x754322, 1)
      .setStrokeStyle(4, 0xf3d29a).setInteractive({ useHandCursor: true });
    this.addInventoryUI(closeBg);
    const closeText = this.add.text(646, 65, 'BACK', {
      fontFamily: FONT, fontSize: '23px', color: '#ffffff',
    }).setOrigin(0.5);
    this.addInventoryUI(closeText);
    closeBg.on('pointerdown', () => this.closeInventory());

    // The turn clock keeps running while the shop is open, so show it here too.
    if (this.modeCfg.turnClock) {
      this.inventoryTimerText = this.addInventoryUI(this.add.text(84, 66,
        'TURN\n' + formatClock(Math.min(this.currentTurnDurationMs || this.turnDurationMs, this.turnClock.remaining())), {
          fontFamily: FONT, fontSize: '24px', color: '#ffe36e',
          stroke: '#4a2814', strokeThickness: 4, align: 'center',
        }).setOrigin(0.5));
    }

    const offers = [
      { key: 'extraTime', name: 'EXTRA TIME (+45s)', price: 3, desc: 'Add 45 seconds to the current turn each time you use one.' },
      { key: 'doublePlay', name: 'DOUBLE PLAY', price: 4, desc: 'Take one extra turn with your mode’s normal timer.' },
      { key: 'scoreStrike', name: 'SCORE STRIKE', price: 5, desc: 'Remove 10 points from your opponent.' },
    ];

    // Three free polls are an allowance for this game, not a Star-priced shop item.
    const hasFreeAudiencePolls = this.mode !== 'alone';
    if (hasFreeAudiencePolls) {
      const y = 238;
      const card = this.add.rectangle(GAME_WIDTH / 2, y, 630, 174, 0x704323, 0.96)
        .setStrokeStyle(4, 0xd5ad72);
      this.addInventoryUI(card);
      const name = this.add.text(68, y - 66, 'FREE AUDIENCE POLLS', {
        fontFamily: FONT, fontSize: '29px', color: '#fff0c7',
        stroke: '#3a2112', strokeThickness: 4,
      }).setOrigin(0, 0.5);
      this.addInventoryUI(name);
      const desc = this.add.text(68, y - 20,
        '3 free uses per player, per game. Never bought with Stars.', {
          fontFamily: FONT, fontSize: '21px', color: '#ffffff',
          wordWrap: { width: 440 },
        }).setOrigin(0, 0.5);
      this.addInventoryUI(desc);
      const remaining = this.add.text(68, y + 48,
        'Remaining this game: ' + this.getAudiencePollsRemaining(), {
          fontFamily: FONT, fontSize: '22px', color: '#ffdf78',
        }).setOrigin(0, 0.5);
      this.addInventoryUI(remaining);
      const freeLabel = this.add.text(554, y - 5, 'FREE', {
        fontFamily: FONT, fontSize: '24px', color: '#ffdf78',
        stroke: '#3a2112', strokeThickness: 4,
      }).setOrigin(0.5);
      this.addInventoryUI(freeLabel);
    }

    const offerStartY = hasFreeAudiencePolls ? 443 : 238;
    offers.forEach((offer, index) => {
      const y = offerStartY + index * 205;
      const card = this.add.rectangle(GAME_WIDTH / 2, y, 630, 174, 0x704323, 0.96)
        .setStrokeStyle(4, 0xd5ad72);
      this.addInventoryUI(card);

      const name = this.add.text(68, y - 66, offer.name, {
        fontFamily: FONT, fontSize: '29px', color: '#fff0c7',
        stroke: '#3a2112', strokeThickness: 4,
      }).setOrigin(0, 0.5);
      this.addInventoryUI(name);

      const desc = this.add.text(68, y - 20, offer.desc, {
        fontFamily: FONT, fontSize: '21px', color: '#ffffff',
        wordWrap: { width: 405 },
      }).setOrigin(0, 0.5);
      this.addInventoryUI(desc);

      const ownedCount = Number(this.inventoryItems[offer.key] || 0);
      const owned = this.add.text(68, y + 48, 'Owned: ' + ownedCount, {
        fontFamily: FONT, fontSize: '22px', color: '#ffdf78',
      }).setOrigin(0, 0.5);
      this.addInventoryUI(owned);

      if (this.online && !['extraTime', 'doublePlay'].includes(offer.key)) {
        const notice = this.add.text(554, y - 5, 'COMING SOON\nONLINE', {
          fontFamily: FONT, fontSize: '18px', color: '#fff0c7', align: 'center',
        }).setOrigin(0.5);
        this.addInventoryUI(notice);
        return;
      }

      if (['extraTime', 'doublePlay'].includes(offer.key) && ownedCount > 0) {
        const canUse = offer.key === 'extraTime'
          ? this.modeCfg.turnClock && !this.turnClock.expired() && !this.turnEnding && !this.isAITurn()
          : offer.key === 'doublePlay'
            ? this.modeCfg.twoPlayers && !this.turnClock.expired() && !this.turnEnding &&
              !this.isBonusTurn && this.doublePlayPendingPlayer === null
            : true;
        const useBg = this.add.rectangle(554, y - 43, 144, 54, canUse ? 0x3b7c3f : 0x665c50, 1)
          .setStrokeStyle(3, 0xf3d29a);
        this.addInventoryUI(useBg);
        const useText = this.add.text(554, y - 43, canUse ? 'USE' : 'UNAVAILABLE', {
          fontFamily: FONT, fontSize: canUse ? '22px' : '14px', color: '#ffffff', align: 'center',
        }).setOrigin(0.5);
        this.addInventoryUI(useText);
        if (canUse) {
          useBg.setInteractive({ useHandCursor: true });
          useBg.on('pointerdown', () => {
            if (this.online) {
              const itemKey = offer.key;
              this.closeInventory();
              this.sendOnlineAction({ type: 'useItem', itemKey });
              return;
            }
            const count = Number(this.inventoryItems[offer.key] || 0);
            if (count < 1) return;
            if (offer.key === 'extraTime') {
              if (!this.modeCfg.turnClock || this.turnClock.expired() || this.turnEnding || this.isAITurn()) return;
              this.inventoryItems.extraTime = count - 1;
              this.turnClock.endsAt += 45000;
              this.currentTurnDurationMs = (this.currentTurnDurationMs || this.turnDurationMs) + 45000;
              this.saveInventory();
              this.closeInventory();
              this.refreshClocks();
              this.showToast('Extra Time used: +45 seconds added to this turn.', 3200);
              return;
            }
            if (offer.key === 'doublePlay') {
              if (!this.modeCfg.twoPlayers || this.turnClock.expired() || this.turnEnding ||
                  this.isBonusTurn || this.doublePlayPendingPlayer !== null) return;
              this.inventoryItems.doublePlay = count - 1;
              this.doublePlayPendingPlayer = this.activePlayer;
              this.saveInventory();
              this.showToast('Double Play ready: after this turn, you get one extra turn.', 3200);
              this.closeInventory();
            }
          });
        }
      }

      const buyBg = this.add.rectangle(554, y + 32, 144, 62,
        this.starBalance >= offer.price ? 0x3b7c3f : 0x665c50, 1)
        .setStrokeStyle(3, 0xf3d29a);
      this.addInventoryUI(buyBg);

      const buyText = this.add.text(554, y + 32, this.starBalance >= offer.price
        ? 'BUY · ' + offer.price + ' ★' : offer.price + ' ★ NEEDED', {
        fontFamily: FONT, fontSize: this.starBalance >= offer.price ? '22px' : '16px',
        color: '#ffffff', align: 'center', wordWrap: { width: 132 },
      }).setOrigin(0.5);
      this.addInventoryUI(buyText);

      if (this.starBalance >= offer.price) {
        buyBg.setInteractive({ useHandCursor: true });
        buyBg.on('pointerdown', () => {
          if (this.online) {
            this.sendOnlineAction({ type: 'buyItem', itemKey: offer.key });
            return;
          }
          if (this.starBalance < offer.price) return;
          this.starBalance -= offer.price;
          this.inventoryItems[offer.key] = Number(this.inventoryItems[offer.key] || 0) + 1;
          this.saveInventory();
          this.renderInventory(); // refresh in place: a purchase must not count as a new open
        });
      }
    });

    const counter = this.add.rectangle(GAME_WIDTH / 2, 1090, 630, 118, 0x4b3929, 0.97)
      .setStrokeStyle(4, 0xd5ad72);
    this.addInventoryUI(counter);
    const counterText = this.add.text(GAME_WIDTH / 2, 1080,
      'CANCEL COUNTER  ·  SPECIAL ITEM\nEarn by collecting a Cancel tile. Use it to block an opponent’s Score Strike, Extra Time, or Double Play.', {
        fontFamily: FONT, fontSize: '20px', color: '#fff0c7',
        align: 'center', wordWrap: { width: 570 }, lineSpacing: 5,
      }).setOrigin(0.5);
    this.addInventoryUI(counterText);

    const note = this.add.text(GAME_WIDTH / 2, 1192,
      'Purchases are saved on this device. Using power-ups in a match is coming next.\nThe inventory can be opened ' +
      INVENTORY_OPEN_LIMIT + ' times per ' + formatInventoryWindow() +
      (this.modeCfg.turnClock ? ', and your turn clock keeps running while it is open.' : '.'), {
        fontFamily: FONT, fontSize: '17px', color: '#ffffff',
        align: 'center', wordWrap: { width: 630 },
      }).setOrigin(0.5);
    this.addInventoryUI(note);
  }

  closeInventory() {
    this.clearInventoryUI();
    this.inventoryOpen = false;
  }

  getAudiencePollsUsed() {
    if (this.online) {
      const used = Number(this.onlineState && this.onlineState.me && this.onlineState.me.audiencePollsUsed);
      return Math.max(0, Math.min(3, Number.isFinite(used) ? used : 0));
    }
    const slot = this.limiterSlot();
    return Math.max(0, Math.min(3, Number(this.audiencePollsUsedByPlayer.get(slot) || 0)));
  }

  getAudiencePollsRemaining() {
    return Math.max(0, 3 - this.getAudiencePollsUsed());
  }

  // Three free polls per player per game are enforced by the online Worker.
  showAudiencePoll() {
    this.closeAudiencePoll();
    if (this.gameOver) return;

    // Audience polling is a live multiplayer feature, never a local AI practice simulation.
    if (this.mode !== 'pvp' && this.mode !== 'tag') {
      this.showToast('Audience polls are only available in online Player 1 vs Player 2 and Tag.', 2800);
      return;
    }
    if (!this.online || !this.onlineSocket || this.onlineSocket.readyState !== WebSocket.OPEN) {
      this.showToast('Connect to an online Player 1 vs Player 2 or Tag room before asking the audience.', 2800);
      return;
    }
    if (this.getAudiencePollsRemaining() <= 0) {
      this.showToast('You have used all 3 free audience polls for this game.', 2600);
      return;
    }
    if (!this.onlineState || this.onlineState.activePlayerNumber !== this.onlinePlayerNumber) {
      this.showToast('You can use an audience poll during your own turn.', 2200);
      return;
    }

    // The Worker validates the first selected shape, remaining allowance, and poll timing.
    // Only the Worker can start a real poll; this client must never invent votes or percentages.
    this.onlineSocket.send(JSON.stringify({ type: 'audience_poll_start' }));
    this.showToast('Audience poll requested. Spectators have 30 seconds to vote.', 2500);
  }

  // Online poll, modelled on "Ask the Audience": while the audience votes the contestant sees the
  // lettered options and a countdown only; the percentages are revealed when voting closes.
  // Only the team that opened the poll sees it, so the other team never sees the audience's advice.
  // Online sides: in Player 1 vs Player 2 each player is their own side; in Tag, Players 1-2 are Team 1 and
  // Players 3-4 are Team 2. Mirrors sideForPlayer() in worker/src/game-engine.js.
  onlineSideForPlayer(playerNumber) {
    const number = Number(playerNumber);
    const mode = (this.onlineState && this.onlineState.mode) || this.onlineMode || this.mode;
    if (!Number.isInteger(number) || number < 1) return null;
    if (mode === 'tag') return number <= 2 ? 0 : number <= 4 ? 1 : null;
    return number === 1 ? 0 : number === 2 ? 1 : null;
  }

  renderOnlineAudiencePoll(poll) {
    if (!poll || this.gameOver) { this.closeAudiencePoll(); return; }
    const mySide = this.onlineSideForPlayer(this.onlinePlayerNumber);
    const pollSide = this.onlineSideForPlayer(poll.startedByPlayer);
    if (mySide === null || pollSide === null || mySide !== pollSide) { this.closeAudiencePoll(); return; }
    const key = poll.id + ':' + (poll.closed ? 'closed' : 'open');
    if (this.dismissedPollKey === key) return; // the player closed this view; do not pop it up again
    if (this.pollShownKey === key && this.pollUI && this.pollUI.length) return; // nothing new to draw
    this.closeAudiencePoll();
    this.pollShownKey = key;
    this.pollUI = [];
    const add = (object) => {
      object.setDepth(250);
      this.pollUI.push(object);
      return object;
    };
    add(this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x120a05, 0.78)
      .setInteractive());
    add(this.add.rectangle(GAME_WIDTH / 2, 650, 640, 690, 0x4b2d17, 1)
      .setStrokeStyle(5, 0xd5ad72));
    add(this.add.text(GAME_WIDTH / 2, 365, poll.closed ? 'AUDIENCE RESULTS' : 'ASK THE AUDIENCE', {
      fontFamily: FONT, fontSize: '42px', color: '#fff2c7',
      stroke: '#3a2112', strokeThickness: 8, align: 'center', wordWrap: { width: 590 },
    }).setOrigin(0.5));

    const options = Array.isArray(poll.options)
      ? poll.options.filter((option) => option && typeof option.tileId === 'string') : [];
    const counts = options.map((option) => Number((poll.counts || {})[option.tileId]) || 0);
    const totalVotes = counts.reduce((sum, count) => sum + count, 0);
    const best = Math.max(0, ...counts);
    const secondsLeft = () => Math.max(0, Math.ceil(((Number(poll.endsAt) || 0) - Date.now()) / 1000));
    const positionLabel = (option) => 'ROW ' + (Number(option.row) + 1) + ', COLUMN ' + (Number(option.col) + 1);
    const subtitle = () => {
      if (poll.closed) return totalVotes > 0
        ? 'POLL CLOSED · ' + totalVotes + (totalVotes === 1 ? ' VOTE' : ' VOTES')
        : 'NO VOTES WERE CAST';
      const left = secondsLeft();
      return left > 0 ? 'THE AUDIENCE IS VOTING ON THE BOARD · ' + left + 's' : 'COUNTING THE VOTES…';
    };
    const subtitleText = add(this.add.text(GAME_WIDTH / 2, 420, subtitle(), {
      fontFamily: FONT, fontSize: '21px', color: '#ffe36e', align: 'center',
      stroke: '#3a2112', strokeThickness: 4, wordWrap: { width: 570 },
    }).setOrigin(0.5));
    if (!poll.closed) {
      this.pollTimer = this.time.addEvent({
        delay: 250, loop: true,
        callback: () => { if (subtitleText.active) subtitleText.setText(subtitle()); },
      });
      add(this.add.text(GAME_WIDTH / 2, 525,
        'Spectators tap a face-down tile on the live board to vote.', {
        fontFamily: FONT, fontSize: '21px', color: '#fff2c7', align: 'center',
        stroke: '#3a2112', strokeThickness: 4, wordWrap: { width: 540 },
      }).setOrigin(0.5));
    } else if (totalVotes > 0) {
      const leaders = options.filter((option, index) => counts[index] === best);
      const labels = leaders.slice(0, 3).map(positionLabel);
      add(this.add.text(GAME_WIDTH / 2, 500,
        (leaders.length === 1 ? 'TOP BOARD PICK: ' : 'TOP BOARD PICKS: ') + labels.join(' · '), {
        fontFamily: FONT, fontSize: '22px', color: '#ffe36e', align: 'center',
        stroke: '#3a2112', strokeThickness: 4, wordWrap: { width: 560 },
      }).setOrigin(0.5));
      add(this.add.text(GAME_WIDTH / 2, 555,
        'The audience chose from the full board.', {
        fontFamily: FONT, fontSize: '19px', color: '#fff2c7', align: 'center',
        stroke: '#3a2112', strokeThickness: 4, wordWrap: { width: 540 },
      }).setOrigin(0.5));
    } else if (poll.closed) {
      add(this.add.text(GAME_WIDTH / 2, 510, 'No votes were cast this time.', {
        fontFamily: FONT, fontSize: '22px', color: '#fff2c7', align: 'center',
        stroke: '#3a2112', strokeThickness: 4,
      }).setOrigin(0.5));
    }
    woodButton(this, GAME_WIDTH / 2, 885, 420, 82,
      poll.closed ? 'CLOSE RESULTS' : 'HIDE', 30,
      () => { this.dismissedPollKey = key; this.closeAudiencePoll(); }, 252).forEach(add);
  }

  closeAudiencePoll() {
    if (this.pollTimer) { this.pollTimer.remove(false); this.pollTimer = null; }
    if (this.pollUI) this.pollUI.forEach((object) => object.destroy());
    this.pollUI = [];
    this.pollShownKey = null;
  }

  // ------------------------------------------------------------------ fx
  createFx() {
    // slice the destroy sprite sheet into 6 frames and build the animation
    const tex = this.textures.get('tileDestroy');
    DESTROY_FRAME_X.forEach((x, i) => { if (!tex.has('d' + i)) tex.add('d' + i, 0, x, 0, 256, 241); });
    if (!this.anims.exists('tileDestroy')) this.anims.create({
      key: 'tileDestroy',
      frames: DESTROY_FRAME_X.map((_, i) => ({ key: 'tileDestroy', frame: 'd' + i })),
      frameRate: 14,
    });

    // landing dust: equal cells, each puff centred on the cell's middle (see DUST_FRAME_WIDTH)
    const dustTex = this.textures.get('dust');
    for (let i = 0; i < DUST_FRAME_COUNT; i++) {
      if (!dustTex.has('u' + i)) dustTex.add('u' + i, 0, i * DUST_FRAME_WIDTH, 0, DUST_FRAME_WIDTH, DUST_FRAME_HEIGHT);
    }
    if (!this.anims.exists('dustPuff')) this.anims.create({
      key: 'dustPuff',
      frames: Array.from({ length: DUST_FRAME_COUNT }, (_, i) => ({ key: 'dust', frame: 'u' + i })),
      frameRate: DUST_FRAME_RATE,
    });

    // flip sound: a few instances so quick flips can overlap
    if (!this.game.flipSounds) this.game.flipSounds = [0, 1, 2, 3].map(() => this.sound.add('flip', { volume: 0.55 }));
    this.flipSounds = this.game.flipSounds;
    this.flipSoundIndex = 0;
  }

  playFlipSound() {
    this.flipSounds[this.flipSoundIndex++ % this.flipSounds.length].play();
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

    if (this.online) {
      this.tiles = Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(null));
      this.onlineTilesById = new Map();
      this.applyOnlineState(this.onlineState, true);
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

  createOnlineTile(viewTile) {
    const visualShape = viewTile.faceUp && viewTile.shape ? viewTile.shape : 'mystery';
    const tile = this.createTile(visualShape, viewTile.row, viewTile.col,
      this.cellX(viewTile.col), this.cellY(viewTile.row));
    tile.serverId = viewTile.id;
    tile.shape = viewTile.faceUp ? viewTile.shape : null;
    tile.faceUp = Boolean(viewTile.faceUp);
    tile.onlineDesiredFaceUp = Boolean(viewTile.faceUp);
    tile.selected = Boolean(viewTile.selected);
    tile.moving = Boolean(viewTile.moving);
    tile.upSince = 0;
    tile.setTexture('shape_' + visualShape);
    if (tile.selected) this.addRing(tile);
    else this.removeRing(tile);
    return tile;
  }

  attachOnlineSocket() {
    const socket = this.onlineSocket;
    if (!socket) return;
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'game_state' && message.state) {
        this.applyOnlineState(message.state);
      } else if (message.type === 'audience_poll_state') {
        this.onlineAudiencePoll = message.poll || null;
        if (!this.spectator) this.renderOnlineAudiencePoll(message.poll || null);
      } else if (message.type === 'spectator_count') {
        this.onlineSpectatorCount = Number(message.count) || 0;
      } else if (message.type === 'error') {
        if (this.onlineSubmitPending) {
          this.onlineSubmitPending = false;
          if (this.onlineState && Number.isFinite(this.onlineState.turnEndsAt)) {
            this.turnClock.endsAt = this.onlineState.turnEndsAt;
          }
        }
        // The server may begin resolving a pick just before this client's snapshot arrives.
        // If it rejects Submit for that reason, retry only after the authoritative state is idle.
        if (/resolving an action/i.test(message.message || '') &&
            this.onlineState && this.onlineState.status === 'playing' &&
            this.onlineState.activePlayerNumber === this.onlinePlayerNumber &&
            this.queueOnlineSubmit(this.onlineState)) {
          this.showToast('Submit queued until the current move finishes.', 1800);
          return;
        }
        this.showToast(message.message || 'The server rejected that action.', 3000);
      } else if (message.type === 'player_disconnected') {
        this.showToast('A player disconnected. Waiting for them to reconnect.', 3500);
      }
    });
    socket.addEventListener('close', () => {
      this.pendingOnlineSubmitKey = null;
      if (this.onlineSubmitPending) {
        this.onlineSubmitPending = false;
        if (this.onlineState && Number.isFinite(this.onlineState.turnEndsAt)) {
          this.turnClock.endsAt = this.onlineState.turnEndsAt;
        }
      }
      if (this.online && !this.gameOver) this.showToast('Connection lost. Return to the main menu and reconnect.', 4500);
    });
  }

  onlineTurnKey(state) {
    return {
      turnIndex: Number(state.turnIndex),
      activePlayerNumber: Number(state.activePlayerNumber),
      isBonusTurn: Boolean(state.isBonusTurn),
    };
  }

  isSameOnlineTurn(state, key) {
    return Boolean(state && key && state.status === 'playing' &&
      state.activePlayerNumber === this.onlinePlayerNumber &&
      Number(state.turnIndex) === key.turnIndex &&
      Number(state.activePlayerNumber) === key.activePlayerNumber &&
      Boolean(state.isBonusTurn) === key.isBonusTurn);
  }

  queueOnlineSubmit(state = this.onlineState) {
    if (!state || state.status !== 'playing' || state.activePlayerNumber !== this.onlinePlayerNumber) return false;
    this.pendingOnlineSubmitKey = this.onlineTurnKey(state);
    return true;
  }

  processPendingOnlineSubmit(state) {
    const key = this.pendingOnlineSubmitKey;
    if (!key) return;
    if (!this.isSameOnlineTurn(state, key)) {
      this.pendingOnlineSubmitKey = null;
      return;
    }
    if (state.pendingEffect) return;
    this.pendingOnlineSubmitKey = null;
    this.time.delayedCall(0, () => {
      const current = this.onlineState;
      if (!this.gameOver && this.isSameOnlineTurn(current, key)) this.submit(false, false, true);
    });
  }

  sendOnlineAction(action) {
    if (!this.online || !this.onlineSocket || this.onlineSocket.readyState !== WebSocket.OPEN) {
      this.showToast('You are disconnected. Please reconnect to the room.', 3000);
      return false;
    }
    if (this.onlineSubmitPending) {
      this.showToast('Submitting turn…', 1000);
      return false;
    }
    const state = this.onlineState;
    if (!state || state.status !== 'playing') {
      if (state && state.status === 'study') this.showToast('Study the board; turns begin when the reveal ends.', 1800);
      return false;
    }
    if (state.pendingEffect) {
      this.showToast('Resolving that move. Please wait.', 1600);
      return false;
    }
    if (state.activePlayerNumber !== this.onlinePlayerNumber) {
      this.showToast('It is Player ' + state.activePlayerNumber + "'s turn.", 2000);
      return false;
    }
    try {
      this.onlineSocket.send(JSON.stringify({ type: 'game_action', action }));
      return true;
    } catch (_) {
      this.showToast('Could not send the action. Please reconnect.', 3000);
      return false;
    }
  }

  applyOnlineState(state, initial = false) {
    if (!this.online || !state) return;
    // The server snapshot contains the canonical owner and deadline for the new turn.
    this.onlineSubmitPending = false;
    const oldInventorySignature = this.onlineInventorySignature || '';
    const previousOnlineStars = this.onlineState && this.onlineState.me &&
      Number.isFinite(Number(this.onlineState.me.stars))
      ? Number(this.onlineState.me.stars) : null;
    const previousOnlineState = this.onlineState;
    this.onlineState = state;
    this.scores = Array.isArray(state.scores) ? state.scores.slice() : [0, 0];
    this.activePlayer = Number.isInteger(state.activeSide) ? state.activeSide : 0;
    this.turnNumber = Number.isInteger(state.turnIndex) ? state.turnIndex : 0;
    this.activeMember = this.modeCfg.teams ? Math.floor(this.turnNumber / 2) % 2 : 0;
    this.isBonusTurn = Boolean(state.isBonusTurn);
    this.doublePlayPendingPlayer = state.doublePlayPendingPlayer ?? null;
    this.turnClock.endsAt = Number.isFinite(state.turnEndsAt) ? state.turnEndsAt : Infinity;
    this.currentTurnDurationMs = state.status === 'study'
      ? this.turnDurationMs
      : Math.max(this.turnDurationMs, Number.isFinite(state.turnEndsAt) ? state.turnEndsAt - Date.now() : this.turnDurationMs);
    this.updateActivePlayerUI();
    this.p1Score.setText(String(this.scores[0] || 0));
    this.p2Score.setText(String(this.scores[1] || 0));
    if (this.modeCfg.teams && this.goalText && this.goalText.active) {
      this.goalText.setText(this.turnLabel().toUpperCase());
    }

    if (state.me) {
      const nextOnlineStars = Math.max(0, Number(state.me.stars) || 0);
      const starReward = previousOnlineStars == null ? 0 : nextOnlineStars - previousOnlineStars;
      this.starBalance = nextOnlineStars;
      this.inventoryItems = { ...(state.me.inventory || {}) };
      this.onlineInventorySignature = JSON.stringify({ stars: this.starBalance, inventory: this.inventoryItems });
      this.updateStarDisplays();
      if (starReward > 0) {
        const streak = Math.max(3, Number(state.me.streak) || 3);
        this.showToast(streak + '-match streak! +' + starReward + ' Stars', 3200);
      }
    }

    const previous = this.onlineTilesById || new Map();
    const canAnimateOnlineCascade = Boolean(!initial && previousOnlineState &&
      previousOnlineState.status === 'playing' && state.status === 'playing' &&
      Array.isArray(previousOnlineState.tiles) && Array.isArray(state.tiles));
    const newCountByColumn = new Map();
    if (canAnimateOnlineCascade) {
      for (const viewTile of (state.tiles || [])) {
        if (!previous.has(viewTile.id) && !viewTile.moving && Number.isInteger(viewTile.col)) {
          newCountByColumn.set(viewTile.col, (newCountByColumn.get(viewTile.col) || 0) + 1);
        }
      }
    }
    const nextById = new Map();
    const nextGrid = Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(null));
    for (const viewTile of (state.tiles || [])) {
      let tile = previous.get(viewTile.id);
      const targetX = this.cellX(viewTile.col);
      const targetY = this.cellY(viewTile.row);
      if (!tile || !tile.active) {
        tile = this.createOnlineTile(viewTile);
        const spawnCount = newCountByColumn.get(viewTile.col) || 0;
        if (canAnimateOnlineCascade && spawnCount > 0 && !viewTile.moving) {
          // Match the local game: new tiles fall in from above the board and puff dust on landing.
          tile.setPosition(targetX, this.cellY(viewTile.row - spawnCount));
          const targetRow = viewTile.row;
          tile.onlineCascadeTargetRow = targetRow;
          this.fall(tile, targetY, 40 * Math.max(0, spawnCount - 1 - viewTile.row), true).then(() => {
            if (tile.active && tile.onlineCascadeTargetRow === targetRow) delete tile.onlineCascadeTargetRow;
          });
        }
        if (viewTile.moving) {
          this.addShuffleOutline(tile);
          tile.shuffleBaseDepth = tile.depth;
          tile.setDepth(11);
        }
      } else {
        if (viewTile.moving) {
          this.addShuffleOutline(tile);
          if (tile.shuffleBaseDepth == null) {
            tile.shuffleBaseDepth = tile.depth;
            tile.setDepth(11);
          }
        } else {
          this.removeShuffleOutline(tile);
        }
        const stillFallingToSameRow = !viewTile.moving && tile.onlineCascadeTargetRow === viewTile.row;
        if ((Math.abs(tile.x - targetX) > 0.5 || Math.abs(tile.y - targetY) > 0.5) && !stillFallingToSameRow) {
          const cascadeFall = canAnimateOnlineCascade && !viewTile.moving &&
            (newCountByColumn.get(viewTile.col) || 0) > 0 &&
            Math.abs(tile.x - targetX) <= 0.5 && targetY > tile.y + 0.5;
          delete tile.onlineCascadeTargetRow;
          this.tweens.killTweensOf(tile);
          if (tile.shuffleOutline) this.tweens.killTweensOf(tile.shuffleOutline);
          if (cascadeFall) {
            // Existing tiles in a refilled column drop with the same bounce as the local cascade.
            const targetRow = viewTile.row;
            tile.onlineCascadeTargetRow = targetRow;
            this.fall(tile, targetY, 0, false).then(() => {
              if (tile.active && tile.onlineCascadeTargetRow === targetRow) delete tile.onlineCascadeTargetRow;
            });
          } else {
            const moveDuration = viewTile.moving && Number.isFinite(viewTile.movingUntil)
              ? Math.max(0, viewTile.movingUntil - Date.now())
              : (initial ? 0 : 240);
            const movingTargets = tile.shuffleOutline ? [tile, tile.shuffleOutline] : [tile];
            this.tweens.add({ targets: movingTargets, x: targetX, y: targetY, duration: moveDuration, ease: 'Sine.easeInOut' });
            if (tile.ring) {
              this.tweens.killTweensOf(tile.ring);
              this.tweens.add({ targets: tile.ring, x: targetX, y: targetY, duration: moveDuration, ease: 'Sine.easeInOut' });
            }
          }
        }
        tile.row = viewTile.row;
        tile.col = viewTile.col;
        if (viewTile.faceUp && viewTile.shape) {
          tile.shape = viewTile.shape;
          if (tile.onlineDesiredFaceUp !== true) {
            tile.onlineDesiredFaceUp = true;
            this.flipTile(tile, true);
          } else if (tile.faceUp) {
            tile.setTexture('shape_' + viewTile.shape);
          }
        } else {
          if (tile.onlineDesiredFaceUp !== false) {
            tile.onlineDesiredFaceUp = false;
            this.flipTile(tile, false);
            tile.shape = null;
          } else if (!tile.faceUp) {
            tile.shape = null;
            tile.setTexture('shape_mystery');
          }
        }
        tile.selected = Boolean(viewTile.selected);
        tile.moving = Boolean(viewTile.moving);
        if (tile.selected) {
          if (!tile.ring) this.addRing(tile);
        } else {
          this.removeRing(tile);
        }
      }
      tile.serverId = viewTile.id;
      tile.moving = Boolean(viewTile.moving);
      nextById.set(viewTile.id, tile);
      if (nextGrid[viewTile.row]) nextGrid[viewTile.row][viewTile.col] = tile;
    }
    for (const [id, oldTile] of previous.entries()) {
      if (nextById.has(id)) continue;
      this.removeRing(oldTile);
      this.removeShuffleOutline(oldTile);
      if (oldTile.active) oldTile.destroy();
    }
    this.tiles = nextGrid;
    this.onlineTilesById = nextById;

    if (this.inventoryOpen && oldInventorySignature &&
        oldInventorySignature !== (this.onlineInventorySignature || '')) {
      this.renderInventory();
    }
    if (this.memes) this.memes.onlineState(previousOnlineState, state); // win / lose commentary from the server's turn changes
    if (state.status === 'finished' && !this.gameOver) {
      this.activePlayer = Number.isInteger(state.winnerSide) ? state.winnerSide : this.activePlayer;
      this.endGame('First to ' + state.targetScore + ' points wins.');
    }
    this.processPendingOnlineSubmit(state);
  }

  // Draw the same cyan square used by local shuffle animation around server-moved tiles.
  addShuffleOutline(tile) {
    if (!tile || !tile.active || tile.shuffleOutline) return;
    const outline = this.add.graphics({ x: tile.x, y: tile.y }).setDepth(14);
    outline.lineStyle(5, 0x66e0ff, 1);
    outline.strokeRect(-TILE_SIZE / 2 - 2, -TILE_SIZE / 2 - 2, TILE_SIZE + 4, TILE_SIZE + 4);
    tile.shuffleOutline = outline;
  }

  removeShuffleOutline(tile) {
    if (!tile) return;
    if (tile.shuffleOutline) {
      this.tweens.killTweensOf(tile.shuffleOutline);
      tile.shuffleOutline.destroy();
      tile.shuffleOutline = null;
    }
    if (tile.shuffleBaseDepth != null) {
      tile.setDepth(tile.shuffleBaseDepth);
      delete tile.shuffleBaseDepth;
    }
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

  // Starts the "memorize" countdown for a batch of tiles. It runs on its own deadline, at the same time
  // as the turn clock, and is not affected by whose turn it is. Spawned tiles (shuffle = true) are
  // shuffled once they are face-down; the opening board is not.
  startReview(batch, ms = SPAWN_REVEAL_MS, shuffle = true) {
    this.reveals.add(batch, ms, shuffle);
  }

  // Once a batch's reveal time is over, flip its tiles to mystery one after the other, then shuffle them.
  // Tiles the player is currently using stay face-up.
  hideFinishedReveals() {
    for (const batch of this.reveals.takeDue()) {
      batch.tiles.forEach((tile, i) => {
        if (tile.active && !tile.selected) this.flipTile(tile, false, i * 35);
      });
      if (batch.shuffle) {
        const token = this.shuffleToken;
        Promise.all(batch.tiles.map((t) => t.flipChain)).then(() => {
          if (token === this.shuffleToken) this.runShuffle(batch.tiles, token);
        });
      }
    }
  }

  // Safety net: a tile may only be face-up while it is picked, being revealed (opening study / new tiles), mid-swap,
  // or briefly shown by a dummy/hazard tap. Anything else that has been face-up for STUCK_UP_MS is flipped back down,
  // so a mismatch can never leave shapes showing, whatever the cause.
  healStuckTiles() {
    const now = this.time.now;
    for (const row of this.tiles) {
      for (const tile of row) {
        if (!tile || !tile.active || !tile.faceUp || tile.selected || tile.swapping) continue;
        if (!tile.upSince || now - tile.upSince < STUCK_UP_MS) continue;
        if (this.reveals.batches.some((b) => b.tiles.includes(tile))) continue;
        this.flipTile(tile, false);
      }
    }
  }

  // ------------------------------------------------------------- shuffle
  // A tile can take part in a swap when it is on the board and not picked by the player.
  canShuffle(tile) {
    return tile.active && !tile.selected && !tile.swapping;
  }

  // Performs the planned swaps of a batch strictly one after another, SHUFFLE_STEP_MS each.
  // The rest of the board stays playable; only the two tiles in motion can't be tapped.
  async runShuffle(tiles, token) {
    this.shuffling++;
    try {
      for (const [i, j] of planShuffle(tiles.length).steps) {
        if (token !== this.shuffleToken) break;
        const a = tiles[i];
        const b = tiles[j];
        if (this.canShuffle(a) && this.canShuffle(b)) await this.swapTiles(a, b);
      }
    } finally {
      this.shuffling--;
    }
  }

  // Stops all shuffling (a match is being resolved and the board is about to change).
  // A swap in progress snaps to its end position so the board is consistent.
  cancelShuffles() {
    this.shuffleToken++;
    this.reveals.cancelShuffles();
    if (this.activeSwap) this.activeSwap.finishNow();
  }

  // Swaps two tiles' places over SHUFFLE_STEP_MS. The tiles bow in opposite directions so they pass each
  // other, and a square stroke follows each of them.
  swapTiles(a, b) {
    return new Promise((resolve) => {
      // Start and end points are the tiles' grid cells, so a swap always lands exactly on the grid.
      const ax = this.cellX(a.col), ay = this.cellY(a.row);
      const bx = this.cellX(b.col), by = this.cellY(b.row);
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const px = -(by - ay) / len;
      const py = (bx - ax) / len;

      // Watching tiles trade places confuses the AI: it may forget what it knew about them.
      if (this.modeCfg.ai) [a, b].forEach((t) => this.aiPlayer.forgetSwapped(t));

      // Board data changes first, so the grid always says where each tile belongs.
      const [aRow, aCol, bRow, bCol] = [a.row, a.col, b.row, b.col];
      this.tiles[bRow][bCol] = a;
      this.tiles[aRow][aCol] = b;
      a.row = bRow; a.col = bCol;
      b.row = aRow; b.col = aCol;

      const makeBox = (tile) => {
        const box = this.add.graphics({ x: tile.x, y: tile.y }).setDepth(14);
        box.lineStyle(5, 0x66e0ff, 1);
        box.strokeRect(-TILE_SIZE / 2 - 2, -TILE_SIZE / 2 - 2, TILE_SIZE + 4, TILE_SIZE + 4);
        return box;
      };
      a.swapping = b.swapping = true;
      const boxA = makeBox(a);
      const boxB = makeBox(b);
      const prevDepth = [a.depth, b.depth];
      a.setDepth(11); b.setDepth(11);

      const place = (t) => {
        const bow = t >= 1 ? 0 : Math.sin(Math.PI * t) * SHUFFLE_ARC_PX; // exact landing on the grid
        a.x = ax + (bx - ax) * t + px * bow; a.y = ay + (by - ay) * t + py * bow;
        b.x = bx + (ax - bx) * t - px * bow; b.y = by + (ay - by) * t - py * bow;
        boxA.x = a.x; boxA.y = a.y; boxB.x = b.x; boxB.y = b.y;
      };
      const state = { t: 0 };
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        place(1);
        boxA.destroy(); boxB.destroy();
        a.swapping = b.swapping = false;
        a.setDepth(prevDepth[0]); b.setDepth(prevDepth[1]);
        if (this.activeSwap && this.activeSwap.tween === tween) this.activeSwap = null;
        resolve();
      };
      const tween = this.tweens.add({
        targets: state, t: 1, duration: SHUFFLE_STEP_MS, ease: 'Sine.easeInOut',
        onUpdate: () => place(state.t), onComplete: finish,
      });
      this.activeSwap = { tween, finishNow: () => { tween.stop(); finish(); } };
    });
  }

  // -------------------------------------------------------------- picking
  addRing(tile) {
    tile.ring = this.add.graphics({ x: tile.x, y: tile.y }).setDepth(12);
    const scale = TILE_SIZE / BASE_TILE_SIZE;
    const ringSize = TILE_SIZE - 4 * scale;
    tile.ring.lineStyle(5 * scale, 0xffe066, 1);
    tile.ring.strokeRoundedRect(-ringSize / 2, -ringSize / 2, ringSize, ringSize, 14 * scale);
  }

  removeRing(tile) {
    if (tile.ring) { tile.ring.destroy(); tile.ring = null; }
  }

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

    // Hazard is a bomb in every mode: destroy it and every shape already picked.
    // Only Play Alone loses one point; versus modes never lose points from Hazard.
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
  }

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
  }

  // Hazards always detonate, destroying the bomb and all shapes/Dummies currently picked.
  // Play Alone loses one point per explosion; versus modes receive no Hazard penalty.
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
    const lost = this.modeCfg.twoPlayers ? 0 : this.applyPenalty(HAZARD_BLAST_PENALTY);
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
  }

  // Legacy internal alias retained for any existing callback: a standalone Hazard also detonates.
  async hazardHit(tile) {
    return this.hazardBlast(tile);
  }

  // Play alone: a wrong shape costs a point (a too-small submit is free). (Two-player modes keep failed attempts free.)
  penalizeMiss() {
    if (!this.modeCfg.twoPlayers) this.applyPenalty(ALONE_MISS_PENALTY);
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  // Attempts in Play Alone are shown for statistics only; there is no checkpoint or attempt limit.
  recordAttempt() {
    if (this.modeCfg.twoPlayers || this.gameOver) return;
    this.totalAttempts++;
    this.updateAloneHUD();
    if (RULES.hasReachedScoreFloor(this.scores[0], ALONE_SCORE_FLOOR)) {
      this.endGame('Your score reached ' + ALONE_SCORE_FLOOR + '.');
    }
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

  // Burn the matched tiles away with the destroy animation.
  async destroyTiles(tiles) {
    const step = Math.min(70, 600 / tiles.length);
    await Promise.all(
      tiles.map(async (tile, i) => {
        await this.sleep(i * step);
        this.tiles[tile.row][tile.col] = null;
        const fx = this.add.sprite(tile.x, tile.y, 'tileDestroy', 'd0').setDepth(13);
        fx.setScale(TILE_SIZE / 241); // constraint size: frame height = 90px (frame is 241px tall)
        this.removeRing(tile);
        tile.destroy();
        fx.play('tileDestroy');
        await new Promise((resolve) => fx.once('animationcomplete', resolve));
        fx.destroy();
      })
    );
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

  // Drops a tile to targetY. With `dust`, a dust puff plays the moment it first lands.
  fall(tile, targetY, delay, dust = false) {
    const distance = Math.abs(targetY - tile.y) / TILE_PITCH;
    const duration = 260 + distance * 90;
    if (dust) {
      // Bounce.easeOut first touches the ground at 1 / 2.75 of the duration
      this.time.delayedCall(delay + duration / 2.75, () => this.spawnDust(tile.x, targetY));
    }
    return this.tweenAsync({ targets: tile, y: targetY, delay, duration, ease: 'Bounce.easeOut' });
  }

  // Dust cloud at the bottom edge of a tile that just landed.
  spawnDust(x, tileY) {
    const puff = this.add.sprite(x, tileY + TILE_SIZE / 2, 'dust', 'u0').setOrigin(0.5, 1).setDepth(13);
    // Scale landing dust with the tile, just like the tile-destruction animation.
    puff.setScale(DUST_SCALE * (TILE_SIZE / BASE_TILE_SIZE));
    puff.play('dustPuff');
    puff.once('animationcomplete', () => puff.destroy());
  }

  // New tile: a hazard (per-mode chance), occasionally a blank wooden dummy, otherwise the next shape
  // from the shuffle bag (see ShapeBag) so spawns stay varied.
  pickShape(counts) {
    if (Math.random() < this.hazardChance) return 'hazard';
    if (Math.random() < DUMMY_SPAWN_CHANCE) return 'dummy';
    return this.shapeBag.next(SHAPE_KEYS.filter((k) => (counts[k] || 0) < MIN_MATCH));
  }

  // ------------------------------------------------------------------ AI (Easy / Professional)
  // The AI only knows what it has seen: the opening board, new tiles while they are face-up, and every
  // tile that gets flipped. What it keeps and what it reaches for live in src/ai.js (AIPlayer, tested in
  // tests/ai.test.mjs); this scene only owns the turn loop below (runAITurn / aiTap / aiAttempt) and
  // records what the AI gets to see through this thin adapter.
  aiSee(tile, certain = false) {
    if (!this.modeCfg.ai || !tile.active) return;
    this.aiPlayer.see(tile, certain);
  }

  async aiIdle(alive) {
    while (this.busy && alive()) await this.sleep(100);
  }

  // One visible tap after a human-like pause.
  async aiTap(tile, alive) {
    await this.sleep(this.ai.tapMs[0] + Math.random() * (this.ai.tapMs[1] - this.ai.tapMs[0]));
    await this.aiIdle(alive);
    if (!alive()) return false;
    this.onTileTap(tile, true);
    await this.sleep(250);
    await this.aiIdle(alive); // a wrong tap resets the attempt before the AI carries on
    return alive();
  }

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
  }

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
  }
}
