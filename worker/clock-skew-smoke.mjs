// Shapey - device-clock-skew regression smoke test (browser, against the local Worker).
//
// Two online PvP clients run with deliberately wrong device clocks: Player 1's Date.now()
// runs 25s AHEAD of the real clock, Player 2's runs 25s BEHIND. The test proves behaviour,
// not syntax: both devices must display the true remaining time for every server deadline
// (turn clock, study/memorize countdown, audience-poll countdown, tile-movement animations),
// repeated snapshots must not make countdowns jump or drift, and the turn must switch at the
// server-authoritative deadline (the Worker's Durable Object alarm), never before it and
// never meaningfully after it.
//
// Timing tolerances (see src/game/clock-sync.js for the derivation): displayed deadlines may
// run at most the best observed downstream latency late (well under 1s against a local
// Worker) and never early, so a 25s skew must show up as a ~25s error if the correction
// regresses. The tolerances below are generous CI margins around that, not the expected
// error: OFFSET_TOLERANCE for the measured skew, DISPLAY_TOLERANCE for countdown accuracy,
// SWITCH_TOLERANCE for the Durable Object alarm's scheduling granularity plus delivery.
//
// Run against one local Worker plus one static file server, exactly like the CI job:
//   npx wrangler dev --config wrangler.jsonc --local --ip 127.0.0.1 --port 8787
//   python3 -m http.server 8080 --bind 127.0.0.1 --directory ..
//   node clock-skew-smoke.mjs

import assert from "node:assert/strict";
import { chromium } from "playwright";

const PAGE_URL = process.env.SHAPEY_BROWSER_URL ||
  "http://127.0.0.1:8080/staging/index.html?api=http://127.0.0.1:8787";
const TIMEOUT = 45_000;
const SKEW_MS = 25_000;             // Player 1 ahead by this much, Player 2 behind by this much
const OFFSET_TOLERANCE_MS = 1_000;  // measured skew vs the true skew
const DISPLAY_TOLERANCE_MS = 2_000; // displayed countdown vs the true remaining time
const JUMP_TOLERANCE_MS = 2_000;    // extra time a countdown may regain between samples
const SWITCH_TOLERANCE_MS = 3_000;  // server-authoritative switch vs the deadline
const POLL_MS = 30_000;

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

async function waitForScene(page, predicate, description, timeout = TIMEOUT, arg = null) {
  await page.waitForFunction(predicate, arg, { timeout }).catch(async (error) => {
    const info = await page.evaluate(() => ({
      url: location.href,
      activeScenes: window.game?.scene?.getScenes(true).map((scene) => scene.scene.key),
      status: window.game?.scene?.getScene("GameScene")?.onlineState?.status,
      activePlayer: window.game?.scene?.getScene("GameScene")?.onlineState?.activePlayerNumber,
      offset: window.game?.scene?.getScene("GameScene")?.serverClockSync?.offset,
      selectedTiles: (window.game?.scene?.getScene("GameScene")?.onlineState?.selectedTileIds || []).length,
      socketOpen: window.game?.scene?.getScene("GameScene")?.onlineSocket?.readyState === 1,
      pollsUsed: window.game?.scene?.getScene("GameScene")?.onlineState?.me?.audiencePollsUsed
    })).catch(() => null);
    throw new Error("Timed out waiting for " + description + ". Browser state: " +
      JSON.stringify(info) + ". Original error: " + error.message);
  });
}

async function choosePvp(page) {
  await waitForScene(page, () =>
    Boolean(window.game?.scene?.getScenes(true).some((scene) => scene.scene.key === "MenuScene")),
    "mode menu");
  await clickWorld(page, 360, 930); // Player 1 vs Player 2 is the third mode.
  await waitForScene(page, () =>
    Boolean(window.game?.scene?.getScene("MenuScene")?.pickerUI?.length),
    "PvP board-size picker");
  await clickWorld(page, 360, 845); // 7x7
  await waitForScene(page, () =>
    window.game?.scene?.getScene("MenuScene")?.onlineMode === "pvp",
    "PvP room lobby");
}

// Reads everything the clock assertions need from one page in one round trip. All remaining
// times are computed page-side with the page's own (deliberately wrong) Date.now(), which
// cancels out of every difference, so the harness clock never matters.
const READ_SCENE = `(() => {
  const scene = window.game && window.game.scene && window.game.scene.getScene("GameScene");
  if (!scene || !scene.onlineState) return null;
  const state = scene.onlineState;
  const now = Date.now();
  const sync = scene.serverClockSync;
  const turnRemaining = Number.isFinite(scene.turnClock.endsAt) ? scene.turnClock.endsAt - now : null;
  // True remaining turn time computed only from the snapshot: deadline - serverNow - age of
  // the snapshot at its arrival (both measured with the same page clock, so the skew cancels).
  const snapshotAge = sync && sync.lastSampleAt ? now - sync.lastSampleAt : null;
  const trueRemaining = Number.isFinite(state.turnEndsAt) && Number.isFinite(state.serverNow) && snapshotAge !== null
    ? (state.turnEndsAt - state.serverNow) - snapshotAge : null;
  const studyRemaining = state.status === "study" && Number.isFinite(state.reviewEndsAt) && sync
    ? sync.serverToLocal(state.reviewEndsAt) - now : null;
  const studyTrue = state.status === "study" && Number.isFinite(state.reviewEndsAt) && Number.isFinite(state.serverNow) && snapshotAge !== null
    ? (state.reviewEndsAt - state.serverNow) - snapshotAge : null;
  const poll = scene.onlineAudiencePoll || null;
  const pollRemaining = poll && !poll.closed && sync ? sync.serverToLocal(Number(poll.endsAt)) - now : null;
  return {
    status: state.status,
    activePlayerNumber: state.activePlayerNumber,
    turnIndex: state.turnIndex,
    revision: state.revision,
    turnEndsAt: state.turnEndsAt,
    offset: sync ? sync.offset : null,
    sampleCount: sync ? sync.sampleCount : 0,
    turnRemaining, trueRemaining,
    studyRemaining, studyTrue,
    pollRemaining, pollClosed: poll ? Boolean(poll.closed) : null,
    pollUIVisible: Boolean(scene.pollUI && scene.pollUI.length),
    clockText: scene.timerText && scene.timerText.text ? scene.timerText.text : "",
    revealText: scene.revealText && scene.revealText.visible ? scene.revealText.text : "",
    movingTiles: (state.tiles || []).filter((tile) => tile.moving).length
  };
})()`;

function parseClockSeconds(text) {
  const match = /(\d+):(\d{2})/.exec(String(text || ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

async function readScene(page) {
  return page.evaluate(READ_SCENE);
}

// Samples every visible tile's position every `stepMs` for `durationMs` and returns how the
// positions changed: `longestRunMs` is the longest run of consecutive samples in which any
// tile position changed (the longest continuous animation), and `changes` counts how many
// sampling intervals showed movement. A device that converts movingUntil correctly animates
// each shuffle step over ~SHUFFLE_STEP_MS (a Sine-eased tween only exceeds half a pixel per
// sample near its middle, so the measured run is shorter than the tween but still spans many
// samples); a skewed device without correction snaps instantly (a run of about one sample
// and almost no changes).
async function animationProfile(page, durationMs, stepMs = 150) {
  const SIGNATURE = `(() => {
    const scene = window.game && window.game.scene && window.game.scene.getScene("GameScene");
    if (!scene || !scene.onlineTilesById) return "";
    const positions = [];
    scene.onlineTilesById.forEach((tile) => positions.push(Math.round(tile.x), Math.round(tile.y)));
    return positions.join(",");
  })()`;
  let previous = null;
  let run = 0;
  let longest = 0;
  let changes = 0;
  for (let elapsed = 0; elapsed < durationMs; elapsed += stepMs) {
    const signature = await page.evaluate(SIGNATURE);
    if (previous !== null && signature !== previous) {
      run += stepMs;
      changes += 1;
    } else {
      run = 0;
    }
    longest = Math.max(longest, run);
    previous = signature;
    await page.waitForTimeout(stepMs);
  }
  return { longestRunMs: longest, changes };
}

async function run() {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  // Device 1: clock 25s ahead of reality. Device 2: clock 25s behind.
  const context1 = await browser.newContext({ viewport: { width: 720, height: 1280 } });
  const context2 = await browser.newContext({ viewport: { width: 720, height: 1280 } });
  await context1.addInitScript((skew) => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + skew;
  }, SKEW_MS);
  await context2.addInitScript((skew) => {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + skew;
  }, -SKEW_MS);
  const page1 = await context1.newPage();
  const page2 = await context2.newPage();
  const pageErrors = [];
  for (const page of [page1, page2]) page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    // Wait for the response commit, not DOMContentLoaded: both pages load Phaser and its
    // module graph at once, and a cold CI Chromium can delay DOMContentLoaded on the second
    // heavy canvas page even though the document and modules are being served successfully.
    // choosePvp() below explicitly waits for the real MenuScene before interacting.
    await Promise.all([
      page1.goto(PAGE_URL, { waitUntil: "commit", timeout: TIMEOUT }),
      page2.goto(PAGE_URL, { waitUntil: "commit", timeout: TIMEOUT })
    ]);
    await Promise.all([choosePvp(page1), choosePvp(page2)]);

    await clickWorldUntil(page1, 360, 710, () =>
      Boolean(window.game?.scene?.getScene("MenuScene")?.currentRoomCode),
      "creating the PvP room");
    await waitForScene(page1, () =>
      Boolean(window.game?.scene?.getScene("MenuScene")?.currentRoomCode),
      "created PvP room code");
    const roomCode = await page1.evaluate(() =>
      window.game.scene.getScene("MenuScene").currentRoomCode);

    await clickWorld(page2, 360, 810); // join with the real room-code dialog
    const joinDialog = page2.locator("#shapey-join-modal");
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await joinDialog.waitFor({ state: "visible", timeout: 1_500 });
        break;
      } catch {
        await clickWorld(page2, 360, 810);
      }
    }
    await joinDialog.waitFor({ state: "visible", timeout: 5_000 });
    await joinDialog.locator('input[aria-label="Room code"]').fill(roomCode);
    await joinDialog.getByRole("button", { name: "JOIN", exact: true }).click();
    await waitForScene(page2, () =>
      window.game?.scene?.getScene("MenuScene")?.onlineStatus?.text?.includes("Room connected as Player 2") ||
      (window.game?.scene?.getScene("GameScene")?.online === true &&
        window.game?.scene?.getScene("GameScene")?.onlinePlayerNumber === 2),
      "second browser joined as Player 2", 15_000);

    await Promise.all([
      waitForScene(page1, () => window.game?.scene?.getScene("GameScene")?.online === true &&
        window.game.scene.getScene("GameScene").onlineState?.status === "study",
        "Player 1 online study board"),
      waitForScene(page2, () => window.game?.scene?.getScene("GameScene")?.online === true &&
        window.game.scene.getScene("GameScene").onlineState?.status === "study",
        "Player 2 online study board")
    ]);

    // Capture a matching triple while the study board is still revealed (shapes are hidden
    // again once the playing phase starts, and positions are preserved when they flip).
    const triple = await page1.evaluate(() => {
      const scene = window.game.scene.getScene("GameScene");
      const groups = new Map();
      for (const tile of scene.onlineState.tiles) {
        // Cancel is a neutral special tile: a Cancel pick clears the selection 350ms
        // later, which would make the poll phase impossible. Hazard detonates and
        // Dummy is not a scoring shape, so only real match shapes can anchor the poll.
        if (!tile.shape || tile.shape === "hazard" || tile.shape === "dummy" || tile.shape === "cancel") continue;
        if (!groups.has(tile.shape)) groups.set(tile.shape, []);
        groups.get(tile.shape).push({ id: tile.id, row: tile.row, col: tile.col });
      }
      for (const [shape, tiles] of groups) {
        if (tiles.length >= 3) return { shape, tiles: tiles.slice(0, 3) };
      }
      return null;
    });
    assert.ok(triple, "The opening board must offer at least one matching triple.");

    // --- Both devices measured the skew from serverNow despite their wrong clocks ----------
    // (The study status alone can come from the scene-start replay of the cached snapshot,
    // which deliberately does not touch the clock: wait for a fresh socket snapshot.)
    for (const page of [page1, page2]) {
      await waitForScene(page, () =>
        (window.game?.scene?.getScene("GameScene")?.serverClockSync?.sampleCount || 0) > 0,
        "a fresh snapshot reached the device and was measured");
    }
    for (const [page, label, expectedOffset] of [[page1, "Player 1 (clock ahead)", -SKEW_MS],
                                                 [page2, "Player 2 (clock behind)", SKEW_MS]]) {
      const scene = await readScene(page);
      assert.ok(scene.offset !== null && scene.sampleCount > 0,
        `${label}: no clock measurement was taken`);
      assert.ok(Math.abs(scene.offset - expectedOffset) <= OFFSET_TOLERANCE_MS,
        `${label}: measured offset ${scene.offset} should be ~${expectedOffset} (device skew ${SKEW_MS}ms)`);
    }

    // --- Study / memorize countdown (reviewEndsAt) on both skewed devices ------------------
    {
      const [a, b] = await Promise.all([readScene(page1), readScene(page2)]);
      for (const [scene, label] of [[a, "Player 1"], [b, "Player 2"]]) {
        assert.ok(scene.studyRemaining !== null && scene.studyTrue !== null,
          `${label}: no study countdown during the study phase`);
        assert.ok(Math.abs(scene.studyRemaining - scene.studyTrue) <= DISPLAY_TOLERANCE_MS,
          `${label}: memorize countdown ${Math.round(scene.studyRemaining)}ms, truth ${Math.round(scene.studyTrue)}ms`);
        const shown = parseClockSeconds(scene.clockText) ?? parseClockSeconds(scene.revealText);
        if (shown !== null) {
          assert.ok(Math.abs(shown * 1000 - scene.studyTrue) <= 2500,
            `${label}: rendered memorize text "${scene.clockText} / ${scene.revealText}" vs truth ${Math.round(scene.studyTrue / 1000)}s`);
        }
      }
      assert.ok(Math.abs(a.studyRemaining - b.studyRemaining) <= DISPLAY_TOLERANCE_MS,
        `the two skewed devices disagree on the memorize countdown (${Math.round(a.studyRemaining)} vs ${Math.round(b.studyRemaining)}ms)`);
    }

    await Promise.all([
      waitForScene(page1, () => window.game?.scene?.getScene("GameScene")?.onlineState?.status === "playing",
        "PvP turn start", 35_000),
      waitForScene(page2, () => window.game?.scene?.getScene("GameScene")?.onlineState?.status === "playing",
        "second PvP client turn start", 35_000)
    ]);

    // --- Turn clock under repeated snapshots: accuracy, no jumps, no extension -------------
    {
      let previousByDevice = null;
      for (let sample = 0; sample < 6; sample++) {
        const a = await readScene(page1);
        const b = await readScene(page2);
        for (const [scene, previous, label] of [[a, previousByDevice && previousByDevice[0], "Player 1"],
                                                [b, previousByDevice && previousByDevice[1], "Player 2"]]) {
          assert.ok(scene.turnRemaining !== null && scene.trueRemaining !== null,
            `${label}: no turn deadline in the playing phase`);
          assert.ok(Math.abs(scene.turnRemaining - scene.trueRemaining) <= DISPLAY_TOLERANCE_MS,
            `${label}: turn clock ${Math.round(scene.turnRemaining)}ms vs truth ${Math.round(scene.trueRemaining)}ms (sample ${sample})`);
          assert.ok(scene.turnRemaining <= scene.trueRemaining + DISPLAY_TOLERANCE_MS,
            `${label}: turn clock shows ${Math.round(scene.turnRemaining)}ms - more than the truth ${Math.round(scene.trueRemaining)}ms allows (turn extension)`);
          const shown = parseClockSeconds(scene.clockText);
          if (shown !== null) {
            assert.ok(Math.abs(shown * 1000 - scene.trueRemaining) <= 2500,
              `${label}: rendered turn clock "${scene.clockText}" vs truth ${Math.round(scene.trueRemaining / 1000)}s (sample ${sample})`);
          }
          if (previous) {
            const regained = previous.turnRemaining - scene.turnRemaining;
            assert.ok(regained <= JUMP_TOLERANCE_MS,
              `${label}: countdown regained ${Math.round(regained)}ms between snapshots (jump; sample ${sample})`);
            assert.equal(scene.turnEndsAt, previous.turnEndsAt,
              `${label}: the server deadline itself moved without a poll (sample ${sample})`);
          }
        }
        previousByDevice = [a, b];
        await page1.waitForTimeout(700);
      }
      const [a, b] = await Promise.all([readScene(page1), readScene(page2)]);
      assert.ok(Math.abs(a.turnRemaining - b.turnRemaining) <= DISPLAY_TOLERANCE_MS,
        `the two skewed devices disagree on the turn clock (${Math.round(a.turnRemaining)} vs ${Math.round(b.turnRemaining)}ms)`);
    }

    // --- Audience-poll countdown + the server-driven turn pause ----------------------------
    // Player 1 selects one tile with the real UI, then presses the real polls button; the
    // Worker opens the poll and pauses the turn deadline for the 30s voting window.
    const tileWorld = async (page, tile) => page.evaluate((t) => {
      const scene = window.game.scene.getScene("GameScene");
      return [scene.cellX(t.col), scene.cellY(t.row)];
    }, tile);

    {
      const [x, y] = await tileWorld(page1, triple.tiles[0]);
      await clickWorld(page1, x, y);
    }
    await waitForScene(page1, (expected) =>
      window.game?.scene?.getScene("GameScene")?.onlineState?.selectedTileIds?.length === expected,
      "server-confirmed single tile selection", 10_000, 1);

    const beforePoll = await readScene(page1);
    // A single press can be swallowed by the pick flip animation or a momentarily
    // reconnecting socket (a real player simply presses again), so retry the press
    // until the poll actually opens - the established pattern for UI-gating clicks.
    await clickWorldUntil(page1, 449, 1141, () =>
      Boolean(window.game?.scene?.getScene("GameScene")?.onlineAudiencePoll &&
        !window.game.scene.getScene("GameScene").onlineAudiencePoll.closed),
      "audience poll opened", 6);
    {
      const [a, b] = await Promise.all([readScene(page1), readScene(page2)]);
      assert.ok(a.pollRemaining !== null, "Player 1 has no poll countdown");
      assert.ok(a.pollRemaining > POLL_MS - 5_000 && a.pollRemaining <= POLL_MS + 500,
        `Player 1 poll countdown ${Math.round(a.pollRemaining)}ms should be ~${POLL_MS}ms on a skewed device`);
      assert.ok(b.pollRemaining === null || b.pollRemaining > POLL_MS - 5_000,
        `Player 2 poll countdown ${b.pollRemaining && Math.round(b.pollRemaining)}ms must also read ~${POLL_MS}ms`);
      // The turn deadline was paused for the poll window: the displayed turn clock now
      // includes the ~30s pause, consistently on both skewed devices.
      for (const [scene, label] of [[a, "Player 1"], [b, "Player 2"]]) {
        assert.ok(scene.turnRemaining >= beforePoll.turnRemaining + 20_000,
          `${label}: turn clock ${Math.round(scene.turnRemaining)}ms should include the ~${POLL_MS}ms poll pause (was ${Math.round(beforePoll.turnRemaining)}ms)`);
      }
      assert.ok(Math.abs(a.turnRemaining - b.turnRemaining) <= DISPLAY_TOLERANCE_MS,
        "the two skewed devices disagree on the paused turn deadline");
      // Only the poll-starting side sees the poll overlay (agreed audience-poll rules).
      assert.ok(a.pollUIVisible, "Player 1 should see the poll overlay");
      assert.ok(!b.pollUIVisible, "Player 2 must not see the poll overlay");
    }

    // --- Poll expiry is server-authoritative; the paused turn time resumes ------------------
    await waitForScene(page1, () =>
      window.game?.scene?.getScene("GameScene")?.onlineAudiencePoll?.closed === true,
      "audience poll closed at its deadline", 45_000);
    await waitForScene(page2, () =>
      window.game?.scene?.getScene("GameScene")?.onlineAudiencePoll?.closed === true,
      "poll close reached Player 2", 10_000);
    {
      const [a, b] = await Promise.all([readScene(page1), readScene(page2)]);
      for (const [scene, label] of [[a, "Player 1"], [b, "Player 2"]]) {
        assert.ok(scene.turnRemaining !== null && scene.turnRemaining > 0,
          `${label}: the turn should have resumed after the poll`);
        assert.ok(Math.abs(scene.turnRemaining - scene.trueRemaining) <= DISPLAY_TOLERANCE_MS,
          `${label}: resumed turn clock ${Math.round(scene.turnRemaining)}ms vs truth ${Math.round(scene.trueRemaining)}ms`);
      }
      assert.ok(Math.abs(a.turnRemaining - b.turnRemaining) <= DISPLAY_TOLERANCE_MS,
        "the two skewed devices disagree on the resumed turn clock");
    }

    // --- Player 1 completes the match; the reveal->shuffle exercises movingUntil ------------
    // Dismiss the poll-results overlay first, exactly like a player would.
    await clickWorld(page1, 360, 885); // the CLOSE RESULTS button
    await waitForScene(page1, () =>
      !(window.game?.scene?.getScene("GameScene")?.pollUI || []).length,
      "poll results overlay dismissed", 5_000);
    for (let index = 1; index < 3; index++) {
      const [x, y] = await tileWorld(page1, triple.tiles[index]);
      await clickWorld(page1, x, y);
      await waitForScene(page1, (expected) =>
        window.game?.scene?.getScene("GameScene")?.onlineState?.selectedTileIds?.length === expected,
        `server-confirmed tile selection ${index + 1}`, 10_000, index + 1);
    }
    await clickWorld(page1, 296, 1141); // Submit
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

    // The matched tiles shuffle in steps of SHUFFLE_STEP_MS (2s), each step animated from a
    // movingUntil server deadline. Watch both devices across the whole reveal+shuffle window:
    // with correct conversion each step animates for ~2s; a skewed device without correction
    // computes a negative duration and snaps instantly (a run of ~one 150ms sample).
    {
      const WINDOW_MS = 16_000;
      const [profile1, profile2] = await Promise.all([
        animationProfile(page1, WINDOW_MS),
        animationProfile(page2, WINDOW_MS)
      ]);
      for (const [profile, label] of [[profile1, "Player 1"], [profile2, "Player 2"]]) {
        assert.ok(profile.longestRunMs >= 600,
          `${label} longest tile animation was only ${profile.longestRunMs}ms; a 25s-skewed clock must not snap tiles instantly`);
        assert.ok(profile.changes >= 6,
          `${label} showed only ${profile.changes} movement intervals; an animated shuffle step spans many samples`);
      }
      assert.ok(Math.abs(profile1.longestRunMs - profile2.longestRunMs) <= 2_000,
        `tile animations lasted ${profile1.longestRunMs}ms on Player 1 vs ${profile2.longestRunMs}ms on Player 2`);
    }

    // --- The Player 2 turn expires with no input: the server switches at the deadline -------
    const baseline = await readScene(page2);
    assert.equal(baseline.activePlayerNumber, 2, "Player 2 should hold the turn before expiry");
    assert.ok(baseline.trueRemaining > 5_000, "Player 2 should still have turn time left");
    const baselineAt = Date.now();       // harness (real) wall clock at the baseline read
    const deadlineAt = baselineAt + baseline.trueRemaining;
    await Promise.all([
      waitForScene(page1, () =>
        window.game?.scene?.getScene("GameScene")?.onlineState?.activePlayerNumber === 1,
        "server switched the expired turn back to Player 1", 60_000),
      waitForScene(page2, () =>
        window.game?.scene?.getScene("GameScene")?.onlineState?.activePlayerNumber === 1,
        "turn switch reached the skewed Player 2 device", 60_000)
    ]);
    const switchedAt = Date.now();
    assert.ok(switchedAt >= deadlineAt - 500,
      `the turn switched ${Math.round(deadlineAt - switchedAt)}ms BEFORE the server deadline`);
    assert.ok(switchedAt <= deadlineAt + SWITCH_TOLERANCE_MS,
      `the turn switched ${Math.round(switchedAt - deadlineAt)}ms after the server deadline (tolerance ${SWITCH_TOLERANCE_MS}ms)`);
    {
      const [a, b] = await Promise.all([readScene(page1), readScene(page2)]);
      assert.equal(a.activePlayerNumber, 1);
      assert.equal(b.activePlayerNumber, 1);
      assert.ok(a.turnIndex > baseline.turnIndex, "the turn index advanced");
      for (const [scene, label] of [[a, "Player 1"], [b, "Player 2"]]) {
        assert.ok(scene.turnRemaining !== null && scene.turnRemaining > 0,
          `${label}: the new turn should be running after the switch`);
      }
    }

    assert.deepEqual(pageErrors, [], "No uncaught browser exceptions should occur.");
    console.log("Clock-skew smoke test passed: two devices with clocks 25s apart displayed the " +
      "true turn, study, poll and tile-movement timings, agreed with each other, and the turn " +
      "switched at the server-authoritative deadline.");
  } finally {
    await Promise.all([context1.close(), context2.close()]);
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
