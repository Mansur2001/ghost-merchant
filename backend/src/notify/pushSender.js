// Delivering one push to one device. Two channels, both off until configured:
//
//   webpush  browsers and installed PWAs. Our own VAPID key pair (scripts/vapid-keys.mjs); the
//            browser's push service relays it. No account with anyone.
//   fcm      the Android app. Firebase Cloud Messaging HTTP v1, one HTTPS call signed with a
//            service-account key — no Google SDK. Needs the owner's (free) Firebase project.
//
// Returns 'ok' | 'gone' (the device unsubscribed: delete the row) | 'error'.
import webpush from 'web-push';
import { createSign } from 'node:crypto';
import { config } from '../config.js';

let vapidSet = false;
function ensureVapid(settings) {
  if (vapidSet || !settings.webpush.enabled) return;
  webpush.setVapidDetails(settings.webpush.subject, settings.webpush.publicKey, settings.webpush.privateKey);
  vapidSet = true;
}

export async function sendWebPush(sub, message, { settings = config.push, send = (s, b, o) => webpush.sendNotification(s, b, o) } = {}) {
  if (!settings.webpush.enabled) return 'error';
  ensureVapid(settings);
  try {
    await send(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(message),
      // Delivered within a day or not at all; "you have arrived" a week late is noise.
      { TTL: 24 * 3600, urgency: 'high', topic: String(message.tag || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined }
    );
    return 'ok';
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) return 'gone';
    console.warn(`[push] web push failed: ${err.statusCode || ''} ${String(err.body || err.message).slice(0, 120)}`);
    return 'error';
  }
}

// ── FCM ──
let fcmToken = null; // { value, until }
const b64url = (b) => Buffer.from(b).toString('base64url');

async function fcmAccessToken(sa, fetchImpl) {
  if (fcmToken && fcmToken.until > Date.now() + 60_000) return fcmToken.value;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: sa.token_uri, iat: now, exp: now + 3600,
  }));
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key, 'base64url');
  const res = await fetchImpl(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`FCM token ${res.status}`);
  const body = await res.json();
  fcmToken = { value: body.access_token, until: Date.now() + (body.expires_in || 3600) * 1000 };
  return fcmToken.value;
}

export async function sendFcm(sub, message, { settings = config.push, fetchImpl = fetch } = {}) {
  const sa = settings.fcm.account;
  if (!settings.fcm.enabled) return 'error';
  try {
    const token = await fcmAccessToken(sa, fetchImpl);
    const res = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        message: {
          token: sub.endpoint,
          notification: { title: message.title, body: message.body },
          data: { url: message.url || '/', tag: message.tag || '' },
          android: { priority: 'high', ttl: '86400s', notification: { tag: message.tag || undefined } },
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return 'ok';
    const text = await res.text();
    if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT.*token/i.test(text)) return 'gone';
    console.warn(`[push] FCM ${res.status}: ${text.slice(0, 160)}`);
    return 'error';
  } catch (err) {
    console.warn(`[push] FCM failed: ${err.message}`);
    return 'error';
  }
}

export function resetPushSenders() { vapidSet = false; fcmToken = null; }
