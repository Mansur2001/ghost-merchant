// Payment sensing over EMAIL — the same job as the Oracle phone, without the phone.
//
// WHY THIS EXISTS: reading SMS on Android requires an app holding the SMS permission
// (Termux:API), installed from the right source, with the permission granted by hand. That is
// three manual steps on a physical device before a single payment can be confirmed.
//
// Every US rail — Zelle, Cash App, Venmo — emails the recipient the same notification it
// texts them. So the merchant's inbox is the identical evidence over a transport the SERVER
// can read directly. No handset, no APK, no permissions.
//
// It reuses everything: the same parsers (domain/receipts.js), the same matching rules, the
// same reconcile queue, the same UNIQUE receipt id. Only the transport differs — which is
// what "the Oracle is a sensor" was always supposed to mean.
//
// The Somali rails still need the phone: EVC Plus texts, it does not email.
//
// SECURITY: an email From: header is as forgeable as an SMS sender ID, so this is evidence,
// not proof. The protections are unchanged — a receipt only auto-matches on phone number +
// exact amount + an order actually waiting, anything else goes to the operator, and a
// replayed message cannot credit twice.
import { ImapFlow } from 'imapflow';
import { config } from '../config.js';
import { parseReceipt } from '../domain/receipts.js';
import { recordAndMatchPayment } from '../commands/payments.js';

let client = null;
let timer = null;
let lastFault = null;

function fault(kind, message) {
  if (lastFault === kind) return; // don't repeat the same complaint every poll
  lastFault = kind;
  console.error(`email sensor: ${message}`);
}

export function isEmailSensorEnabled() {
  const { host, user, password } = config.emailSensor;
  return Boolean(host && user && password);
}

// Strip HTML to readable text. These notifications are sent as multipart with an HTML part
// that often carries the amount, so ignoring it would miss real payments.
function toText(input) {
  return String(input || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function connect() {
  const { host, port, user, password, secure } = config.emailSensor;
  const c = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass: password },
    logger: false, // its debug output includes message bodies, i.e. customer data
  });
  await c.connect();
  return c;
}

// Read unseen messages, look for payments, mark them seen.
//
// Marking seen is the local dedupe. It is NOT the safety net — that is the UNIQUE receipt id
// in the database, which holds even if the mailbox is re-read from scratch.
export async function pollEmailOnce() {
  if (!isEmailSensorEnabled()) return { checked: 0, recognised: 0 };

  let checked = 0;
  let recognised = 0;

  try {
    if (!client || !client.usable) client = await connect();
    const lock = await client.getMailboxLock(config.emailSensor.mailbox);
    try {
      // Only unseen mail, and only recent — a first run against an old inbox should not
      // replay a year of payment notifications into the reconcile queue.
      const since = new Date(Date.now() - config.emailSensor.lookbackHours * 3600 * 1000);
      for await (const msg of client.fetch({ seen: false, since }, {
        envelope: true,
        source: true,
        uid: true,
      })) {
        checked += 1;
        const from = msg.envelope?.from?.[0]?.address || '';
        const subject = msg.envelope?.subject || '';
        // Body and subject together: some rails put the amount only in the subject line.
        const body = `${subject}\n${toText(msg.source?.toString('utf8'))}`;

        const receipt = parseReceipt({
          senderId: from,
          body,
          receivedAt: msg.envelope?.date?.getTime?.() || Date.now(),
        });

        // Mark seen either way, or every poll re-reads the same ordinary mail.
        await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true });
        if (!receipt) continue;

        recognised += 1;
        const outcome = await recordAndMatchPayment(receipt);
        console.log(
          `email sensor: ${receipt.provider} $${receipt.amount} from ` +
            `${receipt.senderName || receipt.senderMsisdn} — ` +
            (outcome.duplicate
              ? 'already seen'
              : outcome.orderId
                ? 'matched'
                : 'recorded, needs reconciliation')
        );
      }
    } finally {
      lock.release();
    }

    if (lastFault) {
      console.log('email sensor: connection is working again.');
      lastFault = null;
    }
  } catch (err) {
    // Authentication is the one worth naming: Gmail rejects a normal password outright, and
    // "invalid credentials" sends people checking the password they typed correctly.
    if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(err.message)) {
      fault(
        'auth',
        `login refused (${err.message}). Gmail requires an APP PASSWORD, not your normal ` +
          'password — see docs/EMAIL_SENSOR_SETUP.md'
      );
    } else {
      fault('connect', `${err.message}`);
    }
    try {
      await client?.logout();
    } catch {
      /* already gone */
    }
    client = null;
  }

  return { checked, recognised };
}

export function startEmailSensor() {
  if (!isEmailSensorEnabled()) return;
  if (timer) return;
  console.log(
    `email sensor: watching ${config.emailSensor.user} for payment notifications ` +
      `(every ${config.emailSensor.pollSeconds}s)`
  );
  timer = setInterval(() => {
    pollEmailOnce().catch((err) => fault('poll', err.message));
  }, config.emailSensor.pollSeconds * 1000);
  timer.unref();
  pollEmailOnce().catch(() => {});
}

export async function stopEmailSensor() {
  if (timer) clearInterval(timer);
  timer = null;
  try {
    await client?.logout();
  } catch {
    /* already gone */
  }
  client = null;
}
