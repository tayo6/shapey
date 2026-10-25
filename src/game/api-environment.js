// Select the correct multiplayer Worker for live, staging, and local test pages.
export const LIVE_MULTIPLAYER_API = 'https://shapey-multiplayer.hellohuman100.workers.dev';
export const STAGING_MULTIPLAYER_API = 'https://shapey-multiplayer-staging.hellohuman100.workers.dev';

const LOCAL_API_PATTERN = /^http:\/\/(?:127\.0\.0\.1|localhost):8787$/i;

export function resolveMultiplayerApi({
  staging = false,
  requestedApi = null,
  localApiAllowed = false,
} = {}) {
  const overridden = LOCAL_API_PATTERN.test(requestedApi || '') && localApiAllowed;
  return {
    api: overridden
      ? requestedApi
      : staging ? STAGING_MULTIPLAYER_API : LIVE_MULTIPLAYER_API,
    overridden,
  };
}
