// Shapey - shared UI building blocks used by the menu, the in-game panel and the
// game-over screen: the wooden button and the room-code modal stylesheet.


// Styles for the room-code entry panel (MenuScene.askRoomCode). Same colours as the game's popups and wooden buttons:
// panel 0x4b2d17 with a gold border, dark slot 0x25180f, wood buttons 0x754322 with a sand border, outlined Happy School text.

import { FONT } from './constants.js';

export const JOIN_MODAL_CSS = `
#shapey-join-modal { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center;
  padding: 16px; box-sizing: border-box; background: rgba(18, 10, 5, .84); font-family: ${FONT}, 'Comic Sans MS', cursive; }
#shapey-join-modal .panel { box-sizing: border-box; width: min(100%, 460px); padding: 26px 22px 22px; background: #4b2d17;
  border: 5px solid #d5ad72; display: flex; flex-direction: column; gap: 14px; text-align: center; }
#shapey-join-modal h2 { margin: 0; font-weight: normal; font-size: 34px; line-height: 1.1; color: #fff2c7;
  -webkit-text-stroke: .17em #3a2412; paint-order: stroke fill; stroke-linejoin: round; }
#shapey-join-modal p { margin: 0; font-size: 19px; line-height: 1.3; color: #ffe9b8; }
#shapey-join-modal input { box-sizing: border-box; width: 100%; height: 66px; padding: 0 12px; text-align: center; text-indent: .22em;
  font: inherit; font-size: 36px; letter-spacing: .22em; text-transform: uppercase; color: #ffe36e; background: #25180f;
  border: 4px solid #8b623a; border-radius: 0; outline: none; }
#shapey-join-modal input:focus { border-color: #ffe36e; }
#shapey-join-modal .err { min-height: 22px; font-size: 17px; line-height: 1.3; color: #ffb09e; }
#shapey-join-modal .row { display: flex; gap: 12px; }
#shapey-join-modal button { flex: 1; min-height: 58px; font: inherit; font-size: 26px; line-height: 1; color: #fff; background: #754322;
  border: 4px solid #f3d29a; border-radius: 0; cursor: pointer; -webkit-text-stroke: .17em #3a2412; paint-order: stroke fill;
  stroke-linejoin: round; transition: transform .07s; }
#shapey-join-modal button:active { transform: scale(.96); }
#shapey-join-modal button:focus-visible { outline: 3px solid #ffe36e; outline-offset: 2px; }
`;

// A wooden button used by the menu, the in-game panel and the game-over screen.
export function woodButton(scene, x, y, w, h, label, fontSize, onTap, depth = 0, sub = null) {
  const bg = scene.add.rectangle(x, y, w, h, 0x754322, 1).setStrokeStyle(4, 0xf3d29a)
    .setDepth(depth).setInteractive({ useHandCursor: true });
  const text = scene.add.text(x, sub ? y - h * 0.17 : y, label, {
    fontFamily: FONT, fontSize: fontSize + 'px', color: '#ffffff',
    stroke: '#3a2412', strokeThickness: Math.round(fontSize / 6),
  }).setOrigin(0.5).setDepth(depth + 1);
  const objects = [bg, text];
  if (sub) {
    objects.push(scene.add.text(x, y + h * 0.25, sub, {
      fontFamily: FONT, fontSize: '20px', color: '#ffe9b8', align: 'center', wordWrap: { width: w - 40 },
    }).setOrigin(0.5).setDepth(depth + 1));
  }
  bg.on('pointerdown', () => {
    scene.tweens.add({ targets: [bg, text], scale: 0.96, duration: 70, yoyo: true });
    onTap();
  });
  return objects;
}
