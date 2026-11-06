# Getting email codes delivered

Customers sign in with email + password, so a lost email no longer locks anyone out. Codes are
still needed to **prove an address** and to **reset a forgotten password**, so they must arrive.

## Why codes get "Dropped" today

The app hands every code to SendGrid and SendGrid accepts it (HTTP 202). The production log
shows 10 accepted, and only 1 code ever used. The loss happens inside SendGrid or at the inbox,
because the sender is `gurikaabe@gmail.com`: mail "from Gmail" that isn't sent by Gmail is
classic spam-filter bait, and SendGrid drops or blocks a lot of it. The production API key can
only send, so the exact reason per message is in SendGrid → **Activity Feed** (click a message;
"Dropped" shows the reason). Also check **Suppressions** (Bounces, Blocks, Spam reports): an
address there is dropped every time until you remove it.

## The fix: send from your own domain (about 20 minutes, once)

1. **SendGrid → Settings → Sender Authentication → Authenticate Your Domain.** DNS host:
   Cloudflare. Domain: `gurikaabe.com`. Leave "automated security" on.
2. SendGrid shows 3 CNAME records (`em1234.gurikaabe.com`, `s1._domainkey…`,
   `s2._domainkey…`). In **Cloudflare → DNS**, add each one exactly, with **Proxy OFF (grey
   cloud)**. Proxied CNAMEs break DKIM.
3. Back in SendGrid, click **Verify**. It can take a few minutes.
4. Your existing DMARC record (`p=reject; adkim=s`) is fine: SendGrid signs DKIM as
   `gurikaabe.com`, which passes strict alignment. Don't loosen it.
5. **SendGrid → Settings → Sender Authentication → Single Sender**, or just use the
   authenticated domain: sending from `no-reply@gurikaabe.com` needs no mailbox to exist.
6. On the server, edit `/root/gurikaabe/.env`, set `EMAIL_FROM=no-reply@gurikaabe.com`, then:
   ```bash
   cd /root/gurikaabe && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate backend
   ```
7. Test: sign in with "Forgot your password?" using your own Gmail and an Outlook address.
   Both codes should arrive in the inbox within a minute.

Until step 6, keep `EMAIL_FROM=gurikaabe@gmail.com` (it is the verified single sender), and tell
testers to check Spam/Promotions.
