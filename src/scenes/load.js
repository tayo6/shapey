// Shapey - LoadScene: stage 2 of loading. Draws the same logo/load-bar picture as the
// index.html placeholder, loads every other asset, and routes to the menu, a direct
// ?mode= game, or the audience watch flow (?watch=CODE).


// Starts loading the custom font right away (in parallel with Phaser and the art). A slow or failed
// font load never blocks the game for more than 2.5 seconds.

import { GAME_WIDTH, GAME_HEIGHT, FONT, SHAPE_FILES, LOGO_W, LOGO_Y, LOAD_BAR_W, LOAD_BAR_Y, LOAD_TRACK, LOAD_MIN_FILL } from '../constants.js';
import { urlParams, AUDIENCE_WATCH_CODE, START_MODE, STAGING, API_OVERRIDDEN, MULTIPLAYER_API } from '../config.js';

const fontReady = Promise.race([
  document.fonts.load(`20px ${FONT}`),
  new Promise((resolve) => setTimeout(resolve, 2500)),
]).catch(() => {});

// Stage 2: shows the same background, logo and clean load bar as the HTML placeholder, then loads
// everything else while the bar fills.
export class LoadScene extends Phaser.Scene {
  constructor() {
    super('LoadScene');
  }

  preload() {
    this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x2b1a0f);
    // The textured background was loaded by BootScene, so it is visible with the logo and load bar.
    if (this.textures.exists('bg')) this.add.image(0, 0, 'bg').setOrigin(0, 0).setDisplaySize(GAME_WIDTH, GAME_HEIGHT);
    const logo = this.add.image(GAME_WIDTH / 2, LOGO_Y, 'logo');
    logo.setScale(LOGO_W / logo.width);

    const bar = this.add.image(GAME_WIDTH / 2, LOAD_BAR_Y, 'loadRect');
    const k = LOAD_BAR_W / bar.width;
    bar.setScale(k);
    const left = bar.x - bar.displayWidth / 2;
    const top = bar.y - bar.displayHeight / 2;
    const slotX = left + LOAD_TRACK.x0 * bar.displayWidth;
    const slotW = (LOAD_TRACK.x1 - LOAD_TRACK.x0) * bar.displayWidth;
    const slotY = top + LOAD_TRACK.y0 * bar.displayHeight;
    const slotH = (LOAD_TRACK.y1 - LOAD_TRACK.y0) * bar.displayHeight;
    // gold fill with a lighter top half for a glossy look; both grow with the load progress
    const fill = this.add.rectangle(slotX, slotY, slotW * LOAD_MIN_FILL, slotH, 0xf2b84b).setOrigin(0, 0);
    const gloss = this.add.rectangle(slotX, slotY, slotW * LOAD_MIN_FILL, slotH * 0.45, 0xffe3a0, 0.7).setOrigin(0, 0);
    const setProgress = (value) => {
      const w = slotW * (LOAD_MIN_FILL + (1 - LOAD_MIN_FILL) * value);
      fill.width = w;
      gloss.width = w;
    };
    this.load.on('progress', setProgress);

    // the load animation: the logo gently bobs and the fill pulses while the game downloads
    this.tweens.add({ targets: logo, y: LOGO_Y - 8, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    this.tweens.add({ targets: [fill, gloss], alpha: { from: 0.75, to: 1 }, duration: 500, yoyo: true, repeat: -1 });

    // Hand over from the HTML placeholder only once this scene has been drawn, so there is no blank flash.
    const boot = document.getElementById('boot');
    if (boot) this.game.events.once('postrender', () => requestAnimationFrame(() => boot.remove()));

    this.load.setPath('assets');

    // backgrounds
    if (!this.textures.exists('bg')) this.load.image('bg', 'backgrounds/BG.webp');
    this.load.image('headerShadow', 'backgrounds/header shadow.webp');
    this.load.image('headerPlank1', 'backgrounds/header  plank 1.webp'); // two spaces in the filename
    this.load.image('trayShadow', 'backgrounds/Tray Shadow.webp');
    this.load.image('tray', 'backgrounds/tray.webp');
    this.load.image('bottomNav', 'backgrounds/bottom navigation.webp');

    // ui
    this.load.image('playerPlank1', 'ui/player plank.webp');
    this.load.image('playerPlank2', 'ui/player plank 2.webp');
    this.load.image('timerPlank', 'ui/timer plank.webp');
    this.load.image('starIcon', 'ui/Star.webp');
    this.load.image('btnSettings', 'ui/settings.webp');
    this.load.image('btnSubmit', 'ui/submit.webp');
    this.load.image('btnPolls', 'ui/polls.webp');
    this.load.image('btnInventory', 'ui/inventory.webp');

    // shapes
    for (const [key, file] of Object.entries(SHAPE_FILES)) {
      this.load.image('shape_' + key, 'shapes/' + file);
    }

    // fx + audio
    this.load.image('tileDestroy', 'fx/tile destroy frame.webp');
    this.load.image('dust', 'fx/dusty.webp');
    this.load.audio('flip', ['audio/tile_flip_short.ogg', 'audio/tile_flip_short.wav']);
  }

  async create() {
    await fontReady; // usually already done by now
    if (AUDIENCE_WATCH_CODE) {
      this.startAudienceWatch();
      return;
    }
    if (START_MODE) this.scene.start('GameScene', { mode: START_MODE });
    else this.scene.start('MenuScene');
  }

  async startAudienceWatch() {
    const code = AUDIENCE_WATCH_CODE;
    // Audience links must use the audience wrapper so Chat, Polls, Settings and Back to game exist.
    // Direct ?watch= links otherwise opened the game canvas without audience navigation.
    if (urlParams.get('embed') !== '1') {
      const audienceUrl = new URL('staging/audience.html', document.baseURI);
      audienceUrl.searchParams.set('room', code);
      const hintedMode = urlParams.get('mode');
      if (hintedMode) audienceUrl.searchParams.set('mode', hintedMode);
      // Preserve environment routing: a live room uses production, while staging rooms stay isolated.
      if (STAGING) audienceUrl.searchParams.set('env', 'staging');
      // Preserve an explicitly validated localhost Worker override for local end-to-end tests.
      if (API_OVERRIDDEN) audienceUrl.searchParams.set('api', MULTIPLAYER_API);
      window.location.replace(audienceUrl.href);
      return;
    }
    const showError = (message) => {
      this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, 620, 300, 0x4b2d17, 0.98).setStrokeStyle(5, 0xd5ad72).setDepth(200);
      this.add.text(GAME_WIDTH / 2, GAME_HEIGHT / 2 - 45, message, {
        fontFamily: FONT, fontSize: '28px', color: '#fff2c7', align: 'center',
        stroke: '#3a2412', strokeThickness: 5, wordWrap: { width: 540 }
      }).setOrigin(0.5).setDepth(201);
    };
    const roomModeFor = (message) => message.mode || message.state?.mode || urlParams.get('mode') || 'pvp';
    const gameModeFor = (roomMode) => roomMode === 'tag' ? 'tag' : 'pvp';

    // Embedded audience page owns the single real WebSocket. The iframe receives the same
    // authorised spectator snapshots through postMessage, so each watcher counts only once.
    // (This scene only ever runs embedded: the non-embedded ?watch= case was redirected to
    // staging/audience.html above, so no direct-connection fallback is needed here.)
    {
      class EmbeddedAudienceSocket extends EventTarget {
        constructor() {
          super();
          this.readyState = WebSocket.OPEN;
          this.parentMessageHandler = (event) => {
            if (event.source !== window.parent || event.origin !== window.location.origin ||
                event.data?.type !== 'shapey-audience-message') return;
            const message = event.data.message;
            if (message && typeof message.type === 'string') this.deliver(message);
          };
          window.addEventListener('message', this.parentMessageHandler);
          try { window.parent.postMessage({ type: 'shapey-audience-ready' }, window.location.origin); } catch {}
        }
        send(data) {
          try { window.parent.postMessage({ type: 'shapey-audience-socket-send', data }, window.location.origin); } catch {}
        }
        close() {
          this.readyState = WebSocket.CLOSED;
          window.removeEventListener('message', this.parentMessageHandler);
          try { this.dispatchEvent(new CloseEvent('close')); } catch {}
        }
        deliver(message) {
          try { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); } catch {}
        }
      }
      const socket = new EmbeddedAudienceSocket();
      let started = false;
      socket.addEventListener('message', (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        const snapshot = message.state;
        const isStartMessage = (message.type === 'spectator_welcome' || message.type === 'game_started' ||
          message.type === 'game_state') && Boolean(snapshot) &&
          Array.isArray(snapshot.tiles) && snapshot.tiles.length > 0 &&
          ['study', 'playing', 'finished'].includes(snapshot.status);
        // Do not expose a blank/question-mark-only canvas during the room hand-off.
        // The first scene must be created from a complete authoritative board snapshot.
        if (!started && isStartMessage) {
          const roomMode = roomModeFor(message);
          started = true;
          this.scene.start('GameScene', {
            mode: gameModeFor(roomMode),
            online: true,
            spectator: true,
            audienceMode: roomMode,
            onlineSocket: socket,
            onlineRoomCode: code,
            onlineState: message.state
          });
        } else if (!started && (message.type === 'error' || message.type === 'demo_ended')) {
          showError(message.message || 'This room is no longer available.');
        }
      });
      return;
    }
  }
}
