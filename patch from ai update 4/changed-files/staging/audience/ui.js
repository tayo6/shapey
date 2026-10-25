// Shapey audience page - overlays and chrome: toast, veil, watch status, sound,
// the chat-page open/close helpers, mode UI and the roster, plus the bottom panels.

import { els, state } from './state.js';
import { el, modeName, playerWord, pollIsOpen, sideNames, sideOf, statusName, text } from './util.js';
import { updateBadges } from './badges.js';
import { renderPoll } from './polls.js';

// The two bottom-sheet panels (polls and settings) and their header buttons.
const PANELS = {
  polls: { panel: els.pollPanel, button: els.btnPolls },
  settings: { panel: els.settingsPanel, button: els.btnSettings }
};

export function playAudienceTone(frequency = 620) {
  if (state.soundMuted) return;
  try {
    const AudioClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioClass) return;
    if (!state.audienceAudio) state.audienceAudio = new AudioClass();
    if (state.audienceAudio.state === 'suspended') state.audienceAudio.resume();
    const oscillator = state.audienceAudio.createOscillator(); const gain = state.audienceAudio.createGain();
    oscillator.type = 'sine'; oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.035, state.audienceAudio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, state.audienceAudio.currentTime + 0.12);
    oscillator.connect(gain); gain.connect(state.audienceAudio.destination); oscillator.start(); oscillator.stop(state.audienceAudio.currentTime + 0.12);
  } catch (_) {}
}

export function syncGameFrameMute() { try { els.gameFrame.contentWindow?.postMessage({ type: 'shapey-audience-mute', muted: state.soundMuted }, window.location.origin); } catch (_) {} }

export function forwardGameFrameMessage(message) {
  if (!message || !['spectator_welcome', 'game_state', 'game_started'].includes(message.type)) return;
  state.latestGameFrameMessage = message;
  try { els.gameFrame.contentWindow?.postMessage({ type: 'shapey-audience-message', message }, window.location.origin); } catch (_) {}
}

export function setDirectoryStatus(message, isError) {
  text(els.directoryStatus, message);
  els.directoryStatus.classList.toggle('error', Boolean(isError));
}

// ------------------------------------------------------------------ toast + veil
export function showToast(message, ms, isError) {
  clearTimeout(state.toastTimer);
  text(els.toast, message || '');
  els.toast.classList.toggle('error', Boolean(isError));
  els.toast.hidden = !message;
  if (message && ms) {
    state.toastTimer = setTimeout(() => {
      if (state.statusIsError && state.statusMessage) {
        text(els.toast, state.statusMessage);
        els.toast.classList.add('error');
      } else {
        text(els.toast, '');
        els.toast.hidden = true;
      }
    }, ms);
  }
}

export function updateVeil() {
  const hasBoard = Boolean(state.currentState && Array.isArray(state.currentState.tiles) && state.currentState.tiles.length);
  els.veil.hidden = hasBoard && !state.connectionLost;
  if (!els.veil.hidden) text(els.veilText, (state.statusMessage || (state.connectionLost ? 'Disconnected from the room.' : 'Connecting…')).toUpperCase());
  els.retryConnection.hidden = !state.connectionLost;
  els.retryConnection.disabled = false;
}

export function setWatchStatus(message, isError) {
  state.statusMessage = message || '';
  state.statusIsError = Boolean(isError);
  showToast(state.statusMessage, isError ? 0 : 3200, isError);
  updateVeil();
}

export function openChatPage(updateUrl = true) {
  if (!state.activeRoomCode || state.chatPageOpen) return;
  closePanels();
  state.chatPageOpen = true;
  // Keep the game iframe visible and running under the chat overlay. Hiding it with display:none
  // can make mobile browsers resize/suspend Phaser, leaving only outer navigation on return.
  els.watch.hidden = false;
  els.chatPage.hidden = false;
  document.body.classList.add('chat-open');
  els.btnChat.classList.add('is-open');
  els.btnChat.setAttribute('aria-expanded', 'true');
  state.unreadChat = 0;
  updateBadges();
  requestAnimationFrame(() => {
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
    els.chatInput.focus({ preventScroll: true });
  });
  if (updateUrl && window.location.hash !== '#chat') {
    window.history.pushState({ shapeyAudienceChat: true }, '', window.location.pathname + window.location.search + '#chat');
  }
}

export function closeChatPage(updateUrl = true) {
  if (!state.chatPageOpen) return;
  state.chatPageOpen = false;
  els.chatPage.hidden = true;
  document.body.classList.remove('chat-open');
  els.btnChat.classList.remove('is-open');
  els.btnChat.setAttribute('aria-expanded', 'false');
  if (state.activeRoomCode) els.watch.hidden = false;
  if (updateUrl && window.location.hash === '#chat') {
    window.history.replaceState(window.history.state || {}, '', window.location.pathname + window.location.search);
  }
}

// These audience rooms all use the existing Chat, Polls and Settings icons.
export function applyModeUI() {
  const hasPolls = ['pvp', 'tag', 'demo'].includes(state.activeMode);
  els.btnPolls.hidden = !hasPolls;
  els.btnChat.style.setProperty('--x', hasPolls ? 175 : 250);
  els.btnPolls.style.setProperty('--x', 360);
  els.btnSettings.style.setProperty('--x', hasPolls ? 545 : 470);
  const names = sideNames(state.activeMode);
  text(els.p1Name, names[0]);
  text(els.p2Name, names[1]);
  if (!hasPolls && state.activePanel === 'polls') closePanels();
}

export function renderPlayers() {
  els.endDemo.hidden = !(state.activeMode === 'demo' && state.demoControlRoomCode === state.activeRoomCode && state.demoControlReady);
  els.playersList.replaceChildren();
  const tag = state.activeMode === 'tag';
  const connected = new Set((state.roomPlayers || []).filter((p) => p && p.connected).map((p) => p.playerNumber));
  for (let number = 1; number <= (tag ? 4 : 2); number++) {
    const row = el('div', 'roster-row');
    row.append(el('span', '', (tag ? 'Team ' + (sideOf('tag', number) + 1) + ' · ' : '') + playerWord(state.activeMode) + ' ' + number),
      el('span', 'state' + (connected.has(number) ? ' on' : ''), connected.has(number) ? 'CONNECTED' : 'WAITING'));
    els.playersList.append(row);
  }
  text(els.roomSummary, (modeName(state.activeMode) + ' · Room ' + state.activeRoomCode + ' · ' + statusName(state.roomStatus) + ' · ' + state.roomSpectators + ' watching').toUpperCase());
  text(els.chatCount, state.roomSpectators + ' watching');
}

export function openPanel(name) {
  if (state.activePanel === name) { closePanels(); return; }
  closePanels();
  if (name === 'polls' && !['pvp', 'tag', 'demo'].includes(state.activeMode)) return;
  if (name === 'polls' && pollIsOpen(state.currentPoll)) {
    setWatchStatus('The audience poll is live. Tap a highlighted tile on the board to vote.', false);
    return;
  }
  state.activePanel = name;
  els.backdrop.hidden = false;
  PANELS[name].panel.hidden = false;
  PANELS[name].button.classList.add('is-open');
  PANELS[name].button.setAttribute('aria-expanded', 'true');
  if (name === 'settings') renderPlayers();
  if (name === 'polls') renderPoll(state.currentPoll);
  updateBadges();
}

export function closePanels() {
  state.activePanel = null;
  els.backdrop.hidden = true;
  Object.values(PANELS).forEach(({ panel, button }) => {
    panel.hidden = true;
    button.classList.remove('is-open');
    button.setAttribute('aria-expanded', 'false');
  });
  updateBadges();
}

export function sendSocketMessage(message) {
  if (!state.roomSocket || state.roomSocket.readyState !== WebSocket.OPEN) {
    text(els.chatStatus, 'Not connected. Close this and tap RETRY.');
    setWatchStatus('Not connected to the room.', true);
    return false;
  }
  try { state.roomSocket.send(JSON.stringify(message)); return true; } catch (_) { return false; }
}
