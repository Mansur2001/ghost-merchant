// Runs before any test module is imported (jest `setupFiles`). config.js calls required()
// for these at import time, so they must exist before the module graph loads. Wallet tests
// pass their wallets explicitly, so no merchant number or dial code is pinned here.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';
