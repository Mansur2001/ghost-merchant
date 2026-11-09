// Outbound email: login codes for customers who linked an email, the code that confirms a new
// email, staff setup codes an admin chose to send by email, and the "your password was
// changed" notice (no code, no secret — it tells the owner, so a hijack doesn't go unseen).
//
// Twilio SendGrid, under the same OTP_TRANSPORT as SMS (notify/smsSender.js) and the same
// rules: real mail in production, never a code in the log there, and in dev only to addresses
// on DEV_EMAIL_ALLOWLIST. Like SMS, it carries a code and nothing else.
import { config } from '../config.js';
import { resolveTransport } from './smsSender.js';
import { setupMessage } from '../domain/staffInvite.js';

// `failure`: a short code safe to show a user ("EMAIL-HTTP403"), like SmsDeliveryError's.
export class EmailDeliveryError extends Error {
  constructor(message, failure = 'EMAIL') {
    super(message);
    this.failure = failure;
  }
}

export function emailConfigured() {
  const g = config.otp.sendgrid;
  return Boolean(g.apiKey && g.from);
}

// SendGrid's v3 mail/send over plain HTTPS. Same key as their SMTP relay; no SDK, for the same
// supply-chain reason as SMS.
async function sendViaSendGrid(to, subject, text) {
  const { apiKey, from } = config.otp.sendgrid;
  if (!emailConfigured()) {
    throw new EmailDeliveryError('email selected but SENDGRID_API_KEY / EMAIL_FROM are not set', 'EMAIL-NOCONFIG');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.otp.sendTimeoutMs);
  let res;
  let body = null;
  try {
    res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from, name: 'GuriKaabe' },
        subject,
        content: [{ type: 'text/plain', value: text }],
        // A code must not be rewritten into a tracked link or counted as an "open".
        tracking_settings: { click_tracking: { enable: false }, open_tracking: { enable: false } },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      try { body = await res.json(); } catch { /* status only */ }
    }
  } catch (err) {
    throw new EmailDeliveryError(`sendgrid send failed: ${err.message}`, err.name === 'AbortError' ? 'EMAIL-TIMEOUT' : 'EMAIL-NETWORK');
  } finally {
    clearTimeout(timer);
  }
  // 202 Accepted is the only success. The first error message usually names the cause
  // (unverified sender, key without Mail Send permission).
  if (res.status !== 202) {
    const detail = body?.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new EmailDeliveryError(`sendgrid send failed: ${detail}`, `EMAIL-HTTP${res.status}`);
  }
}

function devAllowlisted(email) {
  return config.otp.devEmailAllowlist.includes(String(email).toLowerCase());
}

// The notice after a password is set or changed (OWASP: tell the owner on the channel they
// own). It carries nothing secret, so in dev the log line names no address and no content.
export async function sendPasswordChangedNotice(email, { first = false } = {}) {
  const transport = resolveTransport({
    configured: emailConfigured(),
    allowlisted: devAllowlisted(email),
    target: email,
    allowlistName: 'DEV_EMAIL_ALLOWLIST',
  });
  if (transport === 'log') {
    console.warn('[EMAIL][dev-transport] password-changed notice (not sent)');
    return { transport: 'log' };
  }
  const what = first ? 'set' : 'changed';
  await sendViaSendGrid(email, `Your GuriKaabe password was ${what}`,
    `Your GuriKaabe password was just ${what}. If this was you, there is nothing to do.\n` +
    `If it wasn't you: open GuriKaabe, tap "Forgot your password? Sign in with an emailed ` +
    `code", sign in with the code we send to this email, and set a new password.\n\n` +
    `Furaha sirta GuriKaabe waa la ${first ? 'sameeyay' : 'beddelay'}. Haddii adiga ay ahayd, waxba ha samayn.\n` +
    `Haddii aadan adiga ahayn: fur GuriKaabe, riix "Furaha sirta ma ilowday?", ku gal koodhka aan ` +
    `emailkan u dirno, kadibna samee furaha sirta cusub.`);
  return { transport };
}

async function deliver(email, code, subject, text) {
  const transport = resolveTransport({
    configured: emailConfigured(),
    allowlisted: devAllowlisted(email),
    target: email,
    allowlistName: 'DEV_EMAIL_ALLOWLIST',
  });
  if (transport === 'twilio') {
    await sendViaSendGrid(email, subject, text);
    return { transport: 'twilio' };
  }
  if (transport !== 'log') throw new EmailDeliveryError(`unknown OTP_TRANSPORT "${transport}"`);
  console.warn(`[OTP][dev-transport] ${email} -> ${code}`);
  return { transport: 'log' };
}

export async function sendOtpEmail(email, code) {
  return deliver(email, code, `Your GuriKaabe code: ${code}`,
    `Your GuriKaabe code is ${code}. It expires in 5 minutes. Never share it.\n\n` +
    `Koodhkaaga GuriKaabe waa ${code}. Wuxuu shaqeynayaa 5 daqiiqo. Qofna ha siin.`);
}

export async function sendEmailLinkCode(email, code) {
  return deliver(email, code, `Confirm your email for GuriKaabe: ${code}`,
    `Enter ${code} in GuriKaabe to use this email for sign-in codes. It expires in 5 minutes.\n` +
    `If you didn't ask for this, ignore this email.\n\n` +
    `Geli ${code} GuriKaabe si emailkan loogu isticmaalo koodhka. Haddii aadan codsan, iska dhaaf.`);
}

export async function sendSetupEmail(email, role, code) {
  return deliver(email, code, 'Your GuriKaabe account is ready', setupMessage(role, code));
}
