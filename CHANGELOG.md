# Changelog

All notable changes to MedCore are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres (loosely)
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Session window: `ff24ba7` (2026-04-14) -> `63a592c` (2026-04-15).
Focus: production hardening, test depth, accessibility, i18n, mobile scaffolding.

### Added
- **Test suite expansion**: 659 -> **1,343 tests** across 6 layers
  (unit, integration, page-level, e2e, concurrency, a11y). 587 new API
  integration/unit tests across 30 routers; 57 new web page-level tests
  across 10 dashboard pages.
- **45 routers** now have integration coverage with auth, validation, and
  error-path assertions.
- **Walk-in token race** concurrency test — hammers the queue allocator in
  parallel to prove the unique-per-day token invariant holds under contention.
- **Database migrations** — first-class Prisma migration history replacing
  ad-hoc `db push`. Initial baseline, auth-state persistence, role expansion,
  and schema drift reconciliation migrations.
- **Razorpay webhook handler** with signature verification, amount
  cross-check against the source invoice, and idempotency via webhook event
  IDs (fail-closed: any verification error rejects the payment).
- **Uploads security stack**: row-level ACL checks, server-side MIME sniffing
  (reject-by-magic-bytes, not just extension), per-mime size caps, signed
  short-lived download URLs, and a retention cron that purges expired blobs.
- **PDF generation** via `pdfkit` (server-side, deterministic, archival-safe)
  with real scannable QR codes embedded for prescription verify-flow.
  Includes Socket.IO realtime delivery + tests.
- **Mobile Phase 1** scaffolding: Expo SDK 53 + expo-router app shell, EAS
  build config, push-notification registration, billing screens,
  doctor-lite queue view, and realtime socket wiring.
- **Hindi (hi-IN) i18n** on 10 dashboard pages with locale switcher.
- **Accessibility gate**: WCAG 2.1 AA compliance with per-page budget
  overrides, enforced in CI via `@axe-core/playwright`.
- **TOTP 2FA**: enrolment, verify-login, backup codes. Temp tokens persisted
  to DB (not in-memory Map) for replica safety.
- **PHARMACIST** and **LAB_TECH** roles (5 -> 7) for least-privilege access.
- **Scheduled task registry** written to `system_config` table with last-run
  timestamps for observability (drainScheduled, retention, backup, etc.).
- **Backup restore rehearsal** — full round-trip (dump -> restore to scratch
  DB -> row-count verify across 8 critical tables). Verified 2026-04-15.
- **DataTable**, **Tooltip**, **Autocomplete**, **EmptyState** primitives,
  dark-mode sweep, toast migration, mobile bottom nav on web.
- **app/server split** in the API so tests can import the Express app
  without spinning up the HTTP listener or Socket.IO server.

### Changed
- Rate limits raised to **600 req/min global**, **30/min on /auth** for
  dashboard-friendly browsing.
- Prescription verify page upgraded to Next.js 15 async-params signature.
- 20 button-name + form-label fixes for screen-reader compliance.
- Queue events now room-scoped (`queue:<doctorId>`, `token-display`) rather
  than broadcast.
- JWTs are now `jti`-scoped so refresh-token rotation can detect replay.

### Fixed
- **Notification drain** now picks up rows with `scheduledFor = NULL`
  (previously stuck in QUEUED forever).
- **Lab order-number generator** correctly filters by `LAB` prefix — no more
  cross-prefix collisions.
- **Admin-console** handles the grouped roster response shape and stops
  calling the removed `/auth/users` endpoint.
- MR sequence upsert race on patient create.
- A11y: low-contrast text on admin-console darkened; aria-labels on
  DataTable page-size, admissions selects, and billing actions menu.
- Test brittleness: vitest positional paths (replacing deprecated `--dir`),
  asset enum values, queue endpoint URL, vulnerability rank neutralization
  in queue-ordering test, auth token shape in patients tests.

### Security
- **Razorpay fail-closed**: any signature or amount mismatch rejects the
  payment end-to-end; no silent retries.
- **Upload ACL** now enforced at the row level — users cannot fetch blobs
  they don't own even with a valid signed URL from a different tenant.
- **MIME sniffing** blocks spoofed `.pdf.exe` style uploads.
- **2FA state** moved out of process memory so a restart or second replica
  cannot bypass challenges.

### Infrastructure
- `packages/db` now the single source of truth for schema and migrations.
- Push-token drift migration added to unblock mobile rollout.
- Playwright e2e suite (30 specs) stabilized against prod rate limits.
- New devDeps: `pdfkit`, `qrcode`, `@axe-core/playwright`, `vitest`,
  `playwright`, `supertest`, `@faker-js/faker`.
- `.gitignore` expanded to exclude local investigation scripts.

---

## [v1.0.0] - 2026-04-13

Baseline snapshot of MedCore prior to the hardening session above.

### Included at baseline
- **Full-stack monorepo**: Next.js 15 web app, Express + Prisma API,
  Postgres, Socket.IO realtime, PM2 process manager.
- **Clinical modules**: OPD, IPD/Admissions, EHR, Prescriptions, Lab
  (orders + results), Pharmacy Inventory, Surgery/OT, Emergency/ER,
  Antenatal/Maternity, Pediatric, Immunizations, Telemedicine, Blood
  Bank, Ambulance, Referrals, Feedback, Chat, Visitor Pass.
- **Operational modules**: Appointments with queue, Billing + invoices
  (pending/partial states), Staff HR, Payroll, Leave Management, Assets,
  Purchase Orders, Suppliers, Wards, Notifications.
- **Auth**: password login with bcrypt, JWT access + refresh, 5 roles
  (SUPER_ADMIN, ADMIN, DOCTOR, NURSE, RECEPTIONIST), password reset.
- **Security**: rate limiting, audit logging, RBAC across routes.
- **Seed data**: 35 realistic patients, 14 days of history, full OPD flow
  across all modules for demo/dev use.
- **Deployment**: PM2 ecosystem config, `scripts/` for backup/restore/
  deploy/healthcheck/pm2-setup.
- **Docs**: PRD, TEST_PLAN, 68 Playwright screenshots (one per module)
  embedded in the README, full CONTRIBUTING guide with migration runbook.
- **500+ tests** at initial infrastructure commit (`a8f22e8`).

[Unreleased]: https://github.com/Globussoft-Technologies/medcore/compare/v1.0.0...HEAD
[v1.0.0]: https://github.com/Globussoft-Technologies/medcore/releases/tag/v1.0.0
