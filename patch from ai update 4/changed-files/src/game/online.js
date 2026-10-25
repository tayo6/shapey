// Shapey - the online client: authoritative-state reconciliation, the submit queue and
// the WebSocket wiring against the multiplayer Worker (worker/src/).
// Extracted from GameScene (scenes/game.js) as a prototype mixin.

import { TILE_SIZE, GRID_COLS, GRID_ROWS } from '../config.js';

export const OnlineClientMixin = {
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
  },

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
            this.turnClock.endsAt = this.serverToLocal(this.onlineState.turnEndsAt);
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
          this.turnClock.endsAt = this.serverToLocal(this.onlineState.turnEndsAt);
        }
      }
      if (this.online && !this.gameOver) this.showToast('Connection lost. Return to the main menu and reconnect.', 4500);
    });
  },

  onlineTurnKey(state) {
    return {
      turnIndex: Number(state.turnIndex),
      activePlayerNumber: Number(state.activePlayerNumber),
      isBonusTurn: Boolean(state.isBonusTurn),
    };
  },

  isSameOnlineTurn(state, key) {
    return Boolean(state && key && state.status === 'playing' &&
      state.activePlayerNumber === this.onlinePlayerNumber &&
      Number(state.turnIndex) === key.turnIndex &&
      Number(state.activePlayerNumber) === key.activePlayerNumber &&
      Boolean(state.isBonusTurn) === key.isBonusTurn);
  },

  queueOnlineSubmit(state = this.onlineState) {
    if (!state || state.status !== 'playing' || state.activePlayerNumber !== this.onlinePlayerNumber) return false;
    this.pendingOnlineSubmitKey = this.onlineTurnKey(state);
    return true;
  },

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
  },

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
  },

  applyOnlineState(state, initial = false) {
    if (!this.online || !state) return;
    // The server snapshot contains the canonical owner and deadline for the new turn.
    this.onlineSubmitPending = false;
    // Deadlines are server timestamps: measure the clock skew from serverNow on every snapshot,
    // so a device with a wrong clock still shows (and enforces) the true remaining time.
    if (Number.isFinite(Number(state.serverNow))) {
      this.serverClockOffset = Number(state.serverNow) - Date.now();
    }
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
    this.turnClock.endsAt = Number.isFinite(state.turnEndsAt) ? this.serverToLocal(state.turnEndsAt) : Infinity;
    this.currentTurnDurationMs = state.status === 'study'
      ? this.turnDurationMs
      : Math.max(this.turnDurationMs, Number.isFinite(state.turnEndsAt) ? this.serverToLocal(state.turnEndsAt) - Date.now() : this.turnDurationMs);
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
              ? Math.max(0, this.serverToLocal(viewTile.movingUntil) - Date.now())
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
  },

  // Draw the same cyan square used by local shuffle animation around server-moved tiles.
  addShuffleOutline(tile) {
    if (!tile || !tile.active || tile.shuffleOutline) return;
    const outline = this.add.graphics({ x: tile.x, y: tile.y }).setDepth(14);
    outline.lineStyle(5, 0x66e0ff, 1);
    outline.strokeRect(-TILE_SIZE / 2 - 2, -TILE_SIZE / 2 - 2, TILE_SIZE + 4, TILE_SIZE + 4);
    tile.shuffleOutline = outline;
  },

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
  },

};
