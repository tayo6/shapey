// Shapey Worker - the public HTTP/WebSocket router: /health, the room directory API,
// room info and the /ws/{ROOMCODE} upgrade. Durable Object plumbing lives in room.js;
// helpers live in lib.js.

import { isAllowedOrigin, isRoomCode, isBoardSize, modeDetails } from "./protocol.js";
import { corsHeaders, json, newSeatToken, AUDIENCE_POLL_MS, LIVE_DIRECTORY_OBJECT_NAME } from "./lib.js";
import { Room } from "./room.js";

// The Durable Object class must be re-exported from the entry module for the binding.
export { Room };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env.ENVIRONMENT);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        ok: true,
        service: "shapey-multiplayer",
        stage: "authoritative-gameplay-v1",
        protocolVersion: 1,
        audiencePollSeconds: AUDIENCE_POLL_MS / 1000,
        pollResultsHiddenUntilClose: true
      }, 200, cors);
    }

    if (url.pathname === "/api/rooms" && request.method === "GET") {
      if (!isAllowedOrigin(request.headers.get("Origin") || "", env.ENVIRONMENT)) {
        return json({ error: "Origin not allowed." }, 403, cors);
      }
      const directory = env.ROOMS.get(env.ROOMS.idFromName(LIVE_DIRECTORY_OBJECT_NAME));
      const target = new URL("https://directory.internal/directory/list");
      for (const key of ["mode", "status"]) {
        const value = url.searchParams.get(key);
        if (value) target.searchParams.set(key, value);
      }
      const response = await directory.fetch(target.toString());
      const payload = await response.json();
      return json(payload, response.status, { ...cors, "Cache-Control": "no-store" });
    }

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      // Origin is a browser abuse barrier, not authentication. The per-IP limit below also
      // constrains direct API clients that forge Origin headers.
      if (!isAllowedOrigin(request.headers.get("Origin") || "", env.ENVIRONMENT)) {
        return json({ error: "Origin not allowed." }, 403, cors);
      }
      const clientAddress = request.headers.get("CF-Connecting-IP") || "unknown";
      const digest = new Uint8Array(await crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode(clientAddress)
      ));
      const limiterKey = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const limiter = env.ROOMS.get(env.ROOMS.idFromName("create-limit:" + limiterKey));
      const limited = await limiter.fetch("https://room.internal/rate-limit", { method: "POST" });
      if (limited.status === 429) {
        const detail = await limited.json();
        const retryAfter = limited.headers.get("Retry-After");
        return json(detail, 429, retryAfter ? { ...cors, "Retry-After": retryAfter } : cors);
      }
      if (!limited.ok) return json({ error: "Room creation is temporarily unavailable. Please retry later." }, 503, cors);

      let body;
      try { body = await request.json(); }
      catch { return json({ error: "Send a JSON body with mode set to pvp or tag." }, 400, cors); }
      const details = modeDetails(body?.mode);
      if (!details) return json({ error: "Choose Player 1 vs Player 2 (pvp), Tag (tag), or AI vs AI demo (demo)." }, 400, cors);
      const boardSize = body.boardSize === undefined ? 7 : body.boardSize;
      if (!isBoardSize(boardSize) || (details.mode === "tag" && boardSize !== 7)) {
        const message = details.mode === "tag"
          ? "Tag uses a 7x7 board."
          : "Choose a board size of 5, 6, or 7.";
        return json({ error: message }, 400, cors);
      }
      const demoControlToken = details.mode === "demo" ? newSeatToken() : null;

      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      for (let attempt = 0; attempt < 5; attempt++) {
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        const code = Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const created = await stub.fetch("https://room.internal/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roomCode: code, ...details, boardSize, demoControlToken })
        });
        if (created.status === 409) continue;
        if (!created.ok) return json({ error: "Could not reserve a room. Please try again." }, 503, cors);
        return json({
          roomCode: code,
          boardSize,
          websocketUrl: url.origin.replace(/^http/, "ws") + "/ws/" + code,
          status: details.mode === "demo" ? "starting" : "waiting",
          ...details,
          ...(demoControlToken ? { demoControlToken } : {})
        }, 201, cors);
      }
      return json({ error: "Could not create a unique room code. Please try again." }, 503, cors);
    }

    const infoMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})$/);
    if (infoMatch && request.method === "GET") {
      const origin = request.headers.get("Origin") || "";
      if (!isAllowedOrigin(origin, env.ENVIRONMENT)) {
        return json({ error: "Origin not allowed." }, 403, cors);
      }

      // Check the directory before touching a room Durable Object. This avoids waking
      // storage for arbitrary room-code scans and returns quickly for unknown rooms.
      const directory = env.ROOMS.get(env.ROOMS.idFromName(LIVE_DIRECTORY_OBJECT_NAME));
      const directoryResponse = await directory.fetch("https://directory.internal/directory/list");
      if (!directoryResponse.ok) {
        return json({ error: "Room directory is temporarily unavailable." }, 503, cors);
      }
      const directoryData = await directoryResponse.json();
      const exists = Array.isArray(directoryData.rooms) &&
        directoryData.rooms.some((room) => room && room.roomCode === infoMatch[1]);
      if (!exists) return json({ error: "Room not found." }, 404, cors);

      const stub = env.ROOMS.get(env.ROOMS.idFromName(infoMatch[1]));
      const info = await stub.fetch("https://room.internal/info");
      const data = await info.json();
      return json(data, info.status, cors);
    }

    const match = url.pathname.match(/^\/ws\/([A-Z0-9]{6})$/);
    if (match && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      // CORS does not protect WebSocket handshakes; validate Origin explicitly.
      if (!isAllowedOrigin(request.headers.get("Origin") || "", env.ENVIRONMENT)) {
        return json({ error: "Origin not allowed." }, 403, cors);
      }
      return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
    }

    return json({
      error: "Not found",
      endpoints: ["GET /health", "POST /api/rooms", "GET /api/rooms/{ROOMCODE}", "WebSocket /ws/{ROOMCODE}?mode=pvp|tag"]
    }, 404, cors);
  }
};
