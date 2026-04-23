/**
 * Unit tests for the tenant-scoped Prisma client extension.
 *
 * Strategy:
 * - `shouldScope` and `applyTenantScope` are pure — we exercise them directly
 *   across the 20 scoped models and a handful of non-scoped models to prove
 *   the filter decision matrix is correct.
 * - The extension itself is tested by spying on `prisma.$extends`'s
 *   underlying `query` callback. We drive it through the public
 *   `tenantScopedPrisma.<model>.<op>(args)` surface while controlling the
 *   tenant context via `runWithTenant`, and we assert that the call that
 *   reaches the underlying mock prisma has (or does not have) the injected
 *   `tenantId`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock setup ──────────────────────────────────────────────────────────────
// We capture every call to the underlying prisma delegate so assertions can
// inspect exactly what the extension forwarded after its $allOperations hook
// ran. The extension intercepts at the `$allOperations` layer, so by
// returning predictable results we can focus on the args transformation.

const { mockPrisma, calls } = vi.hoisted(() => {
  // Mutable call log — one entry per delegate invocation.
  const calls: Array<{
    model: string;
    operation: string;
    args: unknown;
  }> = [];

  // Build an object that looks enough like a real PrismaClient for
  // `$extends` to wrap it. The extension's `query.$allModels.$allOperations`
  // hook calls `query(args)` which Prisma resolves to the underlying
  // delegate method. We simulate that with a tiny proxy.
  const delegateFor = (model: string) => {
    const ops = [
      "findMany",
      "findFirst",
      "findUnique",
      "findUniqueOrThrow",
      "findFirstOrThrow",
      "create",
      "createMany",
      "update",
      "updateMany",
      "delete",
      "deleteMany",
      "upsert",
      "count",
      "aggregate",
      "groupBy",
    ];
    const obj: Record<string, unknown> = {};
    for (const op of ops) {
      obj[op] = (args: unknown) => {
        calls.push({ model, operation: op, args });
        return Promise.resolve({ mocked: true, model, op, args });
      };
    }
    return obj;
  };

  const mockPrisma: Record<string, unknown> = {
    // Tenant-scoped delegates
    patient: delegateFor("Patient"),
    doctor: delegateFor("Doctor"),
    user: delegateFor("User"),
    appointment: delegateFor("Appointment"),
    consultation: delegateFor("Consultation"),
    prescription: delegateFor("Prescription"),
    invoice: delegateFor("Invoice"),
    payment: delegateFor("Payment"),
    labOrder: delegateFor("LabOrder"),
    labResult: delegateFor("LabResult"),
    admission: delegateFor("Admission"),
    medicationOrder: delegateFor("MedicationOrder"),
    nurseRound: delegateFor("NurseRound"),
    referral: delegateFor("Referral"),
    surgery: delegateFor("Surgery"),
    staffShift: delegateFor("StaffShift"),
    leaveRequest: delegateFor("LeaveRequest"),
    telemedicineSession: delegateFor("TelemedicineSession"),
    emergencyCase: delegateFor("EmergencyCase"),
    notification: delegateFor("Notification"),
    // Non-tenant-scoped delegates
    icd10Code: delegateFor("Icd10Code"),
    medicine: delegateFor("Medicine"),
    systemConfig: delegateFor("SystemConfig"),

    // Minimal $extends implementation: translate the user's
    // `query.$allModels.$allOperations` callback into proxied delegate
    // methods that call the callback with `model`, `operation`, `args`,
    // `query`.
    $extends(config: {
      name?: string;
      query?: {
        $allModels?: {
          $allOperations?: (ctx: {
            model: string;
            operation: string;
            args: unknown;
            query: (args: unknown) => Promise<unknown>;
          }) => Promise<unknown>;
        };
      };
    }) {
      const hook = config.query?.$allModels?.$allOperations;
      if (!hook) return mockPrisma;

      // Map delegate key (camelCase) → Prisma `model` PascalCase used by the
      // extension API. We maintain an explicit table so tests are readable.
      const MODEL_NAMES: Record<string, string> = {
        patient: "Patient",
        doctor: "Doctor",
        user: "User",
        appointment: "Appointment",
        consultation: "Consultation",
        prescription: "Prescription",
        invoice: "Invoice",
        payment: "Payment",
        labOrder: "LabOrder",
        labResult: "LabResult",
        admission: "Admission",
        medicationOrder: "MedicationOrder",
        nurseRound: "NurseRound",
        referral: "Referral",
        surgery: "Surgery",
        staffShift: "StaffShift",
        leaveRequest: "LeaveRequest",
        telemedicineSession: "TelemedicineSession",
        emergencyCase: "EmergencyCase",
        notification: "Notification",
        icd10Code: "Icd10Code",
        medicine: "Medicine",
        systemConfig: "SystemConfig",
      };

      const wrapped: Record<string, unknown> = { $extends: mockPrisma.$extends };
      for (const [delegateKey, modelName] of Object.entries(MODEL_NAMES)) {
        const underlying = mockPrisma[delegateKey] as Record<
          string,
          (args: unknown) => Promise<unknown>
        >;
        const proxy: Record<string, unknown> = {};
        for (const op of Object.keys(underlying)) {
          proxy[op] = (args: unknown) =>
            hook({
              model: modelName,
              operation: op,
              args,
              query: (a) => underlying[op](a),
            });
        }
        wrapped[delegateKey] = proxy;
      }
      return wrapped;
    },
  };

  return { mockPrisma, calls };
});

vi.mock("@medcore/db", () => ({ prisma: mockPrisma }));

// Import AFTER the mock is registered so the module sees our fake prisma.
import {
  tenantScopedPrisma,
  TENANT_SCOPED_MODELS,
  shouldScope,
  applyTenantScope,
} from "./tenant-prisma";
import { runWithTenant } from "./tenant-context";

beforeEach(() => {
  calls.length = 0;
});

// ── Pure unit tests ─────────────────────────────────────────────────────────

describe("shouldScope", () => {
  it("returns true for every tenant-scoped model on a standard read op", () => {
    for (const model of TENANT_SCOPED_MODELS) {
      expect(shouldScope(model, "findMany")).toBe(true);
    }
  });

  it("returns false for non-tenant-scoped models (catalogs, system config)", () => {
    expect(shouldScope("Icd10Code", "findMany")).toBe(false);
    expect(shouldScope("Medicine", "findMany")).toBe(false);
    expect(shouldScope("SystemConfig", "create")).toBe(false);
  });

  it("returns false for undefined model (raw queries, $runCommandRaw, …)", () => {
    expect(shouldScope(undefined, "findMany")).toBe(false);
  });

  it("returns false for unsupported operations", () => {
    expect(shouldScope("Patient", "executeRaw")).toBe(false);
  });
});

describe("applyTenantScope", () => {
  it("injects tenantId into args.where for findMany", () => {
    const out = applyTenantScope({ where: { isActive: true } }, "findMany", "t1");
    expect(out).toEqual({ where: { isActive: true, tenantId: "t1" } });
  });

  it("creates args.where when caller passes none", () => {
    const out = applyTenantScope({}, "findMany", "t1");
    expect(out).toEqual({ where: { tenantId: "t1" } });
  });

  it("injects tenantId into args.data for create", () => {
    const out = applyTenantScope(
      { data: { name: "Alice" } },
      "create",
      "t1",
    );
    expect(out).toEqual({ data: { name: "Alice", tenantId: "t1" } });
  });

  it("injects tenantId into every row for createMany", () => {
    const out = applyTenantScope(
      { data: [{ name: "A" }, { name: "B" }] },
      "createMany",
      "t1",
    );
    expect(out).toEqual({
      data: [
        { name: "A", tenantId: "t1" },
        { name: "B", tenantId: "t1" },
      ],
    });
  });

  it("injects into both where and create for upsert", () => {
    const out = applyTenantScope(
      {
        where: { id: "p1" },
        create: { name: "Alice" },
        update: { name: "Bob" },
      },
      "upsert",
      "t1",
    );
    expect((out as any).where).toEqual({ id: "p1", tenantId: "t1" });
    expect((out as any).create).toEqual({ name: "Alice", tenantId: "t1" });
    // `update` is deliberately not tagged — tenantId isn't in the patch set.
    expect((out as any).update).toEqual({ name: "Bob" });
  });

  it("does not mutate caller-provided args", () => {
    const input = { where: { isActive: true } };
    applyTenantScope(input, "findMany", "t1");
    expect(input).toEqual({ where: { isActive: true } });
  });
});

// ── Integration-style tests on the extended client ──────────────────────────

describe("tenantScopedPrisma auto-injection", () => {
  it("injects tenantId on create when context is set", async () => {
    await runWithTenant("t1", async () => {
      await (tenantScopedPrisma as any).patient.create({
        data: { mrNumber: "MR-1", userId: "u1", gender: "MALE" },
      });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("Patient");
    expect(calls[0].operation).toBe("create");
    expect((calls[0].args as any).data.tenantId).toBe("t1");
  });

  it("auto-filters findMany by current tenant", async () => {
    await runWithTenant("t1", async () => {
      await (tenantScopedPrisma as any).patient.findMany({
        where: { mrNumber: "MR-1" },
      });
    });
    expect(calls).toHaveLength(1);
    expect((calls[0].args as any).where).toEqual({
      mrNumber: "MR-1",
      tenantId: "t1",
    });
  });

  it("cross-tenant read: findMany from tenant A cannot see tenant B's filter", async () => {
    // Call under tenant A. The args that reach the underlying prisma must
    // carry tenantId=A — so a tenant-A request will return zero rows from
    // the real DB for a tenant-B record, regardless of any `where` clause
    // the caller tries to set. We assert that even if the caller forges a
    // tenantId in their `where`, the extension OVERWRITES it with the
    // context value.
    await runWithTenant("A", async () => {
      await (tenantScopedPrisma as any).patient.findMany({
        where: { tenantId: "B", mrNumber: "MR-B" },
      });
    });
    expect((calls[0].args as any).where.tenantId).toBe("A");
    // mrNumber survives
    expect((calls[0].args as any).where.mrNumber).toBe("MR-B");
  });

  it("cross-tenant update affects 0 rows (filter forces tenant scope)", async () => {
    await runWithTenant("A", async () => {
      await (tenantScopedPrisma as any).appointment.updateMany({
        where: { id: "apt-owned-by-B" },
        data: { notes: "hijack" },
      });
    });
    expect(calls[0].operation).toBe("updateMany");
    expect((calls[0].args as any).where).toEqual({
      id: "apt-owned-by-B",
      tenantId: "A",
    });
  });

  it("admin console (no tenant context) sees everything — pass-through", async () => {
    // NOT wrapped in runWithTenant → getTenantId() returns undefined.
    await (tenantScopedPrisma as any).patient.findMany({
      where: { mrNumber: "MR-1" },
    });
    expect(calls).toHaveLength(1);
    expect((calls[0].args as any).where).toEqual({ mrNumber: "MR-1" });
    expect((calls[0].args as any).where.tenantId).toBeUndefined();
  });

  it("non-tenant-scoped models (Icd10Code) are not filtered", async () => {
    await runWithTenant("t1", async () => {
      await (tenantScopedPrisma as any).icd10Code.findMany({
        where: { code: "J45" },
      });
    });
    expect(calls).toHaveLength(1);
    expect((calls[0].args as any).where).toEqual({ code: "J45" });
    expect((calls[0].args as any).where.tenantId).toBeUndefined();
  });

  it("non-tenant-scoped models pass create through without tenantId", async () => {
    await runWithTenant("t1", async () => {
      await (tenantScopedPrisma as any).medicine.create({
        data: { name: "Paracetamol" },
      });
    });
    expect(calls).toHaveLength(1);
    expect((calls[0].args as any).data).toEqual({ name: "Paracetamol" });
    expect((calls[0].args as any).data.tenantId).toBeUndefined();
  });

  it("tenant A and tenant B see different filters on sequential reads", async () => {
    await runWithTenant("A", async () => {
      await (tenantScopedPrisma as any).invoice.findMany();
    });
    await runWithTenant("B", async () => {
      await (tenantScopedPrisma as any).invoice.findMany();
    });
    expect(calls).toHaveLength(2);
    expect((calls[0].args as any).where.tenantId).toBe("A");
    expect((calls[1].args as any).where.tenantId).toBe("B");
  });

  it("TENANT_SCOPED_MODELS contains all 57 documented models (20 foundation + 37 extended)", () => {
    expect(TENANT_SCOPED_MODELS.size).toBe(57);
    // Foundation models (20, from 20260423000004_tenant_foundation):
    expect(TENANT_SCOPED_MODELS.has("Patient")).toBe(true);
    expect(TENANT_SCOPED_MODELS.has("Notification")).toBe(true);
    expect(TENANT_SCOPED_MODELS.has("EmergencyCase")).toBe(true);
    // Extended models (37, from 20260423000005_tenant_scope_extended):
    expect(TENANT_SCOPED_MODELS.has("PatientAllergy")).toBe(true);
    expect(TENANT_SCOPED_MODELS.has("AIScribeSession")).toBe(true);
    expect(TENANT_SCOPED_MODELS.has("AITriageSession")).toBe(true);
    expect(TENANT_SCOPED_MODELS.has("ChatMessage")).toBe(true);
    expect(TENANT_SCOPED_MODELS.has("Holiday")).toBe(true);
    // Non-scoped catalogs stay out:
    expect(TENANT_SCOPED_MODELS.has("Icd10Code")).toBe(false);
  });
});
