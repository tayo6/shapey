// Shapey audience page - the chat log and the full-page chat view helpers.


// ------------------------------------------------------------------ chat (text only)

import { AVATAR_COLORS, els, state } from './state.js';
import { el } from './util.js';
import { updateBadges } from './badges.js';

export function ensureChatEmpty() {
  if (!els.chatMessages.querySelector('.msg') && !els.chatMessages.querySelector('.empty')) {
    els.chatMessages.append(el('div', 'empty', 'No messages yet.\nBe the first to say hello!'));
    els.chatMessages.lastElementChild.style.whiteSpace = 'pre-line';
  }
}

export function avatarColor(name) {
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function appendChat(message, live) {
  if (!message || typeof message.text !== 'string') return;
  if (message.id && state.chatIds.has(message.id)) return;
  if (message.id) state.chatIds.add(message.id);
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
  if (live && !state.chatPageOpen) { state.unreadChat++; updateBadges(); }
}
