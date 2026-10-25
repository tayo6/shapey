'use strict';
// DEVELOPER DEMO ROOM: "AI VS AI".
// Two simulated AIs play each other so the audience side (room list, board, chat) can be tried without any
// other device or a backend. The room is listed in LIVE GAMES like a real one, marked DEMO.
//
// It runs entirely in the browser and speaks the same messages the real room does (spectator_welcome,
// game_state, chat_message, spectator_count), so the page code path is the production one.
//
// TO REMOVE AFTER DEVELOPMENT: delete this file and its <script> tag in audience.html. Nothing else depends on it.
(function () {
  const RULES = window.ShapeyRules;
  if (!RULES) return; // src/rules.js is needed for scoring; without it there is no demo

  const CODE = 'AIDEMO';
  const MODE = 'ai';
  const TARGET = 20;           // a short race, so a whole game (and its game-over screen) fits in a few minutes
  const TURN_MS = 45000;       // same turn length as the real game
  const SPEED = Number(new URLSearchParams(window.location.search).get('demospeed')) || 1; // test hook only
  const REVIEW_MS = 8000;      // opening board face-up
  const REVEAL_MS = 4000;      // new tiles face-up
  const SWAP_MS = 1400;        // one shuffle swap
  const SHAPES = ['cancel', 'capsule', 'circle', 'cross', 'divide', 'corner', 'marked', 'pointer', 'shield', 'sphere', 'square', 'star', 'x'];
  const BOT_NAMES = ['Ada', 'Tunde', 'Kemi', 'Spectator 4', 'Zainab', 'Spectator 9'];
  const BOT_LINES = [
    'AI 1 remembers everything!', 'wait, where did the star go?', 'that shuffle was nasty', 'AI 2 is catching up',
    'ooh that was close', 'I would have picked the circles', 'this is hypnotic', 'who is winning?', 'nice match!',
    'the memorize timer is so short', 'come on AI 2!', 'big match incoming?'
  ];

  const rand = (n) => Math.floor(Math.random() * n);
  const pick = (list) => list[rand(list.length)];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms / SPEED));

  const viewers = new Set();
  const chatLog = [];
  const startedAt = Date.now();
  let game = null;
  let nextTileId = 0;
  let nextChatId = 0;
  let revision = 0;

  function newTile(row, col, faceUp) {
    const roll = Math.random();
    // About the game's own mix: ~10% hazards, a few blank wooden dummies, otherwise a random shape.
    const shape = roll < 0.1 ? 'hazard' : roll < 0.17 ? 'dummy' : pick(SHAPES);
    return { id: 'd' + (nextTileId++), row, col, shape, faceUp, selected: false, moving: false };
  }
  const matchable = (tile) => tile.shape !== 'hazard' && tile.shape !== 'dummy';

  // What a spectator is allowed to see: hidden tiles never carry their shape.
  function view(g) {
    return {
      protocolVersion: 1, roomCode: CODE, mode: MODE, status: g.status, revision: ++revision,
      reviewEndsAt: g.reviewEndsAt, turnIndex: g.turnIndex, activePlayerNumber: g.activePlayerNumber,
      activeSide: g.activePlayerNumber - 1, isBonusTurn: false, turnDurationMs: TURN_MS, turnEndsAt: g.turnEndsAt,
      targetScore: TARGET, scores: g.scores.slice(),
      winnerSide: g.winner, winnerPlayerNumber: g.winner == null ? null : g.winner + 1,
      reveals: g.reveals.map((batch) => ({ endsAt: batch.endsAt, tileIds: batch.ids.slice() })),
      shuffling: g.shuffling, players: [1, 2],
      tiles: g.tiles.map((t) => ({
        id: t.id, row: t.row, col: t.col, shape: t.faceUp ? t.shape : null, faceUp: t.faceUp,
        selected: t.selected, moving: t.moving, movingUntil: null
      }))
    };
  }
  function push() {
    if (!viewers.size || !game) return;
    const message = { type: 'game_state', state: view(game) };
    viewers.forEach((v) => v.deliver(message));
  }
  function broadcast(message) { viewers.forEach((v) => v.deliver(message)); }
  function broadcastCount() { broadcast({ type: 'spectator_count', count: viewers.size }); }

  // Both AIs watch the same board, so whatever is flipped up is remembered by each of them (imperfectly).
  function learn(tile, chance) {
    game.memory.forEach((memory) => { if (Math.random() < chance) memory.set(tile.id, tile.shape); });
  }

  function startGame() {
    const g = {
      status: 'study', scores: [0, 0], tiles: [], turnIndex: 0, activePlayerNumber: 1, turnEndsAt: null,
      reviewEndsAt: Date.now() + REVIEW_MS / SPEED, reveals: [], shuffling: false, winner: null,
      memory: [new Map(), new Map()]
    };
    for (let row = 0; row < 7; row++) for (let col = 0; col < 7; col++) g.tiles.push(newTile(row, col, true));
    game = g;
    g.tiles.forEach((tile) => learn(tile, 0.8));
    push();
    run(g);
  }

  async function run(g) {
    const alive = () => game === g;
    await wait(REVIEW_MS);
    if (!alive()) return;
    g.tiles.forEach((tile) => { tile.faceUp = false; });
    g.status = 'playing';
    g.reviewEndsAt = null;
    while (alive() && g.status === 'playing') {
      g.turnEndsAt = Date.now() + TURN_MS;
      push();
      await playTurn(g, alive);
      if (!alive() || g.status !== 'playing') break;
      g.turnIndex += 1;
      g.activePlayerNumber = g.activePlayerNumber === 1 ? 2 : 1;
    }
  }

  // One attempt per turn, like the real game: pick a same-shape group (from memory, else by exploring), then submit.
  async function playTurn(g, alive) {
    const p = g.activePlayerNumber - 1;
    const memory = g.memory[p];
    await wait(900 + rand(900));
    if (!alive()) return;
    const byId = new Map(g.tiles.map((t) => [t.id, t]));
    for (const id of [...memory.keys()]) if (!byId.has(id)) memory.delete(id);

    const groups = new Map();
    for (const [id, shape] of memory) {
      const tile = byId.get(id);
      if (!tile || !matchable(tile) || tile.shape !== shape) continue;
      if (!groups.has(shape)) groups.set(shape, []);
      groups.get(shape).push(tile);
    }
    let best = null;
    groups.forEach((list) => { if (list.length >= 3 && (!best || list.length > best.length)) best = list; });

    const picked = [];
    const flipUp = async (tile) => {
      tile.selected = true;
      tile.faceUp = true;
      picked.push(tile);
      learn(tile, 0.8);
      push();
      await wait(700 + rand(500));
    };

    if (best) {
      for (const tile of best.slice(0, 5)) { await flipUp(tile); if (!alive()) return; }
    } else {
      // Explore: flip an unknown tile, then look for a partner; a different shape ends the attempt.
      const unknown = () => g.tiles.filter((t) => matchable(t) && !memory.has(t.id) && !picked.includes(t));
      const first = pick(unknown().length ? unknown() : g.tiles.filter(matchable));
      await flipUp(first);
      while (alive() && picked.length < 5) {
        const shape = picked[0].shape;
        const known = g.tiles.find((t) => !picked.includes(t) && t.shape === shape && memory.has(t.id));
        const next = known || (unknown().length ? pick(unknown()) : null);
        if (!next) break;
        await flipUp(next);
        if (next.shape !== shape) break;
      }
    }
    if (!alive()) return;
    await wait(500);
    const shape = picked[0] && picked[0].shape;
    const same = picked.length >= 3 && picked.every((t) => t.shape === shape);
    if (!same) {
      // A miss or a too-small submit: everything flips back down and the turn passes.
      picked.forEach((t) => { t.selected = false; t.faceUp = false; });
      push();
      await wait(600);
      return;
    }
    g.scores[p] += RULES.scoreFor(picked.length);
    const fresh = [];
    picked.forEach((old) => {
      const tile = newTile(old.row, old.col, true);
      g.tiles[g.tiles.indexOf(old)] = tile;
      memory.delete(old.id);
      fresh.push(tile);
    });
    push();
    if (RULES.hasReachedTarget(g.scores[p], TARGET)) {
      g.status = 'finished';
      g.winner = p;
      g.turnEndsAt = null;
      push();
      botSay('GG! AI ' + (p + 1) + ' wins');
      setTimeout(() => { if (game === g) startGame(); }, 14000 / SPEED);
      return;
    }
    await spawnAndShuffle(g, fresh, alive);
  }

  // New tiles show face-up for a moment (MEMORIZE), flip down, then a few of them swap places (SHUFFLING).
  async function spawnAndShuffle(g, fresh, alive) {
    const batch = { ids: fresh.map((t) => t.id), endsAt: Date.now() + REVEAL_MS / SPEED };
    g.reveals.push(batch);
    push();
    fresh.forEach((tile) => learn(tile, 0.7));
    await wait(REVEAL_MS);
    if (!alive()) return;
    fresh.forEach((tile) => { tile.faceUp = false; });
    g.reveals = g.reveals.filter((b) => b !== batch);
    g.shuffling = fresh.length > 1;
    push();
    for (let swaps = Math.min(3, fresh.length - 1); swaps > 0 && alive(); swaps--) {
      const a = pick(fresh);
      const b = pick(fresh.filter((t) => t !== a));
      a.moving = true; b.moving = true;
      push();
      await wait(250);
      [a.row, b.row] = [b.row, a.row];
      [a.col, b.col] = [b.col, a.col];
      push();
      await wait(SWAP_MS);
      a.moving = false; b.moving = false;
      g.memory.forEach((memory) => { if (Math.random() < 0.3) { memory.delete(a.id); memory.delete(b.id); } });
      push();
    }
    g.shuffling = false;
    push();
  }

  // ---------------------------------------------------------------- audience chatter
  function addChat(sender, text) {
    const message = { id: 'demo' + (nextChatId++), sender, text, createdAt: Date.now() };
    chatLog.push(message);
    if (chatLog.length > 50) chatLog.shift();
    broadcast({ type: 'chat_message', message });
  }
  function botSay(text) { addChat(pick(BOT_NAMES), text); }
  [['Ada', 'is this the demo room?'], ['Tunde', 'two AIs, no humans involved'], ['Kemi', 'watching from the audience seats']]
    .forEach(([sender, text], i) => chatLog.push({ id: 'demo-h' + i, sender, text, createdAt: Date.now() - (3 - i) * 60000 }));
  (function chatter() {
    setTimeout(() => { if (viewers.size) botSay(pick(BOT_LINES)); chatter(); }, (9000 + rand(11000)) / SPEED);
  })();

  // ---------------------------------------------------------------- a WebSocket look-alike for the page
  class DemoSocket {
    constructor() {
      this.readyState = 0;
      this.listeners = {};
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        viewers.add(this);
        this.emit('open', {});
        broadcastCount();
      }, 120);
    }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    emit(type, event) { (this.listeners[type] || []).forEach((fn) => fn(event)); }
    deliver(message) {
      setTimeout(() => { if (this.readyState === 1) this.emit('message', { data: JSON.stringify(message) }); }, 0);
    }
    send(data) {
      let message;
      try { message = JSON.parse(data); } catch (_) { return; }
      if (message.type === 'spectate') {
        this.deliver({
          type: 'spectator_welcome', status: 'live', spectatorCount: viewers.size,
          players: [{ playerNumber: 1, connected: true }, { playerNumber: 2, connected: true }],
          state: view(game), chatHistory: chatLog.slice(), poll: null
        });
      } else if (message.type === 'chat' && typeof message.text === 'string') {
        addChat('You', message.text.slice(0, 280));
      } else if (message.type === 'poll_vote') {
        this.deliver({ type: 'error', message: 'Audience polls are only available in Tag games.' });
      }
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      viewers.delete(this);
      broadcastCount();
    }
  }
  DemoSocket.OPEN = 1;

  window.ShapeyDemo = Object.freeze({
    code: CODE,
    mode: MODE,
    isDemoCode: (code) => String(code || '').toUpperCase() === CODE,
    // The room as the directory lists it (same shape as GET /api/rooms entries, plus demo: true).
    summary: () => ({
      roomCode: CODE, mode: MODE, status: 'live', playerCount: 2, maxPlayers: 2, spectatorCount: viewers.size,
      scores: game.scores.slice(), activePlayerNumber: game.status === 'playing' ? game.activePlayerNumber : null,
      targetScore: TARGET, createdAt: startedAt, demo: true
    }),
    details: () => ({ mode: MODE, status: 'live', players: [{ playerNumber: 1, connected: true }, { playerNumber: 2, connected: true }] }),
    createSocket: () => new DemoSocket()
  });

  startGame();
})();
