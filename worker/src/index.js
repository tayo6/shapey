import { DurableObject } from "cloudflare:workers";
import {
  isAllowedOrigin, isRoomCode, modeDetails, isRoomExpired,
  roomExpiryDeadline, ROOM_IDLE_TTL_MS, MAX_MESSAGE_BYTES, messageByteLength,
  nextMessageRateState, nextRoomCreationWindow
} from "./protocol.js";
import {
  createGameState, gameViewForPlayer, gameViewForSpectator, applyGameAction,
  advanceGameByTime, nextGameDeadline, SHAPE_KEYS
} from "./game-engine.js";

const MAX_SPECTATORS_PER_ROOM = 100;
const MAX_CHAT_CHARS = 280;
const CHAT_HISTORY_LIMIT = 50;
const AUDIENCE_POLL_MS = 20_000;

function shortRandomId() {
  return newSeatToken().slice(0, 12).toUpperCase();
}

function cleanChatText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\\u0000-\\u001f\\u007f]/g, " ").trim().slice(0, MAX_CHAT_CHARS);
}

function audiencePollSnapshot(poll) {
  if (!poll) return null;
  const counts = Object.fromEntries(poll.options.map(option => [option, 0]));
  for (const vote of Object.values(poll.votes || {})) {
    if (Object.prototype.hasOwnProperty.call(counts, vote)) counts[vote] += 1;
  }
  return {
    id: poll.id,
    startedByPlayer: poll.startedByPlayer,
    options: poll.options.slice(),
    counts,
    totalVotes: Object.values(counts).reduce((sum, value) => sum + value, 0),
    endsAt: poll.endsAt,
    closed: Boolean(poll.closed)
  };
}

// CORS and WebSocket origin policy share the tested protocol helper.

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
  if (isAllowedOrigin(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}

// Player-seat credentials are generated server-side and stored only as SHA-256 hashes.
// They let a returning browser reclaim its original seat without putting the secret in a URL.
function newSeatToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashSeatToken(token) {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(token)
  ));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        ok: true,
        service: "shapey-multiplayer",
        stage: "authoritative-gameplay-v1",
        protocolVersion: 1
      }, 200, cors);
    }

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      // Origin is a browser abuse barrier, not authentication. The per-IP limit below also
      // constrains direct API clients that forge Origin headers.
      if (!isAllowedOrigin(request.headers.get("Origin") || "")) {
        return json({ error: "Origin not allowed." }, 403, cors);
      }
      const clientAddress = request.headers.get("CF-Connecting-IP") || "unknown";
      const digest = new Uint8Array(await crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode(clientAddress)
      ));
      const limiterKey = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const limiter = env.ROOMS.get(env.ROOMS.idFromName("create-limit:" + limiterKey));
      const limited = await limiter.fetch("https://room.internal/rate-limit", { method: "POST" });
      if (limited.status === 429) {
        const detail = await limited.json();
        const retryAfter = limited.headers.get("Retry-After");
        return json(detail, 429, retryAfter ? { ...cors, "Retry-After": retryAfter } : cors);
      }
      if (!limited.ok) return json({ error: "Room creation is temporarily unavailable. Please retry later." }, 503, cors);

      let body;
      try { body = await request.json(); }
      catch { return json({ error: "Send a JSON body with mode set to pvp or tag." }, 400, cors); }
      const details = modeDetails(body?.mode);
      if (!details) return json({ error: "Choose Player 1 vs Player 2 (pvp) or Tag (tag)." }, 400, cors);

      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      for (let attempt = 0; attempt < 5; attempt++) {
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        const code = Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const created = await stub.fetch("https://room.internal/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomCode: code, ...details })
        });
        if (created.status === 409) continue;
        if (!created.ok) return json({ error: "Could not reserve a room. Please try again." }, 503, cors);
        return json({
          roomCode: code,
          websocketUrl: url.origin.replace(/^http/, "ws") + "/ws/" + code,
          status: "waiting",
          ...details
        }, 201, cors);
      }
      return json({ error: "Could not create a unique room code. Please try again." }, 503, cors);
    }

    const infoMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})$/);
    if (infoMatch && request.method === "GET") {
      const stub = env.ROOMS.get(env.ROOMS.idFromName(infoMatch[1]));
      const info = await stub.fetch("https://room.internal/info");
      const data = await info.json();
      return json(data, info.status, cors);
    }

    const match = url.pathname.match(/^\/ws\/([A-Z0-9]{6})$/);
    if (match && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      // CORS does not protect WebSocket handshakes; validate Origin explicitly.
      if (!isAllowedOrigin(request.headers.get("Origin") || "")) {
        return json({ error: "Origin not allowed." }, 403, cors);
      }
      return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
    }

    return json({
      error: "Not found",
      endpoints: ["GET /health", "POST /api/rooms", "GET /api/rooms/{ROOMCODE}", "WebSocket /ws/{ROOMCODE}?mode=pvp|tag"]
    }, 404, cors);
  }
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    // Serialize seat claims so simultaneous initial joins cannot claim the same seat.
    this.joinQueue = Promise.resolve();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/rate-limit" && request.method === "POST") {
      const timestamps = await this.ctx.storage.get("roomCreationTimestamps") || [];
      const result = nextRoomCreationWindow(timestamps, Date.now());
      await this.ctx.storage.put("roomCreationTimestamps", result.timestamps);
      if (!result.allowed) {
        return json(
          { error: "Too many rooms created from this connection. Please wait before trying again." },
          429,
          { "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)) }
        );
      }
      return json({ ok: true });
    }

    if (url.pathname === "/create" && request.method === "POST") {
      let data;
      try { data = await request.json(); }
      catch { return json({ error: "Invalid room setup." }, 400); }
      const details = modeDetails(data?.mode);
      if (!details || data.maxPlayers !== details.maxPlayers || !isRoomCode(data.roomCode)) {
        return json({ error: "Invalid room setup." }, 400);
      }
      const existing = await this.ctx.storage.get("room");
      if (existing) return json({ error: "Room code collision." }, 409);
      const now = Date.now();
      // Clear stale state if a random room code is ever reused after an earlier room expired.
      await this.ctx.storage.delete("game");
      await this.ctx.storage.delete("seatRegistry");
      await this.ctx.storage.delete("audiencePoll");
      await this.ctx.storage.delete("chatHistory");
      await this.ctx.storage.put("seatRegistry", { seats: [] });
      await this.ctx.storage.put("room", {
        roomCode: data.roomCode,
        mode: details.mode,
        maxPlayers: details.maxPlayers,
        createdAt: now,
        lastActivityAt: now
      });
      // Empty/waiting rooms expire; activity refreshes the alarm, with a hard maximum lifetime.
      await this.ctx.storage.setAlarm(now + ROOM_IDLE_TTL_MS);
      return json({ ok: true });
    }

    const room = await this.ctx.storage.get("room");
    if (!room) return json({ error: "Room not found. Check the code or create a new room." }, 404);

    if (isRoomExpired(room, Date.now(), this.connectedCount())) {
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.close(4000, "Room expired"); } catch {}
      }
      await this.ctx.storage.delete("room");
      await this.ctx.storage.delete("game");
      await this.ctx.storage.delete("seatRegistry");
      await this.ctx.storage.deleteAlarm();
      return json({ error: "Room expired. Please create a new room." }, 410);
    }

    if (url.pathname === "/info" && request.method === "GET") {
      const players = this.playerList();
      const connected = players.filter(player => player.connected).length;
      return json({
        roomCode: room.roomCode,
        mode: room.mode,
        maxPlayers: room.maxPlayers,
        status: connected >= room.maxPlayers ? "ready" : "waiting",
        players
      });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    const requestedMode = url.searchParams.get("mode");
    if (requestedMode !== room.mode) {
      return json({
        error: "This room is for " + (room.mode === "tag" ? "Tag (2 vs 2)" : "Player 1 vs Player 2") + "."
      }, 409);
    }

    // Player sockets are capped at room size; spectators have a separate, bounded capacity.
    const role = url.searchParams.get("role") === "spectator" ? "spectator" : "player";
    const openSockets = this.ctx.getWebSockets().filter(ws => ws.readyState === WebSocket.OPEN);
    const roleOf = ws => (ws.deserializeAttachment() || {}).role || "player";
    if (role === "spectator") {
      const spectatorCount = openSockets.filter(ws => roleOf(ws) === "spectator").length;
      if (spectatorCount >= MAX_SPECTATORS_PER_ROOM) {
        return json({ error: "This room has reached its spectator limit." }, 429);
      }
    } else {
      const playerSockets = openSockets.filter(ws => roleOf(ws) === "player");
      if (playerSockets.length >= room.maxPlayers) return json({ error: "Room is full." }, 409);
    }

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.serializeAttachment({ playerNumber: null, mode: room.mode, role, spectatorReady: false });
    this.ctx.acceptWebSocket(server);
    await this.scheduleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async scheduleAlarm() {
    const room = await this.ctx.storage.get("room");
    if (!room) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    const roomDeadline = roomExpiryDeadline(room, now, this.connectedCount());
    const game = await this.ctx.storage.get("game");
    const gameDeadline = nextGameDeadline(game);
    const poll = await this.ctx.storage.get("audiencePoll");
    const pollDeadline = poll && !poll.closed ? poll.endsAt : null;
    const deadlines = [roomDeadline, gameDeadline, pollDeadline].filter(Number.isFinite);
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.min(...deadlines));
    else await this.ctx.storage.deleteAlarm();
  }

  async broadcastGameState(type = "game_state") {
    const game = await this.ctx.storage.get("game");
    if (!game) return;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        if (ws.readyState !== WebSocket.OPEN) continue;
        const attachment = ws.deserializeAttachment() || {};
        if (Number.isInteger(attachment.playerNumber)) {
          ws.send(JSON.stringify({ type, state: gameViewForPlayer(game, attachment.playerNumber) }));
        } else if (attachment.role === "spectator" && attachment.spectatorReady) {
          ws.send(JSON.stringify({ type, state: gameViewForSpectator(game) }));
        }
      } catch {}
    }
  }

  connectedCount() {
    return this.ctx.getWebSockets().filter(ws => {
      const attachment = ws.deserializeAttachment() || {};
      return ws.readyState === WebSocket.OPEN && Number.isInteger(attachment.playerNumber);
    }).length;
  }

  playerList() {
    return this.ctx.getWebSockets()
      .map(ws => {
        const attachment = ws.deserializeAttachment() || {};
        return { playerNumber: attachment.playerNumber, connected: ws.readyState === WebSocket.OPEN };
      })
      .filter(player => Number.isInteger(player.playerNumber))
      .sort((a, b) => a.playerNumber - b.playerNumber);
  }

  spectatorCount() {
    return this.ctx.getWebSockets().filter(ws => {
      const attachment = ws.deserializeAttachment() || {};
      return ws.readyState === WebSocket.OPEN &&
        attachment.role === "spectator" && attachment.spectatorReady === true;
    }).length;
  }

  broadcast(message) {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(payload); } catch {}
    }
  }

  async touchRoom() {
    const room = await this.ctx.storage.get("room");
    if (!room) return null;
    room.lastActivityAt = Date.now();
    await this.ctx.storage.put("room", room);
    await this.scheduleAlarm();
    return room;
  }

  async closeExpiredAudiencePoll(game, now = Date.now()) {
    const poll = await this.ctx.storage.get("audiencePoll");
    if (!poll || poll.closed) return;
    if (poll.endsAt > now && (!game || game.status !== "finished") &&
        (!game || game.activePlayerNumber === poll.startedByPlayer)) return;
    const closed = { ...poll, closed: true, endsAt: Math.min(poll.endsAt, now) };
    await this.ctx.storage.delete("audiencePoll");
    this.broadcastAudiencePollState(closed);
  }

  broadcastAudiencePollState(poll) {
    this.broadcast({ type: "audience_poll_state", poll: audiencePollSnapshot(poll) });
  }

  async alarm() {
    const room = await this.ctx.storage.get("room");
    if (!room) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const now = Date.now();
    const connected = this.connectedCount();
    if (isRoomExpired(room, now, connected)) {
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.close(4000, "Room expired"); } catch {}
      }
      await this.ctx.storage.delete("room");
      await this.ctx.storage.delete("game");
      await this.ctx.storage.delete("seatRegistry");
      await this.ctx.storage.deleteAlarm();
      return;
    }

    let game = await this.ctx.storage.get("game");
    if (game && advanceGameByTime(game, now)) {
      await this.ctx.storage.put("game", game);
      await this.broadcastGameState("game_state");
      game = await this.ctx.storage.get("game");
    }
    await this.closeExpiredAudiencePoll(game, now);
    await this.scheduleAlarm();
  }

  async joinSeat(ws, data) {
    const rejectJoin = (message) => {
      try { ws.send(JSON.stringify({ type: "error", message })); } catch {}
      try { ws.close(1008, "Seat claim rejected"); } catch {}
    };
    // The queue protects the persistent seat registry from overlapping WebSocket join messages.
    let release;
    const previousJoin = this.joinQueue;
    this.joinQueue = new Promise(resolve => { release = resolve; });
    await previousJoin;

    try {
      if (ws.readyState !== WebSocket.OPEN) return;
      const attachment = ws.deserializeAttachment() || {};
      if (Number.isInteger(attachment.playerNumber)) {
        rejectJoin("This connection already has a player seat.");
        return;
      }

      const room = await this.ctx.storage.get("room");
      if (!room) {
        rejectJoin("Room not found. Please create a new room.");
        return;
      }

      const suppliedToken = data.seatToken;
      let registry = await this.ctx.storage.get("seatRegistry") || { seats: [] };
      if (!Array.isArray(registry.seats)) registry = { seats: [] };

      let seat;
      let seatToken;
      if (suppliedToken == null || suppliedToken === "") {
        // A new device can claim only a seat that has never been assigned in this room.
        // Previously assigned seats remain reserved for their token for the room's lifetime.
        const reserved = new Set(registry.seats.map(item => item.playerNumber));
        let playerNumber = 1;
        while (reserved.has(playerNumber) && playerNumber <= room.maxPlayers) playerNumber++;
        if (playerNumber > room.maxPlayers) {
          rejectJoin("Every seat in this room has already been assigned. Reconnect from the device that first claimed your seat, or create a new room.");
          return;
        }
        seatToken = newSeatToken();
        seat = {
          playerNumber,
          tokenHash: await hashSeatToken(seatToken),
          createdAt: Date.now()
        };
        registry.seats.push(seat);
      } else {
        if (typeof suppliedToken !== "string" || !/^[a-f0-9]{64}$/.test(suppliedToken)) {
          rejectJoin("The saved player session is invalid. Create a new room or clear the saved session for this room.");
          return;
        }
        const tokenHash = await hashSeatToken(suppliedToken);
        seat = registry.seats.find(item => item.tokenHash === tokenHash);
        if (!seat || !Number.isInteger(seat.playerNumber) ||
            seat.playerNumber < 1 || seat.playerNumber > room.maxPlayers) {
          rejectJoin("That player session is not valid for this room. Create a new room.");
          return;
        }
        seatToken = suppliedToken;
      }

      const playerNumber = seat.playerNumber;
      const duplicate = this.ctx.getWebSockets().some(other => {
        if (other === ws || other.readyState !== WebSocket.OPEN) return false;
        return (other.deserializeAttachment() || {}).playerNumber === playerNumber;
      });
      if (duplicate) {
        rejectJoin("That player seat is already connected on another device.");
        try { ws.close(1008, "Seat already connected"); } catch {}
        return;
      }

      // Commit the seat assignment before any broadcast or game-start decision.
      ws.serializeAttachment({ ...attachment, playerNumber, mode: room.mode });
      await this.ctx.storage.put("seatRegistry", registry);
      await this.touchRoom();
      ws.send(JSON.stringify({
        type: "welcome",
        playerNumber,
        seatToken,
        roomCode: room.roomCode,
        mode: room.mode,
        maxPlayers: room.maxPlayers
      }));
      this.broadcast({
        type: "room_state",
        roomCode: room.roomCode,
        mode: room.mode,
        maxPlayers: room.maxPlayers,
        status: this.connectedCount() >= room.maxPlayers ? "ready" : "waiting",
        players: this.playerList()
      });

      // Once all assigned seats are connected, create the one canonical game state.
      const connected = this.connectedCount();
      const existingGame = await this.ctx.storage.get("game");
      if (connected >= room.maxPlayers && !existingGame) {
        const playerNumbers = Array.from({ length: room.maxPlayers }, (_, index) => index + 1);
        const game = createGameState({ roomCode: room.roomCode, mode: room.mode, playerNumbers });
        await this.ctx.storage.put("game", game);
        await this.broadcastGameState("game_started");
      } else if (existingGame) {
        // A returning device receives the canonical state for its original seat.
        try {
          ws.send(JSON.stringify({
            type: "game_started",
            state: gameViewForPlayer(existingGame, playerNumber)
          }));
        } catch {}
      }
      await this.scheduleAlarm();
    } finally {
      release();
    }
  }

  async joinSpectator(ws) {
    const attachment = ws.deserializeAttachment() || {};
    if (attachment.role !== "spectator") {
      try { ws.send(JSON.stringify({ type: "error", message: "This connection is not a spectator connection." })); } catch {}
      return;
    }
    if (attachment.spectatorReady) return;
    const room = await this.ctx.storage.get("room");
    if (!room) {
      try { ws.send(JSON.stringify({ type: "error", message: "Room not found. Create a new room or check the code." })); } catch {}
      return;
    }
    attachment.spectatorReady = true;
    attachment.spectatorId = shortRandomId();
    ws.serializeAttachment(attachment);
    const game = await this.ctx.storage.get("game");
    const history = (await this.ctx.storage.get("chatHistory") || []).slice(-CHAT_HISTORY_LIMIT);
    const poll = await this.ctx.storage.get("audiencePoll");
    ws.send(JSON.stringify({
      type: "spectator_welcome",
      roomCode: room.roomCode,
      mode: room.mode,
      status: game ? game.status : (this.connectedCount() >= room.maxPlayers ? "ready" : "waiting"),
      players: this.playerList(),
      spectatorCount: this.spectatorCount(),
      state: game ? gameViewForSpectator(game) : null,
      chatHistory: history,
      poll: poll && !poll.closed && poll.endsAt > Date.now() ? audiencePollSnapshot(poll) : null
    }));
    this.broadcast({ type: "spectator_count", count: this.spectatorCount() });
    await this.touchRoom();
  }

  async postChat(ws, data) {
    const attachment = ws.deserializeAttachment() || {};
    const isPlayer = Number.isInteger(attachment.playerNumber);
    const isSpectator = attachment.role === "spectator" && attachment.spectatorReady;
    if (!isPlayer && !isSpectator) {
      ws.send(JSON.stringify({ type: "error", message: "Join the room before sending chat." }));
      return;
    }
    const content = cleanChatText(data?.text);
    if (!content) {
      ws.send(JSON.stringify({ type: "error", message: "Chat messages cannot be empty." }));
      return;
    }
    const entry = {
      id: shortRandomId(),
      sender: isPlayer ? "Player " + attachment.playerNumber : "Spectator " + attachment.spectatorId.slice(-4),
      role: isPlayer ? "player" : "spectator",
      text: content,
      at: Date.now()
    };
    const history = await this.ctx.storage.get("chatHistory") || [];
    history.push(entry);
    await this.ctx.storage.put("chatHistory", history.slice(-CHAT_HISTORY_LIMIT));
    this.broadcast({ type: "chat_message", message: entry });
    await this.touchRoom();
  }

  async startAudiencePoll(ws) {
    const attachment = ws.deserializeAttachment() || {};
    if (!Number.isInteger(attachment.playerNumber)) {
      ws.send(JSON.stringify({ type: "error", message: "Only players can start an audience poll." }));
      return;
    }
    const room = await this.ctx.storage.get("room");
    const game = await this.ctx.storage.get("game");
    const now = Date.now();
    if (!room || room.mode !== "tag") {
      ws.send(JSON.stringify({ type: "error", message: "Audience polls are available in Tag only." }));
      return;
    }
    if (!game || game.status !== "playing" || game.pendingEffect ||
        game.activePlayerNumber !== attachment.playerNumber) {
      ws.send(JSON.stringify({ type: "error", message: "Start a poll only during your active Tag turn." }));
      return;
    }
    const existing = await this.ctx.storage.get("audiencePoll");
    if (existing && !existing.closed && existing.endsAt > now) {
      this.broadcastAudiencePollState(existing);
      return;
    }
    const candidates = SHAPE_KEYS.filter(shape => shape !== "cancel");
    const options = [];
    while (options.length < 4 && candidates.length) {
      const index = Math.floor(Math.random() * candidates.length);
      options.push(candidates.splice(index, 1)[0]);
    }
    const poll = {
      id: shortRandomId(),
      startedByPlayer: attachment.playerNumber,
      startedAt: now,
      endsAt: Math.min(now + AUDIENCE_POLL_MS, Number(game.turnEndsAt) || now + AUDIENCE_POLL_MS),
      options,
      votes: {},
      closed: false
    };
    if (poll.endsAt <= now) {
      ws.send(JSON.stringify({ type: "error", message: "There is not enough time left to open a poll." }));
      return;
    }
    await this.ctx.storage.put("audiencePoll", poll);
    this.broadcastAudiencePollState(poll);
    await this.scheduleAlarm();
    await this.touchRoom();
  }

  async handlePollVote(ws, data) {
    const attachment = ws.deserializeAttachment() || {};
    if (attachment.role !== "spectator" || !attachment.spectatorReady || !attachment.spectatorId) {
      ws.send(JSON.stringify({ type: "error", message: "Only joined spectators can vote in the audience poll." }));
      return;
    }
    const poll = await this.ctx.storage.get("audiencePoll");
    if (!poll || poll.closed || poll.endsAt <= Date.now()) {
      ws.send(JSON.stringify({ type: "error", message: "There is no active audience poll." }));
      return;
    }
    if (typeof data?.shape !== "string" || !poll.options.includes(data.shape)) {
      ws.send(JSON.stringify({ type: "error", message: "Choose one of the poll's listed options." }));
      return;
    }
    poll.votes[attachment.spectatorId] = data.shape;
    await this.ctx.storage.put("audiencePoll", poll);
    this.broadcastAudiencePollState(poll);
    await this.touchRoom();
  }

  async webSocketMessage(ws, message) {
    const byteLength = messageByteLength(message);
    if (byteLength > MAX_MESSAGE_BYTES) {
      try { ws.send(JSON.stringify({ type: "error", message: "Message is too large." })); } catch {}
      try { ws.close(1009, "Message too large"); } catch {}
      return;
    }

    const attachment = ws.deserializeAttachment() || {};
    const rate = nextMessageRateState(attachment, Date.now());
    attachment.messageWindowStartedAt = rate.messageWindowStartedAt;
    attachment.messageCount = rate.messageCount;
    ws.serializeAttachment(attachment);
    if (!rate.allowed) {
      try { ws.send(JSON.stringify({ type: "error", message: "Too many messages. Slow down and reconnect." })); } catch {}
      try { ws.close(1008, "Message rate exceeded"); } catch {}
      return;
    }

    await this.touchRoom();
    let data;
    try {
      data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Messages must be JSON." }));
      return;
    }
    if (data?.type === "join") {
      const attachment = ws.deserializeAttachment() || {};
      if (attachment.role === "spectator") {
        ws.send(JSON.stringify({ type: "error", message: "Spectators cannot claim a player seat." }));
        return;
      }
      await this.joinSeat(ws, data);
      return;
    }
    if (data?.type === "spectate") {
      await this.joinSpectator(ws);
      return;
    }

    const joinedAttachment = ws.deserializeAttachment() || {};
    const isSpectator = joinedAttachment.role === "spectator" && joinedAttachment.spectatorReady === true;
    if (!Number.isInteger(joinedAttachment.playerNumber) && !isSpectator) {
      ws.send(JSON.stringify({ type: "error", message: "Join a player seat or spectator room first." }));
      return;
    }

    if (data?.type === "chat") {
      await this.postChat(ws, data);
      return;
    }
    if (data?.type === "poll_vote") {
      await this.handlePollVote(ws, data);
      return;
    }
    if (data?.type === "audience_poll_start") {
      await this.startAudiencePoll(ws);
      return;
    }
    if (isSpectator && data?.type !== "ping") {
      ws.send(JSON.stringify({ type: "error", message: "Spectators can only chat, vote, or ping." }));
      return;
    }

    if (data?.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", at: Date.now() }));
      return;
    }
    if (data?.type === "ready") {
      const attachment = ws.deserializeAttachment() || {};
      this.broadcast({
        type: "player_ready",
        playerNumber: attachment.playerNumber,
        ready: Boolean(data.ready)
      });
      return;
    }

    if (data?.type === "game_action") {
      const game = await this.ctx.storage.get("game");
      if (!game) {
        ws.send(JSON.stringify({ type: "error", message: "Waiting for all players to connect." }));
        return;
      }
      const attachment = ws.deserializeAttachment() || {};
      const result = applyGameAction(game, attachment.playerNumber, data.action, Date.now());
      if (result.changed) await this.ctx.storage.put("game", result.state);
      if (!result.accepted) {
        ws.send(JSON.stringify({ type: "error", message: result.error || "Action rejected." }));
      }
      if (result.accepted || result.changed) {
        await this.broadcastGameState("game_state");
        const updatedGame = await this.ctx.storage.get("game");
        await this.closeExpiredAudiencePoll(updatedGame, Date.now());
        await this.touchRoom();
      } else {
        await this.scheduleAlarm();
      }
      return;
    }

    ws.send(JSON.stringify({ type: "error", message: "Unsupported message type." }));
  }

  async webSocketClose(ws) {
    const attachment = ws.deserializeAttachment() || {};
    await this.touchRoom();
    if (attachment.role === "spectator") {
      this.broadcast({ type: "spectator_count", count: this.spectatorCount() });
      return;
    }
    if (!Number.isInteger(attachment.playerNumber)) return;
    const room = await this.ctx.storage.get("room");
    this.broadcast({
      type: "player_disconnected",
      playerNumber: attachment.playerNumber,
      mode: room?.mode,
      maxPlayers: room?.maxPlayers,
      players: this.playerList()
    });
  }

  webSocketError(ws) {
    try { ws.close(1011, "WebSocket error"); } catch {}
  }
}
