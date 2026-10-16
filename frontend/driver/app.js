// Driver PWA logic. Lightweight per SRS 6: PIN login, shopping list, one-tap geo: nav,
// one-tap tel: call, out-of-stock/price adjustments, and state-machine actions.

const $ = (id) => document.getElementById(id);
const t = GMI18n.t;
let token = sessionStorage.getItem('driverToken') || null;
let current = null; // current order detail

const label = (s) => t(`drv.st.${s}`);
const STATUS_KIND = {
  PAID_UNASSIGNED: 'ok', DISPATCHED: 'info', IN_TRANSIT: 'info',
  DELIVERED: 'ok', FAILED_REFUND: 'down',
};
// Status bar becomes available once the driver is working an order.
function setStatus(orderId, status) {
  $('statusbar').classList.remove('hidden');
  $('sbText').textContent = `#${GMIds.shortId(orderId)}: ${label(status)}`;
  $('sbTime').textContent = new Date().toLocaleTimeString();
  $('statusbar').className = 'statusbar ' + (STATUS_KIND[status] || '');
}

// Live Somali-number hint on the login field.
if (window.SomPhone) SomPhone.attach({ input: $('msisdn'), hint: $('phoneHint') });

// A rejected fetch means the request never got an answer (offline, DNS, timeout) — that is
// categorically different from the server saying no, and the queue treats it differently.
const api = (path, opts = {}) =>
  fetch(GMConfig.api(path), {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  })
    .then((r) => r.json())
    .catch(() => ({ error: 'No connection.', offline: true }));

// ── Login ──
$('loginBtn').addEventListener('click', async () => {
  // The full number the country switch produced ("206 687 6538" alone isn't one).
  const msisdn = SomPhone.e164Of($('msisdn')) || $('msisdn').value.trim();
  const pin = $('pin').value.trim();
  const res = await api('/driver/login', { method: 'POST', body: JSON.stringify({ msisdn, pin }) });
  if (res.error) return toast(GMI18n.err(res.error));
  token = res.token;
  sessionStorage.setItem('driverToken', token);
  showQueue();
});

// ── Set up the account an admin created ──
if (window.SomPhone) SomPhone.attach({ input: $('sPhone'), hint: $('sPhoneHint') });
$('showSetup').addEventListener('click', () => {
  $('loginView').classList.add('hidden');
  $('setupView').classList.remove('hidden');
});
$('setupBack').addEventListener('click', () => {
  $('setupView').classList.add('hidden');
  $('loginView').classList.remove('hidden');
});
$('setupBtn').addEventListener('click', async () => {
  const phone = SomPhone.e164Of($('sPhone')) || $('sPhone').value.trim();
  const code = $('sCode').value.trim();
  const pin = $('sPin').value.trim();
  if (!phone || !/^\d{8}$/.test(code)) return toast(t('drv.setup.err.code'));
  if (pin !== $('sPin2').value.trim()) return toast(t('drv.setup.err.match'));
  $('setupBtn').disabled = true;
  const res = await api('/staff/setup', {
    method: 'POST',
    body: JSON.stringify({ role: 'driver', phone, code, secret: pin }),
  });
  $('setupBtn').disabled = false;
  if (res.error) { $('setupHint').textContent = GMI18n.err(res.error); return; }
  // Straight in with the PIN they just chose.
  const login = await api('/driver/login', { method: 'POST', body: JSON.stringify({ msisdn: phone, pin }) });
  $('sCode').value = ''; $('sPin').value = ''; $('sPin2').value = '';
  if (login.error) { $('setupView').classList.add('hidden'); $('loginView').classList.remove('hidden'); return; }
  token = login.token;
  sessionStorage.setItem('driverToken', token);
  $('setupView').classList.add('hidden');
  toast(t('drv.setup.ok'));
  showQueue();
});

$('refreshBtn').addEventListener('click', loadQueue);
$('backBtn').addEventListener('click', showQueue);

// ── Offline queue plumbing ──
// Replays queued writes through the same authenticated transport the app uses live. For a
// state transition we also report the order's CURRENT status, so the policy can recognise a
// replay that already landed instead of calling it a conflict.
async function sendQueued(item) {
  const res = await fetch(GMConfig.api(item.path), {
    method: item.method,
    headers: {
      'Content-Type': item.contentType,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: item.body,
  });
  let currentStatus = null;
  if (res.status === 409 && item.orderId) {
    try {
      const look = await fetch(GMConfig.api(`/driver/orders/${item.orderId}`), {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json());
      currentStatus = look?.order?.status || null;
    } catch { /* leave null: the policy then treats 409 as a real conflict */ }
  }
  return { status: res.status, currentStatus };
}

function flushQueue() {
  if (!token || !navigator.onLine) return;
  GMQueue.flush(sendQueued).then(({ sent }) => {
    if (sent > 0) { loadQueue(); if (current) openDetail(current.id); }
  });
}

let lastSyncStats = null;
function renderSyncState(stats) {
  const el = $('syncState');
  if (!el) return;
  lastSyncStats = stats;
  const d = GMSync.describe(stats);
  el.textContent = d.tone === 'error' ? t('sync.failed', { n: stats.failed })
    : d.tone === 'pending' ? t('sync.pending', { n: stats.pending }) : '';
  el.className = 'sync-state ' + d.tone;
  el.classList.toggle('hidden', d.tone === 'ok');
}

window.addEventListener('online', flushQueue);
setInterval(flushQueue, 15000);

function showQueue() {
  $('loginView').classList.add('hidden');
  $('detailView').classList.add('hidden');
  $('queueView').classList.remove('hidden');
  // Status bar is shown whenever the driver is signed in.
  $('statusbar').classList.remove('hidden');
  $('statusbar').className = 'statusbar ok';
  $('sbText').textContent = t('drv.signedIn');
  $('sbTime').textContent = new Date().toLocaleTimeString();
  $('logoutBtn').classList.remove('hidden');
  loadQueue();
  connectSocket();
  GMQueue.onChange(renderSyncState);
  flushQueue();
}

// Logout: drop the session token and return to the PIN login screen.
$('logoutBtn').addEventListener('click', () => {
  // The queue holds THIS driver's writes; leaving them for the next person to sign in would
  // replay someone else's actions under a new identity.
  GMQueue.clear();
  sessionStorage.removeItem('driverToken');
  token = null;
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  location.reload();
});

async function loadQueue() {
  const res = await api('/driver/queue');
  if (res.error) { sessionStorage.removeItem('driverToken'); token = null; return location.reload(); }
  const orders = res.orders || [];
  $('queue').innerHTML = orders.length
    ? orders.map((o) => `
      <div class="card" style="background:var(--panel-2);cursor:pointer" data-id="${o.id}">
        <div class="row" style="align-items:center;">
          <div><strong>#${GMIds.shortId(o.id)}</strong> · $${Number(o.total_amount).toFixed(2)}</div>
          <span class="badge ${o.status === 'PAID_UNASSIGNED' ? 'paid' : 'pending'}">${label(o.status)}</span>
        </div>
        <div class="muted">${o.landmark_text || ''}</div>
      </div>`).join('')
    : `<p class="muted">${t('drv.none')}</p>`;
  $('queue').querySelectorAll('[data-id]').forEach((el) =>
    el.addEventListener('click', () => openDetail(el.dataset.id))
  );
}

async function openDetail(id) {
  const res = await api(`/driver/orders/${id}`);
  if (res.error) return toast(GMI18n.err(res.error));
  current = res.order;
  $('queueView').classList.add('hidden');
  $('detailView').classList.remove('hidden');
  $('dOrderId').textContent = GMIds.shortId(current.id);
  $('dStatus').textContent = label(current.status);
  $('dBudget').textContent = Number(current.total_amount).toFixed(2);
  $('dLandmark').textContent = current.landmark_text || t('drv.noLandmark');
  $('dItems').innerHTML = (current.items || [])
    .map((it) => `<div>• ${it.text || JSON.stringify(it)}${it.price ? ` — $${it.price}` : ''}</div>`)
    .join('') || `<div class="muted">${t('drv.noItems')}</div>`;

  // geo: link triggers the driver's own OS-native map app (zero Google dependency).
  if (current.lat != null && current.lng != null) {
    $('navLink').setAttribute('href', `geo:${current.lat},${current.lng}?q=${current.lat},${current.lng}`);
    $('navLink').classList.remove('hidden');
  } else {
    $('navLink').classList.add('hidden');
  }
  // tel: link for the final-100m call.
  $('callLink').setAttribute('href', `tel:${current.user_phone}`);

  setStatus(current.id, current.status);
  renderActions();
  loadPhotos(current.id);
}

// ── Photos: view the customer's reference photo, add a delivery-proof photo ──
async function loadPhotos(orderId) {
  try {
    const { photos } = await api(`/orders/${orderId}/photos`);
    const el = $('dPhotos');
    if (!photos || !photos.length) { el.innerHTML = `<span class="muted">${t('photos.none')}</span>`; return; }
    // Photo bytes are authorized, so a bare <img src> gets a 401 — fetch with the bearer
    // token and render from an object URL.
    el.innerHTML = photos.map((p) => `
      <figure class="photo">
        <img data-src="${p.url}" alt="${p.kind}" loading="lazy" />
        <figcaption class="muted">${p.kind === 'delivery_proof' ? t('photo.proof') : t('photo.ref')}</figcaption>
      </figure>`).join('');
    el.querySelectorAll('img[data-src]').forEach(async (img) => {
      try {
        const r = await fetch(GMConfig.base + img.dataset.src, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return;
        const url = URL.createObjectURL(await r.blob());
        img.src = url;
        img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
      } catch { /* leave the placeholder */ }
    });
  } catch { /* ignore */ }
}
$('proofBtn').addEventListener('click', async () => {
  const file = $('proofPhoto').files[0];
  if (!file) return toast(t('drv.proof.choose'));
  if (!current) return;
  try {
    // Raw bytes (not JSON), so bypass the JSON api() helper but keep the auth token.
    const r = await fetch(GMConfig.api(`/driver/orders/${current.id}/delivery-proof`), {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', Authorization: `Bearer ${token}` },
      body: file,
    });
    if (!r.ok) throw new Error('upload failed');
    $('proofPhoto').value = '';
    await loadPhotos(current.id);
    toast(t('drv.proof.ok'));
  } catch { toast(t('drv.proof.fail')); }
});

function renderActions() {
  const s = current.status;
  const btns = [];
  // No "Accept" button: dispatch is operator-driven, so a driver never self-claims an order.
  // A PAID_UNASSIGNED order can't reach this screen anyway — the queue only returns orders
  // already assigned to this driver.
  if (s === 'DISPATCHED') btns.push([t('drv.act.secured'), 'secured', '']);
  if (s === 'IN_TRANSIT') btns.push([t('drv.act.delivered'), 'delivered', '']);
  if (['DISPATCHED', 'IN_TRANSIT'].includes(s))
    btns.push([t('drv.act.failed'), 'failed', 'danger']);
  $('actions').innerHTML = btns
    .map(([label, action, cls]) => `<button class="${cls}" data-action="${action}">${label}</button>`)
    .join('') || `<p class="muted">${t('drv.act.none')}</p>`;
  $('actions').querySelectorAll('[data-action]').forEach((b) =>
    b.addEventListener('click', () => doAction(b.dataset.action))
  );
}

// The state a given action moves the order to. Needed so the sync policy can tell "this
// already landed, the response was just lost" from a real conflict.
const ACTION_TARGET = {
  secured: 'IN_TRANSIT',
  delivered: 'DELIVERED',
  failed: 'FAILED_REFUND',
};

async function doAction(action) {
  const body = action === 'failed' ? JSON.stringify({ reason: 'driver reported failure' }) : undefined;
  const path = `/driver/orders/${current.id}/${action}`;
  const target = ACTION_TARGET[action];

  // Offline: queue it and move the UI anyway. A driver standing in a dead zone has finished
  // the delivery — the app must not make them wait for a bar of signal to say so.
  if (!navigator.onLine) {
    await GMQueue.enqueue({
      method: 'POST', path, body: body || null,
      label: action === 'delivered' ? 'Mark delivered'
        : action === 'secured' ? 'Items secured' : 'Report failure',
      orderId: current.id, transitionTo: target,
    });
    applyOptimistic(target);
    return toast(t('drv.saved'));
  }

  const res = await api(path, { method: 'POST', body });
  if (res.error) {
    // The request left the phone but got no answer: queue rather than lose the action.
    if (res.offline) {
      await GMQueue.enqueue({
        method: 'POST', path, body: body || null,
        label: action, orderId: current.id, transitionTo: target,
      });
      applyOptimistic(target);
      return toast(t('drv.saved'));
    }
    return toast(GMI18n.err(res.error));
  }
  current = res.order;
  $('dStatus').textContent = label(current.status);
  setStatus(current.id, current.status);
  renderActions();
  toast(t('drv.updated'));
}

// Move the local view forward before the server has confirmed. The server is still the
// authority — if it later rejects, the queue surfaces "couldn't sync" rather than pretending.
function applyOptimistic(status) {
  if (!current || !status) return;
  current.status = status;
  $('dStatus').textContent = `${label(status)} ${t('drv.waiting')}`;
  setStatus(current.id, status);
  renderActions();
}

$('adjustBtn').addEventListener('click', async () => {
  const note = $('adjustNote').value.trim();
  if (!note) return toast(t('drv.adjust.err'));
  const res = await api(`/driver/orders/${current.id}/adjust`, {
    method: 'POST',
    body: JSON.stringify({ items: current.items, note }),
  });
  if (res.error) return toast(GMI18n.err(res.error));
  $('adjustNote').value = '';
  toast(t('drv.adjust.ok'));
});

// ── Socket: refresh queue on any new order/state change ──
let ws;
function connectSocket() {
  if (ws) return;
  ws = new WebSocket(GMConfig.wsUrl());
  // The token goes in the first frame (a browser can't set handshake headers, and a token in
  // the query string lands in every access log). Subscribing happens only once the server
  // has confirmed the session.
  ws.onopen = () => { $('liveDot').classList.add('on'); ws.send(JSON.stringify({ type: 'auth', token })); };
  ws.onclose = () => { $('liveDot').classList.remove('on'); ws = null; if (token) setTimeout(connectSocket, 2500); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'authenticated') {
      // A driver's own feed — events for the orders assigned to THIS driver. Replaces the
      // old subscribe_operator, which handed every driver the whole system's traffic.
      ws.send(JSON.stringify({ type: 'subscribe_driver' }));
      return;
    }
    if (m.type === 'auth_error') {
      sessionStorage.removeItem('driverToken');
      token = null;
      return location.reload();
    }
    // Live-update the status bar for the order the driver is currently working.
    if (m.type === 'order_state' && current && String(m.orderId) === String(current.id)) {
      current.status = m.to;
      $('dStatus').textContent = label(m.to);
      setStatus(current.id, m.to);
      renderActions();
    }
    if ((m.type === 'order_created' || m.type === 'order_state' || m.type === 'payment_confirmed') && !$('queueView').classList.contains('hidden')) {
      loadQueue();
    }
  };
}

// Language switch: static text is redone by GMI18n.apply(); redraw what this script drew.
document.addEventListener('gm:lang', () => {
  $('msisdn').dispatchEvent(new Event('input'));
  $('sPhone').dispatchEvent(new Event('input'));
  if (lastSyncStats) renderSyncState(lastSyncStats);
  if (!token) return;
  if (current && !$('detailView').classList.contains('hidden')) openDetail(current.id);
  else { $('sbText').textContent = t('drv.signedIn'); loadQueue(); }
});

let toastTimer;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3000);
}

// Auto-resume session.
if (token) showQueue();

// ── Service worker ──
// Registered here rather than in an inline <script> so the page can run under a strict
// Content-Security-Policy (script-src 'self'), which is what blocks injected script.
// Skipped in the native shell: Capacitor bundles the assets into the APK, so a service
// worker would be a second, stale copy of the app competing with the real one.
if ('serviceWorker' in navigator && !GMConfig.isNative()) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/driver/sw.js'));
}
