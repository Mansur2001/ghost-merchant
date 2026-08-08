// WebSocket authentication/authorization checks against the live stack.
// Run from backend/ so `ws` resolves. NODE_TLS_REJECT_UNAUTHORIZED=0 for the self-signed cert.
import { WebSocket } from 'ws';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// This file is copied into backend/ at run time so `ws` resolves from backend/node_modules,
// so walk up until we find docker-compose.yml rather than assuming a fixed depth.
function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 5; i += 1) {
    if (existsSync(join(dir, 'docker-compose.yml'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not locate the repo root');
}
const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

// Order ids are UUIDs. The seed guarantees one order per status, so resolve by status
// rather than assuming sequential ids.
const byStatus = (status) =>
  execSync(
    `docker compose exec -T postgres psql -U ghost -d ghost_merchant -tAc ` +
      `"SELECT id FROM orders WHERE status='${status}' LIMIT 1;"`,
    { cwd: REPO_ROOT, encoding: 'utf8' }
  ).trim();

const OWN_A = byStatus('PENDING_PAYMENT'); // +252612345678
const OWN_B = byStatus('IN_TRANSIT');      // +252612345678, driver 1
const OTHER_A = byStatus('PAID_UNASSIGNED');
const OTHER_B = byStatus('DELIVERED');     // driver 2's order
const DRIVER1_ORDER = byStatus('DISPATCHED');

const WS_URL = 'wss://localhost/ws';
const API = 'https://localhost/api';
let pass = 0, fail = 0;
const chk = (label, ok, detail = '') => {
  if (ok) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.log(`  FAIL  ${label} ${detail}`); fail += 1; }
};

const post = (path, body) =>
  fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

// Open a socket, run a scripted exchange, collect every message received.
function session(steps, { waitMs = 1200 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
    const got = [];
    let closed = null;
    ws.on('open', async () => {
      for (const step of steps) {
        ws.send(JSON.stringify(step));
        await new Promise((r) => setTimeout(r, 250));
      }
    });
    ws.on('message', (raw) => got.push(JSON.parse(raw.toString())));
    ws.on('close', (code) => { closed = code; });
    setTimeout(() => { try { ws.close(); } catch {} resolve({ got, closed }); }, waitMs);
  });
}

const types = (r) => r.got.map((m) => m.type);

console.log('── WebSocket auth ──');

// A customer session for +252612345678 (owns orders 1 and 4; NOT 2, 3, 5, 6).
const req = await post('/auth/otp/request', { phone: '612345678' });
const { token: custToken } = await post('/auth/otp/verify', {
  phone: '612345678',
  code: req.devCode,
});
const { token: drvToken } = await post('/driver/login', {
  msisdn: '+252619876543',
  pin: '1234',
});

// 1. No auth frame at all -> can do nothing.
{
  const r = await session([{ type: 'subscribe_operator' }, { type: 'subscribe', orderId: OWN_A }]);
  chk('unauthenticated subscribe_operator refused',
    r.got.every((m) => m.type === 'error' && m.error === 'not authenticated'), JSON.stringify(types(r)));
}

// 2. Bad token -> auth_error then closed.
{
  const r = await session([{ type: 'auth', token: 'garbage.token' }]);
  chk('invalid token rejected and socket closed',
    types(r).includes('auth_error') && r.closed === 4403, `closed=${r.closed}`);
}

// 3. Silent socket is dropped by the auth timeout.
{
  const r = await session([], { waitMs: 11500 });
  chk('silent socket closed by auth timeout', r.closed === 4401, `closed=${r.closed}`);
}

// 4. Customer: own order subscribes, other people's do not.
{
  const r = await session([
    { type: 'auth', token: custToken },
    { type: 'subscribe', orderId: OWN_A },
    { type: 'subscribe', orderId: OWN_B },
    { type: 'subscribe', orderId: OTHER_A },
    { type: 'subscribe', orderId: OTHER_B },
  ]);
  const subs = r.got.filter((m) => m.type === 'subscribed').map((m) => String(m.orderId));
  const errs = r.got.filter((m) => m.type === 'error').length;
  chk('customer subscribes to own orders',
    subs.includes(OWN_A) && subs.includes(OWN_B), JSON.stringify(subs));
  chk("customer refused other customers' orders",
    !subs.includes(OTHER_A) && !subs.includes(OTHER_B) && errs === 2,
    `subs=${JSON.stringify(subs)} errs=${errs}`);
}

// 5. Customer cannot claim the operator firehose.
{
  const r = await session([{ type: 'auth', token: custToken }, { type: 'subscribe_operator' }]);
  chk('customer refused subscribe_operator',
    r.got.some((m) => m.type === 'error' && m.error === 'forbidden') &&
    !types(r).includes('subscribed_operator'), JSON.stringify(types(r)));
}

// 6. Driver: own feed yes, operator firehose no, unassigned order no.
{
  const r = await session([
    { type: 'auth', token: drvToken },
    { type: 'subscribe_driver' },
    { type: 'subscribe_operator' },
    { type: 'subscribe', orderId: DRIVER1_ORDER },
    { type: 'subscribe', orderId: OTHER_B },
  ]);
  const subs = r.got.filter((m) => m.type === 'subscribed').map((m) => String(m.orderId));
  chk('driver joins own feed', types(r).includes('subscribed_driver'));
  chk('driver refused subscribe_operator', !types(r).includes('subscribed_operator'));
  chk('driver subscribes to their assigned order', subs.includes(DRIVER1_ORDER), JSON.stringify(subs));
  chk("driver refused another driver's order", !subs.includes(OTHER_B), JSON.stringify(subs));
}

console.log(`\n════ ${pass} passed, ${fail} failed ════`);
process.exit(fail === 0 ? 0 : 1);
