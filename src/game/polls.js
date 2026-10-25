// Shapey - the "Ask the Audience" poll overlay for online PvP and Tag.
// Extracted from GameScene (scenes/game.js) as a prototype mixin.

import { GAME_WIDTH, GAME_HEIGHT, FONT } from '../constants.js';
import { woodButton } from '../ui.js';

export const AudiencePollMixin = {
  getAudiencePollsUsed() {
    if (this.online) {
      const used = Number(this.onlineState && this.onlineState.me && this.onlineState.me.audiencePollsUsed);
      return Math.max(0, Math.min(3, Number.isFinite(used) ? used : 0));
    }
    const slot = this.limiterSlot();
    return Math.max(0, Math.min(3, Number(this.audiencePollsUsedByPlayer.get(slot) || 0)));
  },

  getAudiencePollsRemaining() {
    return Math.max(0, 3 - this.getAudiencePollsUsed());
  },

  // Three free polls per player per game are enforced by the online Worker.
  showAudiencePoll() {
    this.closeAudiencePoll();
    if (this.gameOver) return;

    // Audience polling is a live multiplayer feature, never a local AI practice simulation.
    if (this.mode !== 'pvp' && this.mode !== 'tag') {
      this.showToast('Audience polls are only available in online Player 1 vs Player 2 and Tag.', 2800);
      return;
    }
    if (!this.online || !this.onlineSocket || this.onlineSocket.readyState !== WebSocket.OPEN) {
      this.showToast('Connect to an online Player 1 vs Player 2 or Tag room before asking the audience.', 2800);
      return;
    }
    if (this.getAudiencePollsRemaining() <= 0) {
      this.showToast('You have used all 3 free audience polls for this game.', 2600);
      return;
    }
    if (!this.onlineState || this.onlineState.activePlayerNumber !== this.onlinePlayerNumber) {
      this.showToast('You can use an audience poll during your own turn.', 2200);
      return;
    }

    // The Worker validates the first selected shape, remaining allowance, and poll timing.
    // Only the Worker can start a real poll; this client must never invent votes or percentages.
    this.onlineSocket.send(JSON.stringify({ type: 'audience_poll_start' }));
    this.showToast('Audience poll requested. Spectators have 30 seconds to vote.', 2500);
  },

  // Online poll, modelled on "Ask the Audience": while the audience votes the contestant sees the
  // lettered options and a countdown only; the percentages are revealed when voting closes.
  // Only the team that opened the poll sees it, so the other team never sees the audience's advice.
  // Online sides: in Player 1 vs Player 2 each player is their own side; in Tag, Players 1-2 are Team 1 and
  // Players 3-4 are Team 2. Mirrors sideForPlayer() in worker/src/game-engine.js.
  onlineSideForPlayer(playerNumber) {
    const number = Number(playerNumber);
    const mode = (this.onlineState && this.onlineState.mode) || this.onlineMode || this.mode;
    if (!Number.isInteger(number) || number < 1) return null;
    if (mode === 'tag') return number <= 2 ? 0 : number <= 4 ? 1 : null;
    return number === 1 ? 0 : number === 2 ? 1 : null;
  },

  renderOnlineAudiencePoll(poll) {
    if (!poll || this.gameOver) { this.closeAudiencePoll(); return; }
    const mySide = this.onlineSideForPlayer(this.onlinePlayerNumber);
    const pollSide = this.onlineSideForPlayer(poll.startedByPlayer);
    if (mySide === null || pollSide === null || mySide !== pollSide) { this.closeAudiencePoll(); return; }
    const key = poll.id + ':' + (poll.closed ? 'closed' : 'open');
    if (this.dismissedPollKey === key) return; // the player closed this view; do not pop it up again
    if (this.pollShownKey === key && this.pollUI && this.pollUI.length) return; // nothing new to draw
    this.closeAudiencePoll();
    this.pollShownKey = key;
    this.pollUI = [];
    const add = (object) => {
      object.setDepth(250);
      this.pollUI.push(object);
      return object;
    };
    add(this.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0x120a05, 0.78)
      .setInteractive());
    add(this.add.rectangle(GAME_WIDTH / 2, 650, 640, 690, 0x4b2d17, 1)
      .setStrokeStyle(5, 0xd5ad72));
    add(this.add.text(GAME_WIDTH / 2, 365, poll.closed ? 'AUDIENCE RESULTS' : 'ASK THE AUDIENCE', {
      fontFamily: FONT, fontSize: '42px', color: '#fff2c7',
      stroke: '#3a2112', strokeThickness: 8, align: 'center', wordWrap: { width: 590 },
    }).setOrigin(0.5));

    const options = Array.isArray(poll.options)
      ? poll.options.filter((option) => option && typeof option.tileId === 'string') : [];
    const counts = options.map((option) => Number((poll.counts || {})[option.tileId]) || 0);
    const totalVotes = counts.reduce((sum, count) => sum + count, 0);
    const best = Math.max(0, ...counts);
    const secondsLeft = () => Math.max(0, Math.ceil((this.serverToLocal(Number(poll.endsAt) || NaN) - Date.now()) / 1000));
    const positionLabel = (option) => 'ROW ' + (Number(option.row) + 1) + ', COLUMN ' + (Number(option.col) + 1);
    const subtitle = () => {
      if (poll.closed) return totalVotes > 0
        ? 'POLL CLOSED · ' + totalVotes + (totalVotes === 1 ? ' VOTE' : ' VOTES')
        : 'NO VOTES WERE CAST';
      const left = secondsLeft();
      return left > 0 ? 'THE AUDIENCE IS VOTING ON THE BOARD · ' + left + 's' : 'COUNTING THE VOTES…';
    };
    const subtitleText = add(this.add.text(GAME_WIDTH / 2, 420, subtitle(), {
      fontFamily: FONT, fontSize: '21px', color: '#ffe36e', align: 'center',
      stroke: '#3a2112', strokeThickness: 4, wordWrap: { width: 570 },
    }).setOrigin(0.5));
    if (!poll.closed) {
      this.pollTimer = this.time.addEvent({
        delay: 250, loop: true,
        callback: () => { if (subtitleText.active) subtitleText.setText(subtitle()); },
      });
      add(this.add.text(GAME_WIDTH / 2, 525,
        'Spectators tap a face-down tile on the live board to vote.', {
        fontFamily: FONT, fontSize: '21px', color: '#fff2c7', align: 'center',
        stroke: '#3a2112', strokeThickness: 4, wordWrap: { width: 540 },
      }).setOrigin(0.5));
    } else if (totalVotes > 0) {
      const leaders = options.filter((option, index) => counts[index] === best);
      const labels = leaders.slice(0, 3).map(positionLabel);
      add(this.add.text(GAME_WIDTH / 2, 500,
        (leaders.length === 1 ? 'TOP BOARD PICK: ' : 'TOP BOARD PICKS: ') + labels.join(' · '), {
        fontFamily: FONT, fontSize: '22px', color: '#ffe36e', align: 'center',
        stroke: '#3a2112', strokeThickness: 4, wordWrap: { width: 560 },
      }).setOrigin(0.5));
      add(this.add.text(GAME_WIDTH / 2, 555,
        'The audience chose from the full board.', {
        fontFamily: FONT, fontSize: '19px', color: '#fff2c7', align: 'center',
        stroke: '#3a2112', strokeThickness: 4, wordWrap: { width: 540 },
      }).setOrigin(0.5));
    } else if (poll.closed) {
      add(this.add.text(GAME_WIDTH / 2, 510, 'No votes were cast this time.', {
        fontFamily: FONT, fontSize: '22px', color: '#fff2c7', align: 'center',
        stroke: '#3a2112', strokeThickness: 4,
      }).setOrigin(0.5));
    }
    woodButton(this, GAME_WIDTH / 2, 885, 420, 82,
      poll.closed ? 'CLOSE RESULTS' : 'HIDE', 30,
      () => { this.dismissedPollKey = key; this.closeAudiencePoll(); }, 252).forEach(add);
  },

  closeAudiencePoll() {
    if (this.pollTimer) { this.pollTimer.remove(false); this.pollTimer = null; }
    if (this.pollUI) this.pollUI.forEach((object) => object.destroy());
    this.pollUI = [];
    this.pollShownKey = null;
  },

};
