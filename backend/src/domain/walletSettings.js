// Wallet limits from env. Pure, so config.js can read it without importing a command.
const cents = (v) => Math.round(Number(v) * 100);

export function parseWalletSettings(env) {
  const num = (k, d) => {
    const n = Number(env[k]);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    // On unless switched off: the owner holds the licence (2026-11-11).
    enabled: String(env.WALLET_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
    maxBalanceCents: cents(num('WALLET_MAX_BALANCE', 500)),
    topupMinCents: cents(num('WALLET_TOPUP_MIN', 1)),
    topupMaxCents: cents(num('WALLET_TOPUP_MAX', 200)),
  };
}
