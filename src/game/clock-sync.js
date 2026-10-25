// Shapey - device clock synchronisation for online play.
//
// Every deadline the Worker sends (turnEndsAt, reviewEndsAt, reveals[].endsAt, poll endsAt,
// tile movingUntil, pendingEffect.endsAt) is a server wall-clock timestamp, and every snapshot
// carries `serverNow`. A browser whose device clock is wrong (minutes off is common on phones)
// must convert those deadlines to its own clock before comparing them with Date.now(), or every
// countdown is wrong by exactly the skew.
//
// Latency analysis - why this is not just `serverNow - Date.now()`:
// A snapshot stamped serverNow = S only reaches the page's message handler L milliseconds
// later, so the earliest Date.now() the handler can observe is C = S - trueOffset + L, giving
//   measuredOffset = S - C = trueOffset - L.
// The naive estimate therefore under-reads the true offset by the downstream latency L, and
// because L jitters between snapshots, every new snapshot would move every displayed deadline
// by the jitter (countdowns visibly wobbling). Latency only ever LOWERS a sample, so this
// estimator keeps the maximum sample inside a short sliding window: the windowed maximum is
// the sample that suffered the least latency, i.e. the tightest lower bound on the true
// offset, and countdowns stop following network jitter.
//
// Timing tolerance (expected behaviour for tests and reviews):
// - Displayed deadlines run at most min(L) late and never early relative to the server's
//   clock, where min(L) is the best downstream latency observed inside the window
//   (typically < 50ms against a local Worker, < 300ms over the internet).
// - The offset may rise immediately when a faster sample arrives (a one-time correction of
//   the previous latency gap) but falls at most CLOCK_SYNC_MAX_FALL_MS per snapshot, so
//   ordinary clock drift never makes a deadline visibly jump forward. The very first
//   measurement is adopted at once - the initial 0 is a guess, not a measurement to protect.
// - A sustained large drop - every sample inside the window disagrees with the current
//   offset, meaning the delivery that produced it has aged out - is adopted at once rather
//   than eased down over hundreds of snapshots. Because the window is measured in
//   device-clock deltas, a mid-session device-clock correction is always adopted on the
//   first snapshot afterwards (a forward jump ages the old samples out instantly; a
//   backward jump makes the fresh samples snap the offset up). Ordinary latency spikes
//   cannot trigger the reset while any faster sample remains inside the window.
// - Turn switching itself is always server-authoritative: the Worker's Durable Object alarm
//   advances the game at the true deadline regardless of what any client displays, so no
//   client-side estimate can extend a player's turn.

export const CLOCK_SYNC_WINDOW_MS = 15_000;
export const CLOCK_SYNC_MAX_FALL_MS = 100;
export const CLOCK_SYNC_RESET_MS = 1_500;

export function createServerClockSync() {
  let offset = 0;
  let samples = [];
  let lastSampleAt = 0;
  let hasMeasurement = false;

  const sync = {
    get offset() { return offset; },
    get lastSampleAt() { return lastSampleAt; },
    get sampleCount() { return samples.length; },

    // serverNow: the snapshot's server wall-clock. receivedAt: Date.now() captured the moment
    // the snapshot arrived (before JSON.parse), only for freshly received snapshots - never
    // for replays of cached state, which would measure the snapshot's age as skew.
    update(serverNow, receivedAt) {
      if (!Number.isFinite(serverNow) || !Number.isFinite(receivedAt)) return offset;
      samples.push({ at: receivedAt, offset: serverNow - receivedAt });
      samples = samples.filter((entry) => receivedAt - entry.at <= CLOCK_SYNC_WINDOW_MS);
      lastSampleAt = receivedAt;

      const best = Math.max(...samples.map((entry) => entry.offset));
      if (!hasMeasurement || best >= offset) {
        // The first measurement (the initial 0 is a guess, not a measurement - adopting it
        // slowly would take hundreds of snapshots on an ahead-of-server device clock), or a
        // faster delivery / upward drift: adopt the tighter bound immediately.
        offset = best;
        hasMeasurement = true;
        return offset;
      }
      if (best < offset - CLOCK_SYNC_RESET_MS) {
        // Every sample inside the window disagrees with the current offset by a wide margin,
        // so the delivery that produced the current offset has aged out: the device clock was
        // corrected mid-session (or the network degraded for a full window). Adopt the
        // window's best instead of easing down over hundreds of snapshots. Adopting a lower
        // offset moves deadlines later - the safe direction; a later fast delivery that
        // proves the old offset right snaps it back up immediately.
        offset = best;
        return offset;
      }
      // Small downward drift: track the windowed maximum, but only ease down slowly so
      // displayed deadlines never jump forward by more than CLOCK_SYNC_MAX_FALL_MS per snapshot.
      offset = Math.max(best, offset - CLOCK_SYNC_MAX_FALL_MS);
      return offset;
    },

    // Converts a server wall-clock timestamp to this device's clock.
    serverToLocal(at) {
      return Number.isFinite(at) ? at - offset : at;
    },

    reset() {
      offset = 0;
      samples = [];
      lastSampleAt = 0;
      hasMeasurement = false;
    }
  };
  return sync;
}
