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
import { attachSocketServer } from './realtime/socketServer.js';
import { startOracleMonitor } from './realtime/oracleMonitor.js';
import { ensureBucket } from './storage/objectStore.js';

const app = express();

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
app.use('/api', ordersRouter);
app.use('/api', driversRouter);
app.use('/api', operatorRouter);

app.get('/api/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
attachSocketServer(server);
startOracleMonitor();

async function boot() {
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
