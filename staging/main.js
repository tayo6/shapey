// Shapey - a memory game with candy-crush style cascades.
// The game canvas is 720 x 1280 ("720p" width) and scales to fit any screen.
const RULES = window.ShapeyRules;
if (!RULES) throw new Error('Load src/rules.js before src/main.js.');

const GAME_WIDTH = 720;
const GAME_HEIGHT = 1280;

// Move game messages into the free strip above the bottom navigation while a GIF is visible.
const MEME_TOAST_Y = 1015;

const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('embed') === '1') document.body.classList.add('audience-embed');
// This file is published only under /staging/ and is pinned to the isolated test Worker.
// Keep the live site's src/main.js pointed at the production service until staging is approved.
const requestedApi = urlParams.get('api');
const MULTIPLAYER_API = /^http:\/\/(?:127\.0\.0\.1|localhost):8787$/i.test(requestedApi || '')
  ? requestedApi
  : 'https://shapey-multiplayer-staging.hellohuman100.workers.dev';

const FONT = 'HappySchool';
const BOARD_SIZES = Object.freeze([5, 6, 7]);
function normalizeBoardSize(value) {
  const size = Number(value);
  return BOARD_SIZES.includes(size) ? size : 7;
}
const BASE_BOARD_SIZE = 7;
const BASE_TILE_SIZE = 90;
const BASE_TILE_PITCH = 91;
// Updated for each match so smaller boards use the same full tray area as 7×7.
let TILE_SIZE = BASE_TILE_SIZE;
let TILE_PITCH = BASE_TILE_PITCH;
// These are set from the chosen staging test size before each board is created.
let GRID_COLS = normalizeBoardSize(urlParams.get('size'));
let GRID_ROWS = GRID_COLS;

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
// Opening board reveal: 15 seconds. Newly spawned tiles: 5 seconds.
// Pick clocks start after the opening reveal. Player vs AI: human gets 45s Easy / 30s Hard, AI gets 5s.
// Player 1 vs Player 2: 45s per player. Tag: 30s per player. Play Alone has no pick clock.
// Test overrides: ?turn=10000 (turn length) and ?invwindow=20000 (inventory window), in milliseconds.
const TURN_MS = Number(urlParams.get('turn')) || 45000;
const AI_TURN_MS = 5000; // every AI pick-turn has a fixed 5-second limit
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
// Staging win targets: first to 50 for Play Alone / PvAI / PvP; first team to 100 for Tag.
const MODE_TARGET_SCORE = Object.freeze({ alone: 50, ai: 50, pvp: 50, tag: 100 });
// teams = Tag mode: two teams of two share the device, and each team's partners take turns (see turnLabel()).
const MODES = {
  alone: { label: 'PLAY ALONE', hint: 'Reach ' + MODE_TARGET_SCORE.alone + ' points to win. Lose when your score reaches ' + ALONE_SCORE_FLOOR + '.',
           targetScore: MODE_TARGET_SCORE.alone, hazard: HAZARD_CHANCE, twoPlayers: false, turnClock: false, ai: false },
  ai:    { label: 'PLAYER VS AI', hint: 'First to ' + MODE_TARGET_SCORE.ai + ' points wins. Choose Easy or Professional.',
           targetScore: MODE_TARGET_SCORE.ai, hazard: HAZARD_CHANCE, twoPlayers: true, turnClock: true, ai: true },
  pvp:   { label: 'PLAYER 1 VS PLAYER 2', hint: 'Online 2-player match. First to ' + MODE_TARGET_SCORE.pvp + ' points wins.',
           targetScore: MODE_TARGET_SCORE.pvp, hazard: HAZARD_CHANCE, twoPlayers: true, turnClock: true, ai: false },
  tag:   { label: 'TAG: 2 VS 2', hint: 'Online team match · 2 vs 2. First team to ' + MODE_TARGET_SCORE.tag + ' points wins.',
           targetScore: MODE_TARGET_SCORE.tag, hazard: HAZARD_CHANCE, twoPlayers: true, turnClock: true, ai: false, teams: true },
};
const TEAM_PLAYERS = [['Player 1', 'Player 2'], ['Player 3', 'Player 4']]; // Tag: Team 1 and Team 2
const AUDIENCE_WATCH_CODE = /^[A-Z0-9]{6}$/.test(urlParams.get('watch') || '') ? urlParams.get('watch').toUpperCase() : '';
const START_MODE = ['alone', 'ai'].includes(urlParams.get('mode')) ? urlParams.get('mode') : null; // only local modes may skip the menu; online modes must use their room lobby
const HAZARD_OVERRIDE = RULES.parseProbabilityOverride(urlParams.get('hazard'), urlParams.has('hazard'));
// Hazards are bombs: they always destroy themselves and every picked shape.
// Only Play Alone loses 1 point for a Hazard; versus modes never subtract score for it.
const HAZARD_BLAST_PENALTY = 1;
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
  pro:  { label: 'HARD', tag: 'Hard', hint: 'Remembers almost every tile and goes for the biggest match.',
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
// Cancel remains a spawnable special tile, but it is never a scoring/matchable shape.
const MATCH_SHAPE_KEYS = SHAPE_KEYS.filter((shape) => shape !== 'cancel');
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
// The dark slot of "load rectangle staging.webp", as fractions of the image: the progress fill goes inside it.
const LOAD_TRACK = { x0: 0.0664, x1: 0.9326, y0: 0.283, y1: 0.7123 };
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

// Starting board: include at least three copies of each chosen scoring shape without
// overflowing the smaller staging boards. Every board size keeps about 10% hazards.
function makeInitialBoard(hazardChance = 0) {
  const total = GRID_ROWS * GRID_COLS;
  const wantedHazards = Math.min(total, Math.round(total * hazardChance));
  const guaranteedShapeCount = Math.min(MATCH_SHAPE_KEYS.length, Math.floor((total - wantedHazards) / 3));
  const startingShapes = shuffle(MATCH_SHAPE_KEYS).slice(0, guaranteedShapeCount);
  const bag = [];
  startingShapes.forEach((k) => bag.push(k, k, k));
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

// Styles for the room-code entry panel (MenuScene.askRoomCode). Same colours as the game's popups and wooden buttons:
// panel 0x4b2d17 with a gold border, dark slot 0x25180f, wood buttons 0x754322 with a sand border, outlined Happy School text.
const JOIN_MODAL_CSS = `
#shapey-join-modal { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center;
  padding: 16px; box-sizing: border-box; background: rgba(18, 10, 5, .84); font-family: ${FONT}, 'Comic Sans MS', cursive; }
#shapey-join-modal .panel { box-sizing: border-box; width: min(100%, 460px); padding: 26px 22px 22px; background: #4b2d17;
  border: 5px solid #d5ad72; display: flex; flex-direction: column; gap: 14px; text-align: center; }
#shapey-join-modal h2 { margin: 0; font-weight: normal; font-size: 34px; line-height: 1.1; color: #fff2c7;
  -webkit-text-stroke: .17em #3a2412; paint-order: stroke fill; stroke-linejoin: round; }
#shapey-join-modal p { margin: 0; font-size: 19px; line-height: 1.3; color: #ffe9b8; }
#shapey-join-modal input { box-sizing: border-box; width: 100%; height: 66px; padding: 0 12px; text-align: center; text-indent: .22em;
  font: inherit; font-size: 36px; letter-spacing: .22em; text-transform: uppercase; color: #ffe36e; background: #25180f;
  border: 4px solid #8b623a; border-radius: 0; outline: none; }
#shapey-join-modal input:focus { border-color: #ffe36e; }
#shapey-join-modal .err { min-height: 22px; font-size: 17px; line-height: 1.3; color: #ffb09e; }
#shapey-join-modal .row { display: flex; gap: 12px; }
#shapey-join-modal button { flex: 1; min-height: 58px; font: inherit; font-size: 26px; line-height: 1; color: #fff; background: #754322;
  border: 4px solid #f3d29a; border-radius: 0; cursor: pointer; -webkit-text-stroke: .17em #3a2412; paint-order: stroke fill;
  stroke-linejoin: round; transition: transform .07s; }
#shapey-join-modal button:active { transform: scale(.96); }
#shapey-join-modal button:focus-visible { outline: 3px solid #ffe36e; outline-offset: 2px; }
`;

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
  // Freeze the outgoing turn clock while the submitted move is being resolved.
  stop() { this.endsAt = this.clock(); }
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
  }

  create() {
    // Reuse the already-cleaned transparent canvas instead of loading the old corrupted WebP.
    this.textures.addCanvas('loadRect', window.ShapeyLoadingBar.canvas);
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
    if (AUDIENCE_WATCH_CODE) {
      this.startAudienceWatch();
      return;
    }
    if (START_MODE) this.scene.start('GameScene', { mode: START_MODE });
    else this.scene.start('MenuScene');
  }

  async startAudienceWatch() {
    const code = AUDIENCE_WATCH_CODE;
    // Audience links must use the audience wrapper so Chat, Polls, Settings and Back to game exist.
    // Direct ?watch= links otherwise opened the game canvas without audience navigation.
    if (urlParams.get('embed') !== '1') {
      const audienceUrl = new URL('audience.html', window.location.href);
      audienceUrl.searchParams.set('room', code);
      const hintedMode = urlParams.get('mode');
      if (hintedMode) audienceUrl.searchParams.set('mode', hintedMode);
      window.location.replace(audienceUrl.href);
      return;
    }
    const showError = (message) => {
      this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, 620, 300, 0x4b2d17, 0.98).setStrokeStyle(5, 0xd5ad72).setDepth(200);
      this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 45, message, {
        fontFamily: FONT, fontSize: '28px', color: '#fff2c7', align: 'center',
        stroke: '#3a2412', strokeThickness: 5, wordWrap: { width: 540 }
      }).setOrigin(0.5).setDepth(201);
    };
    const roomModeFor = (message) => message.mode || message.state?.mode || urlParams.get('mode') || 'pvp';
    const gameModeFor = (roomMode) => roomMode === 'tag' ? 'tag' : 'pvp';

    // Embedded audience page owns the single real WebSocket. The iframe receives the same
    // authorised spectator snapshots through postMessage, so each watcher counts only once.
    if (urlParams.get('embed') === '1') {
      class EmbeddedAudienceSocket extends EventTarget {
        constructor() {
          super();
          this.readyState = WebSocket.OPEN;
          this.parentMessageHandler = (event) => {
            if (event.source !== window.parent || event.origin !== window.location.origin ||
                event.data?.type !== 'shapey-audience-message') return;
            const message = event.data.message;
            if (message && typeof message.type === 'string') this.deliver(message);
          };
          window.addEventListener('message', this.parentMessageHandler);
          try { window.parent.postMessage({ type: 'shapey-audience-ready' }, window.location.origin); } catch {}
        }
        send(data) {
          try { window.parent.postMessage({ type: 'shapey-audience-socket-send', data }, window.location.origin); } catch {}
        }
        close() {
          this.readyState = WebSocket.CLOSED;
          window.removeEventListener('message', this.parentMessageHandler);
          try { this.dispatchEvent(new CloseEvent('close')); } catch {}
        }
        deliver(message) {
          try { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); } catch {}
        }
      }
      const socket = new EmbeddedAudienceSocket();
      let started = false;
      socket.addEventListener('message', (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        const isStartMessage = (message.type === 'spectator_welcome' || message.type === 'game_started' ||
          message.type === 'game_state') && Boolean(message.state);
        if (!started && isStartMessage) {
          const roomMode = roomModeFor(message);
          started = true;
          this.scene.start('GameScene', {
            mode: gameModeFor(roomMode),
            online: true,
            spectator: true,
            audienceMode: roomMode,
            onlineSocket: socket,
            onlineRoomCode: code,
            onlineState: message.state
          });
        } else if (!started && (message.type === 'error' || message.type === 'demo_ended')) {
          showError(message.message || 'This room is no longer available.');
        }
      });
      return;
    }

    // Direct watch links remain supported outside the embedded audience layout.
    try {
      const response = await fetch(MULTIPLAYER_API + '/api/rooms/' + code, { cache: 'no-store' });
      const details = await response.json();
      if (!response.ok) throw new Error(details.error || 'This room is no longer available.');
      const roomMode = details.mode || urlParams.get('mode') || 'pvp';
      const gameMode = gameModeFor(roomMode);
      const wsBase = MULTIPLAYER_API.replace(/^http/, 'ws');
      const socket = new WebSocket(wsBase + '/ws/' + code + '?mode=' + encodeURIComponent(roomMode) + '&role=spectator');
      let started = false;
      const handleMessage = (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        const isStartMessage = (message.type === 'spectator_welcome' || message.type === 'game_started' ||
          message.type === 'game_state') && message.state;
        if (message.type === 'error' && !started) {
          showError(message.message || 'Could not connect to this room.');
          try { socket.close(); } catch {}
          return;
        }
        if (!started && isStartMessage) {
          started = true;
          this.scene.start('GameScene', {
            mode: gameMode,
            online: true,
            spectator: true,
            audienceMode: roomMode,
            onlineSocket: socket,
            onlineRoomCode: code,
            onlineState: message.state
          });
        } else if (started) {
          // GameScene registered its message handler after this callback; future messages are
          // handled there once the transition has completed.
        }
      };
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'spectate' })));
      socket.addEventListener('message', handleMessage);
      socket.addEventListener('error', () => { if (!started) showError('Could not connect to the room. Return to Live Games and try again.'); });
      socket.addEventListener('close', () => { if (!started) showError('The room connection closed. Return to Live Games and try again.'); });
    } catch (error) {
      showError(error.message || 'Could not open this room.');
    }
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
        () => this.openBoardSize(mode), 10, cfg.hint);
    });

    // Spectating is deliberately separated from playable modes: it is a darker, secondary panel (the same brown fill
    // and gold border the game's popups use) instead of the bright wood of the four playable modes.
    const audienceButton = woodButton(this, GAME_WIDTH / 2, 1228, 620, 76, 'WATCH LIVE GAMES', 32,
      () => this.openAudienceDirectory(), 10, 'SPECTATOR AREA · WATCH ONLY · NO GAME MOVES');
    audienceButton[0].setFillStyle(0x4b2d17, 1).setStrokeStyle(4, 0xd5ad72);
    audienceButton[1].setColor('#fff2c7');
  }

  // Every staging mode uses the same three board-size choices. 7×7 remains the default.
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
    add(this.add.text(GAME_WIDTH / 2, 430, 'Staging test · choose the number of rows and columns', {
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

class GameScene extends Phaser.Scene {
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
    GRID_COLS = this.boardSize;
    GRID_ROWS = this.boardSize;
    const boardScale = BASE_BOARD_SIZE / this.boardSize;
    TILE_PITCH = BASE_TILE_PITCH * boardScale;
    // Keep the original 1px gap: all board sizes then occupy the same 636px visual footprint.
    TILE_SIZE = TILE_PITCH - (BASE_TILE_PITCH - BASE_TILE_SIZE);
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
    this.aiMemory = new Map();       // tile -> shape the AI believes it is
    this.aiRecall = this.ai.recall[0] + Math.random() * (this.ai.recall[1] - this.ai.recall[0]);
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

    // Meme commentary (staging/memes.js). Optional: the game plays the same without it.
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
  async endTurn(reason) {
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
      : reason === 'hazard' ? 'Hazard! No reward. '
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
    const supportsAudiencePolling = this.mode !== 'alone';
    const actions = this.mode === 'alone'
      ? ['settings', 'submit']
      : supportsAudiencePolling
        ? ['settings', 'submit', 'polls', 'inventory']
        : ['settings', 'submit', 'inventory'];
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

    // Both online modes can ask the audience to choose a hidden tile directly on the shared board.
    const polls = this.buttons.btnPolls;
    if (polls) {
      polls.setInteractive({ useHandCursor: true });
      polls.on('pointerdown', () => {
        if (this.mode !== 'alone' && !this.panelOpen && !this.inventoryOpen) this.showAudiencePoll();
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

  // Each non-Play-Alone player gets three free polls per game. Online uses are enforced by the Worker;
  // Player-vs-AI uses its clearly labelled practice audience.
  showAudiencePoll() {
    this.closeAudiencePoll();
    if (this.gameOver) return;
    if (this.mode === 'alone') {
      this.showToast('Audience polls are not available in Play Alone.', 2200);
      return;
    }
    if (this.isAITurn()) {
      this.showToast('Audience polls are available to the human player, not the AI.', 2200);
      return;
    }
    if (this.getAudiencePollsRemaining() <= 0) {
      this.showToast('You have used all 3 free audience polls for this game.', 2600);
      return;
    }
    if (this.online) {
      if ((this.mode !== 'pvp' && this.mode !== 'tag') ||
          !this.onlineSocket || this.onlineSocket.readyState !== WebSocket.OPEN) {
        this.showToast('Live audience polling requires a connected Player 1 vs Player 2 or Tag room.', 2500);
        return;
      }
      if (this.onlineState && this.onlineState.activePlayerNumber !== this.onlinePlayerNumber) {
        this.showToast('You can use an audience poll during your own turn.', 2200);
        return;
      }
      this.onlineSocket.send(JSON.stringify({ type: 'audience_poll_start' }));
      this.showToast('Opening a live poll for spectators…', 1800);
      return;
    }
    const slot = this.limiterSlot();
    this.audiencePollsUsedByPlayer.set(slot, this.getAudiencePollsUsed() + 1);
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
    // Like the TV lifeline, the options keep their A-D order and the top choice is called out above them.
    const ranked = candidates.map((shape, i) => ({ shape, votes: votes[i] }));
    const top = ranked.reduce((best, item) => (item.votes > best.votes ? item : best), ranked[0]);
    add(this.add.text(GAME_WIDTH / 2, 470, 'TOP CHOICE: ' + top.shape.toUpperCase(), {
      fontFamily: FONT, fontSize: '28px', color: '#ffe36e',
      stroke: '#3a2112', strokeThickness: 5, align: 'center',
    }).setOrigin(0.5));

    ranked.forEach((item, i) => {
      const y = 545 + i * 75;
      add(this.add.text(86, y, String.fromCharCode(65 + i) + '  ' + item.shape.toUpperCase(), {
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
      this.hazardBlast(tile);
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
  async hazardBlast(hazard) {
    this.busy = true;
    this.cancelShuffles();
    const tiles = [...this.selection, ...this.dummySelection, hazard];
    this.selection = [];
    this.dummySelection = [];
    this.selectedShape = null;
    hazard.selected = true;
    await this.flipTile(hazard, true);
    const lost = this.modeCfg.twoPlayers ? 0 : this.applyPenalty(HAZARD_BLAST_PENALTY);
    this.showToast('Hazard! It destroys everything you picked.\n' +
      (lost > 0 ? '−' + lost + ' point, no reward.' : 'No reward.'));
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
    this.endTurn('hazard');
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
      if (shape === 'dummy' || shape === 'hazard' || shape === 'cancel' || !this.aiCanTap(tile)) continue;
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
        if (remembered === 'dummy' || remembered === 'hazard' || remembered === 'cancel') continue;
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

// Start Phaser once the clean loading-bar image is ready. The HTML placeholder remains visible
// while its checkerboard background is removed, so both loading screens use the same clean artwork.
window.ShapeyLoadingBar.ready.then(() => {
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
});
