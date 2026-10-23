// Shapey - turn/reveal/inventory time tracking.
// Countdown, RevealTracker and InventoryLimiter work against an injected clock,
// so they stay correct however often the screen redraws. No Phaser, no DOM;
// unit-tested in tests/trackers.test.mjs.


// A countdown to an absolute deadline (never a tick counter), so it stays correct however
// often the screen redraws and can run alongside any other countdown.

import { shuffle } from './utils.js';

export class Countdown {
  constructor(clock = Date.now) {
    this.clock = clock;
    this.endsAt = 0;
  }
  start(ms) { this.endsAt = this.clock() + ms; }
  // Freeze the outgoing turn clock while the submitted move is being resolved.
  stop() { this.endsAt = this.clock(); }
  remaining() { return Math.max(0, this.endsAt - this.clock()); }
  expired() { return this.clock() >= this.endsAt; }
}

// Tracks the "memorize" countdown of every batch of newly revealed tiles. Each batch has its own
// deadline (15s for the opening board, 5s for spawned tiles), independent of the turn clock.
// `shuffle` says whether the batch is shuffled after it flips face-down.
export class RevealTracker {
  constructor(clock = Date.now) {
    this.clock = clock;
    this.batches = [];
  }
  add(tiles, ms, shuffle = false) { this.batches.push({ tiles, shuffle, endsAt: this.clock() + ms }); }
  // Pending batches will still flip face-down, but will no longer be shuffled.
  cancelShuffles() { this.batches.forEach((b) => { b.shuffle = false; }); }
  // Longest time left among the batches still being shown (0 when nothing is being revealed).
  remaining() {
    const now = this.clock();
    return this.batches.reduce((most, b) => Math.max(most, b.endsAt - now), 0);
  }
  // Batches ({ tiles, shuffle }) whose reveal time is over; they are removed from the tracker.
  takeDue() {
    const now = this.clock();
    const due = this.batches.filter((b) => b.endsAt <= now);
    this.batches = this.batches.filter((b) => b.endsAt > now);
    return due;
  }
}

// Rolling-window cap on how often each player may open the inventory.
export class InventoryLimiter {
  constructor(limit, windowMs, playerCount, clock = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
    this.opens = Array.from({ length: playerCount }, () => []); // open timestamps per player
  }
  recent(player) {
    const cutoff = this.clock() - this.windowMs;
    this.opens[player] = this.opens[player].filter((t) => t > cutoff);
    return this.opens[player];
  }
  // Records an open when allowed. When refused, nothing is recorded and retryInMs says how long to wait.
  tryOpen(player) {
    const recent = this.recent(player);
    if (recent.length >= this.limit) {
      const retryInMs = recent[recent.length - this.limit] + this.windowMs - this.clock();
      return { allowed: false, left: 0, retryInMs: Math.max(0, retryInMs) };
    }
    recent.push(this.clock());
    return { allowed: true, left: this.limit - recent.length, retryInMs: 0 };
  }
}
