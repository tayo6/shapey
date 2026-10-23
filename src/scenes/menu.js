// Shapey - MenuScene: the mode picker, board-size and difficulty pickers, the online
// lobby (create/join room against the multiplayer Worker) and the audience directory.


// Mode picker, shown before the game starts.

import { GAME_WIDTH, GAME_HEIGHT, FONT, BOARD_SIZES, normalizeBoardSize, BASE_BOARD_SIZE, AI_LEVELS } from '../constants.js';
import { MULTIPLAYER_API, STAGING, MODE_TARGET_SCORE, MODES } from '../config.js';
import { JOIN_MODAL_CSS, woodButton } from '../ui.js';

export class MenuScene extends Phaser.Scene {
  constructor() {
    super('MenuScene');
  }

  create() {
    this.add.image(0, 0, 'bg').setOrigin(0, 0).setDisplaySize(GAME_WIDTH, GAME_HEIGHT);
    const logo = this.add.image(GAME_WIDTH / 2, 150, 'logo');
    logo.setScale(560 / logo.width);

    // a little row of tiles for decoration
    ['star', 'circle', 'hazard', 'sphere', 'cross'].forEach((key, i) => {
      const tile = this.add.image(104 + i * 128, 352, 'shape_' + key).setDisplaySize(104, 104)
        .setAngle([-6, 4, -3, 6, -5][i]);
      this.tweens.add({ targets: tile, y: tile.y - 10, duration: 1100 + i * 140, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    });

    this.add.text(GAME_WIDTH / 2, 470, 'CHOOSE A MODE', {
      fontFamily: FONT, fontSize: '38px', color: '#ffe36e', stroke: '#3a2412', strokeThickness: 7,
    }).setOrigin(0.5);

    // Four modes: 140px buttons every 165px. Player vs AI first asks for a difficulty.
    this.pickerUI = [];
    Object.entries(MODES).forEach(([mode, cfg], i) => {
      woodButton(this, GAME_WIDTH / 2, 600 + i * 165, 620, 140, cfg.label, 42,
        () => this.openBoardSize(mode), 10, cfg.hint);
    });

    // Spectating is deliberately separated from playable modes: it is a darker, secondary panel (the same brown fill
    // and gold border the game's popups use) instead of the bright wood of the four playable modes.
    const audienceButton = woodButton(this, GAME_WIDTH / 2, 1228, 620, 76, 'WATCH LIVE GAMES', 32,
      () => this.openAudienceDirectory(), 10, 'SPECTATOR AREA · WATCH ONLY · NO GAME MOVES');
    audienceButton[0].setFillStyle(0x4b2d17, 1).setStrokeStyle(4, 0xd5ad72);
    audienceButton[1].setColor('#fff2c7');
  }

  // The board-size choices are 5×5, 6×6 and 7×7; 7×7 remains the default and Tag is fixed at 7×7.
  openBoardSize(mode) {
    if (this.pickerUI.length) return;
    // Tag is intentionally fixed at 7×7; only the other three modes offer smaller boards.
    if (mode === 'tag') {
      this.openOnlineLobby('tag', BASE_BOARD_SIZE);
      return;
    }
    const add = (object) => { this.pickerUI.push(object); return object; };
    add(this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x120a05, 0.82)
      .setDepth(50).setInteractive());
    add(this.add.rectangle(GAME_WIDTH / 2, 675, 640, 820, 0x4b2d17, 1)
      .setStrokeStyle(5, 0xd5ad72).setDepth(51));
    add(this.add.text(GAME_WIDTH / 2, 365, 'CHOOSE BOARD SIZE', {
      fontFamily: FONT, fontSize: '44px', color: '#fff2c7', stroke: '#3a2412', strokeThickness: 8,
    }).setOrigin(0.5).setDepth(52));
    add(this.add.text(GAME_WIDTH / 2, 430, (STAGING ? 'Staging test · ' : '') + 'choose the number of rows and columns', {
      fontFamily: FONT, fontSize: '20px', color: '#fff2c7', align: 'center',
      wordWrap: { width: 540 }, stroke: '#3a2412', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(52));
    BOARD_SIZES.forEach((size, index) => {
      woodButton(this, GAME_WIDTH / 2, 555 + index * 145, 520, 112, size + ' × ' + size, 42,
        () => {
          this.closeBoardSize();
          if (mode === 'ai') this.openDifficulty(size);
          else if (mode === 'pvp' || mode === 'tag') this.openOnlineLobby(mode, size);
          else this.scene.start('GameScene', { mode, boardSize: size });
        }, 52, (size * size) + ' tiles on the board').forEach(add);
    });
    woodButton(this, GAME_WIDTH / 2, 1030, 520, 82, 'BACK', 34,
      () => this.closeBoardSize(), 52).forEach(add);
  }

  closeBoardSize() {
    this.pickerUI.forEach((object) => object.destroy());
    this.pickerUI = [];
  }

  // Room creation and joining are attached to Player 1 vs Player 2 and Tag.
  openOnlineLobby(mode, boardSize = BASE_BOARD_SIZE) {
    if (this.onlineUI && this.onlineUI.length) return;
    this.onlineMode = mode || 'pvp';
    this.onlineBoardSize = this.onlineMode === 'tag' ? BASE_BOARD_SIZE : normalizeBoardSize(boardSize);
    this.onlineUI = [];
    const add = (object) => { this.onlineUI.push(object); return object; };
    const modeTitle = (this.onlineMode === 'tag' ? 'ONLINE TAG · 2 VS 2' : 'ONLINE PLAYER 1 VS PLAYER 2') +
      ' · ' + this.onlineBoardSize + '×' + this.onlineBoardSize;
    add(this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x120a05, 0.86)
      .setDepth(80).setInteractive());
    add(this.add.rectangle(GAME_WIDTH / 2, 650, 650, 820, 0x4b2d17, 1)
      .setStrokeStyle(5, 0xd5ad72).setDepth(81));
    add(this.add.text(GAME_WIDTH / 2, 330, modeTitle, {
      fontFamily: FONT, fontSize: this.onlineMode === 'tag' ? '35px' : '33px',
      color: '#fff2c7', stroke: '#3a2412', strokeThickness: 8, align: 'center',
      wordWrap: { width: 590 },
    }).setOrigin(0.5).setDepth(82));
    const lobbyInstructions = this.onlineMode === 'tag'
      ? 'Four devices. Team 1: Players 1 and 2. Team 2: Players 3 and 4. Invite your teammate first, then invite the other team.'
      : 'Two devices. Take alternating turns; the first player to ' + MODE_TARGET_SCORE.pvp + ' points wins.';
    const sizeInstruction = 'Board size: ' + this.onlineBoardSize + '×' + this.onlineBoardSize + '.';
    this.onlineStatus = add(this.add.text(GAME_WIDTH / 2, 415,
      lobbyInstructions + '\n' + sizeInstruction, {
        fontFamily: FONT, fontSize: '23px', color: '#fff2c7', align: 'center',
        wordWrap: { width: 560 }, stroke: '#3a2412', strokeThickness: 4,
      }).setOrigin(0.5).setDepth(82));
    this.onlineRoomCodeText = add(this.add.text(GAME_WIDTH / 2, 520, '', {
      fontFamily: FONT, fontSize: '54px', color: '#ffe36e', align: 'center',
      stroke: '#3a2412', strokeThickness: 8, letterSpacing: 8,
    }).setOrigin(0.5).setDepth(83));

    this.onlineCreateUI = woodButton(this, GAME_WIDTH / 2, 710, 530, 88, 'CREATE ROOM', 36,
      () => this.createOnlineRoom(), 82, 'Generate a shareable room code');
    this.onlineCreateUI.forEach(add);
    this.onlineJoinUI = woodButton(this, GAME_WIDTH / 2, 810, 530, 88, 'JOIN ROOM', 36,
      () => this.promptJoinRoom(), 82, 'Enter a friend’s room code');
    this.onlineJoinUI.forEach(add);
    this.onlineBackUI = woodButton(this, GAME_WIDTH / 2, 925, 530, 72, 'BACK', 32,
      () => this.closeOnlineLobby(), 82);
    this.onlineBackUI.forEach(add);
  }

  setOnlineStatus(message) {
    if (this.onlineStatus && this.onlineStatus.active) this.onlineStatus.setText(message);
  }

  showOnlineRoomCode(code) {
    this.currentRoomCode = code;
    if (this.onlineRoomCodeText && this.onlineRoomCodeText.active) this.onlineRoomCodeText.setText(code);
    for (const object of [...(this.onlineCreateUI || []), ...(this.onlineJoinUI || [])]) {
      object.setVisible(false);
      if (object.disableInteractive) object.disableInteractive();
    }
    if (!this.onlineCopyUI || !this.onlineCopyUI.length) {
      this.onlineCopyUI = woodButton(this, GAME_WIDTH / 2, 600, 390, 68, 'COPY ROOM CODE', 28,
        () => this.copyOnlineRoomCode(), 84);
      this.onlineCopyUI.forEach((object) => this.onlineUI.push(object));
      this.onlineCopyLabel = this.onlineCopyUI[1];
    }
    if (!this.onlineWatchUI || !this.onlineWatchUI.length) {
      this.onlineWatchUI = woodButton(this, GAME_WIDTH / 2, 690, 390, 68, 'WATCH LIVE', 28,
        () => this.openAudienceWatch(), 84);
      this.onlineWatchUI.forEach((object) => this.onlineUI.push(object));
      this.onlineCopyWatchUI = woodButton(this, GAME_WIDTH / 2, 775, 390, 68, 'COPY WATCH LINK', 27,
        () => this.copyAudienceWatchLink(), 84);
      this.onlineCopyWatchUI.forEach((object) => this.onlineUI.push(object));
    }
  }

  // Opens the public room directory in this tab; the directory has its own way back to the game.
  openAudienceDirectory() {
    window.location.assign(new URL('staging/audience.html', document.baseURI).href);
  }

  audienceWatchUrl() {
    if (!this.currentRoomCode) return null;
    const url = new URL('staging/audience.html', document.baseURI);
    url.searchParams.set('room', this.currentRoomCode);
    url.searchParams.set('mode', this.onlineMode || this.mode || 'tag');
    return url.href;
  }

  openAudienceWatch() {
    const url = this.audienceWatchUrl();
    if (!url) {
      this.setOnlineStatus('Create or join a room first.');
      return;
    }
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (!opened) this.setOnlineStatus('The watch page was blocked. Use COPY WATCH LINK to share it.');
  }

  async copyAudienceWatchLink() {
    const url = this.audienceWatchUrl();
    if (!url) {
      this.setOnlineStatus('Create or join a room first.');
      return;
    }
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
        copied = true;
      }
    } catch {}
    if (!copied) {
      let field;
      try {
        field = document.createElement('textarea');
        field.value = url;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.left = '-9999px';
        document.body.appendChild(field);
        field.select();
        copied = document.execCommand('copy');
      } catch {}
      if (field && field.parentNode) field.parentNode.removeChild(field);
    }
    if (copied) {
      if (this.onlineCopyWatchUI && this.onlineCopyWatchUI[1]?.active) this.onlineCopyWatchUI[1].setText('LINK COPIED!');
      this.setOnlineStatus('Watch link copied. Share it with your audience.');
    } else {
      this.setOnlineStatus('Copy failed. Share this link manually: ' + url);
    }
  }

  async copyOnlineRoomCode() {
    const code = this.currentRoomCode;
    if (!code) {
      this.setOnlineStatus('Create or join a room first.');
      return;
    }
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(code);
        copied = true;
      }
    } catch {}
    if (!copied) {
      let field;
      try {
        field = document.createElement('textarea');
        field.value = code;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.left = '-9999px';
        document.body.appendChild(field);
        field.select();
        copied = document.execCommand('copy');
      } catch {}
      if (field && field.parentNode) field.parentNode.removeChild(field);
    }
    if (copied) {
      if (this.onlineCopyLabel && this.onlineCopyLabel.active) this.onlineCopyLabel.setText('COPIED!');
      this.setOnlineStatus('Room code copied. Send ' + code + ' to your friend.');
    } else {
      this.setOnlineStatus('Copy failed. Please select and copy the room code: ' + code);
    }
  }

  async ensureGameplayService() {
    const response = await fetch(MULTIPLAYER_API + '/health');
    let status;
    try { status = await response.json(); } catch {}
    if (!response.ok || !status || status.stage !== 'authoritative-gameplay-v1' || status.protocolVersion !== 1) {
      throw new Error('Online gameplay is not enabled on the live server yet. Please try again later; no room was created.');
    }
    return status;
  }

  async createOnlineRoom() {
    this.setOnlineStatus('Checking multiplayer service...');
    try {
      await this.ensureGameplayService();
      this.setOnlineStatus('Creating your room...');
      const response = await fetch(MULTIPLAYER_API + '/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: this.onlineMode, boardSize: this.onlineBoardSize || 7 }),
      });
      const data = await response.json();
      if (!response.ok || !data.roomCode) throw new Error(data.error || 'Room creation failed.');
      this.showOnlineRoomCode(data.roomCode);
      this.connectOnlineRoom(data.roomCode, data.websocketUrl, this.onlineMode);
    } catch (error) {
      this.setOnlineStatus(error.message || 'Could not create a room. Check your connection and try again.');
      console.error('Shapey room creation failed:', error);
    }
  }

  // Room-code entry that looks like the rest of the menu (wood panel, gold border, Happy School text, wooden buttons)
  // instead of the browser's own prompt box. Resolves with the code on JOIN / Enter, or null on CANCEL / Escape.
  askRoomCode() {
    return new Promise((resolve) => {
      if (document.getElementById('shapey-join-modal')) { resolve(null); return; }
      if (!document.getElementById('shapey-join-style')) {
        const style = document.createElement('style');
        style.id = 'shapey-join-style';
        style.textContent = JOIN_MODAL_CSS;
        document.head.appendChild(style);
      }
      const make = (tag, props, parent) => {
        const node = document.createElement(tag);
        Object.assign(node, props);
        if (parent) parent.appendChild(node);
        return node;
      };
      const overlay = make('div', { id: 'shapey-join-modal' });
      // Prevent the dialog's pointer/click events from reaching the Phaser game underneath.
      // In particular, clicking JOIN must not activate a game button behind this overlay.
      for (const eventName of [
        'pointerdown', 'pointerup', 'pointermove',
        'mousedown', 'mouseup', 'click', 'touchstart', 'touchend'
      ]) {
        overlay.addEventListener(eventName, (event) => event.stopPropagation());
      }
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'shapey-join-title');
      const panel = make('div', { className: 'panel' }, overlay);
      make('h2', { id: 'shapey-join-title', textContent: 'ENTER ROOM CODE' }, panel);
      make('p', { textContent: 'Ask your friend for their room code.' }, panel);
      const input = make('input', { type: 'text', autocomplete: 'off', spellcheck: false }, panel);
      input.setAttribute('aria-label', 'Room code');
      input.setAttribute('autocapitalize', 'characters');
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('enterkeyhint', 'go');
      const error = make('div', { className: 'err' }, panel);
      error.setAttribute('role', 'alert');
      const row = make('div', { className: 'row' }, panel);
      const cancel = make('button', { type: 'button', textContent: 'CANCEL' }, row);
      const join = make('button', { type: 'button', textContent: 'JOIN' }, row);

      const onKey = (event) => {
        if (event.key === 'Escape') { event.preventDefault(); close(null); }
        else if (event.key === 'Enter' && event.target === input) { event.preventDefault(); submit(); }
      };
      const close = (value) => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(value);
      };
      const submit = () => {
        const code = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!/^[A-Z0-9]{6}$/.test(code)) {
          error.textContent = 'Room codes have 6 letters or numbers.';
          input.focus();
          return;
        }
        close(code);
      };
      input.addEventListener('input', () => { error.textContent = ''; });
      cancel.addEventListener('click', () => close(null));
      join.addEventListener('click', submit);
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
      input.focus();
    });
  }

  async promptJoinRoom() {
    const entered = await this.askRoomCode();
    if (entered == null) return;
    const code = entered.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      this.setOnlineStatus('That code is not valid. Room codes have 6 letters or numbers.');
      return;
    }
    this.setOnlineStatus('Checking multiplayer service...');
    try {
      await this.ensureGameplayService();
      this.setOnlineStatus('Checking room code...');
      const response = await fetch(MULTIPLAYER_API + '/api/rooms/' + code);
      const room = await response.json();
      if (!response.ok) throw new Error(room.error || 'Room not found.');
      if (room.mode !== this.onlineMode) {
        this.setOnlineStatus('That code is for ' +
          (room.mode === 'tag' ? 'Tag (2 vs 2)' : 'Player 1 vs Player 2') +
          '. Go back and select that mode to join.');
        return;
      }
      // A room's server-selected size is authoritative for every device that joins it.
      this.onlineBoardSize = this.onlineMode === 'tag' ? BASE_BOARD_SIZE : normalizeBoardSize(room.boardSize);
      this.showOnlineRoomCode(code);
      this.connectOnlineRoom(code,
        MULTIPLAYER_API.replace(/^http/, 'ws') + '/ws/' + code, this.onlineMode);
    } catch (error) {
      this.setOnlineStatus(error.message || 'Could not find that room. Check the code and try again.');
    }
  }

  connectOnlineRoom(code, websocketUrl, mode) {
    if (this.onlineSocket) {
      try { this.onlineSocket.close(); } catch {}
    }
    const modeLabel = mode === 'tag' ? 'Tag · 2 vs 2' : 'Player 1 vs Player 2';
    this.setOnlineStatus('Connecting to ' + modeLabel + ' room...');
    const separator = websocketUrl.includes('?') ? '&' : '?';
    const socket = new WebSocket(websocketUrl + separator + 'mode=' + encodeURIComponent(mode));
    this.onlineSocket = socket;
    let savedSeatToken = null;
    try {
      savedSeatToken = window.localStorage.getItem('shapey-seat-token:' + code);
    } catch (_) {
      // Storage may be disabled; the current session can still join, but won't retain a seat after reload.
    }
    socket.addEventListener('open', () => {
      this.setOnlineStatus('Joining your player seat...');
      try {
        socket.send(JSON.stringify({ type: 'join', seatToken: savedSeatToken }));
      } catch (_) {
        this.setOnlineStatus('Could not join the room. Please reconnect.');
        try { socket.close(); } catch {}
      }
    });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'welcome') {
        this.onlinePlayerNumber = message.playerNumber;
        if (typeof message.seatToken === 'string') {
          try { window.localStorage.setItem('shapey-seat-token:' + code, message.seatToken); } catch (_) {}
        }
        if (message.mode && message.mode !== mode) {
          this.setOnlineStatus('This code belongs to a different game mode. Return and choose that mode.');
          socket.close();
          return;
        }
        this.setOnlineStatus('Room connected as Player ' + message.playerNumber + '.');
      } else if (message.type === 'room_state') {
        const count = (message.players || []).filter((player) => player.connected).length;
        const maxPlayers = message.maxPlayers || (mode === 'tag' ? 4 : 2);
        const actualMode = message.mode || mode;
        if (actualMode !== mode) {
          this.setOnlineStatus('This room is for a different game mode. Return and choose that mode.');
          socket.close();
          return;
        }
        if (count >= maxPlayers) {
          this.setOnlineStatus('All ' + maxPlayers + ' players connected. Starting the match...');
        } else {
          this.setOnlineStatus(count + '/' + maxPlayers + ' players connected. Share the code with your friend/team.');
        }
      } else if (message.type === 'player_disconnected') {
        const maxPlayers = message.maxPlayers || (mode === 'tag' ? 4 : 2);
        const count = (message.players || []).filter((player) => player.connected).length;
        this.setOnlineStatus('A player disconnected (' + count + '/' + maxPlayers + ' connected). They can rejoin with this code.');
      } else if (message.type === 'game_started' && message.state) {
        this.launchOnlineGame(code, mode, socket, message.state);
      } else if (message.type === 'error') {
        this.setOnlineStatus(message.message || 'The room reported an error.');
      }
    });
    socket.addEventListener('error', () => {
      this.setOnlineStatus('Could not connect to that room. Check the code and try again.');
    });
    socket.addEventListener('close', () => {
      if (this.onlineSocket === socket && this.onlineUI && this.onlineUI.length) {
        this.setOnlineStatus('Disconnected. You can create or join a room again.');
      }
    });
  }

  launchOnlineGame(code, mode, socket, initialState) {
    if (!initialState || !socket) {
      this.setOnlineStatus('The room could not start a match. Please create a new room.');
      return;
    }
    const playerNumber = this.onlinePlayerNumber;
    // Preserve the WebSocket while this scene changes from the lobby to the game board.
    this.onlineSocket = null;
    this.onlineStatus = null;
    this.onlineUI = [];
    this.onlineCopyUI = null;
    this.onlineRoomCodeText = null;
    this.currentRoomCode = null;
    this.onlineMode = null;
    this.scene.start('GameScene', {
      mode,
      online: true,
      onlineSocket: socket,
      onlinePlayerNumber: playerNumber,
      onlineRoomCode: code,
      onlineState: initialState
    });
  }

  closeOnlineLobby() {
    if (this.onlineSocket) {
      const socket = this.onlineSocket;
      this.onlineSocket = null;
      try { socket.close(); } catch {}
    }
    if (this.onlineUI) this.onlineUI.forEach((object) => object.destroy());
    this.onlineUI = [];
    this.onlineStatus = null;
    this.onlineRoomCodeText = null;
    this.onlineCopyUI = null;
    this.onlineCopyLabel = null;
    this.currentRoomCode = null;
    this.onlineMode = null;
    this.onlineBoardSize = null;
  }

  // "Choose difficulty" panel for Player vs AI (Easy / Professional, built from AI_LEVELS).
  openDifficulty(boardSize = 7) {
    this.chosenBoardSize = normalizeBoardSize(boardSize);
    if (this.pickerUI.length) return;
    const add = (object) => { this.pickerUI.push(object); return object; };
    add(this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x120a05, 0.8)
      .setDepth(50).setInteractive()); // shield: taps must not reach the mode buttons underneath
    add(this.add.rectangle(GAME_WIDTH / 2, 640, 640, 700, 0x4b2d17, 1).setStrokeStyle(5, 0xd5ad72).setDepth(51));
    add(this.add.text(GAME_WIDTH / 2, 380, 'CHOOSE DIFFICULTY', {
      fontFamily: FONT, fontSize: '46px', color: '#fff2c7', stroke: '#3a2412', strokeThickness: 8,
    }).setOrigin(0.5).setDepth(52));
    Object.entries(AI_LEVELS).forEach(([difficulty, level], i) => {
      woodButton(this, GAME_WIDTH / 2, 530 + i * 190, 560, 160, level.label, 42,
        () => this.scene.start('GameScene', { mode: 'ai', difficulty, boardSize: this.chosenBoardSize }), 52, level.hint).forEach(add);
    });
    woodButton(this, GAME_WIDTH / 2, 530 + Object.keys(AI_LEVELS).length * 190, 560, 90, 'BACK', 36,
      () => {
        this.closeDifficulty();
        this.openBoardSize('ai');
      }, 52).forEach(add);
  }

  closeDifficulty() {
    this.pickerUI.forEach((object) => object.destroy());
    this.pickerUI = [];
  }
}
