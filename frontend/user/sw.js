// Service Worker: caches the app shell on first load so repeat visits render from local
// storage with near-zero mobile data (SRS 3.1). Bump CACHE to ship new assets.
const CACHE = 'ghost-user-v11';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/manifest.json',
  '/icon.svg',
  '/shared/styles.css',
  '/shared/config.js', '/shared/ids.js', '/shared/syncPolicy.js', '/shared/queue.js', '/shared/phone.js',
  '/shared/theme.js',
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
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;
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
