const CACHE = 'gurikaabe-operator-v60';
const SHELL = ['/operator/', '/operator/index.html', '/operator/app.js', '/icon-192.png', '/shared/styles.css', '/shared/config.js', '/shared/ids.js', '/shared/syncPolicy.js', '/shared/queue.js', '/shared/phone.js', '/shared/theme.js', '/shared/push.js', '/shared/map.js', '/shared/vendor/leaflet-1.9.4.js', '/shared/vendor/leaflet-1.9.4.css', '/shared/vendor/protomaps-leaflet-5.1.0.js'];
// cache: 'reload' = from the server, never the browser's HTTP cache (see user/sw.js).
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE)
  .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
  .then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => {
  const cleanup = (async () => {
    // Only this app's caches: all three apps share the origin, so the list holds the others' too.
    const mine = CACHE.replace(/v\d+$/, '');
    const old = (await caches.keys()).filter((k) => k !== CACHE && k.startsWith(mine));
    await Promise.all(old.map((k) => caches.delete(k)));
    await self.clients.claim();
    return old.length > 0;
  })();
  event.waitUntil(cleanup);
  // An UPDATE (an older version was cached) reloads the pages still showing it: the app has no
  // update listener, so the first open after a deploy would show the old version. Never on a
  // first install (it would reload a page someone is typing into). Started AFTER activation,
  // not inside waitUntil: the reload's requests wait for this worker to be active — awaiting
  // them here deadlocks the page.
  cleanup.then((updated) => {
    if (!updated) return;
    setTimeout(() => {
      self.clients.matchAll({ type: 'window' })
        .then((wins) => wins.forEach((w) => w.navigate(w.url).catch(() => {})));
    }, 0);
  });
});

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
