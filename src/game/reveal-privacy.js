// Best-effort protection against tab-switching during visible shape reveals.
// Browsers cannot prevent OS-level screenshots; this covers the board on focus/visibility loss.
import { FONT } from '../constants.js';
import { TILE_PITCH, GRID_COLS, GRID_ROWS } from '../config.js';

export function getRevealPrivacyRemainingMs({
  online = false,
  onlineState = null,
  now = Date.now(),
  localRemaining = 0,
  serverToLocal = (deadline) => deadline,
} = {}) {
  if (!online) {
    return Number.isFinite(Number(localRemaining))
      ? Math.max(0, Number(localRemaining))
      : 0;
  }
  if (!onlineState) return 0;

  const remaining = [];
  for (const batch of Array.isArray(onlineState.reveals) ? onlineState.reveals : []) {
    const serverEnd = Number(batch && batch.endsAt);
    if (!Number.isFinite(serverEnd)) continue;
    const localEnd = Number(serverToLocal(serverEnd));
    if (Number.isFinite(localEnd)) remaining.push(localEnd - now);
  }

  if (onlineState.status === 'study' && onlineState.reviewEndsAt != null) {
    const serverEnd = Number(onlineState.reviewEndsAt);
    if (Number.isFinite(serverEnd)) {
      const localEnd = Number(serverToLocal(serverEnd));
      if (Number.isFinite(localEnd)) remaining.push(localEnd - now);
    }
  }

  return Math.max(0, ...remaining);
}

export const RevealPrivacyMixin = {
  initRevealPrivacy() {
    this.revealPrivacyUntil = 0;
    this.revealPrivacyCover = null;
    this.revealPrivacyLabel = null;
    this.revealVisibilityHandler = () => {
      if (document.hidden) this.coverBoardDuringReveal();
      else this.updateRevealPrivacy();
    };
    this.revealBlurHandler = () => this.coverBoardDuringReveal();

    document.addEventListener('visibilitychange', this.revealVisibilityHandler);
    window.addEventListener('blur', this.revealBlurHandler);

    this.events.once('shutdown', () => {
      document.removeEventListener('visibilitychange', this.revealVisibilityHandler);
      window.removeEventListener('blur', this.revealBlurHandler);
      this.removeRevealPrivacyCover();
    });
  },

  revealPrivacyRemainingMs() {
    return getRevealPrivacyRemainingMs({
      online: this.online,
      onlineState: this.onlineState,
      now: Date.now(),
      localRemaining: this.reveals ? this.reveals.remaining() : 0,
      serverToLocal: (deadline) => this.serverToLocal(deadline),
    });
  },

  coverBoardDuringReveal() {
    const remaining = this.revealPrivacyRemainingMs();
    if (remaining <= 0 || !this.tray) return;

    this.revealPrivacyUntil = Math.max(this.revealPrivacyUntil || 0, Date.now() + remaining);
    if (this.revealPrivacyCover && this.revealPrivacyCover.active) return;

    // Cover only the tile grid; scores, clocks, and navigation remain visible.
    this.revealPrivacyCover = this.add.rectangle(
      this.tray.x,
      this.tray.y,
      GRID_COLS * TILE_PITCH + 6,
      GRID_ROWS * TILE_PITCH + 6,
      0x21160e,
      0.99,
    ).setDepth(150).setInteractive();

    this.revealPrivacyLabel = this.add.text(this.tray.x, this.tray.y, 'SHAPES HIDDEN', {
      fontFamily: FONT,
      fontSize: '30px',
      color: '#fff2c7',
      stroke: '#3a2412',
      strokeThickness: 6,
      align: 'center',
    }).setOrigin(0.5).setDepth(151);
  },

  updateRevealPrivacy() {
    if (this.revealPrivacyCover && !document.hidden && Date.now() >= this.revealPrivacyUntil) {
      this.removeRevealPrivacyCover();
    }
  },

  removeRevealPrivacyCover() {
    if (this.revealPrivacyCover) this.revealPrivacyCover.destroy();
    if (this.revealPrivacyLabel) this.revealPrivacyLabel.destroy();
    this.revealPrivacyCover = null;
    this.revealPrivacyLabel = null;
    this.revealPrivacyUntil = 0;
  },
};
