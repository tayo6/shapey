// Shapey - game canvas is 720 x 1280 ("720p" width), scaled to fit any screen.
const GAME_WIDTH = 720;
const GAME_HEIGHT = 1280;

class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
  }

  preload() {
    this.load.setPath('assets/backgrounds');
    this.load.image('bg', 'BG.png');
    this.load.image('headerShadow', 'header shadow.png');
    this.load.image('headerPlank1', 'header  plank 1.png'); // note: two spaces in the filename
    this.load.image('trayShadow', 'Tray Shadow.png');
    this.load.image('tray', 'tray.png');
    this.load.image('bottomNav', 'bottom navigation.png');
  }

  create() {
    this.createBackground();
  }

  // Scales an image so its width is exactly GAME_WIDTH, keeping its aspect ratio.
  fitToWidth(image) {
    image.setScale(GAME_WIDTH / image.width);
    return image;
  }

  // Layers from bottom to top: BG -> header shadow -> header plank 1
  //                            -> tray shadow -> tray -> bottom navigation
  createBackground() {
    // 1. BG: 720 wide, top-left of the screen
    this.bg = this.fitToWidth(this.add.image(0, 0, 'bg').setOrigin(0, 0)).setDepth(0);

    // 2. Header shadow: 720 wide, top aligned at y = 0
    this.headerShadow = this.fitToWidth(
      this.add.image(GAME_WIDTH / 2, 0, 'headerShadow').setOrigin(0.5, 0)
    ).setDepth(1);

    // 3. Header plank 1: 720 wide, top aligned at y = 0
    this.headerPlank = this.fitToWidth(
      this.add.image(GAME_WIDTH / 2, 0, 'headerPlank1').setOrigin(0.5, 0)
    ).setDepth(2);

    // 4. Tray shadow: 720 wide, centered in the middle of the screen
    this.trayShadow = this.fitToWidth(
      this.add.image(GAME_WIDTH / 2, GAME_HEIGHT / 2, 'trayShadow')
    ).setDepth(3);

    // 5. Tray: 720 wide, centered on the tray shadow
    this.tray = this.fitToWidth(
      this.add.image(this.trayShadow.x, this.trayShadow.y, 'tray')
    ).setDepth(4);

    // 6. Bottom navigation: 720 wide, bottom aligned to the screen bottom
    this.bottomNav = this.fitToWidth(
      this.add.image(GAME_WIDTH / 2, GAME_HEIGHT, 'bottomNav').setOrigin(0.5, 1)
    ).setDepth(5);
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  backgroundColor: '#000000',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [GameScene],
});
