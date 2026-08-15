// Outbound SMS — currently only used to deliver login passcodes.
//
// THREE TRANSPORTS, and the choice is per-country, not global:
//
//   oracle  — the Somali market. Backend -> HMAC-signed HTTP -> Termux listener on the Oracle
//             phone -> `termux-sms-send`. No telecom API, no vendor, no per-message cost
//             beyond the SIM's own tariff. This is the sovereignty requirement working as
//             intended, and it stays the path for +252.
//   twilio  — everything else, which today means +1 numbers used for testing and for a Play
//             reviewer who has to receive a code to get past the first screen. A Somali SIM
//             sending internationally is slow, expensive and unreliable, so routing +1 through
//             the Oracle would look like "the app is broken".
//   log     — dev only. Prints the code. The backend REFUSES TO BOOT with this under
//             NODE_ENV=production, because anyone with log access could log in as any customer.
//
// Twilio is a deliberate, bounded exception to "no vendor relationships" (CLAUDE.md): it
// carries the non-Somali path only. If it is unconfigured, +252 delivery is unaffected — the
// business keeps working without it.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { parsePhone } from '../domain/phone.js';
import { queueSms } from './smsQueue.js';
import { oracleStatus } from '../realtime/oracleMonitor.js';

export class SmsDeliveryError extends Error {}

function sign(body) {
  return crypto.createHmac('sha256', config.oracleWebhookSecret).update(body).digest('hex');
}

// Queue for the Oracle phone to collect. Deliberately NOT an HTTP call to the device: a
// phone cannot accept inbound connections (carrier NAT on mobile data, router NAT on WiFi),
// so calling it would require a VPN or tunnel. The phone polls instead — see notify/smsQueue.js.
//
// This is the path that makes SMS login work in Somalia with NO telecom integration: the code
// goes out over the merchant's own SIM at normal subscriber rates.
async function sendViaOracle(phone, text) {
  await queueSms({ to: phone, body: text });
  // Queued, not delivered. The phone collects within one poll (a few seconds), well inside
  // the 5-minute code TTL. If the phone is offline the message expires unsent and is swept,
  // which is visible to the operator as a growing queue rather than a silent failure.
}

// Twilio's REST API over plain HTTPS + basic auth. No SDK on purpose: the SDK is ~10MB of
// dependency for one form POST, and this keeps the image small and the supply chain short.
async function sendViaTwilio(phone, text) {
  const { accountSid, authToken, from, messagingServiceSid } = config.otp.twilio;
  if (!accountSid || !authToken || (!from && !messagingServiceSid)) {
    throw new SmsDeliveryError(
      'twilio transport selected but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM are not set'
    );
  }

  const form = new URLSearchParams({ To: phone, Body: text });
  // A Messaging Service handles number pooling and compliance; a bare from-number is the
  // simpler trial setup. Prefer the service when both are present.
  if (messagingServiceSid) form.set('MessagingServiceSid', messagingServiceSid);
  else form.set('From', from);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.otp.sendTimeoutMs);
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
        signal: controller.signal,
      }
    );

    if (!res.ok) {
      // Twilio's error body is JSON with a `message` and a `code`. Surface the code — the
      // common failures are specific and actionable (21608 = number not verified on a trial
      // account, 21211 = invalid To), and a generic "send failed" would send someone hunting
      // through logs for something the API already told us.
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.message) detail = `${body.message}${body.code ? ` (code ${body.code})` : ''}`;
      } catch {
        /* keep the status-only detail */
      }
      throw new SmsDeliveryError(`twilio send failed: ${detail}`);
    }
  } catch (err) {
    if (err instanceof SmsDeliveryError) throw err;
    throw new SmsDeliveryError(`twilio send failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Which transport carries this number.
//
// `auto` is the setting that makes a mixed deployment work: Somali numbers keep going through
// the Oracle phone (no vendor, no per-message cost), everything else goes to Twilio. Any
// explicit transport overrides it, which is what makes a pure-Oracle production deployment or
// a pure-log dev box still possible.
export function transportFor(phone) {
  const configured = config.otp.transport;
  if (configured !== 'auto') return configured;

  const parsed = parsePhone(phone);
  if (parsed.valid && parsed.country === 'SO') return 'oracle';
  return 'twilio';
}

// Is the transport actually usable, or is it selected but unconfigured?
function isConfigured(transport) {
  // "Configured" for the Oracle means a PHONE IS ACTUALLY COLLECTING, not that a setting is
  // present — queuing itself needs nothing but a database, so a config check would always
  // pass and every login would silently queue a message nobody sends.
  //
  // Three states, and the middle one matters:
  //   healthy        — a phone is polling. Queue it; it goes out in seconds.
  //   down           — a phone WAS polling and went quiet. Still queue: it is probably a
  //                    tunnel or a screen lock, and the message waits for it.
  //   not_configured — no phone has ever polled. Queuing would be a black hole.
  if (transport === 'oracle') return oracleStatus().state !== 'not_configured';
  if (transport === 'twilio') {
    const t = config.otp.twilio;
    return Boolean(t.accountSid && t.authToken && (t.from || t.messagingServiceSid));
  }
  return true; // 'log' needs nothing
}

// Never let the passcode reach the caller — the ONLY way a code leaves the server is over the
// chosen transport. (The dev-mode echo lives in the route, gated on the log transport, so
// this stays true for every production configuration.)
export async function sendOtpSms(phone, code) {
  const text = `GuriKaabe: your code is ${code}. It expires in 5 minutes. Never share it.`;
  let transport = transportFor(phone);

  // The dev-log fallback exists so that OTP_TRANSPORT=auto — the correct setting for a mixed
  // deployment — doesn't break every local sign-in before credentials exist. It is a
  // convenience for a dev box, and it is deliberately narrow:
  //
  //   * never in production (printing a customer's login code to a server log is worse than
  //     an error an operator can see), and
  //   * never when a transport was named EXPLICITLY. Asking for `twilio` and silently getting
  //     the log is the worst outcome: you believe you are testing real delivery, the code
  //     appears in the response, and you never learn the credentials are wrong. If you named
  //     it, you meant it, so it fails loudly instead.
  const explicit = config.otp.transport !== 'auto';
  if (!isConfigured(transport) && config.env !== 'production' && !explicit) {
    console.warn(
      `[OTP] transport "${transport}" is not configured — falling back to the dev log ` +
        'transport. Set the credentials to send real messages.'
    );
    transport = 'log';
  }

  if (transport === 'oracle') {
    await sendViaOracle(phone, text);
    return { transport: 'oracle' };
  }

  if (transport === 'twilio') {
    await sendViaTwilio(phone, text);
    return { transport: 'twilio' };
  }

  // `log` transport. Tagged so it is trivially greppable in a log audit.
  console.warn(`[OTP][dev-transport] ${phone} -> ${code}`);
  return { transport: 'log' };
}
