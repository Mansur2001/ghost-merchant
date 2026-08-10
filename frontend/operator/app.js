// Operator PWA — the emergency-override dashboard. The manual "Mark as Paid" button here
// is the difference between a broken system and a reliable business when the Oracle fails
// or a payment can't be auto-matched.

const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem('opToken') || null;

// Always-present merchant status bar: a live one-line feed of the latest system update.
function setStatus(text, kind) {
  $('sbText').textContent = text;
  $('sbTime').textContent = new Date().toLocaleTimeString();
  $('statusbar').className = 'statusbar ' + (kind || '');
}
const STATUS_LABEL = {
  PENDING_PAYMENT: 'awaiting payment', PAID_UNASSIGNED: 'paid — needs a driver',
  DISPATCHED: 'driver dispatched', IN_TRANSIT: 'in transit',
  DELIVERED: 'delivered', FAILED_REFUND: 'failed / refund',
};

// Live Somali-number hint on the add-driver field.
if (window.SomPhone) SomPhone.attach({ input: $('dMsisdn'), hint: $('phoneHint') });

const api = (path, opts = {}) =>
  fetch(GMConfig.api(path), {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  }).then((r) => r.json());

let me = null; // the signed-in operator (id, username, display_name, must_change_password)

async function login() {
  const username = $('username').value.trim();
  const password = $('password').value;
  if (!username || !password) return toast('Enter your username and password.');
  $('loginBtn').disabled = true;
  const res = await api('/operator/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  $('loginBtn').disabled = false;
  if (res.error) {
    // 429 carries retryAfter — say how long rather than just failing.
    $('loginHint').textContent = res.retryAfter
      ? `${res.error}. Try again in ${res.retryAfter}s.`
      : res.error;
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

$('logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem('opToken');
  token = null;
  location.reload();
});

async function showDash() {
  $('loginView').classList.add('hidden');
  $('dash').classList.remove('hidden');
  $('logoutBtn').classList.remove('hidden');
  await loadMe();
  setStatus(
    me ? `Signed in as ${me.display_name} (${me.username}) — monitoring live.`
       : 'Monitoring live — waiting for activity.',
    'ok'
  );
  refreshAll();
  connectSocket();
  setInterval(pollOracle, 20000);
  pollOracle();
}

// Resolve who we are from the token. Also catches the case where this account was
// deactivated while the tab sat open — the server answers 401 and we bounce to login.
async function loadMe() {
  const res = await api('/operator/me');
  if (res.error || !res.operator) {
    sessionStorage.removeItem('opToken');
    token = null;
    return location.reload();
  }
  me = res.operator;
  $('pwNag').classList.toggle('hidden', !me.must_change_password);
}

let drivers = []; // roster with workload stats, kept fresh for the assign picker

async function refreshAll() {
  await loadDrivers();                       // load first so order cards can build the picker
  await Promise.all([
    loadOrders(), loadUnmatched(), loadOperators(), loadRefunds(), loadAccessRequests(),
  ]);
}

// ── Operator roster (P0 #5) ──
async function loadOperators() {
  const res = await api('/operator/operators');
  const list = res.operators || [];
  $('operators').innerHTML = list.length
    ? list.map((o) => `
        <div class="card" style="background:var(--panel-2);">
          <div class="row" style="align-items:center;">
            <div>
              <strong>${escapeHtml(o.display_name)}</strong>
              <span class="muted"> @${escapeHtml(o.username)}</span>
              ${o.id === me?.id ? '<span class="muted"> — you</span>' : ''}
            </div>
            <span class="badge ${o.active ? 'paid' : 'fail'}" style="margin-left:auto;">
              ${o.active ? 'active' : 'disabled'}</span>
          </div>
          <div class="muted">
            ${o.last_login_at ? `last login ${new Date(o.last_login_at).toLocaleString()}` : 'never signed in'}
            ${o.must_change_password ? ' · must change password' : ''}
          </div>
          ${o.id === me?.id ? '' : `<button class="${o.active ? 'danger' : ''}" data-op="${o.id}"
             data-active="${o.active ? 'false' : 'true'}">${o.active ? 'Deactivate' : 'Reactivate'}</button>`}
        </div>`).join('')
    : '<p class="muted">No operators.</p>';
  $('operators').querySelectorAll('[data-op]').forEach((b) =>
    b.addEventListener('click', async () => {
      const res2 = await api(`/operator/operators/${b.dataset.op}/active`, {
        method: 'POST',
        body: JSON.stringify({ active: b.dataset.active === 'true' }),
      });
      if (res2.error) return toast(res2.error);
      toast('Updated ✓');
      loadOperators();
    })
  );
}

$('addOperator').addEventListener('click', async () => {
  const username = $('oUsername').value.trim();
  const displayName = $('oName').value.trim() || username;
  const password = $('oPassword').value;
  if (!username || !password) return toast('Username and password are required.');
  const res = await api('/operator/operators', {
    method: 'POST',
    body: JSON.stringify({ username, displayName, password }),
  });
  if (res.error) return toast(res.error);
  $('oUsername').value = ''; $('oName').value = ''; $('oPassword').value = '';
  toast('Operator created ✓');
  loadOperators();
});

$('changePw').addEventListener('click', async () => {
  const currentPassword = $('pwCurrent').value;
  const newPassword = $('pwNew').value;
  if (!currentPassword || !newPassword) return toast('Fill in both password fields.');
  const res = await api('/operator/me/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (res.error) return toast(res.error);
  $('pwCurrent').value = ''; $('pwNew').value = '';
  toast('Password changed ✓');
  loadMe();
});

// ── Refunds owed ──
// Settling means the operator actually sent money back from their own phone. The telecom
// reference is required because it is the only thing checkable against the telecom's records.
async function loadRefunds() {
  const res = await api('/operator/refunds');
  if (res.error) return;
  const list = res.refunds || [];

  const badge = $('refundTotal');
  badge.textContent = `$${res.total} owed`;
  badge.classList.toggle('hidden', list.length === 0);

  $('refunds').innerHTML = list.length
    ? list.map((r) => `
        <div class="card" style="background:var(--panel-2);">
          <div class="row" style="align-items:center;">
            <div><strong>$${Number(r.amount).toFixed(2)}</strong>
              <span class="muted"> · order #${GMIds.shortId(r.order?.id)}</span></div>
            <span class="muted" style="margin-left:auto;">${escapeHtml(r.order?.user_phone || '')}</span>
          </div>
          <div class="muted">${escapeHtml(r.reason || '')} · opened ${new Date(r.created_at).toLocaleDateString()}</div>
          <input placeholder="EVC / eDahab reference of the money you sent back"
                 id="ref-${r.id}" style="margin-top:8px;" />
          <input placeholder="note (optional)" id="note-${r.id}" style="margin-top:6px;" />
          <div class="row" style="margin-top:8px;">
            <button data-settle="${r.id}">Mark refunded</button>
            <button class="secondary" data-waive="${r.id}">Nothing owed</button>
          </div>
        </div>`).join('')
    : '<p class="muted">Nothing outstanding — every refund has been settled.</p>';

  $('refunds').querySelectorAll('[data-settle]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.settle;
      const reference = $(`ref-${id}`).value.trim();
      if (!reference) return toast('Enter the reference from the transfer you sent.');
      const out = await api(`/operator/refunds/${id}/settle`, {
        method: 'POST',
        body: JSON.stringify({ reference, note: $(`note-${id}`).value.trim() }),
      });
      if (out.error) return toast(out.error);
      toast('Refund recorded ✓');
      loadRefunds();
    })
  );
  $('refunds').querySelectorAll('[data-waive]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.waive;
      const note = $(`note-${id}`).value.trim();
      if (!note) return toast('Say why nothing is owed — the ledger has to explain itself.');
      const out = await api(`/operator/refunds/${id}/waive`, {
        method: 'POST',
        body: JSON.stringify({ note }),
      });
      if (out.error) return toast(out.error);
      toast('Closed ✓');
      loadRefunds();
    })
  );

  $('refundsClosed').innerHTML = (res.settled || []).length
    ? res.settled.map((r) => `
        <div class="row" style="padding:6px 0;border-bottom:1px solid var(--border,#333);">
          <span>$${Number(r.amount).toFixed(2)} · ${r.status}</span>
          <span class="muted" style="margin-left:auto;">
            ${escapeHtml(r.settlement_reference || r.settlement_note || '')}</span>
        </div>`).join('')
    : '<p class="muted">Nothing closed yet.</p>';
}

// ── Access requests ──
// Reviewing records a decision. It does NOT create an account — that stays a deliberate act
// with a password typed for it, in the forms below.
async function loadAccessRequests() {
  const res = await api('/operator/access-requests');
  if (res.error) return;
  const list = res.requests || [];

  const badge = $('requestCount');
  const fresh = list.filter((r) => r.status === 'new').length;
  badge.textContent = `${fresh} new`;
  badge.classList.toggle('hidden', fresh === 0);

  $('accessRequests').innerHTML = list.length
    ? list.map((r) => `
        <div class="card" style="background:var(--panel-2);">
          <div class="row" style="align-items:center;">
            <div><strong>${escapeHtml(r.name)}</strong>
              <span class="muted"> wants to be a ${escapeHtml(r.role)}</span></div>
            <span class="badge ${r.status === 'new' ? 'pending' : 'paid'}"
                  style="margin-left:auto;">${escapeHtml(r.status)}</span>
          </div>
          <div class="muted">
            <a href="tel:${escapeHtml(r.phone)}">${escapeHtml(r.phone)}</a>
            · ${new Date(r.created_at).toLocaleDateString()}
          </div>
          ${r.message ? `<div style="margin-top:6px;">${escapeHtml(r.message)}</div>` : ''}
          <div class="row" style="margin-top:8px;">
            <button class="secondary" data-req="${r.id}" data-status="contacted">Called them</button>
            <button data-req="${r.id}" data-status="approved">Approved</button>
            <button class="danger" data-req="${r.id}" data-status="declined">Decline</button>
          </div>
        </div>`).join('')
    : '<p class="muted">No open requests.</p>';

  $('accessRequests').querySelectorAll('[data-req]').forEach((b) =>
    b.addEventListener('click', async () => {
      const out = await api(`/operator/access-requests/${b.dataset.req}/review`, {
        method: 'POST',
        body: JSON.stringify({ status: b.dataset.status }),
      });
      if (out.error) return toast(out.error);
      toast(
        b.dataset.status === 'approved'
          ? 'Marked approved — now create their account below.'
          : 'Updated ✓'
      );
      loadAccessRequests();
    })
  );
}

// Operator-supplied names land in innerHTML; escape them rather than trusting the roster.
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadDrivers() {
  const res = await api('/operator/drivers');
  drivers = res.drivers || [];
  $('drivers').innerHTML = drivers.length
    ? drivers.map((d) => `
      <div class="card" style="background:var(--panel-2);">
        <div class="row" style="align-items:center;">
          <div><strong>${d.name}</strong> · ${d.msisdn}</div>
          <span class="badge ${d.active ? 'paid' : 'fail'}">${d.active ? 'active' : 'off'}</span>
        </div>
        <div class="muted">${d.active_orders} active · ${d.delivered_orders} delivered</div>
      </div>`).join('')
    : '<p class="muted">No drivers yet — add one below.</p>';
}

// <option> list of assignable (active) drivers for an order's assign picker.
function driverOptions() {
  const opts = drivers.filter((d) => d.active).map((d) =>
    `<option value="${d.id}">${d.name}${d.active_orders > 0 ? ` (${d.active_orders} active)` : ''}</option>`);
  return `<option value="">Assign driver…</option>${opts.join('')}`;
}

async function loadOrders() {
  const res = await api('/operator/orders');
  if (res.error) { logout(); return; }
  const orders = res.orders || [];
  $('orders').innerHTML = orders.length
    ? orders.map((o) => `
      <div class="card" style="background:var(--panel-2);">
        <div class="row" style="align-items:center;">
          <div><strong>#${GMIds.shortId(o.id)}</strong> · $${Number(o.total_amount).toFixed(2)} · ${o.user_phone}</div>
          <span class="badge ${badgeClass(o.status)}">${o.status}</span>
        </div>
        <div class="muted">${o.landmark_text || ''} ${o.driver_name ? '· driver: ' + o.driver_name : ''}</div>
        <div class="photos" id="opPhotos-${o.id}"></div>
        ${o.status === 'PAID_UNASSIGNED' ? `
        <div class="row" style="margin-top:8px;">
          <select data-assign="${o.id}">${driverOptions()}</select>
          <button data-assignbtn="${o.id}" style="max-width:110px;">Assign</button>
        </div>` : ''}
        <div class="row" style="margin-top:8px;">
          ${o.status === 'PENDING_PAYMENT' ? `<button data-act="mark-paid" data-id="${o.id}">Mark as paid (override)</button>` : ''}
          ${o.status !== 'FAILED_REFUND' ? `<button class="danger" data-act="refund" data-id="${o.id}">Refund / fail</button>` : ''}
        </div>
      </div>`).join('')
    : '<p class="muted">No active orders.</p>';
  bindOrderButtons();
  orders.forEach((o) => loadCardPhotos(o.id));
}

// Lazily hydrate each order card with its photo thumbnails (reference + delivery proof).
async function loadCardPhotos(orderId) {
  try {
    const { photos } = await api(`/orders/${orderId}/photos`);
    const el = $(`opPhotos-${orderId}`);
    if (!el || !photos || !photos.length) return;
    // Photo bytes are authorized now, so a bare <img src> would 401 — fetch each with the
    // bearer token and render from an object URL.
    el.innerHTML = photos.map((p) => `
      <figure class="photo">
        <img data-src="${p.url}" alt="${p.kind}" loading="lazy" />
        <figcaption class="muted">${p.kind === 'delivery_proof' ? 'Proof' : 'Reference'}</figcaption>
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

function bindOrderButtons() {
  $('orders').querySelectorAll('[data-act]').forEach((b) =>
    b.addEventListener('click', async () => {
      const { act, id } = b.dataset;
      const path = act === 'mark-paid' ? `/operator/orders/${id}/mark-paid` : `/operator/orders/${id}/refund`;
      const res = await api(path, { method: 'POST', body: JSON.stringify({}) });
      if (res.error) return toast(res.error);
      toast('Done ✓');
      refreshAll();
    })
  );
  // Explicit operator→driver dispatch.
  $('orders').querySelectorAll('[data-assignbtn]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.assignbtn;
      const driverId = $('orders').querySelector(`[data-assign="${id}"]`).value;
      if (!driverId) return toast('Pick a driver first.');
      const res = await api(`/operator/orders/${id}/assign`, { method: 'POST', body: JSON.stringify({ driverId }) });
      if (res.error) return toast(res.error);
      toast('Driver assigned ✓');
      refreshAll();
    })
  );
}

async function loadUnmatched() {
  const res = await api('/operator/transactions/unmatched');
  const txs = res.transactions || [];
  $('unmatched').innerHTML = txs.length
    ? txs.map((t) => `
      <div class="card" style="background:var(--panel-2);">
        <div>$${Number(t.amount).toFixed(2)} from ${t.sender_msisdn}</div>
        <div class="muted">receipt ${t.telecom_receipt_id}</div>
        <div class="row" style="margin-top:8px;">
          <input placeholder="order # to bind" data-txin="${t.id}" />
          <button data-txassign="${t.id}" style="max-width:120px;">Assign</button>
        </div>
      </div>`).join('')
    : '<p class="muted">Nothing to reconcile.</p>';
  $('unmatched').querySelectorAll('[data-txassign]').forEach((b) =>
    b.addEventListener('click', async () => {
      const txId = b.dataset.txassign;
      const orderId = $('unmatched').querySelector(`[data-txin="${txId}"]`).value.trim();
      if (!orderId) return toast('Enter an order number.');
      const res = await api(`/operator/transactions/${txId}/assign`, { method: 'POST', body: JSON.stringify({ orderId }) });
      if (res.error) return toast(res.error);
      toast('Reconciled ✓'); refreshAll();
    })
  );
}

$('addDriver').addEventListener('click', async () => {
  const name = $('dName').value.trim(), msisdn = $('dMsisdn').value.trim(), pin = $('dPin').value.trim();
  if (!name || !msisdn || !pin) return toast('All fields required.');
  const res = await api('/operator/drivers', { method: 'POST', body: JSON.stringify({ name, msisdn, pin }) });
  if (res.error) return toast(res.error);
  $('dName').value = $('dMsisdn').value = $('dPin').value = '';
  toast('Driver created ✓');
});

async function pollOracle() {
  const res = await api('/operator/oracle');
  setOracleBadge(res);
  pollOutbox();
}

// Event-relay backlog. Silent while healthy — an always-on green badge trains people to
// ignore it, and this one only matters when it's wrong.
async function pollOutbox() {
  const res = await api('/operator/outbox');
  const b = $('outboxBadge');
  if (res.error) return b.classList.add('hidden');
  const stuck = res.pending > 20 || res.oldest_pending_seconds > 30 || res.parked > 0;
  b.classList.toggle('hidden', !stuck);
  if (stuck) {
    b.textContent = res.parked > 0
      ? `Events: ${res.parked} PARKED`
      : `Events: ${res.pending} behind (${res.oldest_pending_seconds}s)`;
    setStatus(
      res.parked > 0
        ? `⚠ ${res.parked} event(s) could not be delivered — clients may show stale state.`
        : `⚠ Event relay is ${res.oldest_pending_seconds}s behind — live updates are delayed.`,
      'down'
    );
  }
}
// Three states, because "we never had an Oracle" and "the Oracle died" are different
// situations and only one of them is an emergency. Showing a permanent red DOWN for a phone
// that was never deployed teaches the operator to ignore the badge that matters.
function setOracleBadge(status) {
  const b = $('oracleBadge');
  const state = typeof status === 'object' ? status.state : (status ? 'healthy' : 'down');

  if (state === 'not_configured') {
    b.textContent = 'Payments: manual';
    b.className = 'badge pending';
    b.title = status?.detail || 'No Oracle phone connected — confirm payments by hand.';
    return;
  }
  if (state === 'healthy') {
    b.textContent = 'Oracle: healthy';
    b.className = 'badge paid';
    b.title = 'Payment receipts are being matched automatically.';
    return;
  }
  b.textContent = 'Oracle: DOWN';
  b.className = 'badge fail';
  b.title = status?.detail || 'The Oracle stopped reporting.';
}

let ws;
function connectSocket() {
  ws = new WebSocket(GMConfig.wsUrl());
  // Authenticate in the first frame, then subscribe. subscribe_operator is now role-gated —
  // before this, any client could send it and receive every order in the system.
  ws.onopen = () => { $('liveDot').classList.add('on'); ws.send(JSON.stringify({ type: 'auth', token })); };
  ws.onclose = () => { $('liveDot').classList.remove('on'); if (token) setTimeout(connectSocket, 2500); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'authenticated') {
      return ws.send(JSON.stringify({ type: 'subscribe_operator' }));
    }
    if (m.type === 'auth_error') {
      sessionStorage.removeItem('opToken');
      token = null;
      return location.reload();
    }
    if (m.type === 'oracle_down') {
      setOracleBadge({ state: 'down' });
      setStatus('⚠ Oracle DOWN — payment receipts may be missed. Check the phone.', 'down');
    } else if (m.type === 'oracle_heartbeat') {
      setOracleBadge({ state: 'healthy' });
    } else if (m.type === 'order_created') {
      setStatus(`New order #${GMIds.shortId(m.orderId)} created — awaiting payment.`, 'warn');
      refreshAll();
    } else if (m.type === 'payment_confirmed') {
      setStatus(`Payment confirmed on order #${GMIds.shortId(m.orderId)} ($${Number(m.amount).toFixed(2)}).`, 'ok');
      refreshAll();
    } else if (m.type === 'order_state') {
      setStatus(`Order #${GMIds.shortId(m.orderId)}: ${STATUS_LABEL[m.to] || m.to}.`, m.to === 'FAILED_REFUND' ? 'down' : 'info');
      refreshAll();
    }
  };
}

function badgeClass(s) { return s === 'FAILED_REFUND' ? 'fail' : s === 'PENDING_PAYMENT' ? 'pending' : 'paid'; }
function logout() { sessionStorage.removeItem('opToken'); token = null; location.reload(); }
let toastTimer;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3000);
}

if (token) showDash();

// ── Service worker ──
// Registered here rather than in an inline <script> so the page can run under a strict
// Content-Security-Policy (script-src 'self'), which is what blocks injected script.
// Skipped in the native shell: Capacitor bundles the assets into the APK, so a service
// worker would be a second, stale copy of the app competing with the real one.
if ('serviceWorker' in navigator && !GMConfig.isNative()) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/operator/sw.js'));
}
