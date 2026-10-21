'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rules = require('../src/rules.js');
const memes = require('../src/memes.js');
const manifestTool = require('../tools/build-memes-manifest.js');

const { AttemptWindow, ShuffleBag, MemePicker, buildPools, createLibrary, attach, CONFIG } = memes;

// Deterministic random numbers (mulberry32).
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MANIFEST = {
  audio: { win: ['w1.mp3', "That's why.mp3"], lose: ['l1.mp3', 'l2.mp3', 'l3.mp3'] },
  gifs: {
    win: ['win a.gif', 'win b.webp'],
    lose: ['lose a.gif', 'lose b.jpeg', '𝐌𝐞𝐦𝐞.jpeg'],
    tag_win: ['tag 1.webp', 'tag 2.jpeg'],
    delay_pick: ['Waiting.gif', 'Check time 1.gif'],
  },
};

async function readyLibrary(seed = 1) {
  const library = createLibrary({ rng: seeded(seed), loadManifest: () => Promise.resolve(MANIFEST) });
  await library.ensureLoaded();
  return library;
}

function fakePlayer() {
  const log = [];
  let visible = false;
  return {
    log,
    showVisual(item) { visible = true; log.push(['visual', item]); },
    playAudio(item) { log.push(['audio', item]); },
    hide() { visible = false; },
    layout() {},
    isVisualVisible: () => visible,
  };
}

function fakeScene(overrides = {}) {
  const scene = {
    online: false,
    spectator: false,
    gameOver: false,
    turnEnding: false,
    turnId: 1,
    activePlayer: 0,
    activeMember: 0,
    openingReviewEndsAt: 0,
    currentTurnDurationMs: 45000,
    turnDurationMs: 45000,
    modeCfg: { turnClock: true, twoPlayers: true, ai: false, teams: false },
    sound: { mute: false },
    events: { once() {} },
    now: 0,
    isAITurn() { return this.modeCfg.ai && this.activePlayer === 1; },
    limiterSlot() { return this.modeCfg.teams ? this.activePlayer * 2 + this.activeMember : this.activePlayer; },
    turnClock: { left: 45000, remaining() { return this.left; } },
    ...overrides,
  };
  return scene;
}

// ---------------------------------------------------------------- the win rule
test('a win is a valid match of three or more identical shapes', () => {
  // The game decides this with RULES.isValidMatchSize(count, MIN_MATCH = 3); the commentary only reacts to it.
  for (const count of [3, 4, 5, 6, 9]) assert.equal(rules.isValidMatchSize(count, 3), true, count + ' shapes win');
  for (const count of [0, 1, 2]) assert.equal(rules.isValidMatchSize(count, 3), false, count + ' shapes do not win');
});

// ---------------------------------------------------------------- attempt windows
test('standard window fires exactly once per four attempts, at a random position', () => {
  const positions = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    const window4 = new AttemptWindow(4, seeded(seed));
    for (let round = 0; round < 10; round++) {
      const fired = [1, 2, 3, 4].map(() => window4.record(true));
      assert.equal(fired.filter(Boolean).length, 1, 'seed ' + seed + ' round ' + round);
      positions.add(fired.indexOf(true) + 1);
    }
  }
  assert.deepEqual([...positions].sort(), [1, 2, 3, 4]);
});

test('a trigger that lands on a non-qualifying attempt carries to the next qualifying one in the window, or lapses', () => {
  const window4 = new AttemptWindow(4, () => 0); // target = attempt 1
  assert.equal(window4.record(false), false); // 1: armed but not a win
  assert.equal(window4.record(false), false); // 2
  assert.equal(window4.record(true), true);   // 3: first win after the target fires
  assert.equal(window4.record(true), false);  // 4: already fired in this window
  // new window, no qualifying attempt at all -> lapses without firing
  assert.deepEqual([false, false, false, false].map((q) => window4.record(q)), [false, false, false, false]);
  assert.equal(window4.record(true), true);   // next window fires on its first win
});

test('shuffle bag deals every item before repeating and never repeats back to back', () => {
  const bag = new ShuffleBag(['a', 'b', 'c'], seeded(7));
  let previous = null;
  for (let round = 0; round < 20; round++) {
    const dealt = [bag.next(), bag.next(), bag.next()];
    assert.deepEqual([...dealt].sort(), ['a', 'b', 'c']);
    assert.notEqual(dealt[0], previous);
    previous = dealt[2];
  }
  assert.equal(new ShuffleBag([]).next(), null);
});

// ---------------------------------------------------------------- manifest -> pools
test('buildPools maps the real folder names and encodes awkward file names', () => {
  const pools = buildPools(MANIFEST);
  assert.equal(pools.win.audio.length, 2);
  assert.equal(pools.win.visual.length, 2);
  assert.equal(pools.lose.audio.length, 3);
  assert.equal(pools.lose.visual.length, 3);
  assert.equal(pools.tagWin.audio.length, 0);
  assert.equal(pools.tagWin.visual.length, 2);
  assert.equal(pools.delay.visual.length, 2);
  assert.equal(pools.win.audio[1].url, "assets/memes/audio/win/That's%20why.mp3");
  assert.equal(pools.delay.visual[0].url, 'assets/memes/gifs/delay_pick/Waiting.gif');
  assert.ok(pools.lose.visual.some((item) => item.url === 'assets/memes/gifs/lose/' + encodeURIComponent('𝐌𝐞𝐦𝐞.jpeg')));
});

test('folder aliases (Delay, Tags/win) also feed the right pool', () => {
  const pools = buildPools({ audio: { Delay: ['d.mp3'] }, gifs: { 'Tags/win': ['t.gif'], Delay: ['d.gif'] } });
  assert.equal(pools.delay.audio.length, 1);
  assert.equal(pools.delay.visual.length, 1);
  assert.equal(pools.tagWin.visual[0].url, 'assets/memes/gifs/Tags/win/t.gif');
});

test('picker uses audio or picture at random, and only what exists', () => {
  const picker = new MemePicker(buildPools(MANIFEST), seeded(3));
  const types = new Set();
  for (let i = 0; i < 60; i++) {
    const item = picker.pick('lose');
    types.add(item.type);
    assert.ok(item.url.includes('/lose/'));
  }
  assert.deepEqual([...types].sort(), ['audio', 'visual']);
  for (let i = 0; i < 10; i++) {
    assert.equal(picker.pick('tagWin').type, 'visual'); // no tag audio exists
    assert.equal(picker.pick('delay').type, 'visual');
  }
  assert.equal(new MemePicker(buildPools({}), seeded(1)).pick('win'), null);
});

test('the committed manifest matches the files on disk', () => {
  const onDisk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', 'memes', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifestTool.build(), onDisk);
  const pools = buildPools(onDisk);
  for (const kind of ['win', 'lose', 'delay', 'tagWin']) {
    assert.ok(pools[kind].audio.length + pools[kind].visual.length > 0, kind + ' has files');
  }
});

// ---------------------------------------------------------------- scene adapter
async function setup(sceneOverrides, seed = 5, optionOverrides = {}) {
  const library = await readyLibrary(seed);
  const player = fakePlayer();
  const scene = fakeScene(sceneOverrides);
  const controller = attach(scene, { library, player, rng: seeded(seed + 100), disabled: false, ...optionOverrides });
  return { scene, controller, player, library };
}

// Plays one local versus turn as `slot`: pick something, then end with `reason`.
function playTurn(ctx, reason, { activePlayer = 0, activeMember = 0, pick = true } = {}) {
  ctx.scene.activePlayer = activePlayer;
  ctx.scene.activeMember = activeMember;
  ctx.scene.turnId++;
  if (pick) ctx.controller.noteActivity();
  ctx.controller.turnResult(reason);
}

test('a human fires exactly one win/lose meme per four attempts, from the matching pool', async () => {
  const ctx = await setup({});
  const outcomes = ['match', 'mismatch', 'match', 'timeout', 'hazard', 'match', 'submit', 'match', 'mismatch', 'timeout', 'hazard', 'match'];
  outcomes.forEach((reason) => playTurn(ctx, reason));
  const fired = ctx.player.log;
  assert.equal(fired.length, 3, 'one per window of three');
  // The attempts inside each window decide which pool: reconstruct which attempt fired from the url.
  fired.forEach(([, item], index) => {
    const windowOutcomes = outcomes.slice(index * 4, index * 4 + 4).map((r) => (r === 'match' ? 'win' : 'lose'));
    assert.ok(windowOutcomes.includes(item.kind), 'window ' + index + ' contains a ' + item.kind);
    assert.ok(item.url.includes('/' + item.kind + '/'));
  });
});

test('AI turns never fire or count, and the human windows are unaffected', async () => {
  const ctx = await setup({ modeCfg: { turnClock: true, twoPlayers: true, ai: true, teams: false } });
  for (let i = 0; i < 12; i++) {
    playTurn(ctx, 'match', { activePlayer: 1 }); // AI turn
    ctx.controller.tick();
  }
  assert.equal(ctx.player.log.length, 0);
  for (let i = 0; i < 8; i++) playTurn(ctx, i % 2 ? 'mismatch' : 'match', { activePlayer: 0 }); // human turns
  assert.equal(ctx.player.log.length, 2);
});

test('a turn in which nothing was picked is not an attempt', async () => {
  const ctx = await setup({});
  for (let i = 0; i < 9; i++) playTurn(ctx, 'timeout', { pick: false });
  assert.equal(ctx.player.log.length, 0);
});

test('each human player has an independent attempt window', async () => {
  const ctx = await setup({ modeCfg: { turnClock: true, twoPlayers: true, ai: false, teams: false } });
  // Player 1 and Player 2 alternate; each has 8 attempts -> each fires twice.
  for (let i = 0; i < 16; i++) playTurn(ctx, 'mismatch', { activePlayer: i % 2 });
  assert.equal(ctx.player.log.length, 4);
});

test('Tag: team wins and ordinary commentary use four-attempt windows', async () => {
  const ctx = await setup({ modeCfg: { turnClock: true, twoPlayers: true, ai: false, teams: true } }, 11);
  // Four players, 8 winning turns each.
  for (let round = 0; round < 8; round++) {
    for (const [side, member] of [[0, 0], [1, 0], [0, 1], [1, 1]]) playTurn(ctx, 'match', { activePlayer: side, activeMember: member });
  }
  const tagWins = ctx.player.log.filter(([, item]) => item.kind === 'tagWin');
  assert.equal(tagWins.length, 4 * 2, 'two windows of four per player');
  assert.equal(ctx.player.log.length, tagWins.length, 'a team win never uses the normal win pool');
  tagWins.forEach(([type, item]) => {
    assert.equal(type, 'visual');
    assert.ok(item.url.includes('/gifs/tag_win/'));
  });
  // Losses follow the standard 4-attempt rule in Tag.
  const before = ctx.player.log.length;
  for (let i = 0; i < 6; i++) playTurn(ctx, 'mismatch', { activePlayer: 0, activeMember: 0 });
  const losses = ctx.player.log.slice(before);
  assert.ok(losses.length >= 1 && losses.length <= 2);
  losses.forEach(([, item]) => assert.equal(item.kind, 'lose'));
});

test('Delay meme: idle human at 10 seconds left, once per turn, never for the AI or while picking or studying', async () => {
  const ctx = await setup({});
  ctx.scene.turnClock.left = 20000;
  ctx.controller.tick();
  assert.equal(ctx.player.log.length, 0, 'not yet');
  ctx.scene.turnClock.left = 10000;
  ctx.controller.tick();
  ctx.controller.tick();
  assert.equal(ctx.player.log.length, 1, 'exactly once');
  assert.equal(ctx.player.log[0][1].kind, 'delay');
  assert.ok(ctx.player.log[0][1].url.includes('/gifs/delay_pick/'));
  ctx.scene.turnClock.left = 3000;
  ctx.controller.tick();
  assert.equal(ctx.player.log.length, 1, 'still once in the same turn');

  // next turn: the player picks something, so no Delay meme
  ctx.scene.turnId++;
  ctx.scene.turnClock.left = 45000;
  ctx.controller.tick();
  ctx.controller.noteActivity();
  ctx.scene.turnClock.left = 9000;
  ctx.controller.tick();
  assert.equal(ctx.player.log.length, 1, 'participating players are left alone');

  // next turn: the AI is playing
  const ai = await setup({ modeCfg: { turnClock: true, twoPlayers: true, ai: true, teams: false }, activePlayer: 1 });
  ai.scene.turnClock.left = 8000;
  ai.controller.tick();
  assert.equal(ai.player.log.length, 0);

  // opening study phase: the visible countdown is the study clock, not the pick clock
  const study = await setup({ openingReviewEndsAt: Date.now() + 60000, currentTurnDurationMs: 8000 });
  study.scene.turnClock.left = 8000;
  study.controller.tick();
  assert.equal(study.player.log.length, 0);

  // modes without a pick clock (Play Alone) have no countdown to run out
  const alone = await setup({ modeCfg: { turnClock: false, twoPlayers: false, ai: false, teams: false } });
  alone.scene.turnClock.left = Infinity;
  alone.controller.tick();
  assert.equal(alone.player.log.length, 0);
});

test('Play Alone: wrong shapes and wins both count as attempts for the single player', async () => {
  const ctx = await setup({ modeCfg: { turnClock: false, twoPlayers: false, ai: false, teams: false } });
  for (let i = 0; i < 12; i++) {
    if (i % 3 === 1) ctx.controller.attemptResult('lose');
    else { ctx.controller.noteActivity(); ctx.controller.turnResult('match'); }
  }
  assert.equal(ctx.player.log.length, 3);
});

test('spectators, a disabled switch and an unloaded library stay silent', async () => {
  const spectator = await setup({ spectator: true });
  for (let i = 0; i < 6; i++) playTurn(spectator, 'match');
  assert.equal(spectator.player.log.length, 0);

  const off = await setup({}, 5, { disabled: true });
  for (let i = 0; i < 6; i++) playTurn(off, 'match');
  assert.equal(off.player.log.length, 0);

  const player = fakePlayer();
  const cold = createLibrary({ loadManifest: () => new Promise(() => {}) });
  const scene = fakeScene();
  const controller = attach(scene, { library: cold, player, disabled: false });
  for (let i = 0; i < 6; i++) { scene.turnId++; controller.noteActivity(); controller.turnResult('match'); }
  assert.equal(player.log.length, 0);
});

test('muted games get no audio memes, only pictures', async () => {
  const ctx = await setup({ sound: { mute: true } }, 2);
  for (let i = 0; i < 90; i++) playTurn(ctx, 'mismatch');
  assert.ok(ctx.player.log.length > 0);
  assert.ok(ctx.player.log.every(([type]) => type === 'visual'));
});

// ---------------------------------------------------------------- online snapshots
function snapshot({ turnIndex, player, scores, status = 'playing', selected = false, bonus = false }) {
  return {
    status, turnIndex, activePlayerNumber: player, activeSide: (player - 1) % 2, scores, isBonusTurn: bonus,
    tiles: [{ id: 't1', selected }],
  };
}

test('online: a score increase is a win, a quiet turn change after picks is a loss', async () => {
  const ctx = await setup({ online: true, modeCfg: { turnClock: true, twoPlayers: true, ai: false, teams: false } });
  const feed = (next) => { const previous = ctx.scene.onlineState; ctx.scene.onlineState = next; ctx.controller.onlineState(previous || null, next); };
  // turns alternate P1, P2: P1 wins, P2 loses (picked, no score), repeated for 3 attempts each
  let scores = [0, 0];
  let turn = 0;
  for (let i = 0; i < 4; i++) {
    feed(snapshot({ turnIndex: turn, player: 1, scores: scores.slice(), selected: false }));
    feed(snapshot({ turnIndex: turn, player: 1, scores: scores.slice(), selected: true }));   // P1 picks
    scores = [scores[0] + 1, scores[1]];
    feed(snapshot({ turnIndex: turn, player: 1, scores: scores.slice(), selected: true }));   // score lands before the hand-over
    turn++;
    feed(snapshot({ turnIndex: turn, player: 2, scores: scores.slice(), selected: false }));
    feed(snapshot({ turnIndex: turn, player: 2, scores: scores.slice(), selected: true }));   // P2 picks
    turn++;
    feed(snapshot({ turnIndex: turn, player: 1, scores: scores.slice(), selected: false }));  // P2 scored nothing
  }
  assert.equal(ctx.player.log.length, 2, 'one meme per four attempts for each of two players');
  const kinds = ctx.player.log.map(([, item]) => item.kind).sort();
  assert.deepEqual(kinds, ['lose', 'win']);

  // repeated snapshots of the same turn never count twice
  const count = ctx.player.log.length;
  for (let i = 0; i < 5; i++) feed(snapshot({ turnIndex: turn, player: 1, scores: scores.slice() }));
  assert.equal(ctx.player.log.length, count);
});

test('online: an idle turn that times out is not an attempt, and the Delay meme still plays', async () => {
  const ctx = await setup({ online: true, modeCfg: { turnClock: true, twoPlayers: true, ai: false, teams: false } });
  const feed = (next) => { const previous = ctx.scene.onlineState; ctx.scene.onlineState = next; ctx.controller.onlineState(previous || null, next); };
  for (let turn = 0; turn < 8; turn++) {
    feed(snapshot({ turnIndex: turn, player: (turn % 2) + 1, scores: [0, 0] }));
    ctx.scene.turnClock.left = 9500;
    ctx.controller.tick();
    ctx.scene.turnClock.left = 45000;
  }
  const kinds = ctx.player.log.map(([, item]) => item.kind);
  assert.ok(kinds.length >= 7 && kinds.every((kind) => kind === 'delay'), kinds.join());
});

// ---------------------------------------------------------------- audio cap (browser player)
test('audio memes are cut off at five seconds, even for a 50 second clip', (t) => {
  assert.equal(CONFIG.maxAudioMs, 5000);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const instances = [];
  class FakeAudio {
    constructor(url) {
      this.url = url; this.currentTime = 0; this.volume = 1; this.paused = true; this.handlers = {};
      instances.push(this);
    }
    addEventListener(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); }
    emit(name) { (this.handlers[name] || []).forEach((fn) => fn()); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  const previousAudio = global.Audio;
  global.Audio = FakeAudio;
  try {
    const browserPlayer = memes.createBrowserPlayer({ game: {} });
    browserPlayer.playAudio({ url: 'assets/memes/audio/lose/dont-worry-be-happy_YEjzUZa.mp3' }); // 50.6 s long
    const clip = instances[0];
    clip.emit('playing');
    t.mock.timers.tick(4900);
    assert.equal(clip.paused, false, 'still playing just before the limit');
    t.mock.timers.tick(200);
    assert.equal(clip.paused, true, 'stopped at 5 seconds');

    // a second clip stops the first one, and the playback position alone is also enough to stop it
    browserPlayer.playAudio({ url: 'a.mp3' });
    const next = instances[1];
    next.emit('playing');
    next.currentTime = 5.2;
    next.emit('timeupdate');
    assert.equal(next.paused, true);
  } finally {
    global.Audio = previousAudio;
    t.mock.timers.reset();
  }
});
