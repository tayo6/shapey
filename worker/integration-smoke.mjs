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

  function waitFor(predicate, timeout = WAIT_MS, label = "") {
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        const queued = queue.slice(-8).map((item) => item.type + (item.type === "error" ? ": " + item.message : "")).join(", ");
        reject(new Error("Timed out waiting for " + (label || "a Worker message") + "." +
          (queued ? " Unmatched messages: " + queued : " No unmatched messages were received.")));
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

async function joinSpectator(room, mode) {
  const client = createClient(room.websocketUrl + "?mode=" + encodeURIComponent(mode) + "&role=spectator");
  await waitForOpen(client);
  client.send({ type: "spectate" });
  // The caller reads spectator_welcome to assert board privacy and current poll state.
  return client;
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
  const deniedDirectory = await fetch(BASE_URL + "/api/rooms", {
    headers: { Origin: "https://not-allowed.example" }
  });
  assert.equal(deniedDirectory.status, 403, "Public directory CORS must reject unapproved origins.");

  const [pvpRoom, tagRoom] = await Promise.all([createRoom("pvp"), createRoom("tag")]);
  const directoryResponse = await fetch(BASE_URL + "/api/rooms", {
    headers: { Origin: ALLOWED_ORIGIN }
  });
  const directory = await directoryResponse.json();
  assert.equal(directoryResponse.status, 200, JSON.stringify(directory));
  assert.ok(directory.rooms.some(room => room.roomCode === pvpRoom.roomCode && room.mode === "pvp"),
    "New PvP rooms must be browsable before players join.");
  assert.ok(directory.rooms.some(room => room.roomCode === tagRoom.roomCode && room.mode === "tag"),
    "New Tag rooms must be browsable before players join.");
  assert.ok(directory.rooms.every(room => !("websocketUrl" in room) && !("seatToken" in room)),
    "The public room directory must not expose player connection credentials.");
  const tagDirectoryResponse = await fetch(BASE_URL + "/api/rooms?mode=tag", {
    headers: { Origin: ALLOWED_ORIGIN }
  });
  const tagDirectory = await tagDirectoryResponse.json();
  assert.equal(tagDirectoryResponse.status, 200, JSON.stringify(tagDirectory));
  assert.ok(tagDirectory.rooms.every(room => room.mode === "tag"), "Mode filters must be applied server-side.");
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
    const liveDirectoryResponse = await fetch(BASE_URL + "/api/rooms", {
      headers: { Origin: ALLOWED_ORIGIN }
    });
    const liveDirectory = await liveDirectoryResponse.json();
    assert.ok(liveDirectory.rooms.some(room => room.roomCode === tagRoom.roomCode && room.status === "live"),
      "The public directory must update when a Tag room starts playing.");

    // A spectator can watch a live Tag room without receiving player-only inventory data.
    const audience = await joinSpectator(tagRoom, "tag");
    allClients.push(audience);
    const watched = await audience.waitFor((message) => message.type === "spectator_welcome", WAIT_MS, "spectator welcome");
    assert.equal(watched.mode, "tag");
    assert.equal(watched.state.status, "playing");
    assert.equal("me" in watched.state, false);
    assert.ok(watched.state.tiles.every((tile) => !tile.faceUp && tile.shape === null),
      "Spectator snapshots must keep hidden shapes private.");

    // The active player reveals one shape, then asks the audience to choose among hidden tiles.
    const studyTiles = tagInitialMessages[0].state.tiles.filter((tile) =>
      tile.shape && !["hazard", "dummy", "cancel"].includes(tile.shape));
    const shapeGroups = new Map();
    for (const tile of studyTiles) {
      if (!shapeGroups.has(tile.shape)) shapeGroups.set(tile.shape, []);
      shapeGroups.get(tile.shape).push(tile);
    }
    const matchingTriple = [...shapeGroups.values()].find((tiles) => tiles.length >= 3)?.slice(0, 3);
    assert.ok(matchingTriple, "The Tag study board should include a normal-shape triple for poll testing.");
    tagClients[0].send({ type: "game_action", action: { type: "pick", tileId: matchingTriple[0].id } });
    await tagClients[0].waitFor((message) =>
      message.type === "game_state" && message.state?.selectedTileIds?.length === 1,
      WAIT_MS, "player reveals first shape before asking audience");
    tagClients[0].send({ type: "audience_poll_start" });
    const poll = await audience.waitFor((message) =>
      message.type === "audience_poll_state" && message.poll && !message.poll.closed, WAIT_MS, "audience poll broadcast");
    assert.equal(poll.poll.options.length, 4);
    assert.equal(poll.poll.initialShape, matchingTriple[0].shape);
    assert.ok(poll.poll.options.some((option) => option.tileId && Number.isInteger(option.row) && Number.isInteger(option.col)),
      "Poll options must point to hidden board tiles, not reveal their shapes.");
    audience.send({ type: "poll_vote", tileId: poll.poll.options[0].tileId });
    const voted = await tagClients[0].waitFor((message) =>
      message.type === "audience_poll_state" && message.poll?.id === poll.poll.id &&
      !message.poll.closed, WAIT_MS, "player receives spectator vote broadcast");
    assert.equal("counts" in voted.poll, false,
      "Live vote counts must stay hidden until the audience poll closes.");
    assert.equal("totalVotes" in voted.poll, false,
      "Live total vote counts must stay hidden until the audience poll closes.");
    audience.send({ type: "poll_vote", tileId: poll.poll.options[1].tileId });
    const duplicateVote = await audience.waitFor((message) =>
      message.type === "error" && /already voted/i.test(message.message || ""),
      WAIT_MS, "second vote from one spectator is rejected");
    assert.match(duplicateVote.message, /already voted/i);

    const finalPoll = await audience.waitFor((message) =>
      message.type === "audience_poll_state" && message.poll?.id === poll.poll.id &&
      message.poll.closed, 35_000, "closed audience poll reveals final results");
    assert.equal(finalPoll.poll.totalVotes, 1);
    assert.equal(finalPoll.poll.counts[poll.poll.options[0].tileId], 1);
    const postPollTurn = await tagClients[0].waitFor((message) =>
      message.type === "game_state" && message.state?.revision > tagPlaying[0].revision + 2 &&
      message.state?.activePlayerNumber === 1 && message.state?.selectedTileIds?.length === 1,
      WAIT_MS, "Tag player's turn and selected shape are restored after poll");
    let tagRevision = postPollTurn.state.revision;

    // Live chat is relayed to players and spectators with bounded, plain-text messages.
    audience.send({ type: "chat", text: "Hello <audience> viewer" });
    const playerChat = await tagClients[0].waitFor((message) =>
      message.type === "chat_message" && message.message?.text === "Hello <audience> viewer", WAIT_MS, "player receives audience chat");
    const audienceChat = await audience.waitFor((message) =>
      message.type === "chat_message" && message.message?.text === "Hello <audience> viewer", WAIT_MS, "audience receives chat echo");
    assert.equal(playerChat.message.role, "spectator");
    assert.match(playerChat.message.sender, /^Spectator /);
    assert.equal(audienceChat.message.id, playerChat.message.id);

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
    for (const [current, next] of [[1, 3], [3, 2], [2, 4], [4, 1]]) {
      const actor = tagClients[current - 1];
      actor.send({ type: "game_action", action: { type: "submit" } });
      const updates = await Promise.all(tagClients.map((client) =>
        client.waitFor((message) =>
          message.type === "game_state" && message.state.revision > tagRevision)));
      for (const update of updates) assert.equal(update.state.activePlayerNumber, next);
      tagRevision = updates[0].state.revision;
    }

    // AI vs AI demo rooms start without player seats, let the audience watch automated turns,
    // and can be ended by the person who created the demo.
    const demoRoom = await createRoom("demo");
    assert.match(demoRoom.demoControlToken, /^[a-f0-9]{64}$/);
    assert.equal(demoRoom.maxPlayers, 0);
    const demoAudience = await joinSpectator(demoRoom, "demo");
    allClients.push(demoAudience);
    const demoWelcome = await demoAudience.waitFor((message) => message.type === "spectator_welcome", WAIT_MS, "AI demo spectator welcome");
    assert.equal(demoWelcome.mode, "demo");
    assert.equal(demoWelcome.state.mode, "demo");
    assert.equal(demoWelcome.state.status, "study");
    demoAudience.send({ type: "demo_control", token: demoRoom.demoControlToken });
    await demoAudience.waitFor((message) => message.type === "demo_control_ready", WAIT_MS, "AI demo control permission");
    const aiMove = await demoAudience.waitFor((message) =>
      message.type === "game_state" && message.state?.mode === "demo" &&
      message.state?.status === "playing" && message.state.selectedTileIds?.length >= 1,
      WAIT_MS, "automatic AI tile pick");
    assert.ok(aiMove.state.activePlayerNumber === 1 || aiMove.state.activePlayerNumber === 2);
    demoAudience.send({ type: "end_demo" });
    await demoAudience.waitFor((message) => message.type === "demo_ended", WAIT_MS, "AI demo end");
    const deletedDemo = await fetch(BASE_URL + "/api/rooms/" + demoRoom.roomCode, {
      headers: { Origin: ALLOWED_ORIGIN }
    });
    assert.equal(deletedDemo.status, 404, "Ending the demo should delete its room data.");

    console.log("Local Worker integration passed: origin guard, PvP scoring/reconnect, Tag turn sequence, audience chat/polls, and AI demo auto-play/cleanup.");
  } finally {
    await Promise.all(allClients.map((client) => client.close()));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
