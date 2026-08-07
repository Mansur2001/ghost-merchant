// Outbound SMS — currently only used to deliver login passcodes.
//
// We have no telecom API (that's the whole premise), so the send path runs back out through
// the Oracle phone: backend -> HMAC-signed HTTP -> Termux listener on the device ->
// `termux-sms-send`. Same shared secret and signing scheme as the inbound webhook, so the
// trust relationship is symmetric and there is only one secret to rotate.
//
// Transports (OTP_TRANSPORT):
//   log    - print the code to the server log. DEV ONLY. Boot warns loudly if this is set
//            with NODE_ENV=production, because it means anyone with log access can log in
//            as any customer.
//   oracle - real SMS via the Oracle device. Requires ORACLE_SMS_URL. UNVALIDATED ON REAL
//            HARDWARE (see P4 in CLAUDE.md) — the send path is written but has never run
//            against a live Hormuud/Somtel SIM.
import crypto from 'node:crypto';
import { config } from '../config.js';

export class SmsDeliveryError extends Error {}

function sign(body) {
  return crypto.createHmac('sha256', config.oracleWebhookSecret).update(body).digest('hex');
}

async function sendViaOracle(phone, text) {
  if (!config.otp.oracleSmsUrl) {
    throw new SmsDeliveryError('OTP_TRANSPORT=oracle but ORACLE_SMS_URL is not set');
  }
  const body = JSON.stringify({ to: phone, text, sentAt: new Date().toISOString() });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.otp.sendTimeoutMs);
  try {
    const res = await fetch(config.otp.oracleSmsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Oracle-Signature': sign(body) },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new SmsDeliveryError(`oracle SMS send failed: HTTP ${res.status}`);
    }
  } catch (err) {
    if (err instanceof SmsDeliveryError) throw err;
    throw new SmsDeliveryError(`oracle SMS send failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Never let the passcode reach the caller — the ONLY way a code leaves the server is over
// the chosen transport. (The dev-mode echo lives in the route, gated on the log transport,
// so this stays true for every production configuration.)
export async function sendOtpSms(phone, code) {
  const text = `Ghost Merchant: your code is ${code}. It expires in 5 minutes. Never share it.`;

  if (config.otp.transport === 'oracle') {
    await sendViaOracle(phone, text);
    return { transport: 'oracle' };
  }

  // `log` transport. Tag it so it is trivially greppable in a log audit.
  console.warn(`[OTP][dev-transport] ${phone} -> ${code}`);
  return { transport: 'log' };
}
