// Feature-level verification of the Shapey refactor (review package, rev 4).
// Drives the REAL UI end to end in headless Chromium against the locally served build:
//
//   A. Loading screen: the HTML boot overlay (#boot) exists, its plank load-bar canvas
//      is created, and the game reaches MenuScene.
//   B. Menu + board-size selection + Play Alone on a 5x5 board (real clicks):
//      25 tiles (not 49), a 3-match pays exactly +1, destroyed tiles refill with the
//      falling spawn animation (tiles are observed mid-fall), a wrong shape costs -1.
//   C. Player vs AI on a 6x6 board (real clicks): the turn countdown ticks down,
//      submitting passes the turn to the AI, the AI turn lasts ~AI_TURN_MS (5s),
//      then control returns to the player.
//
// PLACEMENT: this folder must live INSIDE the repository checkout (as <repo>/verification/)
// so that the Playwright import below resolves to the repo's own worker/node_modules.
// Prerequisite: cd worker && npm ci   (installs playwright 1.64.0 from the lockfile)
// Server needed: a static file server on 127.0.0.1:8080 serving the repo root.
import { chromium } from "../worker/node_modules/playwright/index.mjs";

const BASE = "http://127.0.0.1:8080/index.html";
const errors = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS" : "FAIL") + " - " + name + (detail === undefined ? "" : " :: " + JSON.stringify(detail)));
  if (ok) pass++; else fail++;
}

async function clickWorld(page, x, y) {
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Phaser canvas not visible");
  await page.mouse.click(box.x + (x * box.width) / 720, box.y + (y * box.height) / 1280);
}

// Wait until the board is fully refilled, idle, every tile face-down, no reveal batch pending
// and no shuffle running - then confirm the state is still stable 600ms later, so a transient
// gap between the spawned-tile reveal and its shuffle can never be mistaken for "settled".
async function waitSettled(page, rows, cols, extra) {
  const pred = (n) => {
    const s = window.game.scene.getScene("GameScene");
    if (!s || s.busy || s.turnEnding || s.gameOver) return false;
    if (!s.tiles || s.tiles.length !== n.rows) return false;
    if (n.extra === "player" && (s.isAITurn && s.isAITurn())) return false;
    if (s.activeSwap || s.shuffling) return false; // a shuffle step/chain is in progress
    if (s.reveals && s.reveals.batches && s.reveals.batches.length) return false; // reveal still pending
    return s.tiles.every((row) => row.length === n.cols && row.every((t) => t && !t.faceUp && !t.swapping));
  };
  await page.waitForFunction(pred, { rows, cols, extra }, { timeout: 30000 });
  await wait(600);
  await page.waitForFunction(pred, { rows, cols, extra }, { timeout: 15000 });
  await wait(150);
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
  // ---------- A. loading screen ----------
  const context = await browser.newContext({ viewport: { width: 720, height: 1280 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push("[A] " + e.message));
  await page.goto(BASE + "?review=1000", { waitUntil: "domcontentloaded" });

  const bootAtStart = await page.evaluate(() => ({
    boot: !!document.getElementById("boot"),
    revealed: document.getElementById("boot")?.classList.contains("ready") || false,
    plankCanvas: !!document.getElementById("bootLoadRectangle"),
    logo: !!document.querySelector("#boot .logo"),
    bg: !!document.querySelector("#boot .bg"),
  }));
  check("A1 loading screen markup present at first paint (#boot + bg + logo + bar)",
    bootAtStart.boot && bootAtStart.logo && bootAtStart.bg, bootAtStart);
  // The plank reveal happens as soon as the boot assets decode (a few seconds at most on a
  // cold load); the overlay is then removed once Phaser takes over, so accept either state.
  const bootRevealed = await page.evaluate(async () => {
    for (let i = 0; i < 90; i++) {
      const boot = document.getElementById("boot");
      if (boot === null) return { revealed: true, plankCanvas: true, note: "overlay already removed (menu handoff)" };
      if (boot.classList.contains("ready") && document.getElementById("bootLoadRectangle")) {
        return { revealed: true, plankCanvas: true, note: "plank revealed" };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { revealed: false, plankCanvas: !!document.getElementById("bootLoadRectangle"), note: "not revealed within 9s" };
  });
  check("A2 loading screen revealed its artwork (boot.ready + plank load-bar canvas)",
    bootRevealed.revealed && bootRevealed.plankCanvas, bootRevealed);

  await page.waitForFunction(() =>
    window.game?.scene?.getScenes(true).some((s) => s.scene.key === "MenuScene"), null, { timeout: 45000 });
  const bootHandoff = await page.evaluate(() => ({
    bootRemoved: document.getElementById("boot") === null,
    phaserCanvas: document.querySelectorAll("canvas").length >= 1,
  }));
  check("A3 loading screen hands off cleanly (boot overlay removed once the menu is up)",
    bootHandoff.bootRemoved && bootHandoff.phaserCanvas, bootHandoff);
  await page.screenshot({ path: "evidence-r4-loading-menu.png" });

  // ---------- B. menu -> board size 5x5 -> Play Alone ----------
  await page.waitForFunction(() => window.game?.scene?.getScene("MenuScene")?.pickerUI !== undefined, null, { timeout: 10000 });
  await clickWorld(page, 360, 600); // PLAY ALONE (first mode button)
  await page.waitForFunction(() => window.game.scene.getScene("MenuScene").pickerUI.length > 0, null, { timeout: 10000 });
  check("B1 PLAY ALONE opens the CHOOSE BOARD SIZE picker", true);
  await page.screenshot({ path: "evidence-r4-board-size-picker.png" });

  await clickWorld(page, 360, 555); // 5 x 5
  await page.waitForFunction(() =>
    window.game?.scene?.getScenes(true).some((s) => s.scene.key === "GameScene"), null, { timeout: 30000 });
  await waitSettled(page, 5, 5);
  const dims = await page.evaluate(() => {
    const s = window.game.scene.getScene("GameScene");
    return { rows: s.tiles.length, cols: s.tiles[0].length, tiles: s.tiles.flat().length, mode: s.mode, boardSize: s.boardSize };
  });
  check("B2 choosing 5x5 starts Play Alone with a 25-tile board", dims.rows === 5 && dims.cols === 5 && dims.tiles === 25 && dims.mode === "alone", dims);
  await page.screenshot({ path: "evidence-r4-play-alone-5x5.png" });

  // Find a 3-match using the game's own MATCH_SHAPE_KEYS, then click the real tiles.
  const triple = await page.evaluate(async () => {
    const m = await import("/src/constants.js");
    const s = window.game.scene.getScene("GameScene");
    const counts = {};
    s.tiles.flat().forEach((t) => { counts[t.shape] = (counts[t.shape] || 0) + 1; });
    const shape = Object.keys(counts).find((k) => m.MATCH_SHAPE_KEYS.includes(k) && counts[k] >= 3);
    if (!shape) return null;
    return s.tiles.flat().filter((t) => t.shape === shape).slice(0, 3).map((t) => ({ x: t.x, y: t.y }));
  });
  if (!triple) throw new Error("no 3-match available on the 5x5 board");
  for (const t of triple) await clickWorld(page, t.x, t.y);
  await page.waitForFunction(() => window.game.scene.getScene("GameScene").selection.length === 3, null, { timeout: 10000 });
  const scoreBefore = await page.evaluate(() => window.game.scene.getScene("GameScene").scores[0]);

  const submitPos = await page.evaluate(() => {
    const b = window.game.scene.getScene("GameScene").buttons.btnSubmit;
    return { x: b.x, y: b.y - b.displayHeight / 2 };
  });
  await clickWorld(page, submitPos.x, submitPos.y);

  // Watch for the falling spawn animation while the board refills.
  let sawFallingTile = false;
  for (let i = 0; i < 60 && !sawFallingTile; i++) {
    sawFallingTile = await page.evaluate(() => {
      const s = window.game.scene.getScene("GameScene");
      return s.tiles.flat().some((t) => t && t.y < s.cellY(t.row) - 2);
    });
    await wait(40);
  }
  await waitSettled(page, 5, 5);
  const afterMatch = await page.evaluate(() => {
    const s = window.game.scene.getScene("GameScene");
    return { score: s.scores[0], tiles: s.tiles.flat().filter(Boolean).length, gameOver: s.gameOver };
  });
  check("B3 a submitted 3-match scores exactly +1 in Play Alone", afterMatch.score === scoreBefore + 1, { before: scoreBefore, after: afterMatch.score });
  check("B4 board refilled to 25 tiles after the match", afterMatch.tiles === 25 && !afterMatch.gameOver, afterMatch);
  check("B5 spawn animation: new tiles observed mid-fall into their slots", sawFallingTile);

  // Wrong shape: pick 2 of one shape, then 1 of another. The mismatch resolves on the
  // pick itself (flip back + penalty) - no submit involved. Play Alone loses 1 point.
  const pair = await page.evaluate(async () => {
    const m = await import("/src/constants.js");
    const s = window.game.scene.getScene("GameScene");
    const counts = {};
    s.tiles.flat().forEach((t) => { counts[t.shape] = (counts[t.shape] || 0) + 1; });
    const a = Object.keys(counts).find((k) => m.MATCH_SHAPE_KEYS.includes(k) && counts[k] >= 2);
    const b = Object.keys(counts).find((k) => m.MATCH_SHAPE_KEYS.includes(k) && k !== a);
    if (!a || !b) return null;
    const pick = s.tiles.flat().filter((t) => t.shape === a).slice(0, 2)
      .concat(s.tiles.flat().filter((t) => t.shape === b).slice(0, 1));
    return pick.map((t) => ({ x: t.x, y: t.y }));
  });
  if (!pair) throw new Error("no wrong-shape combination available");
  const beforeWrong = await page.evaluate(() => window.game.scene.getScene("GameScene").scores[0]);
  await clickWorld(page, pair[0].x, pair[0].y);
  await clickWorld(page, pair[1].x, pair[1].y);
  await page.waitForFunction(() => window.game.scene.getScene("GameScene").selection.length === 2, null, { timeout: 10000 });
  await clickWorld(page, pair[2].x, pair[2].y); // the mismatched shape resolves on pick
  await waitSettled(page, 5, 5);
  const afterWrong = await page.evaluate(() => {
    const s = window.game.scene.getScene("GameScene");
    return { score: s.scores[0], selection: s.selection.length };
  });
  check("B6 a wrong shape in Play Alone costs exactly -1 (and the picks flip back)",
    afterWrong.score === beforeWrong - 1 && afterWrong.selection === 0, { before: beforeWrong, after: afterWrong });
  await context.close();

  // ---------- C. menu -> board size 6x6 -> EASY -> Player vs AI ----------
  const ctx2 = await browser.newContext({ viewport: { width: 720, height: 1280 } });
  const page2 = await ctx2.newPage();
  page2.on("pageerror", (e) => errors.push("[C] " + e.message));
  await page2.goto(BASE + "?review=1000", { waitUntil: "domcontentloaded" });
  await page2.waitForFunction(() =>
    window.game?.scene?.getScenes(true).some((s) => s.scene.key === "MenuScene"), null, { timeout: 45000 });
  await clickWorld(page2, 360, 765);  // PLAYER VS AI (second mode button)
  await page2.waitForFunction(() => window.game.scene.getScene("MenuScene").pickerUI.length > 0, null, { timeout: 10000 });
  await clickWorld(page2, 360, 700);  // 6 x 6
  await page2.waitForFunction(() => window.game.scene.getScene("MenuScene").pickerUI.length > 0, null, { timeout: 10000 });
  await clickWorld(page2, 360, 530);  // EASY (first difficulty)
  await page2.waitForFunction(() =>
    window.game?.scene?.getScenes(true).some((s) => s.scene.key === "GameScene"), null, { timeout: 30000 });
  await waitSettled(page2, 6, 6, "player");
  const dims2 = await page2.evaluate(() => {
    const s = window.game.scene.getScene("GameScene");
    return { mode: s.mode, difficulty: s.difficulty, tiles: s.tiles.flat().length, hasClock: !!s.turnClock };
  });
  check("C1 PLAYER VS AI + 6x6 + EASY starts with a 36-tile board and a turn clock",
    dims2.mode === "ai" && dims2.tiles === 36 && dims2.hasClock, dims2);
  await page2.screenshot({ path: "evidence-r4-versus-ai-6x6.png" });

  // Countdown ticks down in real time.
  const r1 = await page2.evaluate(() => window.game.scene.getScene("GameScene").turnClock.remaining());
  await wait(900);
  const r2 = await page2.evaluate(() => window.game.scene.getScene("GameScene").turnClock.remaining());
  check("C2 turn countdown is running (remaining time decreases)", r2 < r1 && r1 > 0, { first: r1, second: r2 });

  // Player match -> submit -> turn passes to the AI.
  const triple2 = await page2.evaluate(async () => {
    const m = await import("/src/constants.js");
    const s = window.game.scene.getScene("GameScene");
    const counts = {};
    s.tiles.flat().forEach((t) => { counts[t.shape] = (counts[t.shape] || 0) + 1; });
    const shape = Object.keys(counts).find((k) => m.MATCH_SHAPE_KEYS.includes(k) && counts[k] >= 3);
    if (!shape) return null;
    return s.tiles.flat().filter((t) => t.shape === shape).slice(0, 3).map((t) => ({ x: t.x, y: t.y }));
  });
  if (!triple2) throw new Error("no 3-match available on the 6x6 board");
  for (const t of triple2) await clickWorld(page2, t.x, t.y);
  await page2.waitForFunction(() => window.game.scene.getScene("GameScene").selection.length === 3, null, { timeout: 10000 });
  const submit2 = await page2.evaluate(() => {
    const b = window.game.scene.getScene("GameScene").buttons.btnSubmit;
    return { x: b.x, y: b.y - b.displayHeight / 2 };
  });
  await clickWorld(page2, submit2.x, submit2.y);

  await page2.waitForFunction(() => {
    const s = window.game.scene.getScene("GameScene");
    return s.activePlayer === 1 && !s.busy && !s.turnEnding;
  }, null, { timeout: 30000 });
  check("C3 submitting passes the turn to the AI (activePlayer 1)", true);

  // The AI's turn is a fixed 5 seconds (AI_TURN_MS), then control returns.
  const t0 = Date.now();
  await page2.waitForFunction(() => {
    const s = window.game.scene.getScene("GameScene");
    return s.activePlayer === 0 && !s.busy && !s.turnEnding && !s.gameOver;
  }, null, { timeout: 60000 });
  const aiMs = Date.now() - t0;
  check("C4 the AI turn lasts about its fixed 5 seconds (AI_TURN_MS)", aiMs >= 3500 && aiMs <= 12000, { measuredMs: aiMs, expectedMs: 5000 });
  check("C5 control returns to the player after the AI turn", true);
  await page2.screenshot({ path: "evidence-r4-versus-ai-back-to-player.png" });
  await ctx2.close();

  // ---------- D. versus PRO AI (exercises the spare-time/goBig branch, patch 0003) ----------
  const ctx3 = await browser.newContext({ viewport: { width: 720, height: 1280 } });
  const page3 = await ctx3.newPage();
  page3.on("pageerror", (e) => errors.push("[D] " + e.message));
  await page3.goto(BASE + "?review=1000", { waitUntil: "domcontentloaded" });
  await page3.waitForFunction(() =>
    window.game?.scene?.getScenes(true).some((s) => s.scene.key === "MenuScene"), null, { timeout: 45000 });
  await clickWorld(page3, 360, 765);  // PLAYER VS AI
  await page3.waitForFunction(() => window.game.scene.getScene("MenuScene").pickerUI.length > 0, null, { timeout: 10000 });
  await clickWorld(page3, 360, 845);  // 7 x 7
  await page3.waitForFunction(() => window.game.scene.getScene("MenuScene").pickerUI.length > 0, null, { timeout: 10000 });
  await clickWorld(page3, 360, 720);  // HARD (the PRO level: goBig = true)
  await page3.waitForFunction(() =>
    window.game?.scene?.getScenes(true).some((s) => s.scene.key === "GameScene"), null, { timeout: 30000 });
  await waitSettled(page3, 7, 7, "player");
  const dims3 = await page3.evaluate(() => {
    const s = window.game.scene.getScene("GameScene");
    return { mode: s.mode, difficulty: s.difficulty, tiles: s.tiles.flat().length };
  });
  check("D1 PLAYER VS AI + 7x7 + HARD (pro) starts with a 49-tile board",
    dims3.mode === "ai" && dims3.difficulty === "pro" && dims3.tiles === 49, dims3);

  // Let the PRO AI take one full turn: its pick loop runs the spare-time checks on every
  // candidate (the code path patch 0003 un-deadened by lowering AI_SPARE_MS to 2000).
  const triple3 = await page3.evaluate(async () => {
    const m = await import("/src/constants.js");
    const s = window.game.scene.getScene("GameScene");
    const counts = {};
    s.tiles.flat().forEach((t) => { counts[t.shape] = (counts[t.shape] || 0) + 1; });
    const shape = Object.keys(counts).find((k) => m.MATCH_SHAPE_KEYS.includes(k) && counts[k] >= 3);
    if (!shape) return null;
    return s.tiles.flat().filter((t) => t.shape === shape).slice(0, 3).map((t) => ({ x: t.x, y: t.y }));
  });
  if (!triple3) throw new Error("no 3-match available on the 7x7 board");
  for (const t of triple3) await clickWorld(page3, t.x, t.y);
  await page3.waitForFunction(() => window.game.scene.getScene("GameScene").selection.length === 3, null, { timeout: 10000 });
  const submit3 = await page3.evaluate(() => {
    const b = window.game.scene.getScene("GameScene").buttons.btnSubmit;
    return { x: b.x, y: b.y - b.displayHeight / 2 };
  });
  await clickWorld(page3, submit3.x, submit3.y);
  await page3.waitForFunction(() => {
    const s = window.game.scene.getScene("GameScene");
    return s.activePlayer === 1 && !s.busy && !s.turnEnding;
  }, null, { timeout: 30000 });
  const d0 = Date.now();
  await page3.waitForFunction(() => {
    const s = window.game.scene.getScene("GameScene");
    return s.activePlayer === 0 && !s.busy && !s.turnEnding && !s.gameOver;
  }, null, { timeout: 60000 });
  const proMs = Date.now() - d0;
  check("D2 the PRO AI plays its full turn (spare-time pick loop) and returns control",
    proMs >= 3500 && proMs <= 15000, { measuredMs: proMs });
  await page3.screenshot({ path: "evidence-r4-versus-pro-ai.png" });
  await ctx3.close();

  check("Z no uncaught page errors in any scenario", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail > 0 || errors.length) process.exit(1);
