// Shapey audience page - the shared board renderer: tiles, spawn/fall animation,
// dust and destroy effects, poll voting highlights, scores and the HUD clock.

import { els, state } from './state.js';
import { formatClock, percentSplit, pollIsOpen, serverToLocal, shapeUrl, sideOf, text, turnLabel } from './util.js';
import { renderPoll } from './polls.js';
import { sendSocketMessage, setWatchStatus } from './ui.js';

export function renderScores(view) {
  const scores = Array.isArray(view.scores) ? view.scores : [0, 0];
  text(els.p1Score, Number(scores[0]) || 0);
  text(els.p2Score, Number(scores[1]) || 0);
  // Like the game, the side that is not playing is dimmed.
  const playing = view.status === 'playing' && view.activePlayerNumber;
  const side = playing ? sideOf(view.mode, view.activePlayerNumber) : -1;
  els.side0.classList.toggle('dim', side === 1);
  els.side1.classList.toggle('dim', side === 0);
  // The game shows whose turn it is under the timer in Tag only.
  const showGoal = view.mode === 'tag' && playing;
  els.goalText.hidden = !showGoal;
  if (showGoal) text(els.goalText, (turnLabel(view.mode, view.activePlayerNumber) + (view.isBonusTurn ? ' · Double Play' : '')).toUpperCase());
}

export function renderBoard(view, previousState = null, animate = false) {
  if (!state || !Array.isArray(view.tiles)) {
    els.board.replaceChildren();
    state.tileNodes.clear();
    return;
  }
  const requestedSize = [5, 6, 7].includes(Number(view.boardSize)) ? Number(view.boardSize) : 7;
  // Tag remains 7×7. Other modes scale tile size and spacing to fill the same fixed tray area.
  const boardSize = view.mode === 'tag' ? 7 : requestedSize;
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
    for (const tile of view.tiles) {
      if (!previousTiles.has(String(tile.id))) newCountByColumn.set(tile.col, (newCountByColumn.get(tile.col) || 0) + 1);
    }
  }
  const options = Array.isArray(state.currentPoll && state.currentPoll.options) ? state.currentPoll.options : [];
  const optionId = (option) => option && typeof option === 'object' ? String(option.tileId || '') : String(option || '');
  const optionIds = new Set(options.map(optionId).filter(Boolean));
  const counts = state.currentPoll && state.currentPoll.closed ? (state.currentPoll.counts || {}) : {};
  const optionCounts = options.map((option) => Number(counts[optionId(option)]) || 0);
  const totalVotes = optionCounts.reduce((sum, count) => sum + count, 0);
  const best = Math.max(0, ...optionCounts);
  const percents = percentSplit(optionCounts);
  const percentById = new Map();
  options.forEach((option, index) => percentById.set(optionId(option), percents[index]));
  const canVote = Boolean(pollIsOpen(state.currentPoll) && !state.currentVote && state.roomSocket && state.roomSocket.readyState === WebSocket.OPEN);

  const keep = new Set();
  for (const tileData of view.tiles) {
    if (!Number.isInteger(tileData.row) || !Number.isInteger(tileData.col)) continue;
    const id = String(tileData.id);
    keep.add(id);
    let tile = state.tileNodes.get(id);
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
      animateSpawn = canAnimate && !previousTiles.has(id) && view.status !== 'study';
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
      state.tileNodes.set(id, tile);
      if (animateSpawn) {
        const spawnCount = newCountByColumn.get(tileData.col) || 1;
        const landingDelay = 40 * Math.max(0, spawnCount - 1 - tileData.row);
        const landingDuration = 260 + Math.max(1, spawnCount) * 90;
        window.requestAnimationFrame(() => {
          if (state.tileNodes.get(id) !== tile) return;
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
    const isThisVote = state.currentVote === id;
    const votes = Number(counts[id]) || 0;
    const isWinner = Boolean(state.currentPoll && state.currentPoll.closed && totalVotes > 0 && isPollOption && votes === best);
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
    if (voteBadge && state.currentPoll && state.currentPoll.closed && isPollOption && totalVotes > 0 && votes > 0) {
      voteBadge.hidden = false;
      voteBadge.textContent = (percentById.get(id) || 0) + '%';
    } else if (voteBadge) {
      voteBadge.hidden = true;
      voteBadge.textContent = '';
    }
  }
  for (const [id, node] of state.tileNodes.entries()) {
    if (!keep.has(id)) {
      const oldTile = previousTiles.get(id);
      if (canAnimate && oldTile) playBoardEffect('destroy', oldTile.row, oldTile.col);
      node.remove();
      state.tileNodes.delete(id);
    }
  }
}

export function finishSpawnDust(tile) {
  if (!tile || tile.dataset.spawnDust !== 'true') return;
  delete tile.dataset.spawnDust;
  tile.style.transitionDelay = '';
  tile.style.transitionDuration = '';
  if (state.tileNodes.get(tile.dataset.tileId) !== tile) return;
  playBoardEffect('dust', Number(tile.dataset.dustRow), Number(tile.dataset.dustCol));
}

export function playBoardEffect(kind, row, col) {
  if (els.gameFrame && !els.gameFrame.hidden) return;
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 6 || col < 0 || col > 6) return;
  const effect = document.createElement('div');
  effect.className = 'board-fx ' + (kind === 'dust' ? 'dust-fx' : 'destroy-fx');
  effect.style.setProperty('--c', col);
  effect.style.setProperty('--r', row);
  els.board.append(effect);
  effect.addEventListener('animationend', () => effect.remove(), { once: true });
}

export function voteForTile(tileId) {
  const poll = state.currentPoll;
  const options = Array.isArray(poll && poll.options) ? poll.options : [];
  if (!pollIsOpen(poll) || state.currentVote || !state.roomSocket || state.roomSocket.readyState !== WebSocket.OPEN) return;
  if (!options.some((option) => (option && typeof option === 'object' ? String(option.tileId) : String(option)) === String(tileId))) return;
  const tile = state.currentState && Array.isArray(state.currentState.tiles)
    ? state.currentState.tiles.find((item) => String(item.id) === String(tileId)) : null;
  if (!tile || tile.faceUp || tile.selected || tile.moving) return;
  if (sendSocketMessage({ type: 'poll_vote', tileId: String(tileId) })) {
    state.currentVote = String(tileId);
    renderPoll(state.currentPoll);
    setWatchStatus('Vote submitted for row ' + (tile.row + 1) + ', column ' + (tile.col + 1) + '.', false);
  }
}

export function updateBoardPollHint() {
  // The footnote element is optional: older pages that do not have it must not crash the socket handler.
  const footnote = els.boardFootnote;
  if (!footnote) return;
  if (state.currentPoll && pollIsOpen(state.currentPoll)) {
    footnote.hidden = false;
    text(footnote, 'Audience poll open: tap any cyan-outlined face-down tile on the shared board to vote once.');
  } else if (state.currentPoll && state.currentPoll.closed) {
    footnote.hidden = false;
    text(footnote, 'Poll closed. Gold outlines and percentages show the audience’s top board choice or tied tiles.');
  } else {
    footnote.hidden = true;
    text(footnote, '');
  }
}

// Turn clock and the MEMORIZE / SHUFFLING cue, drawn from the same deadlines the game uses.
export function updateHud() {
  const view = state.currentState;
  if (!view) { text(els.turnClock, '--:--'); text(els.revealText, ''); return; }
  const now = Date.now();
  let clock;
  if (view.status === 'study') clock = '--:--';
  else if (view.status === 'playing' && Number.isFinite(view.turnEndsAt)) clock = formatClock(serverToLocal(view.turnEndsAt) - now);
  else if (view.status === 'finished') clock = formatClock(0);
  else clock = '--:--';
  text(els.turnClock, clock);
  let left = view.status === 'study' && Number.isFinite(view.reviewEndsAt) ? serverToLocal(view.reviewEndsAt) - now : 0;
  (view.reveals || []).forEach((batch) => { left = Math.max(left, serverToLocal(batch.endsAt) - now); });
  if (left > 0) text(els.revealText, 'MEMORIZE ' + formatClock(left));
  else if (view.shuffling) text(els.revealText, 'SHUFFLING');
  else text(els.revealText, '');
}
