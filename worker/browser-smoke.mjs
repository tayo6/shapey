import assert from "node:assert/strict";
import { chromium } from "playwright";

const PAGE_URL = process.env.SHAPEY_BROWSER_URL ||
  "http://127.0.0.1:8080/staging/index.html?api=http://127.0.0.1:8787";
const TIMEOUT = 45_000;

async function clickWorld(page, x, y) {
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  assert.ok(box, "Phaser canvas must be visible.");
  await page.mouse.click(box.x + x * box.width / 720, box.y + y * box.height / 1280);
}

async function waitForScene(page, predicate, description, timeout = TIMEOUT, arg = null) {
  await page.waitForFunction(predicate, arg, { timeout }).catch(async (error) => {
    const info = await page.evaluate(() => ({
      url: location.href,
      activeScenes: window.game?.scene?.getScenes(true).map((scene) => scene.scene.key),
      lobbyMode: window.game?.scene?.getScene("MenuScene")?.onlineMode,
      status: window.game?.scene?.getScene("MenuScene")?.onlineStatus?.text,
      roomCode: window.game?.scene?.getScene("MenuScene")?.currentRoomCode,
      gameState: window.game?.scene?.getScene("GameScene")?.onlineState?.status
    })).catch(() => null);
    throw new Error("Timed out waiting for " + description + ". Browser state: " +
      JSON.stringify(info) + ". Original error: " + error.message);
  });
}

async function choosePvp(page) {
  await waitForScene(page, () =>
    Boolean(window.game?.scene?.getScenes(true).some((scene) => scene.scene.key === "MenuScene")),
    "mode menu");
  await clickWorld(page, 360, 930);
  await waitForScene(page, () =>
    window.game?.scene?.getScene("MenuScene")?.onlineMode === "pvp",
    "PvP room lobby");
}

async function run() {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context1 = await browser.newContext({ viewport: { width: 720, height: 1280 } });
  const context2 = await browser.newContext({ viewport: { width: 720, height: 1280 } });
  const page1 = await context1.newPage();
  const page2 = await context2.newPage();
  const pageErrors = [];
  for (const page of [page1, page2]) {
    page.on("pageerror", (error) => pageErrors.push(error.message));
  }

  try {
    await Promise.all([
      page1.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT }),
      page2.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT })
    ]);
    await Promise.all([choosePvp(page1), choosePvp(page2)]);

    await clickWorld(page1, 360, 710);
    await waitForScene(page1, () =>
      Boolean(window.game?.scene?.getScene("MenuScene")?.currentRoomCode),
      "created PvP room code");
    const roomCode = await page1.evaluate(() =>
      window.game.scene.getScene("MenuScene").currentRoomCode);

    // Return the known room code from inside the second browser instead of using a native
    // prompt dialog. This keeps the test deterministic while still clicking the real JOIN ROOM UI.
    await page2.evaluate((code) => {
      window.prompt = () => code;
    }, roomCode);
    await clickWorld(page2, 360, 810);
    await waitForScene(page2, () =>
      window.game?.scene?.getScene("MenuScene")?.onlineStatus?.text?.includes("Room connected as Player 2"),
      "second browser joined as Player 2", 15_000);

    await Promise.all([
      waitForScene(page1, () => window.game?.scene?.getScene("GameScene")?.online === true &&
        window.game.scene.getScene("GameScene").onlineState?.status === "study",
        "Player 1 online study board"),
      waitForScene(page2, () => window.game?.scene?.getScene("GameScene")?.online === true &&
        window.game.scene.getScene("GameScene").onlineState?.status === "study",
        "Player 2 online study board")
    ]);

    const triple = await page1.evaluate(() => {
      const scene = window.game.scene.getScene("GameScene");
      const groups = new Map();
      for (const tile of scene.onlineState.tiles) {
        if (!tile.shape || tile.shape === "hazard" || tile.shape === "dummy") continue;
        if (!groups.has(tile.shape)) groups.set(tile.shape, []);
        groups.get(tile.shape).push({ id: tile.id, row: tile.row, col: tile.col });
      }
      for (const [shape, tiles] of groups) {
        if (tiles.length >= 3) return { shape, tiles: tiles.slice(0, 3) };
      }
      return null;
    });
    assert.ok(triple, "The opening board must offer at least one matching triple.");

    // The server's 15-second study phase is shared by both devices.
    await Promise.all([
      waitForScene(page1, () => window.game?.scene?.getScene("GameScene")?.onlineState?.status === "playing",
        "PvP turn start", 35_000),
      waitForScene(page2, () => window.game?.scene?.getScene("GameScene")?.onlineState?.status === "playing",
        "second PvP client turn start", 35_000)
    ]);

    const cellPositions = await page1.evaluate((tiles) => {
      const scene = window.game.scene.getScene("GameScene");
      return tiles.map((item) => ({
        id: item.id,
        x: scene.cellX(item.col),
        y: scene.cellY(item.row)
      }));
    }, triple.tiles);

    for (let index = 0; index < cellPositions.length; index++) {
      const tile = cellPositions[index];
      await clickWorld(page1, tile.x, tile.y);
      await waitForScene(page1, (expected) => {
        const state = window.game?.scene?.getScene("GameScene")?.onlineState;
        return state?.selectedTileIds?.length === expected;
      }, "server-confirmed tile selection " + (index + 1), 10_000, index + 1);
    }

    await clickWorld(page1, 296, 1141); // Submit button on the existing 720 × 1280 board.
    await Promise.all([
      waitForScene(page1, () => {
        const state = window.game?.scene?.getScene("GameScene")?.onlineState;
        return state?.scores?.[0] === 1 && state?.activePlayerNumber === 2;
      }, "Player 1 score and turn handover"),
      waitForScene(page2, () => {
        const state = window.game?.scene?.getScene("GameScene")?.onlineState;
        return state?.scores?.[0] === 1 && state?.activePlayerNumber === 2;
      }, "matching score update on Player 2 device")
    ]);

    assert.deepEqual(pageErrors, [], "No uncaught browser exceptions should occur.");
    console.log("Browser PvP smoke test passed: two separate browser contexts joined one room, shared the same board, scored one match, and synchronized the next turn.");
  } finally {
    await Promise.all([context1.close(), context2.close()]);
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});