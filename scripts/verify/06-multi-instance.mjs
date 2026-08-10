// P2 verification: does the stack actually work with MORE THAN ONE backend instance?
//
// This is the whole point of moving the bus and the rate limiter to Redis, and it cannot be
// checked by reading code — the failure mode is "some clients silently miss some events",
// which looks like flakiness rather than a bug.
//
// Run with the stack scaled up:
//   docker compose up -d --scale backend=2
//   cd backend && NODE_TLS_REJECT_UNAUTHORIZED=0 node ../scripts/verify/06-multi-instance.mjs
import { WebSocket } from 'ws';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 5; i += 1) {
    if (existsSync(join(dir, 'docker-compose.yml'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not locate the repo root');
}
const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

const API = 'https://localhost/api';
const WS_URL = 'wss://localhost/ws';
let pass = 0, fail = 0;
const chk = (label, ok, detail = '') => {
  if (ok) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.log(`  FAIL  ${label} ${detail}`); fail += 1; }
};

const sh = (cmd) => execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const psql = (sql) =>
  sh(`docker compose exec -T postgres psql -U ghost -d ghost_merchant -tAc "${sql}"`).trim();

const post = (path, body, token) =>
  fetch(API + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

console.log('── Multi-instance (Redis bus + shared rate limits) ──');

const instances = Number(sh('docker compose ps backend --format "{{.Name}}" | wc -l'));
chk(`stack is running ${instances} backend instances`, instances >= 2, `got ${instances}`);
if (instances < 2) {
  console.log('\n  Run: docker compose up -d --scale backend=2');
  process.exit(1);
}

// Relay leadership is a TRANSACTION-scoped advisory lock, so it rotates between instances
// batch by batch rather than being held by one. Counting log lines would therefore be
// meaningless. What must hold is the property leadership exists to protect: no event is
// delivered twice, and the queue always drains. Both are asserted below.

const opToken = await post('/operator/login', {
  username: 'hodan',
  password: 'seeded-operator-pw-1',
}).then((r) => r.json()).then((j) => j.token);
chk('operator signed in', Boolean(opToken));

// ── Cross-instance event fan-out ──
//
// Open several sockets. Caddy spreads them over both instances, so if the bus were still
// in-process only the sockets on the instance that handled the HTTP request would see the
// event. All of them must.
const SOCKETS = 6;
const order = psql("SELECT id FROM orders WHERE status='PENDING_PAYMENT' LIMIT 1;");
chk('found a pending order to move', Boolean(order), order);

function openSocket(token, orderId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL, { rejectUnauthorized: false });
    const received = [];
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'authenticated') {
        ws.send(JSON.stringify({ type: 'subscribe', orderId }));
      } else if (m.type === 'subscribed') {
        resolve({ ws, received });
      } else {
        received.push(m);
      }
    });
    setTimeout(() => resolve({ ws, received }), 4000); // don't hang if auth stalls
  });
}

const sockets = await Promise.all(
  Array.from({ length: SOCKETS }, () => openSocket(opToken, order))
);
chk(`${SOCKETS} sockets connected and subscribed`, sockets.every((s) => s.ws.readyState === 1));

// One HTTP request, handled by exactly ONE instance.
const res = await post(`/operator/orders/${order}/mark-paid`, {}, opToken);
chk('state change accepted', res.status === 200, `HTTP ${res.status}`);

await new Promise((r) => setTimeout(r, 2500)); // outbox relay + Redis fan-out

const counts = sockets.map((s) => s.received.filter((m) => m.type === 'order_state').length);
const delivered = counts.filter((n) => n > 0).length;
chk(
  `every socket received the event across instances (${delivered}/${SOCKETS})`,
  delivered === SOCKETS,
  `only ${delivered} of ${SOCKETS} — events are NOT crossing instances`
);
// The duplicate check is what relay leadership actually buys: if both instances relayed the
// same batch, every socket would see the state change twice.
chk(
  'no socket received it TWICE (relay leadership held)',
  counts.every((n) => n <= 1),
  `per-socket counts: ${JSON.stringify(counts)}`
);

// And the queue drained — a lock that nobody can take would stall delivery entirely.
const pending = psql(
  "SELECT count(*) FROM outbox WHERE published_at IS NULL AND NOT failed;"
);
chk('outbox fully drained', pending === '0', pending);
sockets.forEach((s) => s.ws.close());

// ── Shared rate limits ──
//
// The operator login limit is 10 per 15 minutes per username. Requests spread over both
// instances, so with a per-process limiter the effective ceiling would be 20 and none of
// these would be refused.
const codes = [];
for (let i = 0; i < 14; i += 1) {
  // eslint-disable-next-line no-await-in-loop
  const r = await post('/operator/login', { username: 'hodan', password: 'wrong-password-x' });
  codes.push(r.status);
}
const refused = codes.filter((c) => c === 429).length;
chk(
  `rate limit is shared across instances (${refused} of 14 refused)`,
  refused > 0,
  'no 429 seen — each instance is counting separately'
);

// Redis really is doing the work.
const keys = sh('docker compose exec -T redis redis-cli --scan --pattern "rl:*" | head -5');
chk('rate-limit counters live in Redis', keys.includes('rl:'), keys || '(none)');

console.log(`\n════ ${pass} passed, ${fail} failed ════`);
process.exit(fail === 0 ? 0 : 1);
