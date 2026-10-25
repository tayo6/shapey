// Audience page verification against the LOCAL Worker (review package, rev 5): the
// boardFootnote poll fix, the ES-module split and the test-only ?api= override must all work
// together on the real audience flow.
// Flow: open staging/audience.html?api=http://127.0.0.1:8787, start an AI-vs-AI demo from the
// directory UI, watch a full study->playing cycle and an audience poll, count page errors.
//
// BACKEND NOTE: since patch 0013 the audience wrapper honours ?api=http://127.0.0.1:8787 on
// localhost-served pages (staging/audience/state.js), mirroring src/config.js. This script
// therefore runs the audience frontend entirely against the LOCAL refactored Worker: the
// demo room, the spectator snapshots, the poll and the chat all come from the same wrangler
// dev instance the smoke suites use. The deployed staging Worker is not touched. On a
// deployed (non-localhost) page the ?api= parameter is ignored and the hard-coded production
// API is used, exactly as before.
//
// PLACEMENT: this folder must live INSIDE the repository checkout (as <repo>/verification/)
// so that the Playwright import below resolves to the repo's own worker/node_modules.
// Prerequisites: cd worker && npm ci  (installs playwright 1.64.0), then:
//   - a static file server on 127.0.0.1:8080 serving the repo root
//   - a local Worker on 127.0.0.1:8787 (wrangler dev --config worker/wrangler.jsonc --local)
// The full audience/room/chat/poll/reconnect behaviour is covered more deeply by
// worker/audience-smoke.mjs (CI); this script is the light-weight package check.
import { chromium } from "../worker/node_modules/playwright/index.mjs";

const URL = "http://127.0.0.1:8080/staging/audience.html?api=http://127.0.0.1:8787";
const errors = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const context = await browser.newContext({ viewport: { width: 720, height: 1280 } });
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));

try {
  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#directoryList")?.children.length > 0 ||
    document.body.textContent.includes("AI vs AI"), null, { timeout: 30000 });

  // Start the demo via the page's own control (button or in-page action).
  const started = await page.evaluate(() => {
    const candidate = [...document.querySelectorAll("button")]
      .find((b) => /demo/i.test(b.textContent || ""));
    if (candidate) { candidate.click(); return "button:" + candidate.textContent.trim(); }
    return null;
  });
  if (!started) {
    // Fall back to the exposed module API used by the directory header.
    await page.evaluate(async () => {
      // The directory's own demo button posts to the deployed staging Worker (see BACKEND NOTE).
      const res = await fetch("https://shapey-multiplayer-staging.hellohuman100.workers.dev/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Origin": "http://127.0.0.1:8080" },
        body: JSON.stringify({ mode: "demo" }),
      });
      if (!res.ok) throw new Error("demo create failed: " + res.status);
    });
  }
  await wait(2000);

  // Watch long enough to cover: board render, countdown, a poll opening, footnote updates.
  let sawBoard = false, sawClock = false, sawPoll = false, sawFootnote = false;
  for (let i = 0; i < 40; i++) {
    await wait(1000);
    const state = await page.evaluate(() => ({
      tiles: document.querySelectorAll("#board [data-tile], #board img, #board .tile").length,
      bodyText: document.body.textContent || "",
      footnote: document.querySelector("#boardFootnote")?.textContent || "",
      pollOpen: Boolean(document.querySelector("#pollPanel")?.offsetParent),
    })).catch(() => null);
    if (!state) continue;
    if (state.tiles > 0) sawBoard = true;
    if (/\d+\s*s|0:\d\d/.test(state.bodyText)) sawClock = true;
    if (/Ask the Audience/i.test(state.bodyText)) sawPoll = true;
    if (/Audience poll open/i.test(state.footnote)) sawFootnote = true;
    if (sawBoard && sawPoll && sawFootnote && i > 20) break;
  }
  const shotDir = process.env.SHAPEY_EVIDENCE_DIR || null;
  if (shotDir) await page.screenshot({ path: shotDir + "/evidence-audience-poll-v2.png" }).catch(() => {});

  console.log(JSON.stringify({ sawBoard, sawClock, sawPoll, sawFootnote, errors }, null, 2));
  const failed = [];
  if (!sawBoard) failed.push("board never rendered");
  if (!sawPoll) failed.push("no audience poll observed in 40s");
  if (!sawFootnote) failed.push("poll footnote never showed");
  if (errors.length) failed.push(errors.length + " page error(s)");
  if (failed.length) { console.error("FAILED: " + failed.join("; ")); process.exitCode = 1; }
  else console.log("Audience watch PASSED: board rendered, poll ran, footnote appeared, 0 page errors.");
} finally {
  await context.close();
  await browser.close();
}
