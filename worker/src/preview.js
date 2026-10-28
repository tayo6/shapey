// Static-only audience preview proxy. Multiplayer traffic goes directly to the
// staging Worker, which validates the browser Origin and applies its own rate limits.
// Never forward /api/* or /ws/* from this public preview: doing so would turn the
// preview into an Origin-rewriting relay around the staging Worker.
const STATIC_ORIGIN = "https://tayo6.github.io/shapey";
const ALLOWED_STATIC_ORIGIN = "https://tayo6.github.io";
const PREVIEW_HEADER = "static-only-0005";

function forwardedStaticRequest(request, target) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.set("Origin", ALLOWED_STATIC_ORIGIN);
  const init = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
  return new Request(target, init);
}

function addPreviewHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Shapey-Preview", PREVIEW_HEADER);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Shapey-Preview": PREVIEW_HEADER
    }
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "shapey-audience-preview",
        stage: "static-preview-only",
        protocolVersion: 1
      });
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/") ||
        url.pathname === "/ws" || url.pathname.startsWith("/ws/")) {
      return json({
        error: "This preview serves static files only. Use the staging Worker directly for multiplayer."
      }, 410);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "The audience preview accepts GET and HEAD only." }, 405);
    }

    if (url.pathname === "/") {
      return Response.redirect(url.origin + "/staging/audience.html" + url.search, 302);
    }
    if (url.pathname === "/staging" || url.pathname === "/staging/") {
      return Response.redirect(url.origin + "/staging/index.html" + url.search, 302);
    }

    const staticPath = (url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname) + url.search;
    const target = new URL(staticPath, STATIC_ORIGIN + "/");
    const response = await fetch(forwardedStaticRequest(request, target));
    return addPreviewHeaders(response);
  }
};
