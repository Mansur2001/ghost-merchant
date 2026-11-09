// Navigation routes and OpenStreetMap search: shaped for the apps, never invented, and the
// public geocoder is asked at most once a second and never twice for the same thing.
import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { routeDetail } from '../src/routing/route.js';
import { geocode, resetGeocoder, foldQuery } from '../src/geocode/nominatim.js';

const A = { lat: 2.0478, lng: 45.3291 };
const B = { lat: 2.0144, lng: 45.3047 };
const osrm = {
  code: 'Ok',
  routes: [{
    distance: 6670.4, duration: 785,
    geometry: { coordinates: [[45.32912345, 2.04781234], [45.3047, 2.0144]] },
    legs: [{ steps: [
      { maneuver: { type: 'depart', modifier: 'left', location: [45.3291, 2.0478] }, name: '', distance: 111, duration: 20 },
      { maneuver: { type: 'turn', modifier: 'right', location: [45.32, 2.04] }, name: 'Wadada Makkah', distance: 678, duration: 90 },
      { maneuver: { type: 'arrive', location: [45.3047, 2.0144] }, name: '', distance: 0, duration: 0 },
    ] }],
  }],
};

describe('routeDetail', () => {
  test('no routing engine -> null (the apps fall back), never a made-up route', async () => {
    expect(await routeDetail(A, B, { url: '' })).toBeNull();
    expect(await routeDetail(A, B, { url: 'http://osrm', fetchImpl: async () => { throw new Error('down'); } })).toBeNull();
    expect(await routeDetail(A, B, { url: 'http://osrm', fetchImpl: async () => ({ ok: true, json: async () => ({ code: 'NoRoute' }) }) })).toBeNull();
  });

  test('geometry as [lat, lng], steps with maneuver points, ETA never faster than city speed', async () => {
    let asked;
    const r = await routeDetail(A, B, { url: 'http://osrm/', fetchImpl: async (u) => { asked = u; return { ok: true, json: async () => osrm }; } });
    expect(asked).toBe('http://osrm/route/v1/driving/45.3291,2.0478;45.3047,2.0144?overview=full&geometries=geojson&steps=true');
    expect(r.meters).toBe(6670);
    expect(r.minutes).toBeGreaterThanOrEqual(23); // 6.7 km at 18 km/h, not OSRM's 13 min
    expect(r.geometry[0]).toEqual([2.04781, 45.32912]);
    expect(r.steps[1]).toMatchObject({ type: 'turn', modifier: 'right', name: 'Wadada Makkah', at: [2.04, 45.32] });
  });
});

describe('geocode (OpenStreetMap Nominatim)', () => {
  const settings = { url: 'https://nominatim.example', userAgent: 'GuriKaabe/test (x@example.com)' };
  const answer = [
    { name: 'Isbitaalka Banaadir', display_name: 'Isbitaalka Banaadir, Wadada Afgooye, Wadajir, Muqdisho', lat: '2.034484', lon: '45.29884', category: 'amenity', type: 'hospital' },
    { name: 'Far away', display_name: 'Somewhere', lat: '47.6', lon: '-122.3', type: 'city' },
  ];
  beforeEach(() => resetGeocoder());

  test('Somalia only, identifying User-Agent, bounded to the service area; results outside dropped', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => answer }));
    const r = await geocode('Banadir Hospital', { settings, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/countrycodes=so/);
    expect(url).toMatch(/bounded=1/);
    expect(init.headers['User-Agent']).toMatch(/GuriKaabe/);
    expect(r).toEqual([{ name: 'Isbitaalka Banaadir', detail: 'Wadada Afgooye, Wadajir, Muqdisho', lat: 2.034484, lng: 45.29884, kind: 'hospital', category: 'amenity' }]);
  });

  test('the same search is answered from the cache, not asked again', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => answer }));
    await geocode('Banadir  Hospital', { settings, fetchImpl });
    await geocode('banadir hospital', { settings, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('at most one request a second to the public server', async () => {
    const times = [];
    const fetchImpl = async () => { times.push(Date.now()); return { ok: true, json: async () => [] }; };
    await Promise.all(['aaa', 'bbb', 'ccc'].map((q) => geocode(q, { settings, fetchImpl })));
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(1000);
  }, 10000);

  test('near: that area first, in the geocoder\'s order, with the distance', async () => {
    const mogadishu = [
      { name: 'Hodan Hospital', display_name: 'Hodan Hospital, Hodan, Muqdisho', lat: '2.0369624', lon: '45.3108968', type: 'hospital' },
      { name: 'Keysane Hospital', display_name: 'Keysane Hospital, Muqdisho', lat: '2.0535075', lon: '45.3869634', type: 'hospital' },
    ];
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => mogadishu }));
    const r = await geocode('hospital', { settings, fetchImpl, near: { lat: 2.054, lng: 45.386 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // A box around 2.1,45.4 (rounded), not the whole country.
    expect(decodeURIComponent(fetchImpl.mock.calls[0][0])).toMatch(/viewbox=45\.15,2\.35,45\.65,1\.85/);
    expect(r.map((x) => x.name)).toEqual(['Hodan Hospital', 'Keysane Hospital']);
    expect(r[1].distance_m).toBeLessThan(200);
    expect(r[0].distance_m).toBeGreaterThan(8000);
  });

  test('near finds nothing -> the whole country, once', async () => {
    const answers = [[], answer];
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => answers.shift() }));
    const r = await geocode('Banadir Hospital', { settings, fetchImpl, near: { lat: 9.56, lng: 44.06 } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(decodeURIComponent(fetchImpl.mock.calls[1][0])).toMatch(/viewbox=40\.8,12\.3,51\.6,-1\.9/);
    expect(r.map((x) => x.name)).toEqual(['Isbitaalka Banaadir']);
  }, 10000);

  test('too short, or switched off -> nothing asked', async () => {
    const fetchImpl = jest.fn();
    expect(await geocode('ab', { settings, fetchImpl })).toEqual([]);
    expect(await geocode('Bakaara', { settings: { ...settings, url: '' }, fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(foldQuery('  KM4   Junction ')).toBe('km4 junction');
  });
});
