// User PWA logic. Vanilla JS, no framework (keeps the bundle tiny per the data budget).
// Flow: verify phone by SMS code -> describe need -> geolocate + landmark -> create order ->
// tel: USSD pay -> subscribe over WebSocket -> live timeline + chat until DELIVERED.

const $ = (id) => document.getElementById(id);
const t = GMI18n.t;

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
    toast(t('session.expired'));
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
const label = (s) => t(`st.${s}`);
// Server errors arrive in English; show them in the customer's language.
const errText = (res) => (res.retryAfter
  ? t('auth.retry', { err: GMI18n.err(res.error), s: res.retryAfter })
  : GMI18n.err(res.error));

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
  if (!phoneValid) return toast(t('err.phone'));
  $('sendCodeBtn').disabled = true;
  $('resendBtn').disabled = true;
  $('otpStatus').textContent = t('auth.sending');
  const res = await api('/auth/otp/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: phoneE164 }),
  });
  $('sendCodeBtn').disabled = false;
  if (res.error) {
    // 429 carries retryAfter — tell them exactly how long, don't just fail.
    $('otpStatus').textContent = errText(res);
    $('resendBtn').disabled = false;
    return;
  }
  $('codeStep').classList.remove('hidden');
  $('codeInput').focus();
  // devCode is only ever present with the log transport in a non-production backend.
  $('otpStatus').textContent = res.devCode
    ? t('auth.dev', { code: res.devCode })
    : t('auth.sent', { phone: res.phone, m: Math.round(res.expiresInSeconds / 60) });
  startResendCountdown();
}

// The server enforces a 60s cooldown; mirror it in the UI so the button isn't a lie.
let resendLeft = 0;
let resendTimer = null;
function renderResend() {
  $('resendBtn').textContent = resendLeft > 0 ? t('auth.resendIn', { s: resendLeft }) : t('auth.resend');
}
function startResendCountdown(seconds = 60) {
  resendLeft = seconds;
  $('resendBtn').disabled = true;
  clearInterval(resendTimer);
  const tick = () => {
    renderResend();
    if (resendLeft <= 0) { $('resendBtn').disabled = false; clearInterval(resendTimer); }
    resendLeft -= 1;
  };
  resendTimer = setInterval(tick, 1000);
  tick();
}

async function verifyCode() {
  const code = $('codeInput').value.trim();
  if (!/^\d{6}$/.test(code)) return toast(t('err.code'));
  $('verifyBtn').disabled = true;
  const res = await api('/auth/otp/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: phoneE164, code }),
  });
  $('verifyBtn').disabled = false;
  if (res.error || !res.token) {
    $('otpStatus').textContent = res.error ? GMI18n.err(res.error) : t('err.badCode');
    return;
  }
  setSession(res.token, res.phone);
  $('codeInput').value = '';
  $('otpStatus').textContent = '';
  $('codeStep').classList.add('hidden');
  $('signedInAs').textContent = res.phone;
  showView('startView');
  toast(t('auth.ok'));
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
  toast(t('signedOut'));
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
  $('locStatus').textContent = t('loc.finding');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      $('locStatus').textContent = t('loc.ok', { m: Math.round(pos.coords.accuracy) });
    },
    () => {
      $('locStatus').textContent = t('loc.fail');
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
  if (!request) return toast(t('start.err.request'));
  if (!(totalAmount >= 0)) return toast(t('start.err.amount'));
  if (!landmark) return toast(t('start.err.landmark'));

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
    toast(GMI18n.err(e.message));
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
  setStatus(`#${GMIds.shortId(order.id)}: ${label(order.status)}`, STATUS_KIND[order.status]);
  loadThread();
  loadPhotos(order.id);
  connectSocket();
}

// Show the pay button only when this order can actually be paid that way. A dead
// `tel:*712*...#` link on a +1 number produces a dial string the network rejects — worse
// than no button, because the customer thinks they've paid.
let lastPayment = {};
function renderPayment(payment) {
  lastPayment = payment;
  const link = $('payLink');
  const note = $('payNote');
  if (payment.paymentMethod === 'ussd' && payment.ussdUri) {
    // CRITICAL: use the server-built URI verbatim; the trailing # is already %23-encoded.
    link.setAttribute('href', payment.ussdUri);
    link.classList.remove('hidden');
    note.textContent = t('pay.note');
  } else {
    // The server's paymentNote is English; the method alone says which message applies.
    link.classList.add('hidden');
    note.textContent = t('pay.manual');
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
    if (!photos || !photos.length) { el.innerHTML = `<span class="muted">${t('photos.none')}</span>`; return; }
    // Photo bytes are authorized too, so they can't be loaded with a plain <img src>.
    // Fetch each with the token and render from an object URL.
    el.innerHTML = photos.map((p) => `
      <figure class="photo">
        <img data-src="${p.url}" alt="${p.kind}" loading="lazy" />
        <figcaption class="muted">${p.kind === 'delivery_proof' ? t('photo.proof') : t('photo.ref')}</figcaption>
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
      setStatus(`#${GMIds.shortId(order.id)}: ${label(m.to)}`, STATUS_KIND[m.to]);
    } else if (m.type === 'payment_confirmed') {
      updateBadge('PAID_UNASSIGNED');
      setStatus(`#${GMIds.shortId(order.id)}: ${t('pay.confirmed')}`, 'ok');
      toast(t('pay.confirmed'));
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
    return `<li class="${cls}"><div class="label">${label(s)}</div></li>`;
  }).join('') + (isFail ? `<li class="active"><div class="label">${label('FAILED_REFUND')}</div></li>` : '');
}

function updateBadge(status) {
  const b = $('statusBadge');
  b.textContent = label(status);
  b.className = 'badge ' + (status === 'FAILED_REFUND' ? 'fail' : status === 'PENDING_PAYMENT' ? 'pending' : 'paid');
  // Once paid (or failed), a live "Pay now" button invites paying twice. Runs after
  // renderPayment() and on every socket transition, so it always has the last word.
  if (status !== 'PENDING_PAYMENT') {
    $('payLink').classList.add('hidden');
    $('payNote').classList.add('hidden');
  } else {
    $('payNote').classList.remove('hidden');
  }
  renderPaidClaim(status);
}

// ── "I've paid" ──
// Nothing reads the merchant's receipts automatically: an operator checks the merchant phone.
// This tells them which order to check. It is not proof of payment, and the order only turns
// "paid" when the operator confirms — the page then updates on its own over the socket.
function renderPaidClaim(status) {
  const pending = status === 'PENDING_PAYMENT';
  const claimed = Boolean(order && order.payment_claimed_at);
  $('paidBox').classList.toggle('hidden', !pending || claimed);
  $('paidNote').classList.toggle('hidden', !pending || !claimed);
  if (pending && claimed) {
    $('paidNote').textContent = t('paid.waiting') +
      (order.payment_claim_ref ? ` ${t('paid.ref', { ref: order.payment_claim_ref })}` : '');
  }
}

$('paidBtn').addEventListener('click', async () => {
  if (!order) return;
  $('paidBtn').disabled = true;
  const res = await api(`/orders/${order.id}/paid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference: $('payRef').value.trim() }),
  });
  $('paidBtn').disabled = false;
  if (res.error) return toast(GMI18n.err(res.error));
  order = { ...order, ...res.order };
  $('payRef').value = '';
  renderPaidClaim(order.status);
  toast(t('paid.sent'));
});

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
  if (res.error) return toast(GMI18n.err(res.error));
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
            <span class="badge ${badgeClass(o.status)}">${label(o.status)}</span>
          </div>
          <div class="muted">${o.landmark_text || ''}</div>
        </div>`).join('')
    : `<p class="muted">${t('resume.none')}</p>`;
  $('resumeList').querySelectorAll('[data-id]').forEach((el) =>
    el.addEventListener('click', () => resumeOrder(el.dataset.id))
  );
}
async function resumeOrder(id) {
  const res = await api(`/orders/${id}`);
  if (res.error) return toast(GMI18n.err(res.error));
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

  if (name.length < 2) return toast(t('join.err.name'));
  if (!joinPhoneValid) return toast(t('err.phone'));

  $('joinSubmit').disabled = true;
  $('joinStatus').textContent = t('join.sending');
  const res = await api('/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, name, phone: joinPhoneE164, message }),
  });
  $('joinSubmit').disabled = false;

  if (res.error) {
    $('joinStatus').textContent = errText(res);
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
      $('joinStatus').textContent = t('join.sendingId', { side: t(`join.side.${side}`) });
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
          failed.push(t(`join.side.${side}`));
        }
      } catch {
        failed.push(t(`join.side.${side}`));
      }
    }
    if (failed.length) {
      $('joinStatus').textContent =
        `${t('join.done')} ${t('join.uploadFailed', { list: failed.join(', ') })}`;
      return;
    }
  }

  $('joinStatus').textContent = t('join.done');
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
  for (const [side, file] of [['front', front], ['back', back]]) {
    parts.push(`${t(`join.side.${side}`)} ${file ? '✓' : t('join.missing')}`);
  }
  $('joinIdHint').textContent = t('join.idHint', { parts: parts.join(' · ') });
}
$('joinIdFront').addEventListener('change', updateIdHint);
$('joinIdBack').addEventListener('change', updateIdHint);

// ── Language switch ──
// Static text is redone by GMI18n.apply(); this redraws what the script rendered itself.
document.addEventListener('gm:lang', () => {
  if (order) {
    renderPayment(lastPayment);
    renderTimeline(order.status);
    updateBadge(order.status);
    loadPhotos(order.id);
  }
  if (resendLeft > 0 || !$('codeStep').classList.contains('hidden')) renderResend();
  if (lastSyncStats) renderSyncState(lastSyncStats);
  // Re-run the live phone hints in the new language.
  ['phone', 'joinPhone'].forEach((id) => $(id).dispatchEvent(new Event('input')));
  if (!$('resumeView').classList.contains('hidden')) $('resumeBtn').click();
  updateIdHint();
  $('otpStatus').textContent = '';
});

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
