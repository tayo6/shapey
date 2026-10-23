// Unit tests for src/trackers.js (Countdown, RevealTracker, InventoryLimiter).
// All three take an injected clock, so time is simulated exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Countdown, RevealTracker, InventoryLimiter } from '../src/trackers.js';

// A controllable clock: a closure (not a method) so it survives being passed around.
function fakeClock(startAt = 0) {
  const state = { now: startAt };
  return { state, fn: () => state.now };
}

test('Countdown tracks its deadline and expires exactly at it', () => {
  const { state, fn } = fakeClock(1000);
  const c = new Countdown(fn);
  assert.equal(c.expired(), true, 'a fresh countdown has never started');
  c.start(5000);
  assert.equal(c.expired(), false);
  assert.equal(c.remaining(), 5000);
  state.now = 5000; // 4s later
  assert.equal(c.remaining(), 1000);
  assert.equal(c.expired(), false);
  state.now = 6000;
  assert.equal(c.expired(), true);
  assert.equal(c.remaining(), 0, 'remaining never goes negative');
});

test('Countdown.stop parks the outgoing clock at the submit instant', () => {
  // Used by submit(): the outgoing player's clock must not consume the time spent
  // resolving the move, so stop() pins the deadline to now. From that moment the
  // countdown reads zero/expired and never shows time again until a new start().
  const { state, fn } = fakeClock(0);
  const c = new Countdown(fn);
  c.start(10000);
  state.now = 4000;
  c.stop();
  assert.equal(c.remaining(), 0);
  assert.equal(c.expired(), true);
  state.now = 9000; // resolution takes another 5s...
  assert.equal(c.remaining(), 0, 'the parked clock does not run down further');
  assert.equal(c.expired(), true);
  c.start(3000); // the next player gets a fresh deadline
  assert.equal(c.remaining(), 3000);
  assert.equal(c.expired(), false);
});

test('RevealTracker reports the longest remaining reveal and hands due batches back once', () => {
  const { state, fn } = fakeClock(0);
  const t = new RevealTracker(fn);
  const opening = [{ id: 1 }, { id: 2 }];
  const spawned = [{ id: 3 }];
  t.add(opening, 15000, true);
  state.now = 10000; // 5s before the opening flips, a spawned tile appears
  t.add(spawned, 5000, true);
  assert.equal(t.remaining(), 5000);
  state.now = 15000;
  assert.equal(t.remaining(), 0);
  const due = t.takeDue();
  assert.equal(due.length, 2);
  assert.deepEqual(due[0].tiles, opening);
  assert.equal(due[0].shuffle, true);
  assert.equal(due[1].tiles[0].id, 3);
  assert.deepEqual(t.takeDue(), [], 'a due batch is removed when taken');
  assert.equal(t.remaining(), 0);
});

test('RevealTracker.cancelShuffles keeps flipping but stops shuffling', () => {
  const { state, fn } = fakeClock(0);
  const t = new RevealTracker(fn);
  t.add([{ id: 1 }], 1000, true);
  t.cancelShuffles();
  state.now = 1000;
  const [batch] = t.takeDue();
  assert.equal(batch.shuffle, false, 'pending batches flip face-down but are no longer shuffled');
});

test('InventoryLimiter enforces a rolling per-player window', () => {
  const { state, fn } = fakeClock(0);
  const limiter = new InventoryLimiter(2, 60000, 2, fn);
  assert.deepEqual(limiter.tryOpen(0), { allowed: true, left: 1, retryInMs: 0 });
  state.now = 5000;
  assert.deepEqual(limiter.tryOpen(0), { allowed: true, left: 0, retryInMs: 0 });
  const refused = limiter.tryOpen(0);
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryInMs > 0 && refused.retryInMs <= 60000);
  // The other player has their own budget.
  assert.equal(limiter.tryOpen(1).allowed, true);
  // At 60.001s the first open (t=0) has rolled out of the window, the second (t=5s) is still in.
  state.now = 60001;
  assert.equal(limiter.tryOpen(0).allowed, true);
  assert.equal(limiter.tryOpen(0).allowed, false); // the t=5s open is still inside the window
  // At 65.001s that one has rolled out too.
  state.now = 65001;
  assert.equal(limiter.tryOpen(0).allowed, true);
});

test('InventoryLimiter refused opens are not recorded', () => {
  const { state, fn } = fakeClock(0);
  const limiter = new InventoryLimiter(1, 1000, 1, fn);
  limiter.tryOpen(0);
  for (let i = 0; i < 5; i++) assert.equal(limiter.tryOpen(0).allowed, false);
  state.now = 1001; // window passed; the refusals did not extend it
  assert.equal(limiter.tryOpen(0).allowed, true);
});
