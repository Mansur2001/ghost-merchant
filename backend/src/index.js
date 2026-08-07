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
import { attachSocketServer } from './realtime/socketServer.js';
import { startOracleMonitor } from './realtime/oracleMonitor.js';
import { ensureBucket } from './storage/objectStore.js';
import { sweepExpiredOtps } from './commands/auth.js';

const app = express();

// Rate limiting is only as good as the IP it buckets on — see config.trustProxyHops.
app.set('trust proxy', config.trustProxyHops);

// Minimal CORS (frontend is same-origin behind Caddy; this eases local dev tooling).
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && config.corsOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Oracle-Signature');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// NOTE: webhookRouter mounts its own raw-body JSON parser (needed for HMAC), so it must
// be registered BEFORE the global json parser to keep the exact bytes.
app.use('/api', webhookRouter);

app.use(express.json({ limit: '32kb' })); // order payloads must stay small
app.use('/api', authRouter);
app.use('/api', ordersRouter);
app.use('/api', driversRouter);
app.use('/api', operatorRouter);

app.get('/api/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
attachSocketServer(server);
startOracleMonitor();

// Expired passcodes are dead weight and PII-adjacent — sweep them hourly.
const otpSweep = setInterval(() => {
  sweepExpiredOtps().catch((err) => console.error('OTP sweep failed:', err.message));
}, 60 * 60 * 1000);
otpSweep.unref();

async function boot() {
  // Refuse to be quietly insecure: with the log transport there is no SMS, so anyone who can
  // read the logs can log in as any customer. Fine in dev, fatal in production.
  if (config.env === 'production' && config.otp.transport !== 'oracle') {
    console.error(
      'FATAL: OTP_TRANSPORT must be "oracle" in production — ' +
        `"${config.otp.transport}" prints login codes to the server log.`
    );
    process.exit(1);
  }

  try {
    await ensureBucket();
  } catch (err) {
    console.error('MinIO bucket init failed (continuing):', err.message);
  }
  server.listen(config.port, () => {
    console.log(`Ghost Merchant backend listening on :${config.port} (${config.env})`);
  });
}

boot();
