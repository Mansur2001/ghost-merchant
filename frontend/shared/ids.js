// Order id helpers for the browser. Classic script; exposes window.GMIds.
//
// Order ids are UUIDs. Two consequences for the UI:
//   * They're unreadable on a phone and unusable over the phone ("read me your order
//     number"), so anything shown to a human is the short form. Lookups always use the full
//     id — the short form is presentation only, never an identifier.
//   * The CLIENT mints the id before creating an order. That makes a retry idempotent: if
//     the response is lost on a bad connection, resending the same id returns the original
//     order rather than creating a second one the customer could pay for twice.
(function (global) {
  function newId() {
    // crypto.randomUUID needs a secure context. Capacitor serves the app from a secure
    // origin and the PWA runs under HTTPS, so this is available — but fall back rather than
    // crash the checkout if some future WebView disagrees.
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    var bytes = new Uint8Array(16);
    global.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
    var hex = [];
    for (var i = 0; i < 16; i++) hex.push((bytes[i] + 0x100).toString(16).slice(1));
    return (
      hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' +
      hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' +
      hex.slice(10, 16).join('')
    );
  }

  function shortId(id) {
    return typeof id === 'string' ? id.slice(0, 8) : '';
  }

  global.GMIds = { newId: newId, shortId: shortId };
})(window);
