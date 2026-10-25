// Watch-path verification (review package, rev 4): the main game's ?watch=CODE entry.
// Patch 0004 removed the unreachable direct-connection fallback from startAudienceWatch;
// the reachable behaviour is: index.html?watch=CODE redirects to the audience wrapper
// (staging/audience.html?room=CODE), whose embedded iframe runs the game client and
// receives authorised spectator snapshots from the wrapper's single WebSocket.
//
// BACKEND NOTE (verified against the code): the audience wrapper (staging/audience/state.js)
// hardcodes MULTIPLAYER_API to the deployed staging Worker and ignores ?api= - on the live
// site and locally alike. The demo room is therefore created on that same deployed staging
// Worker (exactly what the page's own "start demo" button does; http://127.0.0.1:8080 is in
// the Worker's ALLOWED_ORIGINS). The Worker-side logic itself is covered by the local
// integration/browser/tag smoke suites against the refactored local Worker.
//
// This script drives the whole reachable path:
//   1. create an AI-vs-AI demo room on the staging Worker (POST /api/rooms, mode demo)
//   2. open index.html?watch=CODE -> must land on staging/audience.html?room=CODE
//   3. the embedded #gameFrame must render the live match (tiles via postMessage snapshots)
//   4. the watched match must actually progress (turn/score changes observed)
//   5. zero uncaught page errors
//
// PLACEMENT: inside the repository checkout as <repo>/verification/watch-verify.mjs
// Prerequisites: cd worker && npm ci and a static server on 127.0.0.1:8080 serving the repo
// root. No local Worker needed (see BACKEND NOTE).
import { chromium } from "../worker/node_modules/playwright/index.mjs";

const GAME = "http://127.0.0.1:8080/index.html";
const API = "https://shapey-multiplayer-staging.hellohuman100.workers.dev";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail === undefined ? "" : " :: " + JSON.stringify(detail)));
  if (ok) pass++; else fail++;
}

// 1. Create the demo room on the staging Worker, exactly like the audience page's own button
//    (POST /api/rooms with mode demo; the local origin is in the Worker's ALLOWED_ORIGINS).
const res = await fetch(API + "/api/rooms", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Origin": "http://127.0.0.1:8080" },
  body: JSON.stringify({ mode: "demo" }),
});
if (!res.ok) { console.error("FAIL - demo room could not be created :: HTTP " + res.status); process.exit(1); }
const room = await res.json();
const code = room.roomCode;
check("W1 demo room created via the Worker API", !!code && room.mode === "demo", { roomCode: code, mode: room.mode });

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 720, height: 1280 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));

  // 2. The main game's ?watch=CODE link must hand over to the audience wrapper.
  await page.goto(GAME + "?watch=" + code, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/staging\/audience\.html/, { timeout: 30000 });
  const landed = new URL(page.url());
  check("W2 index.html?watch=CODE redirects to the audience wrapper with the same room code",
    landed.searchParams.get("room") === code, { finalUrl: landed.pathname + "?" + landed.searchParams.toString() });

  // 3. The wrapper's embedded game frame must come up and render the watched board.
  await page.waitForFunction(() => {
    const frame = document.querySelector("#gameFrame");
    if (!frame || frame.hidden) return false;
    try {
      const s = frame.contentWindow?.game?.scene?.getScene("GameScene");
      return !!s && !!s.tiles && s.tiles.flat().filter(Boolean).length > 0;
    } catch { return false; }
  }, null, { timeout: 60000 });
  const frameState = await page.evaluate(() => {
    const frame = document.querySelector("#gameFrame");
    const s = frame.contentWindow.game.scene.getScene("GameScene");
    return {
      tiles: s.tiles.flat().filter(Boolean).length,
      mode: s.mode,
      scores: s.scores,
      activePlayer: s.activePlayer,
    };
  });
  check("W3 the embedded game client renders the watched match in the iframe",
    frameState.tiles > 0, frameState);
  await page.screenshot({ path: "evidence-r4-watch-embed.png" });

  // 4. The AI-vs-AI demo must actually progress while being watched (snapshots keep flowing).
  //    The demo opens with a study phase, so watch for up to 75s for a turn/score/attempt change.
  const snap = () => page.evaluate(() => {
    const s = document.querySelector("#gameFrame").contentWindow.game.scene.getScene("GameScene");
    return {
      status: s.onlineState?.status ?? null,
      active: s.onlineState?.activePlayerNumber ?? null,
      turn: s.turnNumber ?? null,
      scores: s.scores.join(","),
      attempts: s.totalAttempts ?? null,
      over: s.gameOver,
    };
  });
  const first = await snap();
  let progressed = false, last = first;
  for (let i = 0; i < 75 && !progressed; i++) {
    await wait(1000);
    last = await snap().catch(() => last);
    if (last.scores !== first.scores || last.active !== first.active ||
        last.turn !== first.turn || last.attempts !== first.attempts) progressed = true;
  }
  check("W4 the watched match progresses live (turn, attempts or score changed while watching)",
    progressed, { first, last });

  check("W5 no uncaught page errors during the whole watch session", errors.length === 0, errors);
  await context.close();
} finally {
  await browser.close();
}
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0) process.exit(1);
