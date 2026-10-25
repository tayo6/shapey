// Shapey Worker - audience polls ("Ask the Audience"): creation, voting, closing and
// broadcasting. A prototype mixin for the Room Durable Object (see room.js).

import { audiencePollSnapshot, shortRandomId, AUDIENCE_POLL_MS } from "./lib.js";
import { audiencePollsRemaining } from "./game-engine.js";

export const RoomPollsMixin = {
  async closeExpiredAudiencePoll(game, now = Date.now()) {
    const poll = await this.ctx.storage.get("audiencePoll");
    if (!poll || poll.closed) return;
    if (poll.endsAt > now && game && game.status !== "finished" &&
        game.activePlayerNumber === poll.startedByPlayer) return;

    const closed = { ...poll, closed: true, endsAt: Math.min(poll.endsAt, now) };
    // The audience gets the full 30 seconds. The requesting player's remaining turn time is paused
    // during the poll and restored when the audience finishes voting.
    if (game && game.status === "playing" && game.activePlayerNumber === poll.startedByPlayer &&
        Number.isFinite(poll.remainingTurnMs)) {
      game.turnEndsAt = now + Math.max(0, poll.remainingTurnMs);
      game.revision = (Number(game.revision) || 0) + 1;

      // The demo AIs can accept the audience suggestion if the top-voted hidden tile really matches
      // the first shape. Otherwise they keep their original matching plan.
      const votes = Object.values(poll.votes || {});
      const counts = new Map();
      for (const tileId of votes) counts.set(tileId, (counts.get(tileId) || 0) + 1);
      const topCount = Math.max(0, ...counts.values());
      if (topCount > 0 && (await this.ctx.storage.get("room"))?.mode === "demo" &&
          game.demoPollTurnIndex === game.turnIndex && Array.isArray(game.demoPickPlan)) {
        const winningIds = [...counts.entries()].filter(([, count]) => count === topCount).map(([tileId]) => tileId);
        const chosen = winningIds.map(id => game.tiles.find(tile => tile.id === id))
          .find(tile => tile && tile.shape === poll.initialShape && !tile.faceUp && !tile.moving && !tile.selected);
        if (chosen) game.demoPickPlan = [chosen.id, ...game.demoPickPlan.filter(id => id !== chosen.id)].slice(0, 2);
      }
      if ((await this.ctx.storage.get("room"))?.mode === "demo") game.demoNextActionAt = now + 300;
      await this.ctx.storage.put("game", game);
      await this.broadcastGameState("game_state");
    }
    await this.ctx.storage.delete("audiencePoll");
    this.broadcastAudiencePollState(closed);
  },

  broadcastAudiencePollState(poll, now = Date.now()) {
    this.broadcast({ type: "audience_poll_state", poll: audiencePollSnapshot(poll, now) });
  },

  async createAudiencePoll(game, playerNumber, now = Date.now()) {
    if (!game || game.status !== "playing" || game.pendingEffect ||
        game.activePlayerNumber !== playerNumber ||
        !Array.isArray(game.selectedTileIds) || game.selectedTileIds.length !== 1 ||
        typeof game.selectedShape !== "string") {
      return null;
    }
    const candidates = game.tiles.filter(tile =>
      !tile.faceUp && !tile.selected && !tile.moving &&
      !game.selectedTileIds.includes(tile.id) && !game.dummyTileIds.includes(tile.id)
    );
    if (candidates.length < 1) return null;

    // Include at least one genuine match when available, otherwise the audience would be asked
    // to help with a question that has no correct answer. Hidden shapes stay server-side.
    const matching = candidates.filter(tile => tile.shape === game.selectedShape);
    if (!matching.length) return null;
    // Let spectators choose from every eligible hidden tile on the live board, rather than a fixed four.
    // The public snapshot contains only tile IDs and positions, never their hidden shapes.
    const options = candidates;
    const remainingTurnMs = Number.isFinite(game.turnEndsAt) ? Math.max(0, game.turnEndsAt - now) : 0;
    return {
      id: shortRandomId(),
      startedByPlayer: playerNumber,
      startedAt: now,
      endsAt: now + AUDIENCE_POLL_MS,
      remainingTurnMs,
      initialShape: game.selectedShape,
      options: options.map(tile => ({ tileId: tile.id, row: tile.row, col: tile.col })),
      votes: {},
      closed: false
    };
  },

  async publishAudiencePoll(poll, game) {
    // Pause the player's turn timer for the duration of the poll.
    game.turnEndsAt = poll.endsAt + poll.remainingTurnMs;
    game.revision = (Number(game.revision) || 0) + 1;
    await this.ctx.storage.put("game", game);
    await this.ctx.storage.put("audiencePoll", poll);
    await this.broadcastGameState("game_state");
    this.broadcastAudiencePollState(poll);
    await this.scheduleAlarm();
    await this.touchRoom();
  },

  async startAudiencePoll(ws) {
    const attachment = ws.deserializeAttachment() || {};
    if (!Number.isInteger(attachment.playerNumber)) {
      ws.send(JSON.stringify({ type: "error", message: "Only players can start an audience poll." }));
      return;
    }
    const room = await this.ctx.storage.get("room");
    const game = await this.ctx.storage.get("game");
    const now = Date.now();
    if (!room || !["pvp", "tag"].includes(room.mode)) {
      ws.send(JSON.stringify({ type: "error", message: "Audience polls are available in online Player 1 vs Player 2 and Tag rooms." }));
      return;
    }
    if (!game || game.status !== "playing" || game.pendingEffect ||
        game.activePlayerNumber !== attachment.playerNumber) {
      ws.send(JSON.stringify({ type: "error", message: "Start a poll only during your active turn." }));
      return;
    }
    const existing = await this.ctx.storage.get("audiencePoll");
    if (existing && !existing.closed && existing.endsAt > now) {
      this.broadcastAudiencePollState(existing);
      return;
    }
    const playerData = game.playerData && game.playerData[String(attachment.playerNumber)];
    if (!playerData) {
      ws.send(JSON.stringify({ type: "error", message: "Player data is unavailable for this match." }));
      return;
    }
    if (audiencePollsRemaining(playerData) <= 0) {
      ws.send(JSON.stringify({ type: "error", message: "You have used all 3 audience polls for this game." }));
      return;
    }
    const poll = await this.createAudiencePoll(game, attachment.playerNumber, now);
    if (!poll) {
      ws.send(JSON.stringify({ type: "error", message: "Pick one first shape before asking the audience to find a match." }));
      return;
    }
    playerData.audiencePollsUsed = (Number.isInteger(playerData.audiencePollsUsed) ? playerData.audiencePollsUsed : 0) + 1;
    await this.publishAudiencePoll(poll, game);
  },

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
    if (Object.prototype.hasOwnProperty.call(poll.votes || {}, attachment.spectatorId)) {
      ws.send(JSON.stringify({ type: "error", message: "You have already voted in this poll." }));
      return;
    }
    const tileId = data?.tileId;
    if (typeof tileId !== "string" || !poll.options.some(option => option.tileId === tileId)) {
      ws.send(JSON.stringify({ type: "error", message: "Choose one of the hidden tiles listed in the poll." }));
      return;
    }
    poll.votes[attachment.spectatorId] = tileId;
    await this.ctx.storage.put("audiencePoll", poll);
    this.broadcastAudiencePollState(poll);
    await this.touchRoom();
  },

};
