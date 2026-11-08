// Application entry point. Wires the modular monolith together:
// routes -> commands (writes, emit events) / queries (reads),
// event bus -> realtime socket layer.
import http from 'node:http';
import express from 'express';
import { config } from './config.js';
import { ordersRouter } from './routes/orders.js';
import { paymentsWebhookRouter } from './routes/paymentsWebhook.js';
import { driversRouter } from './routes/drivers.js';
import { operatorRouter } from './routes/operator.js';
import { authRouter } from './routes/auth.js';
import { signupRouter } from './routes/signup.js';
import { staffSetupRouter } from './routes/staffSetup.js';
import { sweepExpiredSetupCodes } from './commands/staffAccounts.js';
import { dispatchWaitingSoon } from './commands/dispatch.js';
import { sweepStaleAttempts } from './commands/providerPayments.js';
import { ensureStarterCatalog } from './db/starterCatalog.js';
import { WAAFIPAY_PRODUCTION_URL } from './domain/waafipay.js';
import { attachSocketServer } from './realtime/socketServer.js';
import { ensureBucket } from './storage/objectStore.js';
import { sweepExpiredOtps } from './commands/auth.js';
import { startOutboxRelay, stopOutboxRelay, sweepOutbox } from './events/outbox.js';
import { ensureBootstrapOperator } from './commands/operators.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { requestLog } from './middleware/requestLog.js';
import { apiNotFound, errorHandler, errorRef } from './middleware/errorHandler.js';
import { prisma, disconnect as disconnectDb } from './db/prisma.js';
import { SEED_OPERATORS, SEED_DRIVERS } from './db/seedFixtures.js';
import { liveSeedCredentials } from './db/seedSafety.js';
import { startBusSubscriber } from './events/bus.js';
import { warnIfSingleInstance, closeRedis } from './redis/client.js';
import { parsePhone } from './domain/phone.js';
import { isWellFormedCode } from './domain/otp.js';
import { maskPhone } from './domain/redact.js';

const app = express();

// Rate limiting is only as good as the IP it buckets on — see config.trustProxyHops.
app.set('trust proxy', config.trustProxyHops);
app.disable('x-powered-by'); // don't advertise the stack

// Order matters: log/headers first so they apply to EVERY response including 404s and
// rejections from the body parser.
app.use(requestLog);
app.use(errorRef);
app.use(securityHeaders);

// Minimal CORS (frontend is same-origin behind Caddy; this eases local dev tooling).
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && config.corsOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Before the JSON parser: the payment callback's signature covers its raw bytes.
app.use('/api', paymentsWebhookRouter);
app.use(express.json({ limit: '32kb' })); // order payloads must stay small
app.use('/api', authRouter);
app.use('/api', signupRouter);
app.use('/api', staffSetupRouter);
app.use('/api', ordersRouter);
app.use('/api', driversRouter);
app.use('/api', operatorRouter);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Terminal handlers, after every route.
app.use('/api', apiNotFound);
app.use(errorHandler);

const server = http.createServer(app);
const wss = attachSocketServer(server);

// Cross-instance event delivery. Without Redis this is a no-op and the bus stays in-process.
warnIfSingleInstance();
startBusSubscriber();

// The relay turns committed outbox rows into bus events. Started before listen() so any
// events left undelivered by a previous crash go out before we take new traffic.
startOutboxRelay();

// Hourly housekeeping: expired passcodes are dead weight and PII-adjacent; delivered outbox
// rows are kept a week as the "why did this happen" record, then dropped.
const housekeeping = setInterval(() => {
  sweepExpiredOtps().catch((err) => console.error('OTP sweep failed:', err.message));
  sweepOutbox().catch((err) => console.error('outbox sweep failed:', err.message));
  sweepExpiredSetupCodes().catch((err) => console.error('setup code sweep failed:', err.message));
}, 60 * 60 * 1000);
housekeeping.unref();

// Backstop for automatic dispatch: paid orders waiting for a free driver are retried every
// 30s, in case a driver freed up in a way that didn't trigger it directly.
const dispatchTimer = setInterval(dispatchWaitingSoon, 30 * 1000);
dispatchTimer.unref();

// Wallet prompts left 'pending' by a restart mid-call become 'unknown' (commands/providerPayments.js).
const attemptTimer = setInterval(() => {
  sweepStaleAttempts().catch((err) => console.error('payment attempt sweep failed:', err.message));
}, 60 * 1000);
attemptTimer.unref();

async function boot() {
  // The `log` transport prints login codes to the server log, so anyone with log access could
  // sign in as any customer. Fine in dev, fatal in production.
  if (!['twilio', 'auto', 'log'].includes(config.otp.transport)) {
    console.error(`FATAL: OTP_TRANSPORT must be twilio, auto or log (got "${config.otp.transport}").`);
    process.exit(1);
  }
  if (config.env === 'production' && !['twilio', 'auto'].includes(config.otp.transport)) {
    console.error(
      'FATAL: OTP_TRANSPORT must be twilio (or auto) in production — ' +
        `"${config.otp.transport}" prints login codes to the server log.`
    );
    process.exit(1);
  }

  // A wallet with a bad number or dial code would send a customer's money nowhere — or to the
  // wrong person. Refuse now rather than discover it from a customer's complaint.
  const { wallets, errors: walletErrors, warnings: walletWarnings } = config.payment;
  if (walletErrors.length) {
    walletErrors.forEach((e) => console.error(`FATAL: wallet ${e}`));
    process.exit(1);
  }
  walletWarnings.forEach((w) => console.warn(`[wallets] ${w}`));
  if (process.env.MERCHANT_MSISDN || process.env.USSD_TEMPLATE) {
    console.warn('[wallets] MERCHANT_MSISDN / USSD_TEMPLATE are no longer read — use EVC_MERCHANT / EVC_USSD.');
  }
  console.log(
    wallets.length
      ? `[wallets] offering ${wallets.map((w) => w.name).join(', ')}`
      : '[wallets] none configured — every order uses the operator-confirmed manual path'
  );

  // Who may mark an order paid. 'api' with no (or a weak) secret would let anyone who can
  // reach the server forge "paid" callbacks — refuse to start instead.
  if (!['operator', 'api'].includes(config.paymentConfirmation)) {
    console.error(`FATAL: PAYMENT_CONFIRMATION must be operator or api (got "${config.paymentConfirmation}").`);
    process.exit(1);
  }
  if (config.paymentConfirmation === 'api' && config.paymentWebhookSecret.length < 32) {
    console.error('FATAL: PAYMENT_CONFIRMATION=api needs PAYMENT_WEBHOOK_SECRET of at least 32 characters.');
    process.exit(1);
  }
  console.log(config.paymentConfirmation === 'api'
    ? '[payments] confirmed ONLY by the signed mobile-money callback; operators cannot mark orders paid'
    : '[payments] confirmed by an operator with the transaction number (switch to api when the provider is live)');

  // WaafiPay: half-set credentials, or a sandbox gateway in production (which would mark
  // orders paid with no money behind them), refuse to boot.
  const waafi = config.waafipay;
  if (waafi.errors.length) {
    waafi.errors.forEach((e) => console.error(`FATAL: WaafiPay ${e}`));
    process.exit(1);
  }
  if (waafi.enabled && config.env === 'production' && waafi.url !== WAAFIPAY_PRODUCTION_URL) {
    console.error(`FATAL: WAAFIPAY_URL in production must be ${WAAFIPAY_PRODUCTION_URL} — anything else confirms payments nobody made.`);
    process.exit(1);
  }
  console.log(waafi.enabled
    ? `[payments] in-app wallet prompts on (${waafi.wallets.join(', ')}) via ${new URL(waafi.url).host}`
    : '[payments] in-app wallet prompts off (no WaafiPay credentials) — USSD links and "I\'ve paid" only');

  if (config.pricing.errors.length) {
    config.pricing.errors.forEach((e) => console.error(`FATAL: tariff ${e}`));
    process.exit(1);
  }
  if (config.assistant.errors.length) {
    config.assistant.errors.forEach((e) => console.error(`FATAL: assistant ${e}`));
    process.exit(1);
  }
  console.log(config.assistant.enabled
    ? `[assistant] FAQ + ${config.assistant.model} at ${new URL(config.assistant.url).host}`
    : '[assistant] FAQ answers only (no ASSISTANT_URL)');
  console.log(config.routingUrl ? `[routing] OSRM at ${config.routingUrl}` : '[routing] straight-line estimate (no ROUTING_URL)');

  // A half-set review login is silently disabled by reviewCodeFor(), which would surface as a
  // Play rejection days later. Say so now, while someone is watching the deploy.
  const review = config.otp.review;
  if (review.phone || review.code) {
    const reviewOk = parsePhone(review.phone).valid && isWellFormedCode(review.code);
    if (!reviewOk) {
      console.error('FATAL: REVIEW_PHONE must be a valid number and REVIEW_CODE exactly 6 digits.');
      process.exit(1);
    }
    console.warn(`[OTP] Play review login is ENABLED for ${maskPhone(parsePhone(review.phone).e164)}`);
  }

  // Create the first named operator if the roster is empty, so a fresh deploy is reachable.
  try {
    await ensureBootstrapOperator();
  } catch (err) {
    console.error('FATAL: operator bootstrap failed:', err.message);
    process.exit(1);
  }

  // The dev seed's passwords and PINs are in the repository, so they are public. If one still
  // logs in here — a dev database promoted to the VPS, the seed run by mistake, or a bootstrap
  // password copied from CREDENTIALS.md — anyone can read every customer's details. Refuse to
  // serve until it is changed or deactivated.
  if (config.env === 'production') {
    const [operators, drivers] = await Promise.all([
      prisma.operator.findMany({
        where: { username: { in: SEED_OPERATORS.map((o) => o.username) } },
        select: { username: true, password_hash: true, active: true },
      }),
      prisma.driver.findMany({
        where: { msisdn: { in: SEED_DRIVERS.map((d) => d.msisdn) } },
        select: { msisdn: true, pin_hash: true, active: true },
      }),
    ]);
    const live = liveSeedCredentials(operators, drivers);
    if (live.length) {
      console.error(
        `FATAL: public seed credentials still log in: ${live.join(', ')}. ` +
          'Change or deactivate them before running in production.'
      );
      process.exit(1);
    }
  }

  // A fresh install gets a starter catalog and places list; an edited one is never touched.
  try {
    if (await ensureStarterCatalog(prisma)) console.log('[catalog] starter catalog/places added — check prices and pins');
  } catch (err) {
    console.error('starter catalog failed (continuing):', err.message);
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
