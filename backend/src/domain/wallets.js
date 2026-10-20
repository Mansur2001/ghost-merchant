// The mobile-money wallets a customer can pay with. Each one is a USSD code that sends money
// straight to that network's merchant number — the platform is never in the funds flow
// (invariant 6), it just builds the dial string.
//
// A wallet is OFFERED only when the owner configured BOTH its merchant number and its dial
// template. There are deliberately no built-in defaults: a code we guessed, or a placeholder
// merchant number, is a button that takes a customer's money to the wrong place or nowhere.
// Unconfigured = not shown; half-configured or malformed = refuse to boot.
import { parsePhone } from './phone.js';

// Display order, and the network each wallet runs on. `network` matches the operator names
// in domain/phone.js so a customer's own network can be offered first.
export const WALLETS = [
  { id: 'evc', name: 'EVC Plus', network: 'Hormuud', env: 'EVC' },
  { id: 'edahab', name: 'eDahab', network: 'Somtel', env: 'EDAHAB' },
  { id: 'zaad', name: 'Zaad', network: 'Telesom', env: 'ZAAD' },
  { id: 'sahal', name: 'Sahal', network: 'Golis', env: 'SAHAL' },
];

// A template must produce exactly "*digits*...digits%23" once filled in. The trailing # has to
// arrive pre-encoded (invariant 5) and nothing else may be in the string: a stray character is
// a dial string the network rejects after the customer has already pressed call.
function templateProblem(template) {
  if ((template.match(/\{NUM\}/g) || []).length !== 1) return 'must contain {NUM} exactly once';
  if ((template.match(/\{AMT\}/g) || []).length !== 1) return 'must contain {AMT} exactly once';
  if (template.includes('#')) return 'must end in %23, not a bare # (Android truncates at #)';
  const sample = template.replace('{NUM}', '612345678').replace('{AMT}', '10.00');
  if (!/^\*[\d*.]+%23$/.test(sample)) return 'must look like *712*{NUM}*{AMT}%23 — only digits, * and a final %23';
  return null;
}

// Pure: reads `<ENV>_MERCHANT` / `<ENV>_USSD` from the given env. Returns the usable wallets
// plus every problem found, so boot can print them all at once rather than one per restart.
export function parseWallets(env) {
  const wallets = [];
  const errors = [];
  const warnings = [];
  for (const w of WALLETS) {
    const rawNum = (env[`${w.env}_MERCHANT`] || '').trim();
    const template = (env[`${w.env}_USSD`] || '').trim();
    if (!rawNum && !template) continue;
    if (!rawNum || !template) {
      errors.push(`${w.name}: set both ${w.env}_MERCHANT and ${w.env}_USSD, or neither`);
      continue;
    }
    const num = parsePhone(rawNum);
    if (!num.valid || num.country !== 'SO') {
      errors.push(`${w.name}: ${w.env}_MERCHANT is not a valid Somali number`);
      continue;
    }
    const problem = templateProblem(template);
    if (problem) {
      errors.push(`${w.name}: ${w.env}_USSD ${problem}`);
      continue;
    }
    // Operators reallocate ranges, so a mismatch is worth a look but not a refusal.
    if (num.operator !== w.network) {
      warnings.push(`${w.name} usually runs on ${w.network}, but ${w.env}_MERCHANT looks like ${num.operator}`);
    }
    wallets.push({ id: w.id, name: w.name, network: w.network, merchant: num.national, template });
  }
  return { wallets, errors, warnings };
}

export function buildWalletUri(wallet, amount) {
  const amt = Number(amount).toFixed(2);
  return `tel:${wallet.template.replace('{NUM}', wallet.merchant).replace('{AMT}', amt)}`;
}
