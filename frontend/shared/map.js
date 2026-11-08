// The map, shared by the three apps. Classic script; exposes window.GMMap.
//
// Leaflet draws it; the street data is ONE self-hosted file, tiles/somalia.pmtiles, served by
// our own Caddy with range requests (protomaps-leaflet reads just the pieces it needs). No
// Google, no tile vendor, no API key, no per-view cost. When the file isn't installed
// (scripts/fetch-map-tiles.sh) the map still works: a plain grid with every pin, line and
// distance on it — the job never depends on the street picture.
//
// Pins are CSS (divIcon), not image files: nothing to fetch, and they follow the theme.
(function (global) {
  var L = global.L;
  var MOGADISHU = { lat: 2.0469, lng: 45.3182 };
  // Somalia and Somaliland with a margin (matches backend domain/geo.js SERVICE_AREA).
  var BOUNDS = [[-1.9, 40.8], [12.3, 51.6]];

  var tilesState = null; // null = not checked, true/false once known

  function tilesUrl() {
    var base = (global.GMConfig && global.GMConfig.base) || '';
    return base + '/tiles/somalia.pmtiles';
  }

  // One cheap ranged read tells us whether the street file is there.
  function checkTiles() {
    if (tilesState !== null) return Promise.resolve(tilesState);
    if (!global.protomapsL) { tilesState = false; return Promise.resolve(false); }
    return fetch(tilesUrl(), { headers: { Range: 'bytes=0-15' } })
      .then(function (r) { tilesState = r.status === 206 || r.status === 200; return tilesState; })
      .catch(function () { tilesState = false; return false; });
  }

  function theme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function lang() {
    try { return (global.GMI18n && global.GMI18n.lang && global.GMI18n.lang()) === 'so' ? 'so' : 'en'; } catch (e) { return 'en'; }
  }

  var PIN_TEXT = { pickup: 'A', dropoff: 'B', driver: '', me: '', market: '🛒', place: '' };

  function icon(kind, label) {
    var cls = 'gm-pin gm-pin-' + kind;
    var inner = kind === 'driver' || kind === 'me'
      ? '<span class="gm-dot"></span>'
      : '<span class="gm-pin-head"><b>' + (label || PIN_TEXT[kind] || '') + '</b></span>';
    var size = kind === 'driver' || kind === 'me' ? [22, 22] : [30, 38];
    var anchor = kind === 'driver' || kind === 'me' ? [11, 11] : [15, 36];
    return L.divIcon({ className: cls, html: inner, iconSize: size, iconAnchor: anchor });
  }

  function create(el, opts) {
    opts = opts || {};
    var center = opts.center || MOGADISHU;
    var map = L.map(el, {
      zoomControl: true,
      attributionControl: true,
      maxBounds: BOUNDS,
      maxBoundsViscosity: 0.8,
      minZoom: 5,
      maxZoom: 19,
      tap: true,
    }).setView([center.lat, center.lng], opts.zoom || 14);
    map.attributionControl.setPrefix('');

    el.classList.add('gm-map');
    var note = null;
    var base = null;
    checkTiles().then(function (ok) {
      if (ok) {
        base = global.protomapsL.leafletLayer({ url: tilesUrl(), flavor: theme(), lang: lang() });
        base.addTo(map);
        map.attributionControl.addAttribution('© <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>');
      } else {
        el.classList.add('gm-map-plain');
        note = L.control({ position: 'bottomleft' });
        note.onAdd = function () {
          var d = L.DomUtil.create('div', 'gm-map-note');
          d.textContent = (global.GMI18n && global.GMI18n.t) ? global.GMI18n.t('map.plain') : 'Street map not installed — pins and distances still work.';
          return d;
        };
        note.addTo(map);
      }
    });

    var layers = {};
    var tapHandler = null;
    map.on('click', function (e) { if (tapHandler) tapHandler({ lat: e.latlng.lat, lng: e.latlng.lng }); });
    map.on('dragstart', function () { api.dragged = true; if (api.onDrag) api.onDrag(); });

    var api = {
      map: map,
      // One pin per key: calling again moves it. `opts.draggable` + `opts.onMove` for "drag to adjust".
      pin: function (key, p, o) {
        o = o || {};
        if (!p || p.lat == null || p.lng == null) { api.remove(key); return null; }
        var existing = layers[key];
        if (existing && existing.setLatLng) {
          existing.setLatLng([p.lat, p.lng]);
          if (o.title) existing.options.title = o.title;
          return existing;
        }
        var m = L.marker([p.lat, p.lng], {
          icon: icon(o.kind || 'place', o.label),
          draggable: Boolean(o.draggable),
          keyboard: false,
          title: o.title || '',
          zIndexOffset: o.kind === 'driver' ? 1000 : 0,
        }).addTo(map);
        if (o.onMove) m.on('dragend', function () { var ll = m.getLatLng(); o.onMove({ lat: ll.lat, lng: ll.lng }); });
        if (o.onTap) m.on('click', function () { o.onTap(); });
        layers[key] = m;
        return m;
      },
      // How sure the phone is: a ring the size of its reported accuracy.
      accuracy: function (key, p, meters) {
        api.remove(key);
        if (!p || !meters) return;
        layers[key] = L.circle([p.lat, p.lng], { radius: meters, className: 'gm-accuracy', weight: 1 }).addTo(map);
      },
      line: function (key, a, b) {
        api.remove(key);
        if (!a || !b) return;
        layers[key] = L.polyline([[a.lat, a.lng], [b.lat, b.lng]], { className: 'gm-line', weight: 4, dashArray: '6 8' }).addTo(map);
      },
      // A road route from GET /api/route: [[lat, lng], …]. Replaces any straight line.
      route: function (key, coords) {
        api.remove(key);
        if (!coords || coords.length < 2) return;
        layers[key] = L.polyline(coords, { className: 'gm-route', weight: 6, lineJoin: 'round', lineCap: 'round' }).addTo(map);
      },
      // Keep `p` in view as it moves (navigation). Stops while the person drags the map.
      follow: function (p, zoom) {
        if (!p || api.dragged) return;
        map.setView([p.lat, p.lng], zoom || Math.max(map.getZoom(), 16), { animate: true });
      },
      dragged: false,
      remove: function (key) {
        if (layers[key]) { map.removeLayer(layers[key]); delete layers[key]; }
      },
      has: function (key) { return Boolean(layers[key]); },
      // Frame the given points (or every pin), never zooming in past street level.
      fit: function (points, o) {
        var pts = (points || []).filter(function (p) { return p && p.lat != null; });
        if (!pts.length) return;
        if (pts.length === 1) { map.setView([pts[0].lat, pts[0].lng], Math.max(map.getZoom(), 15)); return; }
        map.fitBounds(pts.map(function (p) { return [p.lat, p.lng]; }), { padding: [36, 36], maxZoom: (o && o.maxZoom) || 16 });
      },
      center: function () { var c = map.getCenter(); return { lat: c.lat, lng: c.lng }; },
      onTap: function (fn) { tapHandler = fn; },
      // Call after the container was hidden and shown (Leaflet measures it once).
      refresh: function () { setTimeout(function () { map.invalidateSize(); }, 0); },
      destroy: function () { map.remove(); layers = {}; if (base) base = null; if (note) note = null; },
    };
    return api;
  }

  // Great-circle metres, same formula as the backend (domain/proof.js).
  function distance(a, b) {
    var R = 6371000;
    var rad = function (d) { return (d * Math.PI) / 180; };
    var dLat = rad(b.lat - a.lat);
    var dLng = rad(b.lng - a.lng);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return Math.round(2 * R * Math.asin(Math.sqrt(h)));
  }

  function formatDistance(m) {
    if (m == null || !isFinite(m)) return '';
    return m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
  }

  // "Open in my navigation app": the driver's own maps app, if the phone has one. geo: is what
  // Android hands to whichever app the driver chose; no vendor is built into GuriKaabe.
  function navUri(p, label) {
    var q = p.lat + ',' + p.lng;
    return 'geo:' + q + '?q=' + q + (label ? '(' + encodeURIComponent(label) + ')' : '');
  }

  // Inside the area we serve? A phone abroad (a tester in Seattle) or a broken fix (0, 0) is
  // not a pickup, a door or a driver position.
  function inArea(p) {
    return Boolean(p) && p.lat >= BOUNDS[0][0] && p.lat <= BOUNDS[1][0] && p.lng >= BOUNDS[0][1] && p.lng <= BOUNDS[1][1];
  }

  global.GMMap = {
    available: function () { return Boolean(L); },
    inArea: inArea,
    create: create,
    distance: distance,
    formatDistance: formatDistance,
    navUri: navUri,
    MOGADISHU: MOGADISHU,
  };
})(window);
