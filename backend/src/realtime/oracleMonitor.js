// Dead-man's switch for the Android Oracle. The phone is the single point of failure;
// a silent Oracle means silent revenue loss with no error. It POSTs /api/heartbeat
// regularly; if we don't hear from it within the timeout, we alert the operator dashboard.
import { config } from '../config.js';
import { EVENTS, publish } from '../events/bus.js';

let lastHeartbeat = Date.now();
let currentlyDown = false;

export function recordHeartbeat(meta = {}) {
  lastHeartbeat = Date.now();
  if (currentlyDown) {
    currentlyDown = false;
    publish(EVENTS.ORACLE_HEARTBEAT, { status: 'recovered', at: lastHeartbeat, ...meta });
  } else {
    publish(EVENTS.ORACLE_HEARTBEAT, { status: 'alive', at: lastHeartbeat, ...meta });
  }
}

export function oracleStatus() {
  const age = Date.now() - lastHeartbeat;
  return {
    healthy: age <= config.oracleHeartbeatTimeoutMs,
    lastHeartbeat,
    ageMs: age,
  };
}

export function startOracleMonitor() {
  setInterval(() => {
    const age = Date.now() - lastHeartbeat;
    if (age > config.oracleHeartbeatTimeoutMs && !currentlyDown) {
      currentlyDown = true;
      publish(EVENTS.ORACLE_DOWN, {
        status: 'down',
        lastHeartbeat,
        ageMs: age,
      });
      console.error(`⚠ Oracle DOWN — no heartbeat for ${Math.round(age / 1000)}s`);
    }
  }, 30_000).unref();
}
