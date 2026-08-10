// What the offline queue should DO with each outcome. Pure decision logic, no storage and no
// network, so it can be unit-tested outside a browser (backend/tests/syncPolicy.test.js runs
// this exact file).
//
// The rule from CLAUDE.md: **the server's state machine always wins over a queued client
// transition, and a rejected action surfaces as "couldn't sync" — never silently dropped.**
// Everything here follows from that.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GMSync = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // What to do with a queued write after an attempt.
  //   'done'    — applied; drop it from the queue
  //   'retry'   — transient (offline, server down); keep it and try again later
  //   'rejected'— the server refused on the merits; keep it visible and tell the user
  const DONE = 'done';
  const RETRY = 'retry';
  const REJECTED = 'rejected';

  const MAX_ATTEMPTS = 8;

  // Exponential backoff with a ceiling, so a phone that's been in a dead zone for an hour
  // doesn't hammer the server the instant one bar appears.
  function backoffMs(attempts) {
    return Math.min(1000 * 2 ** Math.max(0, attempts - 1), 5 * 60 * 1000);
  }

  // Classify an HTTP response (or the absence of one).
  //
  // `status === 0` means the request never got an answer — offline, DNS, TLS, timeout. That
  // is the ordinary case for this app and must always be retryable.
  function classify({ status, attempts = 0, isTransitionTo = null, currentStatus = null }) {
    if (status === 0) {
      return attempts >= MAX_ATTEMPTS
        ? { action: REJECTED, reason: 'Could not reach the server after several tries.' }
        : { action: RETRY, retryInMs: backoffMs(attempts) };
    }

    if (status >= 200 && status < 300) return { action: DONE };

    // 409 on a state transition is the interesting one. It usually means "illegal transition
    // from the current state" — but if the order is ALREADY in the state we were trying to
    // reach, then our own earlier attempt succeeded and only the response was lost. That is a
    // success, not a conflict, and telling the driver their delivery "failed to sync" when it
    // is sitting there marked delivered would be a lie.
    if (status === 409) {
      if (isTransitionTo && currentStatus && isTransitionTo === currentStatus) {
        return { action: DONE, note: 'already applied' };
      }
      return {
        action: REJECTED,
        reason: 'The order moved on before this reached us — the server version wins.',
      };
    }

    // Auth expired. Retrying won't help until the user signs in again, but the action is not
    // WRONG — hold it so it can go through after re-authentication.
    if (status === 401 || status === 403) {
      return { action: RETRY, retryInMs: backoffMs(attempts), needsAuth: true };
    }

    // 429: we are being rate-limited. Always retryable, and the server tells us when.
    if (status === 429) {
      return { action: RETRY, retryInMs: Math.max(backoffMs(attempts), 5000) };
    }

    // Other 4xx: the request itself is bad (validation, gone, not yours). Replaying it will
    // never work, so stop and show it rather than looping forever.
    if (status >= 400 && status < 500) {
      return { action: REJECTED, reason: 'The server refused this change.' };
    }

    // 5xx: the server is unwell, not the request.
    return attempts >= MAX_ATTEMPTS
      ? { action: REJECTED, reason: 'The server kept failing on this.' }
      : { action: RETRY, retryInMs: backoffMs(attempts) };
  }

  // Whether an item is due for another attempt.
  function isDue(item, now = Date.now()) {
    return !item.nextAttemptAt || item.nextAttemptAt <= now;
  }

  // Human summary for the sync indicator. Deliberately plain: a driver holding a phone in the
  // sun does not want "3 mutations pending in the write-ahead queue".
  function describe({ pending = 0, failed = 0 }) {
    if (failed > 0) return { tone: 'error', text: `${failed} change${failed === 1 ? '' : 's'} couldn't sync` };
    if (pending > 0) return { tone: 'pending', text: `${pending} waiting to send` };
    return { tone: 'ok', text: 'All changes saved' };
  }

  return { DONE, RETRY, REJECTED, MAX_ATTEMPTS, backoffMs, classify, isDue, describe };
});
