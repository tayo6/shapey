// Shapey - entry point. Starts Phaser after the clean boot artwork is ready to show together.

import { GAME_WIDTH, GAME_HEIGHT } from './constants.js';
import { BootScene } from './scenes/boot.js';
import { LoadScene } from './scenes/load.js';
import { MenuScene } from './scenes/menu.js';
import { GameScene } from './scenes/game.js';

// Shapey - a memory game with candy-crush style cascades.
// The game canvas is 720 x 1280 ("720p" width) and scales to fit any screen.

// Start Phaser once the cleaned loading bar, logo and background are ready.
window.ShapeyLoadingBar.ready.then(() => {
  window.game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    backgroundColor: '#2b1a0f',
    banner: false,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: [BootScene, LoadScene, MenuScene, GameScene],
  });
});
