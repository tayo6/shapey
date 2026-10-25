// In-browser verification of the agreed Shapey Hazard rules (review package, rev 3).
// Drives the real GameScene in headless Chromium against the locally served build.
//
// PLACEMENT: this folder must live INSIDE the repository checkout (as <repo>/verification/)
// so that the Playwright import below resolves to the repo's own worker/node_modules.
// Prerequisite: cd worker && npm ci   (installs playwright 1.64.0 from the lockfile)
// Server needed: a static file server on 127.0.0.1:8080 serving the repo root.
// Paths verified:
//   A. Play Alone, Hazard picked first  -> -1 point, hazard destroyed, play continues
//   B. Play Alone, Dummy then Hazard    -> exactly -1 more (dummy never adds its own penalty)
//   C. Versus AI, Hazard picked first   -> 0 points, hazard destroyed, turn passes to the AI
//   D. Versus AI, shapes then Hazard    -> 0 points (no versus penalty), all picked destroyed,
//                                          turn passes to the AI
import { chromium } from "../worker/node_modules/playwright/index.mjs";

const BASE = "http://127.0.0.1:8080/";
const errors = [];

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function freshPage(browser, url) {
  const context = await browser.newContext({ viewport: { width: 720, height: 1280 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push("[" + url + "] " + e.message));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() =>
    window.game?.scene?.getScenes(true).some((s) => s.scene.key === "GameScene"), null, { timeout: 30000 });
  await waitFullySettled(page);
  return { context, page };
}

// Board is fully refilled, idle, and every tile is face-down.
async function waitFullySettled(page) {
  await page.waitForFunction(() => {
    const scene = window.game.scene.getScene("GameScene");
    if (scene.busy || scene.turnEnding || scene.gameOver) return false;
    if (!scene.tiles || scene.tiles.length !== 7) return false;
    return scene.tiles.every((row) => row.length === 7 && row.every((t) => t && !t.faceUp));
  }, null, { timeout: 30000 });
}

async function setShape(page, r, c, shape) {
  return page.evaluate(([row, col, s]) => {
    const scene = window.game.scene.getScene("GameScene");
    const tile = scene.tiles[row][col];
    tile.shape = s;
    tile.probe = true; // identity marker: destroyed tiles must not survive the blast
    return tile.shape;
  }, [r, c, shape]);
}

async function tapTile(page, r, c) {
  await page.evaluate(([row, col]) => {
    const scene = window.game.scene.getScene("GameScene");
    scene.onTileTap(scene.tiles[row][col]);
  }, [r, c]);
}

async function snapshot(page) {
  return page.evaluate(() => {
    const scene = window.game.scene.getScene("GameScene");
    let count = 0;
    let probed = 0;
    for (const row of scene.tiles) for (const t of row) if (t) { count++; if (t.probe) probed++; }
    return {
      scores: scene.scores.slice(),
      activePlayer: scene.activePlayer,
      turnEnding: scene.turnEnding,
      busy: scene.busy,
      gameOver: scene.gameOver,
      tileCount: count,
      probedSurvivors: probed,
      selection: scene.selection.length,
      dummySelection: scene.dummySelection.length,
    };
  });
}

async function settle(page, ms) { await wait(ms); return snapshot(page); }

const SCREENSHOTS = process.env.SHAPEY_EVIDENCE_DIR || null;
async function shoot(page, name) {
  if (!SCREENSHOTS) return;
  await page.screenshot({ path: SCREENSHOTS + "/" + name, fullScreen: false });
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? "PASS" : "FAIL") + " - " + name + " :: " + JSON.stringify(detail));
}

try {
  // ---------------- Play Alone ----------------
  {
    const { context, page } = await freshPage(browser, BASE + "?mode=alone&review=1000");
    const before = await snapshot(page);
    // A: first-pick hazard
    await setShape(page, 0, 0, "hazard");
    await tapTile(page, 0, 0);
    const a = await settle(page, 3500);
    record("A alone/first-pick hazard: -1 point", a.scores[0] === before.scores[0] - 1, a);
    record("A alone/first-pick hazard: hazard destroyed itself (board refilled)",
      a.probedSurvivors === 0 && a.tileCount === 49, a);
    record("A alone/first-pick hazard: play continues (no game over, idle)",
      !a.gameOver && !a.turnEnding && !a.busy && a.selection === 0, a);
    await shoot(page, "evidence-hazard-alone-minus1.png");
    await waitFullySettled(page);

    // B: dummy then hazard -> exactly one more point lost (the hazard's own)
    const bBefore = await snapshot(page);
    await setShape(page, 1, 1, "dummy");
    await setShape(page, 2, 2, "hazard");
    await tapTile(page, 1, 1);
    const picked = await settle(page, 500);
    record("B alone/dummy+hazard: dummy is picked and held", picked.dummySelection === 1, picked);
    await tapTile(page, 2, 2);
    const b = await settle(page, 3500);
    record("B alone/dummy+hazard: exactly -1 more (hazard's own penalty)",
      b.scores[0] === bBefore.scores[0] - 1, { before: bBefore.scores, after: b.scores });
    record("B alone/dummy+hazard: both tiles destroyed (board refilled)",
      b.probedSurvivors === 0 && b.tileCount === 49,
      { probedSurvivors: b.probedSurvivors, tileCount: b.tileCount });
    await context.close();
  }

  // ---------------- Versus AI (Easy) ----------------
  {
    const { context, page } = await freshPage(browser, BASE + "?mode=ai&review=1000");
    await page.waitForFunction(() => {
      const scene = window.game.scene.getScene("GameScene");
      return scene.activePlayer === 0 && !scene.busy && !scene.turnEnding && !scene.gameOver;
    }, null, { timeout: 30000 });
    await waitFullySettled(page);

    const before = await snapshot(page);
    // C: first-pick hazard in a versus mode
    await setShape(page, 0, 5, "hazard");
    await tapTile(page, 0, 5);
    const c = await settle(page, 3500);
    record("C versus/first-pick hazard: no point lost", c.scores[0] === before.scores[0] &&
      c.scores[1] === before.scores[1], c);
    record("C versus/first-pick hazard: hazard destroyed itself (board refilled)",
      c.probedSurvivors === 0 && c.tileCount === 49, c);
    record("C versus/first-pick hazard: turn handed to the AI", c.activePlayer === 1, c);

    // Wait for the AI's 5-second turn to run and hand back - game must continue normally.
    await page.waitForFunction(() => {
      const scene = window.game.scene.getScene("GameScene");
      return scene.activePlayer === 0 && !scene.busy && !scene.turnEnding && !scene.gameOver;
    }, null, { timeout: 25000 });
    record("C versus/after AI turn: control returns to the player, game alive",
      (await snapshot(page)).activePlayer === 0, await snapshot(page));
    await waitFullySettled(page);

    // D: shapes then hazard in a versus mode - destroys all picked, NO penalty, turn passes
    const dBefore = await snapshot(page);
    await setShape(page, 1, 3, "circle");
    await setShape(page, 2, 4, "circle");
    await setShape(page, 3, 5, "hazard");
    await tapTile(page, 1, 3);
    await wait(400);
    await tapTile(page, 2, 4);
    await wait(400);
    await tapTile(page, 3, 5);
    const d = await settle(page, 3500);
    record("D versus/shapes+hazard: no point lost (no versus Hazard penalty)",
      d.scores[0] === dBefore.scores[0] && d.scores[1] === dBefore.scores[1],
      { before: dBefore.scores, after: d.scores });
    record("D versus/shapes+hazard: all three picked tiles destroyed (board refilled)",
      d.probedSurvivors === 0 && d.tileCount === 49,
      { probedSurvivors: d.probedSurvivors, tileCount: d.tileCount });
    record("D versus/shapes+hazard: turn handed to the AI", d.activePlayer === 1, d);
    await shoot(page, "evidence-hazard-versus-no-penalty.png");
    await context.close();
  }
} finally {
  await browser.close();
}

record("no uncaught page errors in any scenario", errors.length === 0, errors);
const failed = results.filter((r) => !r.pass);
console.log("\n" + (results.length - failed.length) + "/" + results.length + " checks passed");
if (failed.length) process.exit(1);
