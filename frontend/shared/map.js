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
  // Somalia and Somaliland with a margin (matches backend domain/geo.js SERVICE_AREA): where a
  // pickup, drop-off or place may be. The map itself is NOT held to it — a live dot (yours, a
  // driver's) is shown wherever it is; only the street picture ends at the border.
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

  function icon(kind, label, glyph) {
    var cls = 'gm-pin gm-pin-' + kind + (glyph ? ' gm-pin-glyph' : '');
    var inner = kind === 'driver' || kind === 'me'
      ? '<span class="gm-dot"></span>'
      : '<span class="gm-pin-head"><b>' + (glyph || label || PIN_TEXT[kind] || '') + '</b></span>';
    var size = kind === 'driver' || kind === 'me' ? [22, 22] : [30, 38];
    var anchor = kind === 'driver' || kind === 'me' ? [11, 11] : [15, 36];
    return L.divIcon({ className: cls, html: inner, iconSize: size, iconAnchor: anchor });
  }

  // ── Points of interest: businesses and landmarks from the street file's `pois` layer ──
  // protomaps-leaflet draws roads and place names but has no rule for this layer, so the shops,
  // clinics and mosques people give directions by never appeared. Each kind is a coloured disc
  // with an emoji (no sprite sheet to fetch), its name beside it once the street is close.
  // The labeler drops whatever would overlap, so a busy market thins out instead of piling up.
  var HEALTH = '#d64545', FOOD = '#e07b39', SHOP = '#b8901c', MONEY = '#2f8f6b';
  var TRAVEL = '#3f6fd1', STAY = '#8a5cc7', PUBLIC = '#5f6f86', GREEN = '#3f9d4a';
  var POI = {
    hospital: ['🏥', HEALTH], clinic: ['🏥', HEALTH], doctors: ['🩺', HEALTH], dentist: ['🦷', HEALTH],
    pharmacy: ['💊', HEALTH], chemist: ['💊', HEALTH],
    restaurant: ['🍽', FOOD], fast_food: ['🍔', FOOD], cafe: ['☕', FOOD], bakery: ['🥖', FOOD],
    ice_cream: ['🍦', FOOD], juice: ['🥤', FOOD], food_court: ['🍽', FOOD],
    marketplace: ['🛒', SHOP], supermarket: ['🛒', SHOP], convenience: ['🏪', SHOP], general: ['🏪', SHOP],
    greengrocer: ['🥬', SHOP], butcher: ['🥩', SHOP], clothes: ['👕', SHOP], shoes: ['👟', SHOP],
    mobile_phone: ['📱', SHOP], electronics: ['📱', SHOP], hardware: ['🔧', SHOP], doityourself: ['🔧', SHOP],
    beauty: ['💈', SHOP], hairdresser: ['💈', SHOP], books: ['📚', SHOP], furniture: ['🛋', SHOP],
    bank: ['🏦', MONEY], atm: ['🏧', MONEY], bureau_de_change: ['💱', MONEY], money_transfer: ['💸', MONEY],
    fuel: ['⛽', TRAVEL], bus_stop: ['🚌', TRAVEL], bus_station: ['🚌', TRAVEL], aerodrome: ['✈', TRAVEL],
    airport: ['✈', TRAVEL], ferry_terminal: ['⛴', TRAVEL], car_repair: ['🔧', TRAVEL], parking: ['🅿', TRAVEL],
    hotel: ['🛏', STAY], guest_house: ['🛏', STAY], hostel: ['🛏', STAY], motel: ['🛏', STAY],
    place_of_worship: ['🕌', MONEY], mosque: ['🕌', MONEY],
    school: ['🏫', PUBLIC], kindergarten: ['🏫', PUBLIC], university: ['🎓', PUBLIC], college: ['🎓', PUBLIC],
    library: ['📚', PUBLIC], police: ['🚓', PUBLIC], fire_station: ['🚒', PUBLIC], townhall: ['🏛', PUBLIC],
    courthouse: ['🏛', PUBLIC], embassy: ['🏛', PUBLIC], post_office: ['📮', PUBLIC], museum: ['🏛', PUBLIC],
    stadium: ['🏟', PUBLIC], sports_centre: ['🏟', PUBLIC], toilets: ['🚻', PUBLIC], drinking_water: ['🚰', PUBLIC],
    park: ['🌳', GREEN], garden: ['🌳', GREEN], beach: ['🏖', GREEN], zoo: ['🦒', GREEN], marina: ['⚓', TRAVEL],
    // Kinds the Somalia file actually holds (counted around KM4/Bakaara, 2026-11-09).
    mall: ['🛍', SHOP], shopping_centre: ['🛍', SHOP], department_store: ['🛍', SHOP], retail: ['🛍', SHOP],
    computer: ['💻', SHOP], cosmetics: ['💄', SHOP], perfumery: ['💄', SHOP], gift: ['🎁', SHOP],
    beverages: ['🥤', SHOP], photographer: ['📷', SHOP], car_rental: ['🚗', TRAVEL],
    community_centre: ['🏛', PUBLIC], monument: ['🗿', PUBLIC], memorial: ['🗿', PUBLIC],
    attraction: ['⭐', PUBLIC], viewpoint: ['⭐', GREEN], cinema: ['🎬', PUBLIC], theatre: ['🎭', PUBLIC],
    fitness_centre: ['🏋', PUBLIC], playground: ['🛝', GREEN], pitch: ['⚽', GREEN],
  };
  // Health and money first: when two would overlap, the one a person is likelier to need stays.
  var POI_RANK = [HEALTH, MONEY, TRAVEL, SHOP, FOOD, STAY, PUBLIC, GREEN];
  var POI_FONT = '500 11px sans-serif';
  // The file tags most places to appear only from z16, closer than our maps open (13–15), so
  // nothing showed. Icons come 2 levels sooner, names 1 sooner; the labeler drops overlaps.
  var POI_MIN_ZOOM = 13;
  var POI_TEXT_ZOOM = 15;
  var POI_EARLY = 2;

  // How many business/landmark icons have been drawn: lets a test prove they render (the
  // map is a canvas, so there is no element to count).
  var stats = { icons: 0 };

  function poiKind(props) { return props.kind || props['pmap:kind'] || ''; }
  // From which zoom the file says a place matters (16 if it doesn't say); every place by 17.
  function poiZoom(props) {
    var min = Number(props.min_zoom);
    return Math.min(isFinite(min) && min > 0 ? min : 16, 17);
  }

  // OSM's broader categories, for a search result whose exact type has no icon of its own.
  var CATEGORY = {
    shop: ['🛍', SHOP], craft: ['🔧', SHOP], office: ['🏢', PUBLIC], healthcare: ['🏥', HEALTH],
    tourism: ['⭐', PUBLIC], historic: ['🗿', PUBLIC], leisure: ['🌳', GREEN], aeroway: ['✈', TRAVEL],
    railway: ['🚉', TRAVEL], public_transport: ['🚌', TRAVEL],
  };
  // Our own places (Operator → Catalog & places).
  var OWN = { market: ['🛒', SHOP], landmark: ['⭐', PUBLIC] };
  // The icon for a place found by search, the same one the map draws for it, or null.
  // `kind` is OSM's type (hospital) or ours (market); `category` OSM's (amenity, shop…).
  function placeIcon(kind, category) {
    var k = POI[kind] || OWN[kind] || (category === 'landuse' && (kind === 'retail' || kind === 'commercial') ? POI.marketplace : null) || CATEGORY[category];
    return k ? { glyph: k[0], color: k[1] } : null;
  }

  function poiSymbolizer(lng, dark) {
    var textFill = dark ? '#ececec' : '#2b2b2b';
    var halo = dark ? '#151515' : '#ffffff';
    return {
      place: function (layout, geom, feature) {
        var kind = POI[poiKind(feature.props)];
        if (!kind) return undefined;
        var a = geom[0][0];
        var r = 9;
        var name = layout.zoom >= Math.max(POI_TEXT_ZOOM, poiZoom(feature.props) - 1)
          ? String(feature.props['name:' + lng] || feature.props.name || '').slice(0, 28) : '';
        var w = 0;
        if (name) { layout.scratch.font = POI_FONT; w = layout.scratch.measureText(name).width; }
        return [{
          anchor: a,
          bboxes: [{ minX: a.x - r, minY: a.y - r, maxX: a.x + r + (w ? 4 + w : 0), maxY: a.y + r }],
          draw: function (ctx) {
            stats.icons++;
            ctx.globalAlpha = 1;
            ctx.beginPath();
            ctx.arc(0, 0, r, 0, 2 * Math.PI);
            ctx.fillStyle = kind[1];
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(kind[0], 0, 0.5);
            if (!name) return;
            ctx.font = POI_FONT;
            ctx.textAlign = 'left';
            ctx.lineWidth = 3;
            ctx.strokeStyle = halo;
            ctx.strokeText(name, r + 4, 0);
            ctx.fillStyle = textFill;
            ctx.fillText(name, r + 4, 0);
          },
        }];
      },
    };
  }

  function poiRules(lng, dark) {
    var sym = poiSymbolizer(lng, dark);
    return POI_RANK.map(function (colour) {
      return {
        dataLayer: 'pois',
        symbolizer: sym,
        minzoom: POI_MIN_ZOOM,
        filter: function (zoom, f) {
          var k = POI[poiKind(f.props)];
          if (!k || k[1] !== colour) return false;
          return zoom >= poiZoom(f.props) - POI_EARLY;
        },
      };
    });
  }

  // The street layer with POIs added to its labels. The layer builds its labeler from the
  // flavor's rules in its constructor and doesn't export the flavor, so the labeler is rebuilt
  // here with ours in front.
  function streetLayer() {
    var P = global.protomapsL;
    // attribution: '' stops the layer adding its own "Protomaps © OpenStreetMap" line.
    var layer = P.leafletLayer({ url: tilesUrl(), flavor: theme(), lang: lang(), attribution: '' });
    try {
      layer.labelRules = poiRules(lang(), theme() === 'dark').concat(layer.labelRules);
      layer.labelers = new P.Labelers(layer.scratch, layer.labelRules, 16, layer.onTilesInvalidated);
    } catch (e) { /* an unexpected protomaps build: the streets still draw, without POIs */ }
    return layer;
  }

  // "Where am I": a button that turns on a live dot (with its accuracy ring) and keeps it in
  // view until the map is dragged; a second tap re-centres. Drawn anywhere — it is only a dot;
  // what a booking may use is decided by the screen (inArea), not here.
  function locateControl(onState) {
    var c = L.control({ position: 'bottomright' });
    c.onAdd = function () {
      var b = L.DomUtil.create('button', 'gm-locate');
      b.type = 'button';
      b.setAttribute('aria-label', global.GMI18n && global.GMI18n.t ? global.GMI18n.t('map.locate') : 'My location');
      b.innerHTML = '<span></span>';
      L.DomEvent.disableClickPropagation(b);
      L.DomEvent.on(b, 'click', function () { onState(b); });
      return b;
    };
    return c;
  }

  // Move a marker to `p` over ~0.8 s instead of jumping: a driver's dot that teleports every
  // few seconds reads as broken. A far jump (a stale fix replaced) is not animated.
  function glide(marker, p) {
    var from = marker.getLatLng();
    if (marker._gmAnim) global.cancelAnimationFrame(marker._gmAnim);
    if (distance({ lat: from.lat, lng: from.lng }, p) > 2000 || !global.requestAnimationFrame) {
      marker.setLatLng([p.lat, p.lng]);
      return;
    }
    var t0 = Date.now();
    var ms = 800;
    (function step() {
      var k = Math.min(1, (Date.now() - t0) / ms);
      marker.setLatLng([from.lat + (p.lat - from.lat) * k, from.lng + (p.lng - from.lng) * k]);
      marker._gmAnim = k < 1 ? global.requestAnimationFrame(step) : null;
    })();
  }

  // The place's name beside its pin (a picked business), or none.
  function nameTag(marker, name) {
    if ((marker._gmName || '') === (name || '')) return;
    marker._gmName = name || '';
    marker.unbindTooltip();
    if (!name) return;
    // As text, never HTML: a tooltip string is inserted as markup, and OSM names are public input.
    var el = document.createElement('span');
    el.textContent = String(name).slice(0, 40);
    marker.bindTooltip(el, { permanent: true, direction: 'right', offset: [12, -22], className: 'gm-pin-name' });
  }

  // A position that stopped updating (a driver in a dead zone) is drawn faded, not hidden.
  function markStale(marker, stale) {
    var e = marker.getElement && marker.getElement();
    if (e) e.classList.toggle('gm-stale', Boolean(stale));
  }

  function create(el, opts) {
    opts = opts || {};
    // The customer's city (shared/cities.js) when one is chosen; Mogadishu otherwise.
    var center = opts.center || (global.GMCity ? global.GMCity.current().center : MOGADISHU);
    var map = L.map(el, {
      zoomControl: true,
      attributionControl: false,
      minZoom: 3,
      maxZoom: 19,
      tap: true,
    // Street level, like any maps app: businesses and landmarks are on screen without zooming.
    }).setView([center.lat, center.lng], opts.zoom || 15);

    el.classList.add('gm-map');
    var note = null;
    var base = null;
    checkTiles().then(function (ok) {
      if (ok) {
        base = streetLayer();
        // No credit on the map: OpenStreetMap and Protomaps are credited in the privacy policy.
        base.addTo(map);
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
        var look = (o.kind || 'place') + '|' + (o.label || '') + '|' + (o.glyph || '');
        if (existing && existing.setLatLng) {
          if (o.glide) glide(existing, p); else existing.setLatLng([p.lat, p.lng]);
          if (o.title) existing.options.title = o.title;
          // A picked business turned back into a plain point (dragged away), or the reverse.
          if (existing._gmLook !== look) { existing.setIcon(icon(o.kind || 'place', o.label, o.glyph)); existing._gmLook = look; }
          nameTag(existing, o.name);
          if (o.stale != null) markStale(existing, o.stale);
          return existing;
        }
        var m = L.marker([p.lat, p.lng], {
          icon: icon(o.kind || 'place', o.label, o.glyph),
          draggable: Boolean(o.draggable),
          keyboard: false,
          title: o.title || '',
          zIndexOffset: o.kind === 'driver' ? 1000 : 0,
        }).addTo(map);
        if (o.onMove) m.on('dragend', function () { var ll = m.getLatLng(); o.onMove({ lat: ll.lat, lng: ll.lng }); });
        if (o.onTap) m.on('click', function () { o.onTap(); });
        if (o.stale) markStale(m, true);
        m._gmLook = look;
        nameTag(m, o.name);
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
      destroy: function () { stopLocate(); map.remove(); layers = {}; if (base) base = null; if (note) note = null; },
    };

    // The live "you are here" dot, behind the locate button (opts.locate).
    var stopWatch = null;
    var following = false;
    function stopLocate() {
      if (stopWatch) { stopWatch(); stopWatch = null; }
      api.remove('_me');
      api.remove('_meAcc');
    }
    function showMe(fix, btn) {
      btn.classList.remove('gm-locate-off');
      var first = !api.has('_me');
      api.pin('_me', fix, { kind: 'me', glide: true });
      api.remove('_meAcc');
      if (fix.accuracy) layers._meAcc = L.circle([fix.lat, fix.lng], { radius: fix.accuracy, className: 'gm-accuracy', weight: 1, interactive: false }).addTo(map);
      if (first || following) map.setView([fix.lat, fix.lng], Math.max(map.getZoom(), 16), { animate: true });
    }
    if (opts.locate && global.GMLocation && global.GMLocation.supported) {
      locateControl(function (btn) {
        following = true;
        api.dragged = false;
        btn.classList.add('gm-locate-on');
        var here = layers._me && layers._me.getLatLng();
        if (here) map.setView(here, Math.max(map.getZoom(), 16), { animate: true });
        if (stopWatch) return;
        stopWatch = global.GMLocation.watch(function (fix) { showMe(fix, btn); }, function () {
          btn.classList.remove('gm-locate-on');
          btn.classList.add('gm-locate-off');
          stopLocate();
        }, { minIntervalMs: 2000 });
      }).addTo(map);
      map.on('dragstart', function () { following = false; });
    }
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
    stats: stats,
    placeIcon: placeIcon,
  };
})(window);
