// Shapey audience page - shared state: the element map, every mutable top-level
// variable (one `state` object so the ES modules below can update it), and the page
// constants. Every other module imports { state, els } from here.

export const MULTIPLAYER_API = 'https://shapey-multiplayer-staging.hellohuman100.workers.dev';
export const SHAPE_FILES = {
  mystery: 'Mystery.webp', dummy: 'dummy.webp', hazard: 'hazard.webp', cancel: 'cancel.webp',
  capsule: 'capsule.webp', circle: 'circle.webp', cross: 'cross.webp', divide: 'divide.webp',
  corner: 'four corner.webp', marked: 'marked.webp', pointer: 'shield.webp', shield: 'pointer.webp',
  sphere: 'sphere.webp', square: 'square.webp', star: 'star .webp', x: 'x.webp'
};
// The game's own mode names (MODES in main.js).
export const MODE_LABELS = { tag: 'TAG: 2 VS 2', pvp: 'PLAYER 1 VS PLAYER 2', demo: 'AI VS AI' };
export const AVATAR_COLORS = ['#754322', '#8a4f2a', '#5d3a1e', '#9a6a35', '#6b4a2a', '#7c3f1d'];

export const $ = (id) => document.getElementById(id);

export const els = {
  directory: $('directoryView'), watch: $('watchView'), rooms: $('roomCards'), directoryStatus: $('directoryStatus'),
  modeChips: $('modeChips'), statusFilter: $('statusFilter'), refreshRooms: $('refreshRooms'), startDemo: $('startDemo'), gameFrame: $('gameFrame'), muteAudienceSound: $('muteAudienceSound'), endDemo: $('endDemo'),
  board: $('board'), boardFootnote: $('boardFootnote'), veil: $('veil'), veilText: $('veilText'), retryConnection: $('retryConnection'), toast: $('toast'),
  side0: $('side0'), side1: $('side1'), p1Score: $('p1Score'), p2Score: $('p2Score'), p1Name: $('p1Name'), p2Name: $('p2Name'),
  turnClock: $('turnClock'), goalText: $('goalText'), revealText: $('revealText'),
  btnChat: $('btnChat'), btnPolls: $('btnPolls'), btnSettings: $('btnSettings'), chatBadge: $('chatBadge'), pollBadge: $('pollBadge'),
  backdrop: $('backdrop'), pollPanel: $('pollPanel'), settingsPanel: $('settingsPanel'),
  chatPage: $('chatPage'), backToGame: $('backToGame'), chatRoomTitle: $('chatRoomTitle'),
  chatMessages: $('chatMessages'), chatStatus: $('chatStatus'), chatCount: $('chatCount'), chatForm: $('chatForm'), chatInput: $('chatInput'),
  pollIntro: $('pollIntro'), pollOptions: $('pollOptions'), roomSummary: $('roomSummary'), playersList: $('playersList'), shareRoom: $('shareRoom')
};

// Every mutable top-level variable of the old single-file page.
export const state = {
  activeMode: '',
  activePanel: null,
  activeRoomCode: '',
  audienceAudio: null,
  chatIds: new Set(),
  chatPageOpen: false,
  connectionLost: false,
  currentPoll: null,
  currentState: null,
  currentVote: null,
  demoControlReady: false,
  demoControlRoomCode: '',
  demoControlToken: '',
  explicitLeave: false,
  lastTurnKey: null,
  latestGameFrameMessage: null,
  modeFilterValue: 'all',
  pollAcceptedId: '',
  pollDeclinedId: '',
  pollLockedId: null,
  refreshTimer: null,
  roomPlayers: [],
  roomSocket: null,
  roomSpectators: 0,
  roomStatus: 'waiting',
  roomsCache: [],
  roomsLoadedAt: null,
  roomsLoadSeq: 0,
  serverClockOffset: 0,
  soundMuted: (() => { try { return localStorage.getItem('shapey-audience-muted') === 'true'; } catch (_) { return false; } })(),
  statusFilterValue: 'live',
  statusIsError: false,
  statusMessage: '',
  tileNodes: new Map(),
  watchToken: 0,
  toastTimer: null,
  turnTimer: null,
  unreadChat: 0,
};

