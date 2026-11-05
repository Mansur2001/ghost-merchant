// Operator PWA — the dispatch desk. Nothing reads payment receipts automatically: the operator
// checks the merchant phone and confirms each payment here, so "Confirm payment" is the step
// every order passes through. Customers who tap "I've paid" are surfaced first.
//
// Layout: every section is a list (left) and a detail panel (right) for the selected item.
// The page never scrolls; each pane does. Lists redraw on every live event, the detail panel
// only when ITS item changes — so a half-typed reference or a picked driver is never wiped.

const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem('opToken') || null;
let me = null; // the signed-in operator

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
  account: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
};
const SECTIONS = [
  ['orders', 'Orders'], ['deliveries', 'Deliveries'], ['refunds', 'Refunds'],
  ['drivers', 'Drivers'], ['team', 'Team', 'admin'], ['account', 'Account'],
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
}
function setCount(id, n) {
  if ((counts[id] || 0) === n) return;
  counts[id] = n;
  renderNav();
}
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => setPanel(b.dataset.goto)));

// List + detail plumbing: which item is open in each section, and the phone-width toggle.
const selected = { orders: null, deliveries: null, refunds: null, drivers: null, team: null };
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

function logout() { sessionStorage.removeItem('opToken'); token = null; location.reload(); }
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
  ['orderDetail', 'deliveryDetail', 'refundDetail', 'driverDetail', 'teamDetail'].forEach((id) =>
    emptyDetail($(id), '👈', 'Select an item on the left.'));
  refreshAll();
  connectSocket();
  setInterval(pollOutbox, 20000);
  pollOutbox();
}

// Resolve who we are from the token. Also catches an account deactivated while the tab sat
// open — the server answers 401 and we bounce to login.
async function loadMe() {
  const res = await api('/operator/me');
  if (res.error || !res.operator) return logout();
  me = res.operator;
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
      ? 'Getting started: add a driver under <strong>Drivers</strong>. Until there is one, paid orders can’t be dispatched.'
      : 'Getting started: ask an admin to add a driver. Until there is one, paid orders can’t be dispatched.';
  } else if (orderCount === 0) {
    msg = 'Ready. Place a test order from the customer app to watch it come through.';
  }
  el.innerHTML = msg;
  el.classList.toggle('hidden', !msg);
}

let drivers = []; // roster with workload stats, kept fresh for the assign picker

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
  PENDING_PAYMENT: ['Awaiting payment', 'pending'], PAID_UNASSIGNED: ['Needs a driver', 'gold'],
  DISPATCHED: ['Driver at market', 'info'], IN_TRANSIT: ['On the way', 'info'],
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
  ['Needs a driver', (o) => o.status === 'PAID_UNASSIGNED'],
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
    ['Needs a driver', n((o) => o.status === 'PAID_UNASSIGNED'), 'gold'],
    ['On the road', n(FILTERS.road), ''],
  ].map(([k, v, tone]) => `<div class="kpi ${v ? tone : ''}"><span class="k-label">${k}</span><span class="k-value">${v}</span></div>`).join('');
  setCount('orders', n(isClaimed) + n((o) => o.status === 'PAID_UNASSIGNED'));
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
    : `${o.driver_name ? `🛵 ${escapeHtml(o.driver_name)} · ` : ''}${timeAgo(o.created_at)}`;
  return `<button class="lrow" type="button" data-open="${o.id}">
      <span class="l1"><span class="mono">#${GMIds.shortId(o.id)}</span><span class="t">${escapeHtml(o.landmark_text || '—')}</span></span>
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

function driverOptions(current) {
  const opts = drivers.filter((d) => d.active && !d.setup_pending).map((d) =>
    `<option value="${d.id}" ${String(d.id) === String(current) ? 'selected' : ''}>${escapeHtml(d.name)}${d.active_orders > 0 ? ` (${d.active_orders} active)` : ''}</option>`);
  return `<option value="">Choose a driver…</option>${opts.join('')}`;
}

function renderOrderDetail(o) {
  const el = $('orderDetail');
  el.dataset.key = orderKey(o);
  const [chip, tone] = STATUS_CHIP[o.status] || [o.status, ''];
  const items = (o.items || []).map((it) => escapeHtml(it.text || '')).filter(Boolean).join(', ') || '—';
  const map = o.lat != null && o.lng != null
    ? `<a href="https://www.openstreetmap.org/?mlat=${o.lat}&mlon=${o.lng}#map=18/${o.lat}/${o.lng}" target="_blank" rel="noopener">Open map ↗</a>`
    : '<span class="muted">No GPS pin — landmark only</span>';

  let action = '';
  if (o.status === 'PENDING_PAYMENT') {
    action = `<div class="dsec"><h4>Confirm payment</h4>
      ${isClaimed(o) ? `<div class="callout" style="margin-bottom:10px;"><strong>💰 Customer says they paid${o.claim_wallet
        ? ` with ${escapeHtml(o.claim_wallet.name)} — check ${escapeHtml(o.claim_wallet.merchant)}` : ''}</strong>
        <div class="muted">${o.payment_claim_ref ? `Ref ${escapeHtml(o.payment_claim_ref)} · ` : ''}${timeAgo(o.payment_claimed_at)}</div></div>`
        : '<p class="muted" style="margin:0 0 8px;">The customer hasn’t said they paid yet.</p>'}
      <label for="payref-${o.id}">Transaction number from the merchant phone</label>
      <input id="payref-${o.id}" data-payref="${o.id}" value="${escapeHtml(o.payment_claim_ref || '')}" autocapitalize="characters" spellcheck="false" />
      <button data-confirm="${o.id}">Confirm ${money(o.total_amount)} received</button></div>`;
  } else if (['PAID_UNASSIGNED', 'DISPATCHED', 'IN_TRANSIT'].includes(o.status)) {
    const re = o.status !== 'PAID_UNASSIGNED';
    action = `<div class="dsec"><h4>${re ? 'Driver' : 'Assign a driver'}</h4>
      ${re ? `<p class="muted" style="margin:0 0 8px;">With ${escapeHtml(o.driver_name || 'a driver')}.${o.status === 'IN_TRANSIT' ? ' ✓ Items photographed at pickup.' : ''}</p>` : ''}
      <select data-assign="${o.id}">${driverOptions(re ? o.driver_id : null)}</select>
      <button data-assignbtn="${o.id}" ${re ? 'class="secondary"' : ''}>${re ? 'Reassign' : 'Assign'}</button></div>`;
  }

  el.innerHTML = `
    <div class="pane-head">${backBtn('ordersWs')}<strong class="mono">#${GMIds.shortId(o.id)}</strong>
      <span class="badge ${tone}">${chip}</span><span class="grow"></span><strong>${money(o.total_amount)}</strong></div>
    <div class="pane-body">
      ${action}
      <div class="dsec"><h4>Customer</h4><dl class="kv">
        <dt>Driver calls</dt><dd><a href="tel:${escapeHtml(o.user_phone)}">${escapeHtml(o.user_phone)}</a></dd>
        <dt>Landmark</dt><dd>${escapeHtml(o.landmark_text || '—')}</dd>
        <dt>Location</dt><dd>${map}</dd>
        <dt>Items</dt><dd>${items}</dd>
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
      if (!reference && confirm.dataset.noref !== '1') {
        confirm.dataset.noref = '1';
        confirm.textContent = 'Confirm WITHOUT a transaction number?';
        return toast('Adding the transaction number stops one payment being used for two orders.');
      }
      confirm.disabled = true;
      const res = await api(`/operator/orders/${o.id}/mark-paid`, { method: 'POST', body: JSON.stringify({ reference }) });
      confirm.disabled = false;
      if (res.error) return toast(res.error);
      toast('Payment confirmed ✓ — the customer sees it now');
      refreshAll();
    });
  }
  const assign = el.querySelector('[data-assignbtn]');
  if (assign) {
    assign.addEventListener('click', async () => {
      const driverId = el.querySelector('[data-assign]').value;
      if (!driverId) return toast('Pick a driver first.');
      assign.disabled = true;
      const res = await api(`/operator/orders/${o.id}/assign`, { method: 'POST', body: JSON.stringify({ driverId }) });
      assign.disabled = false;
      if (res.error) return toast(res.error);
      toast('Driver assigned ✓');
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
      ${open ? `<div class="dsec"><h4>Record it</h4>
        <label for="rfRef">Reference of the money you sent back</label>
        <input id="rfRef" autocapitalize="characters" spellcheck="false" />
        <label for="rfNote">Note (required for “Nothing owed”)</label>
        <input id="rfNote" /></div>` : ''}
    </div>
    ${open ? `<div class="pane-foot"><button id="rfSettle" type="button">Mark refunded</button>
      <button class="secondary" id="rfWaive" type="button">Nothing owed</button></div>` : ''}`;
  bindBack(el);
  showDetail('refundsWs', true);
  if (!open) return;
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
        <span class="l1"><span class="t">${escapeHtml(d.name)}</span></span>
        <span class="l2">${escapeHtml(d.msisdn)} · ${d.active_orders} active · ${d.delivered_orders} delivered</span>
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
        <dt>Now</dt><dd>${d.active_orders} active</dd>
        <dt>All time</dt><dd>${d.delivered_orders} delivered</dd>
      </dl></div>
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
        <dt>Email</dt><dd>${r.email ? `<a href="mailto:${escapeHtml(r.email)}">${escapeHtml(r.email)}</a>` : '<span class="muted">none given</span>'}</dd>
        <dt>Phone</dt><dd><a href="tel:${escapeHtml(r.phone)}">${escapeHtml(r.phone)}</a></dd>
        <dt>Sent</dt><dd>${new Date(r.created_at).toLocaleString()}</dd>
      </dl>${r.message ? `<p style="margin:10px 0 0;">${escapeHtml(r.message)}</p>` : ''}</div>
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
      : `<button class="secondary" data-status="contacted" type="button">Contacted</button>
         <button data-status="approved" type="button">Approve</button>
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

if (token) showDash();

// ── Service worker ──
// Registered here rather than in an inline <script> so the page can run under a strict
// Content-Security-Policy (script-src 'self'), which is what blocks injected script.
// Skipped in the native shell: Capacitor bundles the assets into the APK.
if ('serviceWorker' in navigator && !GMConfig.isNative()) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/operator/sw.js'));
}
