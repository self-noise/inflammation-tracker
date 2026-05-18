/* Minimal service worker: caches the app shell so the form is usable
 * offline. Koofr WebDAV requests are *not* cached — they go to the
 * network and fail loudly if offline, which is what we want (the
 * caller queues them in localStorage).
 *
 * Strategy: cache-first for same-origin shell assets; pass-through
 * for everything else. Bump CACHE_VERSION to invalidate on deploy.
 */

const CACHE_VERSION = "v9";
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
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL))
  );
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

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // Lazy-cache successful same-origin responses so newly added
        // files start working offline after the first load.
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached); // fall back to whatever we have
    })
  );
});
