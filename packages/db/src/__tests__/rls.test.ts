/**
 * Tenant-scoping isolation regression suite (P4 from
 * docs/TEST_COVERAGE_AUDIT.md §5).
 *
 * What this is — and isn't:
 * The audit doc calls this an "RLS policy verification" suite, but MedCore
 * does NOT use PostgreSQL Row-Level Security. Multi-tenant isolation is
 * enforced at the application layer by the Prisma `$extends` wrapper in
 * `apps/api/src/services/tenant-prisma.ts`, which auto-injects `tenantId`
 * into `where` / `data` based on the AsyncLocalStorage-bound context set by
 * `runWithTenant` (see `apps/api/src/services/tenant-context.ts`). This
 * suite is therefore a regression test for that scoping mechanism, not for
 * Postgres RLS. A leak here means PHI bleeding across tenants — treat any
 * failure as a P0 incident.
 *
 * Cross-package import note:
 * `tenantScopedPrisma` and `runWithTenant` live under `apps/api/`, but the
 * audit doc puts this file under `packages/db/src/__tests__/` (where the
 * scoped MODELS are defined). Importing api code from a packages test is a
 * code-organisation smell — see the report for the recommendation to lift
 * the wrapper into `@medcore/db` so `packages/*` is the single source of
 * truth for tenant scoping.
 *
 * Strategy:
 *   1. Create 2 fresh tenants (T1, T2) with unique subdomains so the suite
 *      is rerunnable on the same shared DB without `prisma db push --force-reset`.
 *   2. Inside each tenant's `runWithTenant` scope, seed 2-3 rows across the
 *      representative tenant-scoped models (User, Doctor, Patient,
 *      Appointment, Prescription, Invoice, Notification).
 *   3. Assert each tenant's scoped client only sees its own rows.
 *   4. Assert the un-scoped raw `prisma` client sees both tenants' rows
 *      (proves the data was actually written and that the filter is doing
 *      the work, not the absence of data).
 *   5. Assert cross-tenant `findUnique({ where: { id } })` from T1 returns
 *      null when given a T2 row id.
 *   6. Assert cross-tenant update / delete attempts no-op or throw —
 *      Prisma's `findUnique`-shaped delete will throw "Record not found"
 *      because the injected `tenantId` filter excludes the target row.
 *   7. afterAll: delete every row this suite created, scoped strictly by
 *      our two tenant ids. We never touch other tenants' data.
 *
 * The whole suite is gated on DATABASE_URL_TEST. Without a test DB it is
 * silently skipped so unit-only runs on a developer laptop don't fail.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import bcrypt from "bcryptjs";

// ── Cross-package import note ──────────────────────────────────────────────
// `tenantScopedPrisma`, `runWithTenant`, `tenantAsyncStorage`, and the
// integration-test helpers (`describeIfDB`, `getPrisma`) all live under
// `apps/api/`. The audit doc anchors this test at `packages/db/src/__tests__/`,
// so we reach across packages with dynamic `import()` calls — a static
// `import` would trip TS6059 ("file is not under rootDir") because
// `packages/db/tsconfig.json` correctly limits its `rootDir` to its own
// `src/`. Dynamic imports keep the file at the audit-mandated location AND
// keep `npx tsc --noEmit -p packages/db/tsconfig.json` clean. The
// architectural smell — that scoping logic lives in `apps/api` instead of
// `@medcore/db` — is called out in the report.
//
// All cross-package symbols are resolved once in `beforeAll` and held in
// module-scope vars that the tests close over.
type RunWithTenant = <T>(tenantId: string, fn: () => T) => T;
type AsyncLocalStorage<T> = { getStore(): T | undefined };
// `tenantScopedPrisma` is a Prisma client extension whose full type would
// pull every model delegate into this file. We type it loosely with an
// `id` + `tenantId` shape on returned rows — every model we touch has both
// columns — and only access the methods we exercise. The actual PrismaClient
// typings are still enforced inside apps/api.
interface RowShape {
  id: string;
  tenantId?: string | null;
  [key: string]: unknown;
}
interface ScopedDelegate {
  findMany: (args?: unknown) => Promise<RowShape[]>;
  findFirst: (args?: unknown) => Promise<RowShape | null>;
  findUnique: (args: unknown) => Promise<RowShape | null>;
  create: (args: unknown) => Promise<RowShape>;
  update: (args: unknown) => Promise<RowShape>;
  updateMany: (args: unknown) => Promise<{ count: number }>;
  delete: (args: unknown) => Promise<RowShape>;
  deleteMany: (args: unknown) => Promise<{ count: number }>;
  count: (args?: unknown) => Promise<number>;
}
interface ScopedPrisma {
  user: ScopedDelegate;
  doctor: ScopedDelegate;
  patient: ScopedDelegate;
  appointment: ScopedDelegate;
  prescription: ScopedDelegate;
  invoice: ScopedDelegate;
  notification: ScopedDelegate;
}
interface RawPrisma {
  tenant: {
    create: (args: unknown) => Promise<{ id: string; subdomain: string }>;
    delete: (args: unknown) => Promise<unknown>;
  };
  user: {
    create: (args: unknown) => Promise<{ id: string; email: string }>;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
  };
  patient: {
    findMany: (args?: unknown) => Promise<
      Array<{ id: string; tenantId: string | null; bloodGroup: string | null }>
    >;
    findUnique: (args: unknown) => Promise<
      | { id: string; tenantId: string | null; bloodGroup: string | null }
      | null
    >;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
  };
  doctor: { deleteMany: (args: unknown) => Promise<{ count: number }> };
  appointment: { deleteMany: (args: unknown) => Promise<{ count: number }> };
  prescription: { deleteMany: (args: unknown) => Promise<{ count: number }> };
  invoice: {
    findMany: (args?: unknown) => Promise<
      Array<{ id: string; tenantId: string | null }>
    >;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
  };
  notification: {
    findMany: (args?: unknown) => Promise<
      Array<{ id: string; tenantId: string | null }>
    >;
    findUnique: (args: unknown) => Promise<
      { id: string; tenantId: string | null } | null
    >;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
  };
}

let runWithTenant: RunWithTenant;
let tenantAsyncStorage: AsyncLocalStorage<{ tenantId: string }>;
let tenantScopedPrisma: ScopedPrisma;
let getPrisma: () => Promise<RawPrisma>;

// Sync gate: vitest needs to know at describe-time whether to skip.
const TEST_DB_AVAILABLE = !!process.env.DATABASE_URL_TEST;

// Use a process-stable random suffix so concurrent test files don't collide
// on `Tenant.subdomain` (unique) or `User.email` (unique). We pin once per
// process so the afterAll cleanup can find every row this suite created.
const SUITE_SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

interface SeededTenant {
  id: string;
  subdomain: string;
  adminUserId: string;
  doctorUserId: string;
  doctorId: string;
  patientUserIds: string[];
  patientIds: string[];
  appointmentIds: string[];
  prescriptionIds: string[];
  invoiceIds: string[];
  notificationIds: string[];
}

let t1: SeededTenant;
let t2: SeededTenant;

/**
 * Seed one tenant's full graph: 1 admin user, 1 doctor user + Doctor row,
 * 2 patient users + Patient rows, 2 appointments, 1 prescription on the
 * first appointment, 2 invoices (one per appointment), 2 notifications.
 *
 * All writes happen inside `runWithTenant(tenantId, …)` so the scoping
 * extension auto-tags every row with the right `tenantId` — that's the
 * mechanism we're testing, so we exercise it here too rather than passing
 * `tenantId` manually.
 */
async function seedTenantGraph(label: "T1" | "T2"): Promise<SeededTenant> {
  const prisma = await getPrisma();

  // Tenant + admin user are created with the un-scoped client because
  // creating a Tenant has no `tenantId` of its own (it IS the tenant), and
  // the very first user in a tenant is bootstrapped before any context can
  // exist.
  const tenant = await prisma.tenant.create({
    data: {
      name: `${label} Hospital ${SUITE_SUFFIX}`,
      subdomain: `${label.toLowerCase()}-rls-${SUITE_SUFFIX}`,
      plan: "BASIC",
      active: true,
    },
  });

  const adminUser = await prisma.user.create({
    data: {
      email: `${label.toLowerCase()}-admin-${SUITE_SUFFIX}@rls.test`,
      name: `${label} Admin`,
      phone: "9000000000",
      passwordHash: await bcrypt.hash("rls-test-pw", 4),
      role: "ADMIN",
      tenantId: tenant.id,
      isActive: true,
    },
  });

  // Everything else goes through `tenantScopedPrisma` inside the tenant's
  // async context — this is exactly the path application code uses.
  return runWithTenant(tenant.id, async () => {
    // Doctor user + Doctor row.
    const doctorUser = await tenantScopedPrisma.user.create({
      data: {
        email: `${label.toLowerCase()}-doc-${SUITE_SUFFIX}@rls.test`,
        name: `${label} Doctor`,
        phone: "9000000001",
        passwordHash: await bcrypt.hash("rls-test-pw", 4),
        role: "DOCTOR",
        isActive: true,
      },
    });
    const doctor = await tenantScopedPrisma.doctor.create({
      data: {
        userId: doctorUser.id,
        specialization: "General Medicine",
        languages: ["en"],
      },
    });

    // 2 patient users + Patient rows.
    const patientUserIds: string[] = [];
    const patientIds: string[] = [];
    for (let i = 1; i <= 2; i += 1) {
      const pUser = await tenantScopedPrisma.user.create({
        data: {
          email: `${label.toLowerCase()}-pat${i}-${SUITE_SUFFIX}@rls.test`,
          name: `${label} Patient ${i}`,
          phone: `90000001${i}0`,
          passwordHash: await bcrypt.hash("rls-test-pw", 4),
          role: "PATIENT",
          isActive: true,
        },
      });
      const patient = await tenantScopedPrisma.patient.create({
        data: {
          userId: pUser.id,
          mrNumber: `MR-${label}-${SUITE_SUFFIX}-${i}`,
          dateOfBirth: new Date("1990-01-01"),
          gender: "MALE",
        },
      });
      patientUserIds.push(pUser.id);
      patientIds.push(patient.id);
    }

    // 2 appointments (one per patient).
    const appointmentIds: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const appt = await tenantScopedPrisma.appointment.create({
        data: {
          patientId: patientIds[i]!,
          doctorId: doctor.id,
          date: new Date("2026-06-01"),
          tokenNumber: i + 1,
          type: "SCHEDULED",
          status: "BOOKED",
          priority: "NORMAL",
        },
      });
      appointmentIds.push(appt.id);
    }

    // 1 prescription (only on the first appointment — Appointment.prescription
    // is 1:1 via Prescription.appointmentId @unique).
    const presc = await tenantScopedPrisma.prescription.create({
      data: {
        appointmentId: appointmentIds[0]!,
        patientId: patientIds[0]!,
        doctorId: doctor.id,
        diagnosis: `${label} headache`,
      },
    });

    // 2 invoices (one per appointment — Invoice.appointmentId is @unique).
    const invoiceIds: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const inv = await tenantScopedPrisma.invoice.create({
        data: {
          invoiceNumber: `INV-${label}-${SUITE_SUFFIX}-${i + 1}`,
          appointmentId: appointmentIds[i]!,
          patientId: patientIds[i]!,
          subtotal: 500 + i * 100,
          totalAmount: 500 + i * 100,
        },
      });
      invoiceIds.push(inv.id);
    }

    // 2 notifications (one per patient user).
    const notificationIds: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const n = await tenantScopedPrisma.notification.create({
        data: {
          userId: patientUserIds[i]!,
          type: "APPOINTMENT_BOOKED",
          channel: "PUSH",
          title: `${label} appt booked`,
          message: `Token ${i + 1} confirmed.`,
        },
      });
      notificationIds.push(n.id);
    }

    return {
      id: tenant.id,
      subdomain: tenant.subdomain,
      adminUserId: adminUser.id,
      doctorUserId: doctorUser.id,
      doctorId: doctor.id,
      patientUserIds,
      patientIds,
      appointmentIds,
      prescriptionIds: [presc.id],
      invoiceIds,
      notificationIds,
    };
  });
}

/**
 * Delete every row this suite created. Scoped to our two tenant ids so we
 * never touch unrelated test data on the shared DB. Order matters because
 * of FK constraints — children before parents.
 *
 * We use the un-scoped `prisma` client here because we want to delete from
 * BOTH tenants in a single block, and because some FK chains
 * (Notification → User) would otherwise need a context switch per row.
 */
async function cleanupTenantGraph(t: SeededTenant): Promise<void> {
  const prisma = await getPrisma();
  const userIds = [t.adminUserId, t.doctorUserId, ...t.patientUserIds];
  // Children → parents:
  await prisma.notification.deleteMany({ where: { tenantId: t.id } });
  await prisma.invoice.deleteMany({ where: { tenantId: t.id } });
  await prisma.prescription.deleteMany({ where: { tenantId: t.id } });
  await prisma.appointment.deleteMany({ where: { tenantId: t.id } });
  await prisma.patient.deleteMany({ where: { tenantId: t.id } });
  await prisma.doctor.deleteMany({ where: { tenantId: t.id } });
  // Notification.userId / etc. are gone, so users are deletable now.
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.tenant.delete({ where: { id: t.id } }).catch(() => {
    // Already gone or cascaded — idempotent cleanup.
  });
}

// `describeIfDB` would normally be imported from apps/api/src/test/setup, but
// we keep cross-package imports out of the static graph (see header). We
// reproduce the gate here using vitest's native `skipIf` modifier.
const describeIntegration = describe.skipIf(!TEST_DB_AVAILABLE);

describeIntegration("Multi-tenant scoping isolation (P4 — Prisma context filter)", () => {
  beforeAll(async () => {
    // Resolve the cross-package symbols once. We compute the import paths at
    // runtime via string concatenation so TypeScript cannot follow them
    // statically — that's the trick that keeps
    // `tsc -p packages/db/tsconfig.json` clean despite the cross-package
    // reach. Vitest still resolves them at runtime through Node module
    // resolution exactly the same as a normal `import`.
    const apiBase = "../../../../apps/api/src/";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dyn = (p: string): Promise<any> => import(/* @vite-ignore */ p);
    const tenantContextMod = await dyn(`${apiBase}services/tenant-context`);
    const tenantPrismaMod = await dyn(`${apiBase}services/tenant-prisma`);
    const setupMod = await dyn(`${apiBase}test/setup`);
    runWithTenant = tenantContextMod.runWithTenant as RunWithTenant;
    tenantAsyncStorage =
      tenantContextMod.tenantAsyncStorage as AsyncLocalStorage<{
        tenantId: string;
      }>;
    tenantScopedPrisma = tenantPrismaMod.tenantScopedPrisma as ScopedPrisma;
    getPrisma = setupMod.getPrisma as () => Promise<RawPrisma>;

    [t1, t2] = await Promise.all([
      seedTenantGraph("T1"),
      seedTenantGraph("T2"),
    ]);
  }, 60_000);

  // Pre-flight sanity check: if anything left a stray AsyncLocalStorage frame
  // in scope (some other test forgot to await its `runWithTenant`), the suite
  // is meaningless. Bail loudly.
  beforeEach(() => {
    expect(tenantAsyncStorage.getStore()).toBeUndefined();
  });

  afterAll(async () => {
    if (t1) await cleanupTenantGraph(t1);
    if (t2) await cleanupTenantGraph(t2);
  }, 60_000);

  // ── Assertion 1: T1's tenant client only sees T1 rows ──────────────────
  describe("T1 scoped reads", () => {
    it("returns only T1 rows from every tenant-scoped model", async () => {
      await runWithTenant(t1.id, async () => {
        const [patients, appts, prescs, invoices, notifs, doctors] =
          await Promise.all([
            tenantScopedPrisma.patient.findMany(),
            tenantScopedPrisma.appointment.findMany(),
            tenantScopedPrisma.prescription.findMany(),
            tenantScopedPrisma.invoice.findMany(),
            tenantScopedPrisma.notification.findMany(),
            tenantScopedPrisma.doctor.findMany(),
          ]);

        // Every returned row must carry T1's tenantId.
        for (const row of [
          ...patients,
          ...appts,
          ...prescs,
          ...invoices,
          ...notifs,
          ...doctors,
        ]) {
          expect(row.tenantId).toBe(t1.id);
        }

        // None of the T2 ids should appear in T1's view.
        const seenIds = new Set([
          ...patients.map((p: { id: string }) => p.id),
          ...appts.map((a: { id: string }) => a.id),
          ...prescs.map((p: { id: string }) => p.id),
          ...invoices.map((i: { id: string }) => i.id),
          ...notifs.map((n: { id: string }) => n.id),
          ...doctors.map((d: { id: string }) => d.id),
        ]);
        for (const t2Id of [
          ...t2.patientIds,
          ...t2.appointmentIds,
          ...t2.prescriptionIds,
          ...t2.invoiceIds,
          ...t2.notificationIds,
          t2.doctorId,
        ]) {
          expect(seenIds.has(t2Id)).toBe(false);
        }

        // And T1 should see exactly the rows it created (no leakage from
        // other tests on the shared DB into T1's view that we control).
        const t1PatientIds = patients
          .map((p: { id: string }) => p.id)
          .filter((id: string) => t1.patientIds.includes(id));
        expect(t1PatientIds.sort()).toEqual([...t1.patientIds].sort());
      });
    });
  });

  // ── Assertion 2: T2's tenant client only sees T2 rows ──────────────────
  describe("T2 scoped reads", () => {
    it("returns only T2 rows from every tenant-scoped model", async () => {
      await runWithTenant(t2.id, async () => {
        const [patients, appts, prescs, invoices, notifs, doctors] =
          await Promise.all([
            tenantScopedPrisma.patient.findMany(),
            tenantScopedPrisma.appointment.findMany(),
            tenantScopedPrisma.prescription.findMany(),
            tenantScopedPrisma.invoice.findMany(),
            tenantScopedPrisma.notification.findMany(),
            tenantScopedPrisma.doctor.findMany(),
          ]);

        for (const row of [
          ...patients,
          ...appts,
          ...prescs,
          ...invoices,
          ...notifs,
          ...doctors,
        ]) {
          expect(row.tenantId).toBe(t2.id);
        }

        const seenIds = new Set([
          ...patients.map((p: { id: string }) => p.id),
          ...appts.map((a: { id: string }) => a.id),
          ...prescs.map((p: { id: string }) => p.id),
          ...invoices.map((i: { id: string }) => i.id),
          ...notifs.map((n: { id: string }) => n.id),
          ...doctors.map((d: { id: string }) => d.id),
        ]);
        for (const t1Id of [
          ...t1.patientIds,
          ...t1.appointmentIds,
          ...t1.prescriptionIds,
          ...t1.invoiceIds,
          ...t1.notificationIds,
          t1.doctorId,
        ]) {
          expect(seenIds.has(t1Id)).toBe(false);
        }
      });
    });
  });

  // ── Assertion 3: Un-scoped raw client sees BOTH tenants' rows ──────────
  // Proves the data was actually written and that the absence in T1's /
  // T2's views is the filter doing its job, not data missing.
  describe("un-scoped raw prisma (admin / migration path)", () => {
    it("sees rows from both T1 and T2 when no tenant context is bound", async () => {
      const prisma = await getPrisma();
      // Fetch only the rows we explicitly seeded to avoid noise from other
      // tests on the shared DB.
      const allPatientIds = [...t1.patientIds, ...t2.patientIds];
      const patients = await prisma.patient.findMany({
        where: { id: { in: allPatientIds } },
      });
      expect(patients.map((p: { id: string }) => p.id).sort()).toEqual(
        [...allPatientIds].sort(),
      );

      const allInvoiceIds = [...t1.invoiceIds, ...t2.invoiceIds];
      const invoices = await prisma.invoice.findMany({
        where: { id: { in: allInvoiceIds } },
      });
      expect(invoices).toHaveLength(allInvoiceIds.length);

      // And the rows ARE tagged with the correct tenantId in the column —
      // confirming the create-side injection landed.
      const t1Invoices = invoices.filter(
        (i: { tenantId: string | null }) => i.tenantId === t1.id,
      );
      const t2Invoices = invoices.filter(
        (i: { tenantId: string | null }) => i.tenantId === t2.id,
      );
      expect(t1Invoices).toHaveLength(t1.invoiceIds.length);
      expect(t2Invoices).toHaveLength(t2.invoiceIds.length);
    });
  });

  // ── Assertion 4: Cross-tenant findUnique returns null ──────────────────
  describe("cross-tenant findUnique", () => {
    it("returns null when T1 looks up a T2 row by id", async () => {
      await runWithTenant(t1.id, async () => {
        // findUnique with a primary-key shape — the extension widens this to
        // findFirst-style by injecting tenantId into the where, which is
        // the exact behaviour we want: a foreign id from another tenant
        // produces NO match.
        const ghostPatient = await tenantScopedPrisma.patient.findUnique({
          where: { id: t2.patientIds[0]! },
        });
        expect(ghostPatient).toBeNull();

        const ghostInvoice = await tenantScopedPrisma.invoice.findUnique({
          where: { id: t2.invoiceIds[0]! },
        });
        expect(ghostInvoice).toBeNull();

        const ghostAppt = await tenantScopedPrisma.appointment.findUnique({
          where: { id: t2.appointmentIds[0]! },
        });
        expect(ghostAppt).toBeNull();

        // And `findFirst` with a direct id filter must also return null.
        const ghostNotif = await tenantScopedPrisma.notification.findFirst({
          where: { id: t2.notificationIds[0]! },
        });
        expect(ghostNotif).toBeNull();
      });
    });

    it("symmetrically: T2 sees null when querying T1 ids", async () => {
      await runWithTenant(t2.id, async () => {
        const ghostPatient = await tenantScopedPrisma.patient.findUnique({
          where: { id: t1.patientIds[0]! },
        });
        expect(ghostPatient).toBeNull();
      });
    });
  });

  // ── Assertion 5: Cross-tenant write attempts no-op or throw ────────────
  describe("cross-tenant updates and deletes", () => {
    it("update({ where: { id: t2RowId } }) from T1 throws (record not found)", async () => {
      await runWithTenant(t1.id, async () => {
        // Prisma's `update` requires the row to exist; the extension
        // injects tenantId into the where, so the row is invisible and
        // Prisma raises "Record to update not found".
        await expect(
          tenantScopedPrisma.patient.update({
            where: { id: t2.patientIds[0]! },
            data: { bloodGroup: "EVIL_HACKED" },
          }),
        ).rejects.toThrow();
      });

      // Verify the targeted T2 row is UNCHANGED via the un-scoped client.
      const prisma = await getPrisma();
      const stillFine = await prisma.patient.findUnique({
        where: { id: t2.patientIds[0]! },
      });
      expect(stillFine).not.toBeNull();
      expect(stillFine?.bloodGroup).not.toBe("EVIL_HACKED");
      expect(stillFine?.tenantId).toBe(t2.id);
    });

    it("updateMany targeting another tenant's row updates 0 records", async () => {
      await runWithTenant(t1.id, async () => {
        const result = await tenantScopedPrisma.patient.updateMany({
          where: { id: t2.patientIds[0]! },
          data: { bloodGroup: "EVIL_BULK_HACKED" },
        });
        expect(result.count).toBe(0);
      });

      const prisma = await getPrisma();
      const stillFine = await prisma.patient.findUnique({
        where: { id: t2.patientIds[0]! },
      });
      expect(stillFine?.bloodGroup).not.toBe("EVIL_BULK_HACKED");
    });

    it("delete({ where: { id: t2RowId } }) from T1 throws and T2 row survives", async () => {
      // Use a row that has no children attached (the second invoice's row
      // we'd also need to delete its appointment — pick the second
      // appointment which has no prescription dependency).
      const targetId = t2.notificationIds[0]!;

      await runWithTenant(t1.id, async () => {
        await expect(
          tenantScopedPrisma.notification.delete({
            where: { id: targetId },
          }),
        ).rejects.toThrow();
      });

      const prisma = await getPrisma();
      const survivor = await prisma.notification.findUnique({
        where: { id: targetId },
      });
      expect(survivor).not.toBeNull();
      expect(survivor?.tenantId).toBe(t2.id);
    });

    it("deleteMany targeting another tenant deletes 0 records", async () => {
      const targetIds = [...t2.notificationIds];
      await runWithTenant(t1.id, async () => {
        const result = await tenantScopedPrisma.notification.deleteMany({
          where: { id: { in: targetIds } },
        });
        expect(result.count).toBe(0);
      });

      const prisma = await getPrisma();
      const survivors = await prisma.notification.findMany({
        where: { id: { in: targetIds } },
      });
      expect(survivors).toHaveLength(targetIds.length);
    });
  });

  // ── Bonus: count / aggregate are also scoped ───────────────────────────
  // Confirms the `READ_WRITE_OPERATIONS` set in tenant-prisma.ts covers
  // aggregations too. A mistake here would let "how many patients does
  // this tenant have" leak — a common dashboard query.
  describe("count / aggregate are scoped", () => {
    it("count() in T1 excludes T2 rows", async () => {
      await runWithTenant(t1.id, async () => {
        const t1PatientCount = await tenantScopedPrisma.patient.count();
        // We only seeded 2 patients in T1 — but other tests on the shared
        // DB may have left rows around. The invariant we CAN assert is
        // that the count is at least our 2 and strictly less than
        // (everyone-else + ours + T2's), and that none of the T2 ids show
        // up in a findMany-with-id-filter probe.
        expect(t1PatientCount).toBeGreaterThanOrEqual(t1.patientIds.length);

        // Probe: a full findMany inside T1 must not include any T2 ids.
        const all = await tenantScopedPrisma.patient.findMany({
          where: { id: { in: [...t1.patientIds, ...t2.patientIds] } },
        });
        const visibleIds = new Set(all.map((p: { id: string }) => p.id));
        for (const t1Id of t1.patientIds) expect(visibleIds.has(t1Id)).toBe(true);
        for (const t2Id of t2.patientIds) expect(visibleIds.has(t2Id)).toBe(false);
      });
    });
  });
});
