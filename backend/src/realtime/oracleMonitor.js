// Dead-man's switch for the Android Oracle.
//
// WHAT THE ORACLE IS: a CONFIRMATION device, not a communication one. When a customer pays
// over EVC Plus, the telecom texts the MERCHANT's phone; the Oracle forwards that SMS so the
// order flips to paid by itself. There is no telecom API — that message is the only automated
// signal a payment happened. Nothing about customer/driver/operator conversation goes through
// it; that is the in-app chat over WebSocket and never touches this phone.
//
// A silent Oracle therefore means silent revenue loss with no error anywhere.
//
// BUT: running WITHOUT one is a legitimate choice, not a fault. At low volume an operator
// reads the merchant phone and taps "Mark as paid" — the manual override that already exists.
// A deployment with no Somali SIM yet has no Oracle at all.
//
// So the switch ARMS ITSELF only once an Oracle has proven it exists. Three states:
//
//   not_configured — never heard from one. Not an alarm; nothing is broken.
//   healthy        — heard from it inside the timeout.
//   down           — it WAS reporting and went silent. This is the emergency.
//
// The distinction matters because an alarm that is always on is one people learn to ignore,
// and this is the alarm that means "payments are silently not being matched".
import { config } from '../config.js';
import { EVENTS, publish } from '../events/bus.js';

let lastHeartbeat = null; // null = never seen one
let currentlyDown = false;

export function recordHeartbeat(meta = {}) {
  const firstEver = lastHeartbeat === null;
  lastHeartbeat = Date.now();
  if (currentlyDown) {
    currentlyDown = false;
    publish(EVENTS.ORACLE_HEARTBEAT, { status: 'recovered', at: lastHeartbeat, ...meta });
  } else {
    publish(EVENTS.ORACLE_HEARTBEAT, {
      status: firstEver ? 'connected' : 'alive',
      at: lastHeartbeat,
      ...meta,
    });
  }
}

export function oracleStatus() {
  if (lastHeartbeat === null) {
    return {
      state: 'not_configured',
      healthy: false,
      lastHeartbeat: null,
      ageMs: null,
      // Said plainly so the dashboard can explain rather than alarm.
      detail:
        'No Oracle phone has reported in. Payments are confirmed manually by an operator — ' +
        'that is a supported way to run.',
    };
  }
  const age = Date.now() - lastHeartbeat;
  const healthy = age <= config.oracleHeartbeatTimeoutMs;
  return {
    state: healthy ? 'healthy' : 'down',
    healthy,
    lastHeartbeat,
    ageMs: age,
    detail: healthy
      ? null
      : 'The Oracle phone has stopped reporting. Payments are NOT being matched automatically ' +
        '— confirm them manually and check the phone.',
  };
}

export function startOracleMonitor() {
  setInterval(() => {
    // Never armed: no Oracle has ever reported, so there is nothing to have died.
    if (lastHeartbeat === null) return;

    const age = Date.now() - lastHeartbeat;
    if (age > config.oracleHeartbeatTimeoutMs && !currentlyDown) {
      currentlyDown = true;
      publish(EVENTS.ORACLE_DOWN, { status: 'down', lastHeartbeat, ageMs: age });
      console.error(`⚠ Oracle DOWN — no heartbeat for ${Math.round(age / 1000)}s`);
    }
  }, 30_000).unref();
}

// Test hook.
export function resetOracleMonitor() {
  lastHeartbeat = null;
  currentlyDown = false;
}
