// Shapey audience page - watching a room: the WebSocket lifecycle, message
// processing, the game-state renderer entry and the AI-demo launcher.


// ------------------------------------------------------------------ views

import { API_OVERRIDDEN, MULTIPLAYER_API, els, serverClock, state } from './state.js';
import { api, directoryUrl, playerWord, text, turnLabel } from './util.js';
import { appendChat, ensureChatEmpty } from './chat.js';
import { renderBoard, renderScores, updateBoardPollHint, updateHud } from './board.js';
import { renderPoll } from './polls.js';
import { applyModeUI, closeChatPage, closePanels, forwardGameFrameMessage, playAudienceTone, renderPlayers, sendSocketMessage, setDirectoryStatus, setWatchStatus, showToast, syncGameFrameMute, updateVeil } from './ui.js';
import { enterWatchView, showDirectory } from './directory.js';

function clearSocketTimers() {
  if (state.keepaliveTimer !== null) {
    window.clearInterval(state.keepaliveTimer);
    state.keepaliveTimer = null;
  }
  if (state.reconnectTimer !== null) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

export function closeSocket() {
  clearSocketTimers();
  if (state.roomSocket) {
    const old = state.roomSocket;
    state.roomSocket = null;
    try { old.close(1000, 'Audience left room'); } catch (_) {}
  }
}

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 12000, 15000];

function scheduleRoomReconnect(code, token) {
  if (state.explicitLeave || token !== state.watchToken || state.reconnectTimer !== null) return;
  if (state.reconnectAttempts >= RECONNECT_DELAYS_MS.length) {
    state.connectionLost = true;
    setWatchStatus('Connection is still unavailable. Tap RETRY to try again.', true);
    return;
  }
  const delay = RECONNECT_DELAYS_MS[state.reconnectAttempts++];
  state.connectionLost = true;
  setWatchStatus('Connection interrupted. Reconnecting…', true);
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    if (state.explicitLeave || token !== state.watchToken) return;
    connectRoomSocket(code, token);
  }, delay);
}

function connectRoomSocket(code, token) {
  if (state.explicitLeave || token !== state.watchToken) return;
  const wsBase = MULTIPLAYER_API.replace(/^http/, 'ws');
  let socket;
  try {
    socket = new WebSocket(wsBase + '/ws/' + code + '?mode=' + encodeURIComponent(state.activeMode) + '&role=spectator');
  } catch (_) {
    scheduleRoomReconnect(code, token);
    return;
  }
  state.roomSocket = socket;

  socket.addEventListener('open', () => {
    if (state.roomSocket !== socket || token !== state.watchToken) return;
    try { socket.send(JSON.stringify({ type: 'spectate' })); } catch (_) {}
    if (state.demoControlToken && state.demoControlRoomCode === code) {
      try { socket.send(JSON.stringify({ type: 'demo_control', token: state.demoControlToken })); } catch (_) {}
    }
    if (state.keepaliveTimer !== null) window.clearInterval(state.keepaliveTimer);
    // A quiet 30-second audience poll can outlast a mobile connection's idle timeout.
    // The Worker accepts ping messages and replies with pong without changing game state.
    state.keepaliveTimer = window.setInterval(() => {
      if (state.roomSocket !== socket || socket.readyState !== WebSocket.OPEN) return;
      try { socket.send('ping'); }
      catch (_) { try { socket.close(); } catch (_) {} }
    }, 12000);
  });

  socket.addEventListener('message', (event) => {
    if (state.roomSocket !== socket) return;
    const receivedAt = Date.now();
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    processMessage(message, receivedAt);
  });

  socket.addEventListener('error', () => {
    if (state.roomSocket !== socket) return;
    state.connectionLost = true;
    setWatchStatus('Connection interrupted. Reconnecting…', true);
  });

  socket.addEventListener('close', (event) => {
    if (state.roomSocket !== socket) return;
    state.roomSocket = null;
    if (state.keepaliveTimer !== null) {
      window.clearInterval(state.keepaliveTimer);
      state.keepaliveTimer = null;
    }
    if (state.explicitLeave || token !== state.watchToken) {
      updateVeil();
      return;
    }
    state.connectionLost = true;
    const reason = String(event.reason || '');
    // The Worker uses 4000 for a room that has ended or expired; do not retry a closed room forever.
    if (event.code === 4000 || /room expired|AI vs AI demo (?:ended|finished)/i.test(reason)) {
      setWatchStatus(reason || 'This room has ended. Return to Live Games to watch another room.', true);
      return;
    }
    scheduleRoomReconnect(code, token);
  });
}

export function resetRoomView() {
  if (state.chatPageOpen) closeChatPage(false);
  els.chatPage.hidden = true;
  document.body.classList.remove('chat-open');
  state.chatPageOpen = false;
  state.currentState = null;
  state.latestGameFrameMessage = null;
  state.currentPoll = null;
  state.currentVote = null;
  state.pollAcceptedId = '';
  state.pollDeclinedId = '';
  state.lastTurnKey = null;
  state.unreadChat = 0;
  state.pollLockedId = null;
  state.connectionLost = false;
  state.statusMessage = '';
  state.statusIsError = false;
  state.tileNodes.forEach((node) => node.remove());
  state.tileNodes.clear();
  els.board.replaceChildren();
  if (els.boardFootnote) { els.boardFootnote.hidden = true; text(els.boardFootnote, ''); }
  if (els.gameFrame) { els.gameFrame.hidden = true; els.gameFrame.src = 'about:blank'; }
  els.watch.classList.remove('has-game-frame', 'game-ready');
  els.pollOptions.replaceChildren();
  els.chatMessages.replaceChildren();
  state.chatIds = new Set();
  text(els.chatStatus, '');
  showToast('', 0, false);
  closePanels();
}

// ------------------------------------------------------------------ in-room rendering

export function renderGameState(snapshot, receivedAt = null) {
  if (!snapshot) return;
  const previousState = state.currentState;
  state.currentState = snapshot;
  state.activeMode = snapshot.mode || state.activeMode;
  state.connectionLost = false;
  // Deadlines are server timestamps: measure the skew from serverNow on every FRESH snapshot
  // (receivedAt is captured on arrival; replays would measure the snapshot's age as skew).
  if (receivedAt !== null && Number.isFinite(Number(snapshot.serverNow))) {
    serverClock.update(Number(snapshot.serverNow), receivedAt);
  }
  applyModeUI();
  renderBoard(snapshot, previousState, Boolean(previousState));
  renderScores(snapshot);
  updateHud();
  if (snapshot.status === 'playing') {
    const key = snapshot.turnIndex + ':' + snapshot.activePlayerNumber + ':' + Boolean(snapshot.isBonusTurn);
    if (state.lastTurnKey !== null && key !== state.lastTurnKey) {
      showToast((snapshot.isBonusTurn ? 'Double Play! ' : '') + turnLabel(snapshot.mode, snapshot.activePlayerNumber) + '’s turn', 2600, false);
    }
    state.lastTurnKey = key;
  } else if (snapshot.status === 'finished') {
    const winner = Number.isInteger(snapshot.winnerPlayerNumber) ? playerWord(snapshot.mode) + ' ' + snapshot.winnerPlayerNumber + ' wins'
      : (Number.isInteger(snapshot.winnerSide) ? 'Team ' + (snapshot.winnerSide + 1) + ' wins' : '');
    showToast('Game over' + (winner ? ' · ' + winner : ''), 0, false);
  }
  updateBoardPollHint();
  updateVeil();
}

// ------------------------------------------------------------------ socket messages
export function processMessage(message, receivedAt = null) {
  if (!message || typeof message.type !== 'string') return;
  forwardGameFrameMessage(message);
  if (message.type === 'demo_control_ready') {
    if (state.activeMode === 'demo' && state.demoControlRoomCode === state.activeRoomCode) { state.demoControlReady = true; renderPlayers(); }
    return;
  }
  if (message.type === 'demo_ended') { showDirectory(true); setDirectoryStatus('The AI-vs-AI demo has ended. Start another demo to keep testing.', false); return; }
  if (message.type === 'spectator_welcome') {
    state.reconnectAttempts = 0;
    if (state.reconnectTimer !== null) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    state.roomStatus = message.status || 'waiting';
    state.roomPlayers = message.players || [];
    state.roomSpectators = Number(message.spectatorCount) || 0;
    state.connectionLost = false;
    setWatchStatus(state.activeMode === 'demo' ? 'Watching the AI-vs-AI demo.' : 'Watching the match.', false);
    if (message.state) renderGameState(message.state, receivedAt);
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
    state.roomStatus = message.state.status === 'playing' ? 'live' : message.state.status === 'finished' ? 'finished' : 'starting';
    renderGameState(message.state, receivedAt);
    renderPlayers();
    return;
  }
  if (message.type === 'room_state') {
    state.roomPlayers = message.players || [];
    state.roomStatus = message.status || state.roomStatus;
    renderPlayers();
    return;
  }
  if (message.type === 'spectator_count') {
    state.roomSpectators = Number(message.count) || 0;
    renderPlayers();
    return;
  }
  if (message.type === 'chat_message' && message.message) {
    appendChat(message.message, true);
    playAudienceTone(620);
    return;
  }
  if (message.type === 'audience_poll_state') {
    const newOpenPoll = message.poll && !message.poll.closed && (!state.currentPoll || state.currentPoll.id !== message.poll.id);
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

export async function startWatching(roomCode, hintedMode, pushUrl) {
  const code = String(roomCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    showDirectory(false);
    setDirectoryStatus('That room code is not valid.', true);
    return;
  }
  state.explicitLeave = false;
  const token = ++state.watchToken;
  closeSocket();
  state.reconnectAttempts = 0;
  state.activeRoomCode = code;
  state.activeMode = hintedMode || '';
  if (state.chatPageOpen) closeChatPage(false);
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
  document.body.classList.add('watching-room');
  if (pushUrl) enterWatchView(code);
  try {
    const roomResponse = await fetch(api('/api/rooms/' + code), { cache: 'no-store' });
    const details = await roomResponse.json();
    if (token !== state.watchToken) return; // the viewer left or opened another room while this was loading
    if (!roomResponse.ok) throw new Error(details.error || 'Room not found.');
    if (!state.activeMode) state.activeMode = details.mode;
    if (details.mode !== state.activeMode) throw new Error('The shared link has a different game mode. Please open the room again from the live games list.');
    applyModeUI();
    state.roomStatus = details.status || 'waiting';
    state.roomPlayers = details.players || [];
    renderPlayers();
    els.gameFrame.hidden = false;
    els.watch.classList.add('has-game-frame');
    els.watch.classList.remove('game-ready');
    const frameUrl = new URL('staging/index.html', document.baseURI);
    frameUrl.searchParams.set('watch', code);
    frameUrl.searchParams.set('mode', state.activeMode);
    frameUrl.searchParams.set('embed', '1');
    // When testing against a local Worker, the embedded game must talk to the same local
    // Worker (its spectator socket and snapshots), not the deployed staging service.
    if (API_OVERRIDDEN) frameUrl.searchParams.set('api', MULTIPLAYER_API);
    els.gameFrame.onload = () => {
      if (state.latestGameFrameMessage) forwardGameFrameMessage(state.latestGameFrameMessage);
      syncGameFrameMute();
    };
    els.gameFrame.src = frameUrl.href;
    syncGameFrameMute();
    connectRoomSocket(code, token);
  } catch (error) {
    if (token !== state.watchToken) return;
    state.connectionLost = true;
    setWatchStatus(error.message || 'Could not open this room.', true);
    text(els.roomSummary, 'This room is no longer available in the staging service.');
  }
}

export async function shareWatchLink() {
  if (!state.activeRoomCode) return;
  const url = directoryUrl(); // already carries the local-testing ?api= override
  url.searchParams.set('room', state.activeRoomCode);
  url.searchParams.set('mode', state.activeMode);
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
export async function startAiDemo() {
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
    state.demoControlToken = data.demoControlToken || '';
    state.demoControlRoomCode = data.roomCode || '';
    state.demoControlReady = false;
    if (!state.demoControlToken || !state.demoControlRoomCode) throw new Error('The Worker did not return the demo control details.');
    await startWatching(data.roomCode, 'demo', true);
  } catch (error) {
    setDirectoryStatus(error.message || 'Could not open the AI demo.', true);
  } finally {
    if (!els.directory.hidden) els.startDemo.disabled = false;
  }
}
