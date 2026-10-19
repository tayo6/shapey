// Authoritative, serializable game state for online Player 1 vs Player 2 and Tag.
// This module deliberately has no Phaser, DOM, Worker, or Durable Object dependencies.
export const DEFAULT_BOARD_SIZE = 7;
export const BOARD_SIZES = Object.freeze([5, 6, 7]);
export const GRID_ROWS = DEFAULT_BOARD_SIZE; // Backwards-compatible constants for existing 7×7 tests.
export const GRID_COLS = DEFAULT_BOARD_SIZE;
export const INITIAL_REVIEW_MS = 15_000;
export const TURN_MS = 45_000;
export const TAG_TURN_MS = 30_000;
export const NEW_TILE_REVEAL_MS = 5_000;

export function turnDurationForMode(mode) {
  return mode === "tag" ? TAG_TURN_MS : TURN_MS;
}
export const SHUFFLE_STEP_MS = 2_000;
export const MIN_MATCH = 3;

export const SHAPE_KEYS = Object.freeze([
  "cancel", "capsule", "circle", "cross", "divide", "corner", "marked",
  "pointer", "shield", "sphere", "square", "star", "x"
]);

const MATCH_SCORES = Object.freeze({ 3: 1, 4: 2 });
const ITEM_PRICES = Object.freeze({ extraTime: 3, doublePlay: 4 });
function randomIndex(length, rng) {
  return Math.min(length - 1, Math.floor(rng() * length));
}

function pick(list, rng) {
  return list[randomIndex(list.length, rng)];
}

function shuffled(list, rng) {
  const output = list.slice();
  for (let i = output.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1, rng);
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function sideForPlayer(mode, playerNumber) {
  if (mode === "pvp") return playerNumber === 1 ? 0 : playerNumber === 2 ? 1 : null;
  if (mode === "tag") {
    if (playerNumber === 1 || playerNumber === 2) return 0;
    if (playerNumber === 3 || playerNumber === 4) return 1;
  }
  return null;
}

export function scoreForMatch(count) {
  if (!Number.isInteger(count) || count < MIN_MATCH) return 0;
  if (count >= 5) return 5;
  return MATCH_SCORES[count] || 0;
}

function makeStartingBoard(rng, boardSize) {
  // Choose as many complete three-of-a-kind groups as the selected square board can fit.
  // 5×5 gets seven guaranteed groups, 6×6 gets ten, and 7×7 keeps all thirteen.
  const totalTiles = boardSize * boardSize;
  const wantedHazards = Math.round(totalTiles * 0.1);
  const guaranteedShapeCount = Math.min(SHAPE_KEYS.length, Math.floor((totalTiles - wantedHazards) / 3));
  const startingShapes = shuffled(SHAPE_KEYS, rng).slice(0, guaranteedShapeCount);
  const shapes = [];
  for (const shape of startingShapes) shapes.push(shape, shape, shape);
  const hazardCount = Math.min(totalTiles - shapes.length, wantedHazards);
  for (let i = 0; i < hazardCount; i++) shapes.push("hazard");
  while (shapes.length < totalTiles) {
    shapes.push(rng() < 0.08 ? "dummy" : pick(SHAPE_KEYS, rng));
  }
  return shuffled(shapes, rng).map((shape, index) => ({
    id: "t" + (index + 1),
    shape,
    row: Math.floor(index / boardSize),
    col: index % boardSize,
    faceUp: true,
    selected: false,
    moving: false
  }));
}

function newPlayerData() {
  return {
    stars: 1,
    streak: 0,
    lastRewardedStreak: 0,
    inventory: { audiencePick: 1, extraTime: 0, doublePlay: 0, scoreStrike: 0, cancelCounter: 0 },
    scoreStrikeUsed: false
  };
}

export function createGameState({ roomCode, mode, playerNumbers, boardSize = DEFAULT_BOARD_SIZE, now = Date.now(), rng = Math.random }) {
  const expected = mode === "pvp" ? 2 : mode === "tag" ? 4 : 0;
  const order = mode === "pvp" ? [1, 2] : mode === "tag" ? [1, 3, 2, 4] : null;
  if (!BOARD_SIZES.includes(boardSize)) throw new Error("Invalid board size.");
  if (mode === "tag" && boardSize !== DEFAULT_BOARD_SIZE) throw new Error("Tag uses a 7x7 board.");
  if (!expected || !Array.isArray(playerNumbers) || playerNumbers.length !== expected ||
      order.some((number) => !playerNumbers.includes(number))) {
    throw new Error("Invalid player set for online mode.");
  }

  const playerData = {};
  for (const playerNumber of order) playerData[String(playerNumber)] = newPlayerData();
  const turnDurationMs = turnDurationForMode(mode);

  return {
    protocolVersion: 1,
    roomCode,
    mode,
    boardSize,
    status: "study",
    createdAt: now,
    reviewEndsAt: now + INITIAL_REVIEW_MS,
    turnIndex: 0,
    turnOrder: order,
    activePlayerNumber: order[0],
    isBonusTurn: false,
    doublePlayPendingPlayer: null,
    turnDurationMs,
    turnEndsAt: now + INITIAL_REVIEW_MS + turnDurationMs,
    targetScore: mode === "tag" ? 200 : 100,
    scores: [0, 0],
    winnerSide: null,
    winnerPlayerNumber: null,
    playerData,
    tiles: makeStartingBoard(rng, boardSize),
    nextTileNumber: boardSize * boardSize + 1,
    shapeQueue: [],
    lastShape: null,
    selectedTileIds: [],
    dummyTileIds: [],
    selectedShape: null,
    pendingEffect: null,
    reveals: [],
    shuffles: [],
    revision: 1
  };
}

export function scoreSide(state, side, points) {
  if ((side !== 0 && side !== 1) || !Number.isFinite(points)) return;
  state.scores[side] += points;
}

function playerCanAct(state, playerNumber) {
  return state.status === "playing" &&
    state.pendingEffect === null &&
    state.activePlayerNumber === playerNumber &&
    sideForPlayer(state.mode, playerNumber) !== null;
}

function tileById(state, tileId) {
  return state.tiles.find((tile) => tile.id === tileId);
}

function clearSelection(state, faceDown = true) {
  for (const id of [...state.selectedTileIds, ...state.dummyTileIds]) {
    const tile = tileById(state, id);
    if (!tile) continue;
    tile.selected = false;
    if (faceDown) tile.faceUp = false;
  }
  state.selectedTileIds = [];
  state.dummyTileIds = [];
  state.selectedShape = null;
}

function breakStreak(state, playerNumber) {
  const data = state.playerData[String(playerNumber)];
  if (data) {
    data.streak = 0;
    // Reward thresholds belong to the current consecutive streak, not the player's lifetime.
    // Resetting both lets a player earn the streak reward again after a failed turn.
    data.lastRewardedStreak = 0;
  }
}

function endTurn(state, now, { matched = false } = {}) {
  const currentPlayer = state.activePlayerNumber;
  const durationMs = Number.isFinite(state.turnDurationMs) && state.turnDurationMs > 0
    ? state.turnDurationMs : turnDurationForMode(state.mode);
  if (!matched) breakStreak(state, currentPlayer);

  // Double Play adds exactly one normal-length turn for its owner. A bonus turn cannot chain.
  if (!state.isBonusTurn && state.doublePlayPendingPlayer === currentPlayer) {
    state.doublePlayPendingPlayer = null;
    state.isBonusTurn = true;
    state.turnEndsAt = now + durationMs;
    return;
  }

  state.isBonusTurn = false;
  state.turnIndex += 1;
  state.activePlayerNumber = state.turnOrder[state.turnIndex % state.turnOrder.length];
  state.turnEndsAt = now + durationMs;
}

function nextShape(state, rng) {
  if (!state.shapeQueue.some((shape) => shape !== state.lastShape)) {
    state.shapeQueue = shuffled(SHAPE_KEYS, rng);
  }
  let index = state.shapeQueue.length - 1;
  while (index >= 0 && state.shapeQueue[index] === state.lastShape) index--;
  if (index < 0) {
    state.shapeQueue = shuffled(SHAPE_KEYS.filter((shape) => shape !== state.lastShape), rng);
    index = state.shapeQueue.length - 1;
  }
  const [shape] = state.shapeQueue.splice(index, 1);
  state.lastShape = shape;
  return shape;
}

function makeShufflePlan(count, rng) {
  if (count < 2) return [];
  const order = shuffled(Array.from({ length: count }, (_, index) => index), rng);
  const participants = [];
  const skipped = [];
  for (const index of order) (rng() < 0.1 ? skipped : participants).push(index);
  while (participants.length < Math.min(count, 3)) participants.push(skipped.pop());

  const steps = [[participants[0], participants[1]]];
  const involved = [participants[0], participants[1]];
  for (let index = 2; index < participants.length; index++) {
    steps.push([participants[index], pick(involved, rng)]);
    involved.push(participants[index]);
  }
  while (steps.length < count - 1) {
    const a = pick(involved, rng);
    let b = pick(involved, rng);
    let guard = 0;
    while ((a === b || (steps.length > 0 &&
        ((a === steps[steps.length - 1][0] && b === steps[steps.length - 1][1]) ||
         (a === steps[steps.length - 1][1] && b === steps[steps.length - 1][0])))) && guard++ < 30) {
      b = (b + 1) % involved.length;
    }
    if (a !== b) steps.push([a, b]);
  }
  return steps.slice(0, count - 1);
}

function stopShuffles(state) {
  for (const shuffle of state.shuffles) {
    for (const id of shuffle.tileIds) {
      const tile = tileById(state, id);
      if (tile) tile.moving = false;
    }
    if (shuffle.move) {
      for (const id of shuffle.move.tileIds) {
        const tile = tileById(state, id);
        if (tile) tile.moving = false;
      }
    }
  }
  state.shuffles = [];
}

function ensureMatchPossible(state, freshTiles, rng) {
  const counts = {};
  for (const tile of state.tiles) {
    if (SHAPE_KEYS.includes(tile.shape)) counts[tile.shape] = (counts[tile.shape] || 0) + 1;
  }
  if (Object.values(counts).some((count) => count >= MIN_MATCH)) return;
  const best = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || pick(SHAPE_KEYS, rng);
  let needed = MIN_MATCH - (counts[best] || 0);
  for (const tile of freshTiles) {
    if (needed <= 0) break;
    if (tile.shape === "hazard" || tile.shape === "dummy" || tile.shape === best) continue;
    tile.shape = best;
    needed--;
  }
}

function cascade(state, removedIds, now, rng) {
  stopShuffles(state);
  const removed = new Set(removedIds);
  state.tiles = state.tiles.filter((tile) => !removed.has(tile.id));
  clearSelection(state, true);

  const freshTiles = [];
  const boardSize = state.boardSize || DEFAULT_BOARD_SIZE;
  for (let col = 0; col < boardSize; col++) {
    const column = state.tiles.filter((tile) => tile.col === col).sort((a, b) => b.row - a.row);
    let writeRow = boardSize - 1;
    for (const tile of column) {
      tile.row = writeRow--;
      tile.selected = false;
      tile.moving = false;
    }
    while (writeRow >= 0) {
      const tile = {
        id: "t" + state.nextTileNumber++,
        shape: rng() < 0.1 ? "hazard" : rng() < 0.08 ? "dummy" : nextShape(state, rng),
        row: writeRow--,
        col,
        faceUp: true,
        selected: false,
        moving: false
      };
      state.tiles.push(tile);
      freshTiles.push(tile);
    }
  }
  ensureMatchPossible(state, freshTiles, rng);
  if (freshTiles.length) {
    state.reveals.push({ tileIds: freshTiles.map((tile) => tile.id), endsAt: now + NEW_TILE_REVEAL_MS });
  }
}

function awardMatch(state, playerNumber, count, now, rng) {
  const side = sideForPlayer(state.mode, playerNumber);
  const points = scoreForMatch(count);
  scoreSide(state, side, points);

  const data = state.playerData[String(playerNumber)];
  data.streak += 1;
  if (data.streak >= 3 && data.streak > data.lastRewardedStreak) {
    data.stars += data.streak - 2;
    data.lastRewardedStreak = data.streak;
  }

  if (state.scores[side] >= state.targetScore) {
    state.status = "finished";
    state.winnerSide = side;
    state.winnerPlayerNumber = playerNumber;
    state.pendingEffect = null;
    state.reveals = [];
    stopShuffles(state);
    return;
  }
  endTurn(state, now, { matched: true });
  void rng;
}

function resolveSelectedMatch(state, now, rng) {
  const selected = state.selectedTileIds.map((id) => tileById(state, id)).filter(Boolean);
  const shape = state.selectedShape;
  const valid = selected.length >= MIN_MATCH && shape !== null &&
    selected.every((tile) => tile.shape === shape && SHAPE_KEYS.includes(tile.shape));
  if (!valid) {
    clearSelection(state, true);
    endTurn(state, now, { matched: false });
    return;
  }
  const removedIds = selected.map((tile) => tile.id);
  const count = selected.length;
  cascade(state, removedIds, now, rng);
  awardMatch(state, state.activePlayerNumber, count, now, rng);
}

function applyHazardBlast(state, hazard, now, rng) {
  const activePlayer = state.activePlayerNumber;
  const hadRealShapes = state.selectedTileIds.length > 0;
  const removedIds = [...state.selectedTileIds, ...state.dummyTileIds, hazard.id];
  if (hadRealShapes) scoreSide(state, sideForPlayer(state.mode, activePlayer), -1);
  clearSelection(state, true);
  cascade(state, removedIds, now, rng);
  endTurn(state, now, { matched: false });
}

function resolvePendingEffect(state, now, rng) {
  const pending = state.pendingEffect;
  if (!pending || pending.endsAt > now) return false;
  // Clear the lock before resolving the effect so the room never remains permanently blocked.
  state.pendingEffect = null;
  if (pending.type === "mismatch") {
    clearSelection(state, true);
    endTurn(state, now, { matched: false });
  } else if (pending.type === "hazard-hit") {
    const tile = tileById(state, pending.tileId);
    if (tile) tile.faceUp = false;
  } else if (pending.type === "cancel-dummy") {
    clearSelection(state, true);
  }
  return true;
}

export function advanceGameByTime(inputState, now = Date.now(), rng = Math.random) {
  const state = inputState;
  let changed = false;
  for (let safety = 0; safety < 100; safety++) {
    let progressed = false;

    if (state.status === "study" && state.reviewEndsAt <= now) {
      state.status = "playing";
      state.reviewEndsAt = null;
      for (const tile of state.tiles) tile.faceUp = false;
      changed = progressed = true;
    }

    if (state.pendingEffect && state.pendingEffect.endsAt <= now) {
      resolvePendingEffect(state, now, rng);
      changed = progressed = true;
    }

    const dueReveals = state.reveals.filter((batch) => batch.endsAt <= now);
    if (dueReveals.length) {
      const dueIds = new Set(dueReveals.flatMap((batch) => batch.tileIds));
      for (const id of dueIds) {
        const tile = tileById(state, id);
        if (tile) tile.faceUp = false;
      }
      state.reveals = state.reveals.filter((batch) => batch.endsAt > now);
      for (const batch of dueReveals) {
        const tileIds = batch.tileIds.filter((id) => tileById(state, id));
        const steps = makeShufflePlan(tileIds.length, rng);
        if (steps.length) state.shuffles.push({ tileIds, steps, nextStep: 0, move: null, nextAt: now });
      }
      changed = progressed = true;
    }

    const shuffle = state.shuffles.find((item) =>
      item.move ? item.move.endsAt <= now : item.nextAt <= now);
    if (shuffle) {
      if (shuffle.move) {
        for (const id of shuffle.move.tileIds) {
          const tile = tileById(state, id);
          if (tile) tile.moving = false;
        }
        shuffle.move = null;
      }
      if (shuffle.nextStep >= shuffle.steps.length) {
        state.shuffles = state.shuffles.filter((item) => item !== shuffle);
      } else {
        const [aIndex, bIndex] = shuffle.steps[shuffle.nextStep++];
        const a = tileById(state, shuffle.tileIds[aIndex]);
        const b = tileById(state, shuffle.tileIds[bIndex]);
        if (a && b) {
          [a.row, b.row] = [b.row, a.row];
          [a.col, b.col] = [b.col, a.col];
          a.moving = true;
          b.moving = true;
          shuffle.move = { tileIds: [a.id, b.id], endsAt: now + SHUFFLE_STEP_MS };
          shuffle.nextAt = null;
        } else {
          shuffle.nextAt = now;
        }
      }
      changed = progressed = true;
    }

    if (state.status === "playing" && !state.pendingEffect && state.turnEndsAt <= now) {
      if (state.selectedTileIds.length >= MIN_MATCH) {
        const player = state.activePlayerNumber;
        resolveSelectedMatch(state, now, rng);
        if (state.status !== "finished" && state.activePlayerNumber === player &&
            state.isBonusTurn && state.turnEndsAt <= now) {
          // A very late wake-up cannot create a stale bonus turn deadline.
          state.turnEndsAt = now + (state.turnDurationMs || turnDurationForMode(state.mode));
        }
      } else {
        clearSelection(state, true);
        endTurn(state, now, { matched: false });
      }
      changed = progressed = true;
    }

    if (!progressed) break;
  }
  if (changed) state.revision += 1;
  return changed;
}

function startPending(state, type, tileId, now, durationMs) {
  state.pendingEffect = { type, tileId, endsAt: now + durationMs };
}

function applyPick(state, playerNumber, tileId, now, rng) {
  if (!playerCanAct(state, playerNumber)) throw new Error("It is not your turn or the game is resolving an action.");
  const tile = tileById(state, tileId);
  if (!tile) throw new Error("That tile is no longer on the board.");
  if (tile.faceUp || tile.selected || tile.moving) throw new Error("That tile is not currently available.");

  tile.faceUp = true;
  if (tile.shape === "hazard") {
    if (state.selectedTileIds.length === 0 && state.dummyTileIds.length === 0) {
      startPending(state, "hazard-hit", tile.id, now, 900);
    } else {
      applyHazardBlast(state, tile, now, rng);
    }
    return;
  }

  if (tile.shape === "dummy") {
    tile.selected = true;
    state.dummyTileIds.push(tile.id);
    return;
  }

  if (tile.shape === "cancel" && state.selectedTileIds.length === 0 && state.dummyTileIds.length > 0) {
    tile.selected = true;
    state.selectedTileIds.push(tile.id);
    state.selectedShape = tile.shape;
    startPending(state, "cancel-dummy", tile.id, now, 350);
    return;
  }

  const mismatched = state.selectedShape !== null && tile.shape !== state.selectedShape;
  tile.selected = true;
  state.selectedTileIds.push(tile.id);
  if (state.selectedShape === null) state.selectedShape = tile.shape;
  if (mismatched) startPending(state, "mismatch", tile.id, now, 500);
}

function applyBuyItem(state, playerNumber, itemKey) {
  if (!playerCanAct(state, playerNumber)) throw new Error("Shop purchases are available only during your active turn.");
  // Only explicitly priced own-properties are valid; inherited names like "constructor"
  // must never be interpreted as prices or allowed to corrupt the Star balance.
  if (typeof itemKey !== "string" || !Object.prototype.hasOwnProperty.call(ITEM_PRICES, itemKey)) {
    throw new Error("That item is not available in online play yet.");
  }
  const price = ITEM_PRICES[itemKey];
  const data = state.playerData[String(playerNumber)];
  if (data.stars < price) throw new Error("Not enough Stars to buy that item.");
  data.stars -= price;
  data.inventory[itemKey] = Number(data.inventory[itemKey] || 0) + 1;
}

function applyUseItem(state, playerNumber, itemKey, now) {
  if (!playerCanAct(state, playerNumber)) throw new Error("Items can only be used during your active turn.");
  const data = state.playerData[String(playerNumber)];
  if (itemKey === "extraTime") {
    if (Number(data.inventory.extraTime || 0) < 1) throw new Error("You do not own Extra Time.");
    data.inventory.extraTime -= 1;
    state.turnEndsAt += TURN_MS;
    return;
  }
  if (itemKey === "doublePlay") {
    if (state.isBonusTurn || state.doublePlayPendingPlayer !== null) {
      throw new Error("Double Play is unavailable during a bonus turn or while another Double Play is pending.");
    }
    if (Number(data.inventory.doublePlay || 0) < 1) throw new Error("You do not own Double Play.");
    data.inventory.doublePlay -= 1;
    state.doublePlayPendingPlayer = playerNumber;
    return;
  }
  throw new Error("That item is not available in online play yet.");
}

export function applyGameAction(inputState, playerNumber, action, now = Date.now(), rng = Math.random) {
  const state = clone(inputState);
  const clockChanged = advanceGameByTime(state, now, rng);
  const beforeActionRevision = state.revision;
  try {
    if (!action || typeof action !== "object" || typeof action.type !== "string") {
      throw new Error("Invalid game action.");
    }
    if (state.status === "finished") throw new Error("This match has ended.");
    if (action.type === "pick") {
      applyPick(state, playerNumber, action.tileId, now, rng);
    } else if (action.type === "submit") {
      if (!playerCanAct(state, playerNumber)) throw new Error("It is not your turn or the game is resolving an action.");
      const currentPlayer = state.activePlayerNumber;
      if (state.selectedTileIds.length >= MIN_MATCH) {
        resolveSelectedMatch(state, now, rng);
      } else {
        clearSelection(state, true);
        endTurn(state, now, { matched: false });
      }
      void currentPlayer;
    } else if (action.type === "buyItem") {
      applyBuyItem(state, playerNumber, action.itemKey);
    } else if (action.type === "useItem") {
      applyUseItem(state, playerNumber, action.itemKey, now);
    } else {
      throw new Error("Unsupported game action.");
    }
    state.revision += 1;
    return { accepted: true, state, changed: true };
  } catch (error) {
    return {
      accepted: false,
      error: error instanceof Error ? error.message : "Action rejected.",
      state,
      changed: clockChanged || state.revision !== inputState.revision
    };
  }
}

export function nextGameDeadline(state) {
  if (!state || state.status === "finished") return null;
  const deadlines = [];
  if (state.status === "study" && Number.isFinite(state.reviewEndsAt)) deadlines.push(state.reviewEndsAt);
  if (state.status === "playing" && !state.pendingEffect && Number.isFinite(state.turnEndsAt)) deadlines.push(state.turnEndsAt);
  if (state.pendingEffect && Number.isFinite(state.pendingEffect.endsAt)) deadlines.push(state.pendingEffect.endsAt);
  for (const reveal of state.reveals) deadlines.push(reveal.endsAt);
  for (const shuffle of state.shuffles) {
    deadlines.push(shuffle.move ? shuffle.move.endsAt : shuffle.nextAt);
  }
  const valid = deadlines.filter(Number.isFinite);
  return valid.length ? Math.min(...valid) : null;
}

// Spectator snapshots use the same hidden-tile privacy rules as player snapshots,
 // but omit the active player's private inventory, Stars and streak data.
export function gameViewForSpectator(state) {
  if (!state || !Array.isArray(state.turnOrder) || !state.turnOrder.includes(state.activePlayerNumber)) {
    return null;
  }
  const view = gameViewForPlayer(state, state.activePlayerNumber);
  delete view.me;
  return view;
}

// Never send hidden tile shapes to any browser. The backend keeps the actual shape privately.
export function gameViewForPlayer(state, playerNumber) {
  if (!state.turnOrder.includes(playerNumber)) throw new Error("Player is not part of this match.");
  const side = sideForPlayer(state.mode, playerNumber);
  const ownData = clone(state.playerData[String(playerNumber)]);
  const movingUntilById = new Map();
  for (const shuffle of state.shuffles) {
    if (shuffle.move && Number.isFinite(shuffle.move.endsAt)) {
      for (const id of shuffle.move.tileIds) movingUntilById.set(id, shuffle.move.endsAt);
    }
  }
  return {
    protocolVersion: state.protocolVersion,
    roomCode: state.roomCode,
    mode: state.mode,
    boardSize: state.boardSize || DEFAULT_BOARD_SIZE,
    status: state.status,
    revision: state.revision,
    reviewEndsAt: state.reviewEndsAt,
    turnIndex: state.turnIndex,
    activePlayerNumber: state.activePlayerNumber,
    activeSide: sideForPlayer(state.mode, state.activePlayerNumber),
    isBonusTurn: state.isBonusTurn,
    doublePlayPendingPlayer: state.doublePlayPendingPlayer,
    turnDurationMs: state.turnDurationMs || turnDurationForMode(state.mode),
    turnEndsAt: state.turnEndsAt,
    targetScore: state.targetScore,
    scores: state.scores.slice(),
    winnerSide: state.winnerSide,
    winnerPlayerNumber: state.winnerPlayerNumber,
    pendingEffect: state.pendingEffect ? { ...state.pendingEffect } : null,
    reveals: state.reveals.map((batch) => ({ endsAt: batch.endsAt, tileIds: batch.tileIds.slice() })),
    shuffling: state.shuffles.length > 0,
    tiles: state.tiles.map((tile) => ({
      id: tile.id,
      row: tile.row,
      col: tile.col,
      shape: tile.faceUp ? tile.shape : null,
      faceUp: tile.faceUp,
      selected: tile.selected,
      moving: tile.moving,
      movingUntil: movingUntilById.get(tile.id) ?? null
    })),
    selectedTileIds: state.selectedTileIds.slice(),
    dummyTileIds: state.dummyTileIds.slice(),
    players: state.turnOrder.slice(),
    me: { playerNumber, side, ...ownData }
  };
}
