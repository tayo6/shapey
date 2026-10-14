export const ALLOWED_ORIGINS = Object.freeze([
  "https://tayo6.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

export const ROOM_IDLE_TTL_MS = 30 * 60 * 1000;
export const ROOM_MAX_LIFETIME_MS = 6 * 60 * 60 * 1000;

export function isAllowedOrigin(origin) {
  return typeof origin === "string" && ALLOWED_ORIGINS.includes(origin);
}

export function modeDetails(mode) {
  if (mode === "tag") return { mode: "tag", maxPlayers: 4 };
  if (mode === "pvp") return { mode: "pvp", maxPlayers: 2 };
  return null;
}

export function isRoomCode(value) {
  return typeof value === "string" && /^[A-Z0-9]{6}$/.test(value);
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
