// Shapey Worker - the AI-vs-AI demo bot: picks, submits and demo-room lifecycle on the
// room alarm. A prototype mixin for the Room Durable Object (see room.js).

import { applyGameAction, SHAPE_KEYS } from "./game-engine.js";

export const RoomDemoMixin = {
  async runDemoStep(game, now) {
    if (!game || game.status === "finished") {
      if (game && !Number.isFinite(game.demoCleanupAt)) {
        game.demoCleanupAt = now + 8_000;
        game.demoNextActionAt = null;
        game.demoSubmitAt = null;
        game.demoPickPlan = null;
        await this.ctx.storage.put("game", game);
      }
      return game;
    }
    if (game.status !== "playing" || !Number.isFinite(game.demoNextActionAt) || game.demoNextActionAt > now) return game;

    // Let the existing reveal and shuffle animations finish before the demo AI picks again.
    if (game.pendingEffect || game.reveals?.length || game.shuffles?.length) {
      game.demoNextActionAt = now + 500;
      await this.ctx.storage.put("game", game);
      return game;
    }

    if (Number.isFinite(game.demoSubmitAt) && game.demoSubmitAt > now) {
      game.demoNextActionAt = game.demoSubmitAt;
      await this.ctx.storage.put("game", game);
      return game;
    }

    if (Number.isFinite(game.demoSubmitAt) && game.demoSubmitAt <= now) {
      const result = applyGameAction(game, game.activePlayerNumber, { type: "submit" }, now);
      if (result.accepted) {
        game = result.state;
        game.demoPickPlan = null;
        game.demoSubmitAt = null;
        game.demoNextActionAt = game.status === "finished" ? null : now + 1_700;
        if (game.status === "finished") game.demoCleanupAt = now + 8_000;
        await this.ctx.storage.put("game", game);
        await this.broadcastGameState("game_state");
      } else {
        game.demoPickPlan = null;
        game.demoSubmitAt = null;
        game.demoNextActionAt = now + 1_000;
        await this.ctx.storage.put("game", game);
      }
      return game;
    }

    if (Array.isArray(game.demoPickPlan) && game.demoPickPlan.length) {
      const tileId = game.demoPickPlan[0];
      const tile = game.tiles.find(item => item.id === tileId && !item.faceUp && !item.moving && !item.selected);
      if (!tile) {
        game.demoPickPlan = null;
        game.demoNextActionAt = now + 500;
        await this.ctx.storage.put("game", game);
        return game;
      }
      const result = applyGameAction(game, game.activePlayerNumber, { type: "pick", tileId }, now);
      if (result.accepted) {
        game = result.state;
        game.demoPickPlan = game.demoPickPlan.slice(1);
        game.demoNextActionAt = now + 650;
        if (!game.demoPickPlan.length) {
          game.demoPickPlan = null;
          game.demoSubmitAt = now + 700;
          game.demoNextActionAt = game.demoSubmitAt;
        }
        // Every second demo turn pauses after the first revealed shape so spectators can test the live poll.
        if (game.selectedTileIds.length === 1 && game.turnIndex % 2 === 0 &&
            game.demoPollTurnIndex !== game.turnIndex) {
          const poll = await this.createAudiencePoll(game, game.activePlayerNumber, now);
          if (poll) {
            game.demoPollTurnIndex = game.turnIndex;
            game.demoSubmitAt = null;
            game.demoNextActionAt = poll.endsAt;
            await this.publishAudiencePoll(poll, game);
            return game;
          }
        }
        await this.ctx.storage.put("game", game);
        await this.broadcastGameState("game_state");
      } else {
        game.demoPickPlan = null;
        game.demoSubmitAt = null;
        game.demoNextActionAt = now + 1_000;
        await this.ctx.storage.put("game", game);
      }
      return game;
    }

    const groups = new Map();
    for (const tile of game.tiles) {
      if (tile.faceUp || tile.moving || tile.selected || !SHAPE_KEYS.includes(tile.shape)) continue;
      if (!groups.has(tile.shape)) groups.set(tile.shape, []);
      groups.get(tile.shape).push(tile.id);
    }
    const matches = [...groups.values()].filter(ids => ids.length >= 3);
    if (!matches.length) {
      game.demoSubmitAt = now;
      game.demoNextActionAt = now;
      await this.ctx.storage.put("game", game);
      return game;
    }
    const group = matches[Math.floor(Math.random() * matches.length)].slice();
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [group[i], group[j]] = [group[j], group[i]];
    }
    game.demoPickPlan = group.slice(0, 3);
    game.demoNextActionAt = now + 300;
    await this.ctx.storage.put("game", game);
    return game;
  },

};
