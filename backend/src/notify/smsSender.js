// Outbound SMS: customer login codes and staff setup codes.
//
// Twilio carries EVERY text, Somali and international alike: one account, no hardware to keep
// alive, pay-as-you-go. It is the one deliberate vendor exception (CLAUDE.md), and it is
// bounded: it carries a code, never money. Email codes go through Twilio SendGrid
// (notify/emailSender.js) under the same transport setting.
//
//   twilio — the production transport, for every number. `auto` means this.
//   log    — dev only. Prints the code. The backend REFUSES TO BOOT with this under
//            NODE_ENV=production, because anyone with log access could log in as any customer.
import { config } from '../config.js';
import { parsePhone } from '../domain/phone.js';
import { setupMessage } from '../domain/staffInvite.js';

// `failure` is a short code that is safe to show a user and quote back to us ("SMS-21408"): the
// provider's error number or what kind of failure it was, never the message text or a key.
export class SmsDeliveryError extends Error {
  constructor(message, failure = 'SMS') {
    super(message);
    this.failure = failure;
  }
}

// Twilio's Messages API over plain HTTPS + basic auth (Account SID : Auth Token). No SDK on
// purpose: it would be a large dependency for one form POST, and this keeps the supply chain short.
async function sendViaTwilio(phone, text) {
  const { accountSid, authToken, messagingServiceSid, from } = config.otp.twilio;
  if (!twilioConfigured()) {
    throw new SmsDeliveryError(
      'twilio transport selected but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / ' +
        'TWILIO_MESSAGING_SERVICE_SID (or TWILIO_FROM) are not set',
      'SMS-NOCONFIG'
    );
  }

  const form = new URLSearchParams({ To: phone, Body: text });
  // The Messaging Service is what the 10DLC campaign is registered on; a bare number is the
  // fallback. US carriers filter texts from unregistered senders (docs/LIVE_SMS_SETUP.md).
  if (messagingServiceSid) form.set('MessagingServiceSid', messagingServiceSid);
  else form.set('From', from);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.otp.sendTimeoutMs);
  let res;
  let body = null;
  try {
    res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: controller.signal,
    });
    try {
      body = await res.json();
    } catch {
      /* keep the status-only detail */
    }
  } catch (err) {
    throw new SmsDeliveryError(`twilio send failed: ${err.message}`, err.name === 'AbortError' ? 'SMS-TIMEOUT' : 'SMS-NETWORK');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Twilio's own error code (e.g. 21408 "permission to send to this region", 21610
    // "recipient replied STOP") is the fastest route to the cause — keep it in the message.
    const detail = body?.code ? `${body.code}: ${body.message || ''}`.trim() : `HTTP ${res.status}`;
    throw new SmsDeliveryError(`twilio send failed: ${detail}`, `SMS-${body?.code || `HTTP${res.status}`}`);
  }
  // Accepted for delivery ('queued' / 'accepted'). A message created already failed is a
  // failure, never "sent".
  if (!body?.sid || body.status === 'failed' || body.status === 'undelivered') {
    throw new SmsDeliveryError(`twilio send failed: ${body?.error_code || body?.status || 'no message returned'}`, `SMS-${body?.error_code || 'FAILED'}`);
  }
}

function twilioConfigured() {
  const t = config.otp.twilio;
  return Boolean(t.accountSid && t.authToken && (t.messagingServiceSid || t.from));
}

// Which transport to use. `auto` is Twilio; an explicit `log` keeps a dev box offline.
export function transportFor() {
  return config.otp.transport === 'auto' ? 'twilio' : config.otp.transport;
}

function devAllowlisted(phone) {
  const target = parsePhone(phone).e164;
  return Boolean(target) && config.otp.devSmsAllowlist.some((n) => parsePhone(n).e164 === target);
}

// Never let the passcode reach the caller — the ONLY way a code leaves the server is over the
// chosen transport. (The dev-mode echo lives in the route, gated on the log transport, so
// this stays true for every production configuration.)
export async function sendOtpSms(phone, code) {
  return deliverCode(phone, code, `GuriKaabe: your code is ${code}. It expires in 5 minutes. Never share it.`);
}

// A staff account's one-time setup code (commands/staffAccounts.js). Same transport, same dev
// allowlist, same refusal to print codes in production as a login code.
export async function sendSetupSms(phone, role, code) {
  return deliverCode(phone, code, setupMessage(role, code));
}

// Decide whether a code really goes out, or only to the dev log. Shared with email
// (notify/emailSender.js) so both channels obey exactly the same rules.
//
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
export function resolveTransport({ configured, allowlisted, target, allowlistName }) {
  let transport = transportFor();
  const explicit = config.otp.transport !== 'auto';
  if (transport !== 'log' && !configured && config.env !== 'production' && !explicit) {
    console.warn(
      `[OTP] transport "${transport}" is not configured — falling back to the dev log ` +
        'transport. Set the credentials to send real messages.'
    );
    transport = 'log';
  }

  // Dev never messages someone nobody vouched for — see config.otp.dev*Allowlist.
  if (config.env !== 'production' && transport !== 'log' && !allowlisted) {
    console.warn(`[OTP] ${target} is not on ${allowlistName} — showing the code instead of sending it.`);
    transport = 'log';
  }
  return transport;
}

async function deliverCode(phone, code, text) {
  const transport = resolveTransport({
    configured: twilioConfigured(),
    allowlisted: devAllowlisted(phone),
    target: phone,
    allowlistName: 'DEV_SMS_ALLOWLIST',
  });

  if (transport === 'twilio') {
    await sendViaTwilio(phone, text);
    return { transport: 'twilio' };
  }
  if (transport !== 'log') throw new SmsDeliveryError(`unknown OTP_TRANSPORT "${transport}"`);

  // `log` transport. Tagged so it is trivially greppable in a log audit.
  console.warn(`[OTP][dev-transport] ${phone} -> ${code}`);
  return { transport: 'log' };
}
