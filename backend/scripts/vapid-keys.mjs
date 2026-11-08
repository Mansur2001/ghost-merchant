// Make the key pair for web push notifications. Run once; put the two lines in .env (both
// servers can share them, but never commit them). Changing them later signs every browser
// out of notifications until they turn them on again.
//
//   docker compose exec backend node scripts/vapid-keys.mjs
import webpush from 'web-push';

const k = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${k.privateKey}`);
