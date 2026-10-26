// Shapey Worker - the Room Durable Object: room lifecycle, the live directory bridge,
// broadcasts, the alarm and WebSocket connect/close handling. Seat claiming, chat, polls,
// the message dispatcher and the demo bot are prototype mixins (room-*.js) composed onto
// this class, so every method still sees the same `this` (the Durable Object stub).

import { DurableObject } from "cloudflare:workers";
import {
  isRoomCode, isBoardSize, modeDetails, isRoomExpired,
  roomExpiryDeadline, nextRoomCreationWindow
} from "./protocol.js";
import {
  createGameState, gameViewForPlayer, gameViewForSpectator,
  advanceGameByTime, nextGameDeadline, AI_TURN_MS
} from "./game-engine.js";
import {
  json, hashSeatToken, MAX_SPECTATORS_PER_ROOM, LIVE_DIRECTORY_OBJECT_NAME,
  LIVE_DIRECTORY_PREFIX, LIVE_DIRECTORY_STALE_MS, LIVE_DIRECTORY_REFRESH_MS
} from "./lib.js";
import { RoomPollsMixin } from "./room-polls.js";
import { RoomDemoMixin } from "./room-demo.js";
import { RoomSeatsMixin } from "./room-seats.js";
import { RoomMessagesMixin } from "./room-messages.js";
import { clearRoomStorage } from "./room-storage.js";

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.lastDirectorySignature = null;
    this.lastDirectoryPublishedAt = 0;
    // Serialize seat claims so simultaneous initial joins cannot claim the same seat.
    this.joinQueue = Promise.resolve();
  }

  async fetch(request) {
    const url = new URL(request.url);

    // A dedicated singleton instance of this class stores lightweight public room cards.
    // Its internal routes are only reached through the Worker binding, never the public router.
    if (url.pathname === "/directory/list" && request.method === "GET") {
      const now = Date.now();
      const stored = await this.ctx.storage.list({ prefix: LIVE_DIRECTORY_PREFIX });
      const rooms = [];
      for (const [key, room] of stored.entries()) {
        if (!room || !Number.isFinite(room.expiresAt) || room.expiresAt <= now ||
            !["waiting", "ready", "starting", "live"].includes(room.status)) {
          await this.ctx.storage.delete(key);
          continue;
        }
        rooms.push(room);
      }
      const requestedMode = url.searchParams.get("mode");
      const requestedStatus = url.searchParams.get("status");
      const filtered = rooms.filter(room =>
        (!["pvp", "tag"].includes(requestedMode) || room.mode === requestedMode) &&
        (!["waiting", "ready", "starting", "live"].includes(requestedStatus) || room.status === requestedStatus));
      const statusRank = { live: 0, starting: 1, ready: 2, waiting: 3 };
      filtered.sort((a, b) => statusRank[a.status] - statusRank[b.status] || b.updatedAt - a.updatedAt);
      return json({ rooms: filtered, count: filtered.length, generatedAt: now }, 200, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/directory/upsert" && request.method === "POST") {
      let data;
      try { data = await request.json(); }
      catch { return json({ error: "Invalid directory entry." }, 400); }
      const details = modeDetails(data?.mode);
      const boardSize = data.boardSize === undefined ? 7 : data.boardSize;
      const statuses = ["waiting", "ready", "starting", "live"];
      if (!details || !isRoomCode(data?.roomCode) || !statuses.includes(data?.status) || !isBoardSize(boardSize)) {
        return json({ error: "Invalid directory entry." }, 400);
      }
      const now = Date.now();
      const scores = Array.isArray(data.scores) && data.scores.length >= 2 &&
        data.scores.slice(0, 2).every(Number.isFinite) ? data.scores.slice(0, 2) : [0, 0];
      const activePlayerNumber = Number.isInteger(data.activePlayerNumber) &&
        data.activePlayerNumber >= 1 && data.activePlayerNumber <= details.maxPlayers
        ? data.activePlayerNumber : null;
      const summary = {
        roomCode: data.roomCode,
        mode: details.mode,
        status: data.status,
        playerCount: Number.isInteger(data.playerCount) ? Math.min(details.maxPlayers, Math.max(0, data.playerCount)) : 0,
        maxPlayers: details.maxPlayers,
        boardSize,
        spectatorCount: Number.isInteger(data.spectatorCount) ? Math.min(MAX_SPECTATORS_PER_ROOM, Math.max(0, data.spectatorCount)) : 0,
        scores,
        activePlayerNumber,
        targetScore: Number.isFinite(data.targetScore) ? data.targetScore : (details.mode === "tag" ? 100 : 50),
        createdAt: Number.isFinite(data.createdAt) ? data.createdAt : now,
        updatedAt: now,
        expiresAt: now + LIVE_DIRECTORY_STALE_MS
      };
      await this.ctx.storage.put(LIVE_DIRECTORY_PREFIX + summary.roomCode, summary);
      return json({ ok: true });
    }

    if (url.pathname === "/directory/remove" && request.method === "DELETE") {
      const roomCode = url.searchParams.get("roomCode");
      if (!isRoomCode(roomCode)) return json({ error: "Invalid room code." }, 400);
      await this.ctx.storage.delete(LIVE_DIRECTORY_PREFIX + roomCode);
      return json({ ok: true });
    }

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
      const boardSize = data.boardSize === undefined ? 7 : data.boardSize;
      if (!details || data.maxPlayers !== details.maxPlayers || !isRoomCode(data.roomCode) ||
          !isBoardSize(boardSize) ||
          (details.mode === "demo" && typeof data.demoControlToken !== "string")) {
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
        boardSize,
        demoControlTokenHash: data.demoControlToken ? await hashSeatToken(data.demoControlToken) : null,
        createdAt: now,
        lastActivityAt: now
      });
      if (details.mode === "demo") {
        // A demo is an automatically running PvP game whose two player seats are controlled by the Worker.
        const game = createGameState({
          roomCode: data.roomCode, mode: "pvp", playerNumbers: [1, 2], boardSize, now,
          turnDurationMs: AI_TURN_MS
        });
        // Keep the sample short enough to watch on one device; regular PvP still targets 50.
        // Its server-authoritative turn deadline is five seconds, matching the local AI budget.
        game.targetScore = 10;
        game.demoNextActionAt = Number(game.reviewEndsAt) + 500;
        game.demoPickPlan = null;
        game.demoSubmitAt = null;
        game.demoCleanupAt = null;
        await this.ctx.storage.put("game", game);
      }
      // Schedule the opening study phase, AI turns, and eventual demo cleanup as well as room expiry.
      await this.scheduleAlarm();
      await this.publishRoomSummary(true);
      return json({ ok: true });
    }

    const room = await this.ctx.storage.get("room");
    if (!room) return json({ error: "Room not found. Check the code or create a new room." }, 404);

    if (isRoomExpired(room, Date.now(), this.connectedCount())) {
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.close(4000, "Room expired"); } catch {}
      }
      await this.clearRoomData(room.roomCode);
      return json({ error: "Room expired. Please create a new room." }, 410);
    }

    if (url.pathname === "/info" && request.method === "GET") {
      const players = this.playerList();
      const connected = players.filter(player => player.connected).length;
      const game = await this.ctx.storage.get("game");
      const status = game?.status === "finished" ? "finished" : game?.status === "playing" ? "live" :
        game?.status === "study" ? "starting" : room.mode === "demo" ? "starting" : connected >= room.maxPlayers ? "ready" : "waiting";
      return json({ roomCode: room.roomCode, mode: room.mode, maxPlayers: room.maxPlayers,
        boardSize: room.boardSize || 7, status, players });
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }

    const requestedMode = url.searchParams.get("mode");
    if (requestedMode !== room.mode) {
      return json({
        error: "This room is for " + (room.mode === "tag" ? "Tag (2 vs 2)" : room.mode === "demo" ? "AI vs AI demo" : "Player 1 vs Player 2") + "."
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
    const deadlines = [roomDeadline, gameDeadline, pollDeadline,
      game?.demoNextActionAt, game?.demoSubmitAt, game?.demoCleanupAt].filter(Number.isFinite);
    // Keep a room with a connected player but no game on the directory too. Without this
    // heartbeat, a long lobby wait could outlive its directory listing lease.
    if (this.connectedCount() > 0 && !game) deadlines.push(now + LIVE_DIRECTORY_REFRESH_MS);
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.min(...deadlines));
    else await this.ctx.storage.deleteAlarm();
    await this.publishRoomSummary();
  }

  async removeRoomFromDirectory(roomCode) {
    if (!isRoomCode(roomCode)) return;
    try {
      const directory = this.env.ROOMS.get(this.env.ROOMS.idFromName(LIVE_DIRECTORY_OBJECT_NAME));
      await directory.fetch("https://directory.internal/directory/remove?roomCode=" + roomCode, { method: "DELETE" });
    } catch (error) {
      console.error("Could not remove expired Shapey room from live directory:", error);
    }
  }

  // Expiry, demo end and explicit teardown must remove all room-specific data,
  // including audience polls and chat history, and cancel the scheduled alarm.
  async clearRoomData(roomCode) {
    await this.removeRoomFromDirectory(roomCode);
    await clearRoomStorage(this.ctx.storage);
  }

  async publishRoomSummary(force = false) {
    const room = await this.ctx.storage.get("room");
    if (!room) return;
    const game = await this.ctx.storage.get("game");
    const status = game?.status === "finished" ? "finished" :
      game?.status === "playing" ? "live" :
      game?.status === "study" ? "starting" :
      room.mode === "demo" ? "starting" :
      this.connectedCount() >= room.maxPlayers ? "ready" : "waiting";
    if (status === "finished") {
      await this.removeRoomFromDirectory(room.roomCode);
      this.lastDirectorySignature = null;
      this.lastDirectoryPublishedAt = 0;
      return;
    }
    const connectedPlayerNumbers = new Set(this.playerList()
      .filter(player => player.connected).map(player => player.playerNumber));
    const summary = {
      roomCode: room.roomCode,
      mode: room.mode,
      status,
      playerCount: connectedPlayerNumbers.size,
      maxPlayers: room.maxPlayers,
      boardSize: room.boardSize || 7,
      spectatorCount: this.spectatorCount(),
      scores: Array.isArray(game?.scores) ? game.scores.slice(0, 2) : [0, 0],
      activePlayerNumber: Number.isInteger(game?.activePlayerNumber) ? game.activePlayerNumber : null,
      targetScore: Number.isFinite(game?.targetScore) ? game.targetScore : (room.mode === "tag" ? 100 : 50),
      createdAt: room.createdAt
    };
    const signature = JSON.stringify(summary);
    const now = Date.now();
    if (!force && signature === this.lastDirectorySignature && now - this.lastDirectoryPublishedAt < LIVE_DIRECTORY_REFRESH_MS) return;
    try {
      const directory = this.env.ROOMS.get(this.env.ROOMS.idFromName(LIVE_DIRECTORY_OBJECT_NAME));
      const response = await directory.fetch("https://directory.internal/directory/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(summary)
      });
      if (!response.ok) throw new Error("Directory returned HTTP " + response.status);
      this.lastDirectorySignature = signature;
      this.lastDirectoryPublishedAt = now;
    } catch (error) {
      console.error("Could not update Shapey live directory:", error);
    }
  }

  async broadcastGameState(type = "game_state") {
    const game = await this.ctx.storage.get("game");
    if (!game) return;
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        if (ws.readyState !== WebSocket.OPEN) continue;
        const attachment = ws.deserializeAttachment() || {};
        if (Number.isInteger(attachment.playerNumber)) {
          ws.send(JSON.stringify({ type, state: gameViewForPlayer(game, attachment.playerNumber, now) }));
        } else if (attachment.role === "spectator" && attachment.spectatorReady) {
          const state = gameViewForSpectator(game, now);
          const room = await this.ctx.storage.get("room");
          if (state && room?.mode === "demo") state.mode = "demo";
          ws.send(JSON.stringify({ type, state }));
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





  async deleteRoomData(roomCode, reason = "Room ended") {
    this.broadcast({ type: "demo_ended", message: reason });
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.close(4000, reason); } catch {}
    }
    await this.clearRoomData(roomCode);
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
      await this.clearRoomData(room.roomCode);
      return;
    }

    let game = await this.ctx.storage.get("game");
    if (game && advanceGameByTime(game, now)) {
      await this.ctx.storage.put("game", game);
      await this.broadcastGameState("game_state");
      game = await this.ctx.storage.get("game");
    }
    // Close a due poll before the demo AI gets another turn, then let the bot respond to the result.
    await this.closeExpiredAudiencePoll(game, now);
    game = await this.ctx.storage.get("game");
    if (room.mode === "demo" && game) {
      if (Number.isFinite(game.demoCleanupAt) && game.demoCleanupAt <= now) {
        await this.deleteRoomData(room.roomCode, "AI vs AI demo finished");
        return;
      }
      game = await this.runDemoStep(game, now);
    }
    await this.scheduleAlarm();
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

Object.assign(Room.prototype, RoomPollsMixin, RoomDemoMixin, RoomSeatsMixin, RoomMessagesMixin);
