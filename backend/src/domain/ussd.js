// Builds the USSD tel: URI for zero-API P2P payment.
// CRITICAL: the trailing # MUST be encoded as %23 or Android browsers truncate the dial
// string before handing it to the OS. The template already contains %23; we only inject
// the merchant number and amount.
import { config } from '../config.js';
import { parsePhone } from './phone.js';

export function buildUssdUri(amount) {
  const amt = Number(amount).toFixed(2);
  const dial = config.payment.ussdTemplate
    .replace('{NUM}', config.payment.merchantMsisdn)
    .replace('{AMT}', amt);
  return `tel:${dial}`;
}

// How THIS order gets paid, decided from the customer's own number.
//
// A US (+1) test account has no EVC Plus rail, so handing it a `tel:*712*...#` link would
// produce a dial string the network rejects — a dead button and a confused customer. Say so
// instead, and route the order through the operator's manual mark-paid path. The client
// renders whatever this returns; it must never assume a ussdUri exists.
export function buildPaymentInstruction(order) {
  const parsed = parsePhone(order?.user_phone);

  if (parsed.valid && parsed.canUssd) {
    return {
      paymentMethod: 'ussd',
      ussdUri: buildUssdUri(order.total_amount),
      paymentNote: null,
    };
  }

  return {
    paymentMethod: 'manual',
    ussdUri: null,
    paymentNote:
      'EVC Plus / eDahab payment is only available for Somali numbers. ' +
      'Pay the operator directly and they will confirm this order.',
  };
}
