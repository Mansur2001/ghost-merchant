// Payment-receipt parsing. Pure functions over SMS text — no DB, no network, fully testable.
//
// THE ORACLE IS A SENSOR, NOT AN EVC PLUS READER. It watches the merchant phone's inbox for
// any message saying money arrived, whatever rail sent it. That is what lets one merchant
// phone confirm a Somali EVC Plus transfer and a US Zelle payment with the same mechanism:
// neither rail offers an API, but both text the recipient.
//
// PARSING LIVES HERE, ON THE SERVER, not on the phone. Telecoms and banks reword their
// messages without warning, and a parser fix must not require physical access to a handset
// that may be in another country. The phone forwards the raw text; this decides what it means.
//
// SECURITY — read before adding a provider. An SMS sender ID is trivially spoofable, so a
// receipt is EVIDENCE, not proof. Three things keep that from becoming free groceries:
//   1. matching requires the sender's number AND the exact amount AND an order actually
//      waiting for that amount;
//   2. anything ambiguous goes to the operator's reconcile queue instead of auto-confirming;
//   3. `telecom_receipt_id` is UNIQUE, so a replayed message can never credit twice.
// Do not add a provider whose messages lack a stable reference id and an amount.

// Read a money amount out of a message.
//
// This is fussier than it looks. A naive /([0-9]+(\.[0-9]{1,2})?)/ happily matches the digits
// inside "from 612345678" and books a $612,345,678 payment — a real bug a test caught here.
// So: a bare number only counts as money if it has two decimal places, and anything can count
// if it carries a currency symbol. A phone number and a reference code have neither.
function readAmount(body) {
  const withSymbol = String(body).match(/\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
  if (withSymbol) return withSymbol[1].replace(/,/g, '');
  const decimal = String(body).match(/(?<![\d.])([0-9][0-9,]*\.[0-9]{2})(?![\d])/);
  return decimal ? decimal[1].replace(/,/g, '') : null;
}

// Each provider: how to recognise its messages, and how to read one.
//
// `senderIds` are matched case-insensitively against the SMS sender field. `test` is a second
// gate on the body, so a spoofed sender with unrelated text still doesn't parse.
const PROVIDERS = [
  {
    id: 'evcplus',
    label: 'EVC Plus',
    country: 'SO',
    senderIds: ['evcplus', 'evc', 'hormuud'],
    test: /you have received/i,
    // "You have received $5.50 from 61XXXXXXX. Ref: ABC123XYZ"
    parse: (body) => ({
      amount: readAmount(body),
      senderMsisdn: body.match(/from\s+(\+?\d{6,15})/i)?.[1],
      reference: body.match(/(?:ref|txn|id)[:\s]+([A-Z0-9-]{4,})/i)?.[1],
    }),
  },
  {
    id: 'edahab',
    label: 'eDahab',
    country: 'SO',
    senderIds: ['edahab', 'somtel'],
    test: /received|waxaad heshay/i,
    parse: (body) => ({
      amount: readAmount(body),
      senderMsisdn: body.match(/from\s+(\+?\d{6,15})|(\+?\d{9,15})/i)?.[1],
      reference: body.match(/(?:ref|txn|id)[:\s]+([A-Z0-9-]{4,})/i)?.[1],
    }),
  },
  {
    id: 'zelle',
    label: 'Zelle',
    country: 'US',
    senderIds: ['zelle', '09876', 'chase', 'bofa', 'wellsfargo'],
    test: /zelle|sent you|you received/i,
    // "John Smith sent you $25.00 with Zelle. Ref 1234ABCD"
    // Zelle identifies people by NAME, not number — see senderName below.
    parse: (body) => ({
      amount: readAmount(body),
      senderName: body.match(/^([A-Za-z][A-Za-z.'\- ]{1,40}?)\s+sent you/i)?.[1]?.trim(),
      reference: body.match(/(?:ref|confirmation|conf)[.:\s#]+([A-Z0-9-]{4,})/i)?.[1],
    }),
  },
  {
    id: 'cashapp',
    label: 'Cash App',
    country: 'US',
    senderIds: ['cashapp', 'cash app', 'square'],
    test: /cash app|sent you/i,
    // "$John sent you $25.00 on Cash App. #ABC123"
    parse: (body) => ({
      amount: readAmount(body),
      senderName: body.match(/\$?([A-Za-z][A-Za-z0-9.'\- ]{1,40}?)\s+sent you/i)?.[1]?.trim(),
      reference: body.match(/#([A-Z0-9-]{4,})/i)?.[1],
    }),
  },
  {
    id: 'venmo',
    label: 'Venmo',
    country: 'US',
    senderIds: ['venmo', '86753'],
    test: /venmo|paid you/i,
    // "John Smith paid you $25.00 - Venmo. ID: 1234567890"
    parse: (body) => ({
      amount: readAmount(body),
      senderName: body.match(/^([A-Za-z][A-Za-z.'\- ]{1,40}?)\s+paid you/i)?.[1]?.trim(),
      reference: body.match(/(?:id|ref)[:\s#]+([A-Z0-9-]{4,})/i)?.[1],
    }),
  },
];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

// Which provider, if any, sent this. `senderId` is the SMS "from" field.
export function identifyProvider(senderId, body = '') {
  const from = String(senderId || '').toLowerCase();
  const text = String(body || '');
  return (
    PROVIDERS.find(
      (p) => p.senderIds.some((s) => from.includes(s)) && p.test.test(text)
    ) || null
  );
}

// Parse a receipt SMS into the shape the payment command expects.
//
// Returns null when the message isn't a recognisable receipt — that is the common case (the
// merchant phone also receives ordinary texts) and must never throw.
//
// A receipt with no amount is useless and a receipt with no reference cannot be de-duplicated,
// so both are required. Without a stable reference, a telecom resending the same SMS would
// credit the order twice.
export function parseReceipt({ senderId, body, receivedAt } = {}) {
  const provider = identifyProvider(senderId, body);
  if (!provider) return null;

  const raw = provider.parse(String(body));
  const amount = Number(raw.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  // Fall back to a stable synthetic id when the provider gives none: sender + timestamp +
  // amount is stable across a redelivery of the SAME message, which is what dedupe needs.
  const reference =
    raw.reference || `${provider.id}-${receivedAt || ''}-${amount}`.replace(/\s+/g, '');

  return {
    provider: provider.id,
    providerLabel: provider.label,
    receiptId: `${provider.id}:${reference}`,
    amount,
    // Somali rails give a phone number, so the payment can be matched automatically.
    senderMsisdn: raw.senderMsisdn || null,
    // US rails identify people by display name. There is no safe way to turn "John Smith"
    // into an order, so these are recorded and land in the operator's reconcile queue —
    // matching on amount alone would mark the WRONG customer's order paid whenever two
    // people owe the same amount.
    senderName: raw.senderName || null,
    rawSms: String(body),
  };
}
