'use strict';

const MULTIPLAYER_API = 'https://shapey-multiplayer-staging.hellohuman100.workers.dev';
const SHAPE_FILES = {
  mystery: 'Mystery.webp', dummy: 'dummy.webp', hazard: 'hazard.webp', cancel: 'cancel.webp',
  capsule: 'capsule.webp', circle: 'circle.webp', cross: 'cross.webp', divide: 'divide.webp',
  corner: 'four corner.webp', marked: 'marked.webp', pointer: 'shield.webp', shield: 'pointer.webp',
  sphere: 'sphere.webp', square: 'square.webp', star: 'star .webp', x: 'x.webp'
};
const $ = (id) => document.getElementById(id);
const els = {
  directory: $('directoryView'), watch: $('watchView'), rooms: $('roomCards'), directoryStatus: $('directoryStatus'),
  modeChips: $('modeChips'), statusFilter: $('statusFilter'), refreshRooms: $('refreshRooms'),
  watchTitle: $('watchTitle'), watchStatus: $('watchStatus'), turnStatus: $('turnStatus'), turnClock: $('turnClock'),
  scoreCards: $('scoreCards'), board: $('board'), boardFootnote: $('boardFootnote'), roomSummary: $('roomSummary'),
  playersList: $('playersList'), pollIntro: $('pollIntro'), pollOptions: $('pollOptions'), chatMessages: $('chatMessages'),
  chatStatus: $('chatStatus'), chatForm: $('chatForm'), chatInput: $('chatInput'), sendChat: $('sendChat'),
  connectionActions: $('connectionActions'), retryConnection: $('retryConnection'), shareRoom: $('shareRoom'),
  startDemo: $('startDemo'), bottomNav: $('audienceBottomNav'), pollPanel: $('audiencePollPanel'), chatPanel: $('audienceChatPanel'),
  settingsPanel: $('audienceSettingsPanel'), muteSound: $('muteAudienceSound'), settingsStatus: $('settingsStatus'), leaveRoom: $('leaveRoom'),
  navPolls: $('navPolls'), navChat: $('navChat'), navSettings: $('navSettings')
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
let chatIds = new Set();
let tileNodes = new Map();
let explicitLeave = false;
let refreshTimer = null;
let turnTimer = null;
let modeFilterValue = 'all';
let watchToken = 0;      // bumps whenever the viewer opens or leaves a room, so a slow connect can tell it is stale
let roomsCache = [];
let roomsLoadedAt = null;
let roomsLoadSeq = 0;    // only the newest room-list request may update the screen
let pollLockedId = null;
let demoControlToken = '';
let demoControlRoomCode = '';
let demoControlReady = false;
let openAudiencePanel = '';
let audienceAudio = null;
let soundMuted = localStorage.getItem('shapey-audience-muted') === 'true';

function api(path) { return MULTIPLAYER_API + path; }
function playAudienceTone(frequency = 620) {
  if (soundMuted) return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audienceAudio) audienceAudio = new AudioContextClass();
    if (audienceAudio.state === 'suspended') audienceAudio.resume();
    const oscillator = audienceAudio.createOscillator();
    const gain = audienceAudio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.035, audienceAudio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audienceAudio.currentTime + 0.12);
    oscillator.connect(gain);
    gain.connect(audienceAudio.destination);
    oscillator.start();
    oscillator.stop(audienceAudio.currentTime + 0.12);
  } catch (_) {}
}
function closeAudiencePanel() {
  openAudiencePanel = '';
  [els.pollPanel, els.chatPanel, els.settingsPanel].forEach((panel) => { panel.hidden = true; });
  [els.navPolls, els.navChat, els.navSettings].forEach((button) => button.setAttribute('aria-pressed', 'false'));
}
function toggleAudiencePanel(name) {
  if (openAudiencePanel === name) { closeAudiencePanel(); return; }
  closeAudiencePanel();
  openAudiencePanel = name;
  const panel = name === 'polls' ? els.pollPanel : name === 'chat' ? els.chatPanel : els.settingsPanel;
  const button = name === 'polls' ? els.navPolls : name === 'chat' ? els.navChat : els.navSettings;
  panel.hidden = false;
  button.setAttribute('aria-pressed', 'true');
  if (name === 'chat') els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  if (name === 'settings') updateSettingsPanel();
}
function updateSettingsPanel() {
  if (!els.leaveRoom) return;
  const ownsDemo = activeMode === 'demo' && demoControlRoomCode === activeRoomCode && Boolean(demoControlToken);
  text(els.leaveRoom, ownsDemo ? 'End AI demo' : 'Leave room');
  els.leaveRoom.classList.toggle('end-demo', ownsDemo);
  els.leaveRoom.disabled = ownsDemo && !demoControlReady;
  if (ownsDemo) text(els.settingsStatus, demoControlReady
    ? 'You opened this demo. End it here when you have finished watching.'
    : 'Connecting your demo controls…');
  else if (activeMode === 'demo') text(els.settingsStatus, 'You are watching this demo. Only its creator can end the shared room.');
  else text(els.settingsStatus, 'Mute audience sounds or leave this room. You cannot make game moves.');
}
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
    if (!response.ok) throw new Error(data.error || 'Could not create the AI demo. The staging Worker may need its update.');
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
function directoryUrl() { return new URL('staging/audience.html', document.baseURI); }
function shapeUrl(shape) {
  const file = SHAPE_FILES[shape] || SHAPE_FILES.mystery;
  return new URL('assets/shapes/' + encodeURIComponent(file), document.baseURI).href;
}
function text(el, value) { el.textContent = value == null ? '' : String(value); }
function modeName(mode) { return mode === 'demo' ? 'AI vs AI Demo' : mode === 'tag' ? 'Tag · 2 vs 2' : 'Player 1 vs Player 2'; }
function statusName(status) {
  return ({ live: 'Live', starting: 'Starting', ready: 'Ready', waiting: 'Waiting' })[status] || status || 'Unknown';
}
function setDirectoryStatus(message, isError) {
  text(els.directoryStatus, message);
  els.directoryStatus.classList.toggle('error', Boolean(isError));
}
function setWatchStatus(message, isError) {
  text(els.watchStatus, message);
  els.watchStatus.classList.toggle('error', Boolean(isError));
}
function closeSocket() {
  if (roomSocket) {
    const old = roomSocket;
    roomSocket = null;
    try { old.close(1000, 'Audience left room'); } catch (_) {}
  }
}
function showDirectory(updateUrl) {
  explicitLeave = true;
  watchToken++;
  closeSocket();
  activeRoomCode = '';
  activeMode = '';
  currentState = null;
  currentPoll = null;
  currentVote = null;
  tileNodes.forEach((node) => node.remove());
  tileNodes.clear();
  els.board.replaceChildren();
  els.pollOptions.replaceChildren();
  els.chatMessages.replaceChildren();
  chatIds = new Set();
  els.directory.hidden = false;
  els.watch.hidden = true;
  els.bottomNav.hidden = true;
  closeAudiencePanel();
  els.connectionActions.hidden = true;
  if (updateUrl) {
    const url = directoryUrl();
    window.history.pushState({}, '', url.pathname);
  }
  loadRooms();
}
function enterWatchView(code) {
  els.directory.hidden = true;
  els.watch.hidden = false;
  els.connectionActions.hidden = true;
  const url = directoryUrl();
  url.searchParams.set('room', code);
  if (activeMode) url.searchParams.set('mode', activeMode);
  window.history.pushState({}, '', url.pathname + url.search);
}
function makePill(status) {
  const span = document.createElement('span');
  span.className = 'pill' + (status === 'live' ? ' live' : '');
  text(span, statusName(status));
  return span;
}
function makeRoomCard(room) {
  const article = document.createElement('article');
  article.className = 'panel room-card';
  const heading = document.createElement('div');
  heading.className = 'card-heading';
  const title = document.createElement('h3');
  text(title, modeName(room.mode));
  const badges = document.createElement('div');
  badges.className = 'badges';
  const badge = document.createElement('span');
  badge.className = 'mode-badge ' + (room.mode === 'tag' ? 'tag' : room.mode === 'demo' ? 'demo' : 'pvp');
  text(badge, room.mode === 'tag' ? 'Tag' : room.mode === 'demo' ? 'AI vs AI' : '1 vs 1');
  badges.append(badge, makePill(room.status));
  heading.append(title, badges);
  article.append(heading);

  const meta = document.createElement('div');
  meta.className = 'room-meta';
  const players = document.createElement('div');
  text(players, room.mode === 'demo' ? 'Automated players: AI 1 vs AI 2' : 'Players connected: ' + (Number(room.playerCount) || 0) + ' / ' + (Number(room.maxPlayers) || (room.mode === 'tag' ? 4 : 2)));
  meta.append(players);
  const spectators = document.createElement('div');
  text(spectators, 'Watching: ' + (Number(room.spectatorCount) || 0));
  meta.append(spectators);
  const score = document.createElement('div');
  score.className = 'room-score';
  const scores = Array.isArray(room.scores) ? room.scores : [0, 0];
  text(score, (room.mode === 'tag' ? 'Team A ' : room.mode === 'demo' ? 'AI 1 ' : 'P1 ') + (Number(scores[0]) || 0) + '  —  ' +
    (room.mode === 'tag' ? 'Team B ' : room.mode === 'demo' ? 'AI 2 ' : 'P2 ') + (Number(scores[1]) || 0));
  meta.append(score);
  const target = document.createElement('div');
  const targetScore = Number(room.targetScore) || (room.mode === 'tag' ? 200 : 100);
  const sideNames = room.mode === 'tag' ? ['Team A', 'Team B'] : ['Player 1', 'Player 2'];
  const turnSide = room.activePlayerNumber ? (room.mode === 'tag' ? (room.activePlayerNumber <= 2 ? 0 : 1) : room.activePlayerNumber - 1) : -1;
  const details = ['First to ' + targetScore];
  if (room.status === 'live' && turnSide >= 0) details.push(sideNames[turnSide] + ' to play');
  if (Number.isFinite(room.createdAt)) {
    const minutes = Math.max(0, Math.floor((Date.now() - room.createdAt) / 60000));
    details.push(minutes < 1 ? 'just started' : 'open ' + minutes + ' min');
  }
  text(target, details.join(' · '));
  meta.append(target);
  article.append(meta);

  const bottom = document.createElement('div');
  bottom.className = 'card-bottom';
  const code = document.createElement('span');
  code.className = 'pill';
  text(code, 'Room ' + room.roomCode);
  const watch = document.createElement('button');
  watch.type = 'button';
  text(watch, 'Watch game');
  watch.addEventListener('click', () => startWatching(room.roomCode, room.mode, true));
  bottom.append(code, watch);
  article.append(bottom);
  return article;
}
function updateModeChips(rooms) {
  const counts = { all: rooms.length, tag: 0, pvp: 0, demo: 0 };
  rooms.forEach((room) => { if (counts[room.mode] != null) counts[room.mode]++; });
  const names = { all: 'All', tag: 'Tag · 2 vs 2', pvp: '1 vs 1', demo: 'AI vs AI' };
  els.modeChips.querySelectorAll('.chip').forEach((chip) => {
    const mode = chip.dataset.mode;
    const active = mode === modeFilterValue;
    chip.classList.toggle('is-active', active);
    chip.setAttribute('aria-pressed', String(active));
    text(chip, names[mode] + ' (' + counts[mode] + ')');
  });
}
function renderRooms() {
  if (!roomsLoadedAt) return;
  const statusFilter = els.statusFilter.value;
  const byStatus = roomsCache.filter((room) => {
    if (statusFilter === 'live' && room.status !== 'live') return false;
    if (statusFilter === 'waiting' && !['waiting', 'ready', 'starting'].includes(room.status)) return false;
    return true;
  });
  updateModeChips(byStatus);
  const rank = { live: 0, starting: 1, ready: 2, waiting: 3 };
  const filtered = byStatus
    .filter((room) => modeFilterValue === 'all' || room.mode === modeFilterValue)
    .sort((a, b) => (rank[a.status] ?? 4) - (rank[b.status] ?? 4) || (Number(b.spectatorCount) || 0) - (Number(a.spectatorCount) || 0));
  els.rooms.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'notice';
    text(empty, roomsCache.length ? 'No rooms match those filters. Try "All available rooms" to include games that have not started.' : 'No public rooms are active right now. Refresh in a little while, or create a room from the Shapey game page.');
    els.rooms.append(empty);
  } else {
    filtered.forEach((room) => els.rooms.append(makeRoomCard(room)));
  }
  const noun = filtered.length === 1 ? 'room' : 'rooms';
  setDirectoryStatus(filtered.length + ' ' + noun + ' available · updated ' + roomsLoadedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), false);
}
async function loadRooms() {
  const seq = ++roomsLoadSeq;
  setDirectoryStatus('Refreshing the public room list…', false);
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
    els.rooms.replaceChildren();
    const message = document.createElement('p');
    message.className = 'notice danger';
    text(message, error.message || 'The live directory is unavailable. Please retry.');
    els.rooms.append(message);
    setDirectoryStatus('Could not load live games. The staging Worker may need its latest update.', true);
  } finally {
    if (seq === roomsLoadSeq) els.refreshRooms.disabled = false;
  }
}
function sendSocketMessage(message) {
  if (!roomSocket || roomSocket.readyState !== WebSocket.OPEN) {
    setWatchStatus('Not connected to the room. Reconnect to continue watching.', true);
    return false;
  }
  roomSocket.send(JSON.stringify(message));
  return true;
}
function renderScores(state) {
  els.scoreCards.replaceChildren();
  const labels = state.mode === 'tag' ? ['Team A · Players 1 + 2', 'Team B · Players 3 + 4'] : state.mode === 'demo' ? ['AI 1', 'AI 2'] : ['Player 1', 'Player 2'];
  const scores = Array.isArray(state.scores) ? state.scores : [0, 0];
  for (let i = 0; i < 2; i++) {
    const card = document.createElement('div');
    card.className = 'score-card';
    const label = document.createElement('span');
    label.className = 'label';
    text(label, labels[i]);
    const value = document.createElement('strong');
    text(value, Number(scores[i]) || 0);
    card.append(label, value);
    els.scoreCards.append(card);
  }
}
function renderPlayers() {
  els.playersList.replaceChildren();
  const max = activeMode === 'tag' ? 4 : 2;
  const connected = new Set((roomPlayers || []).filter((p) => p && p.connected).map((p) => p.playerNumber));
  for (let number = 1; number <= max; number++) {
    const row = document.createElement('div');
    row.className = 'player-row';
    const name = document.createElement('span');
    text(name, activeMode === 'demo' ? 'AI ' + number : 'Player ' + number + (activeMode === 'tag' ? (number === 1 || number === 2 ? ' · Team A' : ' · Team B') : ''));
    const status = document.createElement('span');
    status.className = 'notice';
    const dot = document.createElement('i');
    dot.className = connected.has(number) ? 'online-dot' : 'online-dot offline-dot';
    status.append(dot, document.createTextNode(activeMode === 'demo' ? (currentState && currentState.activePlayerNumber === number ? 'Taking turn' : 'Ready') : connected.has(number) ? 'Connected' : 'Waiting'));
    row.append(name, status);
    els.playersList.append(row);
  }
  text(els.roomSummary, modeName(activeMode) + ' · Room ' + activeRoomCode + ' · ' + statusName(roomStatus) + ' · ' + roomSpectators + ' watching');
}
function renderBoard(state) {
  if (!state || !Array.isArray(state.tiles)) {
    els.board.replaceChildren();
    tileNodes.clear();
    return;
  }
  const keep = new Set();
  for (const tileData of state.tiles) {
    if (!Number.isInteger(tileData.row) || !Number.isInteger(tileData.col)) continue;
    keep.add(tileData.id);
    let tile = tileNodes.get(tileData.id);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'tile';
      const image = document.createElement('img');
      image.draggable = false;
      tile.append(image);
      els.board.append(tile);
      tileNodes.set(tileData.id, tile);
    }
    tile.style.left = (tileData.col * 100 / 7) + '%';
    tile.style.top = (tileData.row * 100 / 7) + '%';
    tile.classList.toggle('is-moving', Boolean(tileData.moving));
    tile.classList.toggle('is-selected', Boolean(tileData.selected));
    const image = tile.firstElementChild;
    const visibleShape = tileData.faceUp && tileData.shape ? tileData.shape : 'mystery';
    const url = shapeUrl(visibleShape);
    if (image.src !== url) image.src = url;
    image.alt = tileData.faceUp && tileData.shape ? tileData.shape : 'Hidden tile';
    tile.setAttribute('aria-label', image.alt + (tileData.moving ? ', shuffling' : ''));
    tile.style.zIndex = tileData.moving ? '4' : (tileData.selected ? '3' : '1');
  }
  for (const [id, node] of tileNodes.entries()) {
    if (!keep.has(id)) {
      node.remove();
      tileNodes.delete(id);
    }
  }
}
function updateTurnClock() {
  if (!currentState || currentState.status !== 'playing' || !Number.isFinite(currentState.turnEndsAt)) {
    text(els.turnClock, currentState && currentState.status === 'study' ? 'Opening board' : 'Turn clock —');
    return;
  }
  const seconds = Math.max(0, Math.ceil((currentState.turnEndsAt - Date.now()) / 1000));
  text(els.turnClock, 'Turn ' + String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0'));
}
function renderGameState(state) {
  if (!state) return;
  const previousState = currentState;
  currentState = state;
  if (previousState && Array.isArray(previousState.scores) && Array.isArray(state.scores) &&
      state.scores.some((score, index) => score !== previousState.scores[index])) playAudienceTone(760);
  else if (previousState && previousState.activePlayerNumber !== state.activePlayerNumber) playAudienceTone(480);
  activeMode = state.mode || activeMode;
  renderBoard(state);
  renderScores(state);
  const status = state.status;
  if (status === 'study') {
    text(els.turnStatus, activeMode === 'demo' ? 'AI 1 and AI 2 are studying the board' : 'Opening board · memorise the shapes');
    text(els.boardFootnote, 'The opening board is intentionally revealed for study. After it closes, hidden shapes stay hidden. Blue square outlines mark tiles currently shuffling.');
  } else if (status === 'playing') {
    text(els.turnStatus, activeMode === 'demo' ? 'AI ' + state.activePlayerNumber + ' is choosing shapes' : 'Player ' + state.activePlayerNumber + (state.isBonusTurn ? ' · Double Play' : '') + ' has the turn');
    text(els.boardFootnote, 'Read-only audience board. Hidden shapes stay hidden. Blue square outlines mark tiles currently shuffling.');
  } else if (status === 'finished') {
    text(els.turnStatus, 'Game finished' + (activeMode === 'demo' && Number.isInteger(state.winnerPlayerNumber) ? ' · AI ' + state.winnerPlayerNumber + ' won' : Number.isInteger(state.winnerPlayerNumber) ? ' · Player ' + state.winnerPlayerNumber + ' won' :
      (Number.isInteger(state.winnerSide) ? ' · Team ' + (state.winnerSide === 0 ? 'A' : 'B') + ' won' : '')));
    text(els.boardFootnote, 'Final board and scores. The room is no longer listed as live.');
  } else {
    text(els.turnStatus, 'Waiting for players');
  }
  updateTurnClock();
}
function appendChat(message) {
  if (!message || typeof message.text !== 'string') return;
  if (message.id && chatIds.has(message.id)) return;
  if (message.id) chatIds.add(message.id);
  const item = document.createElement('div');
  item.className = 'chat-message';
  const sender = document.createElement('strong');
  text(sender, message.sender || 'Audience');
  const time = document.createElement('span');
  time.className = 'chat-time';
  const timestamp = message.createdAt || message.at;
  if (timestamp) {
    const date = new Date(timestamp);
    text(time, date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  }
  const body = document.createElement('span');
  text(body, message.text);
  item.append(sender, time, document.createElement('br'), body);
  els.chatMessages.append(item);
  while (els.chatMessages.children.length > 100) els.chatMessages.firstElementChild.remove();
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}
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
    const votes = Number(poll.totalVotes) || 0;
    text(els.pollIntro, votes ? 'Poll closed · ' + votes + ' vote' + (votes === 1 ? '' : 's') + ' · the audience result is shown below'
      : 'Poll closed · no votes were cast');
  } else if (pollSecondsLeft(poll) > 0) {
    text(els.pollIntro, 'Ask the Audience · ' + pollSecondsLeft(poll) + 's left to vote · results are revealed when voting ends');
  } else {
    text(els.pollIntro, 'Voting has ended · counting the votes…');
  }
}
// Like the TV lifeline, spectators vote without seeing the running tally; percentages appear once voting closes.
function renderPoll(poll) {
  if (!poll || (currentPoll && currentPoll.id !== poll.id)) currentVote = null;
  currentPoll = poll || null;
  els.pollOptions.replaceChildren();
  if (!poll) {
    text(els.pollIntro, activeMode === 'tag'
      ? 'No poll is open. Tag players can open a poll during their turn; spectators can then vote.'
      : activeMode === 'demo' ? 'AI vs AI demos do not open audience polls. Watch a real Tag room to vote when a player asks the audience.'
      : 'Audience polls are available in Tag games only.');
    return;
  }
  updatePollIntro();
  const options = poll.options || [];
  const counts = options.map((option) => Number(poll.counts && poll.counts[option]) || 0);
  const percents = percentSplit(counts);
  const best = Math.max(0, ...counts);
  const open = pollIsOpen(poll) && roomSocket && roomSocket.readyState === WebSocket.OPEN;
  options.forEach((option, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'poll-option' + (currentVote === option ? ' chosen' : '') +
      (poll.closed && best > 0 && counts[index] === best ? ' winner' : '');
    button.disabled = !open;
    const img = document.createElement('img');
    img.src = shapeUrl(option);
    img.alt = '';
    const copy = document.createElement('span');
    copy.className = 'option-copy';
    text(copy, String.fromCharCode(65 + index) + ' · ' + option.replace(/-/g, ' '));
    const count = document.createElement('span');
    count.className = 'vote-count';
    text(count, poll.closed ? percents[index] + '%' : (currentVote === option ? 'Your vote' : ''));
    button.append(img, copy, count);
    button.addEventListener('click', () => {
      if (!pollIsOpen(currentPoll)) return;
      if (sendSocketMessage({ type: 'poll_vote', shape: option })) {
        currentVote = option;
        renderPoll(currentPoll);
      }
    });
    els.pollOptions.append(button);
  });
}
function processMessage(message) {
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'spectator_welcome') {
    roomStatus = message.status || 'waiting';
    roomPlayers = message.players || [];
    els.bottomNav.hidden = false;
    if (demoControlToken && activeRoomCode === demoControlRoomCode) sendSocketMessage({ type: 'demo_control', token: demoControlToken });
    updateSettingsPanel();
    roomSpectators = Number(message.spectatorCount) || 0;
    renderPlayers();
    if (message.state) renderGameState(message.state);
    else {
      text(els.turnStatus, 'Waiting for all players to join…');
      text(els.boardFootnote, 'The board will appear when the match starts. You are watching as an audience member.');
    }
    (message.chatHistory || []).forEach(appendChat);
    renderPoll(message.poll);
    setWatchStatus('Connected as spectator. You can watch, chat and vote in an open poll.', false);
    els.chatStatus.textContent = 'Connected to room chat.';
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
    appendChat(message.message);
    return;
  }
  if (message.type === 'audience_poll_state') {
    renderPoll(message.poll || null);
    return;
  }
  if (message.type === 'demo_control_ready') {
    demoControlReady = true;
    updateSettingsPanel();
    return;
  }
  if (message.type === 'demo_ended') {
    demoControlReady = false;
    setWatchStatus(message.message || 'The AI demo has ended.', false);
    window.setTimeout(() => showDirectory(true), 900);
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
    setDirectoryStatus('That room code is not valid.', true);
    showDirectory(false);
    return;
  }
  explicitLeave = false;
  if (demoControlRoomCode !== code) { demoControlToken = ''; demoControlReady = false; demoControlRoomCode = ''; }
  const token = ++watchToken;
  closeSocket();
  activeRoomCode = code;
  activeMode = hintedMode || '';
  currentState = null;
  currentPoll = null;
  currentVote = null;
  chatIds = new Set();
  tileNodes.forEach((node) => node.remove());
  tileNodes.clear();
  els.board.replaceChildren();
  els.chatMessages.replaceChildren();
  els.pollOptions.replaceChildren();
  els.chatStatus.textContent = '';
  els.boardFootnote.textContent = 'Connecting to the room. The board is read-only and hidden shapes are not sent to spectators.';
  els.watchTitle.textContent = 'Room ' + code;
  els.turnStatus.textContent = 'Connecting to the room…';
  els.roomSummary.textContent = 'Loading room details…';
  setWatchStatus('Connecting as spectator…', false);
  els.directory.hidden = true;
  els.watch.hidden = false;
  els.bottomNav.hidden = false;
  els.connectionActions.hidden = true;
  closeAudiencePanel();
  if (pushUrl) enterWatchView(code);
  try {
    const roomResponse = await fetch(api('/api/rooms/' + code), { cache: 'no-store' });
    const details = await roomResponse.json();
    if (token !== watchToken) return; // the viewer left or opened another room while this was loading
    if (!roomResponse.ok) throw new Error(details.error || 'Room not found.');
    if (!activeMode) activeMode = details.mode;
    if (details.mode !== activeMode) throw new Error('The shared link has a different game mode. Please open the room again from the directory.');
    els.watchTitle.textContent = modeName(activeMode) + ' · Room ' + code;
    updateSettingsPanel();
    roomStatus = details.status || 'waiting';
    roomPlayers = details.players || [];
    renderPlayers();
    const wsBase = MULTIPLAYER_API.replace(/^http/, 'ws');
    const socket = new WebSocket(wsBase + '/ws/' + code + '?mode=' + encodeURIComponent(activeMode) + '&role=spectator');
    roomSocket = socket;
    socket.addEventListener('open', () => {
      if (roomSocket === socket) sendSocketMessage({ type: 'spectate' });
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
      els.connectionActions.hidden = false;
      els.retryConnection.disabled = false;
      if (!explicitLeave) setWatchStatus('Disconnected from the room. Reconnect to continue watching.', true);
      if (currentPoll && !currentPoll.closed) renderPoll(currentPoll);
    });
  } catch (error) {
    if (token !== watchToken) return;
    setWatchStatus(error.message || 'Could not open this room.', true);
    els.connectionActions.hidden = false;
    els.retryConnection.disabled = false;
    text(els.roomSummary, 'This room is no longer available in the staging service.');
  }
}
async function shareWatchLink() {
  if (!activeRoomCode) return;
  const url = directoryUrl();
  url.searchParams.set('room', activeRoomCode);
  url.searchParams.set('mode', activeMode);
  try {
    await navigator.clipboard.writeText(url.href);
    setWatchStatus('Watch link copied to clipboard.', false);
  } catch (_) {
    const field = document.createElement('input');
    field.value = url.href;
    field.readOnly = true;
    document.body.append(field);
    field.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (_) {}
    field.remove();
    setWatchStatus(copied ? 'Watch link copied to clipboard.' : url.href, !copied);
  }
}
els.refreshRooms.addEventListener('click', loadRooms);
els.startDemo.addEventListener('click', startAiDemo);
els.navPolls.addEventListener('click', () => toggleAudiencePanel('polls'));
els.navChat.addEventListener('click', () => toggleAudiencePanel('chat'));
els.navSettings.addEventListener('click', () => toggleAudiencePanel('settings'));
document.querySelectorAll('[data-close-panel]').forEach((button) => button.addEventListener('click', closeAudiencePanel));
els.muteSound.checked = soundMuted;
els.muteSound.addEventListener('change', () => {
  soundMuted = els.muteSound.checked;
  try { localStorage.setItem('shapey-audience-muted', String(soundMuted)); } catch (_) {}
  if (!soundMuted) playAudienceTone(520);
});
els.leaveRoom.addEventListener('click', () => {
  if (activeMode === 'demo' && demoControlRoomCode === activeRoomCode && demoControlToken) {
    if (!demoControlReady) { text(els.settingsStatus, 'Connecting demo controls… please try again in a moment.'); return; }
    sendSocketMessage({ type: 'end_demo' });
    text(els.settingsStatus, 'Ending the AI demo…');
    els.leaveRoom.disabled = true;
    return;
  }
  showDirectory(true);
});
els.modeChips.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  modeFilterValue = chip.dataset.mode;
  renderRooms();
});
els.statusFilter.addEventListener('change', renderRooms);
$('navBrowse').addEventListener('click', () => showDirectory(true));
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
    text(els.chatStatus, 'Message sent.');
  }
});
window.addEventListener('popstate', () => {
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
  updateTurnClock();
  if (!currentPoll) return;
  updatePollIntro();
  if (!currentPoll.closed && pollSecondsLeft(currentPoll) === 0 && pollLockedId !== currentPoll.id) {
    pollLockedId = currentPoll.id;
    renderPoll(currentPoll); // voting time is over: lock the buttons
  }
}, 250);
const initialParams = new URLSearchParams(window.location.search);
if (initialParams.get('room')) startWatching(initialParams.get('room'), initialParams.get('mode') || '', false);
else loadRooms();