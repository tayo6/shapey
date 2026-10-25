// Shapey - environment-resolved configuration.
// Everything here depends on the page: URL parameters, src/rules.js (loaded as a classic
// script before this module), the staging override (window.SHAPEY_ENV) and the multiplayer
// Worker API. Pure numbers live in constants.js. Browser-only - not for Node tests.

import { normalizeBoardSize, BASE_BOARD_SIZE, BASE_TILE_SIZE, BASE_TILE_PITCH, ALONE_SCORE_FLOOR, HAZARD_CHANCE } from './constants.js';

export const RULES = window.ShapeyRules;
if (!RULES) throw new Error('Load src/rules.js before src/main.js.');

export const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('embed') === '1') document.body.classList.add('audience-embed');

// The staging page (staging/index.html) sets window.SHAPEY_ENV = { staging: true } before this module
// loads, so it can relax host checks for testing. Production pages leave it unset.
export const STAGING = Boolean(typeof window !== 'undefined' && window.SHAPEY_ENV && window.SHAPEY_ENV.staging);

// Multiplayer service used by the live game: the Cloudflare Worker documented in worker/STAGING.md.
// A page served from localhost (or any page in staging mode) may point at a local Worker with
// ?api=http://localhost:8787 (or 127.0.0.1:8787) for testing; every other page ignores that parameter.
const requestedLocalApi = urlParams.get('api');
const isLocalApiUrl = /^http:\/\/(?:127\.0\.0\.1|localhost):8787$/i.test(requestedLocalApi || '');
const localApiAllowed = STAGING || ['localhost', '127.0.0.1'].includes(window.location.hostname);
export const API_OVERRIDDEN = isLocalApiUrl && localApiAllowed;
export const MULTIPLAYER_API = API_OVERRIDDEN
  ? requestedLocalApi
  : 'https://shapey-multiplayer-staging.hellohuman100.workers.dev';

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
// For quick testing you can shorten the timers in the URL, e.g. index.html?review=3000&turn=10000
export const REVIEW_MS = Number(urlParams.get('review')) || 15000;      // the opening board stays face-up this long (study phase)
// Tiles spawned after a match are shown only briefly, flip face-down, then shuffle places with each other.
export const SPAWN_REVEAL_MS = Number(urlParams.get('reveal')) || 5000;  // new tiles face-up
export const SHUFFLE_STEP_MS = Number(urlParams.get('swap')) || 2000;    // each swap takes this long; swaps run one after another

// ---- Turn clock and inventory limits ----------------------------------------
// Opening board reveal: 15 seconds. Newly spawned tiles: 5 seconds.
// Pick clocks start after the opening reveal. Player vs AI: human gets 45s Easy / 30s Hard, AI gets 5s.
// Player 1 vs Player 2: 45s per player. Tag: 30s per player. Play Alone has no pick clock.
// Test overrides: ?turn=10000 (turn length) and ?invwindow=20000 (inventory window), in milliseconds.
export const TURN_MS = Number(urlParams.get('turn')) || 45000;

export const INVENTORY_WINDOW_MS = Number(urlParams.get('invwindow')) || 5 * 60 * 1000;
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
export const HAZARD_OVERRIDE = RULES.parseProbabilityOverride(urlParams.get('hazard'), urlParams.has('hazard'));
