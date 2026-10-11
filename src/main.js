// Shapey - the game canvas is 720 x 1280 ("720p" width) and scales to fit any screen.
const GAME_WIDTH = 720;
const GAME_HEIGHT = 1280;

const FONT = 'HappySchool';
const TILE_SIZE = 90;   // every shape tile is drawn at 90 x 90
const TILE_PITCH = 91;  // distance between tile centres (90px tile + 1px gap)
const GRID_COLS = 7;
const GRID_ROWS = 7;

// Starting board, copied from the reference screenshot (row by row, left to right).
const BOARD = [
  ['square',  'circle',  'cancel',  'cancel',  'capsule', 'mystery', 'shield'],
  ['mystery', 'pointer', 'marked',  'corner',  'circle',  'sphere',  'x'],
  ['marked',  'corner',  'cancel',  'star',    'x',       'capsule', 'mystery'],
  ['sphere',  'mystery', 'pointer', 'cross',   'divide',  'cancel',  'shield'],
  ['mystery', 'divide',  'cross',   'divide',  'square',  'star',    'mystery'],
  ['cross',   'star',    'mystery', 'corner',  'marked',  'sphere',  'pointer'],
  ['capsule', 'cancel',  'shield',  'circle',  'square',  'x',       'mystery'],
];

// texture key -> file in assets/shapes
const SHAPE_FILES = {
  mystery: 'Mystery.png',
  cancel:  'cancel.png',
  capsule: 'capsule.png',
  circle:  'circle.png',
  cross:   'cross.png',
  divide:  'divide.png',
  corner:  'four corner.png',
  marked:  'marked.png',
  pointer: 'shield.png',   // orange gem (file names are swapped)
  shield:  'pointer.png',  // red gem
  sphere:  'sphere.png',
  square:  'square.png',
  star:    'star .png', // note: space before the dot in the filename
  x:       'x.png',
};

class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
  }

  preload() {
    this.load.setPath('assets');

    // backgrounds
    this.load.image('bg', 'backgrounds/BG.png');
    this.load.image('headerShadow', 'backgrounds/header shadow.png');
    this.load.image('headerPlank1', 'backgrounds/header  plank 1.png'); // two spaces in the filename
    this.load.image('trayShadow', 'backgrounds/Tray Shadow.png');
    this.load.image('tray', 'backgrounds/tray.png');
    this.load.image('bottomNav', 'backgrounds/bottom navigation.png');

    // ui
    this.load.image('playerPlank1', 'ui/player plank.png');
    this.load.image('playerPlank2', 'ui/player plank 2.png');
    this.load.image('timerPlank', 'ui/timer plank.png');
    this.load.image('starIcon', 'ui/Star.png');
    this.load.image('btnSettings', 'ui/settings.png');
    this.load.image('btnSubmit', 'ui/submit.png');
    this.load.image('btnPolls', 'ui/polls.png');
    this.load.image('btnChat', 'ui/chat.png');

    // shapes
    for (const [key, file] of Object.entries(SHAPE_FILES)) {
      this.load.image('shape_' + key, 'shapes/' + file);
    }
  }

  create() {
    this.createBackground();
    this.createHeader();
    this.createBottomButtons();
    this.createBoard();
  }

  // Scales an image so its width is exactly `width`, keeping the aspect ratio.
  fitToWidth(image, width = GAME_WIDTH) {
    image.setScale(width / image.width);
    return image;
  }

  // Layers from bottom to top: BG -> header shadow -> header plank 1
  //                            -> tray shadow -> tray -> bottom navigation
  createBackground() {
    this.bg = this.fitToWidth(this.add.image(0, 0, 'bg').setOrigin(0, 0)).setDepth(0);

    this.headerShadow = this.fitToWidth(
      this.add.image(GAME_WIDTH / 2, 0, 'headerShadow').setOrigin(0.5, 0)
    ).setDepth(1);

    this.headerPlank = this.fitToWidth(
      this.add.image(GAME_WIDTH / 2, 0, 'headerPlank1').setOrigin(0.5, 0)
    ).setDepth(2);

    this.trayShadow = this.fitToWidth(
      this.add.image(GAME_WIDTH / 2, GAME_HEIGHT / 2, 'trayShadow')
    ).setDepth(3);

    this.tray = this.fitToWidth(
      this.add.image(this.trayShadow.x, this.trayShadow.y, 'tray')
    ).setDepth(4);

    this.bottomNav = this.fitToWidth(
      this.add.image(GAME_WIDTH / 2, GAME_HEIGHT, 'bottomNav').setOrigin(0.5, 1)
    ).setDepth(5);
  }

  numberText(x, y, text, size) {
    return this.add.text(x, y, text, {
      fontFamily: FONT,
      fontSize: size + 'px',
      color: '#ffffff',
      stroke: '#3a2412',
      strokeThickness: Math.round(size / 9),
    }).setOrigin(0.5).setDepth(11);
  }

  // Score planks, timer and stars.
  createHeader() {
    const SCALE = 0.24;

    // Player 1 (left)
    const p1 = this.add.image(105, 20, 'playerPlank1').setOrigin(0.5, 0).setScale(SCALE).setDepth(10);
    this.p1Score = this.numberText(p1.x + 2, p1.y + p1.displayHeight * 0.35, '59', 46);
    this.p1Name = this.numberText(p1.x - 4, p1.y + p1.displayHeight * 0.83, 'Player 1', 21);

    // Player 2 (right)
    const p2 = this.add.image(612, 20, 'playerPlank2').setOrigin(0.5, 0).setScale(SCALE).setDepth(10);
    this.p2Score = this.numberText(p2.x - 4, p2.y + p2.displayHeight * 0.35, '45', 46);
    this.p2Name = this.numberText(p2.x - 4, p2.y + p2.displayHeight * 0.83, 'Player 2', 21);

    // Timer (centre)
    const timer = this.fitToWidth(this.add.image(GAME_WIDTH / 2, 101, 'timerPlank'), 262).setDepth(10);
    this.timerText = this.numberText(timer.x + 24, timer.y + 2, '00:45', 46);

    // Stars under each player's plank
    this.p1Stars = this.createStars(38, 213, 5);
    this.p2Stars = this.createStars(546, 213, 5);
  }

  createStars(startX, y, count) {
    const stars = [];
    for (let i = 0; i < count; i++) {
      stars.push(
        this.add.image(startX + i * 31.7, y, 'starIcon').setDisplaySize(30, 30).setDepth(10)
      );
    }
    return stars;
  }

  createBottomButtons() {
    const BUTTON_HEIGHT = 146;
    const BOTTOM = 1214; // bottom edge of the label plank
    const buttons = [
      ['btnSettings', 136],
      ['btnSubmit', 296],
      ['btnPolls', 449],
      ['btnChat', 602],
    ];
    this.buttons = {};
    for (const [key, x] of buttons) {
      const btn = this.add.image(x, BOTTOM, key).setOrigin(0.5, 1).setDepth(10);
      btn.setScale(BUTTON_HEIGHT / btn.height);
      this.buttons[key] = btn;
    }
  }

  // 7 x 7 board, centred on the tray. Every tile is 90 x 90.
  createBoard() {
    const startX = this.tray.x - ((GRID_COLS - 1) * TILE_PITCH) / 2;
    const startY = this.tray.y - ((GRID_ROWS - 1) * TILE_PITCH) / 2;
    this.tiles = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      this.tiles[r] = [];
      for (let c = 0; c < GRID_COLS; c++) {
        const tile = this.add
          .image(startX + c * TILE_PITCH, startY + r * TILE_PITCH, 'shape_' + BOARD[r][c])
          .setDisplaySize(TILE_SIZE, TILE_SIZE)
          .setDepth(10);
        tile.setData({ row: r, col: c, shape: BOARD[r][c] });
        this.tiles[r][c] = tile;
      }
    }
  }
}

// Wait for the custom font so the first frame already uses it.
document.fonts.load(`20px ${FONT}`).catch(() => {}).finally(() => {
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
});
