// Shapey - pure helpers: randomness, clock formatting, board-shape rolls, shuffle planning.
// No Phaser, no DOM; unit-tested in tests/utils.test.mjs.


// "00:45" style clock text. Rounds up, so "00:00" only shows once time is really up.

import { SHUFFLE_SKIP_CHANCE, SHAPE_KEYS, DUMMY_SPAWN_CHANCE } from './constants.js';

export const formatClock = (ms) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
};

export function randomBoardShape() {
  return Math.random() < DUMMY_SPAWN_CHANCE ? 'dummy' : randomItem(SHAPE_KEYS);
}

export const randomItem = (list) => list[Math.floor(Math.random() * list.length)];

export function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Plans the shuffle of a batch of `count` new tiles as a list of swaps [i, j] (indexes into the batch).
// - N tiles give N - 1 swaps (3 tiles = 2 swaps, 4 = 3, 5 = 4 ...), performed one after another.
// - Chain rule: each newly involved tile swaps with a tile that has already been shuffled (A<->B, then C<->A or B).
// - Already shuffled tiles can be shuffled again; once everyone is involved, the remaining swaps re-shuffle them.
// - Each tile has a ~10% chance to sit out, but at least min(count, 3) tiles always take part.
export function planShuffle(count, rng = Math.random, skipChance = SHUFFLE_SKIP_CHANCE) {
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
