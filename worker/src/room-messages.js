// Shapey Worker - the WebSocket message dispatcher: rate limiting, join/spectate/chat,
// poll control, demo control and game actions. A prototype mixin for the Room
// Durable Object (see room.js).

import { messageByteLength, nextMessageRateState, MAX_MESSAGE_BYTES } from "./protocol.js";
import { hashSeatToken } from "./lib.js";
import { applyGameAction } from "./game-engine.js";

export const RoomMessagesMixin = {
  async webSocketMessage(ws, message) {
    // Cloudflare normally intercepts this through setWebSocketAutoResponse. Keep the
    // fallback for local runtimes that deliver application messages to this handler.
    if (message === "ping") {
      try { ws.send("pong"); } catch {}
      return;
    }
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

    let data;
    try {
      data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Messages must be JSON." }));
      return;
    }
    // Legacy JSON keepalives are also cheap. Do not update room activity or alarms for them.
    if (data?.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", at: Date.now() }));
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

    if (data?.type === "demo_control") {
      const room = await this.ctx.storage.get("room");
      const suppliedHash = typeof data.token === "string" ? await hashSeatToken(data.token) : "";
      if (room?.mode !== "demo" || !room.demoControlTokenHash || suppliedHash !== room.demoControlTokenHash || attachment.role !== "spectator" || !attachment.spectatorReady) {
        ws.send(JSON.stringify({ type: "error", message: "This demo-control link is not valid." }));
        return;
      }
      attachment.demoController = true;
      ws.serializeAttachment(attachment);
      ws.send(JSON.stringify({ type: "demo_control_ready" }));
      return;
    }
    if (data?.type === "end_demo") {
      const room = await this.ctx.storage.get("room");
      if (room?.mode !== "demo" || attachment.demoController !== true) {
        ws.send(JSON.stringify({ type: "error", message: "Only the person who opened this AI demo can end it." }));
        return;
      }
      await this.deleteRoomData(room.roomCode, "AI vs AI demo ended by its host");
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
    if (isSpectator && !["ping", "demo_control", "end_demo"].includes(data?.type)) {
      ws.send(JSON.stringify({ type: "error", message: "Spectators can only chat, vote, or ping." }));
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
      const activePoll = await this.ctx.storage.get("audiencePoll");
      const actor = ws.deserializeAttachment() || {};
      if (activePoll && !activePoll.closed && activePoll.endsAt > Date.now() &&
          activePoll.startedByPlayer === actor.playerNumber) {
        ws.send(JSON.stringify({ type: "error", message: "Wait for the audience poll to finish before continuing your turn." }));
        return;
      }
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
  },

};
