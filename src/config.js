// Shapey - environment-resolved configuration.
// Everything here depends on the page: URL parameters, src/rules.js (loaded as a classic
// script before this module), the staging override (window.SHAPEY_ENV) and the multiplayer
// Worker API. Pure numbers live in constants.js. Browser-only - not for Node tests.

import { normalizeBoardSize, BASE_BOARD_SIZE, BASE_TILE_SIZE, BASE_TILE_PITCH, ALONE_SCORE_FLOOR, HAZARD_CHANCE, LAYOUTS } from './constants.js';
import { resolveMultiplayerApi } from './game/api-environment.js';
import { testOverridesAllowed, readNumericOverride } from './game/test-overrides.js';

export const RULES = window.ShapeyRules;
if (!RULES) throw new Error('Load src/rules.js before src/main.js.');

export const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('embed') === '1') document.body.classList.add('audience-embed');

// The staging page (staging/index.html) sets window.SHAPEY_ENV = { staging: true } before this module
// loads, so it can relax host checks for testing. Production pages leave it unset.
export const STAGING = Boolean(typeof window !== 'undefined' && window.SHAPEY_ENV && window.SHAPEY_ENV.staging);

// Vertical layout preset (see LAYOUTS in constants.js). Every page keeps the 'classic' layout unless it asks
// for another one: ?layout=roomy|classic in the URL wins, then window.SHAPEY_ENV.layout (set by
// staging/layout-preview.html). The layout is cosmetic only - it never changes rules or online play.
const requestedLayout = urlParams.get('layout') || (window.SHAPEY_ENV && window.SHAPEY_ENV.layout);
export const LAYOUT_NAME = Object.prototype.hasOwnProperty.call(LAYOUTS, requestedLayout) ? requestedLayout : 'classic';
export const LAYOUT = LAYOUTS[LAYOUT_NAME];

// Live pages use the production Worker. Staging pages use the isolated staging Worker.
// Only approved local development contexts may override this with ?api=http://127.0.0.1:8787.
const apiResolution = resolveMultiplayerApi({
  staging: STAGING,
  requestedApi: urlParams.get('api'),
  localApiAllowed: STAGING || ['localhost', '127.0.0.1'].includes(window.location.hostname),
});
export const API_OVERRIDDEN = apiResolution.overridden;
export const MULTIPLAYER_API = apiResolution.api;

// Live board metrics: smaller boards scale up their tiles so every board size fills the same tray
// area as 7×7. GameScene.init applies the chosen board size through setBoardMetrics(); the exported
// live bindings above update everywhere they are read. Initial value: the ?size= override or 7×7.
export let TILE_SIZE = BASE_TILE_SIZE;
export let TILE_PITCH = BASE_TILE_PITCH;
export let GRID_COLS = normalizeBoardSize(urlParams.get('size'));
export let GRID_ROWS = GRID_COLS;
export function setBoardMetrics(boardSize) {
  const boardScale = BASE_BOARD_SIZE / boardSize;
  GRID_COLS = boardSize;
  GRID_ROWS = boardSize;
  TILE_PITCH = BASE_TILE_PITCH * boardScale;
  // Keep the original 1px gap: all board sizes then occupy the same 636px visual footprint.
  TILE_SIZE = TILE_PITCH - (BASE_TILE_PITCH - BASE_TILE_SIZE);
}

// ---- Game rules -----------------------------------------------------------
// Timing overrides are deliberately restricted to staging and localhost. Normal play on
// the live site cannot shorten reveals or turn clocks by editing the page URL.
export const TEST_OVERRIDES_ENABLED = testOverridesAllowed({
  staging: STAGING,
  hostname: window.location.hostname,
});
const numericTestOverride = (key, fallback, min, max) =>
  readNumericOverride(urlParams, key, fallback, TEST_OVERRIDES_ENABLED, { min, max });

export const REVIEW_MS = numericTestOverride('review', 15000, 1000, 60000);
// Tiles spawned after a match are shown briefly, then flip face-down and shuffle places.
export const SPAWN_REVEAL_MS = numericTestOverride('reveal', 5000, 500, 30000);
export const SHUFFLE_STEP_MS = numericTestOverride('swap', 2000, 100, 10000);

// ---- Turn clock and inventory limits ----------------------------------------
// Opening board reveal: 15 seconds. New tiles: 5 seconds. AI turns: 5 seconds.
// Player vs AI: human gets 45s Easy / 30s Professional. PvP: 45s. Tag: 30s.
// Play Alone has no pick clock. Overrides are only enabled on staging and localhost.
export const TURN_MS = numericTestOverride('turn', 45000, 1000, 60000);
export const INVENTORY_WINDOW_MS = numericTestOverride('invwindow', 5 * 60 * 1000, 1000, 60 * 60 * 1000);
export const formatInventoryWindow = () => INVENTORY_WINDOW_MS % 60000 === 0
  ? INVENTORY_WINDOW_MS / 60000 + ' min' : INVENTORY_WINDOW_MS / 1000 + ' s';

// Win targets come from src/rules.js (50 for Play Alone / PvAI / PvP; 100 for a Tag team), so the game,
// the rule tests and the README all agree.
export const MODE_TARGET_SCORE = Object.freeze({
  alone: RULES.targetScoreForMode('alone'), ai: RULES.targetScoreForMode('ai'),
  pvp: RULES.targetScoreForMode('pvp'), tag: RULES.targetScoreForMode('tag'),
});
// teams = Tag mode: two teams of two share the device, and each team's partners take turns (see turnLabel()).
export const MODES = {
  alone: { label: 'PLAY ALONE', hint: 'Reach ' + MODE_TARGET_SCORE.alone + ' points to win. Lose when your score reaches ' + ALONE_SCORE_FLOOR + '.',
           targetScore: MODE_TARGET_SCORE.alone, hazard: HAZARD_CHANCE, twoPlayers: false, turnClock: false, ai: false },
  ai:    { label: 'PLAYER VS AI', hint: 'First to ' + MODE_TARGET_SCORE.ai + ' points wins. Choose Easy or Professional.',
           targetScore: MODE_TARGET_SCORE.ai, hazard: HAZARD_CHANCE, twoPlayers: true, turnClock: true, ai: true },
  pvp:   { label: 'PLAYER 1 VS PLAYER 2', hint: 'Online 2-player match. First to ' + MODE_TARGET_SCORE.pvp + ' points wins.',
           targetScore: MODE_TARGET_SCORE.pvp, hazard: HAZARD_CHANCE, twoPlayers: true, turnClock: true, ai: false },
  tag:   { label: 'TAG: 2 VS 2', hint: 'Online team match · 2 vs 2. First team to ' + MODE_TARGET_SCORE.tag + ' points wins.',
           targetScore: MODE_TARGET_SCORE.tag, hazard: HAZARD_CHANCE, twoPlayers: true, turnClock: true, ai: false, teams: true },
};

export const AUDIENCE_WATCH_CODE = /^[A-Z0-9]{6}$/.test(urlParams.get('watch') || '') ? urlParams.get('watch').toUpperCase() : '';
export const START_MODE = ['alone', 'ai'].includes(urlParams.get('mode')) ? urlParams.get('mode') : null; // only local modes may skip the menu; online modes must use their room lobby
export const HAZARD_OVERRIDE = TEST_OVERRIDES_ENABLED
  ? RULES.parseProbabilityOverride(urlParams.get('hazard'), urlParams.has('hazard'))
  : null;
