# MedCore Deployment & Operations Runbook

Production ops guide for MedCore. For architecture, see
[ARCHITECTURE.md](ARCHITECTURE.md). For dev workflow and the full
migration runbook, see [CONTRIBUTING.md](../CONTRIBUTING.md).

> Credentials are never committed. All secrets come from
> `/home/<user>/medcore/.env` (git-ignored). Use `.env.example` as the
> template.

---

## 1. Environments

| Env | URL | DB name | PM2 processes |
|---|---|---|---|
| **prod** | https://medcore.globusdemos.com | `medcore` | `medcore-api`, `medcore-web` |
| **staging** | https://medcore-staging.globusdemos.com | `medcore_staging` | `medcore-api-staging`, `medcore-web-staging` |
| **dev** | http://localhost:3000 | `medcore_dev` | n/a (`npm run dev`) |

API listens on **4000**, web on **3000**. nginx terminates TLS and
proxies both behind the same host.

---

## 2. Standard deploy

```bash
cd /home/<user>/medcore
git pull
npm install
npx prisma generate --schema=packages/db/prisma/schema.prisma
npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma
npm run build -w apps/web
pm2 restart medcore-api medcore-web
pm2 save
```

Or use the wrapper:

```bash
./scripts/deploy.sh
```

The script does all of the above plus a post-deploy healthcheck. It
does **not** seed unless `ALLOW_PROD_SEED_RESET` is set — see section 3.

---

## 3. Database migrations

### Create a migration locally

```bash
cd packages/db
npx prisma migrate dev --name add_some_column
```

Commit the generated `prisma/migrations/<ts>_add_some_column/` folder.

### Apply to prod

```bash
npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma
```

`migrate deploy` only applies pending migrations — it never drops,
never prompts, never asks about data loss.

### First-time adoption on an existing prod DB

On **2026-04-15** we adopted Prisma migrations on a DB that had
previously been managed via `db push`. The prod schema already matched
the first baseline migration, so we marked it applied without running
it:

```bash
npx prisma migrate resolve \
  --schema=packages/db/prisma/schema.prisma \
  --applied 20260415000000_initial
```

Do this exactly once, only on DBs that predate the migration history.
If you see this error on a new deploy, stop and read the drift before
resolving.

### NEVER do these in prod

| Command | Why not |
|---|---|
| `prisma db push` | Drops columns silently, no history, no rollback. |
| `prisma migrate dev` | Tries to reset the DB if it detects drift. |
| `prisma migrate reset` | Wipes everything. |
| `--force-reset` | Same as above. |

### The `--seed` guard

The deploy script's `--seed` flag is **triple-guarded**:

1. Environment variable: `ALLOW_PROD_SEED_RESET=YES_I_WILL_WIPE_THE_HOSPITAL`
2. The script prompts you to type the DB name character-for-character.
3. Only then does it run `prisma db seed`.

There is no single flag that can accidentally wipe prod. If you need
to re-seed prod, you already know what you're doing.

---

## 4. Backups

- **Location**: `/var/backups/medcore/` on the prod host.
- **Format**: `medcore-YYYYMMDD-HHMMSS.sql.gz`
- **Schedule**: `backupDatabase` scheduled task, daily at 02:00 (see
  ARCHITECTURE section 6). Also invokable manually via
  `./scripts/backup-db.sh`.
- **Retention**: 30 days on disk (TODO: offsite replication — tracked
  as follow-up).

### Restore

```bash
gunzip -c /var/backups/medcore/medcore-20260415-020000.sql.gz \
  | psql -U medcore -d medcore_restore_scratch
```

Always restore into a **scratch** DB first. Verify row counts match
before swapping DATABASE_URL.

### Restore rehearsal (2026-04-15)

A full rehearsal was executed on 2026-04-15: dump -> restore to
`medcore_restore_scratch` -> compared row counts on 8 critical
tables (`users`, `patients`, `appointments`, `invoices`,
`prescriptions`, `admissions`, `lab_orders`, `notifications`).
All 8 matched. Backup procedure is verified-good.

---

## 5. Environment variables

Required in `/home/<user>/medcore/.env`. See `.env.example`.

| Var | Required? | Fallback |
|---|---|---|
| `DATABASE_URL` | **required** | none — server won't start |
| `JWT_SECRET` | **required** | none — server won't start |
| `JWT_REFRESH_SECRET` | **required** | none — server won't start |
| `RAZORPAY_KEY_ID` | optional | mock mode (orders are fake) |
| `RAZORPAY_KEY_SECRET` | optional | mock mode |
| `RAZORPAY_WEBHOOK_SECRET` | required if Razorpay is live | webhook rejects all if missing |
| `UPLOAD_SIGNING_SECRET` | **required** | none — uploads disabled |
| `WHATSAPP_API_KEY` | optional | mock mode (logs the message, no send) |
| `MSG91_AUTH_KEY` | optional | mock mode |
| `SENDGRID_API_KEY` | optional | mock mode |
| `FCM_SERVER_KEY` | optional | mock mode (push is a no-op) |

Mock-mode channels still write the `notifications` row with
`deliveryStatus = SENT` and a `[MOCK]` prefix in the payload so
testing doesn't silently break.

---

## 6. Rollback

If a deploy breaks things:

```bash
cd /home/<user>/medcore
git log --oneline -10                    # find last-known-good SHA
git reset --hard <last-known-good-sha>
npm install
npx prisma generate --schema=packages/db/prisma/schema.prisma
npm run build -w apps/web
pm2 restart medcore-api medcore-web
```

If the bad deploy included a migration that needs to be backed out:

```bash
# after git reset, mark the forward migration as rolled back
npx prisma migrate resolve \
  --schema=packages/db/prisma/schema.prisma \
  --rolled-back <failed_migration_name>
```

Then hand-write a down-migration or restore from backup. **Migrations
are one-way by default** — prefer backup restore over hand-editing the
schema on a live host.

---

## 7. Health checks

After every deploy, run:

```bash
./scripts/healthcheck.sh
```

Which checks:

| Check | Expected |
|---|---|
| `curl -sI https://medcore.globusdemos.com/dashboard` | `200` or `302` (redirect to login) |
| `curl -sI https://medcore.globusdemos.com/verify/rx/test` | `200` (public page) |
| `curl -sX POST https://medcore.globusdemos.com/api/v1/billing/razorpay-webhook` | `401` (rejects unsigned) |
| `pm2 list` | `medcore-api` and `medcore-web` both `online` |

---

## 8. Monitoring scheduled tasks

Every cron writes its last-run timestamp to `system_config`. To see
the state of every task:

```sql
SELECT key, value, "updatedAt"
FROM system_config
WHERE key LIKE 'medcore_task_registry:%'
ORDER BY "updatedAt" DESC;
```

Interpretation:

- `drainScheduled` should be within the last **2 minutes**. Older =
  the notification drain is wedged.
- `backupDatabase` should be within the last **26 hours**.
- `retentionCleanup` should be within the last **65 minutes**.
- Anything else older than 2x its interval = investigate the API
  process logs (`pm2 logs medcore-api`).

---

## 9. Notification debugging

If users report missing WhatsApp/SMS/email:

```sql
SELECT "deliveryStatus", COUNT(*)
FROM notifications
WHERE "createdAt" > NOW() - INTERVAL '1 hour'
GROUP BY "deliveryStatus";
```

- `QUEUED` piling up: `drainScheduled` is stuck. Check
  `pm2 logs medcore-api | grep drainScheduled`.
- `FAILED` piling up: check `errorMessage` column — usually a channel
  API key rotation or rate limit.
- `SENT` with `[MOCK]` prefix in payload: you're in mock mode. Set the
  real channel API key and restart.

---

## 10. Razorpay webhook setup

1. Log in to the Razorpay dashboard -> Settings -> Webhooks.
2. Add endpoint: `https://medcore.globusdemos.com/api/v1/billing/razorpay-webhook`
3. Subscribe to: `payment.captured`, `payment.failed`, `order.paid`.
4. Generate a secret; copy into `/home/<user>/medcore/.env` as
   `RAZORPAY_WEBHOOK_SECRET`.
5. Restart the API: `pm2 restart medcore-api`.
6. Test using Razorpay Test Mode — fire a test `payment.captured`
   from the dashboard and watch:

```bash
pm2 logs medcore-api | grep razorpay
```

The handler logs signature-verify result, amount cross-check result,
and idempotency decision for every webhook. Fail-closed: any error =
401/400 response, no DB write.

---

## 11. PM2 systemd persistence

One-time setup so PM2 survives reboots:

```bash
pm2 save
pm2 startup systemd -u <user> --hp /home/<user>
# run the sudo command it prints, then:
pm2 save
```

Verify with:

```bash
systemctl status pm2-<user>
```

After this, a reboot will bring `medcore-api` and `medcore-web` back
automatically. Re-run `pm2 save` any time you add or rename a process.
