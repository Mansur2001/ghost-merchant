# GuriKaabe — commands you'll reuse

Run from the repo root (`/Users/macbook/gurikaabe`) on your Mac unless the heading says **server**.
The usual loop is: **edit → staging → test → commit → deploy**.

---

## 1. Staging (see your changes before production)

Your working tree, built and running at **https://localhost:8444**, with its own throwaway
data. It doesn't touch your dev stack or the VPS, and never sends a real text or email: login
codes appear on screen.

| Do this | Command |
|---|---|
| Build from your current files and start | `./scripts/staging.sh up` |
| Open customer, operator and driver apps | `./scripts/staging.sh open` |
| Run every workflow in a real browser | `./scripts/staging.sh test` |
| …and watch the browser do it | `./scripts/staging.sh test --headed` |
| …step through tests interactively | `./scripts/staging.sh test --ui` |
| …just one file | `./scripts/staging.sh test order-lifecycle` |
| See the report from the last run | `cd e2e && npx playwright show-report` |
| Back to the seed data | `./scripts/staging.sh seed` |
| Follow the backend log | `./scripts/staging.sh logs` |
| What's running | `./scripts/staging.sh status` |
| One SQL query | `./scripts/staging.sh psql "SELECT id, status FROM orders;"` |
| Stop (keeps data) | `./scripts/staging.sh down` |
| Wipe staging and start fresh | `./scripts/staging.sh reset` |
| Play Store screenshots + feature graphic | `./scripts/staging.sh shots` (→ `play-screenshots/`, reseeds first) |

- **Backend change** (`backend/`): re-run `up` (it rebuilds).
- **Frontend change** (`frontend/`): just reload the page, after bumping `CACHE` in that app's
  `sw.js` (see section 6).
- The browser warns once about the local certificate: accept it.

**Staging logins** (seed data, public on purpose):

| App | Login |
|---|---|
| Customer | any number; the code shows on screen |
| Operator | `admin` / `change-me-please-1` (admin), `hodan` / `seeded-operator-pw-1` |
| Driver | `619876543` / `1234` (Amina), `651112223` / `5678` (Bashir) |

What `test` covers (`e2e/tests/`):
- **The full order lifecycle:** order → wallet button → "I've paid" → operator confirms →
  dispatch → driver delivers, with the customer's page updating live at each step.
- **Email codes:** add and confirm an email, then sign in by email. An email request for a
  number with no email looks the same as a real send.
- **Staff invite:** an admin adds a driver with an email setup code, and the driver sets a PIN.
- **Smoke checks:** no console or CSP errors on any app, both flags drawn, the Somali toggle,
  and the privacy and terms pages.

---

## 2. Unit tests and live suites

```bash
cd backend && npm test                 # 358 unit tests, no database needed
./scripts/verify/run-all.sh            # API/WebSocket suites against the DEV stack (wipes dev data)
cd backend && for f in $(find src -name '*.js'); do node --check "$f"; done   # quick syntax check
```

Before every deploy, run `npm test` **and** `./scripts/staging.sh test`.

---

## 3. Local dev stack (https://localhost)

```bash
docker compose up -d --build                    # start everything
docker compose up -d --build backend            # after a backend change (a restart is NOT enough)
docker compose logs -f backend                  # log; dev login codes show on [OTP][dev-transport]
docker compose exec backend npm run seed        # reset to seed data (asks first if you have your own data)
docker compose exec backend npm run db:verify   # check the indexes Prisma can't see are present
docker compose down                             # stop (keeps data); NEVER add -v unless you mean it
```

---

## 4. Commit and push

```bash
git status
git add -A && git commit -m "What changed and why"
git push origin main
```
`.env`, `.env.staging`, `CREDENTIALS.md` and `minio.license` are git-ignored. Keep them that way.

---

## 5. Production (server: `ssh root@80.240.29.219`)

```bash
ssh root@80.240.29.219
cd /root/gurikaabe
```

| Do this (on the server) | Command |
|---|---|
| **Back up the database first** | `mkdir -p /root/backups && docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \| gzip > /root/backups/db-$(date +%F-%H%M).sql.gz` |
| Deploy the latest push | `git pull && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build` |
| After editing `.env` | `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate backend` |
| Edit settings | `nano .env` (then the line above) |
| Is it up? | `curl -s https://app.gurikaabe.com/api/health` should print `{"ok":true}` |
| Follow the log | `docker compose logs -f backend` |
| Why won't it start? | `docker compose logs backend --tail 50 \| grep FATAL` |
| What's running | `docker compose ps` |
| Check Twilio + SendGrid | `node scripts/sms-preflight.mjs` |
| …send a real test text / email | `node scripts/sms-preflight.mjs --send +1XXXXXXXXXX --email you@example.com` |
| Copy backups to your Mac (**run on Mac**) | `scp root@80.240.29.219:/root/backups/* ~/gurikaabe-backups/` |

- **Never** run `npm run seed` or `docker compose down -v` on the server. The first refuses
  anyway, and the second deletes every order and photo.
- Migrations run on their own when the backend starts. Take the backup first.
- **Rollback:** `git checkout <previous commit>`, then the deploy line, and restore the backup
  only if a migration broke data:
  `gunzip -c /root/backups/<file>.sql.gz | docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'`

---

## 6. Frontend gotcha: the cache bump

After editing any `index.html`, `app.js`, `styles.css` or `shared/*.js`, bump `CACHE` in each
affected app's `sw.js` (for example `gurikaabe-user-v29` → `v30`). Otherwise phones keep the old
version. Files in `shared/` are used by all three apps, so bump all three:
```bash
grep -h "^const CACHE" frontend/*/sw.js     # see the current versions
```

---

## 7. Legal pages

```bash
node scripts/build-privacy.mjs   # docs/PRIVACY.md + docs/TERMS.md -> /privacy.html, /terms.html
```
Edit the Markdown, run this, commit, and deploy. It refuses to build while any `[PLACEHOLDER]`
is left.

---

## 8. Android app (Play Store)

```bash
cd mobile && source env.sh
GM_API_BASE=https://app.gurikaabe.com npm run build    # HTTPS only for a release
cd android && ./gradlew bundleRelease
# -> android/app/build/outputs/bundle/release/app-release.aab
```
- Bump `versionCode` in `mobile/android/app/build.gradle` for **every** upload.
- Keep the keystore backed up off this laptop. Losing it means you can never update the app.
- Store screenshots come from **staging or seed data only**, never real customers.

---

## 9. Icons (rarely)

```bash
python3 scripts/brandsheet-icons.py     # masters from GuriKaabe-brandsheet.png (needs Pillow)
./mobile/make-icons.sh                  # Android sizes
```
