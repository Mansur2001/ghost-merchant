// WaafiPay: the gateway that takes EVC Plus (Hormuud), Zaad (Telesom) and Sahal (Golis)
// payments. Pure — building the request and reading the answer — so every branch is tested
// without a network. The HTTP call is commands/providerPayments.js.
//
// How a payment works: we send API_PURCHASE naming the customer's wallet number and the
// amount; WaafiPay pushes a prompt to that phone; the customer approves with their PIN; the
// SAME HTTP call returns APPROVED with WaafiPay's transactionId. Money lands in GuriKaabe's
// merchant account; we record it against the order (invariant 6: we never hold it).
//
// ⚠️ Field names follow WaafiPay's published API_PURCHASE format. Check them against the
// documentation that comes with the merchant account before switching it on in production
// (docs/PAYMENT_API.md, "WaafiPay").
import { parsePhone } from './phone.js';

export const WAAFIPAY_PRODUCTION_URL = 'https://api.waafipay.net/asm';
export const WAAFIPAY_SANDBOX_URL = 'https://sandbox.waafipay.net/asm';

// The wallets WaafiPay can charge. eDahab is not one of them: it stays on the USSD path.
export const WAAFIPAY_WALLETS = ['evc', 'zaad', 'sahal'];

// Pure: settings from env. All three credentials, or none.
export function parseWaafiPay(env) {
  const merchantUid = (env.WAAFIPAY_MERCHANT_UID || '').trim();
  const apiUserId = (env.WAAFIPAY_API_USER_ID || '').trim();
  const apiKey = (env.WAAFIPAY_API_KEY || '').trim();
  const url = (env.WAAFIPAY_URL || WAAFIPAY_PRODUCTION_URL).trim();
  const set = [merchantUid, apiUserId, apiKey].filter(Boolean).length;
  const errors = [];
  if (set > 0 && set < 3) {
    errors.push('set all of WAAFIPAY_MERCHANT_UID, WAAFIPAY_API_USER_ID and WAAFIPAY_API_KEY, or none');
  }
  if (set === 3 && !/^https?:\/\//.test(url)) errors.push('WAAFIPAY_URL must be an http(s) URL');
  // A list, so the owner can offer Sahal before the others are signed (or the reverse).
  const wallets = (env.WAAFIPAY_WALLETS || WAAFIPAY_WALLETS.join(','))
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = wallets.filter((w) => !WAAFIPAY_WALLETS.includes(w));
  if (unknown.length) errors.push(`WAAFIPAY_WALLETS: WaafiPay does not take ${unknown.join(', ')}`);
  return {
    enabled: set === 3 && errors.length === 0,
    merchantUid,
    apiUserId,
    apiKey,
    url,
    wallets: wallets.filter((w) => WAAFIPAY_WALLETS.includes(w)),
    errors,
  };
}

// WaafiPay wants the number as 252XXXXXXXXX, no plus. Only Somali numbers have a wallet.
export function payerAccountNo(phone) {
  const p = parsePhone(phone);
  if (!p.valid || p.country !== 'SO') return null;
  return p.e164.replace(/^\+/, '');
}

// "2026-11-07 12:00:00.000", the timestamp format the gateway's examples use.
function stamp(d) {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

export function buildPurchaseRequest({ settings, attemptId, orderId, accountNo, amount, description, now = new Date() }) {
  return {
    schemaVersion: '1.0',
    requestId: attemptId,
    timestamp: stamp(now),
    channelName: 'WEB',
    serviceName: 'API_PURCHASE',
    serviceParams: {
      merchantUid: settings.merchantUid,
      apiUserId: settings.apiUserId,
      apiKey: settings.apiKey,
      paymentMethod: 'mwallet_account',
      payerInfo: { accountNo },
      transactionInfo: {
        // referenceId comes back on the approval and in WaafiPay's own reports: it is how a
        // payment is traced to this attempt, and the attempt to its order.
        referenceId: attemptId,
        invoiceId: orderId,
        amount,
        currency: 'USD',
        description: String(description || 'GuriKaabe').slice(0, 60),
      },
    },
  };
}

// The gateway's answer, as one of:
//   { status: 'approved', reference, amount }  money taken
//   { status: 'declined', detail }             the customer refused, had no balance, wrong PIN…
//   { status: 'unknown',  detail }             we can't tell. NEVER treated as either: the
//                                              customer may have been charged.
export function readPurchaseResponse(httpStatus, body) {
  if (httpStatus < 200 || httpStatus >= 300 || !body || typeof body !== 'object') {
    return { status: 'unknown', detail: `http ${httpStatus}` };
  }
  const code = String(body.responseCode ?? '');
  const msg = String(body.responseMsg ?? '').slice(0, 120);
  const params = body.params && typeof body.params === 'object' ? body.params : {};
  const state = String(params.state ?? '').toUpperCase();

  if (code === '2001' && state === 'APPROVED') {
    const reference = String(params.transactionId ?? '').trim();
    // Approved without a transaction id is not something we can record (invariant 2 needs a
    // reference). Treat it as unknown so a person looks at the merchant account.
    if (!reference) return { status: 'unknown', detail: 'approved without a transactionId' };
    const amount = params.txAmount ?? null;
    return { status: 'approved', reference, amount: amount === null ? null : String(amount) };
  }
  // 5xxx are the gateway's refusals (user rejected, insufficient balance, timeout on the
  // customer's handset, invalid account). The charge did not happen.
  if (/^5\d{3}$/.test(code)) return { status: 'declined', detail: `${code} ${msg}`.trim() };
  return { status: 'unknown', detail: `${code || 'no code'} ${msg}`.trim() };
}
