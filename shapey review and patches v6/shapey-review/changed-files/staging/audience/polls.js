// Shapey audience page - the Ask-the-Audience poll panel.

import { els, state } from './state.js';
import { pollSecondsLeft, text } from './util.js';
import { updateBadges } from './badges.js';
import { renderBoard, updateBoardPollHint } from './board.js';

export function updatePollIntro() {
  const poll = state.currentPoll;
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
export function renderPoll(poll) {
  const changed = Boolean(poll && (!state.currentPoll || state.currentPoll.id !== poll.id));
  if (changed || !poll) {
    state.currentVote = null;
    state.pollAcceptedId = '';
    state.pollDeclinedId = '';
  }
  state.currentPoll = poll || null;
  els.pollOptions.replaceChildren();
  renderBoard(state.currentState, state.currentState, false);
  updateBoardPollHint();
  if (!poll) {
    text(els.pollIntro, ['pvp', 'tag', 'demo'].includes(state.activeMode)
      ? 'No poll is open. Players can ask the audience after revealing the first shape.'
      : 'Audience polls are available in online Player 1 vs Player 2 and Tag games.');
    updateBadges();
    return;
  }
  updatePollIntro();
  if (!poll.closed) {
    text(els.pollOptions, state.currentVote
      ? 'Your vote is locked. Wait for the poll to close to see the results.'
      : 'Tap a cyan-outlined face-down tile on the board. Every eligible hidden tile can be chosen; no fixed three- or four-option list.');
  } else {
    text(els.pollOptions, 'Voting is closed. Gold outlines and percentages on the board show the top-voted tile or tied tiles.');
  }
  updateBadges();
}
