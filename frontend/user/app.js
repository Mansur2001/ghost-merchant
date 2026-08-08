// User PWA logic. Vanilla JS, no framework (keeps the bundle tiny per the data budget).
// Flow: verify phone by SMS code -> describe need -> geolocate + landmark -> create order ->
// tel: USSD pay -> subscribe over WebSocket -> live timeline + chat until DELIVERED.

const $ = (id) => document.getElementById(id);

// ── Session ──
// The token is the proof that this handset holds the phone number every order is authorized
// against. localStorage (not sessionStorage) on purpose: re-verifying costs a real SMS, and
// the customer is on one personal device. Cleared on sign-out or on any 401.
const TOKEN_KEY = 'gm_token';
const PHONE_KEY = 'gm_phone';
let token = localStorage.getItem(TOKEN_KEY);
let myPhone = localStorage.getItem(PHONE_KEY);

function setSession(newToken, phone) {
  token = newToken;
  myPhone = phone;
  localStorage.setItem(TOKEN_KEY, newToken);
  localStorage.setItem(PHONE_KEY, phone);
}
function clearSession() {
  token = null;
  myPhone = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(PHONE_KEY);
  localStorage.removeItem('gm_last');
}

// Every request carries the bearer token. A 401 means the session died (expired, or the
// server's SESSION_SECRET was rotated) — drop it and send the user back to sign-in rather
// than leaving the UI in a half-broken state.
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, { ...opts, headers });
  if (res.status === 401 && token) {
    clearSession();
    showView('authView');
    toast('Your session expired. Please sign in again.');
    return { error: 'session expired' };
  }
  return res.json().catch(() => ({ error: 'unexpected server response' }));
}

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
let pendingOrderId = null; // client-minted UUID, held across retries
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
// The landing is the default first screen; "I'm a customer" reveals sign-in, or jumps
// straight to the order form if this handset is already verified.
$('asCustomer').addEventListener('click', () => {
  showView(token ? 'startView' : 'authView');
  if (token) $('signedInAs').textContent = myPhone || '';
});
$('homeBtn').addEventListener('click', () => showView('landingView'));
$('authHome').addEventListener('click', () => showView('landingView'));

// ── Sign-in: request a code, then verify it ──
async function requestCode() {
  if (!phoneValid) return toast('Enter a valid Somali mobile number.');
  $('sendCodeBtn').disabled = true;
  $('resendBtn').disabled = true;
  $('otpStatus').textContent = 'Sending code…';
  const res = await api('/auth/otp/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: phoneE164 }),
  });
  $('sendCodeBtn').disabled = false;
  if (res.error) {
    // 429 carries retryAfter — tell them exactly how long, don't just fail.
    $('otpStatus').textContent = res.retryAfter
      ? `${res.error}. Try again in ${res.retryAfter}s.`
      : res.error;
    $('resendBtn').disabled = false;
    return;
  }
  $('codeStep').classList.remove('hidden');
  $('codeInput').focus();
  // devCode is only ever present with the log transport in a non-production backend.
  $('otpStatus').textContent = res.devCode
    ? `Dev mode — your code is ${res.devCode}`
    : `Code sent to ${res.phone}. It expires in ${Math.round(res.expiresInSeconds / 60)} minutes.`;
  startResendCountdown();
}

// The server enforces a 60s cooldown; mirror it in the UI so the button isn't a lie.
function startResendCountdown(seconds = 60) {
  let left = seconds;
  $('resendBtn').disabled = true;
  const tick = () => {
    $('resendBtn').textContent = left > 0 ? `Send a new code (${left}s)` : 'Send a new code';
    if (left <= 0) { $('resendBtn').disabled = false; clearInterval(timer); }
    left -= 1;
  };
  const timer = setInterval(tick, 1000);
  tick();
}

async function verifyCode() {
  const code = $('codeInput').value.trim();
  if (!/^\d{6}$/.test(code)) return toast('Enter the 6-digit code.');
  $('verifyBtn').disabled = true;
  const res = await api('/auth/otp/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: phoneE164, code }),
  });
  $('verifyBtn').disabled = false;
  if (res.error || !res.token) {
    $('otpStatus').textContent = res.error || 'Could not verify that code.';
    return;
  }
  setSession(res.token, res.phone);
  $('codeInput').value = '';
  $('otpStatus').textContent = '';
  $('codeStep').classList.add('hidden');
  $('signedInAs').textContent = res.phone;
  showView('startView');
  toast('Phone verified ✓');
}

$('sendCodeBtn').addEventListener('click', requestCode);
$('resendBtn').addEventListener('click', requestCode);
$('verifyBtn').addEventListener('click', verifyCode);
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyCode(); });
$('signOutBtn').addEventListener('click', () => {
  if (ws) { try { ws.close(); } catch { /* already closed */ } ws = null; }
  order = null;
  clearSession();
  showView('landingView');
  toast('Signed out.');
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
// The owning phone is no longer sent: the server takes it from the verified session, so an
// order can only ever be created under the number this handset proved it holds.
$('submitBtn').addEventListener('click', async () => {
  const request = $('request').value.trim();
  const totalAmount = parseFloat($('amount').value);
  const landmark = $('landmark').value.trim();

  if (!token) return showView('authView');
  if (!request) return toast('Describe what you need.');
  if (!(totalAmount >= 0)) return toast('Enter a valid amount.');
  if (!landmark) return toast('Landmark is required.');

  $('submitBtn').disabled = true;
  // Mint the id here, once, and reuse it if we retry. A lost response on a bad connection
  // must not create a second order the customer could pay for twice.
  pendingOrderId = pendingOrderId || GMIds.newId();
  try {
    const res = await api('/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: pendingOrderId,
        items: [{ text: request }],
        totalAmount,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        landmark,
      }),
    });
    if (res.error) throw new Error(res.error);
    order = res.order;
    pendingOrderId = null; // consumed
    localStorage.setItem('gm_last', JSON.stringify({ orderId: order.id }));
    enterOrderView(res);
    // Seed the thread with the user's request.
    await api(`/orders/${order.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: request }),
    });
    // Optional reference photo → MinIO.
    const file = $('refPhoto').files[0];
    if (file) { try { await uploadPhoto(order.id, file); await loadPhotos(order.id); } catch { /* non-fatal */ } }
  } catch (e) {
    toast(e.message);
  } finally {
    $('submitBtn').disabled = false;
  }
});

// `payment` is { paymentMethod, ussdUri, paymentNote } from the server. A US test number
// has no EVC Plus rail, so there may be no URI at all — render what we're given rather than
// assuming a pay link exists.
function enterOrderView(payment) {
  showView('orderView');
  $('orderId').textContent = GMIds.shortId(order.id);
  $('orderTotal').textContent = Number(order.total_amount).toFixed(2);
  renderPayment(payment || {});
  renderTimeline(order.status);
  updateBadge(order.status);
  setStatus(`Order #${GMIds.shortId(order.id)}: ${LABELS[order.status] || order.status}`, STATUS_KIND[order.status]);
  loadThread();
  loadPhotos(order.id);
  connectSocket();
}

// Show the pay button only when this order can actually be paid that way. A dead
// `tel:*712*...#` link on a +1 number produces a dial string the network rejects — worse
// than no button, because the customer thinks they've paid.
function renderPayment(payment) {
  const link = $('payLink');
  const note = $('payNote');
  if (payment.paymentMethod === 'ussd' && payment.ussdUri) {
    // CRITICAL: use the server-built URI verbatim; the trailing # is already %23-encoded.
    link.setAttribute('href', payment.ussdUri);
    link.classList.remove('hidden');
    note.textContent = 'Tapping opens your dialer with the USSD code pre-filled. Approve the transfer on your phone — this page updates automatically when payment is confirmed.';
  } else {
    link.classList.add('hidden');
    note.textContent = payment.paymentNote
      || 'Pay the operator directly; they will confirm this order.';
  }
}

// ── Photos (MinIO-backed; bytes stream through the backend) ──
async function uploadPhoto(orderId, file) {
  await fetch(`/api/orders/${orderId}/photos/order_ref`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      Authorization: `Bearer ${token}`,
    },
    body: file,
  });
}
async function loadPhotos(orderId) {
  try {
    const { photos } = await api(`/orders/${orderId}/photos`);
    const el = $('photos');
    if (!photos || !photos.length) { el.innerHTML = '<span class="muted">No photos yet.</span>'; return; }
    // Photo bytes are authorized too, so they can't be loaded with a plain <img src>.
    // Fetch each with the token and render from an object URL.
    el.innerHTML = photos.map((p) => `
      <figure class="photo">
        <img data-src="${p.url}" alt="${p.kind}" loading="lazy" />
        <figcaption class="muted">${p.kind === 'delivery_proof' ? 'Delivery proof' : 'Reference'}</figcaption>
      </figure>`).join('');
    el.querySelectorAll('img[data-src]').forEach(async (img) => {
      try {
        const r = await fetch(img.dataset.src, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return;
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        img.src = url;
        img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
      } catch { /* leave the placeholder */ }
    });
  } catch { /* ignore */ }
}

// ── Realtime socket: authenticate, then subscribe to THIS order ──
// A browser can't set headers on a WebSocket handshake and a token in the query string ends
// up in every access log, so the token goes in the first frame instead. The server drops
// sockets that haven't authenticated within 10s.
function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    $('liveDot').classList.add('on');
    ws.send(JSON.stringify({ type: 'auth', token }));
  };
  ws.onclose = () => {
    $('liveDot').classList.remove('on');
    if (token && order) setTimeout(connectSocket, 2000); // auto-reconnect
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'authenticated') {
      if (order) ws.send(JSON.stringify({ type: 'subscribe', orderId: order.id }));
    } else if (m.type === 'auth_error') {
      clearSession();
      showView('authView');
    } else if (m.type === 'order_state') {
      order.status = m.to;
      renderTimeline(m.to);
      updateBadge(m.to);
      setStatus(`Order #${GMIds.shortId(order.id)}: ${LABELS[m.to] || m.to}`, STATUS_KIND[m.to]);
    } else if (m.type === 'payment_confirmed') {
      updateBadge('PAID_UNASSIGNED');
      setStatus(`Order #${GMIds.shortId(order.id)}: Payment confirmed ✓`, 'ok');
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
  // `sender` is derived server-side from the session — a client can't label its own message.
  await api(`/orders/${order.id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

// ── Header navigation: Home (landing) + FAQ ──
const VIEWS = ['landingView', 'authView', 'startView', 'orderView', 'resumeView', 'faqView'];
function showView(id) {
  VIEWS.forEach((v) => $(v).classList.add('hidden'));
  $(id).classList.remove('hidden');
}
$('navHome').addEventListener('click', () => showView('landingView'));
$('faqBtn').addEventListener('click', () => showView('faqView'));
$('faqBack').addEventListener('click', () => showView(order ? 'orderView' : 'landingView'));

// ── Resume an order ──
// Scoped to the verified session: the server answers with THIS number's orders. There is no
// longer any way to list orders for a number you merely typed.
$('resumeBtn').addEventListener('click', async () => {
  if (!token) return showView('authView');
  const res = await api('/orders/mine');
  if (res.error) return toast(res.error);
  showResumeList(res.orders || []);
});
$('resumeBack').addEventListener('click', () => showView('startView'));
function showResumeList(orders) {
  showView('resumeView');
  $('resumeList').innerHTML = orders.length
    ? orders.map((o) => `
        <div class="card" style="background:var(--panel-2);cursor:pointer" data-id="${o.id}">
          <div class="row" style="align-items:center;">
            <div><strong>#${GMIds.shortId(o.id)}</strong> · $${Number(o.total_amount).toFixed(2)}</div>
            <span class="badge ${badgeClass(o.status)}">${o.status}</span>
          </div>
          <div class="muted">${o.landmark_text || ''}</div>
        </div>`).join('')
    : '<p class="muted">No orders found for this number.</p>';
  $('resumeList').querySelectorAll('[data-id]').forEach((el) =>
    el.addEventListener('click', () => resumeOrder(el.dataset.id))
  );
}
async function resumeOrder(id) {
  const res = await api(`/orders/${id}`);
  if (res.error) return toast(res.error);
  order = res.order;
  localStorage.setItem('gm_last', JSON.stringify({ orderId: order.id }));
  enterOrderView(res);
}

// Auto-resume the last active order on load (survives refresh, per the resume requirement).
// Requires a live session — without one there is nothing to resume into.
(async function autoResume() {
  try {
    if (!token) return;
    const saved = JSON.parse(localStorage.getItem('gm_last') || 'null');
    if (!saved?.orderId) return;
    const res = await api(`/orders/${saved.orderId}`);
    if (res.order && !['DELIVERED', 'FAILED_REFUND'].includes(res.order.status)) {
      order = res.order;
      $('signedInAs').textContent = myPhone || '';
      enterOrderView(res);
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

// ── Service worker ──
// Registered here rather than in an inline <script> so the page can run under a strict
// Content-Security-Policy (script-src 'self'), which is what blocks injected script.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
}
