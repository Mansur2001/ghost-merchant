// Application entry point. Wires the modular monolith together:
// routes -> commands (writes, emit events) / queries (reads),
// event bus -> realtime socket layer + oracle monitor.
import http from 'node:http';
import express from 'express';
import { config } from './config.js';
import { ordersRouter } from './routes/orders.js';
import { webhookRouter } from './routes/webhook.js';
import { driversRouter } from './routes/drivers.js';
import { operatorRouter } from './routes/operator.js';
import { authRouter } from './routes/auth.js';
import { signupRouter } from './routes/signup.js';
import { attachSocketServer } from './realtime/socketServer.js';
import { startOracleMonitor } from './realtime/oracleMonitor.js';
import { ensureBucket } from './storage/objectStore.js';
import { sweepExpiredOtps } from './commands/auth.js';
import { startOutboxRelay, stopOutboxRelay, sweepOutbox } from './events/outbox.js';
import { ensureBootstrapOperator } from './commands/operators.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { requestLog } from './middleware/requestLog.js';
import { apiNotFound, errorHandler } from './middleware/errorHandler.js';
import { disconnect as disconnectDb } from './db/prisma.js';
import { startBusSubscriber } from './events/bus.js';
import { startEmailSensor, stopEmailSensor } from './notify/emailSensor.js';
import { sweepSmsQueue } from './notify/smsQueue.js';
import { warnIfSingleInstance, closeRedis } from './redis/client.js';

const app = express();

// Rate limiting is only as good as the IP it buckets on — see config.trustProxyHops.
app.set('trust proxy', config.trustProxyHops);
app.disable('x-powered-by'); // don't advertise the stack

// Order matters: log/headers first so they apply to EVERY response including 404s and
// rejections from the body parser.
app.use(requestLog);
app.use(securityHeaders);

// Minimal CORS (frontend is same-origin behind Caddy; this eases local dev tooling).
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && config.corsOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Oracle-Signature');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// NOTE: webhookRouter mounts its own raw-body JSON parser (needed for HMAC), so it must
// be registered BEFORE the global json parser to keep the exact bytes.
app.use('/api', webhookRouter);

app.use(express.json({ limit: '32kb' })); // order payloads must stay small
app.use('/api', authRouter);
app.use('/api', signupRouter);
app.use('/api', ordersRouter);
app.use('/api', driversRouter);
app.use('/api', operatorRouter);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Terminal handlers, after every route.
app.use('/api', apiNotFound);
app.use(errorHandler);

const server = http.createServer(app);
const wss = attachSocketServer(server);
startOracleMonitor();

// Cross-instance event delivery. Without Redis this is a no-op and the bus stays in-process.
warnIfSingleInstance();
startBusSubscriber();

// Payment sensing over email. No-op unless IMAP credentials are set.
startEmailSensor();

// The relay turns committed outbox rows into bus events. Started before listen() so any
// events left undelivered by a previous crash go out before we take new traffic.
startOutboxRelay();

// Hourly housekeeping: expired passcodes are dead weight and PII-adjacent; delivered outbox
// rows are kept a week as the "why did this happen" record, then dropped.
const housekeeping = setInterval(() => {
  sweepExpiredOtps().catch((err) => console.error('OTP sweep failed:', err.message));
  sweepOutbox().catch((err) => console.error('outbox sweep failed:', err.message));
  // Undelivered login codes are plaintext credentials; don't let them accumulate.
  sweepSmsQueue().catch((err) => console.error('sms queue sweep failed:', err.message));
}, 60 * 60 * 1000);
housekeeping.unref();

async function boot() {
  // Refuse to be quietly insecure: with the log transport there is no SMS, so anyone who can
  // read the logs can log in as any customer. Fine in dev, fatal in production.
  // The `log` transport prints login codes to the server log, so anyone with log access could
  // sign in as any customer. Fine in dev, fatal in production. `oracle`, `twilio` and `auto`
  // all deliver over a real channel.
  if (config.env === 'production' && !['oracle', 'twilio', 'auto'].includes(config.otp.transport)) {
    console.error(
      'FATAL: OTP_TRANSPORT must be oracle | twilio | auto in production — ' +
        `"${config.otp.transport}" prints login codes to the server log.`
    );
    process.exit(1);
  }

  // Create the first named operator if the roster is empty, so a fresh deploy is reachable.
  try {
    await ensureBootstrapOperator();
  } catch (err) {
    console.error('FATAL: operator bootstrap failed:', err.message);
    process.exit(1);
  }

  try {
    await ensureBucket();
  } catch (err) {
    console.error('MinIO bucket init failed (continuing):', err.message);
  }
  server.listen(config.port, () => {
    console.log(`GuriKaabe backend listening on :${config.port} (${config.env})`);
  });
}

// ── Graceful shutdown ──
// `docker compose up -d --build` sends SIGTERM. Without this, in-flight requests are cut
// mid-response and Postgres is left to time out the connections — which during a deploy can
// mean an order write that the customer saw succeed never actually committed.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — shutting down`);

  // Stop taking new work, then let in-flight requests finish.
  const closed = new Promise((resolve) => server.close(resolve));
  for (const client of wss.clients) client.close(1001, 'server shutting down');
  wss.close();
  clearInterval(housekeeping);
  // Undelivered outbox rows are safe: they stay in Postgres and the next boot relays them.
  // Releasing relay leadership explicitly means a rolling deploy doesn't pause delivery
  // while another instance waits for this connection to time out.
  stopOutboxRelay();

  // Don't hang forever on a stuck socket; past this point, exiting is the better outcome.
  const timeout = new Promise((resolve) => setTimeout(resolve, 10_000).unref?.());
  await Promise.race([closed, timeout]);

  await stopEmailSensor().catch(() => {});
  await closeRedis();
  await disconnectDb().catch(() => {});
  console.log('shutdown complete');
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A crash with an open DB pool and live sockets should still be loud and clean, not silent.
process.on('unhandledRejection', (err) => {
  console.error('FATAL unhandledRejection:', err);
  shutdown('unhandledRejection');
});

boot();
