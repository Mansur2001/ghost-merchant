// Push notifications (domain/push.js decides who is told what; notify/pushSender.js delivers).
//
// Best effort by design: a push is a nudge to open the app, never the record. Postgres and the
// live socket are the truth, so a failed push is logged and dropped — it must never fail or
// slow the request that caused it, and nothing is retried into a pile of stale "arrived"s.
import { prisma } from '../db/prisma.js';
import { config } from '../config.js';
import { textFor } from '../domain/push.js';
import { sendWebPush, sendFcm } from '../notify/pushSender.js';

export class PushError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const LANGS = ['en', 'so'];
const MAX_PER_SUBJECT = 10; // devices per person; the oldest goes when an 11th registers

// Register this device for whoever is signed in. `sub` is a browser PushSubscription JSON, or
// `token` an FCM registration token. Owner from the session (role, subjectId), never the body.
export async function saveSubscription({ role, subjectId, sub, token, lang }) {
  const l = LANGS.includes(lang) ? lang : 'en';
  let data;
  if (token) {
    if (!config.push.fcm.enabled) throw new PushError('app notifications are not set up yet', 404);
    if (typeof token !== 'string' || token.length < 20 || token.length > 4096) throw new PushError('bad token');
    data = { channel: 'fcm', endpoint: token, p256dh: null, auth: null };
  } else {
    if (!config.push.webpush.enabled) throw new PushError('notifications are not set up yet', 404);
    const endpoint = String(sub?.endpoint || '');
    const p256dh = String(sub?.keys?.p256dh || '');
    const auth = String(sub?.keys?.auth || '');
    // A push endpoint is the browser vendor's HTTPS URL; anything else would make us POST to
    // an address of the client's choosing.
    if (!/^https:\/\/[^\s/]+\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth) throw new PushError('bad subscription');
    data = { channel: 'webpush', endpoint, p256dh: p256dh.slice(0, 200), auth: auth.slice(0, 100) };
  }
  const row = await prisma.pushSubscription.upsert({
    where: { endpoint: data.endpoint },
    create: { role, subject_id: BigInt(subjectId), lang: l, ...data },
    update: { role, subject_id: BigInt(subjectId), lang: l, failures: 0, ...data },
  });
  const mine = await prisma.pushSubscription.findMany({
    where: { role, subject_id: BigInt(subjectId) }, orderBy: { created_at: 'desc' }, select: { id: true },
  });
  if (mine.length > MAX_PER_SUBJECT) {
    await prisma.pushSubscription.deleteMany({ where: { id: { in: mine.slice(MAX_PER_SUBJECT).map((r) => r.id) } } });
  }
  return { id: String(row.id), channel: row.channel };
}

// Signing out, or "turn off": only the caller's own device row.
export async function removeSubscription({ role, subjectId, endpoint }) {
  const r = await prisma.pushSubscription.deleteMany({
    where: { endpoint: String(endpoint || ''), role, subject_id: BigInt(subjectId) },
  });
  return r.count;
}

async function devicesFor(to) {
  if (to.role === 'operator') {
    const ops = await prisma.operator.findMany({
      where: { active: true, ...(to.admins ? { is_admin: true } : {}) }, select: { id: true },
    });
    if (!ops.length) return [];
    return prisma.pushSubscription.findMany({ where: { role: 'operator', subject_id: { in: ops.map((o) => o.id) } } });
  }
  return prisma.pushSubscription.findMany({ where: { role: to.role, subject_id: BigInt(to.id) } });
}

// Send each target to all of that person's devices, in their language.
export async function notify(targets, { senders = { webpush: sendWebPush, fcm: sendFcm } } = {}) {
  if (!targets.length || !(config.push.webpush.enabled || config.push.fcm.enabled)) return 0;
  let sent = 0;
  for (const target of targets) {
    // eslint-disable-next-line no-await-in-loop
    const devices = await devicesFor(target.to);
    for (const d of devices) {
      const text = textFor(target.kind, d.lang);
      if (!text) continue;
      const message = { ...text, url: target.url, tag: target.tag };
      // eslint-disable-next-line no-await-in-loop
      const result = await (senders[d.channel] || (() => 'error'))(d, message);
      if (result === 'ok') {
        sent += 1;
        // eslint-disable-next-line no-await-in-loop
        await prisma.pushSubscription.update({ where: { id: d.id }, data: { last_ok_at: new Date(), failures: 0 } }).catch(() => {});
      } else if (result === 'gone' || d.failures >= 20) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.pushSubscription.delete({ where: { id: d.id } }).catch(() => {});
      } else {
        // eslint-disable-next-line no-await-in-loop
        await prisma.pushSubscription.update({ where: { id: d.id }, data: { failures: { increment: 1 } } }).catch(() => {});
      }
    }
  }
  return sent;
}

// Fire and forget, after a commit: never awaited by a request.
export function notifyAfter(targets) {
  notify(targets).catch((err) => console.warn(`[push] ${err.message}`));
}
