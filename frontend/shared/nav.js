// Turn-by-turn navigation on top of a route from GET /api/route (our own OSRM). Classic
// script; exposes window.GMNav. No vendor, no key: the route comes from our server, the
// position from the phone, and everything else is worked out here.
//
//   const nav = GMNav.track(route);    // precomputes distances along the road
//   const p = nav.update(fix);         // where we are: next step, distance to it, remaining
//   GMNav.say(step)                    // "Turn right onto Wadada Makkah", in EN or plain SO
(function (global) {
  var t = function (k, v) { return global.GMI18n ? global.GMI18n.t(k, v) : k; };
  var OFF_ROUTE_M = 50;      // further than this from the road line = off route
  var ARRIVED_M = 35;        // this close to the end = arrived

  function dist(a, b) { return global.GMMap.distance({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] }); }

  // Distance in metres from point p to segment a-b, and how far along it (0..1). Flat-earth is
  // exact enough over a city block.
  function toSegment(p, a, b) {
    var kx = Math.cos((p[0] * Math.PI) / 180) * 111320;
    var ky = 110540;
    var ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky;
    var bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var u = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    var cx = ax + u * dx, cy = ay + u * dy;
    return { d: Math.sqrt(cx * cx + cy * cy), u: u };
  }

  function track(route) {
    var g = route.geometry || [];
    var cum = [0];
    for (var i = 1; i < g.length; i++) cum.push(cum[i - 1] + dist(g[i - 1], g[i]));
    var total = cum[cum.length - 1] || 0;
    // Each maneuver's position along the line.
    var steps = (route.steps || []).map(function (s) {
      var best = 0, bestD = Infinity;
      if (s.at) for (var j = 0; j < g.length; j++) { var d = dist(s.at, g[j]); if (d < bestD) { bestD = d; best = j; } }
      return Object.assign({}, s, { along: cum[best] || 0 });
    });

    function update(fix) {
      var p = [fix.lat, fix.lng];
      var bestD = Infinity, along = 0;
      for (var k = 0; k + 1 < g.length; k++) {
        var r = toSegment(p, g[k], g[k + 1]);
        if (r.d < bestD) { bestD = r.d; along = cum[k] + r.u * (cum[k + 1] - cum[k]); }
      }
      if (g.length === 1) { bestD = dist(p, g[0]); along = 0; }
      var remaining = Math.max(0, total - along);
      // The next maneuver ahead of us (a few metres of slack: we're "at" it until past it).
      var next = null, after = null;
      for (var n = 1; n < steps.length; n++) {
        if (steps[n].along > along + 5) { next = steps[n]; after = steps[n + 1] || null; break; }
      }
      return {
        offRoute: bestD > OFF_ROUTE_M,
        offBy: Math.round(bestD),
        remaining: Math.round(remaining),
        minutes: total ? Math.max(1, Math.round((route.minutes * remaining) / total)) : 1,
        next: next,
        toNext: next ? Math.max(0, Math.round(next.along - along)) : Math.round(remaining),
        after: after,
        arrived: remaining < ARRIVED_M || (dist(p, g[g.length - 1] || p) < ARRIVED_M),
      };
    }
    return { update: update, total: total, steps: steps };
  }

  // ── Words and arrows ──
  var ARROW = {
    straight: '↑', 'slight right': '↗', right: '→', 'sharp right': '↘', uturn: '↩',
    'sharp left': '↙', left: '←', 'slight left': '↖',
  };
  function arrow(s) {
    if (!s) return '↑';
    if (s.type === 'arrive') return '🏁';
    if (s.type === 'roundabout' || s.type === 'rotary' || s.type === 'roundabout turn') return '⟳';
    return ARROW[s.modifier] || '↑';
  }
  // "Turn right onto Wadada Makkah" / "Midig u leexo — Wadada Makkah".
  function say(s) {
    if (!s) return '';
    var m = s.modifier || 'straight';
    var dir = t('nav.dir.' + m);
    var base;
    switch (s.type) {
      case 'arrive': return t('nav.arrive');
      case 'depart': base = t('nav.depart', { dir: dir }); break;
      case 'roundabout': case 'rotary': case 'roundabout turn':
        base = s.exit ? t('nav.roundabout', { n: s.exit }) : t('nav.roundaboutAny'); break;
      case 'fork': base = t('nav.fork', { dir: dir }); break;
      case 'merge': base = t('nav.merge', { dir: dir }); break;
      case 'end of road': base = t('nav.endOfRoad', { dir: dir }); break;
      case 'on ramp': case 'off ramp': base = t('nav.ramp', { dir: dir }); break;
      case 'continue': case 'new name':
        base = m === 'straight' ? t('nav.continue') : t('nav.turn', { dir: dir }); break;
      default:
        base = m === 'straight' ? t('nav.continue') : m === 'uturn' ? t('nav.uturn') : t('nav.turn', { dir: dir });
    }
    // Street names in OSM are often bilingual ("Wadada Makkah طريق مكة"): keep the Latin part.
    var name = String(s.name || '').replace(/[؀-ۿ]+.*$/, '').trim();
    return name ? base + ' — ' + name : base;
  }

  // Spoken prompts, where the phone has a voice for the language. Somali voices are rare on
  // Android: then the banner alone does the job.
  function speak(text, lang) {
    try {
      if (!global.speechSynthesis || !text) return false;
      var want = lang === 'so' ? 'so' : 'en';
      var voice = global.speechSynthesis.getVoices().filter(function (v) { return v.lang && v.lang.toLowerCase().indexOf(want) === 0; })[0];
      if (!voice) return false;
      var u = new global.SpeechSynthesisUtterance(text.replace(' — ', ', '));
      u.voice = voice;
      u.lang = voice.lang;
      global.speechSynthesis.cancel();
      global.speechSynthesis.speak(u);
      return true;
    } catch (e) { return false; }
  }

  global.GMNav = { track: track, say: say, arrow: arrow, speak: speak, OFF_ROUTE_M: OFF_ROUTE_M };
})(window);
