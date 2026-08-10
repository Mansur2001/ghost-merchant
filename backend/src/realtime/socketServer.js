// WebSocket real-time layer. Clients authenticate, subscribe to a specific order_id, and the
// layer fans domain events out only to sockets entitled to see them.
//
// AUTHENTICATION: a browser cannot set headers on a WebSocket handshake, and putting a token
// in the query string writes it into every access log and proxy trace. So the token is sent
// as the FIRST FRAME instead: a socket that has not authenticated within AUTH_TIMEOUT_MS can
// do nothing but `auth`/`ping`, and is then closed.
//
// AUTHORIZATION: the same domain rule as HTTP (domain/access.js). Before this existed, any
// client could send {type:'subscribe_operator'} and receive a live feed of every order,
// payment, and message in the system.
import { WebSocketServer } from 'ws';
import { EVENTS, subscribe } from '../events/bus.js';
import { verifyToken } from '../middleware/auth.js';
import { canAccessOrder } from '../domain/access.js';
import { getOrder } from '../queries/orders.js';
import { consumeAsync } from '../middleware/rateLimit.js';

const AUTH_TIMEOUT_MS = 10_000; // authenticate within 10s of connecting or be dropped
const HEARTBEAT_MS = 30_000; // ping idle sockets; drop the ones that stop answering
const MAX_FRAME_BYTES = 4096; // control frames are tiny; anything larger is not our client
const MAX_ROOMS_PER_SOCKET = 50; // one client has no business watching 50 orders

// Close codes (4000-4999 is the application-private range).
const CLOSE_AUTH_TIMEOUT = 4401;
const CLOSE_AUTH_FAILED = 4403;
const CLOSE_TOO_MANY = 4429;

// order_id -> Set<WebSocket>
const rooms = new Map();
// A special room for operator dashboards that watch everything.
const operators = new Set();
// driver_id -> Set<WebSocket>. A driver's own feed: how they learn about an order the
// operator just assigned them, which by definition they aren't subscribed to yet.
const driverFeeds = new Map();

function joinRoom(orderId, ws) {
  const key = String(orderId);
  if (!rooms.has(key)) rooms.set(key, new Set());
  rooms.get(key).add(ws);
  ws.rooms.add(key);
}

function leaveAll(ws) {
  for (const [key, set] of rooms.entries()) {
    set.delete(ws);
    if (set.size === 0) rooms.delete(key); // don't leak an empty Set per delivered order
  }
  for (const [key, set] of driverFeeds.entries()) {
    set.delete(ws);
    if (set.size === 0) driverFeeds.delete(key);
  }
  operators.delete(ws);
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function sendTo(set, message) {
  const data = JSON.stringify(message);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

// Fan an order event out to everyone entitled to it: the order's room, the assigned driver's
// personal feed, and every operator dashboard.
//
// Every room member is re-authorized against the CURRENT order row on each delivery, rather
// than trusting the check made at subscribe time. An operator can reassign an order, and the
// previously-assigned driver must stop receiving that customer's updates immediately — not
// whenever they happen to disconnect. Order events are low-volume (a handful over an order's
// entire life), so this costs one indexed read per event and buys a correct answer.
async function broadcastToOrder(orderId, message) {
  const set = rooms.get(String(orderId));
  const order = await getOrder(orderId).catch(() => null);
  // A socket can qualify through more than one path (an operator watching one order; a driver
  // subscribed to an order that's also on their feed). Deliver once.
  const delivered = new Set();
  const deliver = (ws) => {
    if (delivered.has(ws)) return;
    delivered.add(ws);
    send(ws, message);
  };

  if (set && set.size > 0) {
    for (const ws of [...set]) {
      if (order && canAccessOrder(ws.auth, order)) deliver(ws);
      else leaveRoomOnly(ws, orderId); // silently unsubscribe whoever lost access
    }
  }

  // The assigned driver hears about the order even if they never subscribed to it.
  if (order?.driver_id != null) {
    const feed = driverFeeds.get(String(order.driver_id));
    if (feed) for (const ws of feed) deliver(ws);
  }

  for (const ws of operators) deliver(ws);
}

function leaveRoomOnly(ws, orderId) {
  const key = String(orderId);
  const set = rooms.get(key);
  if (set) {
    set.delete(ws);
    if (set.size === 0) rooms.delete(key);
  }
  ws.rooms?.delete(key);
}

async function handleSubscribe(ws, orderId) {
  if (ws.rooms.size >= MAX_ROOMS_PER_SOCKET) {
    return send(ws, { type: 'error', error: 'subscription limit reached' });
  }
  const order = await getOrder(orderId).catch(() => null);
  // Same rule as HTTP: "not yours" and "doesn't exist" must be indistinguishable, or the
  // socket becomes the enumeration oracle the REST API no longer is.
  if (!order || !canAccessOrder(ws.auth, order)) {
    return send(ws, { type: 'error', error: 'not found', orderId });
  }
  joinRoom(orderId, ws);
  send(ws, { type: 'subscribed', orderId });
}

export function attachSocketServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: MAX_FRAME_BYTES });

  wss.on('connection', (ws, req) => {
    // Connection flood guard, shared with the HTTP limiter (and so with Redis when it's
    // configured, making the limit hold across instances rather than per-instance).
    const ip = req.socket.remoteAddress || 'unknown';
    consumeAsync(`ws:connect:${ip}`, { windowMs: 60_000, max: 60 })
      .then(({ allowed }) => {
        if (!allowed) ws.close(CLOSE_TOO_MANY, 'too many connections');
      })
      .catch(() => {
        // A limiter failure must not deny service; the auth timeout still bounds the socket.
      });

    ws.auth = null;
    ws.rooms = new Set();
    ws.isAlive = true;

    const authTimer = setTimeout(() => {
      if (!ws.auth) ws.close(CLOSE_AUTH_TIMEOUT, 'authentication required');
    }, AUTH_TIMEOUT_MS);

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'ping') return send(ws, { type: 'pong' });

      // ── Pre-auth: `auth` is the only thing that does anything ──
      if (msg.type === 'auth') {
        const payload = verifyToken(String(msg.token || ''));
        if (!payload) {
          send(ws, { type: 'auth_error', error: 'invalid or expired token' });
          return ws.close(CLOSE_AUTH_FAILED, 'authentication failed');
        }
        ws.auth = payload;
        clearTimeout(authTimer);
        return send(ws, { type: 'authenticated', role: payload.role });
      }

      if (!ws.auth) return send(ws, { type: 'error', error: 'not authenticated' });

      // ── Authenticated commands ──
      if (msg.type === 'subscribe' && msg.orderId != null) {
        await handleSubscribe(ws, msg.orderId);
      } else if (msg.type === 'subscribe_operator') {
        if (ws.auth.role !== 'operator') {
          return send(ws, { type: 'error', error: 'forbidden' });
        }
        operators.add(ws);
        send(ws, { type: 'subscribed_operator' });
      } else if (msg.type === 'subscribe_driver') {
        // A driver's own feed. The id comes from the TOKEN, never from the message — asking
        // for someone else's feed is simply not expressible.
        if (ws.auth.role !== 'driver') {
          return send(ws, { type: 'error', error: 'forbidden' });
        }
        const key = String(ws.auth.id);
        if (!driverFeeds.has(key)) driverFeeds.set(key, new Set());
        driverFeeds.get(key).add(ws);
        send(ws, { type: 'subscribed_driver' });
      }
    });

    ws.on('close', () => { clearTimeout(authTimer); leaveAll(ws); });
    ws.on('error', () => { clearTimeout(authTimer); leaveAll(ws); });
  });

  // Drop half-open sockets (phone went through a tunnel and never sent a FIN) so rooms don't
  // accumulate dead entries that we'd otherwise keep authorizing and writing to.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { leaveAll(ws); ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));

  // Bridge domain events -> sockets. Broadcast is async now (driver re-checks hit the DB);
  // nothing awaits these, so swallow rejections rather than crashing the process on a
  // transient DB blip.
  const bridge = (fn) => (p) => Promise.resolve(fn(p)).catch((err) =>
    console.error('socket broadcast failed:', err.message)
  );

  subscribe(EVENTS.ORDER_STATE_CHANGED, bridge((p) =>
    broadcastToOrder(p.orderId, { type: 'order_state', ...p })
  ));
  subscribe(EVENTS.PAYMENT_RECEIVED, bridge((p) =>
    broadcastToOrder(p.orderId, { type: 'payment_confirmed', ...p })
  ));
  subscribe(EVENTS.MESSAGE_POSTED, bridge((p) =>
    broadcastToOrder(p.orderId, { type: 'message', ...p })
  ));
  subscribe(EVENTS.ORDER_CREATED, (p) => sendTo(operators, { type: 'order_created', ...p }));
  subscribe(EVENTS.ORACLE_DOWN, (p) => sendTo(operators, { type: 'oracle_down', ...p }));
  subscribe(EVENTS.ORACLE_HEARTBEAT, (p) =>
    sendTo(operators, { type: 'oracle_heartbeat', ...p })
  );

  console.log('WebSocket layer attached at /ws (authenticated)');
  return wss;
}
