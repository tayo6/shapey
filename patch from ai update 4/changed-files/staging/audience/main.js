// Shapey audience page - entry point: wires every control, starts the refresh and
// HUD timers, and routes the initial URL (?room=CODE or the directory).

import { $, els, state } from './state.js';
import { pollSecondsLeft, text } from './util.js';
import { updateBadges } from './badges.js';
import { updateHud } from './board.js';
import { renderPoll, updatePollIntro } from './polls.js';
import { closeChatPage, closePanels, forwardGameFrameMessage, openChatPage, openPanel, playAudienceTone, sendSocketMessage, syncGameFrameMute } from './ui.js';
import { loadRooms, renderRooms, showDirectory } from './directory.js';
import { shareWatchLink, startAiDemo, startWatching } from './watch.js';

els.refreshRooms.addEventListener('click', loadRooms);
els.startDemo.addEventListener('click', startAiDemo);
els.gameFrame.addEventListener('load', () => {
  if (state.latestGameFrameMessage) forwardGameFrameMessage(state.latestGameFrameMessage);
  syncGameFrameMute();
});
window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || event.source !== els.gameFrame.contentWindow) return;
  const message = event.data;
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'shapey-audience-ready') {
    // The iframe may finish loading after the room's first snapshot; resend it now that the
    // embedded receiver exists, so a first room-open never remains on the loading screen.
    if (state.latestGameFrameMessage) forwardGameFrameMessage(state.latestGameFrameMessage);
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
  state.modeFilterValue = chip.dataset.mode;
  renderRooms();
});
els.statusFilter.addEventListener('change', () => { state.statusFilterValue = els.statusFilter.value; renderRooms(); });
els.btnChat.addEventListener('click', () => openChatPage());
els.backToGame.addEventListener('click', () => closeChatPage(true));
els.btnPolls.addEventListener('click', () => openPanel('polls'));
els.btnSettings.addEventListener('click', () => openPanel('settings'));
els.muteAudienceSound.checked = state.soundMuted;
els.muteAudienceSound.addEventListener('change', () => {
  state.soundMuted = els.muteAudienceSound.checked;
  try { localStorage.setItem('shapey-audience-muted', String(state.soundMuted)); } catch (_) {}
  syncGameFrameMute();
  if (!state.soundMuted) playAudienceTone(520);
});
['closePoll', 'closeSettings', 'resumeWatch'].forEach((id) => $(id).addEventListener('click', closePanels));
els.endDemo.addEventListener('click', () => {
  if (state.activeMode !== 'demo' || state.demoControlRoomCode !== state.activeRoomCode || !state.demoControlReady) return;
  sendSocketMessage({ type: 'end_demo' });
});
els.backdrop.addEventListener('click', closePanels);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (state.chatPageOpen) closeChatPage(true);
  else if (state.activePanel) closePanels();
});
$('backToDirectory').addEventListener('click', () => showDirectory(true));
els.shareRoom.addEventListener('click', shareWatchLink);
els.retryConnection.addEventListener('click', () => {
  els.retryConnection.disabled = true;
  startWatching(state.activeRoomCode, state.activeMode, false);
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
  if (state.chatPageOpen) { closeChatPage(false); return; }
  const params = new URLSearchParams(window.location.search);
  const code = params.get('room');
  if (code) startWatching(code, params.get('mode') || '', false);
  else showDirectory(false);
});
state.refreshTimer = window.setInterval(() => {
  if (!els.directory.hidden && !document.hidden) loadRooms();
}, 20_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !els.directory.hidden) loadRooms();
});
state.turnTimer = window.setInterval(() => {
  updateHud();
  if (!state.currentPoll) return;
  updatePollIntro();
  if (!state.currentPoll.closed && pollSecondsLeft(state.currentPoll) === 0 && state.pollLockedId !== state.currentPoll.id) {
    state.pollLockedId = state.currentPoll.id;
    renderPoll(state.currentPoll); // voting time is over: lock the buttons
  }
  updateBadges();
}, 250);
const initialParams = new URLSearchParams(window.location.search);
if (initialParams.get('room')) {
  startWatching(initialParams.get('room'), initialParams.get('mode') || '', false);
  if (window.location.hash === '#chat') openChatPage(false);
} else loadRooms();
