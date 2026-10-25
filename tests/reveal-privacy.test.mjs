import test from 'node:test';
import assert from 'node:assert/strict';
import { getRevealPrivacyRemainingMs } from '../src/game/reveal-privacy.js';

test('local reveal privacy uses the longest remaining local reveal', () => {
  assert.equal(getRevealPrivacyRemainingMs({ localRemaining: 4300 }), 4300);
  assert.equal(getRevealPrivacyRemainingMs({ localRemaining: -10 }), 0);
  assert.equal(getRevealPrivacyRemainingMs({ localRemaining: NaN }), 0);
});

test('online reveal privacy converts server deadlines using the synced clock', () => {
  const remaining = getRevealPrivacyRemainingMs({
    online: true,
    onlineState: {
      status: 'playing',
      reveals: [{ endsAt: 2200 }, { endsAt: 2900 }, { endsAt: 1800 }],
    },
    now: 1000,
    serverToLocal: (deadline) => deadline - 200,
  });
  assert.equal(remaining, 1700);
});

test('online study privacy includes the opening reveal deadline', () => {
  const remaining = getRevealPrivacyRemainingMs({
    online: true,
    onlineState: { status: 'study', reviewEndsAt: 3000, reveals: [] },
    now: 1000,
    serverToLocal: (deadline) => deadline - 250,
  });
  assert.equal(remaining, 1750);
});

test('online privacy ignores expired or invalid deadlines and never uses local reveal state', () => {
  const remaining = getRevealPrivacyRemainingMs({
    online: true,
    onlineState: {
      status: 'playing',
      reviewEndsAt: null,
      reveals: [{ endsAt: 900 }, { endsAt: 'not-a-time' }, {}],
    },
    now: 1000,
    localRemaining: 5000,
  });
  assert.equal(remaining, 0);
});

test('online privacy has no reveal window until an authoritative state arrives', () => {
  assert.equal(getRevealPrivacyRemainingMs({
    online: true,
    onlineState: null,
    now: 1000,
    localRemaining: 9000,
  }), 0);
});
