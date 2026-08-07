// WebSocket real-time layer. Clients subscribe to a specific order_id; the layer
// subscribes to the domain event bus and fans events out only to the relevant sockets.
// This is the Observer/Pub-Sub edge that flips the PWA from "Pending" to "Confirmed"
// without a page refresh.
import { WebSocketServer } from 'ws';
import { EVENTS, subscribe } from '../events/bus.js';

// order_id -> Set<WebSocket>
const rooms = new Map();
// A special room for operator dashboards that watch everything.
const operators = new Set();

function joinRoom(orderId, ws) {
  const key = String(orderId);
  if (!rooms.has(key)) rooms.set(key, new Set());
  rooms.get(key).add(ws);
}

function leaveAll(ws) {
  for (const set of rooms.values()) set.delete(ws);
  operators.delete(ws);
}

function sendTo(set, message) {
  const data = JSON.stringify(message);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function broadcastToOrder(orderId, message) {
  const set = rooms.get(String(orderId));
  if (set) sendTo(set, message);
  // Operators mirror all order traffic.
  sendTo(operators, message);
}

export function attachSocketServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // { type: 'subscribe', orderId } | { type: 'subscribe_operator' }
      if (msg.type === 'subscribe' && msg.orderId != null) {
        joinRoom(msg.orderId, ws);
        ws.send(JSON.stringify({ type: 'subscribed', orderId: msg.orderId }));
      } else if (msg.type === 'subscribe_operator') {
        operators.add(ws);
        ws.send(JSON.stringify({ type: 'subscribed_operator' }));
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    });

    ws.on('close', () => leaveAll(ws));
    ws.on('error', () => leaveAll(ws));
  });

  // Bridge domain events -> sockets.
  subscribe(EVENTS.ORDER_STATE_CHANGED, (p) =>
    broadcastToOrder(p.orderId, { type: 'order_state', ...p })
  );
  subscribe(EVENTS.PAYMENT_RECEIVED, (p) =>
    broadcastToOrder(p.orderId, { type: 'payment_confirmed', ...p })
  );
  subscribe(EVENTS.MESSAGE_POSTED, (p) =>
    broadcastToOrder(p.orderId, { type: 'message', ...p })
  );
  subscribe(EVENTS.ORDER_CREATED, (p) => sendTo(operators, { type: 'order_created', ...p }));
  subscribe(EVENTS.ORACLE_DOWN, (p) => sendTo(operators, { type: 'oracle_down', ...p }));
  subscribe(EVENTS.ORACLE_HEARTBEAT, (p) =>
    sendTo(operators, { type: 'oracle_heartbeat', ...p })
  );

  console.log('WebSocket layer attached at /ws');
  return wss;
}
