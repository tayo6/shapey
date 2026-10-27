// Layout presets (src/constants.js LAYOUTS): 'classic' must stay exactly the layout the live game has always
// used, and 'roomy' must give the meme slot more room without colliding with the header, the tray or the
// bottom navigation. Pure numbers only, so this runs in Node.

import test from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUTS, MEME_TOAST_Y, GAME_HEIGHT } from '../src/constants.js';

// Measured from the artwork (assets/backgrounds, assets/ui) at the sizes game.js draws them.
const TIMER_PLANK_BOTTOM = 156;  // timer plank: centre 101, height 109 at 262 px wide
const PLAYER2_PLANK_BOTTOM = 181; // the taller score plank: top 20, height 160.56
const TRAY_FRAME_TOP = 288;      // the tray image is 712 px tall, centred at GAME_HEIGHT / 2
const TRAY_FRAME_BOTTOM = 990;
const TRAY_SHADOW_BOTTOM = 1027;
const NAV_BUTTON_TOP = 1068;     // buttons are 146 px tall and end at 1214
const NAV_BUTTON_BOTTOM = 1214;

test('classic is exactly the original layout', () => {
  const c = LAYOUTS.classic;
  assert.deepEqual([c.headerShiftY, c.trayShiftY, c.navShiftY], [0, 0, 0]);
  assert.equal(c.toastY, 256);
  assert.equal(c.memeToastY, MEME_TOAST_Y);
  assert.deepEqual({ ...c.memeSlot }, { x: 360, y: 162, w: 300, h: 122 });
});

test('roomy moves the header up and the tray and navigation down', () => {
  const r = LAYOUTS.roomy;
  assert.ok(r.headerShiftY < 0, 'header moves up');
  assert.ok(r.trayShiftY > 0, 'tray moves down');
  assert.ok(r.navShiftY > 0, 'navigation moves down');
  // The score plank art starts at y = 20, so it may move up by at most 20 px before it is cropped.
  assert.ok(r.headerShiftY >= -20, 'score planks are not cropped');
});

test('roomy keeps the tray clear of the bottom navigation buttons', () => {
  const r = LAYOUTS.roomy;
  const shadowBottom = TRAY_SHADOW_BOTTOM + r.trayShiftY;
  const buttonTop = NAV_BUTTON_TOP + r.navShiftY;
  assert.ok(shadowBottom <= buttonTop, 'tray shadow ends above the buttons');
  assert.ok(NAV_BUTTON_BOTTOM + r.navShiftY < GAME_HEIGHT, 'button labels stay on screen');
});

test('roomy meme slot sits between the header and the tray', () => {
  const r = LAYOUTS.roomy;
  const slot = r.memeSlot;
  assert.ok(slot.y >= TIMER_PLANK_BOTTOM + r.headerShiftY, 'slot starts below the timer plank');
  assert.ok(slot.y + slot.h <= TRAY_FRAME_TOP + r.trayShiftY, 'slot ends above the tray frame');
  // The slot stays between the two score planks while it overlaps their rows.
  const planksBottom = PLAYER2_PLANK_BOTTOM + r.headerShiftY;
  if (slot.y < planksBottom) {
    assert.ok(slot.x - slot.w / 2 >= 210 && slot.x + slot.w / 2 <= 510, 'slot is between the score planks');
  }
});

test('roomy meme slot is clearly bigger than classic', () => {
  const classic = LAYOUTS.classic.memeSlot;
  const roomy = LAYOUTS.roomy.memeSlot;
  assert.ok(roomy.h >= classic.h * 1.4, 'at least 40% taller');
  assert.ok(roomy.w >= classic.w, 'never narrower');
});

test('roomy game messages fit their strips', () => {
  const r = LAYOUTS.roomy;
  assert.ok(r.toastY < TRAY_FRAME_TOP + r.trayShiftY, 'message sits above the tray');
  const stripTop = TRAY_FRAME_BOTTOM + r.trayShiftY;
  const stripBottom = NAV_BUTTON_TOP + r.navShiftY;
  assert.ok(r.memeToastY > stripTop && r.memeToastY < stripBottom, 'message sits between the tray and the buttons');
});
