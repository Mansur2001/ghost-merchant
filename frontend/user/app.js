// User PWA logic. Vanilla JS, no framework (keeps the bundle tiny per the data budget).
// Flow: describe need -> geolocate + landmark -> create order -> tel: USSD pay ->
// subscribe over WebSocket -> live timeline + chat until DELIVERED.

const $ = (id) => document.getElementById(id);
const api = (path, opts) => fetch(`/api${path}`, opts).then((r) => r.json());

const STATES = [
  'PENDING_PAYMENT',
  'PAID_UNASSIGNED',
  'DISPATCHED',
  'IN_TRANSIT',
  'DELIVERED',
];
const LABELS = {
  PENDING_PAYMENT: 'Awaiting payment',
  PAID_UNASSIGNED: 'Payment confirmed',
  DISPATCHED: 'Driver on the way to market',
  IN_TRANSIT: 'Driver bringing your items',
  DELIVERED: 'Delivered',
  FAILED_REFUND: 'Cancelled / refund',
};

let coords = null; // { lat, lng }
let order = null;
let ws = null;
let phoneValid = false;
let phoneE164 = null;

// Live Somali-number validation: as the user types, sync the operator + formatting and
// reject anything that isn't a valid assigned prefix + length.
SomPhone.attach({
  input: $('phone'),
  hint: $('phoneHint'),
  onChange: (r) => { phoneValid = r.valid; phoneE164 = r.e164 || null; },
});

// ── Home / role selection ──
// The landing is the default first screen; "I'm a customer" reveals the order flow.
$('asCustomer').addEventListener('click', () => {
  $('landingView').classList.add('hidden');
  $('startView').classList.remove('hidden');
});
$('homeBtn').addEventListener('click', () => {
  $('startView').classList.add('hidden');
  $('landingView').classList.remove('hidden');
});

// Status bar was removed from the customer PWA (kept only for signed-in operator/driver).
// Left as a guarded no-op so existing call sites stay harmless.
function setStatus(text, kind) {
  const sb = $('statusbar');
  if (!sb) return;
  $('sbText').textContent = text;
  $('sbTime').textContent = new Date().toLocaleTimeString();
  sb.className = 'statusbar ' + (kind || '');
}
function badgeClass(s) {
  return s === 'FAILED_REFUND' ? 'fail' : s === 'PENDING_PAYMENT' ? 'pending' : 'paid';
}
const STATUS_KIND = {
  PENDING_PAYMENT: 'warn', PAID_UNASSIGNED: 'ok', DISPATCHED: 'info',
  IN_TRANSIT: 'info', DELIVERED: 'ok', FAILED_REFUND: 'down',
};

// ── Geolocation (silent capture + landmark mask, per SRS 3.5) ──
$('locBtn').addEventListener('click', () => {
  $('locStatus').textContent = 'Detecting location…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      $('locStatus').textContent = `Location detected (±${Math.round(pos.coords.accuracy)}m). Add a landmark below.`;
    },
    (err) => {
      $('locStatus').textContent = `Could not get location: ${err.message}. You can still order using the landmark.`;
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// ── Create order ──
$('submitBtn').addEventListener('click', async () => {
  const request = $('request').value.trim();
  const totalAmount = parseFloat($('amount').value);
  const landmark = $('landmark').value.trim();

  if (!phoneValid) return toast('Enter a valid Somali mobile number.');
  const userPhone = phoneE164;
  if (!request) return toast('Describe what you need.');
  if (!(totalAmount >= 0)) return toast('Enter a valid amount.');
  if (!landmark) return toast('Landmark is required.');

  $('submitBtn').disabled = true;
  try {
    const res = await api('/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userPhone,
        items: [{ text: request }],
        totalAmount,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        landmark,
      }),
    });
    if (res.error) throw new Error(res.error);
    order = res.order;
    localStorage.setItem('gm_last', JSON.stringify({ orderId: order.id }));
    enterOrderView(res.ussdUri);
    // Seed the thread with the user's request.
    await api(`/orders/${order.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: 'user', body: request }),
    });
    // Optional reference photo → MinIO.
    const file = $('refPhoto').files[0];
    if (file) { try { await uploadPhoto(order.id, file); await loadPhotos(order.id); } catch { /* non-fatal */ } }
  } catch (e) {
    toast(e.message);
    $('submitBtn').disabled = false;
  }
});

function enterOrderView(ussdUri) {
  showView('orderView');
  $('orderId').textContent = order.id;
  $('orderTotal').textContent = Number(order.total_amount).toFixed(2);
  // CRITICAL: use the server-built URI verbatim; the trailing # is already %23-encoded.
  $('payLink').setAttribute('href', ussdUri);
  renderTimeline(order.status);
  updateBadge(order.status);
  setStatus(`Order #${order.id}: ${LABELS[order.status] || order.status}`, STATUS_KIND[order.status]);
  loadThread();
  loadPhotos(order.id);
  connectSocket();
}

// ── Photos (MinIO-backed; bytes stream through the backend) ──
async function uploadPhoto(orderId, file) {
  await fetch(`/api/orders/${orderId}/photos/order_ref`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
}
async function loadPhotos(orderId) {
  try {
    const { photos } = await api(`/orders/${orderId}/photos`);
    const el = $('photos');
    if (!photos || !photos.length) { el.innerHTML = '<span class="muted">No photos yet.</span>'; return; }
    el.innerHTML = photos.map((p) => `
      <figure class="photo">
        <img src="${p.url}" alt="${p.kind}" loading="lazy" />
        <figcaption class="muted">${p.kind === 'delivery_proof' ? 'Delivery proof' : 'Reference'}</figcaption>
      </figure>`).join('');
  } catch { /* ignore */ }
}

// ── Realtime socket: subscribe to THIS order and react to pushes ──
function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    $('liveDot').classList.add('on');
    ws.send(JSON.stringify({ type: 'subscribe', orderId: order.id }));
  };
  ws.onclose = () => {
    $('liveDot').classList.remove('on');
    setTimeout(connectSocket, 2000); // auto-reconnect
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'order_state') {
      order.status = m.to;
      renderTimeline(m.to);
      updateBadge(m.to);
      setStatus(`Order #${order.id}: ${LABELS[m.to] || m.to}`, STATUS_KIND[m.to]);
    } else if (m.type === 'payment_confirmed') {
      updateBadge('PAID_UNASSIGNED');
      setStatus(`Order #${order.id}: Payment confirmed ✓`, 'ok');
      toast('Payment confirmed ✓');
    } else if (m.type === 'message') {
      appendMessage(m.message);
      // A system line accompanies every photo upload → refresh the gallery live.
      if (m.message && m.message.sender === 'system') loadPhotos(order.id);
    }
  };
}

// ── Timeline + badge ──
function renderTimeline(status) {
  const isFail = status === 'FAILED_REFUND';
  const idx = STATES.indexOf(status);
  $('timeline').innerHTML = STATES.map((s, i) => {
    let cls = '';
    if (!isFail && i < idx) cls = 'done';
    else if (!isFail && i === idx) cls = 'active';
    return `<li class="${cls}"><div class="label">${LABELS[s]}</div></li>`;
  }).join('') + (isFail ? `<li class="active"><div class="label">${LABELS.FAILED_REFUND}</div></li>` : '');
}

function updateBadge(status) {
  const b = $('statusBadge');
  b.textContent = status;
  b.className = 'badge ' + (status === 'FAILED_REFUND' ? 'fail' : status === 'PENDING_PAYMENT' ? 'pending' : 'paid');
}

// ── Chat ──
async function loadThread() {
  const { messages } = await api(`/orders/${order.id}/messages`);
  $('thread').innerHTML = '';
  (messages || []).forEach(appendMessage);
}
function appendMessage(m) {
  const div = document.createElement('div');
  div.className = `msg ${m.sender}`;
  div.textContent = m.body;
  $('thread').appendChild(div);
  $('thread').scrollTop = $('thread').scrollHeight;
}
$('chatSend').addEventListener('click', sendChat);
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
async function sendChat() {
  const body = $('chatInput').value.trim();
  if (!body || !order) return;
  $('chatInput').value = '';
  await api(`/orders/${order.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: 'user', body }),
  });
}

// ── Header navigation: Home (landing) + FAQ ──
const VIEWS = ['landingView', 'startView', 'orderView', 'resumeView', 'faqView'];
function showView(id) {
  VIEWS.forEach((v) => $(v).classList.add('hidden'));
  $(id).classList.remove('hidden');
}
$('navHome').addEventListener('click', () => showView('landingView'));
$('faqBtn').addEventListener('click', () => showView('faqView'));
$('faqBack').addEventListener('click', () => showView(order ? 'orderView' : 'landingView'));

// ── Resume an order keyed on phone number ──
$('resumeBtn').addEventListener('click', async () => {
  const r = SomPhone.parse($('phone').value);
  if (!r.valid) return toast('Enter your valid phone number to find your orders.');
  const res = await api(`/orders/by-phone/${encodeURIComponent(r.e164)}`);
  if (res.error) return toast(res.error);
  showResumeList(res.orders || []);
});
$('resumeBack').addEventListener('click', () => {
  $('resumeView').classList.add('hidden');
  $('startView').classList.remove('hidden');
});
function showResumeList(orders) {
  $('startView').classList.add('hidden');
  $('resumeView').classList.remove('hidden');
  $('resumeList').innerHTML = orders.length
    ? orders.map((o) => `
        <div class="card" style="background:var(--panel-2);cursor:pointer" data-id="${o.id}" data-ussd="${o.ussdUri}">
          <div class="row" style="align-items:center;">
            <div><strong>#${o.id}</strong> · $${Number(o.total_amount).toFixed(2)}</div>
            <span class="badge ${badgeClass(o.status)}">${o.status}</span>
          </div>
          <div class="muted">${o.landmark_text || ''}</div>
        </div>`).join('')
    : '<p class="muted">No orders found for this number.</p>';
  $('resumeList').querySelectorAll('[data-id]').forEach((el) =>
    el.addEventListener('click', () => resumeOrder(el.dataset.id, el.dataset.ussd))
  );
}
async function resumeOrder(id, ussd) {
  const res = await api(`/orders/${id}`);
  if (res.error) return toast(res.error);
  order = res.order;
  localStorage.setItem('gm_last', JSON.stringify({ orderId: order.id }));
  enterOrderView(res.ussdUri || ussd);
}

// Auto-resume the last active order on load (survives refresh, per the resume requirement).
(async function autoResume() {
  try {
    const saved = JSON.parse(localStorage.getItem('gm_last') || 'null');
    if (!saved?.orderId) return;
    const res = await api(`/orders/${saved.orderId}`);
    if (res.order && !['DELIVERED', 'FAILED_REFUND'].includes(res.order.status)) {
      order = res.order;
      enterOrderView(res.ussdUri);
    } else {
      localStorage.removeItem('gm_last');
    }
  } catch { /* ignore */ }
})();

// ── Tiny toast ──
let toastTimer;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3200);
}
