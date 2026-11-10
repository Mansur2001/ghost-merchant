// Service Worker: caches the app shell on first load so repeat visits render from local
// storage with near-zero mobile data (SRS 3.1). Bump CACHE to ship new assets.
const CACHE = 'gurikaabe-user-v58';
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/manifest.json',
  '/favicon-32.png', '/icon-192.png', '/icon-512.png',
  '/shared/styles.css',
  '/shared/config.js', '/shared/ids.js', '/shared/syncPolicy.js', '/shared/queue.js', '/shared/phone.js',
  '/shared/theme.js', '/shared/push.js', '/shared/i18n.js',
  '/shared/map.js', '/shared/location.js', '/shared/nav.js',
  '/shared/vendor/leaflet-1.9.4.js', '/shared/vendor/leaflet-1.9.4.css', '/shared/vendor/protomaps-leaflet-5.1.0.js',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' = from the server. A plain addAll may be answered by the browser's HTTP
  // cache, filling the NEW cache with the OLD file: map.js stayed stale for days that way.
  event.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
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

// ── Push notifications (backend domain/push.js) ──
// Shown even when the app is closed. The text is generic on purpose (lock screens); the tap
// opens the app on the order, where the session shows the details.
self.addEventListener('push', (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch { m = { title: 'GuriKaabe', body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(m.title || 'GuriKaabe', {
    body: m.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // Same tag = replace, not stack: a repeated event doesn't buzz twice.
    tag: m.tag || undefined,
    data: { url: m.url || self.registration.scope },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || self.registration.scope, self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (open) {
      await open.focus();
      open.postMessage({ type: 'gm:open', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
