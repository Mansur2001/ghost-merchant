// Durable offline write queue. Classic script; exposes window.GMQueue.
//
// This is the AP half of the CAP design (CLAUDE.md P2). A driver in a dead zone must be able
// to mark an order delivered and have it reach the server later — the alternative is standing
// in the street holding a phone, which is not a product.
//
// IndexedDB, not memory or localStorage:
//   * survives the app being killed by Android to reclaim memory, which happens constantly on
//     the cheap handsets this is built for;
//   * stores Blobs, so a delivery-proof photo can queue too;
//   * localStorage would be synchronous (janks the UI) and capped around 5MB.
//
// Every queued write carries a client-minted idempotency key, so replaying one that actually
// succeeded — response lost, not the write — lands exactly once on the server.
(function (global) {
  const DB_NAME = 'gurikaabe';
  const DB_VERSION = 1;
  const STORE = 'writes';

  let dbPromise = null;
  const listeners = new Set();

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          // autoIncrement gives FIFO ordering for free, and order matters: "secured" must
          // reach the server before "delivered".
          const store = db.createObjectStore(STORE, { keyPath: 'seq', autoIncrement: true });
          store.createIndex('state', 'state');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(STORE, mode);
          const store = t.objectStore(STORE);
          let result;
          Promise.resolve(fn(store)).then((r) => { result = r; }, reject);
          t.oncomplete = () => resolve(result);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        })
    );
  }

  const reqAsPromise = (req) =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

  function notify() {
    stats().then((s) => listeners.forEach((fn) => { try { fn(s); } catch { /* listener's problem */ } }));
  }

  // Register for queue-depth changes (drives the sync indicator).
  function onChange(fn) {
    listeners.add(fn);
    notify();
    return () => listeners.delete(fn);
  }

  async function stats() {
    const items = await all();
    return {
      pending: items.filter((i) => i.state === 'pending').length,
      failed: items.filter((i) => i.state === 'failed').length,
      items,
    };
  }

  function all() {
    return tx('readonly', (store) => reqAsPromise(store.getAll()));
  }

  // Add a write to the queue.
  //
  // `label` is what the user is told is waiting ("Mark delivered"), NOT the endpoint — the
  // sync indicator is read by a driver, not a developer.
  // `transitionTo` lets the policy recognise "the server already has this" on a 409.
  async function enqueue({ method, path, body, contentType, label, orderId, transitionTo }) {
    const item = {
      method: method || 'POST',
      path,
      body: body ?? null,
      contentType: contentType || 'application/json',
      label: label || 'Change',
      orderId: orderId || null,
      transitionTo: transitionTo || null,
      state: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      queuedAt: Date.now(),
      error: null,
    };
    await tx('readwrite', (store) => reqAsPromise(store.add(item)));
    notify();
    return item;
  }

  function update(item) {
    return tx('readwrite', (store) => reqAsPromise(store.put(item)));
  }

  function remove(seq) {
    return tx('readwrite', (store) => reqAsPromise(store.delete(seq)));
  }

  // Drop a permanently-rejected item once the user has acknowledged it.
  async function discard(seq) {
    await remove(seq);
    notify();
  }

  let flushing = false;

  // Replay the queue in order. Stops at the first item that needs retrying, because later
  // writes for the same order almost always depend on earlier ones landing first.
  //
  // `send` is injected: (item) => Promise<{status, currentStatus?}>. Keeping the transport out
  // of here is what lets the policy be tested without a network.
  async function flush(send) {
    if (flushing) return { sent: 0, kept: 0 };
    flushing = true;
    let sent = 0;
    let kept = 0;
    try {
      const items = (await all()).filter((i) => i.state === 'pending');
      for (const item of items) {
        if (!GMSync.isDue(item)) { kept += 1; break; }

        let outcome;
        try {
          // eslint-disable-next-line no-await-in-loop
          outcome = await send(item);
        } catch {
          outcome = { status: 0 }; // never reached the server
        }

        const verdict = GMSync.classify({
          status: outcome.status,
          attempts: item.attempts + 1,
          isTransitionTo: item.transitionTo,
          currentStatus: outcome.currentStatus || null,
        });

        if (verdict.action === GMSync.DONE) {
          // eslint-disable-next-line no-await-in-loop
          await remove(item.seq);
          sent += 1;
        } else if (verdict.action === GMSync.RETRY) {
          item.attempts += 1;
          item.nextAttemptAt = Date.now() + (verdict.retryInMs || 1000);
          item.error = null;
          // eslint-disable-next-line no-await-in-loop
          await update(item);
          kept += 1;
          break; // preserve ordering: don't run ahead of a write that hasn't landed
        } else {
          // Rejected on the merits. Keep it visible — silently dropping a driver's "delivered"
          // is the one thing this queue must never do.
          item.state = 'failed';
          item.error = verdict.reason;
          // eslint-disable-next-line no-await-in-loop
          await update(item);
        }
      }
    } finally {
      flushing = false;
      notify();
    }
    return { sent, kept };
  }

  // Wipe everything (sign-out: the queue holds another person's writes otherwise).
  async function clear() {
    await tx('readwrite', (store) => reqAsPromise(store.clear()));
    notify();
  }

  global.GMQueue = { enqueue, flush, all, stats, onChange, discard, clear };
})(window);
