// The city the customer is in (the home screen's "Boosaaso, Puntland ▾"). Where maps open and
// which places search lists first — nothing more: it is never sent to the server, and a GPS fix
// inside Somalia still wins for the actual pickup or door. Persisted on this phone (gm_city).
(function (global) {
  var KEY = 'gm_city';
  // `id` matches places.city on the server. Centres are each city's main market, roughly.
  var CITIES = [
    { id: 'Mogadishu', en: 'Mogadishu', so: 'Muqdisho', region: 'Banaadir', center: { lat: 2.0469, lng: 45.3182 } },
    { id: 'Boosaaso', en: 'Bosaso', so: 'Boosaaso', region: 'Puntland', center: { lat: 11.2847, lng: 49.1828 } },
    { id: 'Hargeisa', en: 'Hargeisa', so: 'Hargeysa', region: 'Somaliland', center: { lat: 9.5609, lng: 44.0647 } },
    { id: 'Garowe', en: 'Garowe', so: 'Garoowe', region: 'Puntland', center: { lat: 8.4054, lng: 48.4845 } },
    { id: 'Galkayo', en: 'Galkayo', so: 'Gaalkacyo', region: 'Mudug', center: { lat: 6.7697, lng: 47.4308 } },
    { id: 'Kismaayo', en: 'Kismayo', so: 'Kismaayo', region: 'Jubbaland', center: { lat: -0.3582, lng: 42.5454 } },
    { id: 'Baidoa', en: 'Baidoa', so: 'Baydhabo', region: 'Koonfur Galbeed', center: { lat: 3.1137, lng: 43.6498 } },
    { id: 'Beledweyne', en: 'Beledweyne', so: 'Beledweyne', region: 'Hiiraan', center: { lat: 4.7358, lng: 45.2036 } },
  ];
  function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function current() { return CITIES.find(function (c) { return c.id === saved(); }) || CITIES[0]; }
  function set(id) {
    if (!CITIES.some(function (c) { return c.id === id; })) return;
    try { localStorage.setItem(KEY, id); } catch (e) { /* private mode */ }
    document.dispatchEvent(new CustomEvent('gm:city', { detail: { id: id } }));
  }
  // The nearest city to a point (a GPS fix), so the picker can follow the phone the first time.
  function nearest(p) {
    var best = null; var bd = Infinity;
    CITIES.forEach(function (c) {
      var d = Math.pow(c.center.lat - p.lat, 2) + Math.pow(c.center.lng - p.lng, 2);
      if (d < bd) { bd = d; best = c; }
    });
    return best;
  }
  global.GMCity = { list: CITIES, current: current, set: set, nearest: nearest, chosen: function () { return Boolean(saved()); } };
})(window);
