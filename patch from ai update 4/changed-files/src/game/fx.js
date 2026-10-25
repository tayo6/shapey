// Shapey - sound, tile-destruction and landing-dust effects, falling tiles and the
// spawn-shape roll. Extracted from GameScene (scenes/game.js) as a prototype mixin.

import { DESTROY_FRAME_X, DUST_FRAME_COUNT, DUST_FRAME_WIDTH, DUST_FRAME_HEIGHT, DUST_SCALE, DUST_FRAME_RATE, DUMMY_SPAWN_CHANCE, SHAPE_KEYS, MIN_MATCH, BASE_TILE_SIZE } from '../constants.js';
import { TILE_SIZE, TILE_PITCH } from '../config.js';

export const FxMixin = {
  // ------------------------------------------------------------------ fx
  createFx() {
    // slice the destroy sprite sheet into 6 frames and build the animation
    const tex = this.textures.get('tileDestroy');
    DESTROY_FRAME_X.forEach((x, i) => { if (!tex.has('d' + i)) tex.add('d' + i, 0, x, 0, 256, 241); });
    if (!this.anims.exists('tileDestroy')) this.anims.create({
      key: 'tileDestroy',
      frames: DESTROY_FRAME_X.map((_, i) => ({ key: 'tileDestroy', frame: 'd' + i })),
      frameRate: 14,
    });

    // landing dust: equal cells, each puff centred on the cell's middle (see DUST_FRAME_WIDTH)
    const dustTex = this.textures.get('dust');
    for (let i = 0; i < DUST_FRAME_COUNT; i++) {
      if (!dustTex.has('u' + i)) dustTex.add('u' + i, 0, i * DUST_FRAME_WIDTH, 0, DUST_FRAME_WIDTH, DUST_FRAME_HEIGHT);
    }
    if (!this.anims.exists('dustPuff')) this.anims.create({
      key: 'dustPuff',
      frames: Array.from({ length: DUST_FRAME_COUNT }, (_, i) => ({ key: 'dust', frame: 'u' + i })),
      frameRate: DUST_FRAME_RATE,
    });

    // flip sound: a few instances so quick flips can overlap
    if (!this.game.flipSounds) this.game.flipSounds = [0, 1, 2, 3].map(() => this.sound.add('flip', { volume: 0.55 }));
    this.flipSounds = this.game.flipSounds;
    this.flipSoundIndex = 0;
  },

  playFlipSound() {
    this.flipSounds[this.flipSoundIndex++ % this.flipSounds.length].play();
  },

  // Burn the matched tiles away with the destroy animation.
  async destroyTiles(tiles) {
    const step = Math.min(70, 600 / tiles.length);
    await Promise.all(
      tiles.map(async (tile, i) => {
        await this.sleep(i * step);
        this.tiles[tile.row][tile.col] = null;
        const fx = this.add.sprite(tile.x, tile.y, 'tileDestroy', 'd0').setDepth(13);
        fx.setScale(TILE_SIZE / 241); // constraint size: frame height = 90px (frame is 241px tall)
        this.removeRing(tile);
        tile.destroy();
        fx.play('tileDestroy');
        await new Promise((resolve) => fx.once('animationcomplete', resolve));
        fx.destroy();
      })
    );
  },

  // Drops a tile to targetY. With `dust`, a dust puff plays the moment it first lands.
  fall(tile, targetY, delay, dust = false) {
    const distance = Math.abs(targetY - tile.y) / TILE_PITCH;
    const duration = 260 + distance * 90;
    if (dust) {
      // Bounce.easeOut first touches the ground at 1 / 2.75 of the duration
      this.time.delayedCall(delay + duration / 2.75, () => this.spawnDust(tile.x, targetY));
    }
    return this.tweenAsync({ targets: tile, y: targetY, delay, duration, ease: 'Bounce.easeOut' });
  },

  // Dust cloud at the bottom edge of a tile that just landed.
  spawnDust(x, tileY) {
    const puff = this.add.sprite(x, tileY + TILE_SIZE / 2, 'dust', 'u0').setOrigin(0.5, 1).setDepth(13);
    // Scale landing dust with the tile, just like the tile-destruction animation.
    puff.setScale(DUST_SCALE * (TILE_SIZE / BASE_TILE_SIZE));
    puff.play('dustPuff');
    puff.once('animationcomplete', () => puff.destroy());
  },

  // New tile: a hazard (per-mode chance), occasionally a blank wooden dummy, otherwise the next shape
  // from the shuffle bag (see ShapeBag) so spawns stay varied.
  pickShape(counts) {
    if (Math.random() < this.hazardChance) return 'hazard';
    if (Math.random() < DUMMY_SPAWN_CHANCE) return 'dummy';
    return this.shapeBag.next(SHAPE_KEYS.filter((k) => (counts[k] || 0) < MIN_MATCH));
  },

};
