# Commands

Run from `/Users/macbook/gurikaabe` on your Mac, unless it says **server**.

**The usual loop:** edit → `staging.sh up` → `staging.sh test` → commit → deploy.

## Staging (https://localhost:8444)

Your working copy, with its own fake data. It never sends real texts or emails: codes show on screen.

```bash
./scripts/staging.sh up       # build and start (re-run after backend changes)
./scripts/staging.sh test     # run the browser tests (add --headed to watch)
./scripts/staging.sh open     # open the three apps
./scripts/staging.sh shots    # Play Store images -> play-screenshots/
./scripts/staging.sh seed     # reset to seed data
./scripts/staging.sh logs     # backend log
./scripts/staging.sh down     # stop
./scripts/staging.sh reset    # wipe and start fresh
```

| Logins | |
|---|---|
| Customer | any number |
| Operator | `admin` / `change-me-please-1` |
| Driver | `619876543` / `1234` |

## Before every deploy

```bash
cd backend && npm test && cd ..
./scripts/staging.sh test
```

## Commit

```bash
git add -A && git commit -m "What changed" && git push origin main
```

## Deploy (server)

```bash
ssh root@80.240.29.219
cd /root/gurikaabe

# 1. Back up the database
mkdir -p /root/backups && docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > /root/backups/db-$(date +%F-%H%M).sql.gz

# 2. Deploy
git pull && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

# 3. Check it's up (should print {"ok":true})
curl -s https://app.gurikaabe.com/api/health
```

⚠️ On the server, **never** run `npm run seed` or `docker compose down -v`. The second one deletes every order and photo.

## Server: other jobs

```bash
nano .env                                    # change settings, then:
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --force-recreate backend

docker compose logs -f backend               # follow the log
docker compose logs backend --tail 50 | grep FATAL   # why won't it start?
node scripts/sms-preflight.mjs --send +1XXXXXXXXXX --email you@example.com   # test Twilio
```

**Rollback:** `git checkout <old commit>`, then run the deploy line again. Restore the database only if a migration broke data:
```bash
gunzip -c /root/backups/<file>.sql.gz | docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'
```

**Copy backups to your Mac** (run this on the Mac):
```bash
scp root@80.240.29.219:/root/backups/* ~/gurikaabe-backups/
```

## After changing a screen

Bump `CACHE` in that app's `sw.js` (e.g. `v30` → `v31`), or phones keep showing the old version. If you changed a file in `frontend/shared/`, bump all three apps.
```bash
grep -h "^const CACHE" frontend/*/sw.js
```

## Legal pages

Edit `docs/PRIVACY.md` or `docs/TERMS.md`, then run the line below. Commit, then deploy.
```bash
node scripts/build-privacy.mjs
```

## Android release

```bash
cd mobile && source env.sh
GM_API_BASE=https://app.gurikaabe.com npm run build
cd android && ./gradlew bundleRelease
# -> android/app/build/outputs/bundle/release/app-release.aab
```
- Bump `versionCode` in `mobile/android/app/build.gradle` before every upload.
- Keep the keystore backed up somewhere other than this laptop. If you lose it, you can never update the app.

## Local dev stack (https://localhost)

```bash
docker compose up -d --build                 # start
docker compose exec backend npm run seed     # reset to seed data
docker compose down                          # stop (never add -v)
```
