// Push settings from env. Pure. Each channel is off unless fully configured; a half-set one is
// an error at boot (a typo'd key would otherwise fail silently on every notification).
export function parsePush(env) {
  const errors = [];
  const pub = (env.VAPID_PUBLIC_KEY || '').trim();
  const priv = (env.VAPID_PRIVATE_KEY || '').trim();
  const subject = (env.VAPID_SUBJECT || (env.OWNER_EMAIL ? `mailto:${env.OWNER_EMAIL}` : '')).trim();
  if (Boolean(pub) !== Boolean(priv)) errors.push('set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or neither');
  if (pub && priv && !/^(mailto:|https:)/.test(subject)) errors.push('VAPID_SUBJECT must be mailto:… or https:… (or set OWNER_EMAIL)');

  let account = null;
  const raw = (env.FCM_SERVICE_ACCOUNT || '').trim();
  if (raw) {
    try {
      account = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
      if (!account.client_email || !account.private_key || !account.project_id) throw new Error('missing fields');
      account.token_uri = account.token_uri || 'https://oauth2.googleapis.com/token';
    } catch (e) {
      errors.push(`FCM_SERVICE_ACCOUNT is not a Firebase service-account JSON (${e.message})`);
      account = null;
    }
  }
  return {
    webpush: { enabled: Boolean(pub && priv) && errors.length === 0, publicKey: pub, privateKey: priv, subject },
    fcm: { enabled: Boolean(account), account },
    errors,
  };
}
