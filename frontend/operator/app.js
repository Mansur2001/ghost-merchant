// Operator PWA — the dispatch desk. Nothing reads payment receipts automatically: the operator
// checks the merchant phone and confirms each payment here, so "Confirm payment" is the step
// every order passes through. Customers who tap "I've paid" are surfaced first.

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

// Live phone-number hints on every number field.
if (window.SomPhone) {
  SomPhone.attach({ input: $('dMsisdn'), hint: $('phoneHint') });
  SomPhone.attach({ input: $('oPhone'), hint: $('oPhoneHint') });
  SomPhone.attach({ input: $('sPhone'), hint: $('sPhoneHint') });
}

// What a create / re-send answered. In development (no SMS sent) the code is shown so the
// flow can be tested; in production it only ever travels by text message.
function setupCodeToast(res, fallbackName) {
  if (res.error && !res.account && !res.role) return toast(res.error);
  const who = res.account?.name || res.account?.display_name || fallbackName;
  if (res.devCode) return toast(`Dev mode — setup code for ${who}: ${res.devCode}`);
  if (res.error) return toast(res.error); // account exists, but the text failed: re-send
  toast(`Setup code texted to ${who} ✓`);
}

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

// ── Set up an account an admin created ──
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
  const secret = $('sPass').value;
  if (!phone || !/^\d{8}$/.test(code)) return toast('Enter your phone number and the 8-digit code.');
  if (secret !== $('sPass2').value) return toast('The two passwords do not match.');
  $('setupBtn').disabled = true;
  const res = await api('/staff/setup', {
    method: 'POST',
    body: JSON.stringify({ role: 'operator', phone, code, secret }),
  });
  $('setupBtn').disabled = false;
  if (res.error) { $('setupHint').textContent = res.error; return; }
  // Signed straight in with the password they just chose; the username is theirs to keep.
  $('sCode').value = ''; $('sPass').value = ''; $('sPass2').value = '';
  $('username').value = res.username;
  $('password').value = secret;
  $('setupView').classList.add('hidden');
  $('loginView').classList.remove('hidden');
  toast(`Welcome, ${res.name}. Your username is ${res.username}.`);
  login();
});
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
  setInterval(pollOutbox, 20000);
  pollOutbox();
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
  // Staff management is admin-only on the server; hiding it here just keeps the screen honest.
  document.querySelectorAll('.admin-only').forEach((el) => el.classList.toggle('hidden', !me.is_admin));
}

// Shown only while the system is genuinely new. Disappears on its own as each step is done,
// so it never becomes furniture an experienced operator has to look past.
function renderFirstRun({ drivers: driverCount, orders: orderCount }) {
  const el = $('firstRun');
  if (!el) return;
  const steps = [];
  if (me?.must_change_password) {
    steps.push('Change your password below — the current one came from the server config file.');
  }
  if (driverCount === 0) {
    steps.push(me?.is_admin
      ? 'Add a driver. Until there is one, orders can be paid for but never dispatched.'
      : 'Ask an admin to add a driver. Until there is one, orders can be paid for but never dispatched.');
  }
  if (driverCount > 0 && orderCount === 0) {
    steps.push('Ready. Place a test order from the customer app to watch it come through.');
  }
  el.innerHTML = steps.length
    ? `<h3 style="margin:0 0 8px;">Getting started</h3><ul style="margin:0;padding-left:18px;">
       ${steps.map((t) => `<li class="muted" style="margin-bottom:6px;">${t}</li>`).join('')}</ul>`
    : '';
  el.classList.toggle('hidden', steps.length === 0);
}

let drivers = []; // roster with workload stats, kept fresh for the assign picker

async function refreshAll() {
  await loadDrivers();                       // load first so order cards can build the picker
  const [orderCount] = await Promise.all([
    loadOrders(), loadRefunds(),
    ...(me?.is_admin ? [loadOperators(), loadAccessRequests()] : []),
  ]);
  renderFirstRun({ drivers: drivers.length, orders: orderCount ?? 0 });
}

// ── Operator roster (admin only) ──
async function loadOperators() {
  const res = await api('/operator/operators');
  if (res.error) return;
  const list = res.operators || [];
  $('operators').innerHTML = list.length
    ? list.map((o) => {
        const self = o.id === me?.id;
        return `
        <div class="card" style="background:var(--panel-2);">
          <div class="row" style="align-items:center;">
            <div>
              <strong>${escapeHtml(o.display_name)}</strong>
              <span class="muted"> @${escapeHtml(o.username)}</span>
              ${self ? '<span class="muted"> — you</span>' : ''}
            </div>
            <span style="margin-left:auto;">
              ${o.is_admin ? '<span class="badge paid">admin</span>' : ''}
              <span class="badge ${o.active ? 'paid' : 'fail'}">${o.active ? 'active' : 'disabled'}</span>
            </span>
          </div>
          <div class="muted">
            ${o.setup_pending ? 'setup code sent · ' : ''}
            ${o.last_login_at ? `last login ${new Date(o.last_login_at).toLocaleString()}` : 'never signed in'}
            ${o.must_change_password ? ' · must change password' : ''}
          </div>
          <div class="row" style="margin-top:8px;flex-wrap:wrap;">
            ${self ? '' : `<button class="${o.active ? 'danger' : ''}" data-op="${o.id}"
               data-active="${o.active ? 'false' : 'true'}">${o.active ? 'Deactivate' : 'Reactivate'}</button>`}
            ${o.active ? `<button class="secondary" data-opadmin="${o.id}" data-admin="${o.is_admin ? 'false' : 'true'}">
               ${o.is_admin ? 'Remove admin' : 'Make admin'}</button>` : ''}
            ${o.active && o.phone && !self ? `<button class="secondary" data-opcode="${o.id}">
               ${o.setup_pending ? 'Re-send setup code' : 'Reset password by text'}</button>` : ''}
          </div>
        </div>`;
      }).join('')
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
  $('operators').querySelectorAll('[data-opadmin]').forEach((b) =>
    b.addEventListener('click', async () => {
      const res2 = await api(`/operator/operators/${b.dataset.opadmin}/admin`, {
        method: 'POST',
        body: JSON.stringify({ admin: b.dataset.admin === 'true' }),
      });
      if (res2.error) return toast(res2.error);
      toast('Updated ✓');
      await loadMe(); // you may have just changed your own rights
      loadOperators();
    })
  );
  $('operators').querySelectorAll('[data-opcode]').forEach((b) =>
    b.addEventListener('click', async () => {
      const res2 = await api(`/operator/staff/operator/${b.dataset.opcode}/setup-code`, { method: 'POST' });
      setupCodeToast(res2, 'the operator');
      loadOperators();
    })
  );
}

$('addOperator').addEventListener('click', async () => {
  const displayName = $('oName').value.trim();
  const username = $('oUsername').value.trim();
  const phone = SomPhone.e164Of($('oPhone')) || $('oPhone').value.trim();
  if (!displayName || !username || !phone) return toast('Name, username and phone are required.');
  const res = await api('/operator/operators', {
    method: 'POST',
    body: JSON.stringify({ username, displayName, phone }),
  });
  if (res.error && !res.account) return toast(res.error);
  $('oUsername').value = ''; $('oName').value = ''; $('oPhone').value = '';
  setupCodeToast(res, displayName);
  loadOperators();
});

// Suggest a username from the name, until the admin types their own.
$('oName').addEventListener('input', () => {
  if ($('oUsername').dataset.touched) return;
  $('oUsername').value = suggestUsername($('oName').value);
});
$('oUsername').addEventListener('input', () => { $('oUsername').dataset.touched = '1'; });

function suggestUsername(name) {
  const base = String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 32);
  return base.length >= 3 ? base : '';
}

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
    // Careful with the wording: on day one nothing has EVER been settled, so claiming
    // everything has been is simply false.
    : `<p class="muted">${res.settled?.length
        ? 'Nothing outstanding — every refund has been settled.'
        : 'No refunds owed. This fills up when you fail an order that was already paid for.'}</p>`;

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

// ── Access requests (admin only) ──
// Two separate steps, on purpose: Approve records the decision; "Create account" mints the
// credential and texts them a setup code. An approved request stays here until it's done.
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
          ${r.id_document_at
            ? `<div style="margin-top:8px;">
                 <button class="secondary" data-idreq="${r.id}" data-side="front" style="max-width:120px;">ID front</button>
                 <button class="secondary" data-idreq="${r.id}" data-side="back" style="max-width:120px;">ID back</button>
                 <div class="muted" style="font-size:12px;margin-top:4px;">
                   Both sides deleted automatically once you approve or decline.</div>
                 <div data-idimg="${r.id}-front"></div>
                 <div data-idimg="${r.id}-back"></div>
               </div>`
            : '<div class="muted" style="margin-top:6px;font-size:13px;">No ID attached.</div>'}
          ${r.status === 'approved' ? `
          <div style="margin-top:8px;">
            ${r.role === 'operator' ? `<input data-requser="${r.id}" placeholder="username"
               value="${escapeHtml(suggestUsername(r.name))}" autocapitalize="none" spellcheck="false" />` : ''}
            <button data-reqacct="${r.id}" style="margin-top:6px;">Create account &amp; text setup code</button>
          </div>` : `
          <div class="row" style="margin-top:8px;">
            <button class="secondary" data-req="${r.id}" data-status="contacted">Called them</button>
            <button data-req="${r.id}" data-status="approved">Approve</button>
            <button class="danger" data-req="${r.id}" data-status="declined">Decline</button>
          </div>`}
        </div>`).join('')
    : '<p class="muted">No open requests. People who ask to drive or help run deliveries '
      + 'appear here for you to approve.</p>';

  // The ID is fetched on demand, not with the list: it is the most sensitive thing here, and
  // rendering every applicant's document by default would put a wall of government IDs on
  // screen in a shared office.
  $('accessRequests').querySelectorAll('[data-idreq]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.idreq;
      const side = b.dataset.side;
      const holder = $('accessRequests').querySelector(`[data-idimg="${id}-${side}"]`);
      if (holder.dataset.shown) { // toggle off
        holder.innerHTML = ''; delete holder.dataset.shown; b.textContent = `ID ${side}`;
        return;
      }
      try {
        const r = await fetch(GMConfig.api(`/operator/access-requests/${id}/id-document/${side}`), {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return toast(`No ${side} image was uploaded.`);
        const url = URL.createObjectURL(await r.blob());
        holder.innerHTML = `<img src="${url}" alt="ID ${side}"
          style="max-width:100%;margin-top:8px;border-radius:6px;" />`;
        holder.querySelector('img').addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
        holder.dataset.shown = '1';
        b.textContent = `Hide ${side}`;
      } catch { toast('Could not load the ID document.'); }
    })
  );

  $('accessRequests').querySelectorAll('[data-req]').forEach((b) =>
    b.addEventListener('click', async () => {
      const out = await api(`/operator/access-requests/${b.dataset.req}/review`, {
        method: 'POST',
        body: JSON.stringify({ status: b.dataset.status }),
      });
      if (out.error) return toast(out.error);
      toast(
        b.dataset.status === 'approved'
          ? 'Approved — now create their account. Their ID has been deleted.'
          : b.dataset.status === 'declined'
            ? 'Declined — their ID has been deleted.'
            : 'Updated ✓'
      );
      loadAccessRequests();
    })
  );

  $('accessRequests').querySelectorAll('[data-reqacct]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.reqacct;
      const userInput = $('accessRequests').querySelector(`[data-requser="${id}"]`);
      b.disabled = true;
      const out = await api(`/operator/access-requests/${id}/account`, {
        method: 'POST',
        body: JSON.stringify(userInput ? { username: userInput.value.trim() } : {}),
      });
      b.disabled = false;
      if (out.error && !out.account) return toast(out.error);
      setupCodeToast(out, 'the applicant');
      refreshAll();
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
  // Names come from the public request form now — escape everything.
  $('drivers').innerHTML = drivers.length
    ? drivers.map((d) => `
      <div class="card" style="background:var(--panel-2);">
        <div class="row" style="align-items:center;">
          <div><strong>${escapeHtml(d.name)}</strong> · ${escapeHtml(d.msisdn)}</div>
          <span style="margin-left:auto;">
            ${d.setup_pending ? '<span class="badge pending">waiting for setup</span>' : ''}
            <span class="badge ${d.active ? 'paid' : 'fail'}">${d.active ? 'active' : 'off'}</span>
          </span>
        </div>
        <div class="muted">${d.active_orders} active · ${d.delivered_orders} delivered</div>
        ${me?.is_admin ? `
        <div class="row" style="margin-top:8px;">
          ${d.active ? `<button class="secondary" data-drvcode="${d.id}">
             ${d.setup_pending ? 'Re-send setup code' : 'Reset PIN by text'}</button>` : ''}
          <button class="${d.active ? 'danger' : ''}" data-drvactive="${d.id}" data-active="${d.active ? 'false' : 'true'}">
             ${d.active ? 'Deactivate' : 'Reactivate'}</button>
        </div>` : ''}
      </div>`).join('')
    : `<p class="muted">No drivers yet${me?.is_admin ? ' — add one below' : ''}.</p>`;

  $('drivers').querySelectorAll('[data-drvcode]').forEach((b) =>
    b.addEventListener('click', async () => {
      const out = await api(`/operator/staff/driver/${b.dataset.drvcode}/setup-code`, { method: 'POST' });
      setupCodeToast(out, 'the driver');
      loadDrivers();
    })
  );
  $('drivers').querySelectorAll('[data-drvactive]').forEach((b) =>
    b.addEventListener('click', async () => {
      const out = await api(`/operator/drivers/${b.dataset.drvactive}/active`, {
        method: 'POST',
        body: JSON.stringify({ active: b.dataset.active === 'true' }),
      });
      if (out.error) return toast(out.error);
      toast('Updated ✓');
      loadDrivers();
    })
  );
}

// <option> list of assignable (active) drivers for an order's assign picker.
function driverOptions() {
  const opts = drivers.filter((d) => d.active).map((d) =>
    `<option value="${d.id}">${escapeHtml(d.name)}${d.active_orders > 0 ? ` (${d.active_orders} active)` : ''}</option>`);
  return `<option value="">Assign driver…</option>${opts.join('')}`;
}

async function loadOrders() {
  const res = await api('/operator/orders');
  if (res.error) { logout(); return 0; }
  // Customers who said "I've paid" first (oldest claim first): that's money waiting on you.
  const orders = (res.orders || []).slice().sort((a, b) => {
    const ca = a.status === 'PENDING_PAYMENT' && a.payment_claimed_at;
    const cb = b.status === 'PENDING_PAYMENT' && b.payment_claimed_at;
    if (ca && cb) return new Date(a.payment_claimed_at) - new Date(b.payment_claimed_at);
    return ca ? -1 : cb ? 1 : 0;
  });
  $('orders').innerHTML = orders.length
    ? orders.map((o) => {
        const claimed = o.status === 'PENDING_PAYMENT' && o.payment_claimed_at;
        return `
      <div class="card" style="background:var(--panel-2);${claimed ? 'border-color:var(--accent);' : ''}">
        <div class="row" style="align-items:center;">
          <div><strong>#${GMIds.shortId(o.id)}</strong> · $${Number(o.total_amount).toFixed(2)} · ${escapeHtml(o.user_phone)}</div>
          <span class="badge ${badgeClass(o.status)}">${o.status}</span>
        </div>
        <div class="muted">${escapeHtml(o.landmark_text || '')} ${o.driver_name ? '· driver: ' + escapeHtml(o.driver_name) : ''}</div>
        ${claimed ? `<div style="margin-top:6px;"><strong>💰 Customer says they paid</strong>
          <span class="muted">${o.payment_claim_ref ? `· ref ${escapeHtml(o.payment_claim_ref)} ` : ''}· ${timeAgo(o.payment_claimed_at)}</span></div>` : ''}
        <div class="photos" id="opPhotos-${o.id}"></div>
        ${o.status === 'PAID_UNASSIGNED' ? `
        <div class="row" style="margin-top:8px;">
          <select data-assign="${o.id}">${driverOptions()}</select>
          <button data-assignbtn="${o.id}" style="max-width:110px;">Assign</button>
        </div>` : ''}
        ${o.status === 'PENDING_PAYMENT' ? `
        <div style="margin-top:8px;">
          <input data-payref="${o.id}" placeholder="Transaction number from the merchant phone"
                 value="${escapeHtml(o.payment_claim_ref || '')}" autocapitalize="characters" spellcheck="false" />
          <button data-confirm="${o.id}" style="margin-top:6px;">Confirm payment — $${Number(o.total_amount).toFixed(2)} received</button>
        </div>` : ''}
        <div class="row" style="margin-top:8px;">
          ${o.status !== 'FAILED_REFUND' ? `<button class="danger" data-act="refund" data-id="${o.id}">Refund / fail</button>` : ''}
        </div>
      </div>`;
      }).join('')
    : '<p class="muted">No active orders. Orders appear here the moment a customer places one — '
      + 'you don\'t need to refresh.</p>';
  bindOrderButtons();
  orders.forEach((o) => loadCardPhotos(o.id));
  return orders.length;
}

function timeAgo(when) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(when).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} h ago` : new Date(when).toLocaleString();
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
  $('orders').querySelectorAll('[data-act="refund"]').forEach((b) =>
    b.addEventListener('click', async () => {
      const res = await api(`/operator/orders/${b.dataset.id}/refund`, { method: 'POST', body: JSON.stringify({}) });
      if (res.error) return toast(res.error);
      toast('Done ✓');
      refreshAll();
    })
  );
  // Confirm only after seeing the money on the merchant phone. The transaction number ties
  // this payment to this order: the same number can't confirm a second order.
  $('orders').querySelectorAll('[data-confirm]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.confirm;
      const reference = $('orders').querySelector(`[data-payref="${id}"]`).value.trim();
      if (!reference && b.dataset.noref !== '1') {
        b.dataset.noref = '1';
        b.textContent = 'Confirm WITHOUT a transaction number?';
        return toast('Adding the transaction number stops one payment being used for two orders.');
      }
      b.disabled = true;
      const res = await api(`/operator/orders/${id}/mark-paid`, { method: 'POST', body: JSON.stringify({ reference }) });
      b.disabled = false;
      if (res.error) return toast(res.error);
      toast('Payment confirmed ✓ — the customer sees it now');
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

$('addDriver').addEventListener('click', async () => {
  const name = $('dName').value.trim();
  const msisdn = SomPhone.e164Of($('dMsisdn')) || $('dMsisdn').value.trim();
  if (!name || !msisdn) return toast('Name and phone number are required.');
  const res = await api('/operator/drivers', { method: 'POST', body: JSON.stringify({ name, msisdn }) });
  if (res.error && !res.account) return toast(res.error);
  $('dName').value = $('dMsisdn').value = '';
  setupCodeToast(res, name);
  loadDrivers();
});

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
    if (m.type === 'payment_claimed') {
      // The customer says they've paid: the cue to look at the merchant phone.
      setStatus(`💰 Customer says they paid order #${GMIds.shortId(m.orderId)}${m.reference ? ` (ref ${m.reference})` : ''} — check the merchant phone.`, 'warn');
      toast('A customer says they have paid — check the merchant phone.');
      refreshAll();
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
