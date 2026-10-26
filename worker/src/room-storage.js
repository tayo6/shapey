// All persistent room-specific records must be removed together at teardown.
export const ROOM_STORAGE_KEYS = Object.freeze([
  "room",
  "game",
  "seatRegistry",
  "audiencePoll",
  "chatHistory",
]);

export async function clearRoomStorage(storage) {
  for (const key of ROOM_STORAGE_KEYS) {
    await storage.delete(key);
  }
  await storage.deleteAlarm();
}
