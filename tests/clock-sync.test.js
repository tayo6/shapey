// Shapey - unit tests for the online device-clock-skew estimator (src/game/clock-sync.js).
//
// The Worker stamps every snapshot with serverNow; the client measures
//   sample = serverNow - receivedAt = trueOffset - downstreamLatency
// so latency only ever lowers a sample. These tests pin the agreed behaviour:
//   1. the estimator converges to the true offset minus the best observed latency,
//   2. it never reports an offset above the true offset (deadlines never run early),
//   3. network jitter does not wobble deadlines (windowed minimum-latency filter),
//   4. downward drift is eased (no visible forward jumps in displayed deadlines),
//   5. a corrected device clock is adopted quickly (sustained large drop resets),
//   6. serverToLocal() round-trips server deadlines onto the device clock.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createServerClockSync,
  CLOCK_SYNC_WINDOW_MS,
  CLOCK_SYNC_MAX_FALL_MS,
  CLOCK_SYNC_RESET_MS
} from '../src/game/clock-sync.js';

// Simulates a device whose clock is off by trueOffset talking to a server reached with the
// per-message downstream latencies in latencies (ms). Returns the sync object plus helpers.
function simulate(trueOffset, latencies, stepMs = 1000) {
  const sync = createServerClockSync();
  let serverTime = 1_000_000;
  let deviceTime = serverTime - trueOffset; // server = device + trueOffset
  const feed = () => {
    const latency = latencies.next().value;
    serverTime += stepMs;
    deviceTime += stepMs;
    const serverNow = serverTime;
    const receivedAt = deviceTime + latency; // arrives `latency` after the server stamped it
    sync.update(serverNow, receivedAt);
    return { serverNow, receivedAt, latency };
  };
  return { sync, feed, serverAt: () => serverTime, deviceAt: () => deviceTime };
}

test('converges to the true offset minus the best observed latency', () => {
  const { sync, feed } = simulate(30_000, [120, 80, 200, 40, 95, 30][Symbol.iterator]());
  for (let i = 0; i < 6; i++) feed();
  // The fastest delivery observed had 30ms of latency, so the estimate is 30ms low.
  assert.ok(Math.abs(sync.offset - (30_000 - 30)) <= 1, `offset ${sync.offset} should be ~(30000-30)`);
});

test('never reports an offset above the true offset, so deadlines never run early', () => {
  const latencies = [5, 400, 12, 350, 8, 500, 20, 280, 15, 600];
  const { sync, feed } = simulate(-45_000, latencies[Symbol.iterator]());
  for (let i = 0; i < latencies.length; i++) {
    feed();
    assert.ok(sync.offset <= -45_000 + 1,
      `sample ${i}: offset ${sync.offset} must not exceed the true offset -45000`);
  }
});

test('network jitter does not wobble the converted deadline', () => {
  // Alternate fast and slow deliveries; the naive "latest sample" estimate would swing by
  // hundreds of ms between snapshots, visibly jerking every countdown.
  const latencies = [10, 300, 10, 300, 10, 300, 10, 300, 10, 300];
  const { sync, feed } = simulate(0, latencies[Symbol.iterator]());
  const deadline = 2_000_000; // a server-side deadline
  const readings = [];
  for (let i = 0; i < latencies.length; i++) {
    feed();
    readings.push(sync.serverToLocal(deadline));
  }
  const maxSwing = Math.max(...readings) - Math.min(...readings);
  assert.ok(maxSwing <= CLOCK_SYNC_MAX_FALL_MS,
    `converted deadline swung ${maxSwing}ms across jittered snapshots; expected <= ${CLOCK_SYNC_MAX_FALL_MS}ms`);
  // And the reading is at most one fast-sample latency behind the truth.
  assert.ok(readings[readings.length - 1] - (deadline - 0) >= -10 - 1);
  assert.ok(readings[readings.length - 1] - (deadline - 0) <= 10 + 1);
});

test('downward drift is eased, never a visible forward jump', () => {
  const { sync, feed } = simulate(60_000, [5][Symbol.iterator]());
  feed();
  const before = sync.offset;
  // The device clock now drifts down 1s per snapshot (fast crystal): true offset falls to 55000.
  let serverTime = 1_000_000, deviceTime = serverTime - 60_000;
  const drift = () => {
    serverTime += 1000;
    deviceTime += 1000 - 1000; // device clock runs 1s fast per interval
    sync.update(serverTime, deviceTime + 5);
  };
  drift();
  assert.ok(before - sync.offset <= CLOCK_SYNC_MAX_FALL_MS,
    `offset fell ${before - sync.offset}ms in one snapshot; cap is ${CLOCK_SYNC_MAX_FALL_MS}ms`);
});

test('a forward device-clock correction is adopted immediately', () => {
  const sync = createServerClockSync();
  // Steady state: the device matches the server within 5ms of downstream latency.
  sync.update(1_000_000, 999_995);
  assert.ok(Math.abs(sync.offset - 5) <= 1, `offset ${sync.offset} should be ~+5`);
  // The user corrects their clock so the device is suddenly 25s AHEAD of the server.
  // The window is measured in device-clock deltas, so the pre-correction sample (received
  // before the jump) immediately counts as 25s stale and ages out: the first corrected
  // sample stands alone, far below the old offset, and is adopted at once.
  const serverTime = 1_001_000;
  const deviceTime = serverTime + 25_000; // device clock jumped forward
  sync.update(serverTime, deviceTime + 5);
  assert.ok(Math.abs(sync.offset - (-25_000 - 5)) <= 1,
    `offset ${sync.offset} should have adopted the corrected clock (~-25005) immediately`);
  sync.update(serverTime + 1000, deviceTime + 1005);
  assert.ok(Math.abs(sync.offset - (-25_000 - 5)) <= 1, 'and it stays locked on');
});

test('a backward device-clock correction is adopted immediately', () => {
  const sync = createServerClockSync();
  sync.update(1_000_000, 999_995); // offset ~+5
  // The device clock jumps 25s BEHIND the server: fresh samples measure far ABOVE the old
  // offset, and the windowed maximum adopts the tighter bound at once (snap up).
  const serverTime = 1_001_000;
  const deviceTime = serverTime - 25_000; // device clock jumped backward
  sync.update(serverTime, deviceTime + 5);
  assert.ok(Math.abs(sync.offset - (25_000 - 5)) <= 1,
    `offset ${sync.offset} should have snapped up to ~+24995 immediately`);
});

test('stale samples leave the window so the estimate keeps following the true offset', () => {
  const { sync, feed } = simulate(10_000, [20][Symbol.iterator]());
  feed();
  const stale = sync.offset;
  // A long quiet period: the next snapshot arrives after the window has expired.
  let serverTime = 1_000_000, deviceTime = serverTime - 10_000;
  serverTime += CLOCK_SYNC_WINDOW_MS + 5000;
  deviceTime += CLOCK_SYNC_WINDOW_MS + 5000;
  sync.update(serverTime, deviceTime + 20);
  // The stale sample is gone; the new sample stands alone.
  assert.ok(Math.abs(sync.offset - (10_000 - 20)) <= 1, `offset ${sync.offset}, stale was ${stale}`);
});

test('serverToLocal converts a server deadline onto the device clock', () => {
  const trueOffset = 5000; // server runs 5s ahead of the device
  const { sync, feed, serverAt, deviceAt } = simulate(trueOffset, [10][Symbol.iterator]());
  feed();
  const deadline = serverAt() + 45_000; // a turn deadline 45s in the server's future
  const localDeadline = sync.serverToLocal(deadline);
  assert.ok(Math.abs(localDeadline - (deviceAt() + 45_000)) <= 11,
    `local deadline ${localDeadline} should be ~deviceNow+45000`);
  assert.equal(sync.serverToLocal(Number.NaN), Number.NaN); // non-finite passes through
  assert.equal(sync.serverToLocal('not-a-number'), 'not-a-number');
});

test('replays (no update) keep the last measured offset, and reset() clears everything', () => {
  const sync = createServerClockSync();
  sync.update(1_000_000, 990_000); // offset 10_000
  assert.equal(sync.offset, 10_000);
  assert.equal(sync.lastSampleAt, 990_000);
  assert.equal(sync.sampleCount, 1);
  sync.reset();
  assert.equal(sync.offset, 0);
  assert.equal(sync.sampleCount, 0);
  assert.equal(sync.lastSampleAt, 0);
  // After reset, deadlines pass through unconverted until a fresh snapshot arrives.
  assert.equal(sync.serverToLocal(123_456), 123_456);
});

test('non-finite snapshots are ignored', () => {
  const sync = createServerClockSync();
  sync.update(Number.NaN, Date.now());
  sync.update(1_000_000, Number.NaN);
  assert.equal(sync.offset, 0);
  assert.equal(sync.sampleCount, 0);
});
