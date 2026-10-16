export const ALLOWED_ORIGINS = Object.freeze([
  "https://tayo6.github.io",
  "https://shapey-audience-preview.hellohuman100.workers.dev",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

export const ROOM_IDLE_TTL_MS = 30 * 60 * 1000;
export const ROOM_MAX_LIFETIME_MS = 6 * 60 * 60 * 1000;
export const MESSAGE_RATE_WINDOW_MS = 10 * 1000;
export const MESSAGE_RATE_LIMIT = 60;
export const MAX_MESSAGE_BYTES = 4096;
export const ROOM_CREATE_RATE_WINDOW_MS = 10 * 60 * 1000;
export const ROOM_CREATE_RATE_LIMIT = 5;

export function isAllowedOrigin(origin) {
  return typeof origin === "string" && ALLOWED_ORIGINS.includes(origin);
}

export function modeDetails(mode) {
  if (mode === "tag") return { mode: "tag", maxPlayers: 4 };
  if (mode === "pvp") return { mode: "pvp", maxPlayers: 2 };
  if (mode === "demo") return { mode: "demo", maxPlayers: 0 };
  return null;
}

export function isRoomCode(value) {
  return typeof value === "string" && /^[A-Z0-9]{6}$/.test(value);
}

export function messageByteLength(message) {
  if (typeof message === "string") return new TextEncoder().encode(message).byteLength;
  if (message instanceof ArrayBuffer) return message.byteLength;
  if (ArrayBuffer.isView(message)) return message.byteLength;
  return Infinity;
}

export function nextMessageRateState(attachment, now) {
  const startedAt = attachment?.messageWindowStartedAt;
  const count = attachment?.messageCount;
  if (!Number.isFinite(startedAt) || !Number.isFinite(count) ||
      now < startedAt || now - startedAt >= MESSAGE_RATE_WINDOW_MS) {
    return {
      allowed: true,
      messageWindowStartedAt: now,
      messageCount: 1,
    };
  }

  const nextCount = count + 1;
  return {
    allowed: nextCount <= MESSAGE_RATE_LIMIT,
    messageWindowStartedAt: startedAt,
    messageCount: nextCount,
  };
}

export function roomExpiryDeadline(room, now, connectedCount) {
  const maximum = room.createdAt + ROOM_MAX_LIFETIME_MS;
  if (connectedCount > 0) return maximum;
  const lastActivity = Number.isFinite(room.lastActivityAt) ? room.lastActivityAt : room.createdAt;
  return Math.min(maximum, lastActivity + ROOM_IDLE_TTL_MS);
}

export function isRoomExpired(room, now, connectedCount) {
  if (!room || !Number.isFinite(room.createdAt)) return true;
  if (now >= room.createdAt + ROOM_MAX_LIFETIME_MS) return true;
  if (connectedCount > 0) return false;
  const lastActivity = Number.isFinite(room.lastActivityAt) ? room.lastActivityAt : room.createdAt;
  return now >= lastActivity + ROOM_IDLE_TTL_MS;
}


export function nextRoomCreationWindow(timestamps, now) {
  const recent = Array.isArray(timestamps)
    ? timestamps.filter((timestamp) => Number.isFinite(timestamp) && timestamp >= 0 &&
        timestamp <= now && timestamp > now - ROOM_CREATE_RATE_WINDOW_MS)
    : [];
  if (recent.length >= ROOM_CREATE_RATE_LIMIT) {
    return {
      allowed: false,
      timestamps: recent,
      retryAfterMs: Math.max(0, recent[0] + ROOM_CREATE_RATE_WINDOW_MS - now)
    };
  }
  return { allowed: true, timestamps: [...recent, now], retryAfterMs: 0 };
}
