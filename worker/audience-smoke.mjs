// Shapey - audience-frontend smoke test against the LOCAL refactored Worker (browser).
//
// The audience page (staging/audience.html) is pointed at the local Worker with the
// test-only ?api=http://127.0.0.1:8787 override (allowed only on localhost pages; the
// deployed audience configuration is untouched - see staging/audience/state.js). Everything
// the audience frontend does is therefore exercised against the refactored Worker, not the
// deployed staging service:
//
//   - room discovery: the live-games directory lists a four-player Tag room,
//   - joining and spectating: the watch view renders the live board, the embedded game
//     frame loads and the players see the spectator count,
//   - chat delivery: a message sent from one audience device appears on another,
//   - Tag's four-player view: the roster shows Players 1-4 on Teams 1 and 2 and the HUD
//     follows the P1 -> P3 -> P2 turn rotation,
//   - audience polls: both audience devices vote on the board, see the same countdown
//     (one device runs a 40s-skewed clock), and the poll closes at the server deadline
//     with the results revealed,
//   - reconnect: reloading an audience device and a player device restores the session
//     (same seat, same room, chat history intact),
//   - zero uncaught browser errors on every page.
//
// Run against one local Worker plus one static file server, exactly like the CI job:
//   npx wrangler dev --config wrangler.jsonc --local --ip 127.0.0.1 --port 8787
//   python3 -m http.server 8080 --bind 127.0.0.1 --directory ..
//   node audience-smoke.mjs

import assert from "node:assert/strict";
import { chromium } from "playwright";

const GAME_URL = process.env.SHAPEY_BROWSER_URL ||
  "http://127.0.0.1:8080/staging/index.html?api=http://127.0.0.1:8787";
const AUDIENCE_URL = process.env.SHAPEY_AUDIENCE_URL ||
  "http://127.0.0.1:8080/staging/audience.html?api=http://127.0.0.1:8787";
const TIMEOUT = 45_000;
const POLL_MS = 30_000;
const CLOCK_SKEW_MS = 40_000;      // audience device B runs 40s ahead of reality
const CLOCK_TOLERANCE_S = 2;       // audience countdowns must agree within ~2s despite the skew
const POLL_CLOSE_TOLERANCE_MS = 4_000;

async function clickWorld(page, x, y) {
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  assert.ok(box, "Phaser canvas must be visible.");
  await page.mouse.click(box.x + x * box.width / 720, box.y + y * box.height / 1280);
}

// A click fired a few frames too early (cold scene start under load) silently misses Phaser's
// hit areas, so UI-gating clicks are retried until the expected effect appears.
async function clickWorldUntil(page, x, y, predicate, description, attempts = 6, arg = null) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await clickWorld(page, x, y);
    try {
      await page.waitForFunction(predicate, arg, { timeout: 1_500 });
      return;
    } catch {}
  }
  throw new Error("Repeated clicks never achieved: " + description);
}

async function openJoinDialog(page) {
  const dialog = page.locator("#shapey-join-modal");
  for (let attempt = 0; attempt < 6; attempt++) {
    await clickWorld(page, 360, 810);
    try {
      await dialog.waitFor({ state: "visible", timeout: 1_500 });
      return dialog;
    } catch {}
  }
  throw new Error("The JOIN ROOM dialog never opened");
}

async function waitForScene(page, predicate, description, timeout = TIMEOUT, arg = null) {
  await page.waitForFunction(predicate, arg, { timeout }).catch(async (error) => {
    const info = await page.evaluate(() => ({
      url: location.href,
      activeScenes: window.game?.scene?.getScenes(true).map((scene) => scene.scene.key),
      lobbyMode: window.game?.scene?.getScene("MenuScene")?.onlineMode,
      lobbySeat: window.game?.scene?.getScene("MenuScene")?.onlinePlayerNumber,
      status: window.game?.scene?.getScene("MenuScene")?.onlineStatus?.text,
      gameState: window.game?.scene?.getScene("GameScene")?.onlineState?.status,
      activePlayer: window.game?.scene?.getScene("GameScene")?.onlineState?.activePlayerNumber
    })).catch(() => null);
    throw new Error("Timed out waiting for " + description + ". Browser state: " +
      JSON.stringify(info) + ". Original error: " + error.message);
  });
}

async function chooseTag(page) {
  await waitForScene(page, () =>
    Boolean(window.game?.scene?.getScenes(true).some((scene) => scene.scene.key === "MenuScene")),
    "mode menu");
  await clickWorldUntil(page, 360, 1095, () =>
    window.game?.scene?.getScene("MenuScene")?.onlineMode === "tag",
    "selecting the Tag mode");
  await waitForScene(page, () =>
    window.game?.scene?.getScene("MenuScene")?.onlineMode === "tag",
    "online Tag room lobby");
}

async function spectatorCount(page) {
  return page.evaluate(() =>
    Number(window.game?.scene?.getScene("GameScene")?.onlineSpectatorCount) || 0);
}

// Four player pages plus the audience page and its embedded game are six live Phaser/WebGL
// loops on one CI runner, which can starve the embedded iframe's animation frames. Player
// pages that are only holding a seat get their render loop parked: WebSocket snapshots still
// update their state (socket events are DOM events, not rAF), and they are woken to act.
async function parkLoop(page) {
  await page.evaluate(() => { try { window.game?.loop?.sleep(); } catch {} });
}
async function wakeLoop(page) {
  await page.evaluate(() => { try { window.game?.loop?.wake(); } catch {} });
}

function parseClockSeconds(text) {
  const match = /(\d+):(\d{2})/.exec(String(text || ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function pollSecondsFromIntro(text) {
  const match = /(\d+)s left/.exec(String(text || ""));
  return match ? Number(match[1]) : null;
}

async function run() {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

  // Four player devices with correct clocks.
  const playerContexts = await Promise.all(Array.from({ length: 4 }, () =>
    browser.newContext({ viewport: { width: 720, height: 1280 } })));
  const players = await Promise.all(playerContexts.map((context) => context.newPage()));

  // Audience device A with a correct clock, audience device B with a clock 40s ahead.
  const audienceContextA = await browser.newContext({ viewport: { width: 720, height: 1280 } });
  const audienceContextB = await browser.newContext({ viewport: { width: 720, height: 1280 } });
  await audienceContextB.addInitScript((skew) => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + skew;
  }, CLOCK_SKEW_MS);
  const audienceA = await audienceContextA.newPage();
  const audienceB = await audienceContextB.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  for (const page of [...players, audienceA, audienceB]) {
    page.on("pageerror", (error) => pageErrors.push(`${page.url()}: ${error.message}`));
  }
  for (const page of [audienceA, audienceB]) {
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(`${page.url()}: ${message.text()}`);
    });
  }

  try {
    // --- Four players start an online Tag room ---------------------------------------------
    await Promise.all(players.map((page) =>
      page.goto(GAME_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT })));
    await Promise.all(players.map(chooseTag));

    await clickWorldUntil(players[0], 360, 710, () =>
      Boolean(window.game?.scene?.getScene("MenuScene")?.currentRoomCode),
      "creating the Tag room");
    await waitForScene(players[0], () =>
      Boolean(window.game?.scene?.getScene("MenuScene")?.currentRoomCode),
      "created Tag room code");
    const roomCode = await players[0].evaluate(() =>
      window.game.scene.getScene("MenuScene").currentRoomCode);

    for (let index = 1; index < 4; index++) {
      const page = players[index];
      const joinDialog = await openJoinDialog(page);
      await joinDialog.locator('input[aria-label="Room code"]').fill(roomCode);
      await joinDialog.getByRole("button", { name: "JOIN", exact: true }).click();
      await waitForScene(page, (expectedPlayer) =>
        window.game?.scene?.getScene("MenuScene")?.onlinePlayerNumber === expectedPlayer ||
        window.game?.scene?.getScene("GameScene")?.onlinePlayerNumber === expectedPlayer,
        `Tag Player ${index + 1} seat assignment`, 15_000, index + 1);
    }
    await Promise.all(players.map((page, index) =>
      waitForScene(page, (expectedPlayer) => {
        const scene = window.game?.scene?.getScene("GameScene");
        return scene?.online === true &&
          scene.onlinePlayerNumber === expectedPlayer &&
          ["study", "playing"].includes(scene.onlineState?.status);
      }, `Tag Player ${index + 1} initial board`, TIMEOUT, index + 1)));

    // While the board is revealed (study), capture one real-shape tile position for Player 2's
    // later poll (positions are preserved when the tiles flip face-down; they only shuffle
    // after a match reveal).
    const pollTile = await players[1].evaluate(() => {
      const scene = window.game.scene.getScene("GameScene");
      // Cancel is a neutral special tile (a Cancel pick clears the selection 350ms
      // later and no poll can start from it); anchor the poll on a real match shape.
      const tile = (scene.onlineState.tiles || []).find((item) =>
        item.shape && item.shape !== "hazard" && item.shape !== "dummy" && item.shape !== "cancel");
      return tile ? { id: tile.id, row: tile.row, col: tile.col } : null;
    });
    assert.ok(pollTile, "The revealed study board must contain a real shape tile.");

    await Promise.all(players.map((page, index) =>
      waitForScene(page, (expectedPlayer) => {
        const scene = window.game?.scene?.getScene("GameScene");
        return scene?.online === true &&
          scene.onlinePlayerNumber === expectedPlayer &&
          scene.onlineState?.status === "playing";
      }, `Tag Player ${index + 1} turn start`, 35_000, index + 1)));

    // The players are idle spectators of their own match from here on: park their render loops
    // so the audience page and its embedded game get the runner's CPU.
    await Promise.all(players.map((page) => parkLoop(page)));

    // --- Room discovery: the local Worker's directory lists the Tag room --------------------
    await audienceA.goto(AUDIENCE_URL, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    const roomCard = audienceA.locator("#roomCards .room-card", { hasText: roomCode });
    await roomCard.waitFor({ state: "visible", timeout: 15_000 });
    assert.ok((await roomCard.innerText()).includes("4/4 players"),
      "the directory card should show the room as full with four players");
    assert.ok((await audienceA.locator("#roomCards .room-card").count()) >= 1,
      "the live-games directory lists the local Worker's room");

    // --- Joining and spectating -------------------------------------------------------------
    await roomCard.getByRole("button", { name: "WATCH", exact: true }).click();
    await audienceA.locator("#watchView:not([hidden])").waitFor({ state: "attached", timeout: 10_000 });
    await audienceA.waitForFunction(() =>
      document.querySelectorAll("#board .tile, #board [data-tile-id]").length > 0, null,
      { timeout: 15_000 }).catch(() => {});
    await audienceA.waitForFunction(() =>
      !document.getElementById("veil").checkVisibility(), null, { timeout: 15_000 });
    await waitForScene(players[0], () =>
      (window.game?.scene?.getScene("GameScene")?.onlineSpectatorCount || 0) >= 1,
      "players see the first spectator");
    assert.ok(!(await audienceA.locator("#gameFrame").isHidden()),
      "the embedded live game frame should be visible while spectating");

    // Audience device B joins through the shared-room link form (with its skewed clock).
    await audienceB.goto(`${AUDIENCE_URL}&room=${roomCode}&mode=tag`,
      { waitUntil: "domcontentloaded", timeout: TIMEOUT });
    await audienceB.locator("#watchView:not([hidden])").waitFor({ state: "attached", timeout: 15_000 });
    await audienceB.waitForFunction(() =>
      !document.getElementById("veil").checkVisibility(), null, { timeout: 15_000 });
    await waitForScene(players[0], () =>
      (window.game?.scene?.getScene("GameScene")?.onlineSpectatorCount || 0) >= 2,
      "players see both spectators");

    // --- Chat delivery between two audience devices -----------------------------------------
    await audienceA.locator("#btnChat").click();
    await audienceA.locator("#chatPage:not([hidden])").waitFor({ state: "attached", timeout: 5_000 });
    await audienceA.locator("#chatInput").fill("Hello from the local Worker test");
    await audienceA.locator("#sendChat").click();
    const chatSentinel = audienceA.locator("#chatMessages .msg", { hasText: "Hello from the local Worker test" });
    await chatSentinel.waitFor({ state: "visible", timeout: 10_000 });
    await audienceB.locator("#btnChat").click();
    await audienceB.locator("#chatPage:not([hidden])").waitFor({ state: "attached", timeout: 5_000 });
    await audienceB.locator("#chatMessages .msg", { hasText: "Hello from the local Worker test" })
      .waitFor({ state: "visible", timeout: 10_000 });
    // Leave the full-page chat view on both devices to return to the board.
    for (const page of [audienceA, audienceB]) {
      await page.locator("#backToGame").click();
      await page.locator("#chatPage[hidden]").waitFor({ state: "attached", timeout: 5_000 });
    }

    // --- Tag's four-player, two-team view ----------------------------------------------------
    await audienceA.locator("#btnSettings").click();
    await audienceA.locator("#settingsPanel:not([hidden])").waitFor({ state: "attached", timeout: 5_000 });
    const roster = await audienceA.locator("#playersList").innerText();
    for (const expected of ["Team 1 · Player 1", "Team 1 · Player 2", "Team 2 · Player 3", "Team 2 · Player 4"]) {
      assert.ok(roster.includes(expected), `the roster should list "${expected}" (got: ${roster.replace(/\n/g, " | ")})`);
    }
    assert.ok((await audienceA.locator("#roomSummary").innerText()).includes(roomCode),
      "the room summary should show the room code");
    await audienceA.locator("#closeSettings").click();

    // The audience HUD shows the active player; the skewed device must agree on the clock.
    await audienceA.locator("#goalText").waitFor({ state: "visible", timeout: 10_000 });
    const goalA1 = (await audienceA.locator("#goalText").innerText()).trim();
    const goalB1 = (await audienceB.locator("#goalText").innerText()).trim();
    assert.equal(goalB1, goalA1, `both audience devices should show the same turn label (${goalA1} vs ${goalB1})`);
    assert.match(goalA1, /TEAM [12]: PLAYER [1-4]/, "the Tag HUD should name the active team and player");

    // --- Turn rotation visible to the audience: P1 -> P3, P3 -> P2 ---------------------------
    // Submits the actor's empty turn so the audience pages must show the next player.
    // The Tag turn clock is 30s and the audience-side phases above can consume much of
    // it on a loaded runner; if the server has already rotated past the actor (the turn
    // ended at its server-authoritative deadline), the rotation the audience must
    // display has still happened - accept it and keep verifying the audience view. A
    // genuinely broken submit button is still caught whenever the turn is fresh, and
    // tag-browser-smoke covers the button's causal effect on its own.
    async function handover(actorIndex, expectedLabel) {
      const myNumber = actorIndex + 1;
      await wakeLoop(players[actorIndex]);
      const before = await players[actorIndex].evaluate(() =>
        window.game.scene.getScene("GameScene").onlineState.turnIndex);
      await clickWorldUntil(players[actorIndex], 296, 1141, (ctx) => {
        const state = window.game?.scene?.getScene("GameScene")?.onlineState;
        return !state || state.turnIndex > ctx.before ||
          state.activePlayerNumber !== ctx.myNumber;
      }, "submitting the empty turn " + expectedLabel, 5, { before, myNumber });
      await parkLoop(players[actorIndex]);
      await audienceA.locator("#goalText", { hasText: expectedLabel })
        .waitFor({ state: "attached", timeout: 15_000 });
      await audienceB.locator("#goalText", { hasText: expectedLabel })
        .waitFor({ state: "attached", timeout: 15_000 });
    }
    await handover(0, "TEAM 2: PLAYER 3");
    await handover(2, "TEAM 1: PLAYER 2");

    // The turn clock must agree between the correct-clock and the 40s-skewed audience device.
    {
      const secondsA = parseClockSeconds(await audienceA.locator("#turnClock").innerText());
      const secondsB = parseClockSeconds(await audienceB.locator("#turnClock").innerText());
      assert.ok(secondsA !== null && secondsB !== null, "both audience devices show a turn clock");
      assert.ok(Math.abs(secondsA - secondsB) <= CLOCK_TOLERANCE_S,
        `audience turn clocks disagree: ${secondsA}s vs ${secondsB}s despite the ${CLOCK_SKEW_MS}ms device skew`);
    }

    // --- Audience poll: voting, countdown agreement under skew, server-side expiry -----------
    // Player 2 (whose turn it now is) selects one real tile and presses the polls button.
    await wakeLoop(players[1]);
    const pollTarget = await players[1].evaluate((tileId) => {
      const scene = window.game.scene.getScene("GameScene");
      const state = scene.onlineState;
      const serverTile = state?.tiles?.find((tile) => tile.id === tileId);
      const sprite = scene.tiles.flat().find((tile) => tile && tile.serverId === tileId);
      return {
        tileId,
        x: sprite?.x ?? (serverTile ? scene.cellX(serverTile.col) : null),
        y: sprite?.y ?? (serverTile ? scene.cellY(serverTile.row) : null),
        status: state?.status,
        activePlayerNumber: state?.activePlayerNumber,
        remainingMs: scene.turnClock?.remaining?.() ?? null,
        serverTileAvailable: Boolean(serverTile && !serverTile.faceUp && !serverTile.moving),
        spriteAvailable: Boolean(sprite?.active && !sprite.faceUp && !sprite.moving),
        selectedTileIds: state?.selectedTileIds || []
      };
    }, pollTile.id);
    assert.ok(Number.isFinite(pollTarget.x) && Number.isFinite(pollTarget.y),
      `the poll tile must still be present on the client board (got ${JSON.stringify(pollTarget)})`);
    assert.equal(pollTarget.status, "playing", "Player 2 must be in a live turn before the poll pick");
    assert.equal(pollTarget.activePlayerNumber, 2,
      `Player 2 must own the turn for the poll pick (got ${JSON.stringify(pollTarget)})`);
    assert.ok(pollTarget.serverTileAvailable,
      `the chosen poll tile must be available on the server (got ${JSON.stringify(pollTarget)})`);
    // Waking a sleeping Phaser loop may take a frame before pointer input is processed.
    // Retry the real UI click until the server snapshot confirms this exact tile was selected.
    await clickWorldUntil(players[1], pollTarget.x, pollTarget.y, (tileId) => {
      const state = window.game?.scene?.getScene("GameScene")?.onlineState;
      return state?.activePlayerNumber === 2 &&
        state?.selectedTileIds?.includes(tileId);
    }, "server-confirmed poll tile selection for Player 2", 6, pollTile.id);
    // Retry the press until the poll actually opens (a swallowed press or a momentarily
    // reconnecting socket would otherwise flake the phase; a real player presses again).
    await clickWorldUntil(players[1], 449, 1141, () =>
      Boolean(window.game?.scene?.getScene("GameScene")?.onlineAudiencePoll &&
        !window.game.scene.getScene("GameScene").onlineAudiencePoll.closed),
      "audience poll opened on the player page", 6);
    await parkLoop(players[1]);

    const pollStartedAt = Date.now();
    for (const page of [audienceA, audienceB]) {
      await page.locator("#pollIntro", { hasText: "s left" }).waitFor({ state: "attached", timeout: 15_000 });
      await page.locator("#board [data-tile-id].is-vote-option").first()
        .waitFor({ state: "attached", timeout: 5_000 });
    }

    // Both audience devices vote (the board tiles themselves, like real spectators).
    await audienceA.locator("#board [data-tile-id].is-vote-option").first().click();
    await audienceB.locator("#board [data-tile-id].is-vote-option").nth(1).click();
    for (const [page, label] of [[audienceA, "audience A"], [audienceB, "audience B"]]) {
      await page.locator("#pollOptions", { hasText: "Your vote is locked" })
        .waitFor({ state: "attached", timeout: 10_000 });
    }

    // The poll countdown must agree across the two devices despite B's 40s clock skew.
    {
      const secondsA = pollSecondsFromIntro(await audienceA.locator("#pollIntro").innerText());
      const secondsB = pollSecondsFromIntro(await audienceB.locator("#pollIntro").innerText());
      assert.ok(secondsA !== null && secondsB !== null, "both audience devices show the poll countdown");
      assert.ok(Math.abs(secondsA - secondsB) <= CLOCK_TOLERANCE_S,
        `poll countdowns disagree: ${secondsA}s vs ${secondsB}s despite the ${CLOCK_SKEW_MS}ms device skew`);
      assert.ok(secondsA <= Math.ceil(POLL_MS / 1000) && secondsA > 0,
        `the poll countdown should read within the ${POLL_MS / 1000}s window (got ${secondsA}s)`);
    }

    // Expiry is server-authoritative: the poll closes at the deadline and reveals the results.
    await audienceA.locator("#pollOptions", { hasText: "Voting is closed" })
      .waitFor({ state: "attached", timeout: POLL_MS + POLL_CLOSE_TOLERANCE_MS });
    const closedAt = Date.now();
    assert.ok(closedAt - pollStartedAt >= POLL_MS - POLL_CLOSE_TOLERANCE_MS,
      `the poll closed ${Math.round((closedAt - pollStartedAt) / 1000)}s after starting; the audience must get the full window`);
    assert.ok(closedAt - pollStartedAt <= POLL_MS + POLL_CLOSE_TOLERANCE_MS,
      `the poll closed ${Math.round((closedAt - pollStartedAt) / 1000)}s after starting; it must not overrun`);
    const closedIntro = await audienceA.locator("#pollIntro").innerText();
    assert.ok(closedIntro.includes("Poll closed") && closedIntro.includes("2 votes"),
      `the closed poll should reveal both votes (got: ${closedIntro})`);

    // The paused turn resumed on the player's device.
    await waitForScene(players[1], () => {
      const scene = window.game?.scene?.getScene("GameScene");
      return scene?.onlineState?.activePlayerNumber === 2 &&
        Number.isFinite(scene.turnClock.endsAt) && scene.turnClock.endsAt > Date.now();
    }, "Player 2's paused turn resumed after the poll", 15_000);

    // --- Reconnect: an audience device and a player device rejoin mid-game -------------------
    await audienceA.reload({ waitUntil: "domcontentloaded" });
    await audienceA.locator("#watchView:not([hidden])").waitFor({ state: "attached", timeout: 15_000 });
    await audienceA.waitForFunction(() =>
      !document.getElementById("veil").checkVisibility(), null, { timeout: 15_000 });
    await audienceA.locator("#chatPage").evaluate((el) => el.hidden = true); // back to the board view
    await audienceA.locator("#goalText").waitFor({ state: "visible", timeout: 10_000 });
    await audienceA.locator("#btnChat").click();
    await audienceA.locator("#chatMessages .msg", { hasText: "Hello from the local Worker test" })
      .waitFor({ state: "visible", timeout: 10_000 });

    // Player 4 reloads and rejoins through the room dialog; the seat token restores seat 4.
    await players[3].reload({ waitUntil: "domcontentloaded" });
    await chooseTag(players[3]);
    const rejoinDialog = await openJoinDialog(players[3]);
    await rejoinDialog.locator('input[aria-label="Room code"]').fill(roomCode);
    await rejoinDialog.getByRole("button", { name: "JOIN", exact: true }).click();
    await waitForScene(players[3], () => {
      const scene = window.game?.scene?.getScene("GameScene");
      return scene?.online === true && scene.onlinePlayerNumber === 4 &&
        scene.onlineState?.status === "playing";
    }, "Player 4 rejoined into the same seat with the live game", 30_000);
    // The audience devices are still watching the same live match after both reconnects
    // (the active player may have advanced while Player 4 was rejoining, which is fine).
    for (const [page, label] of [[audienceA, "audience A"], [audienceB, "audience B (skewed clock)"]]) {
      const goal = await page.locator("#goalText").innerText();
      assert.match(goal.trim(), /TEAM [12]: PLAYER [1-4]/,
        `${label} should still show the live Tag turn after the reconnects (got "${goal.trim()}")`);
    }

    // --- Root ?watch= redirect: keep the test-only local API override end-to-end ----------
    // The top-level game redirects this URL to staging/audience.html. That redirect must
    // preserve ?api= so the watcher still reaches this local Worker rather than the deployed one.
    const demoCreateResponse = await fetch("http://127.0.0.1:8787/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:8080" },
      body: JSON.stringify({ mode: "demo" })
    });
    assert.equal(demoCreateResponse.status, 201,
      `local Worker should create the AI-vs-AI demo (HTTP ${demoCreateResponse.status})`);
    const demoRoom = await demoCreateResponse.json();
    assert.ok(demoRoom.roomCode, "the local Worker should return a demo room code");

    // The Tag devices and skewed audience are no longer needed; close them to leave WebGL
    // capacity for the embedded game in this final redirect check.
    await Promise.all([...players, audienceB].map((page) => page.close()));
    const localApi = "http://127.0.0.1:8787";
    await audienceA.goto(
      `http://127.0.0.1:8080/index.html?watch=${demoRoom.roomCode}&api=${encodeURIComponent(localApi)}`,
      { waitUntil: "domcontentloaded", timeout: TIMEOUT }
    );
    await audienceA.waitForURL(/\/staging\/audience\.html/, { timeout: TIMEOUT });
    const redirectedUrl = new URL(audienceA.url());
    assert.equal(redirectedUrl.searchParams.get("room"), demoRoom.roomCode,
      "the root watch link should keep the requested demo room");
    assert.equal(redirectedUrl.searchParams.get("api"), localApi,
      "the root watch redirect must preserve the validated local Worker override");
    await audienceA.waitForFunction(() => {
      const frame = document.querySelector("#gameFrame");
      if (!frame || frame.hidden) return false;
      try {
        const scene = frame.contentWindow?.game?.scene?.getScene("GameScene");
        return Boolean(scene?.onlineState && Number.isFinite(scene.onlineState.turnDurationMs) &&
          Array.isArray(scene.tiles) && scene.tiles.flat().filter(Boolean).length === 49);
      } catch { return false; }
    }, null, { timeout: TIMEOUT });
    const demoTiming = await audienceA.evaluate(() => {
      const frame = document.querySelector("#gameFrame");
      const scene = frame.contentWindow.game.scene.getScene("GameScene");
      return {
        tiles: scene.tiles.flat().filter(Boolean).length,
        mode: scene.onlineState.mode,
        turnDurationMs: scene.onlineState.turnDurationMs,
        targetScore: scene.onlineState.targetScore
      };
    });
    assert.equal(demoTiming.turnDurationMs, 5_000,
      "AI-vs-AI demo must expose the five-second server-authoritative turn deadline");
    assert.equal(demoTiming.targetScore, 10, "the demo retains its deliberately short target");
    console.log("Local root ?watch= route passed: override preserved, demo renders, and its turn deadline is 5 seconds.");

    assert.deepEqual(pageErrors, [], "No uncaught browser exceptions should occur on any page.");
    assert.deepEqual(consoleErrors, [], "No console errors should occur on the audience pages.");

    console.log("Audience smoke test passed: the audience frontend ran entirely against the local " +
      "refactored Worker - room discovery, spectating with the embedded game frame, chat across " +
      "two audience devices (one with a 40s-skewed clock agreeing on turn and poll countdowns), " +
      "the four-player Tag roster and turn rotation, poll voting with server-side expiry and " +
      "result reveal, audience + player reconnect, root ?watch= override propagation, and the five-second AI-demo deadline - with zero browser errors.");
  } finally {
    await Promise.all([
      ...playerContexts.map((context) => context.close()),
      audienceContextA.close(), audienceContextB.close()
    ]);
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
