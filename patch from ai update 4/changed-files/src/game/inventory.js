// Shapey - the inventory / shop overlay and the local Star economy (streak rewards).
// Extracted from GameScene (scenes/game.js) as a prototype mixin: the methods keep their
// `this` (the scene), so call sites inside the scene do not change.

import { GAME_WIDTH, GAME_HEIGHT, FONT, INVENTORY_OPEN_LIMIT } from '../constants.js';
import { RULES, formatInventoryWindow } from '../config.js';
import { formatClock } from '../utils.js';

export const InventoryMixin = {
  // ---------------------------------------------------------- inventory/shop
  loadStarBalance() {
    try {
      const raw = window.localStorage.getItem('shapey-stars');
      return RULES.initialStarBalance(raw);
    } catch (_) {
      return 1;
    }
  },

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
  },

  saveInventory() {
    try {
      window.localStorage.setItem('shapey-stars', String(this.starBalance));
      window.localStorage.setItem('shapey-inventory', JSON.stringify(this.inventoryItems));
    } catch (_) {
      // Storage may be unavailable in private browsing; the shop still works for this session.
    }
    this.updateStarDisplays();
  },

  updateStarDisplays() {
    if (this.p1Stars && this.p1Stars[1] && this.p1Stars[1].active) {
      this.p1Stars[1].setText(String(this.starBalance));
    }
    if (this.p2Stars && this.p2Stars[1] && this.p2Stars[1].active) {
      this.p2Stars[1].setText(String(this.modeCfg.ai ? 0 : this.starBalance));
    }
  },

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
  },

  breakLocalMatchStreak() {
    if (!this.modeCfg.twoPlayers) return;
    this.matchStreaks.set(this.limiterSlot(), RULES.nextMatchStreak(0, 0, false));
  },

  clearInventoryUI() {
    this.inventoryUI.forEach((object) => object.destroy());
    this.inventoryUI = [];
    this.inventoryTimerText = null;
  },

  addInventoryUI(object) {
    object.setDepth(100);
    this.inventoryUI.push(object);
    return object;
  },

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
  },

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
  },

  closeInventory() {
    this.clearInventoryUI();
    this.inventoryOpen = false;
  },

};
