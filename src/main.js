// Shapey - a memory game with candy-crush style cascades.
// The game canvas is 720 x 1280 ("720p" width) and scales to fit any screen.
const GAME_WIDTH = 720;
const GAME_HEIGHT = 1280;

const FONT = 'HappySchool';
const TILE_SIZE = 90;   // every shape tile is drawn at 90 x 90
const TILE_PITCH = 91;  // distance between tile centres (90px tile + 1px gap)
const GRID_COLS = 7;
const GRID_ROWS = 7;

// ---- Game rules -----------------------------------------------------------
// For quick testing you can shorten the timers in the URL, e.g. index.html?review=3000&turn=10000
const urlParams = new URLSearchParams(window.location.search);
const REVIEW_MS = Number(urlParams.get('review')) || 15000;      // new shapes stay face-up this long, then flip to mystery
const MIN_MATCH = 3;          // smallest scoring match
// 3 matched = 1 point, 4 matched = 2 points, 5 or more = 5 points
const scoreFor = (count) => (count >= 5 ? 5 : count === 4 ? 2 : count === 3 ? 1 : 0);

// ---- Turn clock and inventory limits ----------------------------------------
// Every turn lasts 45 seconds. The turn clock and the 15 second "memorize" reveal of newly spawned
// tiles each run on their own absolute deadline, so they always tick side by side: a new batch
// being revealed never pauses, resets or extends the turn, and the turn ending never cuts a reveal short.
// Test overrides: ?turn=10000 (turn length) and ?invwindow=20000 (inventory window), in milliseconds.
const TURN_MS = Number(urlParams.get('turn')) || 45000;
// Anti-stalling: a player may open the inventory at most 2 times in any rolling 5 minutes.
// The turn clock keeps running while the inventory is open.
const INVENTORY_OPEN_LIMIT = 2;
const INVENTORY_WINDOW_MS = Number(urlParams.get('invwindow')) || 5 * 60 * 1000;
const PLAYER_NAMES = ['Player 1', 'Player 2'];

// "00:45" style clock text. Rounds up, so "00:00" only shows once time is really up.
const formatClock = (ms) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
};

// texture key -> file in assets/shapes
const SHAPE_FILES = {
  mystery: 'Mystery.png', // the hidden face (never a real shape)
  dummy:   'dummy.png',  // blank wooden tile: neutral, non-scoring, and ignored by matching
  cancel:  'cancel.png',
  capsule: 'capsule.png',
  circle:  'circle.png',
  cross:   'cross.png',
  divide:  'divide.png',
  corner:  'four corner.png',
  marked:  'marked.png',
  pointer: 'shield.png',   // orange gem (file names are swapped)
  shield:  'pointer.png',  // red gem
  sphere:  'sphere.png',
  square:  'square.png',
  star:    'star .png',    // note: space before the dot in the filename
  x:       'x.png',
};
const SHAPE_KEYS = Object.keys(SHAPE_FILES).filter((k) => !['mystery', 'dummy'].includes(k));
const DUMMY_SPAWN_CHANCE = 0.08; // blank wooden tiles are occasional neutral decoys

function randomBoardShape() {
  return Math.random() < DUMMY_SPAWN_CHANCE ? 'dummy' : randomItem(SHAPE_KEYS);
}

// Frames of "tile destroy frame.png" (x positions, each 256 x 241) - centred on the tile.
const DESTROY_FRAME_X = [3, 292, 585, 877, 1172, 1467];

// Frames of "dust frame.png" (3 puffs, each 480 x 189) - landing dust for new shapes.
// The whole sheet is shown 310px wide, aligned to the bottom edge of the landed shape.
const DUST_FRAME_X = [0, 555, 1116];

const randomItem = (list) => list[Math.floor(Math.random() * list.length)];

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Starting board: every shape appears at least 3 times, the rest are random.
function makeInitialBoard() {
  const total = GRID_ROWS * GRID_COLS;
  const bag = [];
  SHAPE_KEYS.forEach((k) => bag.push(k, k, k));
  while (bag.length < total) bag.push(randomBoardShape());
  const flat = shuffle(bag);
  return Array.from({ length: GRID_ROWS }, (_, r) => flat.slice(r * GRID_COLS, (r + 1) * GRID_COLS));
}

// A countdown to an absolute deadline (never a tick counter), so it stays correct however
// often the screen redraws and can run alongside any other countdown.
class Countdown {
  constructor(clock = Date.now) {
    this.clock = clock;
    this.endsAt = 0;
  }
  start(ms) { this.endsAt = this.clock() + ms; }
  remaining() { return Math.max(0, this.endsAt - this.clock()); }
  expired() { return this.clock() >= this.endsAt; }
}

// Tracks the "memorize" countdown of every batch of newly revealed tiles. Each batch has its own
// 15 second deadline, independent of the turn clock.
class RevealTracker {
  constructor(clock = Date.now) {
    this.clock = clock;
    this.batches = [];
  }
  add(tiles, ms) { this.batches.push({ tiles, endsAt: this.clock() + ms }); }
  // Longest time left among the batches still being shown (0 when nothing is being revealed).
  remaining() {
    const now = this.clock();
    return this.batches.reduce((most, b) => Math.max(most, b.endsAt - now), 0);
  }
  // Batches whose reveal time is over; they are removed from the tracker.
  takeDue() {
    const now = this.clock();
    const due = this.batches.filter((b) => b.endsAt <= now);
    this.batches = this.batches.filter((b) => b.endsAt > now);
    return due.map((b) => b.tiles);
  }
}

// Rolling-window cap on how often each player may open the inventory.
class InventoryLimiter {
  constructor(limit, windowMs, playerCount, clock = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
    this.opens = Array.from({ length: playerCount }, () => []); // open timestamps per player
  }
  recent(player) {
    const cutoff = this.clock() - this.windowMs;
    this.opens[player] = this.opens[player].filter((t) => t > cutoff);
    return this.opens[player];
  }
  // Records an open when allowed. When refused, nothing is recorded and retryInMs says how long to wait.
  tryOpen(player) {
    const recent = this.recent(player);
    if (recent.length >= this.limit) {
      const retryInMs = recent[recent.length - this.limit] + this.windowMs - this.clock();
      return { allowed: false, left: 0, retryInMs: Math.max(0, retryInMs) };
    }
    recent.push(this.clock());
    return { allowed: true, left: this.limit - recent.length, retryInMs: 0 };
  }
}

class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
  }

  preload() {
    this.load.setPath('assets');

    // backgrounds
    this.load.image('bg', 'backgrounds/BG.png');
    this.load.image('headerShadow', 'backgrounds/header shadow.png');
    this.load.image('headerPlank1', 'backgrounds/header  plank 1.png'); // two spaces in the filename
    this.load.image('trayShadow', 'backgrounds/Tray Shadow.png');
    this.load.image('tray', 'backgrounds/tray.png');
    this.load.image('bottomNav', 'backgrounds/bottom navigation.png');

    // ui
    this.load.image('playerPlank1', 'ui/player plank.png');
    this.load.image('playerPlank2', 'ui/player plank 2.png');
    this.load.image('timerPlank', 'ui/timer plank.png');
    this.load.image('starIcon', 'ui/Star.png');
    this.load.image('btnSettings', 'ui/settings.png');
    this.load.image('btnSubmit', 'ui/submit.png');
    this.load.image('btnPolls', 'ui/polls.png');
    this.load.image('btnInventory', 'ui/inventory.png');

    // shapes
    for (const [key, file] of Object.entries(SHAPE_FILES)) {
      this.load.image('shape_' + key, 'shapes/' + file);
    }

    // fx + audio
    this.load.image('tileDestroy', 'fx/tile destroy frame.png');
    this.load.image('dust', 'fx/dust frame.png');
    this.load.audio('flip', ['audio/tile_flip_short.ogg', 'audio/tile_flip_short.wav']);
  }

  create() {
    this.scores = [0, 0];      // one score per player
    this.activePlayer = 0;     // 0 = Player 1, 1 = Player 2
    this.selection = [];      // tiles the player has picked, in order
    this.selectedShape = null; // the shape the current attempt is matching
    this.busy = false;        // true while animations run (input is ignored)
    this.starBalance = this.loadStarBalance();
    this.inventoryItems = this.loadInventoryItems();
    this.inventoryUI = [];
    this.inventoryOpen = false;
    this.inventoryTimerText = null;
    this.toast = null;
    this.toastTween = null;

    // Two independent countdowns that run at the same time (see TURN_MS above).
    this.turnClock = new Countdown();   // the active player's 45 second turn
    this.reveals = new RevealTracker(); // the 15 second reveal of each batch of new tiles
    this.turnEnding = false;            // true while a turn is being handed over: taps/submits are ignored
    this.inventoryLimiter = new InventoryLimiter(INVENTORY_OPEN_LIMIT, INVENTORY_WINDOW_MS, PLAYER_NAMES.length);

    this.createBackground();
    this.createHeader();
    this.createBottomButtons();
    this.createFx();
    this.createBoard();
    this.startTurn(0);
  }

  // Runs every frame: flips tiles whose reveal is over, redraws both clocks, and ends the turn on timeout.
  update() {
    if (!this.turnClock) return;
    this.hideFinishedReveals();
    this.refreshClocks();
    // A turn that expires mid-animation (a submitted match resolving, a wrong pick flipping back) waits for it.
    if (!this.turnEnding && !this.busy && this.turnClock.expired()) this.endTurn('timeout');
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
    const SCALE = 0.24;

    const p1 = this.add.image(105, 20, 'playerPlank1').setOrigin(0.5, 0).setScale(SCALE).setDepth(10);
    this.p1Score = this.numberText(p1.x + 2, p1.y + p1.displayHeight * 0.35, '0', 46);
    this.p1Name = this.numberText(p1.x - 4, p1.y + p1.displayHeight * 0.83, 'Player 1', 21);

    const p2 = this.add.image(612, 20, 'playerPlank2').setOrigin(0.5, 0).setScale(SCALE).setDepth(10);
    this.p2Score = this.numberText(p2.x - 4, p2.y + p2.displayHeight * 0.35, '0', 46);
    this.p2Name = this.numberText(p2.x - 4, p2.y + p2.displayHeight * 0.83, 'Player 2', 21);

    const timer = this.fitToWidth(this.add.image(GAME_WIDTH / 2, 101, 'timerPlank'), 262).setDepth(10);
    this.timerText = this.numberText(timer.x + 24, timer.y + 2, formatClock(TURN_MS), 46);

    // Countdown for newly spawned tiles. It sits under the turn timer and only shows while tiles are face-up.
    this.revealText = this.numberText(GAME_WIDTH / 2, 188, '', 26).setVisible(false);

    this.p1Stars = this.createStars(38, 213, 5);
    this.p2Stars = this.createStars(546, 213, 5);

    // Everything that belongs to one player, so the inactive player can be dimmed.
    this.playerUI = [
      [p1, this.p1Score, this.p1Name, ...this.p1Stars],
      [p2, this.p2Score, this.p2Name, ...this.p2Stars],
    ];
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
    const toast = this.add.text(GAME_WIDTH / 2, 256, message, {
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

  // ------------------------------------------------------- clocks and turns
  setClockText(textObject, value) {
    if (textObject.lastClock === value) return; // only redraw the text when it changes
    textObject.lastClock = value;
    textObject.setText(value);
  }

  // Both clocks are redrawn from their own deadlines, so they can never hold each other up.
  refreshClocks() {
    const turnLeft = formatClock(this.turnClock.remaining());
    this.setClockText(this.timerText, turnLeft);

    const revealLeft = this.reveals.remaining();
    this.revealText.setVisible(revealLeft > 0);
    if (revealLeft > 0) this.setClockText(this.revealText, 'MEMORIZE ' + formatClock(revealLeft));

    // The shop covers the header, so it shows the turn clock too: opening it never stops the clock.
    if (this.inventoryTimerText && this.inventoryTimerText.active) {
      this.setClockText(this.inventoryTimerText, 'TURN\n' + turnLeft);
    }
  }

  startTurn(player) {
    this.activePlayer = player;
    this.turnEnding = false;
    this.turnClock.start(TURN_MS);
    this.updateActivePlayerUI();
  }

  // Ends the active player's turn exactly once (timeout or a submitted match) and hands over to the other player.
  async endTurn(reason) {
    if (this.turnEnding) return;
    this.turnEnding = true; // from here on, late taps and submits are ignored
    if (this.inventoryOpen) this.closeInventory();
    await this.resetSelection(); // flip any picked tiles back (nothing to do after a match)

    const next = 1 - this.activePlayer;
    this.startTurn(next);
    this.showToast((reason === 'timeout' ? 'Time is up. ' : '') + PLAYER_NAMES[next] + '’s turn');
  }

  createStars(startX, y, count) {
    const stars = [];
    for (let i = 0; i < count; i++) {
      stars.push(this.add.image(startX + i * 31.7, y, 'starIcon').setDisplaySize(30, 30).setDepth(10));
    }
    return stars;
  }

  createBottomButtons() {
    const BUTTON_HEIGHT = 146;
    const BOTTOM = 1214; // bottom edge of the label plank
    const buttons = [
      ['btnSettings', 136],
      ['btnSubmit', 296],
      ['btnPolls', 449],
      ['btnInventory', 602],
    ];
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

    // Inventory opens the shop/inventory page.
    const inventory = this.buttons.btnInventory;
    inventory.setInteractive({ useHandCursor: true });
    inventory.on('pointerdown', () => this.openInventory());
  }

  // ---------------------------------------------------------- inventory/shop
  loadStarBalance() {
    try {
      const saved = Number(window.localStorage.getItem('shapey-stars'));
      return Number.isFinite(saved) && saved >= 0 ? saved : 1;
    } catch (_) {
      return 1;
    }
  }

  loadInventoryItems() {
    try {
      return JSON.parse(window.localStorage.getItem('shapey-inventory') || '{}') || {};
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
    if (this.inventoryOpen || this.turnEnding) return;
    const attempt = this.inventoryLimiter.tryOpen(this.activePlayer);
    if (!attempt.allowed) {
      const windowText = INVENTORY_WINDOW_MS % 60000 === 0
        ? INVENTORY_WINDOW_MS / 60000 + ' min' : INVENTORY_WINDOW_MS / 1000 + ' s';
      this.showToast('Inventory limit reached (' + INVENTORY_OPEN_LIMIT + ' per ' + windowText +
        ').\nAvailable again in ' + formatClock(attempt.retryInMs));
      return;
    }
    this.inventoryOpen = true;
    this.renderInventory();
  }

  renderInventory() {
    this.clearInventoryUI();

    // Full-page shop uses the same BG.png art as the game background.
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

    const balance = this.add.text(GAME_WIDTH / 2, 128, 'YOUR STARS: ' + this.starBalance + ' ★', {
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
    this.inventoryTimerText = this.addInventoryUI(this.add.text(84, 66,
      'TURN\n' + formatClock(this.turnClock.remaining()), {
        fontFamily: FONT, fontSize: '24px', color: '#ffe36e',
        stroke: '#4a2814', strokeThickness: 4, align: 'center',
      }).setOrigin(0.5));

    const offers = [
      { key: 'audiencePick', name: 'AUDIENCE PICK', price: 3, desc: 'Ask the audience which shape to pursue.' },
      { key: 'doubleTime', name: 'DOUBLE TIME', price: 3, desc: 'Make your next turn last 90 seconds.' },
      { key: 'doublePlay', name: 'DOUBLE PLAY', price: 4, desc: 'Take one extra 45-second turn.' },
      { key: 'scoreStrike', name: 'SCORE STRIKE', price: 5, desc: 'Remove 10 points from your opponent.' },
    ];

    offers.forEach((offer, index) => {
      const y = 238 + index * 205;
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
      'CANCEL COUNTER  ·  SPECIAL ITEM\nEarn by collecting a Cancel tile. Use it to block an opponent’s Score Strike, Double Time, or Double Play.', {
        fontFamily: FONT, fontSize: '20px', color: '#fff0c7',
        align: 'center', wordWrap: { width: 570 }, lineSpacing: 5,
      }).setOrigin(0.5);
    this.addInventoryUI(counterText);

    const note = this.add.text(GAME_WIDTH / 2, 1192,
      'Purchases are saved on this device. Using power-ups in a match is coming next.\nThe inventory can be opened ' +
      INVENTORY_OPEN_LIMIT + ' times per 5 minutes, and your turn clock keeps running while it is open.', {
        fontFamily: FONT, fontSize: '17px', color: '#ffffff',
        align: 'center', wordWrap: { width: 630 },
      }).setOrigin(0.5);
    this.addInventoryUI(note);
  }

  closeInventory() {
    this.clearInventoryUI();
    this.inventoryOpen = false;
  }

  // ------------------------------------------------------------------ fx
  createFx() {
    // slice the destroy sprite sheet into 6 frames and build the animation
    const tex = this.textures.get('tileDestroy');
    DESTROY_FRAME_X.forEach((x, i) => tex.add('d' + i, 0, x, 0, 256, 241));
    this.anims.create({
      key: 'tileDestroy',
      frames: DESTROY_FRAME_X.map((_, i) => ({ key: 'tileDestroy', frame: 'd' + i })),
      frameRate: 14,
    });

    // landing dust: 3 frames
    const dustTex = this.textures.get('dust');
    DUST_FRAME_X.forEach((x, i) => dustTex.add('u' + i, 0, x, 0, 480, 189));
    this.anims.create({
      key: 'dustPuff',
      frames: DUST_FRAME_X.map((_, i) => ({ key: 'dust', frame: 'u' + i })),
      frameRate: 11,
    });

    // flip sound: a few instances so quick flips can overlap
    this.flipSounds = [0, 1, 2, 3].map(() => this.sound.add('flip', { volume: 0.55 }));
    this.flipSoundIndex = 0;
  }

  playFlipSound() {
    this.flipSounds[this.flipSoundIndex++ % this.flipSounds.length].play();
  }

  // ---------------------------------------------------------------- board
  cellX(col) { return this.gridX0 + col * TILE_PITCH; }
  cellY(row) { return this.gridY0 + row * TILE_PITCH; }

  // 7 x 7 board centred on the tray. Every tile is 90 x 90.
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

    const layout = makeInitialBoard();
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
    this.startReview(all); // show everything for 15s, then flip to mystery
  }

  // A new tile, created face-up.
  createTile(shape, row, col, x, y) {
    const tile = this.add.image(x, y, 'shape_' + shape).setDisplaySize(TILE_SIZE, TILE_SIZE).setDepth(10);
    tile.shape = shape;
    tile.row = row;
    tile.col = col;
    tile.faceUp = true;
    tile.selected = false;
    tile.baseScale = tile.scaleX;
    tile.flipChain = Promise.resolve();
    tile.setMask(this.boardMask);
    tile.setInteractive({ useHandCursor: true });
    tile.on('pointerdown', () => this.onTileTap(tile));
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
      await this.tweenAsync({ targets: tile, scaleX: tile.baseScale, duration: 100, ease: 'Sine.easeOut' });
    });
    return tile.flipChain;
  }

  // Starts the REVIEW_MS "memorize" countdown for a batch of new tiles. It runs on its own deadline,
  // at the same time as the turn clock, and is not affected by whose turn it is.
  startReview(batch) {
    this.reveals.add(batch, REVIEW_MS);
  }

  // Once a batch's reveal time is over, flip its tiles to mystery one after the other.
  // Tiles the player is currently using stay face-up.
  hideFinishedReveals() {
    for (const batch of this.reveals.takeDue()) {
      batch.forEach((tile, i) => {
        if (tile.active && !tile.selected) this.flipTile(tile, false, i * 35);
      });
    }
  }

  // -------------------------------------------------------------- picking
  addRing(tile) {
    tile.ring = this.add.graphics({ x: tile.x, y: tile.y }).setDepth(12);
    tile.ring.lineStyle(5, 0xffe066, 1);
    tile.ring.strokeRoundedRect(-43, -43, 86, 86, 14);
  }

  removeRing(tile) {
    if (tile.ring) { tile.ring.destroy(); tile.ring = null; }
  }

  onTileTap(tile) {
    // Taps are ignored during hand-over and once the turn clock has run out.
    if (this.busy || this.turnEnding || this.turnClock.expired() || !tile.active || tile.selected) return;

    // A blank wooden dummy is revealed briefly, but is otherwise as if it
    // had not been picked: it never joins or resets the current selection.
    if (tile.shape === 'dummy') {
      this.flipTile(tile, true);
      this.time.delayedCall(1100, () => {
        if (tile.active && !tile.selected) this.flipTile(tile, false);
      });
      return;
    }

    const isFirst = this.selection.length === 0;
    const matches = isFirst || tile.shape === this.selectedShape;

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

  // A different shape was picked: show it briefly, then flip everything back. No score.
  async failAttempt(wrongTile) {
    this.busy = true;
    await this.flipTile(wrongTile, true);
    await this.sleep(500);
    await this.resetSelection();
    this.busy = false;
  }

  // Flip every picked tile back to mystery, one after the other.
  async resetSelection() {
    const tiles = this.selection;
    this.selection = [];
    this.selectedShape = null;
    await Promise.all(
      tiles.map(async (tile, i) => {
        await this.flipTile(tile, false, i * 140);
        tile.selected = false;
        this.removeRing(tile);
      })
    );
  }

  // -------------------------------------------------------------- submit
  async submit() {
    // A late submit (after the turn clock ran out, or during hand-over) is ignored.
    if (this.busy || this.turnEnding || this.turnClock.expired() || this.selection.length === 0) return;
    this.busy = true;

    const tiles = this.selection;
    if (tiles.length < MIN_MATCH) {
      // not enough for a match: flip back, no score
      await this.resetSelection();
      this.busy = false;
      return;
    }

    await Promise.all(tiles.map((t) => t.flipChain)); // let any flips finish
    this.selection = [];
    this.selectedShape = null;

    this.addScore(scoreFor(tiles.length));
    await this.destroyTiles(tiles);
    await this.cascade();
    this.busy = false;
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
    if (fresh.length) this.startReview(fresh);
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
    puff.setScale(310 / 1596); // constraint size: the 3-frame sheet is 310px wide (about 103 x 36 per frame)
    puff.play('dustPuff');
    puff.once('animationcomplete', () => puff.destroy());
  }

  // Random new shape, favouring shapes with fewer than 3 left so matches stay possible.
  pickShape(counts) {
    // Occasionally spawn a blank wooden dummy; it never counts toward matches.
    if (Math.random() < DUMMY_SPAWN_CHANCE) return 'dummy';
    const scarce = SHAPE_KEYS.filter((k) => (counts[k] || 0) < MIN_MATCH);
    return randomItem(scarce.length ? scarce : SHAPE_KEYS);
  }
}

// Wait for the custom font so the first frame already uses it.
document.fonts.load(`20px ${FONT}`).catch(() => {}).finally(() => {
  window.game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    backgroundColor: '#000000',
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: [GameScene],
  });
});
