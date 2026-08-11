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
  // The queue holds this customer's unsent writes; carrying them into another session would
  // replay one person's messages under another identity.
  if (window.GMQueue) GMQueue.clear();
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
  let res;
  try {
    res = await fetch(GMConfig.api(path), { ...opts, headers });
  } catch {
    // No answer at all — offline, DNS, timeout. Categorically different from the server
    // saying no, and the offline queue treats it differently.
    return { error: 'No connection.', offline: true };
  }
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

// ── Missed-call verification ──
//
// The inverse of a passcode: instead of us sending a secret to the phone and asking for it
// back, the customer's phone reaches us and the caller ID is the proof. Nothing is sent, so
// there is no code to intercept, no per-message cost, and no queue that can stall.
//
// The ticket returned by /call/start is this client's claim on the challenge — it is what
// makes the session ours rather than "whoever asks about this number". Held in memory only:
// it must not outlive the tab, and it is never shown to the customer.
let callTicket = null;
let callPollTimer = null;

async function loadAuthMethods() {
  const res = await api('/auth/methods');
  // Whether a call-capable device exists is deployment configuration, not something the
  // client can assume — a dead "call to verify" button is worse than no button.
  if (res && res.call) $('callStep').classList.remove('hidden');
}
loadAuthMethods();

function stopCallPolling() {
  if (callPollTimer) clearInterval(callPollTimer);
  callPollTimer = null;
  callTicket = null;
}

async function startCallVerification() {
  if (!phoneValid) return toast('Enter a valid mobile number.');
  $('callVerifyBtn').disabled = true;
  $('otpStatus').textContent = '';

  const res = await api('/auth/call/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: phoneE164 }),
  });
  $('callVerifyBtn').disabled = false;

  if (res.error || !res.ticket) {
    $('otpStatus').textContent = res.retryAfter
      ? `${res.error}. Try again in ${res.retryAfter}s.`
      : res.error || 'Could not start verification.';
    return;
  }

  callTicket = res.ticket;
  $('callInstructions').classList.remove('hidden');
  $('callVerifyBtn').classList.add('hidden');
  // Same permission-free dialer launch the USSD payment flow uses (ACTION_DIAL on Android).
  // A plain voice call also works on iOS, where USSD from a tel: link is blocked — so this is
  // the more portable half of the app.
  $('callLink').href = `tel:${res.callNumber}`;
  $('callLink').textContent = `Tap to call ${res.callNumber}`;
  $('callWaiting').textContent = 'Waiting for your call…';

  const interval = res.pollIntervalMs || 2000;
  callPollTimer = setInterval(() => pollCallStatus(), interval);
  pollCallStatus();
}

async function pollCallStatus() {
  if (!callTicket) return;
  const res = await api('/auth/call/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: phoneE164, ticket: callTicket }),
  });

  if (res.status === 'verified' && res.token) {
    stopCallPolling();
    $('callInstructions').classList.add('hidden');
    $('callVerifyBtn').classList.remove('hidden');
    setSession(res.token, res.phone);
    $('signedInAs').textContent = res.phone;
    showView('startView');
    toast('Phone verified ✓');
    return;
  }

  // A 401 here means the challenge expired or was replaced (someone re-opened one for this
  // number). Stop rather than polling a dead ticket forever, and say what to do next.
  if (res.error) {
    stopCallPolling();
    $('callWaiting').textContent = 'That verification expired — tap to try again.';
    $('callInstructions').classList.add('hidden');
    $('callVerifyBtn').classList.remove('hidden');
  }
}

$('callVerifyBtn').addEventListener('click', startCallVerification);
$('callCancelBtn').addEventListener('click', () => {
  stopCallPolling();
  $('callInstructions').classList.add('hidden');
  $('callVerifyBtn').classList.remove('hidden');
  requestCode();
});

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
  await fetch(GMConfig.api(`/orders/${orderId}/photos/order_ref`), {
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
        const r = await fetch(GMConfig.base + img.dataset.src, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return;
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        img.src = url;
        img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
      } catch { /* leave the placeholder */ }
    });
  } catch { /* ignore */ }
}

// ── Offline queue ──
// Replays queued writes when the network returns. Customer-side writes are chat messages and
// order creation, both carrying a client-minted UUID, so a replay of something that already
// landed is a no-op on the server rather than a duplicate.
async function sendQueued(item) {
  const res = await fetch(GMConfig.api(item.path), {
    method: item.method,
    headers: {
      'Content-Type': item.contentType,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: item.body,
  });
  return { status: res.status };
}

function flushQueue() {
  if (!token || !navigator.onLine) return;
  GMQueue.flush(sendQueued).then(({ sent }) => {
    if (sent > 0 && order) loadThread();
  });
}

function renderSyncState(stats) {
  const el = $('syncState');
  if (!el) return;
  const d = GMSync.describe(stats);
  el.textContent = d.tone === 'ok' ? '' : d.text;
  el.className = 'sync-state ' + d.tone;
  el.classList.toggle('hidden', d.tone === 'ok');
}

window.addEventListener('online', flushQueue);
setInterval(flushQueue, 15000);
GMQueue.onChange(renderSyncState);

// ── Realtime socket: authenticate, then subscribe to THIS order ──
// A browser can't set headers on a WebSocket handshake and a token in the query string ends
// up in every access log, so the token goes in the first frame instead. The server drops
// sockets that haven't authenticated within 10s.
function connectSocket() {
  ws = new WebSocket(GMConfig.wsUrl());
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
      flushQueue(); // a live socket is the most reliable signal the network is actually back
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
  // A message we optimistically rendered comes back over the socket once it lands. Replace
  // the placeholder rather than showing the customer their own message twice.
  if (m.client_id) {
    const existing = $('thread').querySelector(`[data-client-id="${m.client_id}"]`);
    if (existing) {
      existing.classList.remove('queued');
      existing.textContent = m.body;
      return;
    }
  }
  const div = document.createElement('div');
  div.className = `msg ${m.sender}${m.queued ? ' queued' : ''}`;
  if (m.clientId || m.client_id) div.dataset.clientId = m.clientId || m.client_id;
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

  // A client-minted id makes the write idempotent: if the response is lost and the queue
  // replays it, the server keeps the original instead of duplicating the message.
  const clientId = GMIds.newId();
  const payload = JSON.stringify({ body, clientId });
  const path = `/orders/${order.id}/messages`;

  // Show it immediately, greyed, so the thread never feels like it swallowed the message.
  appendMessage({ sender: 'user', body, queued: true, clientId });

  if (!navigator.onLine) {
    await GMQueue.enqueue({ method: 'POST', path, body: payload, label: 'Send message', orderId: order.id });
    return;
  }
  // `sender` is derived server-side from the session — a client can't label its own message.
  const res = await api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
  if (res.offline) {
    await GMQueue.enqueue({ method: 'POST', path, body: payload, label: 'Send message', orderId: order.id });
  }
}

// ── Header navigation: Home (landing) + FAQ ──
const VIEWS = ['landingView', 'joinView', 'authView', 'startView', 'orderView', 'resumeView', 'faqView'];
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

// ── Ask to join the team ──
// This submits a REQUEST. It creates no account: an operator reads it, calls the number, and
// decides. The page says so plainly, because a form that looks like registration and then
// doesn't sign you in reads as broken.
$('joinBtn').addEventListener('click', async () => {
  showView('joinView');
  loadOwnerContact();
});
$('joinHome').addEventListener('click', () => showView('landingView'));

// Live validation on the applicant's number — same rules as everywhere else, so we don't take
// a request we can't call back.
let joinPhoneValid = false;
let joinPhoneE164 = null;
SomPhone.attach({
  input: $('joinPhone'),
  hint: $('joinPhoneHint'),
  onChange: (r) => { joinPhoneValid = r.valid; joinPhoneE164 = r.e164 || null; },
});

async function loadOwnerContact() {
  const el = $('ownerContact');
  if (el.dataset.loaded) return;
  const res = await api('/signup/contact');
  const c = res.contact;
  if (!c) return;
  el.innerHTML = `
    <div><a href="mailto:${c.email}">${c.email}</a></div>
    <div><a href="tel:${String(c.phone).replace(/[^\d+]/g, '')}">${c.phone}</a></div>`;
  el.dataset.loaded = '1';
}

$('joinSubmit').addEventListener('click', async () => {
  const name = $('joinName').value.trim();
  const role = $('joinRole').value;
  const message = $('joinMessage').value.trim();

  if (name.length < 2) return toast('Please enter your name.');
  if (!joinPhoneValid) return toast('Enter a valid phone number so we can call you back.');

  $('joinSubmit').disabled = true;
  $('joinStatus').textContent = 'Sending…';
  const res = await api('/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, name, phone: joinPhoneE164, message }),
  });
  $('joinSubmit').disabled = false;

  if (res.error) {
    $('joinStatus').textContent = res.retryAfter
      ? `${res.error} (try again in ${res.retryAfter}s)`
      : res.error;
    return;
  }
  // Upload the ID sides second, using the short-lived token scoped to this request. Doing it
  // as a separate step keeps the request id off the wire, and lets the application succeed
  // even if a photo fails — losing a good applicant because an upload timed out would be silly.
  const sides = [
    ['front', $('joinIdFront').files[0]],
    ['back', $('joinIdBack').files[0]],
  ].filter(([, f]) => f);

  if (sides.length && res.uploadToken) {
    const failed = [];
    for (const [side, file] of sides) {
      $('joinStatus').textContent = `Sending the ${side} of your ID…`;
      try {
        const up = await fetch(GMConfig.api(`/signup/id-document/${side}`), {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            Authorization: `Bearer ${res.uploadToken}`,
          },
          body: file,
        });
        if (!up.ok) {
          const b = await up.json().catch(() => ({}));
          failed.push(`${side} (${b.error || 'failed'})`);
        }
      } catch {
        failed.push(`${side} (no connection)`);
      }
    }
    if (failed.length) {
      $('joinStatus').textContent =
        `${res.message}\n\nCouldn't upload: ${failed.join(', ')} — we may call you to arrange it.`;
      return;
    }
  }

  $('joinStatus').textContent = res.message;
  $('joinName').value = '';
  $('joinMessage').value = '';
  $('joinIdFront').value = '';
  $('joinIdBack').value = '';
  $('joinIdHint').textContent = '';
});

// Say which sides are attached, so nobody submits thinking both went in when one didn't.
function updateIdHint() {
  const front = $('joinIdFront').files[0];
  const back = $('joinIdBack').files[0];
  if (!front && !back) { $('joinIdHint').textContent = ''; return; }
  const parts = [];
  if (front) parts.push('front ✓'); else parts.push('front missing');
  if (back) parts.push('back ✓'); else parts.push('back missing');
  $('joinIdHint').textContent = `${parts.join(' · ')} — deleted once your request is reviewed`;
}
$('joinIdFront').addEventListener('change', updateIdHint);
$('joinIdBack').addEventListener('change', updateIdHint);

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
// Skipped in the native shell: Capacitor bundles the assets into the APK, so a service
// worker would be a second, stale copy of the app competing with the real one.
if ('serviceWorker' in navigator && !GMConfig.isNative()) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
}
