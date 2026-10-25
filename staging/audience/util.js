// Shapey audience page - pure helpers: formatting, naming, percentages, the server
// clock conversion and the poll-open predicates.

import { API_OVERRIDDEN, MODE_LABELS, MULTIPLAYER_API, SHAPE_FILES, serverClock, state } from './state.js';

export function serverToLocal(at) { return serverClock.serverToLocal(at); }

export function api(path) { return MULTIPLAYER_API + path; }

// Every navigation and share URL derives from this one. In local testing it carries the
// ?api= override so reloading the page or copying a watch link stays pointed at the local
// Worker; production pages never carry the parameter.
export function directoryUrl() {
  const url = new URL('staging/audience.html', document.baseURI);
  if (API_OVERRIDDEN) url.searchParams.set('api', MULTIPLAYER_API);
  return url;
}

export function shapeUrl(shape) {
  const file = SHAPE_FILES[shape] || SHAPE_FILES.mystery;
  return new URL('assets/shapes/' + encodeURIComponent(file), document.baseURI).href;
}

export function text(el, value) { el.textContent = value == null ? '' : String(value); }

export function modeName(mode) { return MODE_LABELS[mode] || (mode ? String(mode).toUpperCase() : MODE_LABELS.pvp); }

export function playerWord(mode) { return mode === 'demo' || mode === 'ai' ? 'AI' : 'Player'; }

export function statusName(status) {
  return ({ live: 'Live', starting: 'Starting', ready: 'Ready', waiting: 'Waiting' })[status] || status || 'Unknown';
}

export function sideOf(mode, playerNumber) { return mode === 'tag' ? (playerNumber <= 2 ? 0 : 1) : playerNumber - 1; }

export function sideNames(mode) { return mode === 'tag' ? ['TEAM 1', 'TEAM 2'] : (mode === 'demo' || mode === 'ai') ? ['AI 1', 'AI 2'] : ['Player 1', 'Player 2']; }

// Same wording as the game's turnLabel(): "Team 2: Player 3" in Tag, "Player 1" otherwise.
export function turnLabel(mode, playerNumber) {
  return mode === 'tag' ? 'Team ' + (sideOf(mode, playerNumber) + 1) + ': Player ' + playerNumber : playerWord(mode) + ' ' + playerNumber;
}

export function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}

// ------------------------------------------------------------------ polls ("Ask the Audience")
export function percentSplit(values) {
  const total = values.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((n) => (n / total) * 100);
  const result = exact.map(Math.floor);
  let left = 100 - result.reduce((sum, n) => sum + n, 0);
  exact.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((a, b) => b.rest - a.rest)
    .forEach(({ i }) => { if (left-- > 0) result[i]++; });
  return result;
}

export function pollSecondsLeft(poll) { return Math.max(0, Math.ceil((serverToLocal(Number(poll.endsAt) || NaN) - Date.now()) / 1000)); }

export function pollIsOpen(poll) { return Boolean(poll) && !poll.closed && pollSecondsLeft(poll) > 0; }

export function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content != null) text(node, content);
  return node;
}
