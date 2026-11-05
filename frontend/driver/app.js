// Driver PWA logic. PIN login, job list, and the two driver steps — each with the proof the
// server requires (backend domain/proof.js):
//   pickup   — a photo of the items;
//   delivery — the customer's 4-digit code, or a door photo + a reason (the office checks it).
// Every step also sends the phone's GPS fix when it can get one. A step taken offline queues
// (photo included) and replays in order when signal returns.

const $ = (id) => document.getElementById(id);
const t = GMI18n.t;
let token = sessionStorage.getItem('driverToken') || null;
let current = null; // the job on screen
let photosOf = {}; // kind -> true, for the job on screen

const label = (s) => t(`drv.st.${s}`);
const STATUS_KIND = {
  PAID_UNASSIGNED: 'ok', DISPATCHED: 'info', IN_TRANSIT: 'info',
  DELIVERED: 'ok', FAILED_REFUND: 'down',
};
function setStatus(text, kind) {
  $('statusbar').classList.remove('hidden');
  $('sbText').textContent = text;
  $('sbTime').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('statusbar').className = 'statusbar ' + (kind || '');
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
    .then(GMConfig.readJson)
    .catch(() => ({ error: 'No connection.', offline: true }));

// Escape what came from the public (landmarks, item text) before it reaches innerHTML.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function showOnly(id) {
  ['loginView', 'setupView', 'queueView', 'detailView'].forEach((v) => $(v).classList.toggle('hidden', v !== id));
  window.scrollTo(0, 0);
}

// ── Login ──
async function login() {
  // The full number the country switch produced ("206 687 6538" alone isn't one).
  const msisdn = SomPhone.e164Of($('msisdn')) || $('msisdn').value.trim();
  const pin = $('pin').value.trim();
  $('loginBtn').disabled = true;
  const res = await api('/driver/login', { method: 'POST', body: JSON.stringify({ msisdn, pin }) });
  $('loginBtn').disabled = false;
  if (res.error) return toast(GMI18n.err(res.error));
  token = res.token;
  sessionStorage.setItem('driverToken', token);
  $('pin').value = '';
  showQueue();
}
$('loginBtn').addEventListener('click', login);
$('pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });

// ── Set up the account an admin created ──
if (window.SomPhone) SomPhone.attach({ input: $('sPhone'), hint: $('sPhoneHint') });
$('showSetup').addEventListener('click', () => showOnly('setupView'));
$('setupBack').addEventListener('click', () => showOnly('loginView'));
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
  const signIn = await api('/driver/login', { method: 'POST', body: JSON.stringify({ msisdn: phone, pin }) });
  $('sCode').value = ''; $('sPin').value = ''; $('sPin2').value = '';
  if (signIn.error) return showOnly('loginView');
  token = signIn.token;
  sessionStorage.setItem('driverToken', token);
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
  current = null;
  showOnly('queueView');
  setStatus(t('drv.signedIn'), 'ok');
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
  if (res.offline) return; // keep what's on screen; the queue view is still right
  if (res.error) { sessionStorage.removeItem('driverToken'); token = null; return location.reload(); }
  const orders = res.orders || [];
  $('countPick').textContent = orders.filter((o) => o.status === 'DISPATCHED').length;
  $('countDeliver').textContent = orders.filter((o) => o.status === 'IN_TRANSIT').length;
  $('queue').innerHTML = orders.length
    ? orders.map((o) => `
      <button class="tile" type="button" data-id="${o.id}">
        <span class="tile-icon">${o.status === 'IN_TRANSIT' ? '🛵' : '🛍️'}</span>
        <span class="tile-body">
          <span class="tile-title">${esc(o.landmark_text || t('drv.noLandmark'))}</span>
          <span class="tile-sub">${esc((o.items || [])[0]?.text || '')}</span>
          <span class="tile-sub">#${GMIds.shortId(o.id)} · $${Number(o.total_amount).toFixed(2)}
            · <strong style="color:var(--gold)">${label(o.status)}</strong></span>
        </span>
        <span class="chev">›</span>
      </button>`).join('')
    : `<div class="empty"><div class="big">🛵</div><p>${t('drv.none')}</p></div>`;
  $('queue').querySelectorAll('[data-id]').forEach((el) =>
    el.addEventListener('click', () => openDetail(el.dataset.id))
  );
}

async function openDetail(id) {
  const res = await api(`/driver/orders/${id}`);
  if (res.error) return toast(GMI18n.err(res.error));
  current = res.order;
  photosOf = {};
  showOnly('detailView');
  $('dOrderId').textContent = GMIds.shortId(current.id);
  $('dBudget').textContent = Number(current.total_amount).toFixed(2);
  $('dLandmark').textContent = current.landmark_text || t('drv.noLandmark');
  $('dItems').innerHTML = (current.items || [])
    .map((it) => `<div style="padding:4px 0;">• ${esc(it.text || JSON.stringify(it))}${it.price ? ` — $${esc(it.price)}` : ''}</div>`)
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

  renderStatus();
  await loadPhotos(current.id);
  renderActions();
}

function renderStatus() {
  const s = current.status;
  $('dStatus').textContent = label(s);
  $('dStatus').className = 'badge ' + (s === 'FAILED_REFUND' ? 'fail' : s === 'DELIVERED' ? 'ok' : 'info');
  $('stepPick').className = 'st ' + (s === 'DISPATCHED' ? 'now' : ['IN_TRANSIT', 'DELIVERED'].includes(s) ? 'done' : '');
  $('stepDeliver').className = 'st ' + (s === 'IN_TRANSIT' ? 'now' : s === 'DELIVERED' ? 'done' : '');
  $('stepPick').querySelector('i').textContent = $('stepPick').classList.contains('done') ? '✓' : '1';
  $('stepDeliver').querySelector('i').textContent = $('stepDeliver').classList.contains('done') ? '✓' : '2';
  setStatus(`#${GMIds.shortId(current.id)}: ${label(s)}`, STATUS_KIND[s]);
}

// ── Photos ──
const PHOTO_LABEL = { order_ref: 'photo.ref', pickup_proof: 'drv.pick.photo', delivery_proof: 'photo.proof' };
async function loadPhotos(orderId) {
  const el = $('dPhotos');
  try {
    const { photos } = await api(`/orders/${orderId}/photos`);
    (photos || []).forEach((p) => { photosOf[p.kind] = true; });
    if (!photos || !photos.length) { el.innerHTML = ''; return; }
    // Photo bytes are authorized, so a bare <img src> gets a 401 — fetch with the bearer
    // token and render from an object URL.
    el.innerHTML = photos.map((p) => `
      <figure class="photo">
        <img data-src="${p.url}" alt="" loading="lazy" />
        <figcaption class="muted">${t(PHOTO_LABEL[p.kind] || 'photo.ref')}</figcaption>
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

// Upload an evidence photo the moment it's taken. Offline, it queues — ahead of the step it
// supports, because the queue is FIFO and the server checks for the photo.
async function sendProofPhoto(kind, file) {
  const path = `/driver/orders/${current.id}/${kind === 'pickup_proof' ? 'pickup-proof' : 'delivery-proof'}`;
  const contentType = file.type || 'image/jpeg';
  const queue = async () => {
    await GMQueue.enqueue({ method: 'POST', path, body: file, contentType, label: 'Photo', orderId: current.id });
    toast(t('drv.saved'));
    return true;
  };
  if (!navigator.onLine) return queue();
  toast(t('drv.uploading'));
  try {
    const r = await fetch(GMConfig.api(path), {
      method: 'POST',
      headers: { 'Content-Type': contentType, Authorization: `Bearer ${token}` },
      body: file,
    });
    const body = await GMConfig.readJson(r);
    if (body.error) { toast(GMI18n.err(body.error)); return false; }
    toast(t('drv.photoOk'));
    return true;
  } catch {
    return queue();
  }
}

// Wire a .capture box: preview the picture, upload it, mark the step's photo as done.
function bindCapture(inputId, boxId, kind, onDone) {
  $(inputId).addEventListener('change', async () => {
    const file = $(inputId).files[0];
    if (!file) return;
    const box = $(boxId);
    const url = URL.createObjectURL(file);
    const thumb = box.querySelector('.thumb');
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    img.src = url;
    thumb.replaceWith(img);
    const ok = await sendProofPhoto(kind, file);
    if (!ok) { box.classList.remove('done'); return; }
    photosOf[kind] = true;
    box.classList.add('done');
    onDone();
    if (navigator.onLine) loadPhotos(current.id);
  });
}

const CAMERA_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';
function captureBox(id, inputId, titleKey, subKey, done) {
  return `<label class="capture${done ? ' done' : ''}" id="${id}">
      <input id="${inputId}" type="file" accept="image/*" capture="environment" />
      <span class="thumb">${done ? '✓' : CAMERA_SVG}</span>
      <span>${t(titleKey)}<span class="cap-sub">${t(subKey)}</span></span>
    </label>`;
}

// ── The step in hand ──
function renderActions() {
  const s = current.status;
  const box = $('actions');
  $('problemBox').classList.toggle('hidden', !['DISPATCHED', 'IN_TRANSIT'].includes(s));
  box.classList.remove('hidden');

  if (s === 'DISPATCHED') {
    box.innerHTML = `
      <div class="section-title">${t('drv.pick.title')}</div>
      <p class="muted" style="margin:0 0 12px;">${t('drv.pick.help')}</p>
      ${captureBox('pickCap', 'pickPhoto', 'drv.pick.photo', 'drv.pick.photoSub', photosOf.pickup_proof)}
      <button id="pickBtn" type="button" data-action="secured">${t('drv.pick.btn')}</button>`;
    const sync = () => { $('pickBtn').disabled = !photosOf.pickup_proof; };
    sync();
    bindCapture('pickPhoto', 'pickCap', 'pickup_proof', sync);
    $('pickBtn').addEventListener('click', () => doStep('secured', {}));
    return;
  }

  if (s === 'IN_TRANSIT') {
    box.innerHTML = `
      <div class="section-title">${t('drv.del.title')}</div>
      <p class="muted" style="margin:0 0 4px;">${t('drv.del.help')}</p>
      <label for="codeIn">${t('drv.del.code')}</label>
      <input id="codeIn" class="code-input" type="text" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="••••" />
      <div id="codeMsg" class="muted" style="margin-top:6px;min-height:18px;"></div>
      <button id="deliverBtn" type="button" data-action="delivered">${t('drv.del.btn')}</button>
      <details class="bare" id="noCodeBox" style="margin-top:14px;">
        <summary class="muted">${t('drv.del.noCode')}</summary>
        <div style="margin-top:12px;">
          ${captureBox('doorCap', 'doorPhoto', 'drv.del.photo', 'drv.del.photoSub', photosOf.delivery_proof)}
          <label for="noCodeReason">${t('drv.del.reason')}</label>
          <select id="noCodeReason">
            <option value="Customer's phone is off or dead">${t('drv.reason.phoneDead')}</option>
            <option value="Someone else took the items">${t('drv.reason.someoneElse')}</option>
            <option value="Customer can't find the code">${t('drv.reason.noCode')}</option>
          </select>
          <p class="muted" style="margin:10px 0 0;">${t('drv.del.flagNote')}</p>
          <button class="secondary" id="deliverPhotoBtn" type="button">${t('drv.del.photoBtn')}</button>
        </div>
      </details>`;
    $('codeIn').addEventListener('input', () => {
      $('codeIn').value = $('codeIn').value.replace(/\D/g, '').slice(0, 4);
      $('codeMsg').textContent = '';
    });
    $('deliverBtn').addEventListener('click', () => {
      const code = $('codeIn').value;
      if (!/^\d{4}$/.test(code)) return toast(t('drv.code.need'));
      doStep('delivered', { code });
    });
    const syncDoor = () => { $('deliverPhotoBtn').disabled = !photosOf.delivery_proof; };
    syncDoor();
    bindCapture('doorPhoto', 'doorCap', 'delivery_proof', syncDoor);
    $('deliverPhotoBtn').addEventListener('click', () =>
      doStep('delivered', { noCodeReason: $('noCodeReason').value }));
    return;
  }

  box.innerHTML = `<p class="muted" style="margin:0;">${t('drv.act.none')}</p>`;
}

// The driver's GPS fix, as evidence. Never a gate: no fix (denied, indoors, no GPS chip) just
// goes up as "no fix" and the office sees that.
function getFix() {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  });
}

// The state a given action moves the order to. Needed so the sync policy can tell "this
// already landed, the response was just lost" from a real conflict.
const ACTION_TARGET = { secured: 'IN_TRANSIT', delivered: 'DELIVERED', failed: 'FAILED_REFUND' };
const ACTION_LABEL = { secured: 'Items secured', delivered: 'Mark delivered', failed: 'Report failure' };

async function doStep(action, payload) {
  const buttons = $('detailView').querySelectorAll('button');
  buttons.forEach((b) => { b.disabled = true; });
  if (action !== 'failed') setStatus(t('drv.gps'), 'info');
  const fix = action === 'failed' ? null : await getFix();
  const body = JSON.stringify({ ...payload, ...(fix ? { fix } : {}) });
  const path = `/driver/orders/${current.id}/${action}`;
  const target = ACTION_TARGET[action];
  const queue = async () => {
    await GMQueue.enqueue({
      method: 'POST', path, body, label: ACTION_LABEL[action], orderId: current.id, transitionTo: target,
    });
    applyOptimistic(target);
    toast(t('drv.saved'));
  };

  try {
    // Offline: queue it and move the UI anyway. A driver standing in a dead zone has finished
    // the delivery — the app must not make them wait for a bar of signal to say so.
    if (!navigator.onLine) return await queue();
    const res = await api(path, { method: 'POST', body });
    if (res.offline) return await queue();
    if (res.error) {
      if (action === 'delivered' && payload.code !== undefined && $('codeMsg')) {
        $('codeMsg').textContent = res.triesLeft != null
          ? `${GMI18n.err(res.error)} ${t('drv.tries', { n: res.triesLeft })}`
          : GMI18n.err(res.error);
        $('codeMsg').style.color = 'var(--danger)';
        if (res.triesLeft === 0 || res.status === 423) $('noCodeBox').open = true;
        renderStatus();
        return;
      }
      renderStatus();
      return toast(GMI18n.err(res.error));
    }
    current = { ...current, ...res.order };
    renderStatus();
    renderActions();
    toast(t('drv.updated'));
    if (['DELIVERED', 'FAILED_REFUND'].includes(current.status)) setTimeout(showQueue, 900);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
    // Re-apply the photo gates the blanket enable just lifted.
    if ($('pickBtn')) $('pickBtn').disabled = !photosOf.pickup_proof;
    if ($('deliverPhotoBtn')) $('deliverPhotoBtn').disabled = !photosOf.delivery_proof;
  }
}

// Move the local view forward before the server has confirmed. The server is still the
// authority — if it later rejects, the queue surfaces "couldn't sync" rather than pretending.
function applyOptimistic(status) {
  if (!current || !status) return;
  current.status = status;
  renderStatus();
  $('dStatus').textContent = `${label(status)} ${t('drv.waiting')}`;
  renderActions();
}

// "Report a problem": two taps, because stopping an order can't be undone.
$('failBtn').addEventListener('click', () => {
  const b = $('failBtn');
  if (b.dataset.armed !== '1') {
    b.dataset.armed = '1';
    b.textContent = t('drv.fail.confirm');
    setTimeout(() => { b.dataset.armed = ''; b.textContent = t('drv.fail.btn'); }, 4000);
    return;
  }
  b.dataset.armed = '';
  b.textContent = t('drv.fail.btn');
  doStep('failed', { reason: $('failReason').value });
});

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

// ── Socket: refresh on any change to my jobs ──
let ws;
function connectSocket() {
  if (ws) return;
  ws = new WebSocket(GMConfig.wsUrl());
  // The token goes in the first frame (a browser can't set handshake headers, and a token in
  // the query string lands in every access log). Subscribing happens only once the server
  // has confirmed the session.
  ws.onopen = () => { ws.send(JSON.stringify({ type: 'auth', token })); };
  ws.onclose = () => { ws = null; if (token) setTimeout(connectSocket, 2500); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'authenticated') {
      // A driver's own feed — events for the orders assigned to THIS driver.
      ws.send(JSON.stringify({ type: 'subscribe_driver' }));
      return;
    }
    if (m.type === 'auth_error') {
      sessionStorage.removeItem('driverToken');
      token = null;
      return location.reload();
    }
    if (m.type === 'order_state' && current && String(m.orderId) === String(current.id) && m.to !== current.status) {
      current.status = m.to;
      renderStatus();
      renderActions();
    }
    if ((m.type === 'order_created' || m.type === 'order_state' || m.type === 'payment_confirmed')
        && !$('queueView').classList.contains('hidden')) {
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
  if (current && !$('detailView').classList.contains('hidden')) { renderStatus(); renderActions(); loadPhotos(current.id); }
  else { setStatus(t('drv.signedIn'), 'ok'); loadQueue(); }
});

let toastTimer;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; clearTimeout(toastTimer);
  // A failure to report stays up long enough to read the reference out.
  toastTimer = setTimeout(() => el.remove(), /ref [0-9a-f]{8}|\[\d{3}/.test(msg) ? 10000 : 3000);
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
