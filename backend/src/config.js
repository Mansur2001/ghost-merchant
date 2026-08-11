// Central config. All secrets come from the environment (.env in dev, real env on the VPS).
import dotenv from 'dotenv';
dotenv.config();

const required = (key) => {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
};

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  corsOrigins: (process.env.CORS_ORIGINS || 'https://localhost')
    .split(',')
    .map((s) => s.trim()),

  db: {
    // Prisma takes a single connection URL. Built from the same pieces the rest of the stack
    // uses so there is one place to change credentials, with DATABASE_URL as an override for
    // the CLI and for a managed database that hands you a URL directly.
    get url() {
      if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
      const host = process.env.POSTGRES_HOST || 'postgres';
      const port = process.env.POSTGRES_PORT || '5432';
      const name = process.env.POSTGRES_DB || 'ghost_merchant';
      const user = encodeURIComponent(process.env.POSTGRES_USER || 'ghost');
      const pass = encodeURIComponent(process.env.POSTGRES_PASSWORD || 'ghost');
      return `postgresql://${user}:${pass}@${host}:${port}/${name}?schema=public`;
    },
    host: process.env.POSTGRES_HOST || 'postgres',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'ghost_merchant',
    user: process.env.POSTGRES_USER || 'ghost',
    password: process.env.POSTGRES_PASSWORD || 'ghost',

    // Per-operation CAP choice (see db/pool.js).
    //
    // apCommit  — chat, photos, tracking. 'local' returns without waiting for a replica, so
    //             these stay responsive when the standby is slow. Availability over strict
    //             durability, for data a customer can retype.
    // cpCommit  — money and state transitions. With a synchronous standby configured, set
    //             this to 'remote_apply' so an acknowledged payment survives losing the
    //             primary. Without a standby, 'on' (flush to local disk) is the strongest
    //             available guarantee and is the correct default.
    apCommit: process.env.PG_AP_COMMIT || 'local',
    cpCommit: process.env.PG_CP_COMMIT || 'on',
    // How long a critical write may wait before we refuse it. Under a synchronous-replication
    // partition the commit would otherwise hang forever; this turns that into a loud 503.
    criticalTimeoutMs: parseInt(process.env.PG_CRITICAL_TIMEOUT_MS || '5000', 10),
  },

  s3: {
    endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
    region: process.env.S3_REGION || 'us-east-1',
    bucket: process.env.S3_BUCKET || 'ghost-documents',
    accessKey: process.env.S3_ACCESS_KEY || 'ghost_minio_access',
    secretKey: process.env.S3_SECRET_KEY || 'ghost_minio_secret',
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE || 'true') === 'true',
  },

  oracleWebhookSecret: required('ORACLE_WEBHOOK_SECRET'),
  sessionSecret: required('SESSION_SECRET'),
  // Bootstrap credential ONLY: used once, on first boot, to create the initial named operator
  // account when the roster is empty (commands/operators.js). After that, accounts live in the
  // operators table and this value is inert — real logins never consult it.
  operatorPassword: process.env.OPERATOR_PASSWORD || 'change_me_operator_password',
  bootstrapOperator: {
    username: (process.env.BOOTSTRAP_OPERATOR_USERNAME || 'admin').trim().toLowerCase(),
  },

  payment: {
    merchantMsisdn: process.env.MERCHANT_MSISDN || '61XXXXXXX',
    ussdTemplate: process.env.USSD_TEMPLATE || '*712*{NUM}*{AMT}%23',
    senderIds: (process.env.TELECOM_SENDER_IDS || 'EVCPlus')
      .split(',')
      .map((s) => s.trim()),
  },

  oracleHeartbeatTimeoutMs:
    parseInt(process.env.ORACLE_HEARTBEAT_TIMEOUT_SECONDS || '180', 10) * 1000,

  // Redis is OPTIONAL. Unset = single-instance mode (in-process bus + rate limiter), which
  // is exactly how this ran before P2. Set it to run more than one backend container.
  redis: {
    url: process.env.REDIS_URL || '',
  },

  otp: {
    // 'log'    — dev only, prints the code. Refused under NODE_ENV=production.
    // 'oracle' — real SMS via the Oracle phone (no vendor). The Somali path. Needs no URL:
    //            the backend queues, and the phone polls for what to send (see notify/smsQueue.js).
    // 'twilio' — real SMS via Twilio. Non-Somali numbers (testing, Play review).
    // 'auto'   — per country: +252 via the Oracle, everything else via Twilio.
    transport: process.env.OTP_TRANSPORT || 'log',
    sendTimeoutMs: parseInt(process.env.OTP_SEND_TIMEOUT_MS || '10000', 10),
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      from: process.env.TWILIO_FROM || '',
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID || '',
    },
  },

  // Missed-call verification: the number customers call to prove they hold their phone.
  // Unset = the flow is unavailable and clients fall back to an SMS passcode, so a deployment
  // without a call-capable device is a supported configuration rather than a broken one.
  verifyCall: {
    number: process.env.VERIFY_CALL_NUMBER || '',
  },

  // Payment sensing over email — the Oracle's job without the phone. Every US rail emails
  // the same notification it texts, and the server can read a mailbox directly: no handset,
  // no APK, no Android permissions. Unset = disabled.
  emailSensor: {
    host: process.env.IMAP_HOST || '',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: (process.env.IMAP_SECURE || 'true') === 'true',
    user: process.env.IMAP_USER || '',
    password: process.env.IMAP_PASSWORD || '',
    mailbox: process.env.IMAP_MAILBOX || 'INBOX',
    pollSeconds: parseInt(process.env.IMAP_POLL_SECONDS || '30', 10),
    // A first run must not replay a year of old notifications into the reconcile queue.
    lookbackHours: parseInt(process.env.IMAP_LOOKBACK_HOURS || '24', 10),
  },

  // Shown on the access-request page so someone who can't or won't use the form has a person
  // to contact. Public by design — it is the owner's business contact.
  owner: {
    name: process.env.OWNER_NAME || 'GuriKaabe',
    email: process.env.OWNER_EMAIL || 'tukale206@gmail.com',
    phone: process.env.OWNER_PHONE || '+1 206 687 6538',
  },

  // Behind Caddy the socket peer is always the proxy, so req.ip would be the proxy for every
  // request and the rate limiter would bucket the whole world together. Trust exactly ONE
  // hop: enough to read the real client IP, not enough for a client to forge it by sending
  // its own X-Forwarded-For (Express takes the value the trusted hop appended).
  trustProxyHops: parseInt(process.env.TRUST_PROXY_HOPS || '1', 10),
};
