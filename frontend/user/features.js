// The customer app as the stakeholders designed it (mockup, 2026-11-11), on top of app.js:
// the home screen (city, bell, greeting, the eight services, AI Caawiye), choosing your driver,
// the five-step tracker with the driver's card, ratings, a technician's extra work, the Wallet
// and Tracking tabs, the inbox, parcels, Farsamo visits, places near you, suggesting an item,
// and AI drafts. Classic script loaded after app.js: it shares app.js's top-level names
// (api, t, order, ride, cart, showView…), and app.js calls the functions defined here.
//
// Nothing here decides a price or a payment: every amount on screen is the server's quote,
// and every order is placed and paid exactly as in app.js.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => `$${Number(v).toFixed(2)}`;
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const minutesText = (n) => t('time.min', { n });

// A picture that needs the session (a driver's photo): fetched with the token, shown from an
// object URL. Falls back to the first letter of the name.
async function fillAvatar(box, { name, photoPath }) {
  box.replaceChildren();
  box.textContent = (String(name || '?').trim()[0] || '?').toUpperCase();
  if (!photoPath) return;
  try {
    const r = await fetch(GMConfig.api(photoPath), { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return;
    const url = URL.createObjectURL(await r.blob());
    const img = el('img');
    img.alt = '';
    img.src = url;
    img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    box.replaceChildren(img);
  } catch { /* keep the letter */ }
}
const starsText = (rating, count) => (rating ? `★ ${Number(rating).toFixed(1)}${count ? ` (${count})` : ''}` : t('drv.new'));

// ── Bottom sheet ──
function openSheet(title, body) {
  $('sheetTitle').textContent = title;
  $('sheetBody').replaceChildren(body);
  $('sheetBack').hidden = false;
}
function closeSheet() { $('sheetBack').hidden = true; }
$('sheetBack').addEventListener('click', (e) => { if (e.target === $('sheetBack')) closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

// ══ Home ══
const cityLabel = (c) => `${so() ? c.so : c.en}, ${c.region}`;
let publicSettings = null;
async function loadPublicSettings() {
  if (publicSettings) return publicSettings;
  const res = await api('/settings/public');
  publicSettings = res.error ? { freeDelivery: { enabled: false } } : res;
  return publicSettings;
}
const promoText = (fd) => (Number(fd.minSubtotal) > 0 ? t('promo.over', { amt: money(fd.minSubtotal) }) : t('promo.all'));

let myName = null;
async function renderHome() {
  $('cityName').textContent = cityLabel(GMCity.current());
  $('greetName').textContent = t('home.hello', { name: myName || t('home.sir') });
  if (myName === null) {
    api('/me').then((r) => { myName = r.name || ''; $('greetName').textContent = t('home.hello', { name: myName || t('home.sir') }); });
  }
  refreshBell();
  loadPublicSettings().then((st) => {
    const fd = st.freeDelivery || {};
    $('promoStrip').classList.toggle('hidden', !fd.enabled);
    if (fd.enabled) $('promoSub').textContent = promoText(fd);
  });
  renderEtaStrip();
  renderActiveOrderTile();
}

// Free drivers near the city centre and how far the nearest is (counts and minutes only).
async function renderEtaStrip() {
  const c = GMCity.current().center;
  const res = await api(`/nearby?lat=${c.lat}&lng=${c.lng}`);
  const n = res.nearby;
  if (!n) return;
  const best = ['bajaj', 'car'].map((v) => ({ v, ...n[v] })).filter((x) => x.count > 0).sort((a, b) => a.eta_min - b.eta_min)[0];
  if (!best) {
    $('etaTitle').textContent = t('home.eta.title');
    $('etaSub').textContent = t('home.eta.sub');
    return;
  }
  $('etaTitle').textContent = t('home.eta.live', { v: t(`veh.${best.v}`), n: best.eta_min });
  $('etaSub').textContent = t('home.eta.count', { n: n.bajaj.count + n.car.count });
}

// A job under way gets a shortcut on the home screen.
async function renderActiveOrderTile() {
  const res = await api('/orders/mine');
  const live = (res.orders || []).filter((o) => !['DELIVERED', 'FAILED_REFUND'].includes(o.status));
  $('trackDot').classList.toggle('hidden', !live.length);
  const tile = $('activeOrderTile');
  if (!live.length) { tile.classList.add('hidden'); return; }
  const o = live[0];
  tile.innerHTML = `<span class="tile-icon">${kindIcon(o)}</span>
    <span class="tile-body"><span class="tile-title">${esc(label(o.status, o))}</span>
    <span class="tile-sub">${esc(t('home.active', { n: live.length }))}</span></span><span class="chev">›</span>`;
  tile.onclick = () => (live.length === 1 ? resumeOrder(o.id) : openTracking());
  tile.classList.remove('hidden');
}
const kindIcon = (o) => (o.kind === 'RIDE' ? (VEHICLE_ICON[o.vehicle] || '🚗') : { PARCEL: '📦', SERVICE: '🛠️' }[o.kind] || '🛍️');

$('cityBtn').addEventListener('click', () => {
  const list = el('div', 'city-list');
  GMCity.list.forEach((c) => {
    const b = el('button', null, cityLabel(c));
    b.type = 'button';
    b.setAttribute('aria-pressed', c.id === GMCity.current().id ? 'true' : 'false');
    b.addEventListener('click', () => { GMCity.set(c.id); closeSheet(); renderHome(); });
    list.append(b);
  });
  openSheet(t('city.title'), list);
});

// The eight services.
const SERVICE_OPEN = {
  bajaj: () => openRide('bajaj'),
  taxi: () => openRide('car'),
  food: () => openShop('food'),
  grocery: () => openShop('grocery'),
  pharmacy: () => openShop('pharmacy'),
  water: () => openShop('water'),
  repair: () => openService(),
  parcel: () => openParcel(),
};
// Signed out: off to sign in, and true (the caller stops).
function needSignIn() {
  if (token) return false;
  afterSignIn = 'home';
  setAuthMode('signin');
  showView('authView', 'home');
  toast(t('auth.first'));
  return true;
}
document.querySelectorAll('#svcGrid [data-svc]').forEach((b) => b.addEventListener('click', () => {
  if (needSignIn()) return;
  SERVICE_OPEN[b.dataset.svc]();
}));
$('bannerOrder').addEventListener('click', () => SERVICE_OPEN.food());
$('aiTalk').addEventListener('click', () => openChat(null));
$('homeAi').addEventListener('click', () => {
  const q = $('homeSearch').value.trim();
  openChat(null);
  if (q) { $('homeSearch').value = ''; $('homeResults').replaceChildren(); sendHelp(q); }
});
$('bellBtn').addEventListener('click', () => openInbox());

// Home search: services, catalog items and trades, as you type. Enter asks AI Caawiye.
let homeSearchTimer;
$('homeSearch').addEventListener('input', () => {
  clearTimeout(homeSearchTimer);
  homeSearchTimer = setTimeout(renderHomeSearch, 150);
});
$('homeSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('homeAi').click(); } });
async function renderHomeSearch() {
  const q = fold($('homeSearch').value).trim();
  const box = $('homeResults');
  if (q.length < 2) { box.replaceChildren(); return; }
  const rows = [];
  document.querySelectorAll('#svcGrid [data-svc]').forEach((b) => {
    const name = b.textContent.trim();
    if (fold(name).includes(q) || fold(b.dataset.svc).includes(q)) rows.push({ icon: b.querySelector('.em').textContent, title: name, go: () => b.click() });
  });
  await loadCatalog();
  for (const c of catalog || []) {
    for (const i of c.items) {
      if (rows.length >= 8) break;
      if (fold(i.name_en).includes(q) || fold(i.name_so).includes(q)) {
        rows.push({
          icon: c.icon, title: itemName(i), sub: `${itemUnit(i)} · ${money(i.price)}`,
          go: () => { openShop(c.service); activeCat = c.id; $('shopSearch').value = itemName(i); renderCatalog(); },
        });
      }
    }
  }
  box.replaceChildren(...rows.slice(0, 8).map((r) => {
    const b = el('button', 'tile');
    b.type = 'button';
    b.innerHTML = `<span class="tile-icon">${esc(r.icon || '•')}</span><span class="tile-body"><span class="tile-title">${esc(r.title)}</span>${r.sub ? `<span class="tile-sub">${esc(r.sub)}</span>` : ''}</span><span class="chev">›</span>`;
    b.addEventListener('click', () => { $('homeSearch').value = ''; box.replaceChildren(); if (!needSignIn()) r.go(); });
    return b;
  }), ...(rows.length ? [] : [el('p', 'muted', t('home.search.ai'))]));
}

// ══ Bell / inbox ══
async function refreshBell() {
  if (!token) return;
  const res = await api('/inbox');
  const n = res.unread || 0;
  $('bellCount').textContent = n > 9 ? '9+' : String(n);
  $('bellCount').classList.toggle('hidden', n === 0);
}
const INBOX_ICON = { order: '📋', wallet: '👛', submission: '💡', quote: '🛠️' };
function inboxText(i) {
  if (i.type === 'order') {
    const kind = KIND_KEY[i.order_kind] || 'delivery';
    return { title: label(i.status, { kind: i.order_kind }), sub: t(`inbox.kind.${kind}`, { amt: money(i.amount) }) };
  }
  if (i.type === 'wallet') {
    const sign = Number(i.amount) > 0 ? '+' : '';
    return { title: t(WALLET_KIND[i.kind] || 'wallet.title'), sub: `${sign}${money(i.amount).replace('$-', '-$')}` };
  }
  if (i.type === 'submission') return { title: t(`inbox.sub.${i.status}`), sub: i.name };
  return { title: t('inbox.quote'), sub: money(i.amount) };
}
async function openInbox() {
  if (needSignIn()) return;
  showView('inboxView', 'home');
  $('inboxList').innerHTML = `<p class="muted">${t('shop.loading')}</p>`;
  const res = await api('/inbox');
  const seen = res.seen_at ? new Date(res.seen_at).getTime() : 0;
  const items = res.items || [];
  $('inboxList').replaceChildren(...(items.length ? items.map((i) => {
    const b = el('button', `note-row${new Date(i.at).getTime() > seen ? ' unread' : ''}`);
    b.type = 'button';
    const x = inboxText(i);
    b.innerHTML = `<span class="ni">${INBOX_ICON[i.type] || '•'}</span><span class="nb"><strong></strong><span class="muted"></span></span>`;
    b.querySelector('strong').textContent = x.title;
    b.querySelector('.muted').textContent = `${x.sub} · ${new Date(i.at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
    b.addEventListener('click', () => {
      if (i.type === 'quote' && i.extra_id) return resumeOrder(i.status === 'PENDING_PAYMENT' ? i.extra_id : i.order_id);
      if (i.order_id) return resumeOrder(i.order_id);
      if (i.type === 'wallet') return goTab('wallet');
      if (i.type === 'submission') return openSuggest();
      return null;
    });
    return b;
  }) : [el('div', 'empty', t('inbox.none'))]));
  if (res.unread) api('/inbox/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(refreshBell);
}
$('inboxBack').addEventListener('click', () => goTab('home'));

// ══ Choose your driver (ride) ══
// One fare for every driver of a vehicle (the server's). The one chosen is offered the ride
// first; if they can't, the nearest free driver takes it — the customer never starts over.
function renderRideDrivers(option) {
  const box = $('rideDriversBox');
  const list = option?.drivers || [];
  box.classList.toggle('hidden', !option || !list.length);
  if (!option || !list.length) { ride.driverId = null; return; }
  if (ride.driverId && !list.some((d) => d.id === ride.driverId)) ride.driverId = null;
  $('rideDriversTitle').textContent = t('ride.chooseDriver', { v: vehicleName(option.vehicle) });
  $('rideDrivers').replaceChildren(...list.map((d) => {
    const b = el('button', 'drv');
    b.type = 'button';
    b.setAttribute('aria-pressed', d.id === ride.driverId ? 'true' : 'false');
    const av = el('span', 'avatar');
    fillAvatar(av, { name: d.name, photoPath: d.photo ? `/drivers/${d.id}/photo` : null });
    const body = el('span', 'db');
    const name = el('strong');
    name.append(d.name, el('span', 'stars', starsText(d.rating, d.ratings)));
    body.append(name, el('span', 'muted', [t('ride.awayMin', { n: d.eta_min }), d.plate].filter(Boolean).join(' · ')));
    const price = el('strong', 'mono', money(option.total));
    const tick = el('span', 'tick', d.id === ride.driverId ? '✓' : '');
    b.append(av, body, price, tick);
    b.addEventListener('click', () => {
      ride.driverId = ride.driverId === d.id ? null : d.id;
      renderRideDrivers(option);
    });
    return b;
  }));
}

// How the ride is paid: the wallet when it is on and holds enough, else mobile money on the
// order screen. Tapping switches between them.
function renderRidePay() {
  const w = walletState;
  const fare = ride.quote?.options.find((o) => o.vehicle === ride.vehicle)?.total;
  const can = Boolean(w?.enabled) && (fare == null || Number(w.balance) >= Number(fare));
  if (ride.payWallet == null) ride.payWallet = true;
  const useWallet = can && ride.payWallet;
  $('ridePayLabel').textContent = useWallet ? t('pay.wallet') : t('pay.mobile');
  $('ridePayBal').textContent = w?.enabled ? money(w.balance) : '';
  $('ridePayRow').style.cursor = can ? 'pointer' : 'default';
}
$('ridePayRow').addEventListener('click', () => {
  if (!walletState?.enabled) return;
  ride.payWallet = !ride.payWallet;
  renderRidePay();
});

// ══ Cart: free delivery ══
function renderCartPromo() {
  loadPublicSettings().then((st) => {
    const fd = st.freeDelivery || {};
    $('cartPromo').classList.toggle('hidden', !fd.enabled);
    if (fd.enabled) $('cartPromoSub').textContent = promoText(fd);
  });
}

// ══ Tracking: five steps, the ETA, the driver ══
const STEP_ICON = ['✓', '🛍️', '🛵', '📍', '🏠'];
const STEP_ICON_KIND = { RIDE: ['✓', '🛺', '🚗', '📍', '🏁'], PARCEL: ['✓', '📦', '🛵', '📍', '🏠'], SERVICE: ['✓', '🛠️', '🔧', '🔧', '✓'] };
let trackEta = null; // { minutes, distance, at }
function stepIndex(status) {
  if (status === 'DELIVERED') return 5;
  if (status === 'IN_TRANSIT') return trackEta && trackEta.distance < 500 && order?.kind !== 'SERVICE' ? 3 : 2;
  return { PAID_UNASSIGNED: 0, DISPATCHED: 1 }[status] ?? -1;
}
function renderSteps5(status) {
  if (!order) return;
  const kind = KIND_KEY[order.kind] || 'delivery';
  const icons = STEP_ICON_KIND[order.kind] || STEP_ICON;
  const cur = stepIndex(status);
  const fail = status === 'FAILED_REFUND';
  const steps = [0, 1, 2, 3, 4].filter((i) => !(order.kind === 'SERVICE' && i === 3));
  $('steps5').className = `steps5${fail ? ' fail' : ''}`;
  $('steps5').innerHTML = steps.map((i) => {
    const cls = fail ? '' : i < cur ? 'done' : i === cur ? 'now' : '';
    return `<div class="s ${cls}"><i>${i < cur && !fail ? '✓' : icons[i]}</i><span>${esc(t(`step.${kind}.${i}`))}</span></div>`;
  }).join('');
  // The picture fits a delivery; a ride, a parcel and a visit have their own icon instead.
  $('trackArt').classList.toggle('hidden', !['DELIVERY', 'PARCEL'].includes(order.kind) || ['DELIVERED', 'FAILED_REFUND'].includes(status));
  renderEta(status);
}
// Live minutes from the driver's road (app.js showDriver). Before a driver: an estimate from
// the distance, said as "about".
function setTrackEta(minutes, distance) {
  trackEta = { minutes, distance, at: Date.now(), order: order?.id };
  if (order) renderSteps5(order.status);
}
function renderEta(status) {
  const live = trackEta && Date.now() - trackEta.at < 3 * 60 * 1000 && ['DISPATCHED', 'IN_TRANSIT'].includes(status);
  let text = null;
  if (live) text = t('track.etaLive', { n: trackEta.minutes });
  else if (status === 'PAID_UNASSIGNED' || status === 'PENDING_PAYMENT') {
    const km = (order.distance_m || 0) / 1000;
    const base = Math.max(5, Math.round((km / 18) * 60));
    const prep = order.kind === 'DELIVERY' ? 20 : order.kind === 'SERVICE' ? 15 : 5;
    const lo = base + prep;
    text = order.kind === 'RIDE' ? null : t('track.etaAbout', { a: lo, b: lo + 15 });
  }
  $('etaLabel').classList.toggle('hidden', !text);
  $('etaValue').classList.toggle('hidden', !text);
  $('etaValue').textContent = text || '';
}

// The order's driver (or the one it was offered to), extra work, and the rating.
let offerTimer = null;
async function renderOrderExtras() {
  if (!order) return;
  const o = order;
  trackEta = trackEta && trackEta.order === o.id ? trackEta : null;
  $('rateCard').classList.add('hidden');
  $('extrasCard').classList.add('hidden');
  const wantDriver = o.offer_driver_id != null || ['DISPATCHED', 'IN_TRANSIT', 'DELIVERED'].includes(o.status);
  if (!wantDriver) { $('driverCard').classList.add('hidden'); $('offerCard').classList.add('hidden'); }
  const [drv, extras, rating] = await Promise.all([
    wantDriver ? api(`/orders/${o.id}/driver`) : Promise.resolve({}),
    o.kind === 'SERVICE' && !o.parent_order_id ? api(`/orders/${o.id}/extras`) : Promise.resolve({}),
    o.status === 'DELIVERED' && o.driver_id != null ? api(`/orders/${o.id}/rating`) : Promise.resolve({}),
  ]);
  if (!order || order.id !== o.id) return;
  renderDriverCard(drv.driver || null);
  renderExtras(extras.extras || []);
  if (o.status === 'DELIVERED' && o.driver_id != null) renderRating(rating.rating || null, drv.driver);
}
function renderDriverCard(d) {
  clearInterval(offerTimer);
  const offer = d && d.offer && order.status === 'PAID_UNASSIGNED';
  $('offerCard').classList.toggle('hidden', !offer);
  $('driverCard').classList.toggle('hidden', !d || offer || order.status === 'DELIVERED');
  if (!d) return;
  const who = order.kind === 'SERVICE' ? t('drv.technician') : vehicleName(d.vehicle);
  if (offer) {
    fillAvatar($('offerAvatar'), { name: d.name, photoPath: d.photo ? `/drivers/${d.id}/photo` : null });
    $('offerName').textContent = `${d.name} · ${starsText(d.rating, d.ratings)}`;
    const tick = () => {
      const left = Math.max(0, Math.ceil((new Date(d.offer_expires_at).getTime() - Date.now()) / 1000));
      $('offerCount').textContent = left ? `0:${String(left).padStart(2, '0')}` : '…';
      if (!left) clearInterval(offerTimer);
    };
    tick();
    offerTimer = setInterval(tick, 1000);
    return;
  }
  fillAvatar($('dcAvatar'), { name: d.name, photoPath: d.photo ? `/drivers/${d.id}/photo` : null });
  $('dcName').textContent = d.name;
  $('dcStars').textContent = starsText(d.rating, d.ratings);
  $('dcVehicle').textContent = who;
  $('dcPlate').textContent = d.plate || '';
  $('dcPlate').classList.toggle('hidden', !d.plate);
}
$('dcChat').addEventListener('click', () => { $('chatInput').focus(); $('chatInput').scrollIntoView({ block: 'center', behavior: 'smooth' }); });

function renderExtras(extras) {
  const box = $('extrasList');
  $('extrasCard').classList.toggle('hidden', !extras.length);
  box.replaceChildren(...extras.map((x) => {
    const row = el('div', 'sub-row');
    const body = el('div', 'grow');
    body.append(el('strong', null, x.details || t('extra.title')), el('div', 'muted', label(x.status, { kind: 'SERVICE' })));
    const right = el('div');
    right.append(el('strong', 'mono', money(x.total_amount)));
    if (x.status === 'PENDING_PAYMENT') {
      const pay = el('button', 'small', t('extra.pay'));
      pay.type = 'button';
      pay.style.marginLeft = '8px';
      pay.addEventListener('click', () => resumeOrder(x.id));
      right.append(pay);
    }
    right.style.display = 'flex';
    right.style.alignItems = 'center';
    row.append(body, right);
    return row;
  }));
}

let rateValue = 0;
function renderRating(existing, d) {
  const card = $('rateCard');
  card.classList.remove('hidden');
  $('rateTitle').textContent = t(order.kind === 'SERVICE' ? 'rate.title.tech' : 'rate.title', { name: d?.name || '' });
  if (existing) {
    $('rateStars').replaceChildren();
    $('rateMore').classList.add('hidden');
    $('rateDone').classList.remove('hidden');
    $('rateDone').textContent = t('rate.done', { s: '★'.repeat(existing.stars) });
    return;
  }
  $('rateDone').classList.add('hidden');
  const draw = () => {
    $('rateStars').replaceChildren(...[1, 2, 3, 4, 5].map((n) => {
      const b = el('button', n <= rateValue ? 'on' : '', '★');
      b.type = 'button';
      b.setAttribute('aria-label', String(n));
      b.addEventListener('click', () => { rateValue = n; draw(); $('rateMore').classList.remove('hidden'); });
      return b;
    }));
  };
  rateValue = 0;
  draw();
}
$('rateSend').addEventListener('click', async () => {
  if (!rateValue || !order) return;
  $('rateSend').disabled = true;
  const res = await api(`/orders/${order.id}/rating`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stars: rateValue, comment: $('rateComment').value.trim() }),
  });
  $('rateSend').disabled = false;
  if (res.error) return toast(GMI18n.err(res.error));
  $('rateComment').value = '';
  toast(t('rate.thanks'));
  renderRating(res.rating, null);
  return null;
});

// Share how it's going: words only. Tracking needs the account, so there is no link to leak.
$('shareBtn').addEventListener('click', async () => {
  if (!order) return;
  const text = trackEta && ['DISPATCHED', 'IN_TRANSIT'].includes(order.status)
    ? t('track.shareEta', { s: label(order.status), n: trackEta.minutes })
    : t('track.shareText', { s: label(order.status) });
  try {
    if (navigator.share) await navigator.share({ title: 'GuriKaabe', text });
    else { await navigator.clipboard.writeText(text); toast(t('track.copied')); }
  } catch { /* cancelled */ }
});

// ══ Tracking tab ══
async function openTracking() {
  showView('trackView');
  $('trackList').innerHTML = `<p class="muted">${t('shop.loading')}</p>`;
  const res = await api('/orders/mine');
  if (res.error) return toast(GMI18n.err(res.error));
  const live = (res.orders || []).filter((o) => !['DELIVERED', 'FAILED_REFUND'].includes(o.status));
  if (live.length === 1) return resumeOrder(live[0].id);
  if (!live.length) {
    $('trackList').innerHTML = `<div class="empty"><div class="big">🛵</div><p>${esc(t('track.none'))}</p></div>`;
    const b = el('button', null, t('home.orderNow'));
    b.type = 'button';
    b.style.maxWidth = '260px';
    b.addEventListener('click', () => goTab('home'));
    $('trackList').querySelector('.empty').append(b);
    return null;
  }
  $('trackList').replaceChildren(...live.map((o) => {
    const b = el('button', 'tile');
    b.type = 'button';
    b.innerHTML = `<span class="tile-icon">${kindIcon(o)}</span><span class="tile-body"><span class="tile-title">${esc(label(o.status, o))}</span>
      <span class="tile-sub">${esc(o.landmark_text || '')}</span><span class="tile-sub">#${GMIds.shortId(o.id)} · ${money(o.total_amount)}</span></span><span class="chev">›</span>`;
    b.addEventListener('click', () => resumeOrder(o.id));
    return b;
  }));
  return null;
}

// ══ Wallet tab ══
const TX_ICON = { topup: '➕', order_payment: '🛍️', refund: '↩️', withdrawal: '🏧', withdrawal_reversal: '↩️' };
function renderWalletHistory(w) {
  const rows = w.entries.map((e) => {
    const row = el('div', 'tx');
    const plus = Number(e.amount) > 0;
    row.append(el('span', 'ti', TX_ICON[e.kind] || '•'));
    const body = el('div', 'tb');
    body.append(el('strong', null, t(WALLET_KIND[e.kind] || e.kind)),
      el('span', 'muted', new Date(e.created_at).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })));
    row.append(body, el('span', `ta mono${plus ? ' plus' : ''}`, `${plus ? '+' : '-'}$${Math.abs(Number(e.amount)).toFixed(2)}`));
    if (e.order_id) { row.style.cursor = 'pointer'; row.addEventListener('click', () => resumeOrder(e.order_id)); }
    return row;
  });
  $('walletHistory').replaceChildren(...(rows.length ? rows : [el('p', 'muted', t('wallet.empty'))]));
}
let topupWallet = null;
function renderTopupWays(w) {
  $('topupApp').classList.toggle('hidden', !(w.gateway || []).length);
  $('topupUssd').classList.toggle('hidden', !w.ussd);
  const lt = w.lastTopup;
  const st = $('topupStatus');
  const recent = lt && Date.now() - new Date(lt.created_at).getTime() < 24 * 3600 * 1000;
  const s = recent ? lt.status : null;
  st.classList.toggle('hidden', !s);
  if (s) {
    st.className = `callout${['declined', 'unknown', 'rejected'].includes(s) ? ' warn' : ''}`;
    st.textContent = t(`wallet.topup.${s}`, { amt: lt.amount, why: lt.detail || '' });
  }
  $('topupClaim').disabled = lt?.status === 'claimed';
}
$('walletTopupBtn').addEventListener('click', () => {
  $('topupCard').classList.toggle('hidden');
  if (!$('topupCard').classList.contains('hidden')) $('topupAmount').focus();
});
let dialSeq = 0;
let dialOptions = [];
$('topupAmount').addEventListener('input', async () => {
  if (!walletState?.ussd) return;
  const amount = parseFloat($('topupAmount').value);
  const seq = ++dialSeq;
  if (!(amount > 0)) { $('topupDial').replaceChildren(); return; }
  const res = await api(`/wallet/topup-options?amount=${amount}`);
  if (seq !== dialSeq) return;
  dialOptions = res.ussd || [];
  // The server's dial string, used verbatim: its # is already %23 (invariant 5).
  $('topupDial').replaceChildren(...(res.ussd || []).map((w) => {
    const a = el('a');
    a.setAttribute('href', w.ussdUri);
    a.addEventListener('click', () => { topupWallet = w.id; });
    const b = el('button', 'secondary', t('wallet.ussd.dial', { wallet: w.name, amt: amount.toFixed(2) }));
    b.type = 'button';
    a.append(b);
    return a;
  }));
});
$('topupClaim').addEventListener('click', async () => {
  const amount = parseFloat($('topupAmount').value);
  if (!(amount > 0)) return toast(t('wallet.err.amount'));
  const reference = $('topupRef').value.trim();
  if (!reference) return toast(t('wallet.err.ref'));
  // The wallet they dialled; with only one on offer, that one.
  const wallet = topupWallet || (dialOptions.length === 1 ? dialOptions[0].id : null);
  if (!wallet) return toast(t('wallet.err.dial'));
  $('topupClaim').disabled = true;
  const res = await api('/wallet/topup-claim', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, wallet, reference }),
  });
  $('topupClaim').disabled = false;
  if (res.error) return toast(GMI18n.err(res.error));
  $('topupRef').value = '';
  $('topupAmount').value = '';
  $('topupDial').replaceChildren();
  toast(t('wallet.ussd.sent'));
  loadWallet();
  return null;
});

// ══ Parcel (the Delivery tile) ══
const parcel = { pickup: null, dropoff: null, picking: 'pickup', map: null, quote: null, seq: 0, pendingId: null };
let parcelPhoneE164 = null;
let parcelRecipientE164 = null;
const refreshParcelPhone = SomPhone.attach({ input: $('parcelPhone'), hint: $('parcelPhoneHint'), onChange: (r) => { parcelPhoneE164 = r.valid ? r.e164 : null; } });
SomPhone.attach({ input: $('parcelRecipient'), hint: $('parcelRecipientHint'), onChange: (r) => { parcelRecipientE164 = r.valid ? r.e164 : null; } });
function setParcelPicking(which) {
  parcel.picking = which;
  $('parcelPick').querySelectorAll('[data-point]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.point === which ? 'true' : 'false'));
}
$('parcelPick').querySelectorAll('[data-point]').forEach((b) => b.addEventListener('click', () => setParcelPicking(b.dataset.point)));
function setParcelPoint(which, p) {
  parcel[which] = p;
  parcel.map.pin(which, p, { kind: which, ...pointLook(p), draggable: true, onMove: (q) => setParcelPoint(which, { lat: q.lat, lng: q.lng }) });
  $(which === 'pickup' ? 'parcelFromText' : 'parcelToText').textContent = pointText(p);
  if (which === 'pickup' && !parcel.dropoff) setParcelPicking('dropoff');
  parcel.map.line('route', parcel.pickup, parcel.dropoff);
  if (parcel.pickup && parcel.dropoff) parcel.map.fit([parcel.pickup, parcel.dropoff]);
  if (which === 'dropoff' && (p.placeId || p.label) && !$('parcelLandmark').value.trim()) $('parcelLandmark').value = p.label;
  quoteParcel();
}
async function locateParcel() {
  $('parcelFromText').textContent = t('ride.locating');
  try {
    const fix = await GMLocation.best({});
    if (!GMMap.inArea(fix)) { $('parcelFromText').textContent = t('loc.outside'); return; }
    setParcelPoint('pickup', { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, gps: true });
  } catch (e) {
    $('parcelFromText').textContent = t('ride.pickup.none');
    toast(t(e.reason === 'denied' ? 'loc.denied' : 'loc.fail'));
  }
}
function openParcel() {
  showView('parcelView', 'home');
  if (!parcel.map) {
    parcel.map = GMMap.create($('parcelMap'), { locate: true });
    parcel.map.onTap((p) => { if (GMMap.inArea(p)) setParcelPoint(parcel.picking, p); });
    loadPlaces();
  }
  parcel.map.refresh();
  if (!$('parcelPhone').value) { $('parcelPhone').value = localStorage.getItem(CONTACT_KEY) || ''; refreshParcelPhone(); }
  if (!parcel.pickup) locateParcel();
}
$('parcelBack').addEventListener('click', () => goTab('home'));
$('parcelLocate').addEventListener('click', locateParcel);
const pickParcelPlace = (p) => { $('parcelSearch').value = ''; setParcelPoint(parcel.picking, pickOsmOrPlace(p)); };
$('parcelOsm').addEventListener('click', () => searchOsm($('parcelSearch'), $('parcelResults'), pickParcelPlace, parcel.map));
$('parcelSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchOsm($('parcelSearch'), $('parcelResults'), pickParcelPlace, parcel.map); } });
$('parcelSearch').addEventListener('input', () => {
  osmSeq += 1;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    await loadPlaces();
    renderPlaceResults($('parcelResults'), searchPlaces($('parcelSearch').value), (p) => {
      $('parcelSearch').value = '';
      setParcelPoint(parcel.picking, { lat: p.lat, lng: p.lng, placeId: p.id, label: placeName(p) });
    });
  }, 150);
});
async function quoteParcel() {
  parcel.quote = null;
  $('parcelBook').disabled = true;
  if (!parcel.pickup || !parcel.dropoff) { $('parcelFee').textContent = '—'; $('parcelQuoteNote').textContent = t('ride.setBoth'); return; }
  const seq = ++parcel.seq;
  $('parcelQuoteNote').textContent = t('ride.quoting');
  const res = await api('/quote', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'PARCEL', pickup: pointBody(parcel.pickup), dropoff: pointBody(parcel.dropoff) }),
  });
  if (seq !== parcel.seq) return;
  if (res.error) { $('parcelFee').textContent = '—'; $('parcelQuoteNote').textContent = GMI18n.err(res.error); return; }
  parcel.quote = res.quote;
  $('parcelFee').textContent = Number(res.quote.total).toFixed(2);
  $('parcelQuoteNote').textContent = [GMMap.formatDistance(res.quote.distance_m), res.quote.minutes ? t('ride.min', { n: res.quote.minutes }) : ''].filter(Boolean).join(' · ');
  $('parcelBook').disabled = false;
  $('parcelBook').textContent = t('parcel.bookFor', { p: Number(res.quote.total).toFixed(2) });
}
$('parcelBook').addEventListener('click', async () => {
  if (!parcel.quote) return;
  const details = $('parcelDetails').value.trim();
  const landmark = $('parcelLandmark').value.trim();
  if (details.length < 3) return toast(t('parcel.err.details'));
  if (!landmark) return toast(t('start.err.landmark'));
  if (!parcelRecipientE164) return toast(t('parcel.err.recipient'));
  if (!parcelPhoneE164) return toast(t('err.phone'));
  $('parcelBook').disabled = true;
  parcel.pendingId = parcel.pendingId || GMIds.newId();
  const res = await api('/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'PARCEL', id: parcel.pendingId, pickup: pointBody(parcel.pickup), dropoff: pointBody(parcel.dropoff),
      pickupNote: $('parcelNote').value.trim(), details, landmark, recipientPhone: parcelRecipientE164,
      phone: parcelPhoneE164, expectedTotal: parcel.quote.total,
    }),
  });
  $('parcelBook').disabled = false;
  if (res.error) { if (res.quote) { parcel.quote = res.quote; $('parcelFee').textContent = res.quote.total; } return toast(GMI18n.err(res.error)); }
  parcel.pendingId = null;
  localStorage.setItem(CONTACT_KEY, parcelPhoneE164);
  order = res.order;
  localStorage.setItem('gm_last', JSON.stringify({ orderId: order.id }));
  parcel.dropoff = null;
  parcel.map.remove('dropoff');
  parcel.quote = null;
  ['parcelDetails', 'parcelLandmark', 'parcelNote', 'parcelRecipient'].forEach((id) => { $(id).value = ''; });
  $('parcelToText').textContent = t('parcel.to.none');
  enterOrderView(res);
  return null;
});

// ══ Farsamo: a technician's visit ══
const svc = { trade: null, point: null, map: null, quote: null, seq: 0, pendingId: null, trades: null };
let svcPhoneE164 = null;
const refreshSvcPhone = SomPhone.attach({ input: $('svcPhone'), hint: $('svcPhoneHint'), onChange: (r) => { svcPhoneE164 = r.valid ? r.e164 : null; } });
async function openService() {
  showView('serviceView', 'home');
  if (!svc.trades) {
    const res = await api('/trades');
    svc.trades = res.trades || [];
  }
  renderTrades();
  if (!svc.map) {
    svc.map = GMMap.create($('svcMap'), { zoom: 15, locate: true });
    svc.map.onTap((p) => { if (GMMap.inArea(p)) setSvcPoint(p); });
  }
  svc.map.refresh();
  if (!$('svcPhone').value) { $('svcPhone').value = localStorage.getItem(CONTACT_KEY) || ''; refreshSvcPhone(); }
}
function renderTrades() {
  $('tradeGrid').replaceChildren(...svc.trades.map((tr) => {
    const b = el('button', 'trade');
    b.type = 'button';
    b.setAttribute('aria-pressed', tr.slug === svc.trade ? 'true' : 'false');
    b.innerHTML = `<span class="em">${esc(tr.icon)}</span><span><span></span><span class="fee"></span></span>`;
    b.querySelector('span > span').textContent = so() ? tr.name_so : tr.name_en;
    b.querySelector('.fee').textContent = t('svc.from', { p: money(tr.visit_fee) });
    b.addEventListener('click', () => { svc.trade = tr.slug; renderTrades(); quoteService(); });
    return b;
  }));
}
function setSvcPoint(p) {
  svc.point = p;
  svc.map.pin('dropoff', p, { kind: 'dropoff', draggable: true, onMove: (q) => setSvcPoint({ lat: q.lat, lng: q.lng }) });
  svc.map.accuracy('acc', p.accuracy ? p : null, p.accuracy);
  $('svcLocStatus').textContent = p.gps ? t('loc.ok', { m: p.accuracy }) : t('ride.pinned');
  quoteService();
}
$('svcLocate').addEventListener('click', async () => {
  $('svcLocStatus').textContent = t('loc.finding');
  try {
    const fix = await GMLocation.best({});
    if (!GMMap.inArea(fix)) { $('svcLocStatus').textContent = t('loc.outside'); return; }
    setSvcPoint({ lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, gps: true });
    svc.map.fit([svc.point]);
  } catch (e) {
    $('svcLocStatus').textContent = t(e.reason === 'denied' ? 'loc.denied' : 'loc.fail');
  }
});
$('serviceBack').addEventListener('click', () => goTab('home'));
async function quoteService() {
  svc.quote = null;
  $('svcBook').disabled = true;
  if (!svc.trade || !svc.point) { $('svcFee').textContent = '—'; $('svcQuoteNote').textContent = t('svc.need'); return; }
  const seq = ++svc.seq;
  const res = await api('/quote', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'SERVICE', trade: svc.trade, dropoff: pointBody(svc.point) }),
  });
  if (seq !== svc.seq) return;
  if (res.error) { $('svcQuoteNote').textContent = GMI18n.err(res.error); return; }
  svc.quote = res.quote;
  $('svcFee').textContent = Number(res.quote.total).toFixed(2);
  $('svcQuoteNote').textContent = res.quote.available > 0 ? t('svc.available', { n: res.quote.available }) : t('svc.noneNow');
  $('svcBook').disabled = false;
  $('svcBook').textContent = t('svc.bookFor', { p: Number(res.quote.total).toFixed(2) });
}
$('svcBook').addEventListener('click', async () => {
  if (!svc.quote) return;
  const details = $('svcDetails').value.trim();
  const landmark = $('svcLandmark').value.trim();
  if (details.length < 3) return toast(t('svc.err.details'));
  if (!landmark) return toast(t('start.err.landmark'));
  if (!svcPhoneE164) return toast(t('err.phone'));
  $('svcBook').disabled = true;
  svc.pendingId = svc.pendingId || GMIds.newId();
  const res = await api('/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'SERVICE', id: svc.pendingId, trade: svc.trade, dropoff: pointBody(svc.point),
      details, landmark, phone: svcPhoneE164, expectedTotal: svc.quote.total,
    }),
  });
  $('svcBook').disabled = false;
  if (res.error) return toast(GMI18n.err(res.error));
  svc.pendingId = null;
  localStorage.setItem(CONTACT_KEY, svcPhoneE164);
  order = res.order;
  localStorage.setItem('gm_last', JSON.stringify({ orderId: order.id }));
  $('svcDetails').value = '';
  enterOrderView(res);
  return null;
});

// ══ Places near you ══
async function openNearby() {
  showView('nearbyView', 'home');
  $('nearbyList').innerHTML = `<p class="muted">${t('ride.locating')}</p>`;
  await loadPlaces();
  let from = GMCity.current().center;
  let note = t('near.fromCity', { c: so() ? GMCity.current().so : GMCity.current().en });
  try {
    const fix = await GMLocation.best({});
    if (GMMap.inArea(fix)) { from = fix; note = t('near.fromYou'); }
  } catch { /* the city centre will do */ }
  $('nearbyNote').textContent = note;
  const list = (placesCache || []).map((p) => ({ ...p, distance_m: GMMap.distance(from, p) }))
    .filter((p) => p.distance_m < 30000).sort((a, b) => a.distance_m - b.distance_m).slice(0, 25);
  if (!list.length) { $('nearbyList').innerHTML = `<p class="muted">${t('near.none')}</p>`; return; }
  renderPlaceResults($('nearbyList'), list, (p) => {
    openRide();
    setTimeout(() => setRidePoint('dropoff', { lat: p.lat, lng: p.lng, placeId: p.id, label: placeName(p) }), 50);
  });
}
$('nearbyBack').addEventListener('click', () => goTab('home'));

// ══ Suggest an item ══
async function openSuggest() {
  if (needSignIn()) return;
  showView('suggestView', 'account');
  const res = await api('/catalog/submissions/mine');
  const subs = res.submissions || [];
  $('sugList').replaceChildren(...(subs.length ? subs.map((x) => {
    const row = el('div', 'sub-row');
    const body = el('div', 'grow');
    body.append(el('strong', null, x.name), el('div', 'muted', x.status === 'rejected' && x.review_note ? `${t(`sug.st.${x.status}`)} — ${x.review_note}` : t(`sug.st.${x.status}`)));
    row.append(el('span', null, { new: '⏳', forwarded: '⏳', published: '✅', rejected: '✕' }[x.status] || '•'), body);
    return row;
  }) : [el('p', 'muted', t('sug.none'))]));
}
$('suggestBack').addEventListener('click', () => goTab('account'));
$('shopSuggest').addEventListener('click', () => { $('sugService').value = shopService || 'grocery'; openSuggest(); });
$('sugPhoto').addEventListener('change', () => {
  const file = $('sugPhoto').files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = el('img', 'thumb');
  img.alt = '';
  img.src = url;
  img.id = 'sugThumb';
  img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
  $('sugThumb').replaceWith(img);
  $('sugCapture').classList.add('done');
});
$('sugSend').addEventListener('click', async () => {
  const name = $('sugName').value.trim();
  const file = $('sugPhoto').files[0];
  if (name.length < 2) return toast(t('sug.err.name'));
  if (!file) return toast(t('sug.err.photo'));
  $('sugSend').disabled = true;
  const res = await api('/catalog/submissions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, note: $('sugNote').value.trim(), service: $('sugService').value }),
  });
  if (res.error) { $('sugSend').disabled = false; return toast(GMI18n.err(res.error)); }
  const up = await api(`/catalog/submissions/${res.submission.id}/photo`, {
    method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
  });
  $('sugSend').disabled = false;
  if (up.error) return toast(GMI18n.err(up.error));
  $('sugName').value = '';
  $('sugNote').value = '';
  $('sugPhoto').value = '';
  $('sugCapture').classList.remove('done');
  toast(t('sug.sent'));
  openSuggest();
  return null;
});

// ══ Profile ══
async function loadProfile() {
  const res = await api('/me');
  myName = res.name || '';
  $('profileName').textContent = myName || t('home.sir');
  // A letter of their name (or email); a phone number has none worth showing.
  const letter = (myName || myPhone || '').trim().match(/\p{L}/u);
  $('profileAvatar').textContent = letter ? letter[0].toUpperCase() : '👤';
  $('nameInput').value = myName;
}
$('nameSave').addEventListener('click', async () => {
  const res = await api('/me/name', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('nameInput').value }) });
  if (res.error) return toast(GMI18n.err(res.error));
  myName = res.name || '';
  toast(t('acct.name.saved'));
  loadProfile();
  return null;
});
$('menuWallet').addEventListener('click', () => goTab('wallet'));
$('menuInbox').addEventListener('click', () => openInbox());
$('menuSuggest').addEventListener('click', () => openSuggest());
$('menuHelp').addEventListener('click', () => goTab('help'));
$('menuAi').addEventListener('click', () => openChat(null));
$('menuTheme').addEventListener('click', () => GmTheme.toggle());
$('faqBack').addEventListener('click', () => goTab(token ? 'account' : 'home'));

// ══ AI Caawiye: chips and drafts ══
document.querySelectorAll('#helpChips [data-ask]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.ask === 'help.chip.other') { $('helpInput').focus(); return; }
  sendHelp(t(b.dataset.ask));
}));
// A draft is a button under the answer. Opening it fills the normal screen; nothing is
// ordered or paid until the customer does it there.
function applyDraft(draft, msgEl) {
  const b = el('button', 'small');
  b.type = 'button';
  b.style.marginTop = '8px';
  b.style.display = 'block';
  if (draft.type === 'cart') {
    b.textContent = draft.lines.length ? t('draft.openCart') : t('draft.openShop');
    b.addEventListener('click', async () => {
      if (needSignIn()) return;
      closeChat();
      if (!draft.lines.length) { openShop('grocery'); return; }
      await loadCatalog();
      for (const l of draft.lines) if (itemById(l.itemId)) cart[l.itemId] = Math.min(50, (cart[l.itemId] || 0) + l.qty);
      saveCart();
      openCheckout();
    });
  } else if (draft.type === 'ride') {
    b.textContent = t('draft.openRide', { v: vehicleName(draft.vehicle) });
    b.addEventListener('click', async () => {
      if (needSignIn()) return;
      closeChat();
      openRide(draft.vehicle);
      if (!draft.to) return;
      await loadPlaces();
      const match = searchPlaces(draft.to)[0];
      if (match) setTimeout(() => setRidePoint('dropoff', { lat: match.lat, lng: match.lng, placeId: match.id, label: placeName(match) }), 50);
      else { $('placeSearch').value = draft.to; setPicking('dropoff'); searchOsm($('placeSearch'), $('placeResults'), pickRidePlace, ride.map); }
    });
  } else if (draft.type === 'nearby') {
    b.textContent = t('draft.openNearby');
    b.addEventListener('click', () => { closeChat(); openNearby(); });
  } else {
    return;
  }
  msgEl.append(b);
}

// ══ Redraws ══
document.addEventListener('gm:lang', () => {
  if (currentView === 'homeView') renderHome();
  if (currentView === 'serviceView' && svc.trades) renderTrades();
  if (currentView === 'inboxView') openInbox();
  if (currentView === 'shopView') openShop();
  if (order) { renderSteps5(order.status); renderOrderExtras(); }
  if (walletState) renderWallet();
});
document.addEventListener('gm:city', () => { if (currentView === 'homeView') renderHome(); });
// A signed-in customer lands on Home: fill it.
if (token && currentView === 'homeView') renderHome();
// The wallet line on the ride screen needs the balance.
if (token) loadWallet().catch(() => {});
