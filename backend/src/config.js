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
    host: process.env.POSTGRES_HOST || 'postgres',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'ghost_merchant',
    user: process.env.POSTGRES_USER || 'ghost',
    password: process.env.POSTGRES_PASSWORD || 'ghost',
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

  otp: {
    // 'log' (dev: code printed to the server log) | 'oracle' (real SMS via the Oracle phone).
    transport: process.env.OTP_TRANSPORT || 'log',
    oracleSmsUrl: process.env.ORACLE_SMS_URL || '',
    sendTimeoutMs: parseInt(process.env.OTP_SEND_TIMEOUT_MS || '10000', 10),
  },

  // Behind Caddy the socket peer is always the proxy, so req.ip would be the proxy for every
  // request and the rate limiter would bucket the whole world together. Trust exactly ONE
  // hop: enough to read the real client IP, not enough for a client to forge it by sending
  // its own X-Forwarded-For (Express takes the value the trusted hop appended).
  trustProxyHops: parseInt(process.env.TRUST_PROXY_HOPS || '1', 10),
};
