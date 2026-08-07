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
  fetch(`/api${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  }).then((r) => r.json());

$('loginBtn').addEventListener('click', async () => {
  const password = $('password').value;
  const res = await api('/operator/login', { method: 'POST', body: JSON.stringify({ password }) });
  if (res.error) return toast(res.error);
  token = res.token;
  sessionStorage.setItem('opToken', token);
  showDash();
});

$('logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem('opToken');
  token = null;
  location.reload();
});

function showDash() {
  $('loginView').classList.add('hidden');
  $('dash').classList.remove('hidden');
  $('logoutBtn').classList.remove('hidden');
  setStatus('Monitoring live — waiting for activity.', 'ok');
  refreshAll();
  connectSocket();
  setInterval(pollOracle, 20000);
  pollOracle();
}

let drivers = []; // roster with workload stats, kept fresh for the assign picker

async function refreshAll() {
  await loadDrivers();                       // load first so order cards can build the picker
  await Promise.all([loadOrders(), loadUnmatched()]);
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
          <div><strong>#${o.id}</strong> · $${Number(o.total_amount).toFixed(2)} · ${o.user_phone}</div>
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
        const r = await fetch(img.dataset.src, { headers: { Authorization: `Bearer ${token}` } });
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
  setOracleBadge(res.healthy);
}
function setOracleBadge(healthy) {
  const b = $('oracleBadge');
  b.textContent = healthy ? 'Oracle: healthy' : 'Oracle: DOWN';
  b.className = 'badge ' + (healthy ? 'paid' : 'fail');
}

let ws;
function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
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
      setOracleBadge(false);
      setStatus('⚠ Oracle DOWN — payment receipts may be missed. Check the phone.', 'down');
    } else if (m.type === 'oracle_heartbeat') {
      setOracleBadge(true);
    } else if (m.type === 'order_created') {
      setStatus(`New order #${m.orderId} created — awaiting payment.`, 'warn');
      refreshAll();
    } else if (m.type === 'payment_confirmed') {
      setStatus(`Payment confirmed on order #${m.orderId} ($${Number(m.amount).toFixed(2)}).`, 'ok');
      refreshAll();
    } else if (m.type === 'order_state') {
      setStatus(`Order #${m.orderId}: ${STATUS_LABEL[m.to] || m.to}.`, m.to === 'FAILED_REFUND' ? 'down' : 'info');
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
