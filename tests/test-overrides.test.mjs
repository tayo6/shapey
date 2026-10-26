import test from "node:test";
import assert from "node:assert/strict";
import { testOverridesAllowed, readNumericOverride } from "../src/game/test-overrides.js";

test("URL test overrides are enabled only on staging or localhost", () => {
  assert.equal(testOverridesAllowed({ staging: true, hostname: "tayo6.github.io" }), true);
  assert.equal(testOverridesAllowed({ hostname: "localhost" }), true);
  assert.equal(testOverridesAllowed({ hostname: "127.0.0.1" }), true);
  assert.equal(testOverridesAllowed({ hostname: "tayo6.github.io" }), false);
  assert.equal(testOverridesAllowed({ hostname: "shapey-audience-preview.hellohuman100.workers.dev" }), false);
});

test("production ignores timing overrides", () => {
  const params = new URLSearchParams("turn=1&review=2000");
  assert.equal(readNumericOverride(params, "turn", 45000, false, { min: 1000, max: 60000 }), 45000);
  assert.equal(readNumericOverride(params, "review", 15000, false, { min: 1000, max: 60000 }), 15000);
});

test("staging timing overrides are bounded to integer milliseconds", () => {
  const params = new URLSearchParams("turn=1&review=90000&reveal=3000");
  assert.equal(readNumericOverride(params, "turn", 45000, true, { min: 1000, max: 60000 }), 1000);
  assert.equal(readNumericOverride(params, "review", 15000, true, { min: 1000, max: 60000 }), 60000);
  assert.equal(readNumericOverride(params, "reveal", 5000, true, { min: 500, max: 30000 }), 3000);
});

test("invalid, blank, fractional and infinite override values fall back to defaults", () => {
  for (const raw of ["", "abc", "NaN", "Infinity", "1.5"]) {
    const params = new URLSearchParams("turn=" + encodeURIComponent(raw));
    assert.equal(readNumericOverride(params, "turn", 45000, true, { min: 1000, max: 60000 }), 45000);
  }
  assert.equal(readNumericOverride(new URLSearchParams(), "turn", 45000, true), 45000);
});
