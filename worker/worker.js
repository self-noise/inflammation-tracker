/*
 * Cloudflare Worker: CORS proxy for Koofr WebDAV.
 *
 * Why this exists:
 *   app.koofr.net does not advertise CORS headers, so a browser-origin
 *   PWA cannot call its WebDAV endpoint directly. This Worker forwards
 *   requests to Koofr and adds the CORS headers the browser needs.
 *
 * Deploy:
 *   1. Create a new Worker (e.g. via the Cloudflare dashboard or `wrangler`).
 *   2. Paste this file as the Worker's source.
 *   3. Note the deployed URL (e.g. https://koofr-proxy.<account>.workers.dev).
 *   4. Enter that URL in the app's Settings → "Proxy URL".
 *
 * Request shape:
 *   The app sends e.g. PUT https://<worker>/inflammation/log.csv
 *   and this forwards to    PUT https://app.koofr.net/dav/Koofr/inflammation/log.csv
 *   preserving method, headers (incl. Authorization, If-Match), and body.
 */

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const target = "https://app.koofr.net/dav/Koofr" + url.pathname;
    const init = {
      method: req.method,
      headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
      redirect: "manual",
    };
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(req) });
    }
    const upstream = await fetch(target, init);
    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(corsHeaders(req))) headers.set(k, v);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  },
};

function corsHeaders(req) {
  return {
    "Access-Control-Allow-Origin": req.headers.get("Origin") || "*",
    "Access-Control-Allow-Methods": "GET,PUT,POST,DELETE,PROPFIND,MKCOL,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,Depth,If-Match",
    "Access-Control-Expose-Headers": "ETag",
    "Access-Control-Max-Age": "86400",
  };
}
