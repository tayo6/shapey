import test from "node:test";
import assert from "node:assert/strict";
import { clearRoomStorage, ROOM_STORAGE_KEYS } from "../src/room-storage.js";

test("room cleanup removes every private room record and cancels its alarm", async () => {
  const records = new Map(ROOM_STORAGE_KEYS.map((key) => [key, { value: key }]));
  records.set("unrelated-record", { value: "preserve" });
  let alarmDeleted = false;

  const storage = {
    async delete(key) {
      records.delete(key);
      return true;
    },
    async deleteAlarm() {
      alarmDeleted = true;
    }
  };

  await clearRoomStorage(storage);

  assert.deepEqual([...records.keys()], ["unrelated-record"]);
  assert.equal(alarmDeleted, true);
  assert.ok(ROOM_STORAGE_KEYS.includes("audiencePoll"));
  assert.ok(ROOM_STORAGE_KEYS.includes("chatHistory"));
});
