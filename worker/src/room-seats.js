// Shapey Worker - seat claiming (players), spectator joins and chat. A prototype mixin
// for the Room Durable Object (see room.js).

import { hashSeatToken, newSeatToken, shortRandomId, cleanChatText, CHAT_HISTORY_LIMIT, audiencePollSnapshot } from "./lib.js";
import { createGameState, gameViewForPlayer, gameViewForSpectator } from "./game-engine.js";

const CHAT_COOLDOWN_MS = 1_500;

export const RoomSeatsMixin = {
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
      const duplicateSockets = this.ctx.getWebSockets().filter(other => {
        if (other === ws || other.readyState !== WebSocket.OPEN) return false;
        return (other.deserializeAttachment() || {}).playerNumber === playerNumber;
      });
      if (duplicateSockets.length && (typeof suppliedToken !== "string" || !suppliedToken)) {
        rejectJoin("That player seat is already connected on another device.");
        return;
      }
      // A valid saved seat token proves this is the returning player. Reclaim the seat
      // rather than making them wait for a stale mobile-network socket to close naturally.
      for (const other of duplicateSockets) {
        try { other.close(4001, "Seat resumed on another connection"); } catch {}
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
        maxPlayers: room.maxPlayers,
        boardSize: room.boardSize || 7
      }));
      this.broadcast({
        type: "room_state",
        roomCode: room.roomCode,
        mode: room.mode,
        maxPlayers: room.maxPlayers,
        boardSize: room.boardSize || 7,
        status: this.connectedCount() >= room.maxPlayers ? "ready" : "waiting",
        players: this.playerList()
      });

      // Once all assigned seats are connected, create the one canonical game state.
      const connected = this.connectedCount();
      const existingGame = await this.ctx.storage.get("game");
      if (connected >= room.maxPlayers && !existingGame) {
        const playerNumbers = Array.from({ length: room.maxPlayers }, (_, index) => index + 1);
        const game = createGameState({ roomCode: room.roomCode, mode: room.mode, playerNumbers, boardSize: room.boardSize || 7 });
        await this.ctx.storage.put("game", game);
        await this.broadcastGameState("game_started");
      } else if (existingGame) {
        // A returning device receives the canonical state for its original seat.
        try {
          ws.send(JSON.stringify({
            type: "game_started",
            state: gameViewForPlayer(existingGame, playerNumber, Date.now())
          }));
        } catch {}
      }
      await this.scheduleAlarm();
    } finally {
      release();
    }
  },

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
    if (room.mode === "demo") {
      room.lastSpectatorAt = Date.now();
      await this.ctx.storage.put("room", room);
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
      boardSize: room.boardSize || 7,
      status: game ? game.status : (this.connectedCount() >= room.maxPlayers ? "ready" : "waiting"),
      players: this.playerList(),
      spectatorCount: this.spectatorCount(),
      state: game ? { ...gameViewForSpectator(game, Date.now()), ...(room.mode === "demo" ? { mode: "demo" } : {}) } : null,
      chatHistory: history,
      poll: poll && !poll.closed && poll.endsAt > Date.now() ? audiencePollSnapshot(poll, Date.now()) : null
    }));
    this.broadcast({ type: "spectator_count", count: this.spectatorCount() });
    await this.touchRoom();
  },

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
    const now = Date.now();
    if (Number.isFinite(attachment.lastChatAt) && now - attachment.lastChatAt < CHAT_COOLDOWN_MS) {
      ws.send(JSON.stringify({ type: "error", message: "Please wait a moment before sending another chat message." }));
      return;
    }
    attachment.lastChatAt = now;
    ws.serializeAttachment(attachment);
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
  },

};
