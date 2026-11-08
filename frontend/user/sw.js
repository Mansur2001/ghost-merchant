// Service Worker: caches the app shell on first load so repeat visits render from local
// storage with near-zero mobile data (SRS 3.1). Bump CACHE to ship new assets.
const CACHE = 'gurikaabe-user-v42';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/manifest.json',
  '/favicon-32.png', '/icon-192.png', '/icon-512.png',
  '/shared/styles.css',
  '/shared/config.js', '/shared/ids.js', '/shared/syncPolicy.js', '/shared/queue.js', '/shared/phone.js',
  '/shared/theme.js', '/shared/i18n.js',
  '/shared/map.js', '/shared/location.js',
  '/shared/vendor/leaflet-1.9.4.js', '/shared/vendor/leaflet-1.9.4.css', '/shared/vendor/protomaps-leaflet-5.1.0.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Never cache API or websocket traffic — always live.
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws') || url.pathname.startsWith('/tiles')) return;
  if (request.method !== 'GET') return;

  // Cache-first for the shell; fall back to network and cache new static assets.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
          return res;
        }).catch(() => cached)
    )
  );
});
