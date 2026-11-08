// Where the phone is. Classic script; exposes window.GMLocation.
//
// The first fix a phone gives is often its worst (cell towers, 500 m+). So `best()` WATCHES
// for a few seconds and keeps the most accurate fix, finishing early once one is good enough.
// The answer always says how sure it is (`accuracy`, metres) so the screen can ask the person
// to drag the pin when the phone isn't sure — a cheap handset indoors in Mogadishu often isn't.
(function (global) {
  var geo = global.navigator && global.navigator.geolocation;

  function why(err) {
    if (!global.isSecureContext && global.location.protocol !== 'capacitor:') return 'insecure';
    if (!err) return 'unavailable';
    if (err.code === 1) return 'denied';
    if (err.code === 3) return 'timeout';
    return 'unavailable';
  }

  function toFix(pos) {
    var c = pos.coords;
    return {
      lat: c.latitude,
      lng: c.longitude,
      accuracy: Math.round(c.accuracy || 0),
      heading: c.heading != null && isFinite(c.heading) ? Math.round(c.heading) : null,
      // m/s -> km/h
      speed: c.speed != null && isFinite(c.speed) ? Math.round(c.speed * 3.6) : null,
      at: pos.timestamp || Date.now(),
    };
  }

  // Resolve with the best fix within `timeoutMs`, or as soon as one is within `goodEnoughM`.
  // Reject with an Error whose .reason is denied | timeout | unavailable | insecure.
  function best(opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || 12000;
    var goodEnough = opts.goodEnoughM || 25;
    return new Promise(function (resolve, reject) {
      if (!geo) { var e0 = new Error('no geolocation'); e0.reason = 'unavailable'; reject(e0); return; }
      var bestFix = null;
      var done = false;
      var id = null;
      function finish(err) {
        if (done) return;
        done = true;
        if (id !== null) geo.clearWatch(id);
        clearTimeout(timer);
        if (bestFix) resolve(bestFix);
        else { var e = new Error('no fix'); e.reason = why(err); reject(e); }
      }
      var timer = setTimeout(function () { finish(null); }, timeoutMs);
      id = geo.watchPosition(function (pos) {
        var fix = toFix(pos);
        if (!bestFix || fix.accuracy < bestFix.accuracy) bestFix = fix;
        if (opts.onProgress) opts.onProgress(bestFix);
        // 0 is a (rare) perfect fix, not "unknown": good enough by any measure.
        if (fix.accuracy <= goodEnough) finish(null);
      }, function (err) {
        // Denied ends it now; a transient error keeps waiting for the timer.
        if (err && err.code === 1) finish(err);
      }, { enableHighAccuracy: true, maximumAge: 5000, timeout: timeoutMs });
    });
  }

  // Keep reporting while a driver is online. `onFix` gets every fix at most every
  // `minIntervalMs`; `onError` gets a reason. Returns stop().
  function watch(onFix, onError, opts) {
    opts = opts || {};
    var minInterval = opts.minIntervalMs || 5000;
    if (!geo) { if (onError) onError('unavailable'); return function () {}; }
    // Throttled, but never lossy: a reading inside the interval is held and delivered when the
    // interval ends. A phone that stops moving may send no more readings, and its LAST one (at
    // the door, at the pickup) is the one that matters.
    var last = 0;
    var pending = null;
    var timer = null;
    function deliver() {
      timer = null;
      if (!pending) return;
      last = Date.now();
      var f = pending;
      pending = null;
      onFix(f);
    }
    var id = geo.watchPosition(function (pos) {
      pending = toFix(pos);
      var wait = last + minInterval - Date.now();
      if (wait <= 0) deliver();
      else if (!timer) timer = setTimeout(deliver, wait);
    }, function (err) {
      if (onError) onError(why(err));
    }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 30000 });
    return function () { geo.clearWatch(id); clearTimeout(timer); pending = null; };
  }

  global.GMLocation = { best: best, watch: watch, supported: Boolean(geo) };
})(window);
