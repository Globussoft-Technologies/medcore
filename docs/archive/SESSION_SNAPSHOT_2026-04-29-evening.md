# Session snapshot — 2026-04-29 evening

End-of-day handoff. Picks up where [`SESSION_SNAPSHOT_2026-04-29.md`](SESSION_SNAPSHOT_2026-04-29.md) and [`TODO_2026-04-29.md`](TODO_2026-04-29.md) left off.

## What landed today (after the morning push, in order)

| Commit | What |
|---|---|
| `114491a` | chmod +x on all 11 `scripts/*.sh` + DEPLOY.md restructured GHA-first + deploy.sh header rewrite (TODO §1, partial) |
| `ccb0b18` | Workflow invokes `bash <path>` so file mode is irrelevant (TODO §1, completion) |
| `937409e` | Workflow-level pre-clean of stale `package-lock.json` before invoking script — this is what actually unblocked auto-deploy |
| `b3e24f8` | Cluster A — DOMMatrix polyfill in `apps/api/src/test/setup-env.ts` for pdfjs-dist on CI Node 20 |
| `9babbbf` | Cluster D — settings page error handling (component-was-broken, added try/catch around `/auth/me` load) |
| `97dd473` | Cluster C — defensive null-checks on stats/summary reads across 3 dashboard pages |
| `cb2a132` | Cluster B — partial fix: allergy MILD/MODERATE round-trip + prescriptionItem dedup |

## What's now working

- **Auto-deploy is fixed.** End-to-end flow ran green for `937409e` and onward (ie, latest commits live on `medcore.globusdemos.com`). See [`DEPLOY.md` §9](DEPLOY.md#9-troubleshooting) for the new auto-deploy failure-mode subsection added in this session.
- **Cluster A** — DOMMatrix polyfill applied; `pdf-generator.test.ts` and `ocr.test.ts` no longer in CI's failure list.
- **Cluster D** — settings page test passes (component now swallows the `/auth/me` 500 instead of letting it bubble out of the React boundary).
- **Cluster C** — defensive `?.` chains across `appointments`, `bloodbank`, `visitors` dashboard pages. Will be confirmed green once the next CI run completes against the post-Cluster-C tree.

## What's still red

### Cluster B — FHIR round-trip — PARTIAL FIX, MORE WORK NEEDED

`cb2a132` fixed two of the three failures the test suite reported on `9babbbf`:

1. **`allergy severity enum is preserved`** — fixed. `mapAllergySeverityBack` no longer drifts MILD → MODERATE.
2. **`OPConsultation > ingest is idempotent`** — fixed (very likely; same root cause as #3 below for that scenario).
3. **`ChronicCare > ingest is idempotent`** — **STILL FAILING** after the partial fix. Live verification on the dev box's `medcore_test` DB at end of session showed:

   ```
   Pre-snap:  prescriptions: 2, prescriptionItems: 4
   Post-snap: prescriptions: 3, prescriptionItems: 6
   ```

   So `prescriptions` count went 2 → **3** (+1) and items went 4 → **6** (+2). My item-dedupe is working (otherwise items would be 8+) but the underlying problem is that **`ingestMedicationRequest` picks the wrong appointment**.

#### Diagnosed root cause (need to fix)

[`apps/api/src/services/fhir/ingest.ts:684-689`](../apps/api/src/services/fhir/ingest.ts#L684) — the handler picks the most-recent appointment for `(patientId, doctorId)` rather than the appointment the original prescription was attached to:

```ts
const appointment = await tx.appointment.findFirst({
  where: { patientId, doctorId },
  orderBy: { date: "desc" },
});
```

In ChronicCare the patient has 6 appointments; only 2 had prescriptions. On round-trip the most-recent appointment may differ from those 2, so:
- `findUnique({ appointmentId: latest.id })` returns null
- A NEW prescription is created on the latest appointment
- The original prescriptions stay untouched but become dangling
- `prescriptions` count grows by 1; items pile onto the new prescription

#### How to fix

The forward mapper [`prescriptionToMedicationRequests`](../apps/api/src/services/fhir/resources.ts#L549) emits MedicationRequest IDs as `${prescription.id}-${item.id ?? idx}`. So the original `prescription.id` IS recoverable from the FHIR resource id. Fix shape:

```ts
// Parse the prescription.id back out of the MedicationRequest.id.
// Forward mapper emits `${prescription.id}-${item.id}` (uuid-uuid).
const sourcePrescriptionId = resource.id?.split("-").slice(0, 5).join("-"); // uuid is 5 dash-segments
let prescription = sourcePrescriptionId
  ? await tx.prescription.findUnique({ where: { id: sourcePrescriptionId } })
  : null;

if (!prescription) {
  // Fall back to the appointment-based lookup for non-round-tripped bundles
  // (i.e. inbound from external systems that don't carry our id format).
  // KEEP the existing block as the fallback path.
}
```

Then dedupe items as already done in `cb2a132`.

That should drop `prescriptions: 3` back to `prescriptions: 2` and `prescriptionItems: 6` to `prescriptionItems: 4`, and the test goes green.

### Web tests — additional rot beyond TODO §3

In the post-Cluster-D run (`9babbbf`) one new test file was failing:
- `apps/web/src/app/dashboard/ai-radiology/page.test.tsx > AiRadiologyPage — region overlay > renders a data-testid wrapper for every finding region in the pending-review detail view`

Plus three console errors that may or may not be asserted-on:
- `Cannot read properties of undefined (reading 'BOOKED')`
- `Cannot read properties of undefined (reading 'toLocaleString')`
- `p.services.split is not a function`

Need a closer look — Cluster C didn't address these, they're separate issues.

## Other carry-over

### Step 2 — Migrate Postgres off Docker (deferred)

User explicitly asked for this; deferred until Cluster B is green. See [`DEPLOY.md` "Manual fallback runbook"](DEPLOY.md#manual-fallback-runbook) for the current state. Quick recap of the box:

- Native Postgres 16.13 already installed and `online` per `pg_lsclusters`, listening on `127.0.0.1:5432`.
- Docker container `medcore-postgres` (`postgres:16-alpine`) on `0.0.0.0:5433` is what `DATABASE_URL` currently points at.
- `empcloud-development` is in the `docker` group (no sudo for `docker ps/stop/rm`).
- `sudo` requires password (passwordless `sudo -n` fails) — needed for any `pg_hba.conf` / postgres-superuser flow.

Migration steps when picked up:
1. `pg_dump` from Docker (5433/medcore) → `dump.sql`
2. Create `medcore` role + database in native (5432) with same password
3. `psql` restore the dump
4. Update `/home/empcloud-development/medcore/.env` `DATABASE_URL` from `5433` → `5432`
5. Update `scripts/deploy.sh` constant `DB_URL` from `5433` → `5432`
6. PM2 restart, verify `/api/health`
7. `docker stop medcore-postgres && docker rm medcore-postgres`
8. Update DEPLOY.md to remove all Docker references

### Restore full CI gate (#415)

Currently `needs: [typecheck]` only in `.github/workflows/test.yml` line 245. After Cluster B + the AiRadiologyPage fix land green in CI, restore to:

```yaml
needs: [test, web-tests, typecheck, e2e]
```

Then close [#415](https://github.com/Globussoft-Technologies/medcore/issues/415).

## Pickup commands at home

```bash
# 1. Sync
cd "<your medcore path>"
git pull origin main   # should pick up cb2a132 + this snapshot doc

# 2. Verify nothing else has shifted while you were away
"/c/Program Files/GitHub CLI/gh.exe" run list --repo Globussoft-Technologies/medcore --branch main --limit 5 --json headSha,conclusion,displayTitle --jq '.[] | "\(.headSha[:8]) \(.conclusion) — \(.displayTitle)"'

# 3. SSH credentials are in repo-root .env (gitignored). plink is at "C:/Program Files/PuTTY/plink.exe" if you're on this Windows box; install via `winget install --id PuTTY.PuTTY` if not.
export PATH="/c/Program Files/PuTTY:$PATH"
set -a && source .env && set +a
plink -ssh -batch -pw "$SERVER_PASSWORD" -hostkey "SHA256:DXDaCOdx65e8JeRoH4rI7AXcmW5Ge+e+D7rXFe2U5mw" "$SERVER_USER@$SERVER_IP" 'echo connected'

# 4. Pick up Cluster B from the diagnosed point above. The fix is in
#    apps/api/src/services/fhir/ingest.ts ingestMedicationRequest —
#    parse prescription id back out of MedicationRequest.id instead of
#    "most recent appointment for patient+doctor".

# 5. Verify the fix on the dev box's medcore_test DB:
plink -ssh -batch -pw "$SERVER_PASSWORD" -hostkey "SHA256:DXDaCOdx65e8JeRoH4rI7AXcmW5Ge+e+D7rXFe2U5mw" "$SERVER_USER@$SERVER_IP" '
  export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
  cd ~/medcore && git pull --ff-only origin main
  export DATABASE_URL_TEST="postgresql://medcore:medcore_secure_2024@localhost:5433/medcore_test?schema=public"
  export DATABASE_URL="$DATABASE_URL_TEST"
  export JWT_SECRET=test JWT_REFRESH_SECRET=test NODE_ENV=test
  npx prisma db push --schema packages/db/prisma/schema.prisma --force-reset --skip-generate
  npx vitest run apps/api/src/services/fhir/round-trip.test.ts --reporter=default
'
```

## Conventions reminders (still load-bearing)

- `.env` at repo root holds `SERVER_USER` / `SERVER_PASSWORD` / `SERVER_IP` and is gitignored. Password may have been exposed in chat logs — rotate if security matters.
- Hand-craft schema migrations; don't `prisma migrate dev`.
- ASR is Sarvam-only (India-region).
- Auto-approve enabled via `.claude/settings.local.json` — no terminal prompts on this project for Bash/PowerShell/Read/Write/Edit/Glob/Grep.
- All commits today follow conventional-commit format with no Co-Authored-By trailer (per repo policy).
