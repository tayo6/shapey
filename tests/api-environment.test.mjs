import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_MULTIPLAYER_API,
  STAGING_MULTIPLAYER_API,
  resolveMultiplayerApi,
} from '../src/game/api-environment.js';

test('live pages use the production Worker by default', () => {
  assert.deepEqual(resolveMultiplayerApi({ staging: false }), {
    api: LIVE_MULTIPLAYER_API,
    overridden: false,
  });
});

test('staging pages use the isolated staging Worker by default', () => {
  assert.deepEqual(resolveMultiplayerApi({ staging: true }), {
    api: STAGING_MULTIPLAYER_API,
    overridden: false,
  });
});

test('local Worker override is accepted only when the page explicitly allows it', () => {
  const requestedApi = 'http://127.0.0.1:8787';
  assert.deepEqual(resolveMultiplayerApi({ requestedApi, localApiAllowed: true }), {
    api: requestedApi,
    overridden: true,
  });
  assert.deepEqual(resolveMultiplayerApi({ requestedApi, localApiAllowed: false }), {
    api: LIVE_MULTIPLAYER_API,
    overridden: false,
  });
});

test('arbitrary API URLs are ignored even on an allowed local override context', () => {
  assert.deepEqual(resolveMultiplayerApi({
    requestedApi: 'https://evil.example',
    localApiAllowed: true,
  }), {
    api: LIVE_MULTIPLAYER_API,
    overridden: false,
  });
});
