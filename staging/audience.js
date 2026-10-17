'use strict';

const MULTIPLAYER_API = 'https://shapey-multiplayer-staging.hellohuman100.workers.dev';
const SHAPE_FILES = {
  mystery: 'Mystery.webp', dummy: 'dummy.webp', hazard: 'hazard.webp', cancel: 'cancel.webp',
  capsule: 'capsule.webp', circle: 'circle.webp', cross: 'cross.webp', divide: 'divide.webp',
  corner: 'four corner.webp', marked: 'marked.webp', pointer: 'shield.webp', shield: 'pointer.webp',
  sphere: 'sphere.webp', square: 'square.webp', star: 'star .webp', x: 'x.webp'
};
// The game's own mode names (MODES in main.js).
const MODE_LABELS = { tag: 'TAG: 2 VS 2', pvp: 'PLAYER 1 VS PLAYER 2', demo: 'AI VS AI' };
const AVATAR_COLORS = ['#754322', '#8a4f2a', '#5d3a1e', '#9a6a35', '#6b4a2a', '#7c3f1d'];

const $ = (id) => document.getElementById(id);
const els = {
  directory: $('directoryView'), watch: $('watchView'), rooms: $('roomCards'), directoryStatus: $('directoryStatus'),
  modeChips: $('modeChips'), statusFilter: $('statusFilter'), refreshRooms: $('refreshRooms'), startDemo: $('startDemo'), navBrowse: $('navBrowse'), gameFrame: $('gameFrame'), muteAudienceSound: $('muteAudienceSound'), endDemo: $('endDemo'),
  board: $('board'), veil: $('veil'), veilText: $('veilText'), retryConnection: $('retryConnection'), toast: $('toast'),
  side0: $('side0'), side1: $('side1'), p1Score: $('p1Score'), p2Score: $('p2Score'), p1Name: $('p1Name'), p2Name: $('p2Name'),
  turnClock: $('turnClock'), goalText: $('goalText'), revealText: $('revealText'),
  btnChat: $('btnChat'), btnPolls: $('btnPolls'), btnSettings: $('btnSettings'), chatBadge: $('chatBadge'), pollBadge: $('pollBadge'),
  backdrop: $('backdrop'), pollPanel: $('pollPanel'), settingsPanel: $('settingsPanel'),
  chatPage: $('chatPage'), backToGame: $('backToGame'), chatRoomTitle: $('chatRoomTitle'),
  chatMessages: $('chatMessages'), chatStatus: $('chatStatus'), chatCount: $('chatCount'), chatForm: $('chatForm'), chatInput: $('chatInput'),
  pollIntro: $('pollIntro'), pollOptions: $('pollOptions'), roomSummary: $('roomSummary'), playersList: $('playersList'), shareRoom: $('shareRoom')
};
const PANELS = {
  polls: { panel: els.pollPanel, button: els.btnPolls },
  settings: { panel: els.settingsPanel, button: els.btnSettings }
};

let roomSocket = null;
let activeRoomCode = '';
let activeMode = '';
let currentState = null;
let roomStatus = 'waiting';
let roomPlayers = [];
let roomSpectators = 0;
let currentPoll = null;
let currentVote = null;
let pollAcceptedId = '';
let pollDeclinedId = '';
let chatIds = new Set();
let unreadChat = 0;
let tileNodes = new Map();
let explicitLeave = false;
let connectionLost = false;
let activePanel = null;
let chatPageOpen = false;
let statusMessage = '';
let statusIsError = false;
let toastTimer = null;
let lastTurnKey = null;
let refreshTimer = null;
let turnTimer = null;
let modeFilterValue = 'all';
let statusFilterValue = 'live';
let demoControlToken = '';
let demoControlRoomCode = '';
let demoControlReady = false;
let audienceAudio = null;
let soundMuted = (() => { try { return localStorage.getItem('shapey-audience-muted') === 'true'; } catch (_) { return false; } })();
let watchToken = 0;      // bumps whenever the viewer opens or leaves a room, so a slow connect can tell it is stale
let roomsCache = [];
let roomsLoadedAt = null;
let roomsLoadSeq = 0;    // only the newest room-list request may update the screen
let pollLockedId = null;
let latestGameFrameMessage = null;

function api(path) { return MULTIPLAYER_API + path; }
function directoryUrl() { return new URL('staging/audience.html', document.baseURI); }
function shapeUrl(shape) {
  const file = SHAPE_FILES[shape] || SHAPE_FILES.mystery;
  return new URL('assets/shapes/' + encodeURIComponent(file), document.baseURI).href;
}
function text(el, value) { el.textContent = value == null ? '' : String(value); }
function modeName(mode) { return MODE_LABELS[mode] || (mode ? String(mode).toUpperCase() : MODE_LABELS.pvp); }
function playerWord(mode) { return mode === 'demo' || mode === 'ai' ? 'AI' : 'Player'; }
function playAudienceTone(frequency = 620) {
  if (soundMuted) return;
  try {
    const AudioClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioClass) return;
    if (!audienceAudio) audienceAudio = new AudioClass();
    if (audienceAudio.state === 'suspended') audienceAudio.resume();
    const oscillator = audienceAudio.createOscillator(); const gain = audienceAudio.createGain();
    oscillator.type = 'sine'; oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.035, audienceAudio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audienceAudio.currentTime + 0.12);
    oscillator.connect(gain); gain.connect(audienceAudio.destination); oscillator.start(); oscillator.stop(audienceAudio.currentTime + 0.12);
  } catch (_) {}
}
function syncGameFrameMute() { try { els.gameFrame.contentWindow?.postMessage({ type: 'shapey-audience-mute', muted: soundMuted }, window.location.origin); } catch (_) {} }
function forwardGameFrameMessage(message) {
  if (!message || !['spectator_welcome', 'game_state', 'game_started'].includes(message.type)) return;
  latestGameFrameMessage = message;
  try { els.gameFrame.contentWindow?.postMessage({ type: 'shapey-audience-message', message }, window.location.origin); } catch (_) {}
}
function statusName(status) {
  return ({ live: 'Live', starting: 'Starting', ready: 'Ready', waiting: 'Waiting' })[status] || status || 'Unknown';
}
function sideOf(mode, playerNumber) { return mode === 'tag' ? (playerNumber <= 2 ? 0 : 1) : playerNumber - 1; }
function sideNames(mode) { return mode === 'tag' ? ['TEAM 1', 'TEAM 2'] : (mode === 'demo' || mode === 'ai') ? ['AI 1', 'AI 2'] : ['Player 1', 'Player 2']; }
// Same wording as the game's turnLabel(): "Team 2: Player 3" in Tag, "Player 1" otherwise.
function turnLabel(mode, playerNumber) {
  return mode === 'tag' ? 'Team ' + (sideOf(mode, playerNumber) + 1) + ': Player ' + playerNumber : playerWord(mode) + ' ' + playerNumber;
}
function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}
function setDirectoryStatus(message, isError) {
  text(els.directoryStatus, message);
  els.directoryStatus.classList.toggle('error', Boolean(isError));
}

// ------------------------------------------------------------------ toast + veil
function showToast(message, ms, isError) {
  clearTimeout(toastTimer);
  text(els.toast, message || '');
  els.toast.classList.toggle('error', Boolean(isError));
  els.toast.hidden = !message;
  if (message && ms) {
    toastTimer = setTimeout(() => {
      if (statusIsError && statusMessage) {
        text(els.toast, statusMessage);
        els.toast.classList.add('error');
      } else {
        text(els.toast, '');
        els.toast.hidden = true;
      }
    }, ms);
  }
}
function updateVeil() {
  const hasBoard = Boolean(currentState && Array.isArray(currentState.tiles) && currentState.tiles.length);
  els.veil.hidden = hasBoard && !connectionLost;
  if (!els.veil.hidden) text(els.veilText, (statusMessage || (connectionLost ? 'Disconnected from the room.' : 'Connecting…')).toUpperCase());
  els.retryConnection.hidden = !connectionLost;
  els.retryConnection.disabled = false;
}
function setWatchStatus(message, isError) {
  statusMessage = message || '';
  statusIsError = Boolean(isError);
  showToast(statusMessage, isError ? 0 : 3200, isError);
  updateVeil();
}

// ------------------------------------------------------------------ panels (chat, polls, menu)
function updateBadges() {
  els.chatBadge.hidden = unreadChat === 0;
  text(els.chatBadge, unreadChat > 9 ? '9+' : unreadChat);
  els.pollBadge.hidden = !(pollIsOpen(currentPoll) && !currentVote && activePanel !== 'polls');
}
function closePanels() {
  activePanel = null;
  els.backdrop.hidden = true;
  Object.values(PANELS).forEach(({ panel, button }) => {
    panel.hidden = true;
    button.classList.remove('is-open');
    button.setAttribute('aria-expanded', 'false');
  });
  updateBadges();
}
function openChatPage(updateUrl = true) {
  if (!activeRoomCode || chatPageOpen) return;
  closePanels();
  chatPageOpen = true;
  els.watch.hidden = true;
  els.chatPage.hidden = false;
  document.body.classList.add('chat-open');
  els.btnChat.classList.add('is-open');
  els.btnChat.setAttribute('aria-expanded', 'true');
  unreadChat = 0;
  updateBadges();
  requestAnimationFrame(() => {
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
    els.chatInput.focus({ preventScroll: true });
  });
  if (updateUrl && window.location.hash !== '#chat') {
    window.history.pushState({ shapeyAudienceChat: true }, '', window.location.pathname + window.location.search + '#chat');
  }
}
function closeChatPage(updateUrl = true) {
  if (!chatPageOpen) return;
  chatPageOpen = false;
  els.chatPage.hidden = true;
  document.body.classList.remove('chat-open');
  els.btnChat.classList.remove('is-open');
  els.btnChat.setAttribute('aria-expanded', 'false');
  if (activeRoomCode) els.watch.hidden = false;
  if (updateUrl && window.location.hash === '#chat') {
    window.history.replaceState(window.history.state || {}, '', window.location.pathname + window.location.search);
  }
}
function openPanel(name) {
  if (activePanel === name) { closePanels(); return; }
  closePanels();
  if (name === 'polls' && !['pvp', 'tag', 'demo'].includes(activeMode)) return;
  if (name === 'polls' && pollIsOpen(currentPoll)) {
    setWatchStatus('The audience poll is live. Tap a highlighted tile on the board to vote.', false);
    return;
  }
  activePanel = name;
  els.backdrop.hidden = false;
  PANELS[name].panel.hidden = false;
  PANELS[name].button.classList.add('is-open');
  PANELS[name].button.setAttribute('aria-expanded', 'true');
  if (name === 'settings') renderPlayers();
  if (name === 'polls') renderPoll(currentPoll);
  updateBadges();
}
// These audience rooms all use the existing Chat, Polls and Settings icons.
function applyModeUI() {
  const hasPolls = ['pvp', 'tag', 'demo'].includes(activeMode);
  els.btnPolls.hidden = !hasPolls;
  els.btnChat.style.setProperty('--x', hasPolls ? 175 : 250);
  els.btnPolls.style.setProperty('--x', 360);
  els.btnSettings.style.setProperty('--x', hasPolls ? 545 : 470);
  const names = sideNames(activeMode);
  text(els.p1Name, names[0]);
  text(els.p2Name, names[1]);
  if (!hasPolls && activePanel === 'polls') closePanels();
}

// ------------------------------------------------------------------ views
function closeSocket() {
  if (roomSocket) {
    const old = roomSocket;
    roomSocket = null;
    try { old.close(1000, 'Audience left room'); } catch (_) {}
  }
}
function resetRoomView() {
  if (chatPageOpen) closeChatPage(false);
  els.chatPage.hidden = true;
  document.body.classList.remove('chat-open');
  chatPageOpen = false;
  currentState = null;
  latestGameFrameMessage = null;
  currentPoll = null;
  currentVote = null;
  pollAcceptedId = '';
  pollDeclinedId = '';
  lastTurnKey = null;
  unreadChat = 0;
  pollLockedId = null;
  connectionLost = false;
  statusMessage = '';
  statusIsError = false;
  tileNodes.forEach((node) => node.remove());
  tileNodes.clear();
  els.board.replaceChildren();
  if (els.gameFrame) { els.gameFrame.hidden = true; els.gameFrame.src = 'about:blank'; }
  els.watch.classList.remove('has-game-frame', 'game-ready');
  els.pollOptions.replaceChildren();
  els.chatMessages.replaceChildren();
  chatIds = new Set();
  text(els.chatStatus, '');
  showToast('', 0, false);
  closePanels();
}
function showDirectory(updateUrl) {
  if (chatPageOpen) closeChatPage(false);
  explicitLeave = true;
  watchToken++;
  closeSocket();
  activeRoomCode = '';
  activeMode = '';
  resetRoomView();
  els.directory.hidden = false;
  els.watch.hidden = true;
  if (updateUrl) window.history.pushState({}, '', directoryUrl().pathname);
  loadRooms();
}
function enterWatchView(code) {
  els.directory.hidden = true;
  els.watch.hidden = false;
  const url = directoryUrl();
  url.searchParams.set('room', code);
  if (activeMode) url.searchParams.set('mode', activeMode);
  window.history.pushState({}, '', url.pathname + url.search);
}

// ------------------------------------------------------------------ room directory
function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content != null) text(node, content);
  return node;
}
function makePill(status) {
  return el('span', 'tag-pill' + (status === 'live' ? ' live' : ''), statusName(status));
}
function makeRoomCard(room) {
  const tag = room.mode === 'tag';
  const card = el('article', 'panel room-card');
  const top = el('div', 'top');
  const title = el('h3', 'gt', modeName(room.mode));
  title.style.setProperty('--fs', 26);
  title.style.setProperty('--st', 6);
  title.style.whiteSpace = 'normal';
  const pills = el('div', 'pills');
  if (room.mode === 'demo') pills.append(el('span', 'tag-pill demo', 'Demo'));
  pills.append(makePill(room.status));
  top.append(title, pills);
  card.append(top);

  const names = sideNames(room.mode).map((name) => name.toUpperCase());
  const scores = Array.isArray(room.scores) ? room.scores : [0, 0];
  const row = el('div', 'score-row');
  row.append(el('span', 'side', names[0]), el('b', 'num', Number(scores[0]) || 0), el('span', 'side', '–'),
    el('b', 'num', Number(scores[1]) || 0), el('span', 'side', names[1]));
  card.append(row);

  const max = Number(room.maxPlayers) || (tag ? 4 : 2);
  card.append(el('div', 'sub', 'Room ' + room.roomCode + ' · ' + (Number(room.playerCount) || 0) + '/' + max + ' players · ' +
    (Number(room.spectatorCount) || 0) + ' watching'));

  const boardSize = [5, 6, 7].includes(Number(room.boardSize)) ? Number(room.boardSize) : 7;
  const details = ['Board ' + boardSize + '×' + boardSize, 'First to ' + (Number(room.targetScore) || (tag ? 200 : 100))];
  if (room.status === 'live' && room.activePlayerNumber) details.push(turnLabel(room.mode, room.activePlayerNumber) + ' to play');
  if (Number.isFinite(room.createdAt)) {
    const minutes = Math.max(0, Math.floor((Date.now() - room.createdAt) / 60000));
    details.push(minutes < 1 ? 'just started' : 'open ' + minutes + ' min');
  }
  if (room.mode === 'demo') details.push('Two AIs playing · audience view');
  card.append(el('div', 'sub', details.join(' · ')));

  const watch = el('button', 'wood', 'WATCH');
  watch.type = 'button';
  watch.style.setProperty('--fs', 32);
  watch.addEventListener('click', () => startWatching(room.roomCode, room.mode, true));
  card.append(watch);
  return card;
}
const isWaiting = (room) => ['waiting', 'ready', 'starting'].includes(room.status);
function updateFilterChips() {
  const matchesStatus = (room) => statusFilterValue === 'all' || (statusFilterValue === 'live' ? room.status === 'live' : isWaiting(room));
  const matchesMode = (room) => modeFilterValue === 'all' || room.mode === modeFilterValue;
  const byStatus = roomsCache.filter(matchesStatus);
  const byMode = roomsCache.filter(matchesMode);
  const modeCount = {
    all: byStatus.length,
    tag: byStatus.filter((r) => r.mode === 'tag').length,
    pvp: byStatus.filter((r) => r.mode === 'pvp').length,
    demo: byStatus.filter((r) => r.mode === 'demo').length
  };
  const modeNames = { all: 'All', tag: 'Tag · 2 vs 2', pvp: '1 vs 1', demo: 'AI vs AI' };
  els.modeChips.querySelectorAll('.chip').forEach((chip) => {
    const key = chip.dataset.mode;
    chip.classList.toggle('is-active', key === modeFilterValue);
    chip.setAttribute('aria-pressed', String(key === modeFilterValue));
    text(chip, modeNames[key] + ' (' + (modeCount[key] ?? 0) + ')');
  });
  const statusCount = { live: byMode.filter((r) => r.status === 'live').length, waiting: byMode.filter(isWaiting).length, all: byMode.length };
  const statusNames = { live: 'Live games', waiting: 'Waiting rooms', all: 'All available rooms' };
  [...els.statusFilter.options].forEach((option) => {
    option.textContent = statusNames[option.value] + ' (' + (statusCount[option.value] ?? 0) + ')';
  });
  els.statusFilter.value = statusFilterValue;
}
function renderRooms() {
  if (!roomsLoadedAt) return;
  updateFilterChips();
  const rank = { live: 0, starting: 1, ready: 2, waiting: 3 };
  const filtered = roomsCache
    .filter((room) => statusFilterValue === 'all' || (statusFilterValue === 'live' ? room.status === 'live' : isWaiting(room)))
    .filter((room) => modeFilterValue === 'all' || room.mode === modeFilterValue)
    .sort((a, b) => (Number(b.spectatorCount) || 0) - (Number(a.spectatorCount) || 0) || (rank[a.status] ?? 4) - (rank[b.status] ?? 4));
  els.rooms.replaceChildren();
  if (!filtered.length) {
    els.rooms.append(el('div', 'notice', roomsCache.length
      ? 'No rooms match those filters. Try ALL ROOMS to include games that have not started.'
      : 'No public rooms are active right now. Check back in a little while, or start a room from the game.'));
  } else {
    filtered.forEach((room) => els.rooms.append(makeRoomCard(room)));
  }
  const noun = filtered.length === 1 ? 'room' : 'rooms';
  setDirectoryStatus(filtered.length + ' ' + noun + ' · updated ' + roomsLoadedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), false);
}
async function loadRooms() {
  const seq = ++roomsLoadSeq;
  setDirectoryStatus('Refreshing the room list…', false);
  els.refreshRooms.disabled = true;
  try {
    const response = await fetch(api('/api/rooms'), { cache: 'no-store', headers: { Accept: 'application/json' } });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (seq !== roomsLoadSeq) return; // a newer refresh has started; ignore this older answer
    if (!response.ok) throw new Error(data.error || ('Room directory returned HTTP ' + response.status));
    roomsCache = Array.isArray(data.rooms) ? data.rooms : [];
    roomsLoadedAt = new Date();
    renderRooms();
  } catch (error) {
    if (seq !== roomsLoadSeq) return;
    els.rooms.replaceChildren(el('div', 'notice', error.message || 'The live directory is unavailable. Please retry.'));
    setDirectoryStatus('Could not reach the live room service. Please refresh and try again.', true);
  } finally {
    if (seq === roomsLoadSeq) els.refreshRooms.disabled = false;
  }
}

// ------------------------------------------------------------------ in-room rendering
function sendSocketMessage(message) {
  if (!roomSocket || roomSocket.readyState !== WebSocket.OPEN) {
    text(els.chatStatus, 'Not connected. Close this and tap RETRY.');
    setWatchStatus('Not connected to the room.', true);
    return false;
  }
  try { roomSocket.send(JSON.stringify(message)); return true; } catch (_) { return false; }
}
function renderScores(state) {
  const scores = Array.isArray(state.scores) ? state.scores : [0, 0];
  text(els.p1Score, Number(scores[0]) || 0);
  text(els.p2Score, Number(scores[1]) || 0);
  // Like the game, the side that is not playing is dimmed.
  const playing = state.status === 'playing' && state.activePlayerNumber;
  const side = playing ? sideOf(state.mode, state.activePlayerNumber) : -1;
  els.side0.classList.toggle('dim', side === 1);
  els.side1.classList.toggle('dim', side === 0);
  // The game shows whose turn it is under the timer in Tag only.
  const showGoal = state.mode === 'tag' && playing;
  els.goalText.hidden = !showGoal;
  if (showGoal) text(els.goalText, (turnLabel(state.mode, state.activePlayerNumber) + (state.isBonusTurn ? ' · Double Play' : '')).toUpperCase());
}
function renderBoard(state, previousState = null, animate = false) {
  if (!state || !Array.isArray(state.tiles)) {
    els.board.replaceChildren();
    tileNodes.clear();
    return;
  }
  const requestedSize = [5, 6, 7].includes(Number(state.boardSize)) ? Number(state.boardSize) : 7;
  // Tag remains 7×7. Other modes scale tile size and spacing to fill the same fixed tray area.
  const boardSize = state.mode === 'tag' ? 7 : requestedSize;
  const boardScale = 7 / boardSize;
  const tilePitch = 91 * boardScale;
  const tileSize = tilePitch - 1; // preserve the original 1px gap and 636px tray footprint
  const tileScale = tileSize / 90;
  els.board.style.setProperty('--board-offset', '0');
  els.board.style.setProperty('--tile-size', String(tileSize));
  els.board.style.setProperty('--tile-pitch', String(tilePitch));
  els.board.style.setProperty('--dust-offset-x', String(36 * tileScale));
  els.board.style.setProperty('--dust-offset-y', String(9 * tileScale));
  els.board.style.setProperty('--dust-width', String(162 * tileScale));
  els.board.style.setProperty('--dust-height', String(81 * tileScale));
  const canAnimate = Boolean(animate && previousState && Array.isArray(previousState.tiles) && previousState.status === 'playing');
  const previousTiles = canAnimate ? new Map(previousState.tiles.map((tile) => [String(tile.id), tile])) : new Map();
  const newCountByColumn = new Map();
  if (canAnimate) {
    for (const tile of state.tiles) {
      if (!previousTiles.has(String(tile.id))) newCountByColumn.set(tile.col, (newCountByColumn.get(tile.col) || 0) + 1);
    }
  }
  const options = Array.isArray(currentPoll && currentPoll.options) ? currentPoll.options : [];
  const optionId = (option) => option && typeof option === 'object' ? String(option.tileId || '') : String(option || '');
  const optionIds = new Set(options.map(optionId).filter(Boolean));
  const counts = currentPoll && currentPoll.closed ? (currentPoll.counts || {}) : {};
  const optionCounts = options.map((option) => Number(counts[optionId(option)]) || 0);
  const totalVotes = optionCounts.reduce((sum, count) => sum + count, 0);
  const best = Math.max(0, ...optionCounts);
  const percents = percentSplit(optionCounts);
  const percentById = new Map();
  options.forEach((option, index) => percentById.set(optionId(option), percents[index]));
  const canVote = Boolean(pollIsOpen(currentPoll) && !currentVote && roomSocket && roomSocket.readyState === WebSocket.OPEN);

  const keep = new Set();
  for (const tileData of state.tiles) {
    if (!Number.isInteger(tileData.row) || !Number.isInteger(tileData.col)) continue;
    const id = String(tileData.id);
    keep.add(id);
    let tile = tileNodes.get(id);
    let animateSpawn = false;
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'tile';
      tile.dataset.tileId = id;
      const image = document.createElement('img');
      image.draggable = false;
      image.alt = 'Hidden tile';
      const badge = document.createElement('span');
      badge.className = 'tile-vote-count';
      badge.hidden = true;
      tile.append(image, badge);
      tile.addEventListener('click', () => voteForTile(tile.dataset.tileId));
      tile.addEventListener('keydown', (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && tile.tabIndex >= 0) {
          event.preventDefault();
          voteForTile(tile.dataset.tileId);
        }
      });
      tile.addEventListener('transitionend', (event) => {
        if (event.propertyName === 'top') finishSpawnDust(tile);
      });
      animateSpawn = canAnimate && !previousTiles.has(id) && state.status !== 'study';
      if (animateSpawn) {
        const spawnCount = newCountByColumn.get(tileData.col) || 1;
        const startingRow = tileData.row - spawnCount;
        const landingDelay = 40 * Math.max(0, spawnCount - 1 - tileData.row);
        const landingDuration = 260 + Math.max(1, spawnCount) * 90;
        tile.style.setProperty('--c', tileData.col);
        tile.style.setProperty('--r', startingRow);
        tile.style.transitionDelay = landingDelay + 'ms';
        tile.style.transitionDuration = '.36s, ' + landingDuration + 'ms, .18s';
        tile.dataset.spawnDust = 'true';
        tile.dataset.dustRow = String(tileData.row);
        tile.dataset.dustCol = String(tileData.col);
        tile.classList.add('is-spawning');
      } else {
        tile.style.setProperty('--c', tileData.col);
        tile.style.setProperty('--r', tileData.row);
      }
      els.board.append(tile);
      tileNodes.set(id, tile);
      if (animateSpawn) {
        const spawnCount = newCountByColumn.get(tileData.col) || 1;
        const landingDelay = 40 * Math.max(0, spawnCount - 1 - tileData.row);
        const landingDuration = 260 + Math.max(1, spawnCount) * 90;
        window.requestAnimationFrame(() => {
          if (tileNodes.get(id) !== tile) return;
          tile.classList.remove('is-spawning');
          tile.style.setProperty('--r', tileData.row);
        });
        window.setTimeout(() => finishSpawnDust(tile), landingDelay + landingDuration + 100);
      }
    } else {
      tile.style.setProperty('--c', tileData.col);
      tile.style.setProperty('--r', tileData.row);
    }
    tile.classList.toggle('is-moving', Boolean(tileData.moving));
    tile.classList.toggle('is-selected', Boolean(tileData.selected));
    const image = tile.firstElementChild;
    const visibleShape = tileData.faceUp && tileData.shape ? tileData.shape : 'mystery';
    const url = shapeUrl(visibleShape);
    if (image.src !== url) image.src = url;
    image.alt = tileData.faceUp && tileData.shape ? tileData.shape : 'Hidden tile';
    const isPollOption = optionIds.has(id) && !tileData.faceUp && !tileData.selected && !tileData.moving;
    const isThisVote = currentVote === id;
    const votes = Number(counts[id]) || 0;
    const isWinner = Boolean(currentPoll && currentPoll.closed && totalVotes > 0 && isPollOption && votes === best);
    const isClickable = canVote && isPollOption;
    tile.classList.toggle('is-vote-option', isClickable);
    tile.classList.toggle('is-voted', isThisVote);
    tile.classList.toggle('is-poll-winner', isWinner);
    tile.setAttribute('role', isClickable ? 'button' : 'img');
    tile.tabIndex = isClickable ? 0 : -1;
    const position = 'Row ' + (tileData.row + 1) + ', column ' + (tileData.col + 1);
    tile.setAttribute('aria-label', image.alt + ', ' + position +
      (isClickable ? '. Tap to vote for this tile' : isThisVote ? '. Your vote' : ''));
    tile.style.zIndex = tileData.moving ? '4' : tileData.selected ? '3' : (isClickable || isThisVote || isWinner ? '6' : '1');
    const voteBadge = tile.querySelector('.tile-vote-count');
    if (voteBadge && currentPoll && currentPoll.closed && isPollOption && totalVotes > 0 && votes > 0) {
      voteBadge.hidden = false;
      voteBadge.textContent = (percentById.get(id) || 0) + '%';
    } else if (voteBadge) {
      voteBadge.hidden = true;
      voteBadge.textContent = '';
    }
  }
  for (const [id, node] of tileNodes.entries()) {
    if (!keep.has(id)) {
      const oldTile = previousTiles.get(id);
      if (canAnimate && oldTile) playBoardEffect('destroy', oldTile.row, oldTile.col);
      node.remove();
      tileNodes.delete(id);
    }
  }
}
function finishSpawnDust(tile) {
  if (!tile || tile.dataset.spawnDust !== 'true') return;
  delete tile.dataset.spawnDust;
  tile.style.transitionDelay = '';
  tile.style.transitionDuration = '';
  if (tileNodes.get(tile.dataset.tileId) !== tile) return;
  playBoardEffect('dust', Number(tile.dataset.dustRow), Number(tile.dataset.dustCol));
}
function playBoardEffect(kind, row, col) {
  if (els.gameFrame && !els.gameFrame.hidden) return;
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 6 || col < 0 || col > 6) return;
  const effect = document.createElement('div');
  effect.className = 'board-fx ' + (kind === 'dust' ? 'dust-fx' : 'destroy-fx');
  effect.style.setProperty('--c', col);
  effect.style.setProperty('--r', row);
  els.board.append(effect);
  effect.addEventListener('animationend', () => effect.remove(), { once: true });
}
function voteForTile(tileId) {
  const poll = currentPoll;
  const options = Array.isArray(poll && poll.options) ? poll.options : [];
  if (!pollIsOpen(poll) || currentVote || !roomSocket || roomSocket.readyState !== WebSocket.OPEN) return;
  if (!options.some((option) => (option && typeof option === 'object' ? String(option.tileId) : String(option)) === String(tileId))) return;
  const tile = currentState && Array.isArray(currentState.tiles)
    ? currentState.tiles.find((item) => String(item.id) === String(tileId)) : null;
  if (!tile || tile.faceUp || tile.selected || tile.moving) return;
  if (sendSocketMessage({ type: 'poll_vote', tileId: String(tileId) })) {
    currentVote = String(tileId);
    renderPoll(currentPoll);
    setWatchStatus('Vote submitted for row ' + (tile.row + 1) + ', column ' + (tile.col + 1) + '.', false);
  }
}
function updateBoardPollHint() {
  if (currentPoll && pollIsOpen(currentPoll)) {
    text(els.boardFootnote, 'Audience poll open: tap any cyan-outlined face-down tile on the shared board to vote once.');
  } else if (currentPoll && currentPoll.closed) {
    text(els.boardFootnote, 'Poll closed. Gold outlines and percentages show the audience’s top board choice or tied tiles.');
  }
}
// Turn clock and the MEMORIZE / SHUFFLING cue, drawn from the same deadlines the game uses.
function updateHud() {
  const state = currentState;
  if (!state) { text(els.turnClock, '--:--'); text(els.revealText, ''); return; }
  const now = Date.now();
  let clock;
  if (state.status === 'study') clock = '--:--';
  else if (state.status === 'playing' && Number.isFinite(state.turnEndsAt)) clock = formatClock(state.turnEndsAt - now);
  else if (state.status === 'finished') clock = formatClock(0);
  else clock = '--:--';
  text(els.turnClock, clock);
  let left = state.status === 'study' && Number.isFinite(state.reviewEndsAt) ? state.reviewEndsAt - now : 0;
  (state.reveals || []).forEach((batch) => { left = Math.max(left, batch.endsAt - now); });
  if (left > 0) text(els.revealText, 'MEMORIZE ' + formatClock(left));
  else if (state.shuffling) text(els.revealText, 'SHUFFLING');
  else text(els.revealText, '');
}
function renderGameState(state) {
  if (!state) return;
  const previousState = currentState;
  currentState = state;
  activeMode = state.mode || activeMode;
  connectionLost = false;
  applyModeUI();
  renderBoard(state, previousState, Boolean(previousState));
  renderScores(state);
  updateHud();
  if (state.status === 'playing') {
    const key = state.turnIndex + ':' + state.activePlayerNumber + ':' + Boolean(state.isBonusTurn);
    if (lastTurnKey !== null && key !== lastTurnKey) {
      showToast((state.isBonusTurn ? 'Double Play! ' : '') + turnLabel(state.mode, state.activePlayerNumber) + '’s turn', 2600, false);
    }
    lastTurnKey = key;
  } else if (state.status === 'finished') {
    const winner = Number.isInteger(state.winnerPlayerNumber) ? playerWord(state.mode) + ' ' + state.winnerPlayerNumber + ' wins'
      : (Number.isInteger(state.winnerSide) ? 'Team ' + (state.winnerSide + 1) + ' wins' : '');
    showToast('Game over' + (winner ? ' · ' + winner : ''), 0, false);
  }
  updateBoardPollHint();
  updateVeil();
}
function renderPlayers() {
  els.endDemo.hidden = !(activeMode === 'demo' && demoControlRoomCode === activeRoomCode && demoControlReady);
  els.playersList.replaceChildren();
  const tag = activeMode === 'tag';
  const connected = new Set((roomPlayers || []).filter((p) => p && p.connected).map((p) => p.playerNumber));
  for (let number = 1; number <= (tag ? 4 : 2); number++) {
    const row = el('div', 'roster-row');
    row.append(el('span', '', (tag ? 'Team ' + (sideOf('tag', number) + 1) + ' · ' : '') + playerWord(activeMode) + ' ' + number),
      el('span', 'state' + (connected.has(number) ? ' on' : ''), connected.has(number) ? 'CONNECTED' : 'WAITING'));
    els.playersList.append(row);
  }
  text(els.roomSummary, (modeName(activeMode) + ' · Room ' + activeRoomCode + ' · ' + statusName(roomStatus) + ' · ' + roomSpectators + ' watching').toUpperCase());
  text(els.chatCount, roomSpectators + ' watching');
}

// ------------------------------------------------------------------ chat (text only)
function ensureChatEmpty() {
  if (!els.chatMessages.querySelector('.msg') && !els.chatMessages.querySelector('.empty')) {
    els.chatMessages.append(el('div', 'empty', 'No messages yet.\nBe the first to say hello!'));
    els.chatMessages.lastElementChild.style.whiteSpace = 'pre-line';
  }
}
function avatarColor(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
function appendChat(message, live) {
  if (!message || typeof message.text !== 'string') return;
  if (message.id && chatIds.has(message.id)) return;
  if (message.id) chatIds.add(message.id);
  const empty = els.chatMessages.querySelector('.empty');
  if (empty) empty.remove();
  const sender = message.sender || 'Audience';
  const item = el('div', 'msg');
  const avatar = el('div', 'avatar', Array.from(sender)[0] ? Array.from(sender)[0].toUpperCase() : '?');
  avatar.style.setProperty('--bg', avatarColor(sender));
  const main = el('div', 'msg-main');
  const head = el('div', 'msg-head');
  head.append(el('strong', '', sender), el('p', '', message.text));
  const timestamp = message.createdAt || message.at;
  if (timestamp) {
    const elapsedMs = Math.max(0, Date.now() - new Date(timestamp).getTime());
    const elapsedMinutes = Math.floor(elapsedMs / 60000);
    const relative = elapsedMinutes < 1 ? 'now'
      : elapsedMinutes < 60 ? elapsedMinutes + 'm'
      : elapsedMinutes < 1440 ? Math.floor(elapsedMinutes / 60) + 'h'
      : Math.floor(elapsedMinutes / 1440) + 'd';
    main.append(head, el('time', 'msg-time', relative));
  } else {
    main.append(head);
  }
  item.append(avatar, main);
  const nearBottom = els.chatMessages.scrollHeight - els.chatMessages.scrollTop - els.chatMessages.clientHeight < 80;
  els.chatMessages.append(item);
  while (els.chatMessages.querySelectorAll('.msg').length > 100) els.chatMessages.querySelector('.msg').remove();
  if (nearBottom || !live) els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  if (live && !chatPageOpen) { unreadChat++; updateBadges(); }
}

// ------------------------------------------------------------------ polls ("Ask the Audience")
function percentSplit(values) {
  const total = values.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return values.map(() => 0);
  const exact = values.map((n) => (n / total) * 100);
  const result = exact.map(Math.floor);
  let left = 100 - result.reduce((sum, n) => sum + n, 0);
  exact.map((x, i) => ({ i, rest: x - Math.floor(x) })).sort((a, b) => b.rest - a.rest)
    .forEach(({ i }) => { if (left-- > 0) result[i]++; });
  return result;
}
function pollSecondsLeft(poll) { return Math.max(0, Math.ceil(((Number(poll.endsAt) || 0) - Date.now()) / 1000)); }
function pollIsOpen(poll) { return Boolean(poll) && !poll.closed && pollSecondsLeft(poll) > 0; }
function updatePollIntro() {
  const poll = currentPoll;
  if (!poll) return;
  if (poll.closed) {
    const options = Array.isArray(poll.options) ? poll.options : [];
    const ids = options.map((option) => option && typeof option === 'object' ? String(option.tileId || '') : String(option || ''));
    const counts = ids.map((id) => Number((poll.counts || {})[id]) || 0);
    const total = counts.reduce((sum, count) => sum + count, 0);
    const best = Math.max(0, ...counts);
    const leaders = options.filter((option, index) => total > 0 && counts[index] === best);
    const positions = leaders.slice(0, 3).map((option) => 'row ' + (Number(option.row) + 1) + ', column ' + (Number(option.col) + 1));
    text(els.pollIntro, total
      ? 'Poll closed · ' + total + ' vote' + (total === 1 ? '' : 's') + ' · most popular: ' + positions.join(' / ')
      : 'Poll closed · no votes were cast');
  } else if (pollSecondsLeft(poll) > 0) {
    text(els.pollIntro, 'Ask the Audience · ' + pollSecondsLeft(poll) +
      's left · tap any cyan-outlined face-down tile on the board to vote once');
  } else {
    text(els.pollIntro, 'Voting has ended · counting the votes…');
  }
}
// Spectators vote directly on the live board rather than from a fixed list of choices.
function renderPoll(poll) {
  const changed = Boolean(poll && (!currentPoll || currentPoll.id !== poll.id));
  if (changed || !poll) {
    currentVote = null;
    pollAcceptedId = '';
    pollDeclinedId = '';
  }
  currentPoll = poll || null;
  els.pollOptions.replaceChildren();
  renderBoard(currentState, currentState, false);
  updateBoardPollHint();
  if (!poll) {
    text(els.pollIntro, ['pvp', 'tag', 'demo'].includes(activeMode)
      ? 'No poll is open. Players can ask the audience after revealing the first shape.'
      : 'Audience polls are available in online Player 1 vs Player 2 and Tag games.');
    updateBadges();
    return;
  }
  updatePollIntro();
  if (!poll.closed) {
    text(els.pollOptions, currentVote
      ? 'Your vote is locked. Wait for the poll to close to see the results.'
      : 'Tap a cyan-outlined face-down tile on the board. Every eligible hidden tile can be chosen; no fixed three- or four-option list.');
  } else {
    text(els.pollOptions, 'Voting is closed. Gold outlines and percentages on the board show the top-voted tile or tied tiles.');
  }
  updateBadges();
}

// ------------------------------------------------------------------ socket messages
function processMessage(message) {
  if (!message || typeof message.type !== 'string') return;
  forwardGameFrameMessage(message);
  if (message.type === 'demo_control_ready') {
    if (activeMode === 'demo' && demoControlRoomCode === activeRoomCode) { demoControlReady = true; renderPlayers(); }
    return;
  }
  if (message.type === 'demo_ended') { showDirectory(true); setDirectoryStatus('The AI-vs-AI demo has ended. Start another demo to keep testing.', false); return; }
  if (message.type === 'spectator_welcome') {
    roomStatus = message.status || 'waiting';
    roomPlayers = message.players || [];
    roomSpectators = Number(message.spectatorCount) || 0;
    connectionLost = false;
    setWatchStatus(activeMode === 'demo' ? 'Watching the AI-vs-AI demo.' : 'Watching the match.', false);
    if (message.state) renderGameState(message.state);
    else setWatchStatus('Waiting for all players to join…', false);
    renderPlayers();
    (message.chatHistory || []).forEach((m) => appendChat(m, false));
    ensureChatEmpty();
    renderPoll(message.poll);
    if (message.poll && !message.poll.closed) {
      closePanels();
      setWatchStatus('An audience poll is open. Tap any cyan-outlined face-down tile on the board to vote.', false);
    }
    text(els.chatStatus, 'Connected to room chat.');
    return;
  }
  if ((message.type === 'game_state' || message.type === 'game_started') && message.state) {
    roomStatus = message.state.status === 'playing' ? 'live' : message.state.status === 'finished' ? 'finished' : 'starting';
    renderGameState(message.state);
    renderPlayers();
    return;
  }
  if (message.type === 'room_state') {
    roomPlayers = message.players || [];
    roomStatus = message.status || roomStatus;
    renderPlayers();
    return;
  }
  if (message.type === 'spectator_count') {
    roomSpectators = Number(message.count) || 0;
    renderPlayers();
    return;
  }
  if (message.type === 'chat_message' && message.message) {
    appendChat(message.message, true);
    playAudienceTone(620);
    return;
  }
  if (message.type === 'audience_poll_state') {
    const newOpenPoll = message.poll && !message.poll.closed && (!currentPoll || currentPoll.id !== message.poll.id);
    if (newOpenPoll) {
      playAudienceTone(760);
      closePanels();
      setWatchStatus('An audience poll is open. Tap any cyan-outlined face-down tile on the board to vote.', false);
    }
    renderPoll(message.poll || null);
    return;
  }
  if (message.type === 'error') {
    setWatchStatus(message.message || 'The room rejected that request.', true);
    text(els.chatStatus, message.message || 'The room rejected that request.');
  }
}
async function startWatching(roomCode, hintedMode, pushUrl) {
  const code = String(roomCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    showDirectory(false);
    setDirectoryStatus('That room code is not valid.', true);
    return;
  }
  explicitLeave = false;
  const token = ++watchToken;
  closeSocket();
  activeRoomCode = code;
  activeMode = hintedMode || '';
  if (chatPageOpen) closeChatPage(false);
  resetRoomView();
  applyModeUI();
  ensureChatEmpty();
  text(els.turnClock, '--:--');
  text(els.revealText, '');
  els.goalText.hidden = true;
  text(els.p1Score, 0);
  text(els.p2Score, 0);
  els.side0.classList.remove('dim');
  els.side1.classList.remove('dim');
  setWatchStatus('Connecting to the room…', false);
  els.directory.hidden = true;
  els.watch.hidden = false;
  if (pushUrl) enterWatchView(code);
  try {
    const roomResponse = await fetch(api('/api/rooms/' + code), { cache: 'no-store' });
    const details = await roomResponse.json();
    if (token !== watchToken) return; // the viewer left or opened another room while this was loading
    if (!roomResponse.ok) throw new Error(details.error || 'Room not found.');
    if (!activeMode) activeMode = details.mode;
    if (details.mode !== activeMode) throw new Error('The shared link has a different game mode. Please open the room again from the live games list.');
    applyModeUI();
    roomStatus = details.status || 'waiting';
    roomPlayers = details.players || [];
    renderPlayers();
    const wsBase = MULTIPLAYER_API.replace(/^http/, 'ws');
    const socket = new WebSocket(wsBase + '/ws/' + code + '?mode=' + encodeURIComponent(activeMode) + '&role=spectator');
    els.gameFrame.hidden = false;
    els.watch.classList.add('has-game-frame');
    els.watch.classList.remove('game-ready');
    const frameUrl = new URL('staging/index.html', document.baseURI);
    frameUrl.searchParams.set('watch', code);
    frameUrl.searchParams.set('mode', activeMode);
    frameUrl.searchParams.set('embed', '1');
    els.gameFrame.onload = () => {
      if (latestGameFrameMessage) forwardGameFrameMessage(latestGameFrameMessage);
      syncGameFrameMute();
    };
    els.gameFrame.src = frameUrl.href;
    syncGameFrameMute();
    roomSocket = socket;
    socket.addEventListener('open', () => {
      if (roomSocket !== socket) return;
      sendSocketMessage({ type: 'spectate' });
      if (demoControlToken && demoControlRoomCode === code) socket.send(JSON.stringify({ type: 'demo_control', token: demoControlToken }));
    });
    socket.addEventListener('message', (event) => {
      if (roomSocket !== socket) return;
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      processMessage(message);
    });
    socket.addEventListener('error', () => {
      if (roomSocket === socket) setWatchStatus('Could not connect. The room may have expired or the audience limit may have been reached.', true);
    });
    socket.addEventListener('close', () => {
      if (roomSocket !== socket) return;
      roomSocket = null;
      connectionLost = true;
      if (!explicitLeave) setWatchStatus('Disconnected from the room. Tap RETRY to keep watching.', true);
      else updateVeil();
      if (currentPoll && !currentPoll.closed) renderPoll(currentPoll);
    });
  } catch (error) {
    if (token !== watchToken) return;
    connectionLost = true;
    setWatchStatus(error.message || 'Could not open this room.', true);
    text(els.roomSummary, 'This room is no longer available in the staging service.');
  }
}
async function shareWatchLink() {
  if (!activeRoomCode) return;
  const url = directoryUrl();
  url.searchParams.set('room', activeRoomCode);
  url.searchParams.set('mode', activeMode);
  const flash = (label) => {
    const original = 'COPY WATCH LINK';
    text(els.shareRoom, label);
    setTimeout(() => text(els.shareRoom, original), 2000);
  };
  try {
    await navigator.clipboard.writeText(url.href);
    flash('LINK COPIED!');
  } catch (_) {
    const field = document.createElement('input');
    field.value = url.href;
    field.readOnly = true;
    document.body.append(field);
    field.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (_) {}
    field.remove();
    if (copied) flash('LINK COPIED!');
    else text(els.roomSummary, url.href);
  }
}

// ------------------------------------------------------------------ wiring
async function startAiDemo() {
  els.startDemo.disabled = true;
  setDirectoryStatus('Opening an AI vs AI demo room…', false);
  try {
    const response = await fetch(api('/api/rooms'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ mode: 'demo' })
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(data.error || 'Could not create the AI demo.');
    demoControlToken = data.demoControlToken || '';
    demoControlRoomCode = data.roomCode || '';
    demoControlReady = false;
    if (!demoControlToken || !demoControlRoomCode) throw new Error('The Worker did not return the demo control details.');
    await startWatching(data.roomCode, 'demo', true);
  } catch (error) {
    setDirectoryStatus(error.message || 'Could not open the AI demo.', true);
  } finally {
    if (!els.directory.hidden) els.startDemo.disabled = false;
  }
}
els.refreshRooms.addEventListener('click', loadRooms);
els.startDemo.addEventListener('click', startAiDemo);
els.navBrowse.addEventListener('click', () => showDirectory(true));
els.gameFrame.addEventListener('load', () => {
  if (latestGameFrameMessage) forwardGameFrameMessage(latestGameFrameMessage);
  syncGameFrameMute();
});
window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || event.source !== els.gameFrame.contentWindow) return;
  const message = event.data;
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'shapey-audience-ready') {
    // The iframe may finish loading after the room's first snapshot; resend it now that the
    // embedded receiver exists, so a first room-open never remains on the loading screen.
    if (latestGameFrameMessage) forwardGameFrameMessage(latestGameFrameMessage);
    syncGameFrameMute();
  } else if (message.type === 'shapey-game-ready') {
    els.watch.classList.add('game-ready');
  } else if (message.type === 'shapey-audience-socket-send' &&
             message.data && typeof message.data.type === 'string') {
    sendSocketMessage(message.data);
  }
});
els.modeChips.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  modeFilterValue = chip.dataset.mode;
  renderRooms();
});
els.statusFilter.addEventListener('change', () => { statusFilterValue = els.statusFilter.value; renderRooms(); });
els.btnChat.addEventListener('click', () => openChatPage());
els.backToGame.addEventListener('click', () => {
  if (window.location.hash === '#chat') window.history.back();
  else closeChatPage(false);
});
els.btnPolls.addEventListener('click', () => openPanel('polls'));
els.btnSettings.addEventListener('click', () => openPanel('settings'));
els.muteAudienceSound.checked = soundMuted;
els.muteAudienceSound.addEventListener('change', () => {
  soundMuted = els.muteAudienceSound.checked;
  try { localStorage.setItem('shapey-audience-muted', String(soundMuted)); } catch (_) {}
  syncGameFrameMute();
  if (!soundMuted) playAudienceTone(520);
});
['closePoll', 'closeSettings', 'resumeWatch'].forEach((id) => $(id).addEventListener('click', closePanels));
els.endDemo.addEventListener('click', () => {
  if (activeMode !== 'demo' || demoControlRoomCode !== activeRoomCode || !demoControlReady) return;
  sendSocketMessage({ type: 'end_demo' });
});
els.backdrop.addEventListener('click', closePanels);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (chatPageOpen) {
    if (window.location.hash === '#chat') window.history.back();
    else closeChatPage(false);
  } else if (activePanel) closePanels();
});
$('backToDirectory').addEventListener('click', () => showDirectory(true));
els.shareRoom.addEventListener('click', shareWatchLink);
els.retryConnection.addEventListener('click', () => {
  els.retryConnection.disabled = true;
  startWatching(activeRoomCode, activeMode, false);
});
els.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = els.chatInput.value.trim();
  if (!value) return;
  if (sendSocketMessage({ type: 'chat', text: value })) {
    els.chatInput.value = '';
    text(els.chatStatus, '');
  }
});
window.addEventListener('popstate', () => {
  if (chatPageOpen) { closeChatPage(false); return; }
  const params = new URLSearchParams(window.location.search);
  const code = params.get('room');
  if (code) startWatching(code, params.get('mode') || '', false);
  else showDirectory(false);
});
refreshTimer = window.setInterval(() => {
  if (!els.directory.hidden && !document.hidden) loadRooms();
}, 20_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !els.directory.hidden) loadRooms();
});
turnTimer = window.setInterval(() => {
  updateHud();
  if (!currentPoll) return;
  updatePollIntro();
  if (!currentPoll.closed && pollSecondsLeft(currentPoll) === 0 && pollLockedId !== currentPoll.id) {
    pollLockedId = currentPoll.id;
    renderPoll(currentPoll); // voting time is over: lock the buttons
  }
  updateBadges();
}, 250);
const initialParams = new URLSearchParams(window.location.search);
if (initialParams.get('room')) {
  startWatching(initialParams.get('room'), initialParams.get('mode') || '', false);
  if (window.location.hash === '#chat') openChatPage(false);
} else loadRooms();