// The audit log: one row per decision. Append-only in the database (a trigger refuses UPDATE
// and DELETE), so a record of who confirmed a payment or approved a person can't be quietly
// rewritten afterwards. Pass the transaction's client when the decision is part of one, so the
// record commits with the change it describes.
import { prisma } from '../db/prisma.js';

export function audit({ actor, action, subject = null, detail = {} }, { client } = {}) {
  return (client || prisma).auditLog.create({
    data: { actor: String(actor), action, subject: subject == null ? null : String(subject), detail },
  });
}

// For decisions recorded after their own write: a failed log line must not undo the decision
// or fail the request, but it must be loud.
export function auditAfter(entry) {
  return audit(entry).catch((err) => console.error(`[audit] could not record ${entry.action}: ${err.message}`));
}
