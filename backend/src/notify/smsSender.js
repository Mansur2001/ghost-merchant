// Outbound SMS — currently only used to deliver login passcodes.
//
// ClickSend carries EVERY login code, Somali and international alike. It reaches +252 and
// +1 (toll-free) from one account, with no hardware to keep alive, which is the difference
// between "logins work" and "logins work while a phone in another country stays charged".
// The Oracle phone keeps its real job — reading payment receipts — and no longer sends texts.
//
//   clicksend — the production path, for every number. `auto` means this.
//   oracle    — legacy: queue for the Oracle phone to send over its own SIM. Only used if named
//               explicitly; kept so a deployment can fall back to it without a code change.
//   log       — dev only. Prints the code. The backend REFUSES TO BOOT with this under
//               NODE_ENV=production, because anyone with log access could log in as any customer.
//
// ClickSend is a deliberate, bounded exception to "no vendor relationships" (CLAUDE.md): it is
// pay-as-you-go (no monthly fee) and it sits OUTSIDE the money path — it carries a login code,
// never a payment.
import { config } from '../config.js';
import { parsePhone } from '../domain/phone.js';
import { setupMessage } from '../domain/staffInvite.js';
import { queueSms } from './smsQueue.js';
import { oracleStatus } from '../realtime/oracleMonitor.js';

export class SmsDeliveryError extends Error {}

// Queue for the Oracle phone to collect. Deliberately NOT an HTTP call to the device: a
// phone cannot accept inbound connections (carrier NAT on mobile data, router NAT on WiFi),
// so calling it would require a VPN or tunnel. The phone polls instead — see notify/smsQueue.js.
async function sendViaOracle(phone, text) {
  await queueSms({ to: phone, body: text });
  // Queued, not delivered. The phone collects within one poll (a few seconds), well inside
  // the 5-minute code TTL. If the phone is offline the message expires unsent and is swept,
  // which is visible to the operator as a growing queue rather than a silent failure.
}

// ClickSend's REST API over plain HTTPS + basic auth (username : API key). No SDK on purpose:
// it would be a large dependency for one JSON POST, and this keeps the supply chain short.
async function sendViaClickSend(phone, text) {
  const { username, apiKey, from } = config.otp.clicksend;
  if (!username || !apiKey) {
    throw new SmsDeliveryError(
      'clicksend transport selected but CLICKSEND_USERNAME / CLICKSEND_API_KEY are not set'
    );
  }

  const message = { source: 'gurikaabe', to: phone, body: text };
  // Unset = ClickSend's shared sender. US carriers only accept registered senders now, so a
  // +1 destination needs a verified toll-free number here (docs/LIVE_SMS_SETUP.md).
  if (from) message.from = from;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.otp.sendTimeoutMs);
  let res;
  let body = null;
  try {
    res = await fetch('https://rest.clicksend.com/v3/sms/send', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${apiKey}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages: [message] }),
      signal: controller.signal,
    });
    try {
      body = await res.json();
    } catch {
      /* keep the status-only detail */
    }
  } catch (err) {
    throw new SmsDeliveryError(`clicksend send failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = body?.response_code
      ? `${body.response_code}: ${body.response_msg || ''}`.trim()
      : `HTTP ${res.status}`;
    throw new SmsDeliveryError(`clicksend send failed: ${detail}`);
  }

  // ClickSend answers HTTP 200 for the BATCH even when the one message in it was refused
  // (INVALID_RECIPIENT, INSUFFICIENT_CREDIT, COUNTRY_NOT_ENABLED...). The per-message status is
  // the real answer; treating the 200 as success would report a code sent that never left.
  const status = body?.data?.messages?.[0]?.status;
  if (status !== 'SUCCESS') {
    throw new SmsDeliveryError(`clicksend send failed: ${status || 'no message status returned'}`);
  }
}

function clickSendConfigured() {
  const c = config.otp.clicksend;
  return Boolean(c.username && c.apiKey);
}

// Which transport carries this number. `auto` is ClickSend for everyone; an explicit
// transport overrides it (a dev box forcing `log`, or a fallback to `oracle`).
export function transportFor() {
  const configured = config.otp.transport;
  return configured === 'auto' ? 'clicksend' : configured;
}

// Is the transport actually usable, or is it selected but unconfigured?
function isConfigured(transport) {
  // "Configured" for the Oracle means a PHONE HAS COLLECTED, not that a setting is present —
  // queuing itself needs nothing but a database, so a config check would always pass and
  // every login would silently queue a message nobody sends.
  if (transport === 'oracle') return oracleStatus().state !== 'not_configured';
  if (transport === 'clicksend') return clickSendConfigured();
  return true; // 'log' needs nothing
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

async function deliverCode(phone, code, text) {
  let transport = transportFor();

  // The dev-log fallback exists so that OTP_TRANSPORT=auto — the correct setting for a mixed
  // deployment — doesn't break every local sign-in before credentials exist. It is a
  // convenience for a dev box, and it is deliberately narrow:
  //
  //   * never in production (printing a customer's login code to a server log is worse than
  //     an error an operator can see), and
  //   * never when a transport was named EXPLICITLY. Asking for `clicksend` and silently
  //     getting the log is the worst outcome: you believe you are testing real delivery, the
  //     code appears in the response, and you never learn the credentials are wrong. If you
  //     named it, you meant it, so it fails loudly instead.
  const explicit = config.otp.transport !== 'auto';
  if (!isConfigured(transport) && config.env !== 'production' && !explicit) {
    console.warn(
      `[OTP] transport "${transport}" is not configured — falling back to the dev log ` +
        'transport. Set the credentials to send real messages.'
    );
    transport = 'log';
  }

  // Dev never texts a number nobody vouched for — see config.otp.devSmsAllowlist.
  if (config.env !== 'production' && transport !== 'log' && !devAllowlisted(phone)) {
    console.warn(
      `[OTP] ${phone} is not on DEV_SMS_ALLOWLIST — showing the code instead of texting it.`
    );
    transport = 'log';
  }

  if (transport === 'oracle') {
    await sendViaOracle(phone, text);
    return { transport: 'oracle' };
  }

  if (transport === 'clicksend') {
    await sendViaClickSend(phone, text);
    return { transport: 'clicksend' };
  }

  // `log` transport. Tagged so it is trivially greppable in a log audit.
  console.warn(`[OTP][dev-transport] ${phone} -> ${code}`);
  return { transport: 'log' };
}
