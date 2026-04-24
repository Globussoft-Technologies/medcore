# Post-Deploy Data-Correction Scripts

Appendix to [`DEPLOY.md`](DEPLOY.md). Every production-safe fix / dedup /
backfill script in one place, with its dry-run and apply command.

All scripts in this list:

- Default to **dry-run** (no writes). Pass `--apply` to persist.
- Are **idempotent** — re-running an `--apply` is safe; already-correct rows
  are skipped.
- Use raw `prisma` (not `tenantScopedPrisma`) because data corrections are
  cross-tenant by definition.
- Emit per-row diagnostics to **stderr** and a single **JSON summary** to
  **stdout**, so you can pipe the summary into `jq` without noise.

> **Rollback note:** none of these scripts have an automated undo. If you
> run an `--apply` against the wrong environment, the recovery path is:
> (a) restore from the most recent pg_dump in `/var/backups/medcore/`, or
> (b) the per-script "reverse this change" playbook documented in
> [`AUDIT_RENAME_MAP_2026-04-23.md`](AUDIT_RENAME_MAP_2026-04-23.md) where
> one exists.

---

## Tenant backfills

Run **every time** a migration adds `tenantId` to more tables.
Precedent: `20260423000005_tenant_scope_extended`,
`20260424000002_admission_dama_and_tenant_extension`.

| Script | Purpose |
|---|---|
| `scripts/backfill-default-tenant.ts` | Upserts the `DEFAULT` tenant, labels every NULL-`tenantId` row across all tenant-scoped tables. |

```bash
# Dry-run (safe, zero writes):
npx tsx scripts/backfill-default-tenant.ts

# Apply:
npx tsx scripts/backfill-default-tenant.ts --apply
```

---

## Patient-data fixes

| Script | Issue | Fixes |
|---|---|---|
| `scripts/backfill-patient-ages.ts` | #13 | Recomputes `Patient.age` from `dateOfBirth` where age is 0 and DOB is set. Leaves `dateOfBirth IS NULL` rows alone. |
| `scripts/fix-stale-immunizations.ts` | #46 | Marks pediatric doses overdue on adult patients as MISSED; recomputes `nextDueDate` for children using UIP age offsets. |

```bash
npx tsx scripts/backfill-patient-ages.ts            # dry-run
npx tsx scripts/backfill-patient-ages.ts --apply

npx tsx scripts/fix-stale-immunizations.ts          # dry-run
npx tsx scripts/fix-stale-immunizations.ts --apply
```

---

## Medicine catalogue fixes

| Script | Issue | Fixes |
|---|---|---|
| `scripts/fix-medicine-manufacturers.ts` | #41 | Backfills blank `Medicine.brand` (aliased to "Manufacturer" in the UI) with canonical mappings, then deterministic round-robin fallback. |
| `scripts/fix-rx-required-flags.ts` | #40 | Flips `prescriptionRequired = true` on Schedule-H drugs that were mis-flagged OTC. Never downgrades RX→OTC. |

```bash
npx tsx scripts/fix-medicine-manufacturers.ts       # dry-run
npx tsx scripts/fix-medicine-manufacturers.ts --apply

npx tsx scripts/fix-rx-required-flags.ts            # dry-run
npx tsx scripts/fix-rx-required-flags.ts --apply
```

---

## Admission dedup

| Script | Issue | Fixes |
|---|---|---|
| `scripts/dedup-active-admissions.ts` | #37 | Resolves patients with 2+ simultaneous `ADMITTED` rows. Keeps the most recent; closes older rows with a `[Auto-closed: duplicate admission detected, see ticket #37]` notes prefix and frees the bed if it's no longer referenced. |

```bash
npx tsx scripts/dedup-active-admissions.ts          # dry-run
npx tsx scripts/dedup-active-admissions.ts --apply
```

This script reads from **every tenant** and sorts duplicates by `admittedAt`
then `createdAt`, so the result is stable across re-runs.

---

## Audit action-name rename

One-shot; already applied in production on 2026-04-23. Listed here so ops
know what it did in case a historical audit report looks surprising.

| Script | Purpose |
|---|---|
| `scripts/rename-audit-actions.ts` | Renames legacy audit-action codes to the post-audit canonical names. Full old→new map in [`AUDIT_RENAME_MAP_2026-04-23.md`](AUDIT_RENAME_MAP_2026-04-23.md). |

```bash
npx tsx scripts/rename-audit-actions.ts             # dry-run
npx tsx scripts/rename-audit-actions.ts --apply
```

---

## Insurance-claims v2 migration

Covered in detail in [`DEPLOY.md` §5](DEPLOY.md#5-data-migration--insurance-claims-v2)
and [`scripts/README-insurance-migration.md`](../scripts/README-insurance-migration.md).
Summary:

| Script | Purpose |
|---|---|
| `scripts/migrate-insurance-claims-to-v2.ts` | Migrates legacy `insurance_claims` rows into the TPA-aware `insurance_claims_v2` table. Legacy rows are NOT deleted. |
| `scripts/verify-insurance-claims-migration.ts` | Row-count + field spot-check parity between legacy and v2. |

```bash
npx tsx scripts/migrate-insurance-claims-to-v2.ts                    # dry-run
npx tsx scripts/migrate-insurance-claims-to-v2.ts --apply
npx tsx scripts/verify-insurance-claims-migration.ts                 # verify
```

Idempotency key: `providerClaimRef = "LEGACY-<id>"`. Safe to re-run.

---

## Running order (fresh / disaster recovery)

If you're rebuilding a prod database from `seed-realistic.ts`, run in this
order:

1. `npx prisma migrate deploy`
2. `npx tsx packages/db/src/seed-realistic.ts`
3. `npx tsx scripts/backfill-default-tenant.ts --apply`
4. `npx tsx scripts/backfill-patient-ages.ts --apply`
5. `npx tsx scripts/fix-medicine-manufacturers.ts --apply`
6. `npx tsx scripts/fix-rx-required-flags.ts --apply`
7. `npx tsx scripts/fix-stale-immunizations.ts --apply`
8. `npx tsx scripts/dedup-active-admissions.ts --apply`
9. `scripts/verify-deploy.sh` + `npx tsx scripts/prod-smoke-test.ts`

Under normal deploys (not fresh builds) only run the scripts whose
preconditions are actually met by the current deploy diff.
