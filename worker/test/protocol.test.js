import test from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_ORIGINS, ROOM_IDLE_TTL_MS, ROOM_MAX_LIFETIME_MS,
  MESSAGE_RATE_LIMIT, MESSAGE_RATE_WINDOW_MS, MAX_MESSAGE_BYTES,
  isAllowedOrigin, isRoomCode, modeDetails, isRoomExpired, roomExpiryDeadline,
  messageByteLength, nextMessageRateState,
  ROOM_CREATE_RATE_WINDOW_MS, ROOM_CREATE_RATE_LIMIT, nextRoomCreationWindow,
} from "../src/protocol.js";

test("only the production site and documented local origins are allowed", () => {
  for (const origin of ALLOWED_ORIGINS) assert.equal(isAllowedOrigin(origin), true);
  for (const origin of ["", null, "https://evil.example", "https://tayo6.github.io.evil.example"]) {
    assert.equal(isAllowedOrigin(origin), false);
  }
});

test("online modes and the read-only AI demo are admitted with the intended capacity", () => {
  assert.deepEqual(modeDetails("pvp"), { mode: "pvp", maxPlayers: 2 });
  assert.deepEqual(modeDetails("tag"), { mode: "tag", maxPlayers: 4 });
  assert.deepEqual(modeDetails("demo"), { mode: "demo", maxPlayers: 0 });
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

test("WebSocket application messages have a bounded encoded byte length", () => {
  assert.equal(messageByteLength("hello"), 5);
  assert.equal(messageByteLength("😊"), 4);
  assert.equal(messageByteLength(new Uint8Array([1, 2, 3])), 3);
  assert.equal(messageByteLength(new Uint8Array(MAX_MESSAGE_BYTES)), MAX_MESSAGE_BYTES);
});

test("WebSocket messages are throttled per connection in a fixed window", () => {
  const now = 50_000;
  let attachment = {};
  let result;
  for (let i = 0; i < MESSAGE_RATE_LIMIT; i++) {
    result = nextMessageRateState(attachment, now);
    assert.equal(result.allowed, true);
    attachment = {
      messageWindowStartedAt: result.messageWindowStartedAt,
      messageCount: result.messageCount,
    };
  }
  result = nextMessageRateState(attachment, now);
  assert.equal(result.allowed, false);
  assert.equal(result.messageCount, MESSAGE_RATE_LIMIT + 1);
  assert.equal(nextMessageRateState(attachment, now + MESSAGE_RATE_WINDOW_MS).allowed, true);
});

test("a clock moving backwards resets the per-connection message window", () => {
  assert.deepEqual(nextMessageRateState({
    messageWindowStartedAt: 1000,
    messageCount: 50,
  }, 900), {
    allowed: true,
    messageWindowStartedAt: 900,
    messageCount: 1,
  });
});


test("room creation is capped per rolling window and becomes available again", () => {
  const now = 1_000_000;
  let timestamps = [];
  for (let i = 0; i < ROOM_CREATE_RATE_LIMIT; i++) {
    const result = nextRoomCreationWindow(timestamps, now);
    assert.equal(result.allowed, true);
    timestamps = result.timestamps;
  }
  const blocked = nextRoomCreationWindow(timestamps, now + 100);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.timestamps.length, ROOM_CREATE_RATE_LIMIT);
  assert.equal(blocked.retryAfterMs, ROOM_CREATE_RATE_WINDOW_MS - 100);

  const reset = nextRoomCreationWindow(timestamps, now + ROOM_CREATE_RATE_WINDOW_MS);
  assert.equal(reset.allowed, true);
  assert.deepEqual(reset.timestamps, [now + ROOM_CREATE_RATE_WINDOW_MS]);
});

test("room creation limiter safely ignores invalid old timestamps", () => {
  const result = nextRoomCreationWindow([null, NaN, -10, 9_000], 10_000);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.timestamps, [9_000, 10_000]);
});
