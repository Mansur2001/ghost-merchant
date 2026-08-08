// Where the API lives. Classic script; exposes window.GMConfig.
//
// THE reason the PWAs could not run as a native app: every call was hardcoded same-origin
// (`fetch('/api/...')`, `new WebSocket(location.host)`). Inside a Capacitor WebView the page
// is served from the app's own local origin, so "same origin" is the phone, not the server,
// and every request 404s on launch.
//
// Resolution order:
//   1. window.GM_API_BASE — written into the bundle at build time (mobile/build-www.mjs).
//   2. ?api= query parameter — for pointing a browser at a remote backend while debugging.
//   3. same origin — the plain web/PWA deployment behind Caddy, unchanged.
(function (global) {
  function trimSlash(u) {
    return typeof u === 'string' ? u.replace(/\/+$/, '') : '';
  }

  var fromQuery = '';
  try {
    fromQuery = new URLSearchParams(global.location.search).get('api') || '';
  } catch (e) {
    fromQuery = '';
  }

  // '' means same-origin, which keeps every existing relative path working untouched.
  var base = trimSlash(global.GM_API_BASE || fromQuery || '');

  function api(path) {
    return base + '/api' + path;
  }

  // The socket has to follow the API host, not the page host. ws: for http, wss: for https —
  // a wss:// socket against a cleartext dev backend fails the TLS handshake and looks like
  // "realtime is broken" rather than a config error.
  function wsUrl() {
    if (base) return base.replace(/^http/, 'ws') + '/ws';
    var proto = global.location.protocol === 'https:' ? 'wss' : 'ws';
    return proto + '://' + global.location.host + '/ws';
  }

  // True when running inside the native shell rather than a browser tab. Used to drop
  // web-only behaviour (service worker registration) that Capacitor handles natively.
  function isNative() {
    return Boolean(global.Capacitor && global.Capacitor.isNativePlatform &&
                   global.Capacitor.isNativePlatform());
  }

  global.GMConfig = { base: base, api: api, wsUrl: wsUrl, isNative: isNative };
})(window);
