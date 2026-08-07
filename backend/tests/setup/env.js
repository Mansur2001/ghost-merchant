// Runs before any test module is imported (jest `setupFiles`). config.js calls required()
// for these at import time, so they must exist before the module graph loads. We also pin
// the payment template so the USSD tests are deterministic regardless of the local .env.
process.env.ORACLE_WEBHOOK_SECRET = process.env.ORACLE_WEBHOOK_SECRET || 'test-oracle-secret';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';
process.env.MERCHANT_MSISDN = '612345678';
process.env.USSD_TEMPLATE = '*712*{NUM}*{AMT}%23';
