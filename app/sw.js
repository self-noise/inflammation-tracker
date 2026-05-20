/* Service worker for the Inflammation Tracker PWA.
 *
 * Strategy: network-first for same-origin shell assets, with cache
 * fallback so the form still works offline (or when behind expired
 * .htaccess basic-auth). Each PWA load therefore picks up the latest
 * code from the server whenever the network is reachable and
 * authenticated. Koofr WebDAV requests pass straight through.
 *
 * Non-OK responses (401 from expired basic-auth, 5xx, etc.) do NOT
 * overwrite the cached copy — that would poison the cache with an
 * auth-challenge HTML page. Instead, we serve the previous cached
 * version if we have one.
 *
 * Bumping CACHE_VERSION forces a clean cache on activate. Under the
 * network-first strategy this is no longer required on every JS
 * deploy (fresh code is fetched anyway), but is still useful to wipe
 * stale state or when SHELL changes.
 */

const CACHE_VERSION = "v11";
const CACHE_NAME = "inflam-shell-" + CACHE_VERSION;

const SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "sync.js",
  "manifest.json",
  "icon.svg",
];

self.addEventListener("install", (event) => {
  // Precache shell assets individually rather than via cache.addAll, which
  // is atomic: a single 401 from .htaccess basic-auth on any one asset
  // would otherwise abort the whole install and silently strand the user
  // on the previously-active service worker. Anything that fails to fetch
  // here will be filled in lazily by the fetch handler on the next
  // successful network request.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const results = await Promise.allSettled(
      SHELL.map((url) => cache.add(url))
    );
    const failed = results
      .map((r, i) => ({ r, url: SHELL[i] }))
      .filter(({ r }) => r.status === "rejected");
    if (failed.length) {
      console.warn(
        "[sw] install completed with " + failed.length
          + " uncached shell asset(s): "
          + failed.map(({ url, r }) => url + " (" + r.reason + ")").join("; ")
      );
    }
  })());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only intercept GETs for our own origin's shell assets. Everything
  // else (notably Koofr requests, which need fresh auth + ETag flow)
  // passes straight through to the network.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      // Refresh the cache only on OK (2xx) responses. A 401 from expired
      // basic-auth, or a 5xx from a flaky server, must not replace the
      // previously cached copy — that would lock the user out of working
      // code even after auth was restored. On non-OK, prefer the cached
      // version so the app keeps running while the user re-authenticates.
      if (res.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, res.clone());
        return res;
      }
      const cached = await caches.match(req);
      return cached || res;
    } catch (err) {
      // Network unreachable (offline, DNS failure, etc.). Fall back to
      // whatever we have in cache; if nothing, propagate the failure.
      const cached = await caches.match(req);
      if (cached) return cached;
      throw err;
    }
  })());
});
