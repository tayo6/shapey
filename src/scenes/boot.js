// Shapey - BootScene: stage 1 of loading (logo + loading bar only), then hands over to LoadScene.


// Stage 1: fetches only the logo and the loading bar (two small images), while the HTML placeholder is still up.

export class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload() {
    this.load.setPath('assets');
    this.load.image('logo', 'ui/shapey logo.webp');
  }

  create() {
    // Reuse the immediately available canvas; loading-bar.js cleans it in the background.
    this.textures.addCanvas('loadRect', window.ShapeyLoadingBar.canvas);
    this.scene.start('LoadScene');
  }
}
