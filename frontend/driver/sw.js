const CACHE = 'gurikaabe-driver-v46';
const SHELL = ['/driver/', '/driver/index.html', '/driver/app.js', '/icon-192.png', '/shared/styles.css', '/shared/config.js', '/shared/ids.js', '/shared/syncPolicy.js', '/shared/queue.js', '/shared/phone.js', '/shared/theme.js', '/shared/push.js', '/shared/i18n.js', '/shared/map.js', '/shared/location.js', '/shared/nav.js', '/shared/vendor/leaflet-1.9.4.js', '/shared/vendor/leaflet-1.9.4.css', '/shared/vendor/protomaps-leaflet-5.1.0.js'];
// cache: 'reload' = from the server, never the browser's HTTP cache (see user/sw.js).
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE)
  .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
  .then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws') || url.pathname.startsWith('/tiles') || e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((c) => c || fetch(e.request)));
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
