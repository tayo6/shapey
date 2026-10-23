// Shapey - BootScene: stage 1 of loading (background, logo and loading bar only), then hands over to LoadScene.


// Stage 1: fetches only the textured background and the logo (two small images), while the HTML boot screen
// from index.html is still up. The load-bar plank was already prepared by src/loading-bar.js.

export class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload() {
    this.load.setPath('assets');
    this.load.image('bg', 'backgrounds/BG.webp');
    this.load.image('logo', 'ui/shapey logo.webp');
  }

  create() {
    // The plank is final by now (src/loading-bar.js finishes it before it reveals the boot screen).
    const loadingBar = window.ShapeyLoadingBar;
    if (loadingBar && loadingBar.canvas) this.textures.addCanvas('loadRect', loadingBar.canvas);
    else this.textures.createCanvas('loadRect', 840, 175);
    this.scene.start('LoadScene');
  }
}
