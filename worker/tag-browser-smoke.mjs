import assert from "node:assert/strict";
import { chromium } from "playwright";

const PAGE_URL = process.env.SHAPEY_BROWSER_URL ||
  "http://127.0.0.1:8080/staging/index.html?api=http://127.0.0.1:8787";
const TIMEOUT = 45_000;
const pageErrors = [];
const consoleErrors = [];

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
      readyState: document.readyState,
      phaserAvailable: typeof window.Phaser !== "undefined",
      gameCreated: Boolean(window.game),
      canvasCount: document.querySelectorAll("canvas").length,
      bootOverlayPresent: Boolean(document.getElementById("boot")),
      activeScenes: window.game?.scene?.getScenes(true).map((scene) => scene.scene.key),
      lobbyMode: window.game?.scene?.getScene("MenuScene")?.onlineMode,
      lobbySeat: window.game?.scene?.getScene("MenuScene")?.onlinePlayerNumber,
      status: window.game?.scene?.getScene("MenuScene")?.onlineStatus?.text,
      gameState: window.game?.scene?.getScene("GameScene")?.onlineState?.status,
      activePlayer: window.game?.scene?.getScene("GameScene")?.onlineState?.activePlayerNumber,
    })).catch(() => null);
    throw new Error("Timed out waiting for " + description + ". Browser state: " +
      JSON.stringify(info) + ". Page errors: " + JSON.stringify(pageErrors.slice(-8)) +
      ". Console errors: " + JSON.stringify(consoleErrors.slice(-8)) +
      ". Original error: " + error.message);
  });
}

async function chooseTag(page) {
  await waitForScene(page, () =>
    Boolean(window.game?.scene?.getScenes(true).some((scene) => scene.scene.key === "MenuScene")),
    "mode menu");
  await clickWorld(page, 360, 1095);
  await waitForScene(page, () =>
    window.game?.scene?.getScene("MenuScene")?.onlineMode === "tag",
    "online Tag room lobby");
}

async function run() {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const contexts = await Promise.all(Array.from({ length: 4 }, () =>
    browser.newContext({ viewport: { width: 720, height: 1280 } })));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  for (const page of pages) {
    page.on("pageerror", (error) => {
      pageErrors.push(`${page.url()}: ${error.message}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(`${page.url()}: ${message.text()}`);
    });
  }

  try {
    // Four simultaneous Phaser/WebGL boots can starve a CI runner during asset decoding.
    // Bring each page fully to the menu before starting the next; this tests all four devices
    // while avoiding a false "no active scene" timeout caused by concurrent cold starts.
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index];
      await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
      await waitForScene(page, () =>
        Boolean(window.game?.scene?.getScenes(true).some((scene) => scene.scene.key === "MenuScene")),
      `mode menu ready for Tag Player ${index + 1}`);
    }
    await Promise.all(pages.map(chooseTag));

    await clickWorld(pages[0], 360, 710); // Player 1 creates the Tag room.
    await waitForScene(pages[0], () =>
      Boolean(window.game?.scene?.getScene("MenuScene")?.currentRoomCode),
      "created Tag room code");
    const roomCode = await pages[0].evaluate(() =>
      window.game.scene.getScene("MenuScene").currentRoomCode);

    // Each additional browser context joins as a separate device using the custom
    // room-code dialog now shown by the game (not the old browser prompt()).
    for (let index = 1; index < 4; index++) {
      const page = pages[index];
      await clickWorld(page, 360, 810);
      const joinDialog = page.locator("#shapey-join-modal");
      await joinDialog.waitFor({ state: "visible", timeout: 5_000 });
      await joinDialog.locator('input[aria-label="Room code"]').fill(roomCode);
      await joinDialog.getByRole("button", { name: "JOIN", exact: true }).click();
      const expectedPlayer = index + 1;
      await waitForScene(page, (expected) =>
        window.game?.scene?.getScene("MenuScene")?.onlinePlayerNumber === expected,
      "Tag Player " + expectedPlayer + " seat assignment", 15_000, expectedPlayer);
    }

    await Promise.all(pages.map((page, index) =>
      waitForScene(page, (expectedPlayer) => {
        const scene = window.game?.scene?.getScene("GameScene");
        return scene?.online === true &&
          scene.onlinePlayerNumber === expectedPlayer &&
          ["study", "playing"].includes(scene.onlineState?.status);
      }, "Tag Player " + (index + 1) + " initial board", TIMEOUT, index + 1)));
    await Promise.all(pages.map((page, index) =>
      waitForScene(page, (expectedPlayer) => {
        const scene = window.game?.scene?.getScene("GameScene");
        return scene?.online === true &&
          scene.onlinePlayerNumber === expectedPlayer &&
          scene.onlineState?.status === "playing";
      }, "Tag Player " + (index + 1) + " turn start", 35_000, index + 1)));

    for (const step of [
      { actorPlayer: 1, actorIndex: 0, nextPlayer: 3, nextLabel: "TEAM 2: PLAYER 3" },
      { actorPlayer: 3, actorIndex: 2, nextPlayer: 2, nextLabel: "TEAM 1: PLAYER 2" },
      { actorPlayer: 2, actorIndex: 1, nextPlayer: 4, nextLabel: "TEAM 2: PLAYER 4" },
      { actorPlayer: 4, actorIndex: 3, nextPlayer: 1, nextLabel: "TEAM 1: PLAYER 1" }
    ]) {
      const actor = pages[step.actorIndex];
      const oldRevision = await actor.evaluate(() =>
        window.game.scene.getScene("GameScene").onlineState.revision);
      await clickWorld(actor, 296, 1141); // Existing Submit button, with no tiles selected.
      const expectedAfterTurn = {
        revision: oldRevision,
        nextPlayer: step.nextPlayer,
        nextLabel: step.nextLabel
      };
      await Promise.all(pages.map((page) =>
        waitForScene(page, (expected) => {
          const scene = window.game?.scene?.getScene("GameScene");
          const state = scene?.onlineState;
          return state?.revision > expected.revision &&
            state?.activePlayerNumber === expected.nextPlayer &&
            state?.scores?.[0] === 0 && state?.scores?.[1] === 0 &&
            scene?.goalText?.text === expected.nextLabel;
        }, "Tag handoff " + step.actorPlayer + " → " + step.nextPlayer, 10_000, expectedAfterTurn)));
    }

    assert.deepEqual(pageErrors, [], "No uncaught browser exceptions should occur.");
    console.log("Four-browser Tag smoke test passed: four separate browser contexts joined, started one shared game, and the UI synchronized P1 → P3 → P2 → P4 → P1.");
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});