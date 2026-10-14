// Shapey - a memory game with candy-crush style cascades.
// The game canvas is 720 x 1280 ("720p" width) and scales to fit any screen.
const RULES = window.ShapeyRules;
if (!RULES) throw new Error('Load src/rules.js before src/main.js.');

const GAME_WIDTH = 720;
const GAME_HEIGHT = 1280;

const urlParams = new URLSearchParams(window.location.search);
// Permit only exact local Worker URLs when the page itself is on localhost. Production pages ignore this parameter.
const requestedLocalApi = urlParams.get('api');
const MULTIPLAYER_API = ['localhost', '127.0.0.1'].includes(window.location.hostname) &&
    ['http://localhost:8787', 'http://127.0.0.1:8787'].includes(requestedLocalApi)
  ? requestedLocalApi
  : 'https://shapey-multiplayer.hellohuman100.workers.dev';

const FONT = 'HappySchool';
const TILE_SIZE = 90;   // every shape tile is drawn at 90 x 90
const TILE_PITCH = 91;  // distance between tile centres (90px tile + 1px gap)
const GRID_COLS = 7;
const GRID_ROWS = 7;

// ---- Game rules -----------------------------------------------------------
// For quick testing you can shorten the timers in the URL, e.g. index.html?review=3000&turn=10000
const REVIEW_MS = Number(urlParams.get('review')) || 15000;      // the opening board stays face-up this long (study phase)
// Tiles spawned after a match are shown only briefly, flip face-down, then shuffle places with each other.
const SPAWN_REVEAL_MS = Number(urlParams.get('reveal')) || 5000;  // new tiles face-up
const SHUFFLE_STEP_MS = Number(urlParams.get('swap')) || 2000;    // each swap takes this long; swaps run one after another
const SHUFFLE_SKIP_CHANCE = 0.1;  // about 10% of new tiles sit the shuffle out
const STUCK_UP_MS = 2500;         // a face-up tile with no reason to be face-up is flipped back down after this long
const SHUFFLE_ARC_PX = 28;        // sideways bow of a swap path, so the two tiles pass each other instead of overlapping
const MIN_MATCH = 3;          // smallest scoring match; points are calculated in src/rules.js

// ---- Turn clock and inventory limits ----------------------------------------
// Every turn lasts 45 seconds. The turn clock and each newly spawned tile's SPAWN_REVEAL_MS reveal
// run on their own absolute deadline, so they always tick side by side: a new batch
// being revealed never pauses, resets or extends the turn, and the turn ending never cuts a reveal short.
// Test overrides: ?turn=10000 (turn length) and ?invwindow=20000 (inventory window), in milliseconds.
const TURN_MS = Number(urlParams.get('turn')) || 45000;
// Anti-stalling: a player may open the inventory at most 2 times in any rolling 5 minutes.
// The turn clock keeps running while the inventory is open.
const INVENTORY_OPEN_LIMIT = 2;
const INVENTORY_WINDOW_MS = Number(urlParams.get('invwindow')) || 5 * 60 * 1000;
const formatInventoryWindow = () => INVENTORY_WINDOW_MS % 60000 === 0
  ? INVENTORY_WINDOW_MS / 60000 + ' min' : INVENTORY_WINDOW_MS / 1000 + ' s';
const PLAYER_NAMES = ['Player 1', 'Player 2'];

// Play Alone survival rules: no attempt-based checkpoints.
const ALONE_SCORE_FLOOR = -15;  // reaching this score is game over
const ALONE_MISS_PENALTY = 1;   // a wrong shape costs this much (a too-small submit is free)

// ---- Game modes --------------------------------------------------------------
// hazard = chance that a tile is a hazard (skull) tile: the same ~10% in every mode. Test override: ?hazard=0.5
const HAZARD_CHANCE = 0.1;
// teams = Tag mode: two teams of two share the device, and each team's partners take turns (see turnLabel()).
const MODES = {
  alone: { label: 'PLAY ALONE', hint: 'No timer. Lose when your score reaches ' + ALONE_SCORE_FLOOR + '.',
           targetScore: null, hazard: HAZARD_CHANCE, twoPlayers: false, turnClock: false, ai: false },
  ai:    { label: 'PLAYER VS AI', hint: 'First to ' + RULES.targetScoreForMode('ai') + ' points wins. Choose Easy or Professional.',
           targetScore: RULES.targetScoreForMode('ai'), hazard: HAZARD_CHANCE, twoPlayers: true, turnClock: true, ai: true },
  pvp:   { label: 'PLAYER 1 VS PLAYER 2', hint: 'Online 2-player match. First to ' + RULES.targetScoreForMode('pvp') + ' points wins.',
           targetScore: RULES.targetScoreForMode('pvp'), hazard: HAZARD_CHANCE, twoPlayers: true, turnClock: true, ai: false },
  tag:   { label: 'TAG: 2 VS 2', hint: 'Online team match · 2 vs 2. First team to ' + RULES.targetScoreForMode('tag') + ' points wins.',
           targetScore: RULES.targetScoreForMode('tag'), hazard: HAZARD_CHANCE, twoPlayers: true, turnClock: true, ai: false, teams: true },
};
const TEAM_PLAYERS = [['Player 1', 'Player 2'], ['Player 3', 'Player 4']]; // Tag: Team 1 and Team 2
const START_MODE = ['alone', 'ai'].includes(urlParams.get('mode')) ? urlParams.get('mode') : null; // only local modes may skip the menu; online modes must use their room lobby
const HAZARD_OVERRIDE = RULES.parseProbabilityOverride(urlParams.get('hazard'), urlParams.has('hazard'));
// A hazard tile has two effects (see hazardHit / hazardBlast):
// - two-player modes (Player vs AI, Player vs Player, Tag): picked first it does no damage and flips back; picked
//   after other shapes it costs HAZARD_BLAST_PENALTY point(s) and destroys itself and every picked tile, no reward;
// - Play alone: it never costs anything. It always destroys itself and every picked tile, whether it is picked
//   first or after other shapes.
const HAZARD_BLAST_PENALTY = 1;
// Spec: a hazard picked after other shapes always costs 1 point, even at 0, so a two-player score may go negative.
// Set this to 0 to stop two-player scores dropping below zero (Play alone has its own floor, ALONE_SCORE_FLOOR).
const TWO_PLAYER_SCORE_FLOOR = -Infinity;

// Play Alone attempts are tracked for statistics only. Hazards and wooden dummies are not attempts.

// AI difficulty (see GAMEPLAY.md). Both levels play by the same rules and only ever know what they have seen;
// they differ in memory and decisions. The picker in MenuScene is built from this table.
//   recall       share of seen tiles it remembers (rolled once per game)
//   mistake      a remembered tile is recalled as the wrong shape this often
//   forgetOnSwap a shuffled tile is forgotten this often
//   thinkMs / tapMs / gapMs / submitMs   human-like pauses (before the turn, per tap, between attempts, before Submit)
//   maxAttempts  match attempts per turn before it passes
//   bestGroupChance  chance it picks the biggest remembered group (otherwise a random one)
//   goBig        always reaches for a 5-tile match when it remembers enough tiles (Easy only sometimes tries for 4)
//   followHunch  with no full match remembered, starts from the shape it remembers most copies of
//   preferUnknown  when exploring, flips tiles it has no memory of first
const AI_LEVELS = {
  easy: { label: 'EASY', tag: 'Easy', hint: 'Forgets a lot, guesses often and plays slowly.',
          recall: [0.45, 0.6], mistake: 0.1, forgetOnSwap: 0.5,
          thinkMs: 1400, tapMs: [700, 1200], gapMs: 700, submitMs: 700, maxAttempts: 3,
          bestGroupChance: 0.2, goBig: false, followHunch: false, preferUnknown: false },
  pro:  { label: 'PROFESSIONAL', tag: 'Pro', hint: 'Remembers almost every tile and goes for the biggest match.',
          recall: [0.95, 1], mistake: 0.01, forgetOnSwap: 0.1,
          thinkMs: 900, tapMs: [450, 800], gapMs: 400, submitMs: 450, maxAttempts: 5,
          bestGroupChance: 1, goBig: true, followHunch: true, preferUnknown: true },
};
const AI_SPARE_MS = 6000; // the AI stops reaching for a bigger match when this little of its turn is left

// "00:45" style clock text. Rounds up, so "00:00" only shows once time is really up.
const formatClock = (ms) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
};

// texture key -> file in assets/shapes
const SHAPE_FILES = {
  mystery: 'Mystery.webp', // the hidden face (never a real shape)
  dummy:   'dummy.webp',  // blank wooden tile: neutral, non-scoring, and ignored by matching
  hazard:  'hazard.webp', // skull tile: never matchable; flipping it costs points
  cancel:  'cancel.webp',
  capsule: 'capsule.webp',
  circle:  'circle.webp',
  cross:   'cross.webp',
  divide:  'divide.webp',
  corner:  'four corner.webp',
  marked:  'marked.webp',
  pointer: 'shield.webp',   // orange gem (file names are swapped)
  shield:  'pointer.webp',  // red gem
  sphere:  'sphere.webp',
  square:  'square.webp',
  star:    'star .webp',    // note: space before the dot in the filename
  x:       'x.webp',
};
const SHAPE_KEYS = Object.keys(SHAPE_FILES).filter((k) => !['mystery', 'dummy', 'hazard'].includes(k));
const DUMMY_SPAWN_CHANCE = 0.08; // blank wooden tiles are occasional neutral decoys

function randomBoardShape() {
  return Math.random() < DUMMY_SPAWN_CHANCE ? 'dummy' : randomItem(SHAPE_KEYS);
}

// Frames of "tile destroy frame.webp" (x positions, each 256 x 241) - centred on the tile.
const DESTROY_FRAME_X = [3, 292, 585, 877, 1172, 1467];

// Frames of "dusty.webp" - landing dust for new shapes: 7 equal 304 x 156 cells in a 2128 x 156 sheet.
// Every puff is centred on the same point (the middle of its base) and sits on the bottom edge of its cell,
// so the cloud grows in place instead of drifting sideways. (The original sheet had unevenly spaced puffs.)
const DUST_FRAME_COUNT = 7;
const DUST_FRAME_WIDTH = 304;
const DUST_FRAME_HEIGHT = 156;
const DUST_SCALE = 0.4;      // on-screen size: 304 x 156 art -> about 122 x 62 px
const DUST_FRAME_RATE = 10;

// Shapey logo and the loading bar. index.html draws the same layout while Phaser is still downloading.
const LOGO_W = 520, LOGO_Y = 470;
const LOAD_BAR_W = 560, LOAD_BAR_Y = 720;
// The dark slot of "load rectangle.webp", as fractions of the image: the progress fill goes inside it.
const LOAD_TRACK = { x0: 0.0745, x1: 0.9255, y0: 0.302, y1: 0.698 };
const LOAD_MIN_FILL = 0.06; // share of the slot that is already filled at 0%, so the bar never looks empty

const randomItem = (list) => list[Math.floor(Math.random() * list.length)];

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Starting board: every shape appears at least 3 times, hazards take about `hazardChance` of the
// board (out of the free slots), and the rest are random.
function makeInitialBoard(hazardChance = 0) {
  const total = GRID_ROWS * GRID_COLS;
  const bag = [];
  SHAPE_KEYS.forEach((k) => bag.push(k, k, k));
  const hazards = Math.min(total - bag.length, Math.round(total * hazardChance));
  for (let i = 0; i < hazards; i++) bag.push('hazard');
  while (bag.length < total) bag.push(randomBoardShape());
  const flat = shuffle(bag);
  return Array.from({ length: GRID_ROWS }, (_, r) => flat.slice(r * GRID_COLS, (r + 1) * GRID_COLS));
}

// Spawning uses a "shuffle bag" instead of pure randomness: every shape is dealt once per round in a
// random order, so the same shape is never dealt twice in a row and no shape can dominate a refill.
// Shapes that are short on the board (fewer than MIN_MATCH) get one extra copy per round, so
// matches stay possible without flooding the board with the shape that was just removed.
class ShapeBag {
  constructor(keys) {
    this.keys = keys;
    this.queue = [];
    this.last = null;
  }
  next(scarce = []) {
    if (!this.queue.some((k) => k !== this.last)) {
      this.queue.push(...shuffle([...this.keys, ...scarce.filter((k) => this.keys.includes(k))]));
    }
    let i = this.queue.length - 1;
    while (this.queue[i] === this.last) i--; // skip a repeat of the previous shape
    const [shape] = this.queue.splice(i, 1);
    this.last = shape;
    return shape;
  }
}

// A wooden button used by the menu, the in-game panel and the game-over screen.
function woodButton(scene, x, y, w, h, label, fontSize, onTap, depth = 0, sub = null) {
  const bg = scene.add.rectangle(x, y, w, h, 0x754322, 1).setStrokeStyle(4, 0xf3d29a)
    .setDepth(depth).setInteractive({ useHandCursor: true });
  const text = scene.add.text(x, sub ? y - h * 0.17 : y, label, {
    fontFamily: FONT, fontSize: fontSize + 'px', color: '#ffffff',
    stroke: '#3a2412', strokeThickness: Math.round(fontSize / 6),
  }).setOrigin(0.5).setDepth(depth + 1);
  const objects = [bg, text];
  if (sub) {
    objects.push(scene.add.text(x, y + h * 0.25, sub, {
      fontFamily: FONT, fontSize: '20px', color: '#ffe9b8', align: 'center', wordWrap: { width: w - 40 },
    }).setOrigin(0.5).setDepth(depth + 1));
  }
  bg.on('pointerdown', () => {
    scene.tweens.add({ targets: [bg, text], scale: 0.96, duration: 70, yoyo: true });
    onTap();
  });
  return objects;
}

// Plans the shuffle of a batch of `count` new tiles as a list of swaps [i, j] (indexes into the batch).
// - N tiles give N - 1 swaps (3 tiles = 2 swaps, 4 = 3, 5 = 4 ...), performed one after another.
// - Chain rule: each newly involved tile swaps with a tile that has already been shuffled (A<->B, then C<->A or B).
// - Already shuffled tiles can be shuffled again; once everyone is involved, the remaining swaps re-shuffle them.
// - Each tile has a ~10% chance to sit out, but at least min(count, 3) tiles always take part.
function planShuffle(count, rng = Math.random, skipChance = SHUFFLE_SKIP_CHANCE) {
  if (count < 2) return { steps: [], skipped: [] };
  const order = [];
  for (let i = 0; i < count; i++) order.push(i);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const minPlayers = Math.min(count, 3);
  const players = [];
  const skipped = [];
  for (const i of order) (rng() < skipChance ? skipped : players).push(i);
  while (players.length < minPlayers) players.push(skipped.pop());

  const pick = (list) => list[Math.floor(rng() * list.length)];
  const steps = [[players[0], players[1]]];
  const involved = [players[0], players[1]];
  for (let k = 2; k < players.length; k++) {
    steps.push([players[k], pick(involved)]);
    involved.push(players[k]);
  }
  while (steps.length < count - 1) {
    const last = steps[steps.length - 1];
    let a, b;
    do { a = pick(involved); b = pick(involved); }
    while (a === b || (involved.length > 2 && ((a === last[0] && b === last[1]) || (a === last[1] && b === last[0]))));
    steps.push([a, b]);
  }
  return { steps, skipped };
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
// deadline (15s for the opening board, 5s for spawned tiles), independent of the turn clock.
// `shuffle` says whether the batch is shuffled after it flips face-down.
class RevealTracker {
  constructor(clock = Date.now) {
    this.clock = clock;
    this.batches = [];
  }
  add(tiles, ms, shuffle = false) { this.batches.push({ tiles, shuffle, endsAt: this.clock() + ms }); }
  // Pending batches will still flip face-down, but will no longer be shuffled.
  cancelShuffles() { this.batches.forEach((b) => { b.shuffle = false; }); }
  // Longest time left among the batches still being shown (0 when nothing is being revealed).
  remaining() {
    const now = this.clock();
    return this.batches.reduce((most, b) => Math.max(most, b.endsAt - now), 0);
  }
  // Batches ({ tiles, shuffle }) whose reveal time is over; they are removed from the tracker.
  takeDue() {
    const now = this.clock();
    const due = this.batches.filter((b) => b.endsAt <= now);
    this.batches = this.batches.filter((b) => b.endsAt > now);
    return due;
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

// Starts loading the custom font right away (in parallel with Phaser and the art). A slow or failed
// font load never blocks the game for more than 2.5 seconds.
const fontReady = Promise.race([
  document.fonts.load(`20px ${FONT}`),
  new Promise((resolve) => setTimeout(resolve, 2500)),
]).catch(() => {});

// Stage 1: fetches only the logo and the loading bar (two small images), while the HTML placeholder is still up.
class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload() {
    this.load.setPath('assets');
    this.load.image('logo', 'ui/shapey logo.webp');
    this.load.image('loadRect', 'ui/load rectangle.webp');
  }

  create() {
    this.scene.start('LoadScene');
  }
}

// Stage 2: shows the logo and the load bar (Phaser draws the same picture as index.html), then loads
// everything else while the bar fills.
class LoadScene extends Phaser.Scene {
  constructor() {
    super('LoadScene');
  }

  preload() {
    this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x2b1a0f);
    const logo = this.add.image(GAME_WIDTH / 2, LOGO_Y, 'logo');
    logo.setScale(LOGO_W / logo.width);

    const bar = this.add.image(GAME_WIDTH / 2, LOAD_BAR_Y, 'loadRect');
    const k = LOAD_BAR_W / bar.width;
    bar.setScale(k);
    const left = bar.x - bar.displayWidth / 2;
    const top = bar.y - bar.displayHeight / 2;
    const slotX = left + LOAD_TRACK.x0 * bar.displayWidth;
    const slotW = (LOAD_TRACK.x1 - LOAD_TRACK.x0) * bar.displayWidth;
    const slotY = top + LOAD_TRACK.y0 * bar.displayHeight;
    const slotH = (LOAD_TRACK.y1 - LOAD_TRACK.y0) * bar.displayHeight;
    // gold fill with a lighter top half for a glossy look; both grow with the load progress
    const fill = this.add.rectangle(slotX, slotY, slotW * LOAD_MIN_FILL, slotH, 0xf2b84b).setOrigin(0, 0);
    const gloss = this.add.rectangle(slotX, slotY, slotW * LOAD_MIN_FILL, slotH * 0.45, 0xffe3a0, 0.7).setOrigin(0, 0);
    const setProgress = (value) => {
      const w = slotW * (LOAD_MIN_FILL + (1 - LOAD_MIN_FILL) * value);
      fill.width = w;
      gloss.width = w;
    };
    this.load.on('progress', setProgress);

    // the load animation: the logo gently bobs and the fill pulses while the game downloads
    this.tweens.add({ targets: logo, y: LOGO_Y - 8, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    this.tweens.add({ targets: [fill, gloss], alpha: { from: 0.75, to: 1 }, duration: 500, yoyo: true, repeat: -1 });

    // Hand over from the HTML placeholder only once this scene has been drawn, so there is no blank flash.
    const boot = document.getElementById('boot');
    if (boot) this.game.events.once('postrender', () => requestAnimationFrame(() => boot.remove()));

    this.load.setPath('assets');

    // backgrounds
    this.load.image('bg', 'backgrounds/BG.webp');
    this.load.image('headerShadow', 'backgrounds/header shadow.webp');
    this.load.image('headerPlank1', 'backgrounds/header  plank 1.webp'); // two spaces in the filename
    this.load.image('trayShadow', 'backgrounds/Tray Shadow.webp');
    this.load.image('tray', 'backgrounds/tray.webp');
    this.load.image('bottomNav', 'backgrounds/bottom navigation.webp');

    // ui
    this.load.image('playerPlank1', 'ui/player plank.webp');
    this.load.image('playerPlank2', 'ui/player plank 2.webp');
    this.load.image('timerPlank', 'ui/timer plank.webp');
    this.load.image('starIcon', 'ui/Star.webp');
    this.load.image('btnSettings', 'ui/settings.webp');
    this.load.image('btnSubmit', 'ui/submit.webp');
    this.load.image('btnPolls', 'ui/polls.webp');
    this.load.image('btnInventory', 'ui/inventory.webp');

    // shapes
    for (const [key, file] of Object.entries(SHAPE_FILES)) {
      this.load.image('shape_' + key, 'shapes/' + file);
    }

    // fx + audio
    this.load.image('tileDestroy', 'fx/tile destroy frame.webp');
    this.load.image('dust', 'fx/dusty.webp');
    this.load.audio('flip', ['audio/tile_flip_short.ogg', 'audio/tile_flip_short.wav']);
  }

  async create() {
    await fontReady; // usually already done by now
    if (START_MODE) this.scene.start('GameScene', { mode: START_MODE });
    else this.scene.start('MenuScene');
  }
}

// Mode picker, shown before the game starts.
class MenuScene extends Phaser.Scene {
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
        () => {
          if (cfg.ai) this.openDifficulty();
          else if (mode === 'pvp' || mode === 'tag') this.openOnlineLobby(mode);
          else this.scene.start('GameScene', { mode });
        }, 10, cfg.hint);
    });
  }

  // Room creation and joining are attached to Player 1 vs Player 2 and Tag.
  openOnlineLobby(mode) {
    if (this.onlineUI && this.onlineUI.length) return;
    this.onlineMode = mode || 'pvp';
    this.onlineUI = [];
    const add = (object) => { this.onlineUI.push(object); return object; };
    const modeTitle = this.onlineMode === 'tag' ? 'ONLINE TAG · 2 VS 2' : 'ONLINE PLAYER 1 VS PLAYER 2';
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
      : 'Two devices. Take alternating turns; the first player to 100 points wins.';
    this.onlineStatus = add(this.add.text(GAME_WIDTH / 2, 415,
      lobbyInstructions, {
        fontFamily: FONT, fontSize: '23px', color: '#fff2c7', align: 'center',
        wordWrap: { width: 560 }, stroke: '#3a2412', strokeThickness: 4,
      }).setOrigin(0.5).setDepth(82));
    this.onlineRoomCodeText = add(this.add.text(GAME_WIDTH / 2, 520, '', {
      fontFamily: FONT, fontSize: '54px', color: '#ffe36e', align: 'center',
      stroke: '#3a2412', strokeThickness: 8, letterSpacing: 8,
    }).setOrigin(0.5).setDepth(83));

    woodButton(this, GAME_WIDTH / 2, 710, 530, 88, 'CREATE ROOM', 36,
      () => this.createOnlineRoom(), 82, 'Generate a shareable room code').forEach(add);
    woodButton(this, GAME_WIDTH / 2, 810, 530, 88, 'JOIN ROOM', 36,
      () => this.promptJoinRoom(), 82, 'Enter a friend’s room code').forEach(add);
    woodButton(this, GAME_WIDTH / 2, 935, 530, 78, 'BACK', 33,
      () => this.closeOnlineLobby(), 82).forEach(add);
  }

  setOnlineStatus(message) {
    if (this.onlineStatus && this.onlineStatus.active) this.onlineStatus.setText(message);
  }

  showOnlineRoomCode(code) {
    this.currentRoomCode = code;
    if (this.onlineRoomCodeText && this.onlineRoomCodeText.active) this.onlineRoomCodeText.setText(code);
    if (!this.onlineCopyUI || !this.onlineCopyUI.length) {
      this.onlineCopyUI = woodButton(this, GAME_WIDTH / 2, 600, 390, 68, 'COPY ROOM CODE', 28,
        () => this.copyOnlineRoomCode(), 84);
      this.onlineCopyUI.forEach((object) => this.onlineUI.push(object));
      this.onlineCopyLabel = this.onlineCopyUI[1];
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
        body: JSON.stringify({ mode: this.onlineMode }),
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

  async promptJoinRoom() {
    const entered = window.prompt('Enter your friend’s 6-character room code:');
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
  }

  // "Choose difficulty" panel for Player vs AI (Easy / Professional, built from AI_LEVELS).
  openDifficulty() {
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
        () => this.scene.start('GameScene', { mode: 'ai', difficulty }), 52, level.hint).forEach(add);
    });
    woodButton(this, GAME_WIDTH / 2, 530 + Object.keys(AI_LEVELS).length * 190, 560, 90, 'BACK', 36,
      () => this.closeDifficulty(), 52).forEach(add);
  }

  closeDifficulty() {
    this.pickerUI.forEach((object) => object.destroy());
    this.pickerUI = [];
  }
}

class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
  }

  init(data) {
    this.online = Boolean(data && data.online);
    this.onlineSocket = (data && data.onlineSocket) || null;
    this.onlinePlayerNumber = (data && data.onlinePlayerNumber) || null;
    this.onlineRoomCode = (data && data.onlineRoomCode) || null;
    this.onlineState = (data && data.onlineState) || null;
    this.mode = (data && data.mode) || START_MODE || 'pvp';
    this.modeCfg = MODES[this.mode];
    // Player vs AI difficulty comes from the picker (or ?level=pro for testing); Easy is the default.
    const level = (data && data.difficulty) || urlParams.get('level');
    this.difficulty = AI_LEVELS[level] ? level : 'easy';
    this.ai = AI_LEVELS[this.difficulty];
    this.turnDurationMs = RULES.turnDurationForMode(
      this.mode, this.difficulty, TURN_MS, urlParams.has('turn') ? TURN_MS : 30000
    );
  }

  create() {
    this.scores = [0, 0];      // one score per player
    this.activePlayer = 0;     // 0 = Player 1, 1 = Player 2
    this.selection = [];      // actual shapes picked for the current attempt
    this.dummySelection = [];  // Dummies stay face-up during the attempt but never count as shapes
    this.selectedShape = null; // the shape the current attempt is matching
    this.busy = false;        // true while animations run (input is ignored)
    this.names = this.modeCfg.teams ? ['TEAM 1', 'TEAM 2']
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
    this.totalAttempts = 0;          // Play Alone statistic only; never a loss condition
    this.aiMemory = new Map();       // tile -> shape the AI believes it is
    this.aiRecall = this.ai.recall[0] + Math.random() * (this.ai.recall[1] - this.ai.recall[0]);
    this.starBalance = this.loadStarBalance();
    this.inventoryItems = this.loadInventoryItems();
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

    this.createBackground();
    this.createHeader();
    this.createBottomButtons();
    this.createFx();
    this.createBoard();
    if (this.online) {
      this.attachOnlineSocket();
      this.showToast('Online match connected. Waiting for the server state.', 3200);
      this.events.once('shutdown', () => {
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
        this.showToast('Tag: partners tag in on every other turn.\\n' + this.turnLabel() + ' starts.', 4000);
      }
    }
  }

  // Runs every frame: flips tiles whose reveal is over, redraws both clocks, and ends the turn on timeout.
  update() {
    if (!this.turnClock) return;
    if (!this.online) {
      this.hideFinishedReveals();
      this.healStuckTiles();
    }
    this.refreshClocks();
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
    this.goalText.setText('LOSE AT ' + ALONE_SCORE_FLOOR);
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
    const turnLeft = this.modeCfg.turnClock
      ? formatClock(Math.min(this.currentTurnDurationMs || this.turnDurationMs, this.turnClock.remaining())) : '';
    if (this.modeCfg.turnClock) this.setClockText(this.timerText, turnLeft);

    const revealLeft = this.online && this.onlineState
      ? Math.max(0, ...((this.onlineState.reveals || []).map((batch) => batch.endsAt - Date.now())),
          this.onlineState.status === 'study' && Number.isFinite(this.onlineState.reviewEndsAt)
            ? this.onlineState.reviewEndsAt - Date.now() : 0)
      : this.reveals.remaining();
    const onlineShuffling = Boolean(this.online && this.onlineState && this.onlineState.shuffling);
    this.revealText.setVisible(revealLeft > 0 || this.shuffling > 0 || onlineShuffling);
    // Play alone has no countdown at all: the cue stays, the numbers go.
    if (revealLeft > 0) this.setClockText(this.revealText, this.modeCfg.turnClock ? 'MEMORIZE ' + formatClock(revealLeft) : 'MEMORIZE');
    else if (this.shuffling > 0 || onlineShuffling) this.setClockText(this.revealText, 'SHUFFLING');

    // The shop covers the header, so it shows the turn clock too: opening it never stops the clock.
    if (this.inventoryTimerText && this.inventoryTimerText.active) {
      this.setClockText(this.inventoryTimerText, 'TURN\n' + turnLeft);
    }
  }

  // `player` is the side that plays (0 or 1; a team in Tag). Scores, planks and the AI all work per side.
  startTurn(player, options = {}) {
    const bonus = options.bonus === true;
    this.activePlayer = player;
    if (!bonus) this.turnNumber++;
    // Tag normal turns rotate partners: P1 → P3 → P2 → P4. A Double Play bonus repeats the same partner.
    this.activeMember = this.modeCfg.teams ? RULES.tagMemberForTurn(this.turnNumber) : 0;
    this.isBonusTurn = bonus;
    this.turnEnding = false;
    this.timeoutHandling = false;
    this.turnId++;
    // Play Alone has no countdown. Professional AI matches use 30 seconds per turn; other versus turns use 45.
    const duration = bonus ? TURN_MS : this.turnDurationMs;
    this.currentTurnDurationMs = duration;
    if (this.modeCfg.turnClock) {
      this.turnClock.start(duration + (this.turnNumber === 0 && !bonus ? REVIEW_MS : 0));
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
  async endTurn(reason) {
    if (this.turnEnding || this.gameOver) return;
    this.turnEnding = true; // from here on, late taps and submits are ignored
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
      this.showToast(this.turnLabel() + ' gets a Double Play bonus turn!');
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
      : reason === 'hazard' ? 'Hazard! No reward. '
      : reason === 'mismatch' ? 'Mismatch. '
      : reason === 'submit' ? 'Turn submitted. ' : '';
    this.showToast(prefix + this.turnLabel() + '’s turn');
  }

  createStars(startX, y, count) {
    // One star icon plus a multiplier keeps the score plank uncluttered: ⭐*5, ⭐*2, etc.
    const star = this.add.image(startX, y, 'starIcon').setDisplaySize(30, 30).setDepth(10);
    const multiplier = this.numberText(startX + 33, y, '*' + count, 23).setColor('#ffe36e');
    return [star, multiplier];
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

    // Settings opens a small menu: resume, restart or go back to the mode picker.
    const settings = this.buttons.btnSettings;
    settings.setInteractive({ useHandCursor: true });
    settings.on('pointerdown', () => this.openPanel());

    // Inventory opens the shop/inventory page.
    const inventory = this.buttons.btnInventory;
    inventory.setInteractive({ useHandCursor: true });
    inventory.on('pointerdown', () => this.openInventory());
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
      () => this.online ? this.leaveOnlineMatch() : this.scene.restart({ mode: this.mode, difficulty: this.difficulty }), 252).forEach(add);
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
      // A new local profile gets one free Audience Pick. A saved zero means it was already used.
      if (!Object.prototype.hasOwnProperty.call(items, 'audiencePick')) items.audiencePick = 1;
      try { window.localStorage.setItem('shapey-inventory', JSON.stringify(items)); } catch (_) {}
      return items;
    } catch (_) {
      return { audiencePick: 1 };
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
      this.p1Stars[1].setText('*' + this.starBalance);
    }
    if (this.p2Stars && this.p2Stars[1] && this.p2Stars[1].active) {
      this.p2Stars[1].setText('*' + (this.modeCfg.ai ? 0 : this.starBalance));
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

    const balance = this.add.text(GAME_WIDTH / 2, 128, 'YOUR STARS: *' + this.starBalance, {
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
      { key: 'audiencePick', name: 'AUDIENCE PICK', price: 3, desc: 'Use your poll lifeline to get a practice audience recommendation.' },
      { key: 'extraTime', name: 'EXTRA TIME (+45s)', price: 3, desc: 'Add 45 seconds to the current turn each time you use one.' },
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

      if (this.online && !['extraTime', 'doublePlay'].includes(offer.key)) {
        const notice = this.add.text(554, y - 5, 'COMING SOON\\nONLINE', {
          fontFamily: FONT, fontSize: '18px', color: '#fff0c7', align: 'center',
        }).setOrigin(0.5);
        this.addInventoryUI(notice);
        return;
      }

      if (['audiencePick', 'extraTime', 'doublePlay'].includes(offer.key) && ownedCount > 0) {
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
            if (offer.key === 'audiencePick') {
              this.inventoryItems.audiencePick = count - 1;
              this.saveInventory();
              this.closeInventory();
              this.showAudiencePoll();
              return;
            }
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

  // Local Practice Audience: explicitly simulated votes, not live players or a guaranteed match.
  showAudiencePoll() {
    this.closeAudiencePoll();
    if (this.gameOver) return;
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
    add(this.add.text(GAME_WIDTH / 2, 365, 'AUDIENCE POLL', {
      fontFamily: FONT, fontSize: '48px', color: '#fff2c7',
      stroke: '#3a2112', strokeThickness: 8, align: 'center',
    }).setOrigin(0.5));
    add(this.add.text(GAME_WIDTH / 2, 420, 'PRACTICE AUDIENCE · SIMULATED VOTES', {
      fontFamily: FONT, fontSize: '20px', color: '#ffe36e', align: 'center',
      stroke: '#3a2112', strokeThickness: 4,
    }).setOrigin(0.5));

    const candidates = [];
    const pollCandidates = SHAPE_KEYS.filter((shape) => shape !== 'cancel');
    while (candidates.length < 4) {
      const shape = randomItem(pollCandidates);
      if (!candidates.includes(shape)) candidates.push(shape);
    }
    // Simulate 100 votes so the results look like a game-show audience poll.
    const weights = candidates.map(() => 0.15 + Math.random());
    const totalWeight = weights.reduce((sum, n) => sum + n, 0);
    const votes = weights.map((weight) => Math.round((weight / totalWeight) * 100));
    votes[0] += 100 - votes.reduce((sum, n) => sum + n, 0);
    const ranked = candidates.map((shape, i) => ({ shape, votes: votes[i] }))
      .sort((a, b) => b.votes - a.votes);
    add(this.add.text(GAME_WIDTH / 2, 470, 'TOP CHOICE: ' + ranked[0].shape.toUpperCase(), {
      fontFamily: FONT, fontSize: '28px', color: '#ffe36e',
      stroke: '#3a2112', strokeThickness: 5, align: 'center',
    }).setOrigin(0.5));

    ranked.forEach((item, i) => {
      const y = 545 + i * 75;
      add(this.add.text(86, y, item.shape.toUpperCase(), {
        fontFamily: FONT, fontSize: '20px', color: '#fff2c7',
        stroke: '#3a2112', strokeThickness: 4,
      }).setOrigin(0, 0.5));
      add(this.add.rectangle(280, y, 300, 24, 0x25180f, 1).setOrigin(0, 0.5));
      add(this.add.rectangle(280, y, Math.max(3, 3 * item.votes), 18, 0xd7a849, 1).setOrigin(0, 0.5));
      add(this.add.text(620, y, item.votes + '%', {
        fontFamily: FONT, fontSize: '22px', color: '#ffffff',
        stroke: '#3a2112', strokeThickness: 4, align: 'right',
      }).setOrigin(1, 0.5));
    });
    woodButton(this, GAME_WIDTH / 2, 885, 420, 82, 'CLOSE POLL', 30,
      () => this.closeAudiencePoll(), 252).forEach(add);
  }

  closeAudiencePoll() {
    if (this.pollUI) this.pollUI.forEach((object) => object.destroy());
    this.pollUI = [];
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

    if (this.online) {
      this.tiles = Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(null));
      this.onlineTilesById = new Map();
      this.applyOnlineState(this.onlineState, true);
      return;
    }

    const layout = makeInitialBoard(this.hazardChance);
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
      } else if (message.type === 'error') {
        this.showToast(message.message || 'The server rejected that action.', 3000);
      } else if (message.type === 'player_disconnected') {
        this.showToast('A player disconnected. Waiting for them to reconnect.', 3500);
      }
    });
    socket.addEventListener('close', () => {
      if (this.online && !this.gameOver) this.showToast('Connection lost. Return to the main menu and reconnect.', 4500);
    });
  }

  sendOnlineAction(action) {
    if (!this.online || !this.onlineSocket || this.onlineSocket.readyState !== WebSocket.OPEN) {
      this.showToast('You are disconnected. Please reconnect to the room.', 3000);
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
    const oldInventorySignature = this.onlineInventorySignature || '';
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
      this.starBalance = Math.max(0, Number(state.me.stars) || 0);
      this.inventoryItems = { ...(state.me.inventory || {}) };
      this.onlineInventorySignature = JSON.stringify({ stars: this.starBalance, inventory: this.inventoryItems });
      this.updateStarDisplays();
    }

    const previous = this.onlineTilesById || new Map();
    const nextById = new Map();
    const nextGrid = Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(null));
    for (const viewTile of (state.tiles || [])) {
      let tile = previous.get(viewTile.id);
      const targetX = this.cellX(viewTile.col);
      const targetY = this.cellY(viewTile.row);
      if (!tile || !tile.active) {
        tile = this.createOnlineTile(viewTile);
      } else {
        if (Math.abs(tile.x - targetX) > 0.5 || Math.abs(tile.y - targetY) > 0.5) {
          this.tweens.killTweensOf(tile);
          const moveDuration = viewTile.moving && Number.isFinite(viewTile.movingUntil)
            ? Math.max(0, viewTile.movingUntil - Date.now())
            : (initial ? 0 : 240);
          this.tweens.add({ targets: tile, x: targetX, y: targetY, duration: moveDuration, ease: 'Sine.easeInOut' });
          if (tile.ring) {
            this.tweens.killTweensOf(tile.ring);
            this.tweens.add({ targets: tile.ring, x: targetX, y: targetY, duration: moveDuration, ease: 'Sine.easeInOut' });
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
      if (oldTile.active) oldTile.destroy();
    }
    this.tiles = nextGrid;
    this.onlineTilesById = nextById;

    if (this.inventoryOpen && oldInventorySignature &&
        oldInventorySignature !== (this.onlineInventorySignature || '')) {
      this.renderInventory();
    }
    if (state.status === 'finished' && !this.gameOver) {
      this.activePlayer = Number.isInteger(state.winnerSide) ? state.winnerSide : this.activePlayer;
      this.endGame('First to ' + state.targetScore + ' points wins.');
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
      if (this.modeCfg.ai) [a, b].forEach((t) => { if (Math.random() < this.ai.forgetOnSwap) this.aiMemory.delete(t); });

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
    tile.ring.lineStyle(5, 0xffe066, 1);
    tile.ring.strokeRoundedRect(-43, -43, 86, 86, 14);
  }

  removeRing(tile) {
    if (tile.ring) { tile.ring.destroy(); tile.ring = null; }
  }

  onTileTap(tile, fromAI = false) {
    if (this.online) {
      if (!tile || !tile.active || !tile.serverId || this.gameOver ||
          tile.faceUp || tile.selected || tile.moving || tile.swapping) return;
      this.sendOnlineAction({ type: 'pick', tileId: tile.serverId });
      return;
    }
    // Taps are ignored during hand-over, once the turn clock has run out, after game over and while a
    // menu is open. Tiles in the middle of a swap can't be tapped, and a human can't tap during the AI's turn.
    if (this.busy || this.turnEnding || this.gameOver || this.turnClock.expired() || !tile.active || tile.selected || tile.swapping || tile.faceUp) return; // a face-up tile can't be picked: a shape is only revealed by the player's own flip
    if (!fromAI && (this.panelOpen || this.isAITurn())) return;

    this.aiSee(tile, fromAI); // the AI sees every tile that gets flipped over (certainly its own, only partly the human's)

    // A hazard flipped while other shapes are picked destroys them all (no reward); on its own it costs points.
    if (tile.shape === 'hazard') {
      // Dummies do not count as shapes or penalties. In versus, Dummy + Hazard destroys both for free;
      // only a previously picked real shape makes the Hazard a penalized blast.
      if (!this.modeCfg.twoPlayers || this.selection.length > 0 || this.dummySelection.length > 0) this.hazardBlast(tile);
      else this.hazardHit(tile);
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

    // Cancel + one or more Dummies is a neutral cancelled attempt: reveal Cancel, then flip both
    // it and the Dummies down without awarding or deducting points.
    if (tile.shape === 'cancel' && this.selection.length === 0 && this.dummySelection.length > 0) {
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
    // In versus modes a wrong pair ends the turn immediately. Play Alone remains continuous.
    if (this.modeCfg.twoPlayers && !this.gameOver) this.endTurn('mismatch');
  }

  // A hazard (skull) flipped after other shapes are picked: it costs HAZARD_BLAST_PENALTY point(s) (two-player
  // modes may go below 0, see TWO_PLAYER_SCORE_FLOOR) and the hazard and every picked tile are destroyed, with no reward. It never joins the
  // selection. Like a submitted match it spends the turn: the board falls and refills, the new tiles are
  // revealed and shuffled as usual, and play passes on. Play alone does not count it as an attempt.
  async hazardBlast(hazard) {
    this.busy = true;
    this.cancelShuffles(); // the board is about to change: stop any shuffle and settle the swap in progress
    const hadRealShapes = this.selection.length > 0;
    const tiles = [...this.selection, ...this.dummySelection, hazard];
    this.selection = [];
    this.dummySelection = [];
    this.selectedShape = null;
    hazard.selected = true; // nothing else may pick it while it is being destroyed
    await this.flipTile(hazard, true);
    const lost = this.modeCfg.twoPlayers && hadRealShapes ? this.applyPenalty(HAZARD_BLAST_PENALTY) : 0; // Dummies alone never trigger the penalty
    this.showToast('Hazard! It destroys everything you picked.\n' +
      (lost > 0 ? '−' + lost + ' point, no reward.' : 'No reward.'));
    this.tweens.add({ targets: hazard, angle: { from: -8, to: 8 }, duration: 70, yoyo: true, repeat: 3,
      onComplete: () => { if (hazard.active) hazard.setAngle(0); } });
    await this.sleep(900);
    await Promise.all(tiles.map((t) => t.flipChain)); // let any flips finish
    await this.destroyTiles(tiles);
    await this.cascade();
    this.busy = false;
    // A hazard is not an attempt: in Play Alone it costs nothing and does not increment the attempt statistic.
    this.endTurn('hazard');
  }

  // A hazard (skull) flipped first, with nothing picked: no damage. It is revealed, shakes and flips back, and
  // the turn goes on. (Play alone does not count it as an attempt.)
  async hazardHit(tile) {
    this.busy = true;
    await this.flipTile(tile, true);
    this.showToast('Hazard! Nothing was picked, so no damage.');
    this.tweens.add({ targets: tile, angle: { from: -8, to: 8 }, duration: 70, yoyo: true, repeat: 3,
      onComplete: () => { if (tile.active) tile.setAngle(0); } });
    await this.sleep(900);
    await this.resetSelection();
    if (tile.active) await this.flipTile(tile, false);
    this.busy = false;
    // (a hazard is not an attempt: no penalty of any kind)
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
  async submit(fromAI = false, forced = false) {
    if (this.online) {
      this.sendOnlineAction({ type: 'submit' });
      return;
    }
    // A late submit is normally ignored. Forced is used only by the turn deadline to resolve a pick.
    if (this.busy || this.turnEnding || this.gameOver || (this.turnClock.expired() && !forced)) return;
    if (!forced && !fromAI && (this.panelOpen || this.isAITurn())) return;

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
      }
      return;
    }

    this.cancelShuffles(); // the board is about to change: stop any shuffle and settle the swap in progress
    await Promise.all(tiles.map((t) => t.flipChain)); // let any flips finish
    this.selection = [];
    this.selectedShape = null;
    await this.resetDummies(); // Dummies never get destroyed or counted as part of a successful match.

    const points = RULES.scoreFor(tiles.length);
    this.addScore(points);
    await this.destroyTiles(tiles);
    await this.cascade();
    this.busy = false;
    if (this.modeCfg.twoPlayers && RULES.hasReachedTarget(this.scores[this.activePlayer], this.modeCfg.targetScore)) {
      this.endGame('First to ' + this.modeCfg.targetScore + ' points wins.');
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
    if (this.inventoryOpen) this.closeInventory();
    this.closePanel();
    const text = (y, message, size, color = '#ffffff') => this.add.text(GAME_WIDTH / 2, y, message, {
      fontFamily: FONT, fontSize: size + 'px', color, stroke: '#3a2412', strokeThickness: Math.round(size / 6),
      align: 'center', wordWrap: { width: 600 },
    }).setOrigin(0.5).setDepth(301);
    this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x120a05, 0.85)
      .setDepth(300).setInteractive();
    const versus = this.modeCfg.twoPlayers;
    text(330, versus ? this.names[this.activePlayer] + ' WINS!' : 'GAME OVER',
      76, versus ? '#ffe36e' : '#ff8a7a');
    text(450, reason, 32, '#fff2c7');
    const summary = versus
      ? this.names[0] + ': ' + this.scores[0] + '\n' + this.names[1] + ': ' + this.scores[1] +
        '\nTarget: ' + this.modeCfg.targetScore
      : 'Score: ' + this.scores[0] + '\nAttempts: ' + this.totalAttempts;
    text(600, summary, 40, '#ffe36e');
    woodButton(this, GAME_WIDTH / 2, 810, 500, 110, this.online ? 'NEW ONLINE ROOM' : 'PLAY AGAIN', 44,
      () => this.online ? this.leaveOnlineMatch() : this.scene.restart({ mode: this.mode, difficulty: this.difficulty }), 301);
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
    for (const row of this.tiles) for (const t of row) if (t && SHAPE_KEYS.includes(t.shape)) counts[t.shape] = (counts[t.shape] || 0) + 1;
    if (Object.values(counts).some((n) => n >= MIN_MATCH)) return;
    const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || SHAPE_KEYS[0];
    let need = MIN_MATCH - (counts[best] || 0);
    for (const tile of fresh) {
      if (need <= 0) break;
      if (tile.shape === best || tile.shape === 'hazard') continue; // never turn a hazard into a shape: default hazard chance is 10%
      tile.shape = best;
      tile.setTexture('shape_' + best); // still face-up at this point
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
    puff.setScale(DUST_SCALE);
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
  // tile that gets flipped. How much of that it keeps depends on the level (this.ai, from AI_LEVELS):
  // Easy remembers about half, sometimes wrongly; Professional remembers almost everything. Shuffled tiles
  // may be forgotten. Memory is kept per tile (not per grid cell), so it follows tiles as they fall.
  aiSee(tile, certain = false) {
    if (!this.modeCfg.ai || !tile.active) return;
    if (!certain && Math.random() > this.aiRecall) return;
    const slip = !certain && Math.random() < this.ai.mistake;
    this.aiMemory.set(tile, slip ? randomItem(SHAPE_KEYS) : tile.shape);
  }

  aiCanTap(tile) {
    return tile.active && !tile.selected && !tile.swapping && !tile.faceUp;
  }

  // Remembered, still available tiles of one shape.
  aiKnown(shape) {
    const list = [];
    for (const [tile, remembered] of this.aiMemory) {
      if (!tile.active) this.aiMemory.delete(tile);
      else if (remembered === shape && this.aiCanTap(tile)) list.push(tile);
    }
    return list;
  }

  // Remembered, still available tiles grouped by shape: one list per shape (never dummies or hazards).
  aiGroups() {
    const groups = {};
    for (const [tile, shape] of this.aiMemory) {
      if (!tile.active) { this.aiMemory.delete(tile); continue; }
      if (shape === 'dummy' || shape === 'hazard' || !this.aiCanTap(tile)) continue;
      (groups[shape] = groups[shape] || []).push(tile);
    }
    return Object.values(groups);
  }

  // A shape it remembers at least 3 of. Easy rarely goes for the biggest group; Professional always does.
  aiChooseGroup() {
    const ready = this.aiGroups().filter((list) => list.length >= MIN_MATCH);
    if (!ready.length) return null;
    ready.sort((a, b) => b.length - a.length);
    return Math.random() < this.ai.bestGroupChance ? ready[0] : randomItem(ready);
  }

  // A plausible guess: any hidden tile it doesn't remember as something else (and never a remembered dummy/hazard).
  // Professional starts a fresh attempt on a tile it has no memory of, where it can still learn something.
  aiGuess(shape = null) {
    const pool = [];
    for (const row of this.tiles) {
      for (const tile of row) {
        if (!tile || !this.aiCanTap(tile)) continue;
        const remembered = this.aiMemory.get(tile);
        if (remembered === 'dummy' || remembered === 'hazard') continue;
        if (shape && remembered && remembered !== shape) continue;
        pool.push(tile);
      }
    }
    if (!shape && this.ai.preferUnknown) {
      const unknown = pool.filter((tile) => !this.aiMemory.has(tile));
      if (unknown.length) return randomItem(unknown);
    }
    return pool.length ? randomItem(pool) : null;
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
    let group = alreadyPicking ? this.aiKnown(this.selectedShape) : this.aiChooseGroup();
    if (!alreadyPicking && !group && this.ai.followHunch) {
      // No full match remembered: start from the shape it remembers most copies of (two or more), so it
      // has fewer new tiles left to find.
      const partial = this.aiGroups().sort((a, b) => b.length - a.length)[0];
      if (partial && partial.length >= 2) group = partial;
    }
    const first = alreadyPicking
      ? (group.length ? randomItem(group) : (this.aiGuess(this.selectedShape) || this.aiGuess()))
      : (group ? group[0] : this.aiGuess());
    if (!first || !(await this.aiTap(first, alive))) return false;

    // How many tiles it reaches for: 5 (the 5+ score) for Professional, 3 or sometimes 4 for Easy.
    const goal = this.ai.goBig ? 5 : (Math.random() < 0.3 ? 4 : MIN_MATCH);
    while (alive() && (this.selection.length > 0 || this.dummySelection.length > 0)) {
      const have = this.selection.length;
      const known = have ? this.aiKnown(this.selectedShape) : [];
      // Once it has a match it only keeps going while it remembers more tiles of that shape and has time to spare.
      if (have >= MIN_MATCH && (have >= goal || !known.length || this.turnClock.remaining() < AI_SPARE_MS)) break;
      // Dummies do not count: if a shape is already selected, keep seeking that shape. If none is known,
      // make a plausible guess (and a genuine mismatch ends the AI's turn like any other player's).
      const next = have === 0 ? this.aiGuess()
        : (known.length ? randomItem(known) : (this.aiGuess(this.selectedShape) || this.aiGuess()));
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
    // Keep participating until the AI submits a match, makes a genuine mismatch, or its clock expires.
    // Neutral first-pick hazards and Dummy-only attempts do not prematurely consume its turn.
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

// The game starts immediately (the font and art load behind a progress bar), instead of waiting for the font first.
window.game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: '#2b1a0f',
  banner: false,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene, LoadScene, MenuScene, GameScene],
});
