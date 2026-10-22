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

  // Read a fetch Response as JSON, making any SERVER failure reportable: the error gets a
  // "[status · cause · ref]" tail, e.g. "database unavailable [503 · DB-P1001 · ref 1a2b3c4d]",
  // so the person can tell us exactly what happened and we can find it in the log (the ref is
  // the start of the request id). A dead backend answers through Caddy with an empty or HTML
  // 502, which used to fail JSON parsing and look like nothing happened at all.
  // 4xx answers ("wrong code", "already paid") are left as they are: those are for the person
  // to act on, not to report.
  function readJson(r) {
    return r.json().catch(function () { return null; }).then(function (body) {
      if (r.ok) return body || {};
      if (!body || typeof body !== 'object') {
        body = { error: r.status >= 500 ? 'server unavailable' : 'unexpected server response' };
      }
      body.status = r.status;
      if (r.status >= 500) {
        var parts = [String(r.status)];
        if (body.cause) parts.push(body.cause);
        if (body.ref) parts.push('ref ' + body.ref);
        body.error = String(body.error || 'server error') + ' [' + parts.join(' · ') + ']';
      }
      return body;
    });
  }

  global.GMConfig = { base: base, api: api, wsUrl: wsUrl, isNative: isNative, readJson: readJson };
})(window);
