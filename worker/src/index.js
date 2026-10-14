import { DurableObject } from "cloudflare:workers";
import {
  isAllowedOrigin, isRoomCode, modeDetails, isRoomExpired,
  roomExpiryDeadline, ROOM_IDLE_TTL_MS, MAX_MESSAGE_BYTES, messageByteLength,
  nextMessageRateState
} from "./protocol.js";
import {
  createGameState, gameViewForPlayer, applyGameAction, advanceGameByTime, nextGameDeadline
} from "./game-engine.js";

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "shapey-multiplayer", stage: "mode-aware-rooms" }, 200, cors);
    }

    if (url.pathname === "/api/rooms" && request.method === "POST") {
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
  }

  async fetch(request) {
    const url = new URL(request.url);

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

    const connectedSockets = this.ctx.getWebSockets().filter(ws => ws.readyState === WebSocket.OPEN);
    if (connectedSockets.length >= room.maxPlayers) {
      return json({ error: "Room is full." }, 409);
    }

    const used = new Set(connectedSockets.map(ws => (ws.deserializeAttachment() || {}).playerNumber));
    let playerNumber = 1;
    while (used.has(playerNumber) && playerNumber <= room.maxPlayers) playerNumber++;
    if (playerNumber > room.maxPlayers) return json({ error: "Room is full." }, 409);

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.serializeAttachment({ playerNumber, mode: room.mode });
    this.ctx.acceptWebSocket(server);
    await this.touchRoom();
    server.send(JSON.stringify({
      type: "welcome",
      playerNumber,
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

    // Once all seats are connected, create one canonical game state inside this Durable Object.
    // Every participant receives a player-specific view; hidden tile shapes stay server-side.
    const connected = this.connectedCount();
    const existingGame = await this.ctx.storage.get("game");
    if (connected >= room.maxPlayers && !existingGame) {
      const playerNumbers = Array.from({ length: room.maxPlayers }, (_, index) => index + 1);
      const game = createGameState({
        roomCode: room.roomCode,
        mode: room.mode,
        playerNumbers
      });
      await this.ctx.storage.put("game", game);
      await this.broadcastGameState("game_started");
    } else if (existingGame) {
      // A returning connection must receive the authoritative current match state, not sit in the lobby.
      // The seat may be reassigned after a disconnect; persistent seat tokens are a follow-up hardening task.
      try {
        server.send(JSON.stringify({
          type: "game_started",
          state: gameViewForPlayer(existingGame, playerNumber)
        }));
      } catch {}
    }
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
    const deadlines = [roomDeadline, gameDeadline].filter(Number.isFinite);
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
        if (!Number.isInteger(attachment.playerNumber)) continue;
        ws.send(JSON.stringify({
          type,
          state: gameViewForPlayer(game, attachment.playerNumber)
        }));
      } catch {}
    }
  }

  connectedCount() {
    return this.ctx.getWebSockets().filter(ws => ws.readyState === WebSocket.OPEN).length;
  }

  playerList() {
    return this.ctx.getWebSockets().map(ws => ({
      playerNumber: (ws.deserializeAttachment() || {}).playerNumber,
      connected: ws.readyState === WebSocket.OPEN
    })).sort((a, b) => a.playerNumber - b.playerNumber);
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
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const game = await this.ctx.storage.get("game");
    if (game && advanceGameByTime(game, now)) {
      await this.ctx.storage.put("game", game);
      await this.broadcastGameState("game_state");
    }
    await this.scheduleAlarm();
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
