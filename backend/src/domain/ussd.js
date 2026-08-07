// Builds the USSD tel: URI for zero-API P2P payment.
// CRITICAL: the trailing # MUST be encoded as %23 or Android browsers truncate the dial
// string before handing it to the OS. The template already contains %23; we only inject
// the merchant number and amount.
import { config } from '../config.js';

export function buildUssdUri(amount) {
  const amt = Number(amount).toFixed(2);
  const dial = config.payment.ussdTemplate
    .replace('{NUM}', config.payment.merchantMsisdn)
    .replace('{AMT}', amt);
  return `tel:${dial}`;
}
