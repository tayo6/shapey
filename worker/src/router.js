// Shapey Worker - the public HTTP/WebSocket router: /health, the room directory API,
// room info and the /ws/{ROOMCODE} upgrade. Durable Object plumbing lives in room.js;
// helpers live in lib.js.

import { isAllowedOrigin, isRoomCode, isBoardSize, modeDetails } from "./protocol.js";
import { corsHeaders, json, newSeatToken, AUDIENCE_POLL_MS, LIVE_DIRECTORY_OBJECT_NAME } from "./lib.js";
import { Room } from "./room.js";

// The Durable Object class must be re-exported from the entry module for the binding.
export { Room };

function rateLimitAddress(value) {
  const ip = String(value || "").trim().toLowerCase().split("%")[0];
  if (!ip.includes(":")) return ip;
  const parts = ip.split("::");
  if (parts.length > 2) return ip;
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts[1] ? parts[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return ip;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8) return ip;
  // IPv6 clients can rotate host addresses within a /64. Share the rate-limit key
  // across that prefix while keeping IPv4 clients keyed by their full address.
  return groups.slice(0, 4).map(group => parseInt(group || "0", 16).toString(16)).join(":") + "::/64";
}

async function isRateLimited(env, bindingName, request, route) {
  const address = request.headers.get("CF-Connecting-IP") || "";
  const limiter = env[bindingName];
  if (!address || !limiter || typeof limiter.limit !== "function") return false;
  try {
    const result = await limiter.limit({ key: route + ":" + rateLimitAddress(address) });
    return result?.success !== true;
  } catch (error) {
    // Fail closed if a configured limiter fails: room endpoints should not silently
    // become unbounded during a rate-limiter outage.
    console.error("Rate limiter unavailable for " + route + ":", error);
    return true;
  }
}

function rateLimitedResponse(cors, message = "Too many requests. Please wait and try again.") {
  return json({ error: message }, 429, { ...cors, "Retry-After": "60" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env.ENVIRONMENT);
    try {
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
      if (await isRateLimited(env, "DIRECTORY_READ_LIMITER", request, "directory")) {
        return rateLimitedResponse(cors, "Too many room-list requests. Please wait a minute.");
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
      // Origin is a browser abuse barrier, not authentication. Rate limiting and transactional
      // reservations below protect the API and cap total room creation.
      if (!isAllowedOrigin(request.headers.get("Origin") || "", env.ENVIRONMENT)) {
        return json({ error: "Origin not allowed." }, 403, cors);
      }
      if (await isRateLimited(env, "ROOM_CREATE_BURST_LIMITER", request, "room-create")) {
        return rateLimitedResponse(cors, "Too many room creation requests. Please wait a minute.");
      }
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
      const clientPrefix = rateLimitAddress(request.headers.get("CF-Connecting-IP") || "unknown");
      const clientDigest = new Uint8Array(await crypto.subtle.digest(
        "SHA-256", new TextEncoder().encode(clientPrefix)
      ));
      const clientKey = Array.from(clientDigest.slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("");

      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const directory = env.ROOMS.get(env.ROOMS.idFromName(LIVE_DIRECTORY_OBJECT_NAME));
      for (let attempt = 0; attempt < 5; attempt++) {
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        const code = Array.from(bytes, b => alphabet[b % alphabet.length]).join("");
        const reservation = await directory.fetch(
          "https://directory.internal/directory/reserve?roomCode=" + code + "&mode=" + encodeURIComponent(details.mode),
          { method: "POST", headers: { "X-Shapey-Client-Key": clientKey } }
        );
        if (reservation.status === 409) continue;
        if (reservation.status === 429) {
          return json(await reservation.json(), 429, { ...cors, "Retry-After": "60" });
        }
        if (!reservation.ok) return json({ error: "The game server is temporarily unavailable. Please retry later." }, 503, cors);

        const releaseReservation = async () => {
          try {
            await directory.fetch(
              "https://directory.internal/directory/release?roomCode=" + code,
              { method: "DELETE" }
            );
          } catch (error) {
            console.error("Could not release unused room reservation:", error);
          }
        };
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        let created;
        try {
          created = await stub.fetch("https://room.internal/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ roomCode: code, ...details, boardSize, demoControlToken })
          });
        } catch (error) {
          await releaseReservation();
          console.error("Could not create Shapey room:", error);
          return json({ error: "Could not reserve a room. Please try again." }, 503, cors);
        }
        if (created.status === 409) {
          await releaseReservation();
          continue;
        }
        if (!created.ok) {
          await releaseReservation();
          return json({ error: "Could not reserve a room. Please try again." }, 503, cors);
        }
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
      if (await isRateLimited(env, "ROOM_INFO_LIMITER", request, "room-info")) {
        return rateLimitedResponse(cors, "Too many room lookups. Please wait a minute.");
      }

      // Use a direct directory lookup rather than loading every room just to check one code.
      // This also lets public listings hide waiting rooms without breaking invite-code joins.
      const directory = env.ROOMS.get(env.ROOMS.idFromName(LIVE_DIRECTORY_OBJECT_NAME));
      const directoryResponse = await directory.fetch(
        "https://directory.internal/directory/exists?roomCode=" + encodeURIComponent(infoMatch[1])
      );
      if (!directoryResponse.ok) {
        return json({ error: "Room directory is temporarily unavailable." }, 503, cors);
      }
      const directoryData = await directoryResponse.json();
      if (!directoryData.exists) return json({ error: "Room not found." }, 404, cors);

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
      if (await isRateLimited(env, "WEBSOCKET_UPGRADE_LIMITER", request, "websocket")) {
        return rateLimitedResponse(cors, "Too many WebSocket connections. Please wait a minute.");
      }
      return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
    }

    return json({
      error: "Not found",
      endpoints: ["GET /health", "POST /api/rooms", "GET /api/rooms/{ROOMCODE}", "WebSocket /ws/{ROOMCODE}?mode=pvp|tag"]
    }, 404, cors);
    } catch (error) {
      console.error("Shapey Worker request failed:", error);
      return json({ error: "The game service is temporarily unavailable. Please retry." }, 503, cors);
    }
  }
};
