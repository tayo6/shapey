import test from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_ORIGINS, ROOM_IDLE_TTL_MS, ROOM_MAX_LIFETIME_MS,
  isAllowedOrigin, isRoomCode, modeDetails, isRoomExpired, roomExpiryDeadline,
} from "../src/protocol.js";

test("only the production site and documented local origins are allowed", () => {
  for (const origin of ALLOWED_ORIGINS) assert.equal(isAllowedOrigin(origin), true);
  for (const origin of ["", null, "https://evil.example", "https://tayo6.github.io.evil.example"]) {
    assert.equal(isAllowedOrigin(origin), false);
  }
});

test("only the existing online modes are admitted with their intended capacity", () => {
  assert.deepEqual(modeDetails("pvp"), { mode: "pvp", maxPlayers: 2 });
  assert.deepEqual(modeDetails("tag"), { mode: "tag", maxPlayers: 4 });
  for (const mode of ["alone", "ai", "spectator", "", null]) assert.equal(modeDetails(mode), null);
});

test("room code validation accepts six uppercase letters/digits and rejects malformed input", () => {
  for (const code of ["ABC234", "ZZZZZZ", "123456"]) assert.equal(isRoomCode(code), true);
  for (const code of ["abc234", "ABC23", "ABC2345", "ABC-34", "", null, 123456]) {
    assert.equal(isRoomCode(code), false);
  }
});

test("an empty room expires after the idle TTL", () => {
  const now = 1_000_000;
  const room = { createdAt: now, lastActivityAt: now };
  assert.equal(roomExpiryDeadline(room, now, 0), now + ROOM_IDLE_TTL_MS);
  assert.equal(isRoomExpired(room, now + ROOM_IDLE_TTL_MS - 1, 0), false);
  assert.equal(isRoomExpired(room, now + ROOM_IDLE_TTL_MS, 0), true);
});

test("a connected room gets the hard max-lifetime deadline, not the idle deadline", () => {
  const now = 1_000_000;
  const room = { createdAt: now, lastActivityAt: now };
  assert.equal(roomExpiryDeadline(room, now + ROOM_IDLE_TTL_MS * 3, 1), now + ROOM_MAX_LIFETIME_MS);
  assert.equal(isRoomExpired(room, now + ROOM_IDLE_TTL_MS * 3, 1), false);
  assert.equal(isRoomExpired(room, now + ROOM_MAX_LIFETIME_MS, 1), true);
});

test("a room never survives beyond its hard maximum lifetime", () => {
  const createdAt = 1_000_000;
  const room = { createdAt, lastActivityAt: createdAt + ROOM_MAX_LIFETIME_MS };
  assert.equal(roomExpiryDeadline(room, createdAt, 0), createdAt + ROOM_MAX_LIFETIME_MS);
  assert.equal(isRoomExpired(room, createdAt + ROOM_MAX_LIFETIME_MS, 0), true);
});

test("legacy room records without lastActivityAt fall back to createdAt", () => {
  const createdAt = 1_000_000;
  const room = { createdAt };
  assert.equal(roomExpiryDeadline(room, createdAt, 0), createdAt + ROOM_IDLE_TTL_MS);
  assert.equal(isRoomExpired(room, createdAt + ROOM_IDLE_TTL_MS, 0), true);
});
