import test from "node:test";
import assert from "node:assert/strict";
import {
  INITIAL_REVIEW_MS, TURN_MS, GRID_ROWS, GRID_COLS,
  createGameState, gameViewForPlayer, applyGameAction, advanceGameByTime,
  nextGameDeadline, scoreForMatch
} from "../src/game-engine.js";

const NOW = 1_000_000;
const steadyRandom = () => 0.37;

function startPlaying(mode = "pvp") {
  const playerNumbers = mode === "tag" ? [1, 2, 3, 4] : [1, 2];
  const state = createGameState({ roomCode: "ABC234", mode, playerNumbers, now: NOW, rng: steadyRandom });
  advanceGameByTime(state, NOW + INITIAL_REVIEW_MS, steadyRandom);
  return state;
}

function act(state, playerNumber, action, offset = INITIAL_REVIEW_MS + 1) {
  return applyGameAction(state, playerNumber, action, NOW + offset, steadyRandom);
}

test("creates correct room-sized game states, score targets, and Tag turn order", () => {
  const pvp = createGameState({ roomCode: "ABC234", mode: "pvp", playerNumbers: [1, 2], now: NOW, rng: steadyRandom });
  assert.equal(pvp.tiles.length, GRID_ROWS * GRID_COLS);
  assert.equal(pvp.targetScore, 100);
  assert.deepEqual(pvp.turnOrder, [1, 2]);
  assert.equal(pvp.status, "study");
  assert.equal(nextGameDeadline(pvp), NOW + INITIAL_REVIEW_MS);

  const tag = createGameState({ roomCode: "TAG234", mode: "tag", playerNumbers: [1, 2, 3, 4], now: NOW, rng: steadyRandom });
  assert.equal(tag.targetScore, 200);
  assert.deepEqual(tag.turnOrder, [1, 3, 2, 4]);
  assert.throws(() => createGameState({ roomCode: "BAD234", mode: "tag", playerNumbers: [1, 2], now: NOW }), /Invalid player set/);
});

test("hidden tile shapes are never sent to clients", () => {
  const state = startPlaying();
  const view = gameViewForPlayer(state, 1);
  assert.equal(view.tiles.length, GRID_ROWS * GRID_COLS);
  assert.ok(view.tiles.every((tile) => tile.shape === null && tile.faceUp === false));
  const hiddenShape = state.tiles[0].shape;
  state.tiles[0].faceUp = true;
  const revealed = gameViewForPlayer(state, 2).tiles.find((tile) => tile.id === state.tiles[0].id);
  assert.equal(revealed.shape, hiddenShape);
  assert.equal(state.tiles[0].shape, hiddenShape);
});

test("the server rejects out-of-turn moves", () => {
  const state = startPlaying();
  const result = act(state, 2, { type: "pick", tileId: "t1" });
  assert.equal(result.accepted, false);
  assert.match(result.error, /not your turn/);
  assert.equal(result.state.activePlayerNumber, 1);
  assert.equal(result.state.scores[1], 0);
});

test("a valid 3-tile match awards one point and moves PvP to Player 2", () => {
  const state = startPlaying();
  state.tiles.find((tile) => tile.id === "t1").shape = "circle";
  state.tiles.find((tile) => tile.id === "t2").shape = "circle";
  state.tiles.find((tile) => tile.id === "t3").shape = "circle";
  let current = state;
  for (const tileId of ["t1", "t2", "t3"]) {
    const result = act(current, 1, { type: "pick", tileId });
    assert.equal(result.accepted, true, result.error);
    current = result.state;
  }
  const submitted = act(current, 1, { type: "submit" });
  assert.equal(submitted.accepted, true, submitted.error);
  assert.deepEqual(submitted.state.scores, [1, 0]);
  assert.equal(submitted.state.activePlayerNumber, 2);
  assert.equal(submitted.state.tiles.length, GRID_ROWS * GRID_COLS);
  assert.equal(submitted.state.selectedTileIds.length, 0);
  assert.equal(submitted.state.reveals.length, 1);
});

test("Tag alternates sides and rotates all four player seats in the required order", () => {
  let state = startPlaying("tag");
  const seen = [state.activePlayerNumber];
  for (const player of [1, 3, 2, 4, 1, 3, 2]) {
    const result = act(state, player, { type: "submit" });
    assert.equal(result.accepted, true, result.error);
    state = result.state;
    seen.push(state.activePlayerNumber);
  }
  assert.deepEqual(seen, [1, 3, 2, 4, 1, 3, 2, 4]);
});

test("a mismatched pick is shown briefly, then clears the selection and passes the turn", () => {
  let state = startPlaying();
  state.tiles.find((tile) => tile.id === "t1").shape = "circle";
  state.tiles.find((tile) => tile.id === "t2").shape = "square";
  state = act(state, 1, { type: "pick", tileId: "t1" }).state;
  state = act(state, 1, { type: "pick", tileId: "t2" }).state;
  assert.equal(state.pendingEffect.type, "mismatch");
  assert.equal(state.activePlayerNumber, 1);
  advanceGameByTime(state, NOW + INITIAL_REVIEW_MS + 501, steadyRandom);
  assert.equal(state.pendingEffect, null);
  assert.equal(state.activePlayerNumber, 2);
  assert.equal(state.selectedTileIds.length, 0);
  assert.equal(state.scores[0], 0);
});

test("a first-pick hazard is harmless and does not end the turn", () => {
  let state = startPlaying();
  state.tiles.find((tile) => tile.id === "t1").shape = "hazard";
  state = act(state, 1, { type: "pick", tileId: "t1" }).state;
  assert.equal(state.pendingEffect.type, "hazard-hit");
  advanceGameByTime(state, NOW + INITIAL_REVIEW_MS + 902, steadyRandom);
  assert.equal(state.pendingEffect, null);
  assert.equal(state.activePlayerNumber, 1);
  assert.equal(state.scores[0], 0);
  assert.equal(state.tiles.find((tile) => tile.id === "t1").faceUp, false);
});

test("a hazard after selected shapes deducts one point, refills the board and ends the turn", () => {
  let state = startPlaying();
  state.tiles.find((tile) => tile.id === "t1").shape = "circle";
  state.tiles.find((tile) => tile.id === "t2").shape = "hazard";
  state = act(state, 1, { type: "pick", tileId: "t1" }).state;
  const result = act(state, 1, { type: "pick", tileId: "t2" });
  assert.equal(result.accepted, true, result.error);
  assert.deepEqual(result.state.scores, [-1, 0]);
  assert.equal(result.state.activePlayerNumber, 2);
  assert.equal(result.state.tiles.length, GRID_ROWS * GRID_COLS);
  assert.equal(result.state.tiles.some((tile) => tile.id === "t1" || tile.id === "t2"), false);
});

test("Double Play adds exactly one same-player turn and cannot chain", () => {
  let state = startPlaying();
  state.playerData["1"].stars = 4;
  state = act(state, 1, { type: "buyItem", itemKey: "doublePlay" }).state;
  assert.equal(state.playerData["1"].inventory.doublePlay, 1);
  state = act(state, 1, { type: "useItem", itemKey: "doublePlay" }).state;
  assert.equal(state.doublePlayPendingPlayer, 1);
  state.tiles.find((tile) => tile.id === "t1").shape = "circle";
  state.tiles.find((tile) => tile.id === "t2").shape = "circle";
  state.tiles.find((tile) => tile.id === "t3").shape = "circle";
  for (const tileId of ["t1", "t2", "t3"]) {
    const result = act(state, 1, { type: "pick", tileId });
    assert.equal(result.accepted, true, result.error);
    state = result.state;
  }
  state = act(state, 1, { type: "submit" }).state;
  assert.equal(state.activePlayerNumber, 1);
  assert.equal(state.isBonusTurn, true);
  assert.equal(state.doublePlayPendingPlayer, null);
  const chained = act(state, 1, { type: "useItem", itemKey: "doublePlay" });
  assert.equal(chained.accepted, false);
  const endBonus = act(state, 1, { type: "submit" });
  assert.equal(endBonus.accepted, true);
  assert.equal(endBonus.state.activePlayerNumber, 2);
  assert.equal(endBonus.state.isBonusTurn, false);
});

test("shop purchases reject inherited object-property names without corrupting Stars", () => {
  const state = startPlaying();
  state.playerData["1"].stars = 20;
  const originalInventory = { ...state.playerData["1"].inventory };

  for (const itemKey of ["constructor", "toString", "hasOwnProperty", "__proto__", "unpriced"]) {
    const result = act(state, 1, { type: "buyItem", itemKey });
    assert.equal(result.accepted, false, "Must reject invalid item key: " + itemKey);
    assert.equal(result.state.playerData["1"].stars, 20, "Stars must remain unchanged for " + itemKey);
    assert.deepEqual(result.state.playerData["1"].inventory, originalInventory,
      "Inventory must remain unchanged for " + itemKey);
  }
});

test("a score target ends the match and identifies the winning side", () => {
  let state = startPlaying();
  state.scores[0] = 99;
  state.tiles.find((tile) => tile.id === "t1").shape = "circle";
  state.tiles.find((tile) => tile.id === "t2").shape = "circle";
  state.tiles.find((tile) => tile.id === "t3").shape = "circle";
  for (const tileId of ["t1", "t2", "t3"]) state = act(state, 1, { type: "pick", tileId }).state;
  const result = act(state, 1, { type: "submit" });
  assert.equal(result.state.status, "finished");
  assert.equal(result.state.winnerSide, 0);
  assert.equal(result.state.winnerPlayerNumber, 1);
  assert.equal(result.state.scores[0], 100);
});

test("a timeout with no valid match passes the turn and breaks the streak", () => {
  let state = startPlaying();
  state.playerData["1"].streak = 2;
  advanceGameByTime(state, state.turnEndsAt, steadyRandom);
  assert.equal(state.activePlayerNumber, 2);
  assert.equal(state.playerData["1"].streak, 0);
});

test("scores retain the existing 3/4/5+ scoring table", () => {
  assert.equal(scoreForMatch(2), 0);
  assert.equal(scoreForMatch(3), 1);
  assert.equal(scoreForMatch(4), 2);
  assert.equal(scoreForMatch(5), 5);
  assert.equal(scoreForMatch(8), 5);
});

test("Tag partners contribute to the same team score across separate turns", () => {
  let state = startPlaying("tag");
  const first = ["t1", "t2", "t3"];
  for (const id of first) state.tiles.find((tile) => tile.id === id).shape = "circle";
  for (const tileId of first) {
    const result = act(state, 1, { type: "pick", tileId });
    assert.equal(result.accepted, true, result.error);
    state = result.state;
  }
  state = act(state, 1, { type: "submit" }).state;
  assert.deepEqual(state.scores, [1, 0]);
  assert.equal(state.activePlayerNumber, 3);

  // Player 3 (Team 2) ends their turn without scoring; Player 2 (Team 1) then matches.
  state = act(state, 3, { type: "submit" }).state;
  assert.equal(state.activePlayerNumber, 2);
  const second = ["t4", "t5", "t6"];
  for (const id of second) state.tiles.find((tile) => tile.id === id).shape = "square";
  for (const tileId of second) {
    const result = act(state, 2, { type: "pick", tileId });
    assert.equal(result.accepted, true, result.error);
    state = result.state;
  }
  state = act(state, 2, { type: "submit" }).state;
  assert.deepEqual(state.scores, [2, 0]);
  assert.equal(state.activePlayerNumber, 4);
});

test("three successful turns award Stars to that individual player once at each streak length", () => {
  let state = startPlaying();
  state.playerData["1"].stars = 1;
  for (let matchNumber = 1; matchNumber <= 3; matchNumber++) {
    const available = state.tiles.filter((tile) =>
      !tile.faceUp && !tile.selected && !tile.moving &&
      !["hazard", "dummy"].includes(tile.shape)).slice(0, 3);
    assert.equal(available.length, 3);
    const shape = "circle";
    for (const tile of available) tile.shape = shape;
    for (const tile of available) {
      const result = act(state, 1, { type: "pick", tileId: tile.id });
      assert.equal(result.accepted, true, result.error);
      state = result.state;
    }
    state = act(state, 1, { type: "submit" }).state;
    if (matchNumber < 3) {
      assert.equal(state.activePlayerNumber, 2);
      state = act(state, 2, { type: "submit" }).state;
      assert.equal(state.activePlayerNumber, 1);
    }
  }
  assert.equal(state.playerData["1"].streak, 3);
  assert.equal(state.playerData["1"].stars, 4);
  assert.equal(state.playerData["1"].lastRewardedStreak, 3);
});

test("a broken streak can earn the Star reward again after three new matches", () => {
  let state = startPlaying();
  state.playerData["1"].stars = 4;
  state.playerData["1"].streak = 3;
  state.playerData["1"].lastRewardedStreak = 3;

  // An empty turn breaks Player 1's streak and resets this streak's reward threshold.
  state = act(state, 1, { type: "submit" }).state;
  assert.equal(state.playerData["1"].streak, 0);
  assert.equal(state.playerData["1"].lastRewardedStreak, 0);
  state = act(state, 2, { type: "submit" }).state;

  for (let matchNumber = 1; matchNumber <= 3; matchNumber++) {
    const available = state.tiles.filter((tile) =>
      !tile.faceUp && !tile.selected && !tile.moving &&
      !["hazard", "dummy"].includes(tile.shape)).slice(0, 3);
    assert.equal(available.length, 3);
    for (const tile of available) tile.shape = "circle";
    for (const tile of available) {
      const picked = act(state, 1, { type: "pick", tileId: tile.id });
      assert.equal(picked.accepted, true, picked.error);
      state = picked.state;
    }
    const submitted = act(state, 1, { type: "submit" });
    assert.equal(submitted.accepted, true, submitted.error);
    state = submitted.state;
    if (matchNumber < 3) {
      assert.equal(state.activePlayerNumber, 2);
      state = act(state, 2, { type: "submit" }).state;
      assert.equal(state.activePlayerNumber, 1);
    }
  }

  assert.equal(state.playerData["1"].streak, 3);
  assert.equal(state.playerData["1"].stars, 7);
  assert.equal(state.playerData["1"].lastRewardedStreak, 3);
});

test("player snapshots publish a swap deadline without exposing hidden shapes", () => {
  const state = startPlaying();
  const endAt = NOW + INITIAL_REVIEW_MS + 2_000;
  state.tiles.find((tile) => tile.id === "t1").moving = true;
  state.tiles.find((tile) => tile.id === "t2").moving = true;
  state.shuffles = [{
    tileIds: ["t1", "t2"],
    steps: [[0, 1]],
    nextStep: 1,
    move: { tileIds: ["t1", "t2"], endsAt: endAt },
    nextAt: null
  }];
  const view = gameViewForPlayer(state, 1);
  assert.equal(view.shuffling, true);
  for (const id of ["t1", "t2"]) {
    const tile = view.tiles.find((candidate) => candidate.id === id);
    assert.equal(tile.moving, true);
    assert.equal(tile.movingUntil, endAt);
    assert.equal(tile.shape, null);
  }
});
