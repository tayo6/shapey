import assert from "node:assert/strict";
import WebSocket from "ws";

const BASE_URL = process.env.SHAPEY_TEST_URL || "http://127.0.0.1:8787";
const ALLOWED_ORIGIN = "https://tayo6.github.io";
const WAIT_MS = 25_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createClient(url) {
  const socket = new WebSocket(url, { headers: { Origin: ALLOWED_ORIGIN } });
  const queue = [];
  const waiters = [];

  function onMessage(raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    for (let i = 0; i < waiters.length; i++) {
      if (waiters[i].predicate(message)) {
        const [waiter] = waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        return;
      }
    }
    queue.push(message);
  }
  socket.on("message", onMessage);
  socket.on("error", (error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });

  function waitFor(predicate, timeout = WAIT_MS) {
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error("Timed out waiting for a Worker message."));
      }, timeout);
      waiters.push(waiter);
    });
  }

  function send(message) {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not open.");
    socket.send(JSON.stringify(message));
  }

  function close() {
    if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      socket.once("close", resolve);
      try { socket.close(); } catch { resolve(); }
      setTimeout(resolve, 1_000).unref?.();
    });
  }

  return { socket, waitFor, send, close };
}

async function waitForOpen(client) {
  if (client.socket.readyState === WebSocket.OPEN) return;
  await new Promise((resolve, reject) => {
    client.socket.once("open", resolve);
    client.socket.once("error", reject);
  });
}

async function createRoom(mode) {
  const response = await fetch(BASE_URL + "/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
    body: JSON.stringify({ mode })
  });
  const data = await response.json();
  assert.equal(response.status, 201, JSON.stringify(data));
  assert.ok(data.roomCode);
  return data;
}

async function joinRoom(room, mode, seatToken = null) {
  const client = createClient(room.websocketUrl + "?mode=" + encodeURIComponent(mode));
  await waitForOpen(client);
  client.send({ type: "join", seatToken });
  const welcome = await client.waitFor((message) => message.type === "welcome");
  return { ...client, playerNumber: welcome.playerNumber, seatToken: welcome.seatToken };
}

async function playingState(client) {
  const message = await client.waitFor((item) =>
    (item.type === "game_started" || item.type === "game_state") &&
    item.state?.status === "playing");
  return message.state;
}

async function run() {
  // Verify the test server is running the matching protocol before creating rooms.
  let health;
  const healthDeadline = Date.now() + 30_000;
  while (Date.now() < healthDeadline) {
    try {
      const response = await fetch(BASE_URL + "/health");
      health = await response.json();
      if (response.ok && health.protocolVersion === 1 &&
          health.stage === "authoritative-gameplay-v1") break;
    } catch {}
    await delay(250);
  }
  assert.equal(health?.protocolVersion, 1, "Local Worker did not start with protocol v1.");

  const denied = await fetch(BASE_URL + "/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://not-allowed.example" },
    body: JSON.stringify({ mode: "pvp" })
  });
  assert.equal(denied.status, 403, "Room creation must reject an unapproved origin.");

  const [pvpRoom, tagRoom] = await Promise.all([createRoom("pvp"), createRoom("tag")]);
  const allClients = [];

  try {
    // PvP: two clients, distinct device connections.
    const pvp1 = await joinRoom(pvpRoom, "pvp");
    allClients.push(pvp1);
    assert.equal(pvp1.playerNumber, 1);
    const pvp2 = await joinRoom(pvpRoom, "pvp");
    allClients.push(pvp2);
    assert.equal(pvp2.playerNumber, 2);

    const [pvpInitial1, pvpInitial2] = await Promise.all([
      pvp1.waitFor((message) => message.type === "game_started"),
      pvp2.waitFor((message) => message.type === "game_started")
    ]);
    assert.equal(pvpInitial1.state.mode, "pvp");
    assert.equal(pvpInitial1.state.targetScore, 100);
    assert.equal(pvpInitial1.state.status, "study");
    assert.equal(pvpInitial1.state.tiles.length, 49);
    assert.deepEqual(pvpInitial1.state.players, [1, 2]);

    // Tag: four device connections. Start this while the PvP study phase is counting down,
    // so the integration suite waits only once for the 15-second shared study phase.
    const tagClients = [];
    for (let number = 1; number <= 4; number++) {
      const client = await joinRoom(tagRoom, "tag");
      allClients.push(client);
      tagClients.push(client);
      assert.equal(client.playerNumber, number);
    }
    const tagInitialMessages = await Promise.all(tagClients.map((client) =>
      client.waitFor((message) => message.type === "game_started")));
    for (const message of tagInitialMessages) {
      assert.equal(message.state.mode, "tag");
      assert.equal(message.state.targetScore, 200);
      assert.deepEqual(message.state.players, [1, 3, 2, 4]);
      assert.equal(message.state.activePlayerNumber, 1);
    }

    const [pvpPlaying1, pvpPlaying2, ...tagPlaying] = await Promise.all([
      playingState(pvp1), playingState(pvp2), ...tagClients.map(playingState)
    ]);
    for (const state of [pvpPlaying1, pvpPlaying2, ...tagPlaying]) {
      assert.equal(state.status, "playing");
      assert.ok(state.tiles.every((tile) => !tile.faceUp && tile.shape === null),
        "Face-down shapes must remain hidden in client snapshots.");
    }

    // Player 2 cannot submit a move while Player 1 owns the turn.
    pvp2.send({ type: "game_action", action: { type: "pick", tileId: pvpPlaying2.tiles[0].id } });
    const rejection = await pvp2.waitFor((message) => message.type === "error");
    assert.match(rejection.message, /not your turn/i);

    // Use a same-shape triple memorized from the 15-second study snapshot to finish
    // one real server-validated match through the WebSocket protocol.
    const knownTiles = pvpInitial1.state.tiles.filter((tile) =>
      tile.shape && !["hazard", "dummy"].includes(tile.shape));
    const target = new Map();
    for (const tile of knownTiles) {
      if (!target.has(tile.shape)) target.set(tile.shape, []);
      target.get(tile.shape).push(tile.id);
    }
    const triple = [...target.values()].find((ids) => ids.length >= 3)?.slice(0, 3);
    assert.ok(triple, "The opening board must contain at least one valid triple.");

    let revision = pvpPlaying1.revision;
    for (const tileId of triple) {
      pvp1.send({ type: "game_action", action: { type: "pick", tileId } });
      const update = await pvp1.waitFor((message) =>
        message.type === "game_state" && message.state.revision > revision);
      revision = update.state.revision;
    }
    pvp1.send({ type: "game_action", action: { type: "submit" } });
    const scored = await pvp1.waitFor((message) =>
      message.type === "game_state" && message.state.revision > revision);
    assert.deepEqual(scored.state.scores, [1, 0]);
    assert.equal(scored.state.activePlayerNumber, 2);

    // Closing and reconnecting with the saved seat token must restore the same player number and game.
    const pvpSeatToken = pvp1.seatToken;
    assert.match(pvpSeatToken, /^[a-f0-9]{64}$/);
    await pvp1.close();
    const pvp1Rejoined = await joinRoom(pvpRoom, "pvp", pvpSeatToken);
    allClients.push(pvp1Rejoined);
    assert.equal(pvp1Rejoined.playerNumber, 1);
    assert.equal(pvp1Rejoined.seatToken, pvpSeatToken);
    const resumed = await pvp1Rejoined.waitFor((message) => message.type === "game_started");
    assert.equal(resumed.state.activePlayerNumber, 2);
    assert.deepEqual(resumed.state.scores, [1, 0]);

    // Tag: execute four real empty-turn submissions and verify that the Worker enforces P1→P3→P2→P4.
    let tagRevision = tagPlaying[0].revision;
    for (const [current, next] of [[1, 3], [3, 2], [2, 4], [4, 1]]) {
      const actor = tagClients[current - 1];
      actor.send({ type: "game_action", action: { type: "submit" } });
      const updates = await Promise.all(tagClients.map((client) =>
        client.waitFor((message) =>
          message.type === "game_state" && message.state.revision > tagRevision)));
      for (const update of updates) assert.equal(update.state.activePlayerNumber, next);
      tagRevision = updates[0].state.revision;
    }

    console.log("Local Worker integration passed: origin guard, 2-client PvP match/scoring, stable reconnect seat and state recovery, hidden shapes, out-of-turn rejection, and 4-client Tag turn sequence.");
  } finally {
    await Promise.all(allClients.map((client) => client.close()));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
