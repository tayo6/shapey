// Shapey audience page - the public room directory: filter chips, room cards and
// the directory/listing views.


// ------------------------------------------------------------------ room directory

import { els, state } from './state.js';
import { api, directoryUrl, el, modeName, sideNames, statusName, text, turnLabel } from './util.js';
import { closeChatPage, setDirectoryStatus } from './ui.js';
import { closeSocket, resetRoomView, startWatching } from './watch.js';

export const isWaiting = (room) => ['waiting', 'ready', 'starting'].includes(room.status);

export function makePill(status) {
  return el('span', 'tag-pill' + (status === 'live' ? ' live' : ''), statusName(status));
}

export function makeRoomCard(room) {
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
  const details = ['Board ' + boardSize + '×' + boardSize, 'First to ' + (Number(room.targetScore) || (tag ? 100 : 50))];
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

export function updateFilterChips() {
  const matchesStatus = (room) => state.statusFilterValue === 'all' || (state.statusFilterValue === 'live' ? room.status === 'live' : isWaiting(room));
  const matchesMode = (room) => state.modeFilterValue === 'all' || room.mode === state.modeFilterValue;
  const byStatus = state.roomsCache.filter(matchesStatus);
  const byMode = state.roomsCache.filter(matchesMode);
  const modeCount = {
    all: byStatus.length,
    tag: byStatus.filter((r) => r.mode === 'tag').length,
    pvp: byStatus.filter((r) => r.mode === 'pvp').length,
    demo: byStatus.filter((r) => r.mode === 'demo').length
  };
  const modeNames = { all: 'All', tag: 'Tag · 2 vs 2', pvp: '1 vs 1', demo: 'AI vs AI' };
  els.modeChips.querySelectorAll('.chip').forEach((chip) => {
    const key = chip.dataset.mode;
    chip.classList.toggle('is-active', key === state.modeFilterValue);
    chip.setAttribute('aria-pressed', String(key === state.modeFilterValue));
    text(chip, modeNames[key] + ' (' + (modeCount[key] ?? 0) + ')');
  });
  const statusCount = { live: byMode.filter((r) => r.status === 'live').length, waiting: byMode.filter(isWaiting).length, all: byMode.length };
  const statusNames = { live: 'Live games', waiting: 'Waiting rooms', all: 'All available rooms' };
  [...els.statusFilter.options].forEach((option) => {
    option.textContent = statusNames[option.value] + ' (' + (statusCount[option.value] ?? 0) + ')';
  });
  els.statusFilter.value = state.statusFilterValue;
}

export function renderRooms() {
  if (!state.roomsLoadedAt) return;
  updateFilterChips();
  const rank = { live: 0, starting: 1, ready: 2, waiting: 3 };
  const filtered = state.roomsCache
    .filter((room) => state.statusFilterValue === 'all' || (state.statusFilterValue === 'live' ? room.status === 'live' : isWaiting(room)))
    .filter((room) => state.modeFilterValue === 'all' || room.mode === state.modeFilterValue)
    .sort((a, b) => (Number(b.spectatorCount) || 0) - (Number(a.spectatorCount) || 0) || (rank[a.status] ?? 4) - (rank[b.status] ?? 4));
  els.rooms.replaceChildren();
  if (!filtered.length) {
    els.rooms.append(el('div', 'notice', state.roomsCache.length
      ? 'No rooms match those filters. Try ALL ROOMS to include games that have not started.'
      : 'No public rooms are active right now. Check back in a little while, or start a room from the game.'));
  } else {
    filtered.forEach((room) => els.rooms.append(makeRoomCard(room)));
  }
  const noun = filtered.length === 1 ? 'room' : 'rooms';
  setDirectoryStatus(filtered.length + ' ' + noun + ' · updated ' + state.roomsLoadedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), false);
}

export async function loadRooms() {
  const seq = ++state.roomsLoadSeq;
  setDirectoryStatus('Refreshing the room list…', false);
  els.refreshRooms.disabled = true;
  try {
    const response = await fetch(api('/api/rooms'), { cache: 'no-store', headers: { Accept: 'application/json' } });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (seq !== state.roomsLoadSeq) return; // a newer refresh has started; ignore this older answer
    if (!response.ok) throw new Error(data.error || ('Room directory returned HTTP ' + response.status));
    state.roomsCache = Array.isArray(data.rooms) ? data.rooms : [];
    state.roomsLoadedAt = new Date();
    renderRooms();
  } catch (error) {
    if (seq !== state.roomsLoadSeq) return;
    els.rooms.replaceChildren(el('div', 'notice', error.message || 'The live directory is unavailable. Please retry.'));
    setDirectoryStatus('Could not reach the live room service. Please refresh and try again.', true);
  } finally {
    if (seq === state.roomsLoadSeq) els.refreshRooms.disabled = false;
  }
}

export function showDirectory(updateUrl) {
  document.body.classList.remove('watching-room');
  if (state.chatPageOpen) closeChatPage(false);
  state.explicitLeave = true;
  state.watchToken++;
  closeSocket();
  state.activeRoomCode = '';
  state.activeMode = '';
  resetRoomView();
  els.directory.hidden = false;
  els.watch.hidden = true;
  if (updateUrl) {
    // Preserve the query so local-testing pages keep the ?api= override after leaving a room
    // (production URLs carry no parameters here, exactly as before).
    const url = directoryUrl();
    window.history.pushState({}, '', url.pathname + url.search);
  }
  loadRooms();
}

export function enterWatchView(code) {
  document.body.classList.add('watching-room');
  els.directory.hidden = true;
  els.watch.hidden = false;
  const url = directoryUrl();
  url.searchParams.set('room', code);
  if (state.activeMode) url.searchParams.set('mode', state.activeMode);
  window.history.pushState({}, '', url.pathname + url.search);
}
