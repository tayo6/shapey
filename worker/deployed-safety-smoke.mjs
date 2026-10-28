import assert from "node:assert/strict";
import WebSocket from "ws";

const BASE_URL = process.env.SHAPEY_TEST_URL || "https://shapey-multiplayer-staging.hellohuman100.workers.dev";
const ALLOWED_ORIGIN = "https://tayo6.github.io";
const SOCKET_TIMEOUT_MS = 15_000;

function client(url) {
  const socket = new WebSocket(url, { headers: { Origin: ALLOWED_ORIGIN } });
  const queue = [];
  const waiters = [];

  socket.on("message", raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    for (let i = 0; i < waiters.length; i++) {
      if (!waiters[i].predicate(message)) continue;
      const [waiter] = waiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    queue.push(message);
  });

  socket.on("error", error => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });

  return {
    socket,
    waitFor(predicate, timeout = 10_000, label = "Worker message") {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error("Timed out waiting for " + label + "."));
        }, timeout);
        waiters.push(waiter);
      });
    }
  };
}

function waitForOpen(socket, timeout = 10_000) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket did not open.")), timeout);
    socket.once("open", () => { clearTimeout(timer); resolve(); });
    socket.once("error", error => { clearTimeout(timer); reject(error); });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      response.resume();
      reject(new Error("WebSocket handshake returned HTTP " + response.statusCode + "."));
    });
  });
}

function closeQuietly(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      try { socket.terminate(); } catch {}
      resolve();
    }, 1_500);
    socket.once("close", () => { clearTimeout(timer); resolve(); });
    try { socket.close(); } catch { clearTimeout(timer); resolve(); }
  });
}

async function run() {
  const response = await fetch(BASE_URL + "/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
    body: JSON.stringify({ mode: "demo" })
  });
  const room = await response.json();
  assert.equal(response.status, 201, "Staging must allow a single controlled demo room: " + JSON.stringify(room));
  assert.match(room.roomCode, /^[A-Z0-9]{6}$/);
  assert.equal(typeof room.demoControlToken, "string");

  const audience = client(room.websocketUrl + "?mode=demo&role=spectator");
  let hasDemoControl = false;
  let pending = null;
  let pendingClosePromise = null;

  try {
    await waitForOpen(audience.socket);
    audience.socket.send(JSON.stringify({ type: "spectate" }));
    await audience.waitFor(item => item.type === "spectator_welcome", 10_000, "spectator welcome");
    audience.socket.send(JSON.stringify({ type: "demo_control", token: room.demoControlToken }));
    await audience.waitFor(item => item.type === "demo_control_ready", 10_000, "demo-control confirmation");
    hasDemoControl = true;

    pending = client(room.websocketUrl + "?mode=demo");
    pendingClosePromise = new Promise(resolve => {
      pending.socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await waitForOpen(pending.socket);
    const closed = await Promise.race([
      pendingClosePromise,
      new Promise((_, reject) => setTimeout(() => reject(
        new Error("Staging Worker did not close an unjoined socket within " + SOCKET_TIMEOUT_MS + "ms.")
      ), SOCKET_TIMEOUT_MS))
    ]);
    assert.equal(closed.code, 1008, "Unjoined sockets should close with policy code 1008: " + JSON.stringify(closed));
    assert.match(closed.reason, /join timeout/i, "Expected explicit join-timeout close reason.");
    console.log("PASS: staging closed an unjoined player socket after its join deadline.");
  } finally {
    if (hasDemoControl && audience.socket.readyState === WebSocket.OPEN) {
      try { audience.socket.send(JSON.stringify({ type: "end_demo" })); } catch {}
    }
    await Promise.all([closeQuietly(pending?.socket), closeQuietly(audience.socket)]);
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
