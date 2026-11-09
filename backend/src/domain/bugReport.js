// Bug reports: the rules, adapted from the team bug tracker (TCSS 460 group 8) — same fields,
// same limits, same triage states. Pure, so the form and the server agree.
import { normalizeEmail } from './email.js';

export const LIMITS = { title: 200, description: 5000, reproSteps: 5000 };
export const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
export const APPS = ['customer', 'driver', 'operator'];
export const CLOSED_RETENTION_DAYS = 90;

// Each problem names its field, so the form can put the message next to it (the tracker's
// mapServerError did this by keyword; here the server says which field outright).
export class BugError extends Error {
  constructor(message, field = null, status = 400) {
    super(message);
    this.field = field;
    this.status = status;
  }
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');

export function validateBug(body = {}) {
  const title = text(body.title);
  const description = text(body.description);
  const reproSteps = text(body.reproSteps);
  const rawEmail = text(body.reporterEmail);
  if (!title) throw new BugError('title is required', 'title');
  if (title.length > LIMITS.title) throw new BugError(`title must be ${LIMITS.title} characters or fewer`, 'title');
  if (!description) throw new BugError('description is required', 'description');
  if (description.length > LIMITS.description) throw new BugError(`description must be ${LIMITS.description} characters or fewer`, 'description');
  if (reproSteps.length > LIMITS.reproSteps) throw new BugError(`reproduction steps must be ${LIMITS.reproSteps} characters or fewer`, 'reproSteps');
  let reporterEmail = null;
  if (rawEmail) {
    reporterEmail = normalizeEmail(rawEmail);
    if (!reporterEmail) throw new BugError('enter a valid email address', 'reporterEmail');
  }
  const app = APPS.includes(body.app) ? body.app : 'customer';
  const clip = (v, n) => (text(v) ? text(v).slice(0, n) : null);
  return {
    title,
    description,
    repro_steps: reproSteps || null,
    reporter_email: reporterEmail,
    app,
    app_version: clip(body.appVersion, 40),
    lang: ['en', 'so'].includes(body.lang) ? body.lang : null,
    page: clip(body.page, 60),
  };
}

export function validateTriage(body = {}) {
  const out = {};
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) throw new BugError(`status must be one of ${STATUSES.join(', ')}`, 'status');
    out.status = body.status;
  }
  if (body.note !== undefined) out.triage_note = text(body.note).slice(0, 1000) || null;
  if (!Object.keys(out).length) throw new BugError('nothing to change');
  return out;
}
