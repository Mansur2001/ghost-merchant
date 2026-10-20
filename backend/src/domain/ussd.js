// How an order gets paid: a list of USSD tel: links, one per configured wallet
// (domain/wallets.js). CRITICAL: the trailing # MUST be encoded as %23 or Android browsers
// truncate the dial string before handing it to the OS — the templates arrive pre-encoded and
// are validated at boot, so this only injects the merchant number and amount.
import { config } from '../config.js';
import { parsePhone } from './phone.js';
import { buildWalletUri } from './wallets.js';

// The customer's own network first: someone on Somtel almost certainly pays with eDahab.
// Everything else keeps its configured order, because many people carry two SIMs.
function forCustomer(wallets, operator) {
  const own = wallets.filter((w) => w.network === operator);
  return [...own, ...wallets.filter((w) => w.network !== operator)];
}

// How THIS order gets paid, decided from the customer's own number.
//
// A US (+1) test account has no mobile-money rail, so handing it a `tel:*712*...#` link would
// produce a dial string the network rejects — a dead button and a confused customer. Say so
// instead, and route the order through the operator's manual confirm path. The same applies
// when no wallet is configured yet. The client renders whatever this returns; it must never
// assume a pay link exists.
export function buildPaymentInstruction(order, wallets = config.payment.wallets) {
  const parsed = parsePhone(order?.user_phone);

  if (!(parsed.valid && parsed.canUssd)) {
    return {
      paymentMethod: 'manual',
      wallets: [],
      ussdUri: null,
      paymentNote:
        'Mobile-money payment is only available for Somali numbers. ' +
        'Pay the operator directly and they will confirm this order.',
    };
  }
  if (!wallets.length) {
    return {
      paymentMethod: 'manual',
      wallets: [],
      ussdUri: null,
      paymentNote:
        'No mobile-money wallet is set up yet. Pay the operator directly and they will confirm this order.',
    };
  }

  const options = forCustomer(wallets, parsed.operator).map((w) => ({
    id: w.id,
    name: w.name,
    ussdUri: buildWalletUri(w, order.total_amount),
  }));
  return {
    paymentMethod: 'ussd',
    wallets: options,
    // Kept for app builds that predate the picker: they render one button from this.
    ussdUri: options[0].ussdUri,
    paymentNote: null,
  };
}
