// Operator PWA — the dispatch desk. Nothing reads payment receipts automatically: the operator
// checks the merchant phone and confirms each payment here, so "Confirm payment" is the step
// every order passes through. Customers who tap "I've paid" are surfaced first.
//
// No leverage at this desk: drivers are assigned by the system (fair rotation), refunds are
// recorded by admins only, staff requests are reviewed blind, and every decision lands in an
// append-only audit log. When the mobile-money API is live (settings.paymentConfirmation =
// 'api'), the confirm-payment control disappears: only the provider can mark an order paid.
//
// Layout: every section is a list (left) and a detail panel (right) for the selected item.
// The page never scrolls; each pane does. Lists redraw on every live event, the detail panel
// only when ITS item changes — so a half-typed reference or a picked driver is never wiped.

const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem('opToken') || null;
let me = null; // the signed-in operator
let settings = { paymentConfirmation: 'operator' };

// ── Small helpers ──
function setStatus(text, kind) {
  $('sbText').textContent = text;
  $('sbTime').textContent = new Date().toLocaleTimeString();
  $('statusbar').className = 'statusbar ' + (kind || '');
}
// Everything from the public (names, landmarks, chat) is escaped before innerHTML.
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const money = (n) => `$${Number(n || 0).toFixed(2)}`;
function timeAgo(when) {
  if (!when) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(when).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} h ago` : new Date(when).toLocaleDateString();
}
let toastTimer;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; clearTimeout(toastTimer);
  // A failure to report stays up long enough to read the reference out.
  toastTimer = setTimeout(() => t.remove(), /ref [0-9a-f]{8}|\[\d{3}/.test(msg) ? 10000 : 3000);
}
// Destructive or irreversible buttons take two taps.
function twoTap(btn, confirmText, run) {
  btn.addEventListener('click', () => {
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      const was = btn.textContent;
      btn.textContent = confirmText;
      setTimeout(() => { btn.dataset.armed = ''; btn.textContent = was; }, 4000);
      return;
    }
    btn.dataset.armed = '';
    run();
  });
}

const api = (path, opts = {}) =>
  fetch(GMConfig.api(path), {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  })
    .then(GMConfig.readJson)
    .catch(() => ({ error: 'No connection — check the internet and try again', offline: true }));

// Photo bytes are authorized, so a bare <img src> would 401 — fetch each with the bearer
// token and render from an object URL.
const PHOTO_LABEL = { delivery_proof: 'At the door', pickup_proof: 'Pickup', order_ref: 'Reference' };
async function fillPhotos(el, orderId) {
  if (!el) return;
  const { photos } = await api(`/orders/${orderId}/photos`);
  if (!photos || !photos.length) { el.innerHTML = '<span class="muted">No photos.</span>'; return; }
  el.innerHTML = photos.map((p) => `
    <figure class="photo"><img data-src="${p.url}" alt="" loading="lazy" />
      <figcaption class="muted">${PHOTO_LABEL[p.kind] || p.kind}</figcaption></figure>`).join('');
  el.querySelectorAll('img[data-src]').forEach(async (img) => {
    try {
      const r = await fetch(GMConfig.base + img.dataset.src, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return;
      const url = URL.createObjectURL(await r.blob());
      img.src = url;
      // Kept (not revoked) so a click can open it full size in a new tab.
      img.style.cursor = 'zoom-in';
      img.addEventListener('click', () => window.open(url, '_blank'));
    } catch { /* leave the placeholder */ }
  });
}

// What a create / re-send answered. In development (no email sent) the code is shown so the
// flow can be tested; in production it only ever travels by email.
function setupCodeToast(res, fallbackName) {
  if (res.error && !res.account && !res.role) return toast(res.error);
  const who = res.account?.name || res.account?.display_name || fallbackName;
  if (res.devCode) return toast(`Dev mode — setup code for ${who}: ${res.devCode}`);
  if (res.error) return toast(res.error); // account exists, but the send failed: re-send
  toast(`Setup code ${res.sentVia === 'email' ? 'emailed' : 'texted'} to ${who} ✓`);
}

// ── Sections (sidebar on a desk, pills on a phone) ──
const ICON = {
  orders: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
  deliveries: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  refunds: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v10M9.5 9.5c0-1 1-1.5 2.5-1.5s2.5.6 2.5 1.8c0 2.7-5 1.4-5 4.2 0 1.2 1 1.8 2.5 1.8s2.5-.5 2.5-1.5"/>',
  drivers: '<circle cx="5.5" cy="17.5" r="2.5"/><circle cx="18.5" cy="17.5" r="2.5"/><path d="M8 17.5h7l2-6h-4l-2-4H7"/><path d="M15 6h3l1.5 5.5"/>',
  team: '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/><path d="M17 4a4 4 0 0 1 0 8M22 21c0-3-1.5-5-4-5.7"/>',
  audit: '<path d="M5 3h11l3 3v15H5z"/><path d="M9 9h6M9 13h6M9 17h4"/>',
  account: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
  map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
  catalog: '<path d="M4 7h16l-1.5 12a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
  suggestions: '<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/>',
  topups: '<path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z"/><path d="M15 14h3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  bugs: '<path d="M9 9V7a3 3 0 0 1 6 0v2"/><rect x="7" y="9" width="10" height="11" rx="5"/><path d="M3 13h4M17 13h4M4 7l3 3M20 7l-3 3M4 20l3-3M20 20l-3-3"/>',
};
const SECTIONS = [
  ['orders', 'Orders'], ['map', 'Live map'], ['deliveries', 'Deliveries'], ['refunds', 'Refunds'],
  ['drivers', 'Drivers'], ['catalog', 'Catalog'], ['suggestions', 'Suggestions'], ['topups', 'Top-ups'], ['bugs', 'Bug reports'],
  ['settings', 'Promo', 'admin'], ['team', 'Team', 'admin'], ['audit', 'Audit log', 'admin'], ['account', 'Account'],
];
let panel = 'orders';
const counts = {};
function renderNav() {
  const html = SECTIONS.filter(([, , who]) => who !== 'admin' || me?.is_admin).map(([id, name]) => `
    <button class="navitem" type="button" data-nav="${id}" ${id === panel ? 'aria-current="page"' : ''}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[id]}</svg>
      <span>${name}</span>${counts[id] ? `<span class="count">${counts[id]}</span>` : ''}
    </button>`).join('');
  $('sidenav').innerHTML = html;
  $('topnav').innerHTML = html;
  document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => setPanel(b.dataset.nav)));
}
function setPanel(id) {
  panel = id;
  document.querySelectorAll('[data-panel]').forEach((el) => el.classList.toggle('hidden', el.dataset.panel !== id));
  renderNav();
  if (id === 'deliveries') loadDeliveries();
  if (id === 'audit') loadAudit();
  if (id === 'map') loadMap();
  if (id === 'catalog') loadCatalogAdmin();
  if (id === 'bugs') loadBugs();
  if (id === 'suggestions') loadSuggestions();
  if (id === 'topups') loadTopups();
  if (id === 'settings') loadSettings();
}
function setCount(id, n) {
  if ((counts[id] || 0) === n) return;
  counts[id] = n;
  renderNav();
}
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => setPanel(b.dataset.goto)));

// List + detail plumbing: which item is open in each section, and the phone-width toggle.
const selected = { orders: null, deliveries: null, refunds: null, drivers: null, team: null, catalog: null, bugs: null };
function markSelected(listEl, key) {
  listEl.querySelectorAll('[data-open]').forEach((r) => r.setAttribute('aria-selected', String(r.dataset.open === key)));
}
function showDetail(wsId, on) {
  $(wsId).classList.toggle('show-detail', on);
  $(wsId).closest('.panel').classList.toggle('detail-open', on);
}
const backBtn = (ws) => `<button class="linkbtn only-mobile" type="button" data-back="${ws}">← Back</button>`;
function bindBack(el) {
  el.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => showDetail(b.dataset.back, false)));
}
function emptyDetail(el, icon, text) {
  el.dataset.key = '';
  el.innerHTML = `<div class="pane-body"><div class="pane-empty"><div class="big">${icon}</div>${text}</div></div>`;
}

// ── Login / setup ──
if (window.SomPhone) SomPhone.attach({ input: $('sPhone'), hint: $('sPhoneHint') });

async function login() {
  const username = $('username').value.trim();
  const password = $('password').value;
  if (!username || !password) return toast('Enter your username and password.');
  $('loginBtn').disabled = true;
  // A backend that is down answers through Caddy with a non-JSON 502; api() turns that into
  // "server unavailable [502]" — a button that silently does nothing looks like a wrong password.
  const res = await api('/operator/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  $('loginBtn').disabled = false;
  if (res.error) {
    $('loginHint').textContent = res.retryAfter ? `${res.error}. Try again in ${res.retryAfter}s.` : res.error;
    return;
  }
  token = res.token;
  me = res.operator;
  sessionStorage.setItem('opToken', token);
  $('password').value = '';
  $('loginHint').textContent = '';
  showDash();
}
$('loginBtn').addEventListener('click', login);
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
$('showSetup').addEventListener('click', () => { $('loginView').classList.add('hidden'); $('setupView').classList.remove('hidden'); });
$('setupBack').addEventListener('click', () => { $('setupView').classList.add('hidden'); $('loginView').classList.remove('hidden'); });
$('setupBtn').addEventListener('click', async () => {
  const phone = SomPhone.e164Of($('sPhone')) || $('sPhone').value.trim();
  const code = $('sCode').value.trim();
  const secret = $('sPass').value;
  if (!phone || !/^\d{8}$/.test(code)) return toast('Enter your phone number and the 8-digit code.');
  if (secret !== $('sPass2').value) return toast('The two passwords do not match.');
  $('setupBtn').disabled = true;
  const res = await api('/staff/setup', { method: 'POST', body: JSON.stringify({ role: 'operator', phone, code, secret }) });
  $('setupBtn').disabled = false;
  if (res.error) { $('setupHint').textContent = res.error; return; }
  $('sCode').value = ''; $('sPass').value = ''; $('sPass2').value = '';
  $('username').value = res.username;
  $('password').value = secret;
  $('setupView').classList.add('hidden');
  $('loginView').classList.remove('hidden');
  toast(`Welcome, ${res.name}. Your username is ${res.username}.`);
  login();
});

function logout() {
  // This computer stops getting the desk's notifications once nobody is signed in.
  GMPush.disable(api).catch(() => {}).finally(() => { sessionStorage.removeItem('opToken'); token = null; location.reload(); });
}
$('logoutBtn').addEventListener('click', logout);

async function showDash() {
  $('loginView').classList.add('hidden');
  $('dash').classList.remove('hidden');
  $('logoutBtn').classList.remove('hidden');
  $('sidenav').classList.remove('hidden');
  $('topnav').classList.remove('hidden');
  $('statusbar').classList.remove('hidden');
  await loadMe();
  setPanel('orders');
  setStatus(me ? `Signed in as ${me.display_name} (${me.username}) — monitoring live.` : 'Monitoring live.', 'ok');
  ['orderDetail', 'deliveryDetail', 'refundDetail', 'driverDetail', 'teamDetail', 'catalogDetail', 'bugDetail'].forEach((id) =>
    emptyDetail($(id), '👈', 'Select an item on the left.'));
  refreshAll();
  connectSocket();
  setInterval(pollOutbox, 20000);
  pollOutbox();
  renderOpPush();
}

// Resolve who we are from the token. Also catches an account deactivated while the tab sat
// open — the server answers 401 and we bounce to login.
async function loadMe() {
  const res = await api('/operator/me');
  if (res.error || !res.operator) return logout();
  me = res.operator;
  settings = res.settings || settings;
  $('whoami').textContent = me.display_name;
  $('whoami').classList.remove('hidden');
  $('pwNag').classList.toggle('hidden', !me.must_change_password);
  // Staff management is admin-only on the server; hiding it here just keeps the screen honest.
  document.querySelectorAll('.admin-only').forEach((el) => el.classList.toggle('hidden', !me.is_admin));
  renderNav(); // the Team section comes and goes with admin rights
}

// Shown only while the system is new, as one slim line that disappears when done.
function renderFirstRun({ drivers: driverCount, orders: orderCount }) {
  const el = $('firstRun');
  let msg = '';
  if (driverCount === 0) {
    msg = me?.is_admin
      ? 'Getting started: add a driver under <strong>Drivers</strong>. Until one has set their PIN, paid orders wait.'
      : 'Getting started: ask an admin to add a driver. Until one has set their PIN, paid orders wait.';
  } else if (orderCount === 0) {
    msg = 'Ready. Place a test order from the customer app to watch it come through.';
  }
  el.innerHTML = msg;
  el.classList.toggle('hidden', !msg);
}

let drivers = []; // roster with workload stats

async function refreshAll() {
  await loadDrivers(); // first, so the order detail can build its driver picker
  const [orderCount] = await Promise.all([
    loadOrders(), loadRefunds(), loadDeliveries(),
    ...(me?.is_admin ? [loadOperators(), loadAccessRequests()] : []),
  ]);
  renderFirstRun({ drivers: drivers.length, orders: orderCount ?? 0 });
}

// ═══════════════ Orders ═══════════════
const STATUS_LABEL = {
  PENDING_PAYMENT: 'awaiting payment', PAID_UNASSIGNED: 'paid — needs a driver',
  DISPATCHED: 'driver dispatched', IN_TRANSIT: 'in transit',
  DELIVERED: 'delivered', FAILED_REFUND: 'failed / refund',
};
// Chips say what the order needs from someone, not the enum.
const STATUS_CHIP = {
  PENDING_PAYMENT: ['Awaiting payment', 'pending'], PAID_UNASSIGNED: ['Finding a driver', 'gold'],
  DISPATCHED: ['Driver assigned', 'info'], IN_TRANSIT: ['On the way', 'info'],
  DELIVERED: ['Delivered', 'ok'], FAILED_REFUND: ['Failed', 'fail'],
};
let orderFilter = 'all';
const FILTERS = {
  all: () => true,
  pay: (o) => o.status === 'PENDING_PAYMENT',
  dispatch: (o) => o.status === 'PAID_UNASSIGNED',
  road: (o) => o.status === 'DISPATCHED' || o.status === 'IN_TRANSIT',
};
$('orderFilter').querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
  orderFilter = b.dataset.filter;
  $('orderFilter').querySelectorAll('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderOrders();
}));

let orders = [];
const isClaimed = (o) => o.status === 'PENDING_PAYMENT' && Boolean(o.payment_claimed_at);
// The order of the groups is the order work gets done in.
const ORDER_GROUPS = [
  ['Payment to check', isClaimed],
  ['Awaiting payment', (o) => o.status === 'PENDING_PAYMENT' && !o.payment_claimed_at],
  ['Paid — waiting for a free driver', (o) => o.status === 'PAID_UNASSIGNED'],
  ['On the road', (o) => o.status === 'DISPATCHED' || o.status === 'IN_TRANSIT'],
];

async function loadOrders() {
  const res = await api('/operator/orders');
  if (res.error) { if (!res.offline) logout(); return 0; }
  orders = res.orders || [];
  renderOrders();
  return orders.length;
}

function renderOrders() {
  const n = (f) => orders.filter(f).length;
  $('kpis').innerHTML = [
    ['Payment to check', n(isClaimed), 'warn'],
    ['Awaiting payment', n((o) => o.status === 'PENDING_PAYMENT'), ''],
    ['Waiting for a driver', n((o) => o.status === 'PAID_UNASSIGNED'), 'gold'],
    ['On the road', n(FILTERS.road), ''],
  ].map(([k, v, tone]) => `<div class="kpi ${v ? tone : ''}"><span class="k-label">${k}</span><span class="k-value">${v}</span></div>`).join('');
  setCount('orders', settings.paymentConfirmation === 'api' ? 0 : n(isClaimed));
  $('ordersCount').textContent = `${orders.length}`;

  const shown = orders.filter(FILTERS[orderFilter]);
  const html = ORDER_GROUPS.map(([title, test]) => {
    const rows = shown.filter(test).sort((a, b) =>
      new Date(a.payment_claimed_at || a.created_at) - new Date(b.payment_claimed_at || b.created_at));
    if (!rows.length) return '';
    return `<div class="group-head">${title} · ${rows.length}</div>${rows.map(orderRow).join('')}`;
  }).join('');
  $('orders').innerHTML = html || `<div class="pane-empty"><div class="big">📭</div>${orders.length
    ? 'Nothing in this filter.' : 'No active orders. New orders appear here on their own.'}</div>`;
  $('orders').querySelectorAll('[data-open]').forEach((r) => r.addEventListener('click', () => openOrder(r.dataset.open)));
  markSelected($('orders'), selected.orders);
  if (panel === 'map') renderMap();

  // Keep the open order's panel in step: redraw it only if the order itself changed.
  if (selected.orders) {
    const o = orders.find((x) => x.id === selected.orders);
    if (!o) {
      emptyDetail($('orderDetail'), '✓', 'That order has moved on — delivered or closed. See <strong>Deliveries</strong> or <strong>Refunds</strong>.');
      selected.orders = null;
    } else if (orderKey(o) !== $('orderDetail').dataset.key) {
      renderOrderDetail(o);
    }
  }
}
const orderKey = (o) => [o.id, o.status, o.payment_claimed_at, o.payment_claim_ref, o.driver_id].join('|');

function orderRow(o) {
  const [chip, tone] = STATUS_CHIP[o.status] || [o.status, ''];
  const sub = isClaimed(o)
    ? `💰 Customer says they paid${o.claim_wallet ? ` with ${escapeHtml(o.claim_wallet.name)}` : ''} · ${timeAgo(o.payment_claimed_at)}`
    : `${o.driver_name ? `${o.kind === 'RIDE' ? VEHICLE_ICON[o.vehicle] || '🚗' : '🛵'} ${escapeHtml(o.driver_name)} · ` : ''}${timeAgo(o.created_at)}`;
  const what = o.kind === 'RIDE' ? `${VEHICLE_ICON[o.vehicle] || '🚗'} → ` : { PARCEL: '📦 ', SERVICE: '🛠️ ' }[o.kind] || '🛍️ ';
  return `<button class="lrow" type="button" data-open="${o.id}">
      <span class="l1"><span class="mono">#${GMIds.shortId(o.id)}</span><span class="t">${what}${escapeHtml(o.landmark_text || '—')}</span></span>
      <span class="l2">${sub}</span>
      <span class="side"><span class="amt">${money(o.total_amount)}</span><span class="badge ${tone}">${chip}</span></span>
    </button>`;
}

function openOrder(id) {
  selected.orders = id;
  markSelected($('orders'), id);
  const o = orders.find((x) => x.id === id);
  if (o) renderOrderDetail(o);
  showDetail('ordersWs', true);
}

function renderOrderDetail(o) {
  const el = $('orderDetail');
  el.dataset.key = orderKey(o);
  const [chip, tone] = STATUS_CHIP[o.status] || [o.status, ''];
  const items = (o.items || []).map((it) => escapeHtml(it.text || '')).filter(Boolean).join(', ') || '—';
  const ride = o.kind === 'RIDE';
  const job = o.kind === 'PARCEL'
    ? `<dt>Job</dt><dd>📦 Parcel${o.distance_m ? ` · ${(o.distance_m / 1000).toFixed(1)} km` : ''}</dd>
       <dt>Contents</dt><dd>${escapeHtml(o.details || '—')}</dd><dt>Collect</dt><dd>${escapeHtml(o.pickup_text || '—')}</dd>
       <dt>Deliver</dt><dd>${escapeHtml(o.landmark_text || '—')}</dd><dt>Receiver</dt><dd>${o.recipient_phone ? `<a href="tel:${escapeHtml(o.recipient_phone)}">${escapeHtml(o.recipient_phone)}</a>` : '—'}</dd>`
    : o.kind === 'SERVICE'
      ? `<dt>Job</dt><dd>🛠️ ${o.parent_order_id ? 'Extra work' : 'Visit'} · ${escapeHtml(o.trade || '')}</dd><dt>Problem</dt><dd>${escapeHtml(o.details || '—')}</dd>
         ${o.parent_order_id ? `<dt>For visit</dt><dd class="mono">#${GMIds.shortId(o.parent_order_id)}</dd>` : ''}`
    : ride
    ? `<dt>Job</dt><dd>${VEHICLE_ICON[o.vehicle] || '🚗'} Ride (${escapeHtml(o.vehicle || '')})${o.distance_m ? ` · ${(o.distance_m / 1000).toFixed(1)} km` : ''}</dd>
       <dt>Pickup</dt><dd>${escapeHtml(o.pickup_text || '—')}</dd><dt>Destination</dt><dd>${escapeHtml(o.landmark_text || '—')}</dd>`
    : `<dt>Job</dt><dd>🛍️ Delivery${o.pickup_text ? ` from ${escapeHtml(o.pickup_text)}` : ''}${o.distance_m ? ` · ${(o.distance_m / 1000).toFixed(1)} km` : ''}</dd>
       ${o.fee != null ? `<dt>Price</dt><dd>${money(o.subtotal)} goods + ${money(o.fee)} delivery${o.promo ? ' <span class="badge ok">free delivery promo</span>' : ''}</dd>` : ''}`;
  const map = o.lat != null && o.lng != null
    ? `<a href="https://www.openstreetmap.org/?mlat=${o.lat}&mlon=${o.lng}#map=18/${o.lat}/${o.lng}" target="_blank" rel="noopener">Open map ↗</a>`
    : '<span class="muted">No GPS pin — landmark only</span>';

  let action = '';
  if (o.status === 'PENDING_PAYMENT') {
    const claim = isClaimed(o) ? `<div class="callout" style="margin-bottom:10px;"><strong>💰 Customer says they paid${o.claim_wallet
        ? ` with ${escapeHtml(o.claim_wallet.name)} — check ${escapeHtml(o.claim_wallet.merchant)}` : ''}</strong>
        <div class="muted">${o.payment_claim_ref ? `Ref ${escapeHtml(o.payment_claim_ref)} · ` : ''}${timeAgo(o.payment_claimed_at)}</div></div>`
      : '<p class="muted" style="margin:0 0 8px;">The customer hasn’t said they paid yet.</p>';
    action = settings.paymentConfirmation === 'api'
      ? `<div class="dsec"><h4>Payment</h4>${claim}<p class="muted" style="margin:0;">Confirmed automatically when the money arrives through the mobile-money API. Nobody at the desk can mark it paid.</p></div>`
      : `<div class="dsec"><h4>Confirm payment</h4>${claim}
      <label for="payref-${o.id}">Transaction number from the merchant phone (required)</label>
      <input id="payref-${o.id}" data-payref="${o.id}" value="${escapeHtml(o.payment_claim_ref || '')}" autocapitalize="characters" spellcheck="false" />
      <button data-confirm="${o.id}">Confirm ${money(o.total_amount)} received</button>
      <p class="muted" style="margin:8px 0 0;">The number is checked against every other payment, and your name is recorded with it.</p></div>`;
  } else if (o.status === 'PAID_UNASSIGNED' && o.offer_driver_id) {
    const who = drivers.find((d) => String(d.id) === String(o.offer_driver_id));
    action = `<div class="dsec"><h4>Driver</h4><p class="muted" style="margin:0;">The rider chose <strong>${escapeHtml(who?.name || 'a driver')}</strong>; they have until ${new Date(o.offer_expires_at).toLocaleTimeString()} to accept. Then the nearest free driver gets it automatically.</p></div>`;
  } else if (o.status === 'PAID_UNASSIGNED' && o.kind === 'SERVICE') {
    action = `<div class="dsec"><h4>Technician</h4><p class="muted" style="margin:0;">Paid. The nearest free online technician for this trade gets it automatically. Nobody picks.</p></div>`;
  } else if (o.status === 'PAID_UNASSIGNED') {
    action = o.kind === 'RIDE'
      ? `<div class="dsec"><h4>Driver</h4><p class="muted" style="margin:0;">Paid. The system gives it to the nearest free online ${escapeHtml(o.vehicle || '')} driver within 8 km, as soon as there is one. Nobody picks.</p></div>`
      : `<div class="dsec"><h4>Driver</h4><p class="muted" style="margin:0;">Paid. The system gives it to the next free driver automatically — fewest jobs first, then whoever has waited longest. Nobody picks.</p></div>`;
  } else if (o.status === 'DISPATCHED' || o.status === 'IN_TRANSIT') {
    const proven = o.kind === 'RIDE' ? 'rider picked up' : 'items photographed at pickup';
    action = `<div class="dsec"><h4>Driver</h4><p style="margin:0;">${o.kind === 'RIDE' ? VEHICLE_ICON[o.vehicle] || '🚗' : '🛵'} ${escapeHtml(o.driver_name || '—')} <span class="muted">· assigned automatically${o.status === 'IN_TRANSIT' ? ` · ✓ ${proven}` : ''}</span></p></div>`;
  }

  el.innerHTML = `
    <div class="pane-head">${backBtn('ordersWs')}<strong class="mono">#${GMIds.shortId(o.id)}</strong>
      <span class="badge ${tone}">${chip}</span><span class="grow"></span><strong>${money(o.total_amount)}</strong></div>
    <div class="pane-body">
      ${action}
      <div class="dsec"><h4>Customer</h4><dl class="kv">
        <dt>Driver calls</dt><dd><a href="tel:${escapeHtml(o.user_phone)}">${escapeHtml(o.user_phone)}</a></dd>
        ${job}
        ${ride ? '' : `<dt>Landmark</dt><dd>${escapeHtml(o.landmark_text || '—')}</dd>`}
        <dt>Location</dt><dd>${map}</dd>
        ${ride ? '' : `<dt>Items</dt><dd>${items}</dd>`}
        <dt>Placed</dt><dd>${new Date(o.created_at).toLocaleString()}</dd>
      </dl></div>
      <div class="dsec"><h4>Photos</h4><div class="photos" id="odPhotos"></div></div>
      <div class="dsec"><h4>Progress</h4><ul class="timeline" id="odTimeline"></ul></div>
      <div class="dsec"><h4>Chat</h4><div class="thread" id="odThread"></div>
        <div class="composer"><input id="odMsg" placeholder="Message the customer and driver…" /><button id="odSend" type="button">Send</button></div></div>
    </div>
    <div class="pane-foot"><button class="danger-ghost" id="odFail" type="button">Fail order / refund</button></div>`;
  bindBack(el);
  fillPhotos($('odPhotos'), o.id);
  loadOrderTimeline(o.id);
  loadOrderThread(o.id);

  const confirm = el.querySelector('[data-confirm]');
  if (confirm) {
    // Confirm only after seeing the money on the merchant phone. The transaction number ties
    // this payment to this order: the same number can't confirm a second order.
    confirm.addEventListener('click', async () => {
      const reference = el.querySelector('[data-payref]').value.trim();
      if (!reference) return toast('Enter the transaction number from the merchant phone.');
      confirm.disabled = true;
      const res = await api(`/operator/orders/${o.id}/mark-paid`, { method: 'POST', body: JSON.stringify({ reference }) });
      confirm.disabled = false;
      if (res.error) return toast(res.error);
      toast('Payment confirmed ✓ — the customer sees it now');
      refreshAll();
    });
  }
  twoTap($('odFail'), 'Tap again: fail this order', async () => {
    const res = await api(`/operator/orders/${o.id}/refund`, { method: 'POST', body: JSON.stringify({ reason: 'stopped by operator' }) });
    if (res.error) return toast(res.error);
    toast(o.status === 'PENDING_PAYMENT' ? 'Order failed ✓' : 'Order failed ✓ — the refund is in Refunds');
    refreshAll();
  });
  const send = async () => {
    const body = $('odMsg').value.trim();
    if (!body) return;
    $('odMsg').value = '';
    const res = await api(`/operator/orders/${o.id}/message`, { method: 'POST', body: JSON.stringify({ body, clientId: GMIds.newId() }) });
    if (res.error) toast(res.error);
  };
  $('odSend').addEventListener('click', send);
  $('odMsg').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
}

const STEP_LABEL = {
  PENDING_PAYMENT: 'Order placed', PAID_UNASSIGNED: 'Payment confirmed', DISPATCHED: 'Driver assigned',
  IN_TRANSIT: 'Picked up', DELIVERED: 'Delivered', FAILED_REFUND: 'Failed',
};
async function loadOrderTimeline(orderId) {
  const res = await api(`/orders/${orderId}/timeline`);
  const el = $('odTimeline');
  if (!el || selected.orders !== orderId) return;
  el.innerHTML = (res.timeline || []).map((e) => `
    <li class="${e.to_status === 'FAILED_REFUND' ? 'failed' : 'done'}"><div class="label">${STEP_LABEL[e.to_status] || e.to_status}</div>
      <div class="when">${new Date(e.created_at).toLocaleString()} · ${escapeHtml(String(e.actor).replace(/^operator:\d+:/, ''))}${e.note ? ` · ${escapeHtml(e.note)}` : ''}</div></li>`).join('');
}
async function loadOrderThread(orderId) {
  const res = await api(`/orders/${orderId}/messages`);
  const el = $('odThread');
  if (!el || selected.orders !== orderId) return;
  el.innerHTML = '';
  (res.messages || []).forEach(appendThread);
}
function appendThread(m) {
  const el = $('odThread');
  if (!el) return;
  const div = document.createElement('div');
  // From the desk's side: our own lines on the right, the customer's and driver's on the left.
  div.className = `msg ${m.sender === 'operator' ? 'user' : m.sender === 'system' ? 'system' : 'driver'}`;
  div.textContent = m.sender === 'user' ? `Customer: ${m.body}` : m.sender === 'driver' ? `Driver: ${m.body}` : m.body;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

// ═══════════════ Deliveries: the proof behind each one ═══════════════
// The customer's code is the proof. A delivery without it, without a GPS fix, far from the
// pin, or disputed by the customer is flagged; an operator looks, then marks it checked —
// which records who vouched for it.
const FLAG_TEXT = {
  no_code: 'No customer code', no_gps: 'No GPS fix', far_from_pin: 'Far from the pin',
  customer_disputed: '⚠ Customer says not received — call them',
};
let deliveries = [];
const needsLook = (d) => d.flags.length > 0 && !d.reviewed_at;

async function loadDeliveries() {
  const res = await api('/operator/deliveries');
  if (res.error) return;
  deliveries = res.deliveries || [];
  setCount('deliveries', deliveries.filter(needsLook).length);
  $('deliveriesCount').textContent = `${deliveries.length}`;
  const groups = [['To check', deliveries.filter(needsLook)], ['Done', deliveries.filter((d) => !needsLook(d))]];
  $('deliveries').innerHTML = deliveries.length
    ? groups.filter(([, l]) => l.length).map(([t, l]) => `<div class="group-head">${t} · ${l.length}</div>${l.map(deliveryRow).join('')}`).join('')
    : '<div class="pane-empty"><div class="big">📦</div>No deliveries in the last 7 days.</div>';
  $('deliveries').querySelectorAll('[data-open]').forEach((r) => r.addEventListener('click', () => openDelivery(r.dataset.open)));
  markSelected($('deliveries'), selected.deliveries);
  if (selected.deliveries) {
    const d = deliveries.find((x) => x.order.id === selected.deliveries);
    if (d && deliveryKey(d) !== $('deliveryDetail').dataset.key) renderDeliveryDetail(d);
  }
}
const deliveryKey = (d) => [d.order.id, d.flags.join(','), d.reviewed_at].join('|');
function deliveryRow(d) {
  const look = needsLook(d);
  const how = d.method === 'code' ? '✓ Code' : '📷 No code';
  const where = d.distance_m != null ? `${d.distance_m} m from pin` : d.flags.includes('no_gps') ? 'no GPS' : 'no pin';
  return `<button class="lrow" type="button" data-open="${d.order.id}">
      <span class="l1"><span class="mono">#${GMIds.shortId(d.order.id)}</span><span class="t">${escapeHtml(d.order.landmark_text || '')}</span></span>
      <span class="l2">${how} · ${escapeHtml(where)} · ${escapeHtml(d.order.driver_name || '—')} · ${timeAgo(d.created_at)}</span>
      <span class="side"><span class="amt">${money(d.order.total_amount)}</span>
        <span class="badge ${look ? 'pending' : 'ok'}">${look ? 'Check' : d.reviewed_at ? 'Checked' : 'Proven'}</span></span>
    </button>`;
}
function openDelivery(id) {
  selected.deliveries = id;
  markSelected($('deliveries'), id);
  const d = deliveries.find((x) => x.order.id === id);
  if (d) renderDeliveryDetail(d);
  showDetail('deliveriesWs', true);
}
function renderDeliveryDetail(d) {
  const el = $('deliveryDetail');
  el.dataset.key = deliveryKey(d);
  const look = needsLook(d);
  const how = d.method === 'code' ? '✓ Customer gave the code' : `📷 Photo, no code — “${escapeHtml(d.note || '')}”`;
  const where = d.distance_m != null ? `${d.distance_m} m from the customer’s pin${d.accuracy_m ? ` (GPS ±${d.accuracy_m} m)` : ''}`
    : d.flags.includes('no_gps') ? 'No GPS fix from the driver' : 'No pin to compare with';
  el.innerHTML = `
    <div class="pane-head">${backBtn('deliveriesWs')}<strong class="mono">#${GMIds.shortId(d.order.id)}</strong>
      <span class="badge ${look ? 'pending' : 'ok'}">${look ? 'Check' : d.reviewed_at ? 'Checked' : 'Proven'}</span>
      <span class="grow"></span><strong>${money(d.order.total_amount)}</strong></div>
    <div class="pane-body">
      ${d.flags.length ? `<div class="dsec"><h4>Why it needs a look</h4><div class="chips">${d.flags.map((f) =>
        `<span class="badge pending plain">${FLAG_TEXT[f] || escapeHtml(f)}</span>`).join('')}</div></div>` : ''}
      <div class="dsec"><h4>Proof</h4><dl class="kv">
        <dt>Handover</dt><dd>${how}</dd>
        <dt>Where</dt><dd>${escapeHtml(where)}</dd>
        <dt>Driver</dt><dd>${escapeHtml(d.order.driver_name || '—')}</dd>
        <dt>When</dt><dd>${new Date(d.created_at).toLocaleString()}</dd>
        <dt>Customer</dt><dd><a href="tel:${escapeHtml(d.order.user_phone)}">${escapeHtml(d.order.user_phone || '')}</a></dd>
        <dt>Landmark</dt><dd>${escapeHtml(d.order.landmark_text || '')}</dd>
        ${d.reviewed_at ? `<dt>Checked</dt><dd>Checked by ${escapeHtml(String(d.reviewed_by || '').replace(/^operator:\d+:/, ''))} · ${timeAgo(d.reviewed_at)}</dd>` : ''}
      </dl></div>
      <div class="dsec"><h4>Photos</h4><div class="photos" id="ddPhotos"></div></div>
    </div>
    ${look ? `<div class="pane-foot"><button data-review="${d.order.id}" type="button">Mark checked</button></div>` : ''}`;
  bindBack(el);
  fillPhotos($('ddPhotos'), d.order.id);
  const review = el.querySelector('[data-review]');
  if (review) review.addEventListener('click', async () => {
    review.disabled = true;
    const out = await api(`/operator/orders/${d.order.id}/proofs/review`, { method: 'POST', body: '{}' });
    review.disabled = false;
    if (out.error) return toast(out.error);
    toast('Marked checked ✓');
    loadDeliveries();
  });
}

// ═══════════════ Refunds ═══════════════
// Settling means the operator actually sent money back from their own phone. The telecom
// reference is required because it is the only thing checkable against the telecom's records.
let refunds = [];
let refundsClosed = [];
async function loadRefunds() {
  const res = await api('/operator/refunds');
  if (res.error) return;
  refunds = res.refunds || [];
  refundsClosed = res.settled || [];
  const badge = $('refundTotal');
  badge.textContent = `$${res.total} owed`;
  badge.classList.toggle('hidden', refunds.length === 0);
  setCount('refunds', refunds.length);
  const row = (r, open) => `<button class="lrow" type="button" data-open="${r.id}">
      <span class="l1"><span class="mono">#${GMIds.shortId(r.order?.id)}</span><span class="t">${escapeHtml(r.reason || '')}</span></span>
      <span class="l2">${escapeHtml(r.order?.user_phone || '')} · opened ${timeAgo(r.created_at)}</span>
      <span class="side"><span class="amt">${money(r.amount)}</span><span class="badge ${open ? 'fail' : 'ok'}">${open ? 'Owed' : escapeHtml(r.status)}</span></span>
    </button>`;
  // Careful with the wording: on day one nothing has EVER been settled.
  $('refunds').innerHTML = `
    <div class="group-head">Owed · ${refunds.length}</div>
    ${refunds.length ? refunds.map((r) => row(r, true)).join('') : `<div class="pane-empty">${refundsClosed.length
      ? 'Nothing outstanding — every refund has been settled.'
      : 'No refunds owed. This fills up when an order fails after it was paid.'}</div>`}
    ${refundsClosed.length ? `<div class="group-head">Recently closed · ${refundsClosed.length}</div>${refundsClosed.map((r) => row(r, false)).join('')}` : ''}`;
  $('refunds').querySelectorAll('[data-open]').forEach((r) => r.addEventListener('click', () => openRefund(r.dataset.open)));
  markSelected($('refunds'), selected.refunds);
  if (me?.is_admin) loadWithdrawals();
}

// ── Wallet withdrawals (admin; only when the wallet is on) ──
// The money left the customer's balance when they asked. The admin sends it from the business
// wallet and records the reference — or rejects it, and it goes back to their balance.
let withdrawals = { open: [], recent: [] };
async function loadWithdrawals() {
  const res = await api('/operator/withdrawals');
  if (res.error) return;
  withdrawals = res;
  if (!res.open.length && !res.recent.length) return;
  const row = (w) => `<button class="lrow" type="button" data-wd="${w.id}">
      <span class="l1"><span class="t">💳 Withdrawal to ${escapeHtml(w.payout_phone)}</span></span>
      <span class="l2">${escapeHtml(w.account || '')} · ${timeAgo(w.created_at)}</span>
      <span class="side"><span class="amt">${money(w.amount)}</span><span class="badge ${w.status === 'requested' ? 'fail' : 'ok'}">${w.status === 'requested' ? 'To send' : escapeHtml(w.status)}</span></span>
    </button>`;
  $('refunds').insertAdjacentHTML('afterbegin', `
    <div class="group-head">Wallet withdrawals to send · ${res.open.length}</div>
    ${res.open.map(row).join('') || '<div class="pane-empty">None waiting.</div>'}
    ${res.recent.length ? `<div class="group-head">Withdrawals decided · ${res.recent.length}</div>${res.recent.map(row).join('')}` : ''}`);
  $('refunds').querySelectorAll('[data-wd]').forEach((b) => b.addEventListener('click', () => openWithdrawal(b.dataset.wd)));
}
function openWithdrawal(id) {
  const w = [...withdrawals.open, ...withdrawals.recent].find((x) => x.id === id);
  if (!w) return;
  const el = $('refundDetail');
  const open = w.status === 'requested';
  el.innerHTML = `
    <div class="pane-head">${backBtn('refundsWs')}<strong>Withdrawal ${money(w.amount)}</strong></div>
    <div class="pane-body"><div class="dsec"><dl class="kv">
      <dt>Send to</dt><dd><a href="tel:${escapeHtml(w.payout_phone)}">${escapeHtml(w.payout_phone)}</a></dd>
      <dt>Account</dt><dd>${escapeHtml(w.account || '—')}</dd>
      <dt>Asked</dt><dd>${new Date(w.created_at).toLocaleString()}</dd>
      ${open ? '' : `<dt>Decided</dt><dd>${escapeHtml(w.status)} by ${escapeHtml(w.decided_by || '')}${w.reference ? ` · ref ${escapeHtml(w.reference)}` : ''}${w.note ? ` · ${escapeHtml(w.note)}` : ''}</dd>`}
    </dl></div>
    ${open ? `<div class="dsec"><h4>Sent it</h4>
      <p class="muted" style="margin:0 0 8px;">Send ${money(w.amount)} from the business wallet to ${escapeHtml(w.payout_phone)}, then enter the transaction number.</p>
      <label for="wdRef">Transaction number of the payout</label><input id="wdRef" autocapitalize="characters" />
      <button id="wdPaid" type="button">Record as sent</button></div>
    <div class="dsec"><h4>Reject</h4>
      <label for="wdNote">Why (the customer sees this)</label><input id="wdNote" />
      <button class="danger-ghost" id="wdReject" type="button">Reject — return it to their balance</button></div>` : ''}
    </div>`;
  bindBack(el);
  showDetail('refundsWs', true);
  if (!open) return;
  $('wdPaid').addEventListener('click', async () => {
    const res = await api(`/operator/withdrawals/${w.id}/paid`, { method: 'POST', body: JSON.stringify({ reference: $('wdRef').value.trim() }) });
    if (res.error) return toast(res.error);
    toast('Recorded ✓');
    await loadRefunds();
    emptyDetail(el, '✓', 'Recorded.');
  });
  twoTap($('wdReject'), 'Tap again to reject', async () => {
    const res = await api(`/operator/withdrawals/${w.id}/reject`, { method: 'POST', body: JSON.stringify({ note: $('wdNote').value.trim() }) });
    if (res.error) return toast(res.error);
    toast('Rejected — returned to their balance');
    await loadRefunds();
    emptyDetail(el, '✓', 'Rejected.');
  });
}
function openRefund(id) {
  selected.refunds = id;
  markSelected($('refunds'), id);
  const r = refunds.find((x) => String(x.id) === id) || refundsClosed.find((x) => String(x.id) === id);
  if (!r) return;
  const open = refunds.includes(r);
  const el = $('refundDetail');
  el.innerHTML = `
    <div class="pane-head">${backBtn('refundsWs')}<strong>${money(r.amount)}</strong>
      <span class="badge ${open ? 'fail' : 'ok'}">${open ? 'Owed' : escapeHtml(r.status)}</span>
      <span class="grow"></span><span class="mono muted">#${GMIds.shortId(r.order?.id)}</span></div>
    <div class="pane-body">
      <div class="dsec"><h4>Owed to</h4><dl class="kv">
        <dt>Customer</dt><dd><a href="tel:${escapeHtml(r.order?.user_phone || '')}">${escapeHtml(r.order?.user_phone || '')}</a></dd>
        <dt>Why</dt><dd>${escapeHtml(r.reason || '')}</dd>
        <dt>Opened</dt><dd>${new Date(r.created_at).toLocaleString()}</dd>
        ${!open ? `<dt>Closed with</dt><dd>${escapeHtml(r.settlement_reference || r.settlement_note || '')}</dd>` : ''}
      </dl></div>
      ${open && !me?.is_admin ? '<div class="dsec muted">Only an admin can record a refund as paid or close it.</div>' : ''}
      ${open && me?.is_admin ? `<div class="dsec"><h4>Record it</h4>
        <label for="rfRef">Reference of the money you sent back</label>
        <input id="rfRef" autocapitalize="characters" spellcheck="false" />
        <label for="rfNote">Note (required for “Nothing owed”)</label>
        <input id="rfNote" /></div>` : ''}
    </div>
    ${open && me?.is_admin ? `<div class="pane-foot"><button id="rfSettle" type="button">Mark refunded</button>
      <button class="secondary" id="rfWaive" type="button">Nothing owed</button></div>` : ''}`;
  bindBack(el);
  showDetail('refundsWs', true);
  if (!open || !me?.is_admin) return;
  $('rfSettle').addEventListener('click', async () => {
    const reference = $('rfRef').value.trim();
    if (!reference) return toast('Enter the reference from the transfer you sent.');
    const out = await api(`/operator/refunds/${r.id}/settle`, { method: 'POST', body: JSON.stringify({ reference, note: $('rfNote').value.trim() }) });
    if (out.error) return toast(out.error);
    toast('Refund recorded ✓');
    emptyDetail(el, '✓', 'Recorded.');
    loadRefunds();
  });
  $('rfWaive').addEventListener('click', async () => {
    const note = $('rfNote').value.trim();
    if (!note) return toast('Say why nothing is owed — the ledger has to explain itself.');
    const out = await api(`/operator/refunds/${r.id}/waive`, { method: 'POST', body: JSON.stringify({ note }) });
    if (out.error) return toast(out.error);
    toast('Closed ✓');
    emptyDetail(el, '✓', 'Closed.');
    loadRefunds();
  });
}

// ═══════════════ Drivers ═══════════════
async function loadDrivers() {
  const res = await api('/operator/drivers');
  drivers = res.drivers || [];
  $('driversCount').textContent = `${drivers.length}`;
  $('drivers').innerHTML = drivers.length
    ? drivers.map((d) => `<button class="lrow" type="button" data-open="${d.id}">
        <span class="l1"><span>${VEHICLE_ICON[d.vehicle] || '🛵'}</span><span class="t">${escapeHtml(d.name)}</span></span>
        <span class="l2">${d.role === 'technician' ? '🛠️ technician · ' : ''}${d.online ? 'online' : 'offline'} · ${escapeHtml(d.msisdn)} · ${d.active_orders} active · ${d.delivered_orders} done${d.rating ? ` · ★ ${d.rating} (${d.ratings})` : ''}</span>
        <span class="side">${d.setup_pending ? '<span class="badge pending">Waiting for setup</span>' : ''}
          <span class="badge ${d.active ? 'ok' : 'fail'}">${d.active ? 'Active' : 'Off'}</span></span>
      </button>`).join('')
    : `<div class="pane-empty"><div class="big">🛵</div>No drivers yet${me?.is_admin ? ' — tap “+ Add driver”' : ''}.</div>`;
  $('drivers').querySelectorAll('[data-open]').forEach((r) => r.addEventListener('click', () => openDriver(r.dataset.open)));
  markSelected($('drivers'), selected.drivers);
}
function openDriver(id) {
  selected.drivers = id;
  markSelected($('drivers'), id);
  const d = drivers.find((x) => String(x.id) === id);
  if (!d) return;
  const el = $('driverDetail');
  el.innerHTML = `
    <div class="pane-head">${backBtn('driversWs')}<strong>${escapeHtml(d.name)}</strong>
      <span class="badge ${d.active ? 'ok' : 'fail'}">${d.active ? 'Active' : 'Off'}</span></div>
    <div class="pane-body">
      <div class="dsec"><h4>Driver</h4><dl class="kv">
        <dt>Phone (sign-in)</dt><dd><a href="tel:${escapeHtml(d.msisdn)}">${escapeHtml(d.msisdn)}</a></dd>
        <dt>Setup</dt><dd>${d.setup_pending ? 'Code sent — waiting for them to choose a PIN' : 'PIN set'}</dd>
        <dt>Vehicle</dt><dd>${VEHICLE_ICON[d.vehicle] || ''} ${escapeHtml(d.vehicle)}</dd>
        <dt>Online</dt><dd>${d.online ? 'Yes' : 'No'}${d.located_at ? ` · last position ${timeAgo(d.located_at)}` : ' · no position yet'}</dd>
        <dt>Now</dt><dd>${d.active_orders} active</dd>
        <dt>All time</dt><dd>${d.delivered_orders} delivered</dd>
        <dt>Rating</dt><dd>${d.rating ? `★ ${d.rating} from ${d.ratings} customer(s)` : 'No ratings yet'}</dd>
        <dt>Role</dt><dd>${d.role === 'technician' ? `Technician · ${escapeHtml((d.trades || []).join(', ') || 'no trades yet')}` : 'Driver'}</dd>
        <dt>Plate</dt><dd>${escapeHtml(d.plate || '—')}</dd>
      </dl>
      <div class="avatar-op" id="drvPhotoBox">${d.has_photo ? '' : '<span class="muted">No photo yet</span>'}</div></div>
      ${me?.is_admin ? `<div class="dsec"><h4>What customers see, and which jobs</h4>
        <p class="muted" style="margin:0 0 8px;">Riders choose a driver by photo, name, plate and rating. A technician gets only visits in their trades.</p>
        <label for="drvRole">Role</label>
        <select id="drvRole"><option value="driver" ${d.role !== 'technician' ? 'selected' : ''}>Driver (rides, deliveries, parcels)</option>
          <option value="technician" ${d.role === 'technician' ? 'selected' : ''}>Technician (Farsamo visits)</option></select>
        <label>Trades (technicians)</label><div id="drvTrades" class="chips" style="flex-wrap:wrap;"></div>
        <label for="drvPlate">Plate</label><input id="drvPlate" value="${escapeHtml(d.plate || '')}" maxlength="16" placeholder="BAJ 123" />
        <button class="secondary" id="drvProfileSave" type="button">Save</button>
        <label for="drvPhoto">Photo (JPEG, PNG or WebP — a clear face)</label><input id="drvPhoto" type="file" accept="image/jpeg,image/png,image/webp" />
      </div>` : ''}
      ${me?.is_admin ? `<div class="dsec"><h4>Vehicle</h4>
        <p class="muted" style="margin:0 0 8px;">Rides go to a driver with the vehicle the rider chose. Motorbikes get deliveries only.</p>
        <select id="drvVehicle">${['bajaj', 'car', 'moto'].map((v) => `<option value="${v}" ${d.vehicle === v ? 'selected' : ''}>${VEHICLE_ICON[v]} ${v}</option>`).join('')}</select>
        <button class="secondary" id="drvVehicleSave" type="button">Save vehicle</button></div>` : ''}
      ${me?.is_admin && d.active ? `<div class="dsec"><h4>${d.setup_pending ? 'Re-send setup code' : 'Reset PIN'}</h4>
        <p class="muted" style="margin:0 0 8px;">A new code goes by email; their current PIN keeps working until they set a new one.</p>
        <label for="drvCodeEmail">Email${d.has_email ? ' (leave blank to use the one on file)' : ''}</label>
        <input id="drvCodeEmail" type="email" placeholder="${d.has_email ? 'on file' : 'driver@example.com'}" />
        <button class="secondary" id="drvCode" type="button">Re-send setup code by email</button></div>` : ''}
    </div>
    ${me?.is_admin ? `<div class="pane-foot"><button class="${d.active ? 'danger-ghost' : ''}" id="drvActive" type="button">${d.active ? 'Deactivate driver' : 'Reactivate driver'}</button></div>` : ''}`;
  bindBack(el);
  showDetail('driversWs', true);
  const code = $('drvCode');
  if (code) code.addEventListener('click', async () => {
    const email = $('drvCodeEmail').value.trim();
    const out = await api(`/operator/staff/driver/${d.id}/setup-code`, { method: 'POST', body: JSON.stringify(email ? { email } : {}) });
    setupCodeToast(out, d.name);
    await loadDrivers();
    openDriver(id);
  });
  if (d.has_photo) {
    fetch(GMConfig.api(`/drivers/${d.id}/photo`), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : null)).then((b) => {
        if (!b || !$('drvPhotoBox')) return;
        const img = document.createElement('img');
        img.src = URL.createObjectURL(b);
        img.alt = d.name;
        $('drvPhotoBox').replaceChildren(img);
      }).catch(() => {});
  }
  if ($('drvTrades')) {
    api('/operator/trades').then((r) => {
      const on = new Set(d.trades || []);
      $('drvTrades').innerHTML = (r.trades || []).map((tr) => `<button class="chip" type="button" data-trade="${escapeHtml(tr.slug)}" aria-pressed="${on.has(tr.slug)}">${escapeHtml(tr.icon)} ${escapeHtml(tr.name_en)}</button>`).join('');
      $('drvTrades').querySelectorAll('[data-trade]').forEach((b) => b.addEventListener('click', () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'))));
    });
    $('drvProfileSave').addEventListener('click', async () => {
      const trades = [...$('drvTrades').querySelectorAll('[aria-pressed="true"]')].map((b) => b.dataset.trade);
      const out = await api(`/operator/drivers/${d.id}/profile`, { method: 'POST', body: JSON.stringify({ role: $('drvRole').value, trades, plate: $('drvPlate').value }) });
      if (out.error) return toast(out.error);
      toast('Saved ✓ — recorded in the audit log');
      await loadDrivers();
      openDriver(id);
      return null;
    });
    $('drvPhoto').addEventListener('change', async () => {
      const file = $('drvPhoto').files[0];
      if (!file) return;
      const out = await api(`/operator/drivers/${d.id}/photo`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      if (out.error) return toast(out.error);
      toast('Photo saved ✓');
      await loadDrivers();
      openDriver(id);
    });
  }
  const veh = $('drvVehicleSave');
  if (veh) veh.addEventListener('click', async () => {
    const out = await api(`/operator/drivers/${d.id}/vehicle`, { method: 'POST', body: JSON.stringify({ vehicle: $('drvVehicle').value }) });
    if (out.error) return toast(out.error);
    toast('Vehicle saved ✓');
    await loadDrivers();
    openDriver(id);
  });
  const act = $('drvActive');
  if (act) twoTap(act, d.active ? 'Tap again to deactivate' : 'Tap again to reactivate', async () => {
    const out = await api(`/operator/drivers/${d.id}/active`, { method: 'POST', body: JSON.stringify({ active: !d.active }) });
    if (out.error) return toast(out.error);
    toast('Updated ✓');
    await loadDrivers();
    openDriver(id);
  });
}
$('newDriverBtn').addEventListener('click', () => {
  selected.drivers = null;
  markSelected($('drivers'), null);
  const el = $('driverDetail');
  el.innerHTML = `
    <div class="pane-head">${backBtn('driversWs')}<strong>Add a driver</strong></div>
    <div class="pane-body"><div class="dsec">
      <p class="muted" style="margin:0 0 8px;">They get a setup code by email and choose their own PIN. They sign in with this phone number and that PIN.</p>
      <label for="dName">Name</label><input id="dName" autocomplete="off" />
      <label for="dMsisdn">Phone number</label><input id="dMsisdn" type="tel" placeholder="61 234 5678" />
      <div class="phone-hint muted" id="phoneHint"></div>
      <label for="dEmail">Email — the setup code goes here</label><input id="dEmail" type="email" placeholder="driver@example.com" />
    </div></div>
    <div class="pane-foot"><button id="addDriver" type="button">Create &amp; email setup code</button></div>`;
  bindBack(el);
  if (window.SomPhone) SomPhone.attach({ input: $('dMsisdn'), hint: $('phoneHint') });
  showDetail('driversWs', true);
  $('addDriver').addEventListener('click', async () => {
    const name = $('dName').value.trim();
    const msisdn = SomPhone.e164Of($('dMsisdn')) || $('dMsisdn').value.trim();
    const email = $('dEmail').value.trim();
    if (!name || !msisdn || !email) return toast('Name, phone and email are all needed.');
    const res = await api('/operator/drivers', { method: 'POST', body: JSON.stringify({ name, msisdn, email }) });
    if (res.error && !res.account) return toast(res.error);
    setupCodeToast(res, name);
    await loadDrivers();
    if (res.account?.id) openDriver(String(res.account.id));
  });
});

// ═══════════════ Live map ═══════════════
// Where every driver last reported, and what they carry. Positions arrive over the socket
// (driver_location) a few seconds apart; nothing here is a history.
let opMap = null;
let positions = new Map(); // driverId -> row
let jobPins = new Set();
const VEHICLE_ICON = { bajaj: '🛺', car: '🚗', moto: '🏍️' };
async function loadMap() {
  const res = await api('/operator/map');
  if (res.error) return;
  positions = new Map((res.drivers || []).map((d) => [String(d.driver_id), d]));
  if (!opMap) opMap = GMMap.create($('opMap'), { zoom: 13 });
  opMap.refresh();
  renderMap(true);
}
const fresh = (d) => Date.now() - new Date(d.updated_at).getTime() < 3 * 60 * 1000;
function renderMap(fit = false) {
  if (!opMap) return;
  const rows = [...positions.values()].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  for (const d of rows) {
    opMap.pin(`d${d.driver_id}`, d, { kind: d.online && fresh(d) ? 'driver' : 'me', title: d.name });
  }
  // Live jobs: their start and end pins, so the desk sees who is going where. Pins of jobs
  // that finished since the last draw are taken off.
  const live = orders.filter((x) => ['PAID_UNASSIGNED', 'DISPATCHED', 'IN_TRANSIT'].includes(x.status));
  const keep = new Set(live.flatMap((o) => [`s${o.id}`, `e${o.id}`]));
  for (const k of jobPins) if (!keep.has(k)) opMap.remove(k);
  jobPins = keep;
  for (const o of live) {
    if (o.pickup_lat != null) opMap.pin(`s${o.id}`, { lat: o.pickup_lat, lng: o.pickup_lng }, { kind: o.kind === 'RIDE' ? 'pickup' : 'market', title: `#${GMIds.shortId(o.id)}` });
    if (o.lat != null) opMap.pin(`e${o.id}`, { lat: o.lat, lng: o.lng }, { kind: 'dropoff', title: `#${GMIds.shortId(o.id)} ${o.landmark_text || ''}` });
  }
  const online = rows.filter((d) => d.online && fresh(d)).length;
  $('mapSummary').textContent = `${online} online now · ${rows.length} with a recent position`;
  $('mapDrivers').innerHTML = rows.length ? rows.map((d) => `
    <button class="lrow" type="button" data-pan="${d.driver_id}">
      <span class="l1"><span>${VEHICLE_ICON[d.vehicle] || '🛵'}</span><span class="t">${escapeHtml(d.name)}</span></span>
      <span class="l2">${d.jobs.length ? d.jobs.map((j) => `${j.kind === 'RIDE' ? 'ride' : 'delivery'} #${GMIds.shortId(j.id)}`).join(', ') : 'no job'} · ${timeAgo(d.updated_at)}</span>
      <span class="side"><span class="badge ${d.online && fresh(d) ? 'ok' : ''}">${d.online ? (fresh(d) ? 'Online' : 'No signal') : 'Offline'}</span></span>
    </button>`).join('') : '<div class="pane-empty"><div class="big">🗺️</div>No driver has shared a position yet. Drivers appear when they go online.</div>';
  $('mapDrivers').querySelectorAll('[data-pan]').forEach((b) => b.addEventListener('click', () => {
    const d = positions.get(b.dataset.pan);
    if (d) opMap.fit([d]);
  }));
  if (fit && rows.length) opMap.fit(rows);
}
function onDriverLocation(m) {
  const d = positions.get(String(m.driverId));
  if (d) Object.assign(d, { lat: m.lat, lng: m.lng, updated_at: m.at, online: true });
  else return panel === 'map' && loadMap(); // someone new came online
  if (panel === 'map') renderMap();
}

// ═══════════════ Catalog & places ═══════════════
// Admins edit; everyone can read. Nothing is deleted — "Hide" keeps old orders readable — and
// every change is in the audit log with its before and after.
let catalogData = { categories: [], places: [] };
async function loadCatalogAdmin() {
  const res = await api('/operator/catalog');
  if (res.error) return toast(res.error);
  catalogData = res;
  const [tr, st] = await Promise.all([api('/operator/trades'), stockImages ? null : api('/operator/stock-images')]);
  catalogData.trades = tr.trades || [];
  if (st) stockImages = st.images || [];
  renderCatalogList();
}
function renderCatalogList() {
  const off = (x) => (x.active === false ? ' <span class="badge">hidden</span>' : '');
  const cats = catalogData.categories.map((c) => `
    <div class="group-head">${escapeHtml(c.icon || '')} ${escapeHtml(c.name_en)} · ${c.items.length} · <span class="muted">${escapeHtml(SERVICE_NAME[c.service] || c.service)} tile</span></div>
    <button class="lrow" type="button" data-cat="${c.id}"><span class="l1"><span class="t">Category: ${escapeHtml(c.name_en)} / ${escapeHtml(c.name_so)}</span>${off(c)}</span></button>
    ${c.items.map((i) => `<button class="lrow" type="button" data-item="${i.id}">
      <span class="l1">${i.image_url ? `<img class="op-thumb" src="${escapeHtml(i.image_url)}" alt="" loading="lazy" />` : '<span class="op-thumb">·</span>'}<span class="t">${escapeHtml(i.name_en)}</span>${off(i)}</span>
      <span class="l2">${escapeHtml(i.name_so)} · ${escapeHtml(i.unit_en || '')}</span>
      <span class="side"><span class="amt">${money(i.price)}</span></span></button>`).join('')}`).join('');
  const places = `<div class="group-head">Places · ${catalogData.places.length}</div>${catalogData.places.map((p) => `
    <button class="lrow" type="button" data-place="${p.id}">
      <span class="l1"><span class="t">${escapeHtml(p.name_en)}</span>${off(p)}</span>
      <span class="l2">${escapeHtml(p.kind)} · ${escapeHtml(p.city)} · ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}</span></button>`).join('')}`;
  const trades = `<div class="group-head">Farsamo trades · ${(catalogData.trades || []).length}</div>${(catalogData.trades || []).map((tr) => `
    <button class="lrow" type="button" data-trade="${tr.id}">
      <span class="l1"><span>${escapeHtml(tr.icon)}</span><span class="t">${escapeHtml(tr.name_en)}</span>${off(tr)}</span>
      <span class="l2">${escapeHtml(tr.name_so)} · ${escapeHtml(tr.slug)}</span>
      <span class="side"><span class="amt">${money(tr.visit_fee)}</span></span></button>`).join('')}`;
  $('catalogList').innerHTML = cats + trades + places;
  $('catalogList').querySelectorAll('[data-trade]').forEach((b) => b.addEventListener('click', () => editTrade(Number(b.dataset.trade))));
  $('catalogList').querySelectorAll('[data-item]').forEach((b) => b.addEventListener('click', () => editItem(Number(b.dataset.item))));
  $('catalogList').querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => editCategory(Number(b.dataset.cat))));
  $('catalogList').querySelectorAll('[data-place]').forEach((b) => b.addEventListener('click', () => editPlace(Number(b.dataset.place))));
}
const findItem = (id) => catalogData.categories.flatMap((c) => c.items).find((i) => i.id === id);
const field = (id, label, value = '', attrs = '') =>
  `<label for="${id}">${label}</label><input id="${id}" value="${escapeHtml(value ?? '')}" ${attrs} ${me?.is_admin ? '' : 'disabled'} />`;
const activeBox = (on) => `<label style="display:flex;gap:8px;align-items:center;"><input id="cActive" type="checkbox" style="width:auto;min-height:0;" ${on !== false ? 'checked' : ''} ${me?.is_admin ? '' : 'disabled'} /> Shown to customers</label>`;
function catalogPane(title, body, onSave) {
  const el = $('catalogDetail');
  el.innerHTML = `<div class="pane-head">${backBtn('catalogWs')}<strong>${title}</strong></div>
    <div class="pane-body"><div class="dsec">${body}</div></div>
    ${me?.is_admin ? '<div class="pane-foot"><button id="cSave" type="button">Save</button></div>' : ''}`;
  bindBack(el);
  showDetail('catalogWs', true);
  const save = $('cSave');
  if (save) save.addEventListener('click', async () => {
    save.disabled = true;
    const res = await onSave();
    save.disabled = false;
    if (res?.error) return toast(res.error);
    toast('Saved ✓ — recorded in the audit log');
    loadCatalogAdmin();
  });
}
const val = (id) => $(id).value.trim();
const send = (method, path, body) => api(path, { method, body: JSON.stringify(body) });

function editItem(id) {
  const i = id ? findItem(id) : null;
  const options = catalogData.categories.map((c) => `<option value="${c.id}" ${i && i.category_id === c.id ? 'selected' : ''}>${escapeHtml(c.name_en)}</option>`).join('');
  catalogPane(i ? escapeHtml(i.name_en) : 'New item', `
    <label for="cCat">Category</label><select id="cCat" ${me?.is_admin ? '' : 'disabled'}>${options}</select>
    ${field('cNameEn', 'Name (English)', i?.name_en)}${field('cNameSo', 'Name (Somali — plain words)', i?.name_so)}
    ${field('cUnitEn', 'Unit (English, e.g. 5 kg)', i?.unit_en)}${field('cUnitSo', 'Unit (Somali)', i?.unit_so)}
    ${field('cPrice', 'Price (USD) — what the customer pays for one', i ? Number(i.price).toFixed(2) : '', 'type="number" step="0.01" min="0.01"')}
    ${field('cDescEn', 'One line about it (English, optional)', i?.description_en)}${field('cDescSo', 'One line (Somali, optional)', i?.description_so)}
    ${field('cSort', 'Order in the list', i?.sort ?? 0, 'type="number" min="0"')}
    ${activeBox(i?.active)}
    <label>Picture</label>
    <div class="op-pic">${i?.image_url ? `<img src="${escapeHtml(i.image_url)}" alt="" />` : '<span class="muted">No picture — the app shows the category icon.</span>'}</div>
    ${me?.is_admin ? `<details class="bare"><summary class="muted">Choose a stock picture (licence-free)</summary>
      <div class="stock-grid" id="stockGrid">${(stockImages || []).map((st) => `<button type="button" class="stock" data-img="${escapeHtml(st.image)}" aria-pressed="${i?.image === st.image}"><img src="${escapeHtml(st.url)}" alt="" loading="lazy" /></button>`).join('')}</div></details>
      ${i ? '<label for="cUpload">…or upload this item\'s own photo</label><input id="cUpload" type="file" accept="image/jpeg,image/png,image/webp" />' : ''}
      ${i?.image ? '<button class="linkbtn" id="cNoPic" type="button">Remove the picture</button>' : ''}` : ''}
    <p class="muted" style="margin:8px 0 0;">A price change applies to new carts only; placed orders keep the price they were bought at.</p>`,
  () => {
    const body = {
      category_id: Number($('cCat').value), name_en: val('cNameEn'), name_so: val('cNameSo'),
      unit_en: val('cUnitEn'), unit_so: val('cUnitSo'), price: Number($('cPrice').value), sort: Number($('cSort').value || 0),
      description_en: val('cDescEn'), description_so: val('cDescSo'), active: $('cActive').checked,
    };
    if (pickedImage !== undefined) body.image = pickedImage;
    return i ? send('PATCH', `/operator/catalog/items/${i.id}`, body) : send('POST', '/operator/catalog/items', body);
  });
  pickedImage = undefined;
  document.querySelectorAll('#stockGrid [data-img]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#stockGrid [data-img]').forEach((x) => x.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    pickedImage = b.dataset.img;
  }));
  const noPic = $('cNoPic');
  if (noPic) noPic.addEventListener('click', () => { pickedImage = null; toast('Save to remove the picture.'); });
  const up = $('cUpload');
  if (up) up.addEventListener('change', async () => {
    const file = up.files[0];
    if (!file) return;
    const out = await api(`/operator/catalog/items/${i.id}/image`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
    if (out.error) return toast(out.error);
    toast('Picture saved ✓ — recorded in the audit log');
    await loadCatalogAdmin();
    editItem(i.id);
  });
}
let pickedImage;
let stockImages = null;
const SERVICE_NAME = { food: 'Food', grocery: 'Groceries', pharmacy: 'Pharmacy', water: 'Water', shop: 'Household' };
function editTrade(id) {
  const tr = id ? (catalogData.trades || []).find((x) => x.id === id) : null;
  catalogPane(tr ? escapeHtml(tr.name_en) : 'New trade', `
    ${tr ? '' : field('cSlug', 'Code (lowercase, e.g. plumber — never changes)', '')}
    ${field('cNameEn', 'Name (English)', tr?.name_en)}${field('cNameSo', 'Name (Somali)', tr?.name_so)}
    ${field('cIcon', 'Icon (one emoji)', tr?.icon, 'maxlength="8"')}
    ${field('cFee', 'Visit fee (USD) — paid upfront; more work is quoted in the app', tr ? Number(tr.visit_fee).toFixed(2) : '', 'type="number" step="0.01" min="0.01"')}
    ${field('cSort', 'Order', tr?.sort ?? 0, 'type="number" min="0"')}
    ${activeBox(tr?.active)}`,
  () => {
    const body = { name_en: val('cNameEn'), name_so: val('cNameSo'), icon: val('cIcon'), visit_fee: Number($('cFee').value), sort: Number($('cSort').value || 0), active: $('cActive').checked };
    if (!tr) body.slug = val('cSlug');
    return tr ? send('PATCH', `/operator/trades/${tr.id}`, body) : send('POST', '/operator/trades', body);
  });
}
function editCategory(id) {
  const c = id ? catalogData.categories.find((x) => x.id === id) : null;
  catalogPane(c ? escapeHtml(c.name_en) : 'New category', `
    ${field('cNameEn', 'Name (English)', c?.name_en)}${field('cNameSo', 'Name (Somali)', c?.name_so)}
    ${field('cIcon', 'Icon (one emoji)', c?.icon, 'maxlength="8"')}${field('cSort', 'Order', c?.sort ?? 0, 'type="number" min="0"')}
    <label for="cService">Home tile</label><select id="cService" ${me?.is_admin ? '' : 'disabled'}>${Object.entries(SERVICE_NAME).map(([k, n]) => `<option value="${k}" ${(c?.service || 'shop') === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
    ${activeBox(c?.active)}`,
  () => {
    const body = { name_en: val('cNameEn'), name_so: val('cNameSo'), icon: val('cIcon'), service: $('cService').value, sort: Number($('cSort').value || 0), active: $('cActive').checked };
    return c ? send('PATCH', `/operator/catalog/categories/${c.id}`, body) : send('POST', '/operator/catalog/categories', body);
  });
}
function editPlace(id) {
  const p = id ? catalogData.places.find((x) => x.id === id) : null;
  const kinds = ['market', 'landmark', 'district'].map((k) => `<option ${p?.kind === k ? 'selected' : ''}>${k}</option>`).join('');
  catalogPane(p ? escapeHtml(p.name_en) : 'New place', `
    <label for="cKind">Kind</label><select id="cKind" ${me?.is_admin ? '' : 'disabled'}>${kinds}</select>
    ${field('cNameEn', 'Name (English)', p?.name_en)}${field('cNameSo', 'Name (Somali)', p?.name_so)}
    ${field('cCity', 'City', p?.city || 'Mogadishu')}
    <label>Position — tap the map or drag the pin to the exact spot</label>
    <div class="op-map-small" id="placeMap"></div>
    <div class="btn-row">${field('cLat', 'Latitude', p?.lat, 'type="number" step="0.000001"')}${field('cLng', 'Longitude', p?.lng, 'type="number" step="0.000001"')}</div>
    ${field('cSort', 'Order', p?.sort ?? 0, 'type="number" min="0"')}
    ${activeBox(p?.active)}
    <p class="muted" style="margin:8px 0 0;">Markets set where deliveries are bought and so the delivery fee. Check every pin on the ground before launch.</p>`,
  () => {
    const body = {
      kind: $('cKind').value, name_en: val('cNameEn'), name_so: val('cNameSo'), city: val('cCity'),
      lat: Number($('cLat').value), lng: Number($('cLng').value), sort: Number($('cSort').value || 0), active: $('cActive').checked,
    };
    return p ? send('PATCH', `/operator/places/${p.id}`, body) : send('POST', '/operator/places', body);
  });
  const m = GMMap.create($('placeMap'), { center: p || GMMap.MOGADISHU, zoom: 15 });
  const setPos = (q) => {
    $('cLat').value = q.lat.toFixed(6);
    $('cLng').value = q.lng.toFixed(6);
    m.pin('p', q, { kind: 'place', draggable: Boolean(me?.is_admin), onMove: setPos });
  };
  if (p) setPos(p);
  if (me?.is_admin) m.onTap(setPos);
}
$('newItemBtn').addEventListener('click', () => editItem(null));
$('newCatBtn').addEventListener('click', () => editCategory(null));
$('newPlaceBtn').addEventListener('click', () => editPlace(null));
$('newTradeBtn').addEventListener('click', () => editTrade(null));

// ═══════════════ Bug reports ═══════════════
// From Help -> Report a problem (the team bug tracker, adapted). Every status change and note is
// in the audit log. Resolved/closed reports are deleted 90 days after closing.
const BUG_CHIP = { open: ['Open', 'pending'], in_progress: ['In progress', 'info'], resolved: ['Resolved', 'ok'], closed: ['Closed', ''] };
let bugStatus = 'open';
let bugs = [];
async function loadBugs() {
  const res = await api(`/operator/bugs${bugStatus ? `?status=${bugStatus}` : ''}`);
  if (res.error) return toast(res.error);
  bugs = res.bugs || [];
  setCount('bugs', res.counts?.open || 0);
  $('bugsCount').textContent = `${bugs.length}`;
  $('bugList').innerHTML = bugs.length ? bugs.map((b) => {
    const [chip, tone] = BUG_CHIP[b.status] || [b.status, ''];
    return `<button class="lrow" type="button" data-open="${b.id}">
      <span class="l1"><span class="mono">#${b.id}</span><span class="t">${escapeHtml(b.title)}</span></span>
      <span class="l2">${escapeHtml(b.app)} · ${b.user_id ? 'signed-in customer' : b.reporter_email ? 'visitor with email' : 'anonymous'} · ${timeAgo(b.created_at)}</span>
      <span class="side"><span class="badge ${tone}">${chip}</span></span>
    </button>`;
  }).join('') : `<div class="pane-empty"><div class="big">🐞</div>No ${bugStatus ? BUG_CHIP[bugStatus][0].toLowerCase() : ''} reports.</div>`;
  $('bugList').querySelectorAll('[data-open]').forEach((r) => r.addEventListener('click', () => openBug(r.dataset.open)));
  markSelected($('bugList'), selected.bugs);
}
$('bugFilter').querySelectorAll('[data-bugstatus]').forEach((b) => b.addEventListener('click', () => {
  bugStatus = b.dataset.bugstatus;
  $('bugFilter').querySelectorAll('[data-bugstatus]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  loadBugs();
}));
async function openBug(id) {
  selected.bugs = String(id);
  markSelected($('bugList'), selected.bugs);
  const res = await api(`/operator/bugs/${id}`);
  if (res.error) return toast(res.error);
  const b = res.bug;
  const el = $('bugDetail');
  const options = Object.entries(BUG_CHIP).map(([v, [label]]) => `<option value="${v}" ${b.status === v ? 'selected' : ''}>${label}</option>`).join('');
  el.innerHTML = `
    <div class="pane-head">${backBtn('bugsWs')}<strong class="mono">#${b.id}</strong><span class="t">${escapeHtml(b.title)}</span></div>
    <div class="pane-body">
      <div class="dsec"><h4>What happened</h4><p style="margin:0;white-space:pre-wrap;">${escapeHtml(b.description)}</p></div>
      ${b.repro_steps ? `<div class="dsec"><h4>Steps to reproduce</h4><p style="margin:0;white-space:pre-wrap;">${escapeHtml(b.repro_steps)}</p></div>` : ''}
      <div class="dsec"><h4>Context</h4><dl class="kv">
        <dt>From</dt><dd>${b.user_id ? `signed-in customer (account ${b.user_id})` : 'signed-out visitor'}${b.reporter_email ? ` · <a href="mailto:${escapeHtml(b.reporter_email)}">${escapeHtml(b.reporter_email)}</a>` : ''}</dd>
        <dt>App</dt><dd>${escapeHtml(b.app)} ${escapeHtml(b.app_version || '')} · ${escapeHtml(b.lang || '?')} · screen ${escapeHtml(b.page || '?')}</dd>
        ${b.order_id ? `<dt>Order</dt><dd><a href="#" data-goorder="${b.order_id}">#${GMIds.shortId(b.order_id)}</a></dd>` : ''}
        <dt>Device</dt><dd class="muted" style="font-size:12px;">${escapeHtml(b.user_agent || '—')}</dd>
        <dt>Filed</dt><dd>${new Date(b.created_at).toLocaleString()}</dd>
        ${b.updated_by ? `<dt>Last change</dt><dd>${escapeHtml(b.updated_by)} · ${timeAgo(b.updated_at)}</dd>` : ''}
      </dl></div>
      <div class="dsec"><h4>Triage</h4>
        <label for="bugStatusSel">Status</label><select id="bugStatusSel">${options}</select>
        <label for="bugNote">Note (for the team; not sent to the reporter)</label>
        <textarea id="bugNote" maxlength="1000">${escapeHtml(b.triage_note || '')}</textarea>
      </div>
    </div>
    <div class="pane-foot"><button id="bugSave" type="button">Save</button></div>`;
  bindBack(el);
  showDetail('bugsWs', true);
  el.querySelector('[data-goorder]')?.addEventListener('click', (e) => { e.preventDefault(); setPanel('orders'); refreshAll().then(() => openOrder(b.order_id)); });
  $('bugSave').addEventListener('click', async () => {
    const out = await api(`/operator/bugs/${b.id}`, { method: 'PATCH', body: JSON.stringify({ status: $('bugStatusSel').value, note: $('bugNote').value }) });
    if (out.error) return toast(out.error);
    toast('Saved ✓ — recorded in the audit log');
    await loadBugs();
    openBug(b.id);
  });
}

// ═══════════════ Team (admin): access requests + operators ═══════════════
// Two separate steps, on purpose: Approve records the decision; "Create account" mints the
// credential and emails them a setup code. An approved request stays here until it's done.
let requests = [];
let operators = [];
async function loadAccessRequests() {
  const res = await api('/operator/access-requests');
  if (res.error) return;
  requests = res.requests || [];
  const fresh = requests.filter((r) => r.status === 'new').length;
  $('requestCount').textContent = `${fresh} new`;
  $('requestCount').classList.toggle('hidden', fresh === 0);
  setCount('team', fresh);
  $('accessRequests').innerHTML = requests.length
    ? requests.map((r) => `<button class="lrow" type="button" data-open="req-${r.id}">
        <span class="l1"><span class="t">${escapeHtml(r.name)}</span></span>
        <span class="l2">wants to be a ${escapeHtml(r.role)} · ${timeAgo(r.created_at)}</span>
        <span class="side"><span class="badge ${r.status === 'new' ? 'pending' : r.status === 'approved' ? 'gold' : 'info'}">${escapeHtml(r.status)}</span></span>
      </button>`).join('')
    : '<div class="pane-empty">No open requests.</div>';
  $('accessRequests').querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openRequest(b.dataset.open.slice(4))));
  markSelected($('accessRequests'), selected.team);
}

function suggestUsername(name) {
  const base = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 32);
  return base.length >= 3 ? base : '';
}

function openRequest(id) {
  selected.team = `req-${id}`;
  markSelected($('accessRequests'), selected.team);
  markSelected($('operators'), selected.team);
  const r = requests.find((x) => String(x.id) === id);
  if (!r) return;
  const el = $('teamDetail');
  const approved = r.status === 'approved';
  el.innerHTML = `
    <div class="pane-head">${backBtn('teamWs')}<strong>${escapeHtml(r.name)}</strong>
      <span class="badge ${r.status === 'new' ? 'pending' : 'gold'}">${escapeHtml(r.status)}</span></div>
    <div class="pane-body">
      <div class="dsec"><h4>Request</h4><dl class="kv">
        <dt>Wants to</dt><dd>${r.role === 'driver' ? 'Deliver orders' : 'Coordinate orders and payments'}</dd>
        <dt>Name given</dt><dd>${escapeHtml(r.name)}</dd>
        ${r.blind ? '' : `<dt>Email</dt><dd>${r.email ? `<a href="mailto:${escapeHtml(r.email)}">${escapeHtml(r.email)}</a>` : '<span class="muted">none given</span>'}</dd>
        <dt>Phone</dt><dd><a href="tel:${escapeHtml(r.phone)}">${escapeHtml(r.phone)}</a></dd>`}
        <dt>Sent</dt><dd>${new Date(r.created_at).toLocaleString()}</dd>
      </dl>${r.blind
        ? '<p class="muted" style="margin:10px 0 0;">🔒 Blind review: check that the ID matches the name. Their phone, email and message stay hidden until you decide, and your decision is logged.</p>'
        : r.message ? `<p style="margin:10px 0 0;">${escapeHtml(r.message)}</p>` : ''}</div>
      <div class="dsec"><h4>ID document</h4>
        ${r.id_document_at ? `<div class="btn-row">
            <button class="secondary small" data-side="front" type="button">Show front</button>
            <button class="secondary small" data-side="back" type="button">Show back</button></div>
          <div class="muted" style="margin-top:6px;">Both sides are deleted automatically once you approve or decline.</div>
          <div id="idImg"></div>` : '<span class="muted">No ID attached.</span>'}</div>
      ${approved ? `<div class="dsec"><h4>Create the account</h4>
        ${r.role === 'operator' ? `<label for="reqUser">Username</label><input id="reqUser" value="${escapeHtml(suggestUsername(r.name))}" autocapitalize="none" spellcheck="false" />` : ''}
        <label for="reqEmail">Email for the setup code</label><input id="reqEmail" type="email" value="${escapeHtml(r.email || '')}" placeholder="name@example.com" />
      </div>` : ''}
    </div>
    <div class="pane-foot">${approved
      ? '<button id="reqAcct" type="button">Create account &amp; email setup code</button>'
      : `<button data-status="approved" type="button">Approve</button>
         <button class="danger-ghost" data-status="declined" type="button">Decline</button>`}</div>`;
  bindBack(el);
  showDetail('teamWs', true);

  // The ID is fetched on demand, not with the list: it is the most sensitive thing here.
  el.querySelectorAll('[data-side]').forEach((b) => b.addEventListener('click', async () => {
    const side = b.dataset.side;
    try {
      const resp = await fetch(GMConfig.api(`/operator/access-requests/${r.id}/id-document/${side}`), { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) return toast(`No ${side} image was uploaded.`);
      const url = URL.createObjectURL(await resp.blob());
      $('idImg').innerHTML = `<img src="${url}" alt="ID ${side}" style="max-width:100%;margin-top:8px;border-radius:8px;" />`;
    } catch { toast('Could not load the ID document.'); }
  }));
  el.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', async () => {
    const out = await api(`/operator/access-requests/${r.id}/review`, { method: 'POST', body: JSON.stringify({ status: b.dataset.status }) });
    if (out.error) return toast(out.error);
    toast(b.dataset.status === 'approved' ? 'Approved — now create their account. Their ID has been deleted.'
      : b.dataset.status === 'declined' ? 'Declined — their ID has been deleted.' : 'Updated ✓');
    await loadAccessRequests();
    if (b.dataset.status === 'declined') emptyDetail(el, '✓', 'Declined.'); else openRequest(id);
  }));
  const acct = $('reqAcct');
  if (acct) acct.addEventListener('click', async () => {
    const email = $('reqEmail').value.trim();
    if (!email) return toast('Add an email — setup codes are sent by email.');
    acct.disabled = true;
    const out = await api(`/operator/access-requests/${r.id}/account`, {
      method: 'POST',
      body: JSON.stringify({ ...($('reqUser') ? { username: $('reqUser').value.trim() } : {}), email }),
    });
    acct.disabled = false;
    if (out.error && !out.account) return toast(out.error);
    setupCodeToast(out, r.name);
    emptyDetail(el, '✓', 'Account created. They choose their own password or PIN with the emailed code.');
    refreshAll();
  });
}

async function loadOperators() {
  const res = await api('/operator/operators');
  if (res.error) return;
  operators = res.operators || [];
  $('operators').innerHTML = operators.map((o) => `<button class="lrow" type="button" data-open="op-${o.id}">
      <span class="l1"><span class="t">${escapeHtml(o.display_name)}</span>${o.id === me?.id ? '<span class="muted">you</span>' : ''}</span>
      <span class="l2">@${escapeHtml(o.username)} · ${o.last_login_at ? `last login ${timeAgo(o.last_login_at)}` : 'never signed in'}</span>
      <span class="side">${o.is_admin ? '<span class="badge gold">Admin</span>' : ''}<span class="badge ${o.active ? 'ok' : 'fail'}">${o.active ? 'Active' : 'Off'}</span></span>
    </button>`).join('');
  $('operators').querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openOperator(b.dataset.open.slice(3))));
  markSelected($('operators'), selected.team);
}
function openOperator(id) {
  selected.team = `op-${id}`;
  markSelected($('operators'), selected.team);
  markSelected($('accessRequests'), selected.team);
  const o = operators.find((x) => String(x.id) === id);
  if (!o) return;
  const self = o.id === me?.id;
  const el = $('teamDetail');
  el.innerHTML = `
    <div class="pane-head">${backBtn('teamWs')}<strong>${escapeHtml(o.display_name)}</strong>
      ${o.is_admin ? '<span class="badge gold">Admin</span>' : ''}<span class="badge ${o.active ? 'ok' : 'fail'}">${o.active ? 'Active' : 'Off'}</span></div>
    <div class="pane-body">
      <div class="dsec"><h4>Operator</h4><dl class="kv">
        <dt>Username</dt><dd>@${escapeHtml(o.username)}</dd>
        <dt>Last login</dt><dd>${o.last_login_at ? new Date(o.last_login_at).toLocaleString() : 'never'}</dd>
        <dt>Status</dt><dd>${o.setup_pending ? 'Setup code sent' : o.must_change_password ? 'Must change password' : 'Ready'}</dd>
      </dl></div>
      ${o.active && !self ? `<div class="dsec"><h4>${o.setup_pending ? 'Re-send setup code' : 'Reset password'}</h4>
        <label for="opCodeEmail">Email${o.has_email ? ' (leave blank to use the one on file)' : ''}</label>
        <input id="opCodeEmail" type="email" placeholder="${o.has_email ? 'on file' : 'name@example.com'}" />
        <button class="secondary" id="opCode" type="button">Email a setup code</button></div>` : ''}
      ${self ? '<div class="dsec muted">This is you. You can’t deactivate or demote yourself.</div>' : ''}
    </div>
    ${self ? '' : `<div class="pane-foot">
      ${o.active ? `<button class="secondary" id="opAdmin" type="button">${o.is_admin ? 'Remove admin' : 'Make admin'}</button>` : ''}
      <button class="${o.active ? 'danger-ghost' : ''}" id="opActive" type="button">${o.active ? 'Deactivate' : 'Reactivate'}</button></div>`}`;
  bindBack(el);
  showDetail('teamWs', true);
  const reload = async () => { await loadMe(); await loadOperators(); openOperator(id); };
  const code = $('opCode');
  if (code) code.addEventListener('click', async () => {
    const email = $('opCodeEmail').value.trim();
    const out = await api(`/operator/staff/operator/${o.id}/setup-code`, { method: 'POST', body: JSON.stringify(email ? { email } : {}) });
    setupCodeToast(out, o.display_name);
    reload();
  });
  const adm = $('opAdmin');
  if (adm) twoTap(adm, 'Tap again to confirm', async () => {
    const out = await api(`/operator/operators/${o.id}/admin`, { method: 'POST', body: JSON.stringify({ admin: !o.is_admin }) });
    if (out.error) return toast(out.error);
    toast('Updated ✓');
    reload();
  });
  const act = $('opActive');
  if (act) twoTap(act, 'Tap again to confirm', async () => {
    const out = await api(`/operator/operators/${o.id}/active`, { method: 'POST', body: JSON.stringify({ active: !o.active }) });
    if (out.error) return toast(out.error);
    toast('Updated ✓');
    reload();
  });
}
$('newOperatorBtn').addEventListener('click', () => {
  selected.team = null;
  markSelected($('operators'), null);
  markSelected($('accessRequests'), null);
  const el = $('teamDetail');
  el.innerHTML = `
    <div class="pane-head">${backBtn('teamWs')}<strong>Add an operator</strong></div>
    <div class="pane-body"><div class="dsec">
      <p class="muted" style="margin:0 0 8px;">They get a setup code by email and choose their own password. An operator sees every customer’s phone, address and chat — only add people you know.</p>
      <label for="oName">Name</label><input id="oName" autocomplete="off" />
      <label for="oUsername">Username</label><input id="oUsername" autocapitalize="none" spellcheck="false" />
      <label for="oPhone">Phone (for reference)</label><input id="oPhone" type="tel" placeholder="61 234 5678" />
      <div class="phone-hint muted" id="oPhoneHint"></div>
      <label for="oEmail">Email — the setup code goes here</label><input id="oEmail" type="email" placeholder="name@example.com" />
    </div></div>
    <div class="pane-foot"><button id="addOperator" type="button">Create &amp; email setup code</button></div>`;
  bindBack(el);
  if (window.SomPhone) SomPhone.attach({ input: $('oPhone'), hint: $('oPhoneHint') });
  showDetail('teamWs', true);
  // Suggest a username from the name, until the admin types their own.
  $('oName').addEventListener('input', () => { if (!$('oUsername').dataset.touched) $('oUsername').value = suggestUsername($('oName').value); });
  $('oUsername').addEventListener('input', () => { $('oUsername').dataset.touched = '1'; });
  $('addOperator').addEventListener('click', async () => {
    const displayName = $('oName').value.trim();
    const username = $('oUsername').value.trim();
    const phone = SomPhone.e164Of($('oPhone')) || $('oPhone').value.trim();
    const email = $('oEmail').value.trim();
    if (!displayName || !username || !phone || !email) return toast('Name, username, phone and email are all needed.');
    const res = await api('/operator/operators', { method: 'POST', body: JSON.stringify({ username, displayName, phone, email }) });
    if (res.error && !res.account) return toast(res.error);
    setupCodeToast(res, displayName);
    await loadOperators();
    if (res.account?.id) openOperator(String(res.account.id));
  });
});

// ═══════════════ Audit log (admin, read-only) ═══════════════
// Append-only in the database: this screen can only ever show it, never change it.
const AUDIT_TEXT = {
  'payment.confirmed': 'Payment confirmed', 'payment.unmatched': 'Payment could not be matched',
  'order.dispatched': 'Order dispatched', 'order.failed': 'Order failed', 'delivery.checked': 'Delivery checked',
  'refund.settled': 'Refund recorded as paid', 'refund.waived': 'Refund closed — nothing owed',
  'access.reviewed': 'Access request decided', 'staff.created': 'Staff account created',
  'staff.active': 'Staff activated / deactivated', 'staff.admin': 'Admin rights changed',
};
async function loadAudit() {
  const res = await api('/operator/audit');
  if (res.error) return;
  const who = (a) => escapeHtml(String(a).replace(/^operator:\d+:/, '').replace(/^system:/, '⚙ '));
  $('auditList').innerHTML = (res.entries || []).map((e) => {
    const d = e.detail || {};
    const bits = Object.entries(d).filter(([, v]) => v !== null && v !== '').map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`).join(' · ');
    return `<div class="lrow" style="cursor:default;">
      <span class="l1"><span class="t">${AUDIT_TEXT[e.action] || escapeHtml(e.action)}</span><span class="mono">${escapeHtml(e.subject || '')}</span></span>
      <span class="l2">${who(e.actor)}${bits ? ` · ${bits}` : ''}</span>
      <span class="side"><span class="muted" style="font-size:12px;">${new Date(e.at).toLocaleString()}</span></span>
    </div>`;
  }).join('') || '<div class="pane-empty">Nothing recorded yet.</div>';
}

// ═══════════════ Account ═══════════════
$('changePw').addEventListener('click', async () => {
  const currentPassword = $('pwCurrent').value;
  const newPassword = $('pwNew').value;
  if (!currentPassword || !newPassword) return toast('Fill in both password fields.');
  const res = await api('/operator/me/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
  if (res.error) return toast(res.error);
  $('pwCurrent').value = ''; $('pwNew').value = '';
  toast('Password changed ✓');
  loadMe();
});

// ═══════════════ Health + live updates ═══════════════
// Event-relay backlog. Silent while healthy — an always-on badge trains people to ignore it.
async function pollOutbox() {
  const res = await api('/operator/outbox');
  const b = $('outboxBadge');
  if (res.error) return b.classList.add('hidden');
  const stuck = res.pending > 20 || res.oldest_pending_seconds > 30 || res.parked > 0;
  b.classList.toggle('hidden', !stuck);
  if (stuck) {
    b.textContent = res.parked > 0 ? `Events: ${res.parked} PARKED` : `Events: ${res.pending} behind (${res.oldest_pending_seconds}s)`;
    setStatus(res.parked > 0
      ? `⚠ ${res.parked} event(s) could not be delivered — clients may show stale state.`
      : `⚠ Event relay is ${res.oldest_pending_seconds}s behind — live updates are delayed.`, 'down');
  }
}

let ws;
function connectSocket() {
  ws = new WebSocket(GMConfig.wsUrl());
  // Authenticate in the first frame, then subscribe (subscribe_operator is role-gated).
  ws.onopen = () => { ws.send(JSON.stringify({ type: 'auth', token })); };
  ws.onclose = () => { if (token) setTimeout(connectSocket, 2500); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'authenticated') return ws.send(JSON.stringify({ type: 'subscribe_operator' }));
    if (m.type === 'auth_error') return logout();
    if (m.type === 'driver_location') return onDriverLocation(m);
    if (m.type === 'payment_attempt') {
      if (m.status === 'unknown') setStatus(`⚠ Wallet payment for order #${GMIds.shortId(m.orderId)} could not be confirmed — check the merchant account.`, 'warn');
      return;
    }
    if (m.type === 'message') {
      if (selected.orders && String(m.orderId) === String(selected.orders) && m.message) appendThread(m.message);
      // A customer's "I didn't get it" lands as a system line; the review queue must show it.
      if (m.message?.sender === 'system' && /did not get this order/.test(m.message.body || '')) {
        setStatus(`⚠ Customer says order #${GMIds.shortId(m.orderId)} never arrived — see Deliveries.`, 'warn');
        loadDeliveries();
      }
      return;
    }
    if (m.type === 'payment_claimed') {
      const via = m.walletName ? ` with ${m.walletName}` : '';
      setStatus(`💰 Customer says they paid order #${GMIds.shortId(m.orderId)}${via}${m.reference ? ` (ref ${m.reference})` : ''} — check the merchant phone.`, 'warn');
      toast('A customer says they have paid — check the merchant phone.');
    } else if (m.type === 'order_created') {
      setStatus(`New order #${GMIds.shortId(m.orderId)} — awaiting payment.`, 'warn');
    } else if (m.type === 'payment_confirmed') {
      setStatus(`Payment confirmed on order #${GMIds.shortId(m.orderId)} (${money(m.amount)}).`, 'ok');
    } else if (m.type === 'order_state') {
      setStatus(`Order #${GMIds.shortId(m.orderId)}: ${STATUS_LABEL[m.to] || m.to}.`, m.to === 'FAILED_REFUND' ? 'down' : 'info');
      if (selected.orders === m.orderId) loadOrderTimeline(m.orderId);
    } else {
      return;
    }
    refreshAll();
  };
}

// ── Push notifications (payments to check, disputes, requests) ──
const OP_PUSH_TEXT = {
  on: 'On — this computer is notified.', off: 'Off.', denied: 'Blocked in the browser settings for this site.',
  unavailable: 'Not set up on the server (VAPID keys).', unsupported: 'This browser cannot receive notifications.',
};
async function renderOpPush() {
  const st = await GMPush.state();
  $('opPushStatus').textContent = OP_PUSH_TEXT[st] || st;
  $('opPushToggle').textContent = st === 'on' ? 'Turn off' : 'Turn on';
  $('opPushToggle').disabled = ['denied', 'unavailable', 'unsupported'].includes(st);
}
$('opPushToggle').addEventListener('click', async () => {
  try {
    if ((await GMPush.state()) === 'on') await GMPush.disable(api);
    else { await GMPush.enable(api); toast('Notifications on ✓'); }
  } catch (e) { toast(e.message === 'denied' ? 'The browser blocked notifications.' : 'Could not turn notifications on.'); }
  renderOpPush();
});
function openFromUrl(href) {
  let u;
  try { u = new URL(href, location.origin); } catch { return; }
  const bug = u.searchParams.get('bug');
  if (bug) { setPanel('bugs'); openBug(bug); return; }
  const id = u.searchParams.get('order');
  setPanel('orders');
  if (id) { refreshAll().then(() => openOrder(id)); }
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'gm:open') openFromUrl(e.data.url); });
}

if (token) showDash().then(() => {
  if (new URLSearchParams(location.search).has('order')) { openFromUrl(location.href); history.replaceState(null, '', location.pathname); }
  const bugId = new URLSearchParams(location.search).get('bug');
  if (bugId) { setPanel('bugs'); openBug(bugId); history.replaceState(null, '', location.pathname); }
});

// ── Service worker ──
// Registered here rather than in an inline <script> so the page can run under a strict
// Content-Security-Policy (script-src 'self'), which is what blocks injected script.
// Skipped in the native shell: Capacitor bundles the assets into the APK.
if ('serviceWorker' in navigator && !GMConfig.isNative()) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/operator/sw.js'));
}
