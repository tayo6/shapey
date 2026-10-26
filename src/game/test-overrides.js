// Helpers for URL-only timing and Hazard overrides used by staging and local browser tests.
// Production pages must use the game's real timings and Hazard probability.
export function testOverridesAllowed({ staging = false, hostname = "" } = {}) {
  return Boolean(staging || hostname === "localhost" || hostname === "127.0.0.1");
}

export function readNumericOverride(
  params,
  key,
  defaultValue,
  enabled,
  { min = 1, max = Number.MAX_SAFE_INTEGER } = {}
) {
  if (!enabled || !params || typeof params.get !== "function") return defaultValue;
  const raw = params.get(key);
  if (typeof raw !== "string" || raw.trim() === "") return defaultValue;

  const value = Number(raw);
  // Durations should be finite integer milliseconds. Invalid values fall back to the
  // normal rule; out-of-range integers are bounded so test links cannot create tiny or
  // unreasonably long timers even in staging.
  if (!Number.isFinite(value) || !Number.isInteger(value)) return defaultValue;
  return Math.max(min, Math.min(max, value));
}
