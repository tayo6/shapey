// Shapey audience page - the chat / poll notification badges.


// ------------------------------------------------------------------ panels (chat, polls, menu)

import { els, state } from './state.js';
import { pollIsOpen, text } from './util.js';

export function updateBadges() {
  els.chatBadge.hidden = state.unreadChat === 0;
  text(els.chatBadge, state.unreadChat > 9 ? '9+' : state.unreadChat);
  els.pollBadge.hidden = !(pollIsOpen(state.currentPoll) && !state.currentVote && state.activePanel !== 'polls');
}
