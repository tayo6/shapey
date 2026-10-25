// Shapey Worker - shared helpers: CORS, JSON responses, seat tokens, chat cleaning
// and the audience-poll snapshot. Extracted from src/index.js so the router and the
// Room Durable Object can share them without pulling in each other.

import { isAllowedOrigin } from "./protocol.js";

export const MAX_SPECTATORS_PER_ROOM = 100;
export const MAX_CHAT_CHARS = 280;
export const CHAT_HISTORY_LIMIT = 50;
export const AUDIENCE_POLL_MS = 30_000;
export const LIVE_DIRECTORY_OBJECT_NAME = "shapey-live-directory-v1";
export const LIVE_DIRECTORY_PREFIX = "listed-room:";
export const LIVE_DIRECTORY_STALE_MS = 5 * 60_000;
export const LIVE_DIRECTORY_REFRESH_MS = 45_000;

export function shortRandomId() {
  return newSeatToken().slice(0, 12).toUpperCase();
}

export function cleanChatText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_CHAT_CHARS);
}

export function audiencePollSnapshot(poll, now = Date.now()) {
  if (!poll) return null;
  const counts = Object.fromEntries(poll.options.map(option => [option.tileId, 0]));
  for (const vote of Object.values(poll.votes || {})) {
    if (Object.prototype.hasOwnProperty.call(counts, vote)) counts[vote] += 1;
  }
  const closed = Boolean(poll.closed);
  return {
    id: poll.id,
    startedByPlayer: poll.startedByPlayer,
    initialShape: poll.initialShape,
    serverNow: now,
    options: poll.options.map(option => ({ tileId: option.tileId, row: option.row, col: option.col })),
    ...(closed ? {
      counts,
      totalVotes: Object.values(counts).reduce((sum, value) => sum + value, 0)
    } : {}),
    endsAt: poll.endsAt,
    closed
  };
}

// CORS and WebSocket origin policy share the tested protocol helper.
export function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
  if (isAllowedOrigin(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}

// Player-seat credentials are generated server-side and stored only as SHA-256 hashes.
// They let a returning browser reclaim its original seat without putting the secret in a URL.
export function newSeatToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashSeatToken(token) {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(token)
  ));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
