// Driver PWA logic. Lightweight per SRS 6: PIN login, shopping list, one-tap geo: nav,
// one-tap tel: call, out-of-stock/price adjustments, and state-machine actions.

const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem('driverToken') || null;
let current = null; // current order detail

const LABELS = {
  PAID_UNASSIGNED: 'Ready to accept', DISPATCHED: 'Heading to market',
  IN_TRANSIT: 'Delivering to customer', DELIVERED: 'Delivered', FAILED_REFUND: 'Failed / refund',
};
const STATUS_KIND = {
  PAID_UNASSIGNED: 'ok', DISPATCHED: 'info', IN_TRANSIT: 'info',
  DELIVERED: 'ok', FAILED_REFUND: 'down',
};
// Status bar becomes available once the driver is working an order.
function setStatus(orderId, status) {
  $('statusbar').classList.remove('hidden');
  $('sbText').textContent = `Order #${orderId}: ${LABELS[status] || status}`;
  $('sbTime').textContent = new Date().toLocaleTimeString();
  $('statusbar').className = 'statusbar ' + (STATUS_KIND[status] || '');
}

// Live Somali-number hint on the login field.
if (window.SomPhone) SomPhone.attach({ input: $('msisdn'), hint: $('phoneHint') });

const api = (path, opts = {}) =>
  fetch(`/api${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  }).then((r) => r.json());

// ── Login ──
$('loginBtn').addEventListener('click', async () => {
  const msisdn = $('msisdn').value.trim();
  const pin = $('pin').value.trim();
  const res = await api('/driver/login', { method: 'POST', body: JSON.stringify({ msisdn, pin }) });
  if (res.error) return toast(res.error);
  token = res.token;
  sessionStorage.setItem('driverToken', token);
  showQueue();
});

$('refreshBtn').addEventListener('click', loadQueue);
$('backBtn').addEventListener('click', showQueue);

function showQueue() {
  $('loginView').classList.add('hidden');
  $('detailView').classList.add('hidden');
  $('queueView').classList.remove('hidden');
  // Status bar is shown whenever the driver is signed in.
  $('statusbar').classList.remove('hidden');
  $('statusbar').className = 'statusbar ok';
  $('sbText').textContent = 'Signed in — select an order from your queue.';
  $('sbTime').textContent = new Date().toLocaleTimeString();
  $('logoutBtn').classList.remove('hidden');
  loadQueue();
  connectSocket();
}

// Logout: drop the session token and return to the PIN login screen.
$('logoutBtn').addEventListener('click', () => {
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
          <div><strong>#${o.id}</strong> · $${Number(o.total_amount).toFixed(2)}</div>
          <span class="badge ${o.status === 'PAID_UNASSIGNED' ? 'paid' : 'pending'}">${o.status}</span>
        </div>
        <div class="muted">${o.landmark_text || ''}</div>
      </div>`).join('')
    : '<p class="muted">No orders in the queue.</p>';
  $('queue').querySelectorAll('[data-id]').forEach((el) =>
    el.addEventListener('click', () => openDetail(el.dataset.id))
  );
}

async function openDetail(id) {
  const res = await api(`/driver/orders/${id}`);
  if (res.error) return toast(res.error);
  current = res.order;
  $('queueView').classList.add('hidden');
  $('detailView').classList.remove('hidden');
  $('dOrderId').textContent = current.id;
  $('dStatus').textContent = current.status;
  $('dBudget').textContent = Number(current.total_amount).toFixed(2);
  $('dLandmark').textContent = current.landmark_text || '(none given)';
  $('dItems').innerHTML = (current.items || [])
    .map((it) => `<div>• ${it.text || JSON.stringify(it)}${it.price ? ` — $${it.price}` : ''}</div>`)
    .join('') || '<div class="muted">No structured items — read the chat.</div>';

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
    if (!photos || !photos.length) { el.innerHTML = '<span class="muted">No photos yet.</span>'; return; }
    el.innerHTML = photos.map((p) => `
      <figure class="photo">
        <img src="${p.url}" alt="${p.kind}" loading="lazy" />
        <figcaption class="muted">${p.kind === 'delivery_proof' ? 'Delivery proof' : 'Reference'}</figcaption>
      </figure>`).join('');
  } catch { /* ignore */ }
}
$('proofBtn').addEventListener('click', async () => {
  const file = $('proofPhoto').files[0];
  if (!file) return toast('Choose a photo first.');
  if (!current) return;
  try {
    // Raw bytes (not JSON), so bypass the JSON api() helper but keep the auth token.
    const r = await fetch(`/api/driver/orders/${current.id}/delivery-proof`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', Authorization: `Bearer ${token}` },
      body: file,
    });
    if (!r.ok) throw new Error('upload failed');
    $('proofPhoto').value = '';
    await loadPhotos(current.id);
    toast('Delivery photo uploaded ✓');
  } catch (e) { toast(e.message); }
});

function renderActions() {
  const s = current.status;
  const btns = [];
  if (s === 'PAID_UNASSIGNED') btns.push(['Accept order', 'accept', '']);
  if (s === 'DISPATCHED') btns.push(['Items secured — heading to customer', 'secured', '']);
  if (s === 'IN_TRANSIT') btns.push(['Mark delivered', 'delivered', '']);
  if (['PAID_UNASSIGNED', 'DISPATCHED', 'IN_TRANSIT'].includes(s))
    btns.push(['Report failure / refund', 'failed', 'danger']);
  $('actions').innerHTML = btns
    .map(([label, action, cls]) => `<button class="${cls}" data-action="${action}">${label}</button>`)
    .join('') || '<p class="muted">No actions available.</p>';
  $('actions').querySelectorAll('[data-action]').forEach((b) =>
    b.addEventListener('click', () => doAction(b.dataset.action))
  );
}

async function doAction(action) {
  const body = action === 'failed' ? JSON.stringify({ reason: 'driver reported failure' }) : undefined;
  const res = await api(`/driver/orders/${current.id}/${action}`, { method: 'POST', body });
  if (res.error) return toast(res.error);
  current = res.order;
  $('dStatus').textContent = current.status;
  setStatus(current.id, current.status);
  renderActions();
  toast('Updated ✓');
}

$('adjustBtn').addEventListener('click', async () => {
  const note = $('adjustNote').value.trim();
  if (!note) return toast('Describe the adjustment.');
  const res = await api(`/driver/orders/${current.id}/adjust`, {
    method: 'POST',
    body: JSON.stringify({ items: current.items, note }),
  });
  if (res.error) return toast(res.error);
  $('adjustNote').value = '';
  toast('Sent to customer ✓');
});

// ── Socket: refresh queue on any new order/state change ──
let ws;
function connectSocket() {
  if (ws) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { $('liveDot').classList.add('on'); ws.send(JSON.stringify({ type: 'subscribe_operator' })); };
  ws.onclose = () => { $('liveDot').classList.remove('on'); ws = null; setTimeout(connectSocket, 2500); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    // Live-update the status bar for the order the driver is currently working.
    if (m.type === 'order_state' && current && String(m.orderId) === String(current.id)) {
      current.status = m.to;
      $('dStatus').textContent = m.to;
      setStatus(current.id, m.to);
      renderActions();
    }
    if ((m.type === 'order_created' || m.type === 'order_state' || m.type === 'payment_confirmed') && !$('queueView').classList.contains('hidden')) {
      loadQueue();
    }
  };
}

let toastTimer;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3000);
}

// Auto-resume session.
if (token) showQueue();
