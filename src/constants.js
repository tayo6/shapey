// Shapey - pure constants: layout, shapes, timers, AI levels, animation metrics.
// This module reads no window/document/URL state, so Node unit tests can import it freely.
// Values that depend on URL parameters, rules.js or the multiplayer service live in config.js.

export const GAME_WIDTH = 720;
export const GAME_HEIGHT = 1280;

// Move game messages into the free strip above the bottom navigation while a GIF is visible.
export const MEME_TOAST_Y = 1015;

export const FONT = 'HappySchool';
export const BOARD_SIZES = Object.freeze([5, 6, 7]);
export function normalizeBoardSize(value) {
  const size = Number(value);
  return BOARD_SIZES.includes(size) ? size : 7;
}
export const BASE_BOARD_SIZE = 7;
export const BASE_TILE_SIZE = 90;
export const BASE_TILE_PITCH = 91;

export const SHUFFLE_SKIP_CHANCE = 0.1;  // about 10% of new tiles sit the shuffle out
export const STUCK_UP_MS = 2500;         // a face-up tile with no reason to be face-up is flipped back down after this long
export const SHUFFLE_ARC_PX = 28;        // sideways bow of a swap path, so the two tiles pass each other instead of overlapping
export const MIN_MATCH = 3;          // smallest scoring match; points are calculated in src/rules.js

export const AI_TURN_MS = 5000; // every AI pick-turn has a fixed 5-second limit
// Anti-stalling: a player may open the inventory at most 2 times in any rolling 5 minutes.
// The turn clock keeps running while the inventory is open.
export const INVENTORY_OPEN_LIMIT = 2;

export const PLAYER_NAMES = ['Player 1', 'Player 2'];

// Play Alone survival rules: no attempt-based checkpoints.
export const ALONE_SCORE_FLOOR = -15;  // reaching this score is game over
export const ALONE_MISS_PENALTY = 1;   // a wrong shape costs this much (a too-small submit is free)

// ---- Game modes --------------------------------------------------------------
// hazard = chance that a tile is a hazard (skull) tile: the same ~10% in every mode. Test override: ?hazard=0.5
export const HAZARD_CHANCE = 0.1;

export const TEAM_PLAYERS = [['Player 1', 'Player 2'], ['Player 3', 'Player 4']]; // Tag: Team 1 and Team 2

// Hazards are bombs: they always destroy themselves and every picked shape.
// Only Play Alone loses 1 point for a Hazard; versus modes never subtract score for it.
export const HAZARD_BLAST_PENALTY = 1;
export const TWO_PLAYER_SCORE_FLOOR = -Infinity;

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
export const AI_LEVELS = {
  easy: { label: 'EASY', tag: 'Easy', hint: 'Forgets a lot, guesses often and plays slowly.',
          recall: [0.45, 0.6], mistake: 0.1, forgetOnSwap: 0.5,
          thinkMs: 1400, tapMs: [700, 1200], gapMs: 700, submitMs: 700, maxAttempts: 3,
          bestGroupChance: 0.2, goBig: false, followHunch: false, preferUnknown: false },
  pro:  { label: 'HARD', tag: 'Hard', hint: 'Remembers almost every tile and goes for the biggest match.',
          recall: [0.95, 1], mistake: 0.01, forgetOnSwap: 0.1,
          thinkMs: 900, tapMs: [450, 800], gapMs: 400, submitMs: 450, maxAttempts: 5,
          bestGroupChance: 1, goBig: true, followHunch: true, preferUnknown: true },
};
export const AI_SPARE_MS = 6000; // the AI stops reaching for a bigger match when this little of its turn is left

// texture key -> file in assets/shapes
export const SHAPE_FILES = {
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
export const SHAPE_KEYS = Object.keys(SHAPE_FILES).filter((k) => !['mystery', 'dummy', 'hazard'].includes(k));
// Cancel remains a spawnable special tile, but it is never a scoring/matchable shape.
export const MATCH_SHAPE_KEYS = SHAPE_KEYS.filter((shape) => shape !== 'cancel');
export const DUMMY_SPAWN_CHANCE = 0.08; // blank wooden tiles are occasional neutral decoys

// Frames of "tile destroy frame.webp" (x positions, each 256 x 241) - centred on the tile.
export const DESTROY_FRAME_X = [3, 292, 585, 877, 1172, 1467];

// Frames of "dusty.webp" - landing dust for new shapes: 7 equal 304 x 156 cells in a 2128 x 156 sheet.
// Every puff is centred on the same point (the middle of its base) and sits on the bottom edge of its cell,
// so the cloud grows in place instead of drifting sideways. (The original sheet had unevenly spaced puffs.)
export const DUST_FRAME_COUNT = 7;
export const DUST_FRAME_WIDTH = 304;
export const DUST_FRAME_HEIGHT = 156;
export const DUST_SCALE = 0.4;      // on-screen size: 304 x 156 art -> about 122 x 62 px
export const DUST_FRAME_RATE = 10;

// Shapey logo and the loading bar. index.html draws the same layout while Phaser is still downloading.
export const LOGO_W = 520, LOGO_Y = 470;
export const LOAD_BAR_W = 560, LOAD_BAR_Y = 720;
// The dark slot of "load rectangle staging.webp", as fractions of the image: the progress fill goes inside it.
export const LOAD_TRACK = { x0: 0.0664, x1: 0.9326, y0: 0.283, y1: 0.7123 };
export const LOAD_MIN_FILL = 0.06; // share of the slot that is already filled at 0%, so the bar never looks empty
