# MedCore Architecture

This document describes the shape of the MedCore codebase, the runtime
request flow, the authentication model, how data moves through the
primary business flows, and the design decisions that got us here.

For the development workflow and migration runbook, see
[CONTRIBUTING.md](../CONTRIBUTING.md). For ops, see [DEPLOYMENT.md](DEPLOYMENT.md).

---

## 1. Monorepo layout

```
medcore/
├── apps/
│   ├── api/       — Express 4 + Prisma + Socket.IO (REST + realtime)
│   ├── web/       — Next.js 15 App Router (SSR dashboard + verify pages)
│   └── mobile/    — Expo SDK 53 + expo-router (Phase 1 scaffold)
├── packages/
│   ├── db/        — Prisma schema, migrations, seeds (single source of truth)
│   └── shared/    — Zod validation schemas + TypeScript types shared by
│                    api, web, and mobile
├── e2e/           — Playwright specs (30 stabilized flows)
├── docs/          — PRD, TEST_PLAN, ARCHITECTURE, DEPLOYMENT, screenshots/
└── scripts/       — deploy, backup, restore, pm2-setup, healthcheck
```

Key rule: **nothing else imports from `apps/api/prisma`** — the schema
and migrations live in `packages/db` so that the mobile app, seeds,
and standalone scripts can all share one client.

---

## 2. Runtime request flow

```
            ┌────────────────────────────────────────────────────┐
            │                    Client                          │
            │  (browser, Expo app, Razorpay webhook, curl)        │
            └──────────────────────┬─────────────────────────────┘
                                   │ https
                                   ▼
                          ┌────────────────┐
                          │     nginx      │  TLS terminator + reverse proxy
                          └────────┬───────┘
                                   │
                ┌──────────────────┼──────────────────┐
                ▼                  ▼                  ▼
       ┌───────────────┐   ┌───────────────┐  ┌───────────────┐
       │ Next.js SSR   │   │  Express API  │  │  Socket.IO    │
       │ (port 3000)   │   │  (port 4000)  │  │   sidecar     │
       └───────┬───────┘   └───────┬───────┘  └───────┬───────┘
               │                   │                   │
               └──────────┬────────┴──────────┬────────┘
                          ▼                   ▼
                    ┌──────────┐        ┌──────────┐
                    │  Prisma  │───────▶│ Postgres │
                    └──────────┘        └──────────┘
```

- **Next.js** handles SSR for the dashboard and the public
  `/verify/rx/:token` page. All protected data fetching is done by
  calling the Express API with the user's JWT.
- **Express** is the canonical data plane. Every mutation goes through
  it, guarded by rate limit + auth + Zod validation + RBAC middleware.
- **Socket.IO** runs in the same Node process as Express but is split
  off as a "sidecar" concept (see `apps/api/src/app.ts` vs `server.ts`
  split) so tests can import the app without spinning up listeners.
- **Prisma** is the only allowed path to Postgres. No raw SQL except in
  migrations and in the analytics heat-map query.

---

## 3. Authentication flow

```
  POST /auth/login (email, password)
    │
    ├─ bcrypt.compare ────────────────┐
    ▼                                  │
  has 2FA? ── no ──▶ issue JWT pair   │
    │ yes                             │
    ▼                                  │
  issue TEMP_TOKEN (DB-backed, 5 min) ◀┘
    │
    ▼
  POST /auth/verify-login (temp_token, totp_code)
    │
    ▼
  authenticator.verify(code)  ──▶ issue JWT pair
                                     │
                                     ├─ access  (24h, jti-scoped)
                                     └─ refresh (7d,  jti-scoped)

  POST /auth/refresh (refresh_token)
    │
    ├─ jti already used? ──▶ REVOKE all sessions (replay detected)
    ▼
  rotate: issue new pair, invalidate old refresh
```

- Access: **24h**. Refresh: **7d**. Both signed HS256.
- Refresh tokens are **rotated** on every use with replay detection
  (old `jti` reuse wipes the user's sessions — presumed compromise).
- 2FA is optional per user; temp tokens persist in `auth_temp_tokens`
  so a restart or a second API replica doesn't drop in-flight challenges.
- 7 roles: SUPER_ADMIN, ADMIN, DOCTOR, NURSE, RECEPTIONIST, PHARMACIST,
  LAB_TECH.

---

## 4. Primary data flows

### 4.1 Appointment booking

```
Receptionist ─▶ POST /appointments
                  │
                  ├─ allocate queue token (atomic, per-doctor-per-day)
                  ├─ persist appointment
                  └─ emit queue:<doctorId> via Socket.IO
                              │
                              ▼
                    Doctor dashboard live-updates
```

The token allocator is covered by a dedicated concurrency test that
spawns N parallel requests and asserts unique, gapless tokens.

### 4.2 Prescription lifecycle

```
 draft ──▶ sign ──▶ PDF rendered (pdfkit + QR) ──▶ emit rx:signed
                                                       │
                                                       ▼
                                             /verify/rx/:token
                                               (public SSR page
                                                validates QR payload
                                                + signature)
```

QR encodes a short-lived HMAC-signed token; the verify page is
public-read but reveals nothing beyond the prescription summary.

### 4.3 Billing + Razorpay

```
create invoice ──▶ POST /billing/razorpay-order
                     │
                     ├─ Razorpay Orders API
                     └─ return order_id to client
                                │
                                ▼
                        Razorpay Checkout.js
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
          client verify-payment       webhook (async)
                    │                       │
                    └───────────┬───────────┘
                                ▼
                   both paths share handler:
                   1. verify HMAC signature
                   2. cross-check amount == invoice total
                   3. idempotency by webhook event id
                   4. mark invoice PAID, emit billing:paid
```

**Fail-closed**: any signature, amount, or lookup error rejects the
payment. No silent retry, no partial update.

### 4.4 Notification pipeline

```
trigger (service emit) ──▶ pick template ──▶ render
                                                │
                                                ▼
                                    channel adapter (WhatsApp / SMS /
                                    Email / Push / In-App)
                                                │
                                                ▼
                              INSERT notifications (status=QUEUED)
                                                │
                                                ▼
                       drainScheduled cron (every 1 min)
                                                │
                                                ▼
                              status=SENT|FAILED + retry bookkeeping
```

The drain cron was fixed this session to pick up rows where
`scheduledFor IS NULL` — previously those sat in QUEUED forever.

---

## 5. Design decisions (with whys)

| Decision | Why |
|---|---|
| Prisma **migrations** over `db push` | Data safety. `db push` happily drops columns; migrations give us a reviewable SQL diff, a forward history, and `migrate resolve` for drift. |
| **DB-backed 2FA temp tokens** (not in-memory Map) | Replica safety. A restart, or a second API instance behind a load balancer, must not drop a user's in-flight 2FA challenge. |
| Server-side **pdfkit** PDFs, not browser print | Archival + deterministic output. A prescription printed from Chrome on a doctor's phone is not the same bytes as from the admin's Firefox. pdfkit gives us one reproducible artifact we can hash, sign, and store. |
| **Hard-fail a11y gate with per-page budgets** | Incremental tightening. A global "zero violations" gate blocks all PRs the day you turn it on. Per-page budgets let us ratchet each page down to zero independently. |
| **5 roles -> 7 roles** (add PHARMACIST, LAB_TECH) | Least privilege. A pharmacist doesn't need admissions write access; a lab tech doesn't need pharmacy inventory. |
| **Socket.IO room-scoped events** (`queue:<doctorId>`, `token-display`) | Blast-radius control. A waiting-room display in OPD-2 should not get a push every time OPD-5's queue changes. Scales better and leaks less. |
| **app/server split** in API | Tests can import the Express app without binding a port or starting the Socket.IO server. Faster, parallel-safe tests. |
| **jti-scoped JWTs + refresh rotation** | Enables replay detection. Old refresh token reuse = revoke all sessions. |

---

## 6. Scheduled tasks registry

All scheduled jobs write their last-run time to `system_config` under
keys like `medcore_task_registry:<task_name>`. Query that table to see
when each last ran.

| Task | Interval | Purpose |
|---|---|---|
| `drainScheduled` | 1 min | Send QUEUED notifications via channel adapters |
| `retentionCleanup` | 1 hour | Delete expired upload blobs past retention |
| `refreshTokenSweep` | 1 hour | Purge expired refresh tokens from DB |
| `queueArchive` | daily 00:05 | Archive yesterday's queue tokens |
| `backupDatabase` | daily 02:00 | pg_dump to backup dir, gzipped |
| `auditLogRotate` | daily 03:00 | Roll audit logs older than 90d to cold storage |
| `appointmentReminders` | every 15 min | Fire T-24h / T-2h reminders |
| `invoiceOverdueScan` | daily 09:00 | Flag invoices past due, queue notifications |
| `pushTokenCleanup` | daily 04:00 | Drop stale Expo push tokens |

---

## 7. Known limitations + follow-up

- **Local-disk uploads.** Blobs live on the API host's filesystem.
  Fine for a single-node deploy; needs S3/GCS migration before we scale
  horizontally. Signed-URL infra is already in place and abstracted —
  the swap is a storage-adapter change, not a contract change.
- **HTML -> PDF legacy generators.** 9 PDF generators still render via
  the old HTML-to-PDF path. pdfkit migration is in progress; the
  prescription generator is the reference implementation.
- **ER realtime event-name divergence.** The ER module emits a
  different event name shape than the rest of the app
  (`er_update` vs `er:update`). Clients handle both; needs a
  one-shot rename + client upgrade to clean up.
- **Admin-console color-contrast tech debt.** The admin-console page
  currently uses a per-page a11y budget override for 2 color-contrast
  violations pending a design-system color token revamp.
- **Mobile app is Phase 1.** Scaffolding only — billing + doctor-lite
  queue + push registration. Full feature parity is not a goal of
  Phase 1.
