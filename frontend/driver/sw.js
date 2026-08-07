const CACHE = 'ghost-driver-v7';
const SHELL = ['/driver/', '/driver/index.html', '/driver/app.js', '/shared/styles.css', '/shared/phone.js', '/shared/theme.js'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws') || e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((c) => c || fetch(e.request)));
});
