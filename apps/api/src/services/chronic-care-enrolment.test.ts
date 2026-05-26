// Unit tests for the chronic-care auto-enrolment service —
// `services/chronic-care-enrolment.ts` (Pearl §5.2 gap rows 142-145).
//
// What / which modules / why:
//   - `evaluateCohortRule(rule, tenantId?)` — pure read: returns patient
//     IDs matching a saved cohort-rule blob, optionally scoped by tenant.
//   - `autoEnrolAndRemove()` — cron loop: per active cohort with a
//     non-null `cohortRule`, materialise new ChronicCarePlan rows for
//     newly-matching patients, re-activate previously auto-removed plans
//     when patients re-match, and deactivate plans whose patients have
//     left the cohort. Idempotent.
//
// Prisma is mocked at the import boundary (`@medcore/db`) via vi.hoisted
// — same pattern as `chronic-care-scheduler.test.ts`. The audience
// compiler is also stubbed so we control the compiled `where` shape
// without recreating its DSL semantics (that has its own test file).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, compileAudienceMock } = vi.hoisted(() => ({
  prismaMock: {
    patient: { findMany: vi.fn() },
    chronicCareCohort: { findMany: vi.fn() },
    chronicCarePlan: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
  compileAudienceMock: vi.fn(),
}));

vi.mock("@medcore/db", () => ({
  prisma: prismaMock,
  tenantScopedPrisma: prismaMock,
  getTenantId: () => undefined,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => {
    throw new Error("tenant ctx required");
  },
}));

vi.mock("./audience-compiler", () => ({
  compileAudience: compileAudienceMock,
}));

import {
  evaluateCohortRule,
  autoEnrolAndRemove,
} from "./chronic-care-enrolment";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  compileAudienceMock.mockReturnValue({});
  // Safe defaults that individual tests can override.
  prismaMock.patient.findMany.mockResolvedValue([]);
  prismaMock.chronicCareCohort.findMany.mockResolvedValue([]);
  prismaMock.chronicCarePlan.findMany.mockResolvedValue([]);
  prismaMock.chronicCarePlan.create.mockResolvedValue({ id: "plan-new" });
  prismaMock.chronicCarePlan.update.mockResolvedValue({ id: "plan-upd" });
});

describe("evaluateCohortRule", () => {
  it("returns an empty array when the rule is null", async () => {
    const out = await evaluateCohortRule(null);
    expect(out).toEqual([]);
    expect(compileAudienceMock).not.toHaveBeenCalled();
    expect(prismaMock.patient.findMany).not.toHaveBeenCalled();
  });

  it("returns an empty array when the rule is undefined", async () => {
    const out = await evaluateCohortRule(undefined);
    expect(out).toEqual([]);
    expect(prismaMock.patient.findMany).not.toHaveBeenCalled();
  });

  it("passes the rule blob through to compileAudience and returns the matched IDs", async () => {
    const rule = { matchMode: "ALL", filters: [] } as never;
    compileAudienceMock.mockReturnValue({ gender: "FEMALE" });
    prismaMock.patient.findMany.mockResolvedValue([
      { id: "p1" },
      { id: "p2" },
    ]);
    const out = await evaluateCohortRule(rule);
    expect(compileAudienceMock).toHaveBeenCalledWith(rule);
    expect(out).toEqual(["p1", "p2"]);
  });

  it("does NOT scope by tenant when tenantId is null (default)", async () => {
    compileAudienceMock.mockReturnValue({ gender: "FEMALE" });
    await evaluateCohortRule({ matchMode: "ALL", filters: [] } as never);
    expect(prismaMock.patient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { gender: "FEMALE" } }),
    );
  });

  it("AND-scopes the where by tenantId when supplied", async () => {
    compileAudienceMock.mockReturnValue({ gender: "FEMALE" });
    await evaluateCohortRule(
      { matchMode: "ALL", filters: [] } as never,
      "tenant-42",
    );
    expect(prismaMock.patient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ tenantId: "tenant-42" }, { gender: "FEMALE" }] },
      }),
    );
  });

  it("uses a 5000-row safety cap and selects only id", async () => {
    await evaluateCohortRule({ matchMode: "ALL", filters: [] } as never);
    expect(prismaMock.patient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true }, take: 5000 }),
    );
  });
});

describe("autoEnrolAndRemove — early exit", () => {
  it("returns all-zero summary when there are no active cohorts", async () => {
    prismaMock.chronicCareCohort.findMany.mockResolvedValue([]);
    const result = await autoEnrolAndRemove();
    expect(result).toEqual({
      cohortsEvaluated: 0,
      enrolled: 0,
      removed: 0,
      errors: 0,
    });
    expect(prismaMock.chronicCarePlan.create).not.toHaveBeenCalled();
    expect(prismaMock.chronicCarePlan.update).not.toHaveBeenCalled();
  });

  it("scopes the cohort query to active=true AND non-null cohortRule", async () => {
    await autoEnrolAndRemove();
    expect(prismaMock.chronicCareCohort.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ active: true }),
      }),
    );
    const args = prismaMock.chronicCareCohort.findMany.mock.calls[0][0];
    // The NOT clause excludes cohorts with cohortRule == null
    expect(args.where.NOT).toBeDefined();
  });
});

describe("autoEnrolAndRemove — new enrolments", () => {
  it("creates a ChronicCarePlan for each newly-matching patient", async () => {
    prismaMock.chronicCareCohort.findMany.mockResolvedValue([
      {
        id: "cohort-1",
        condition: "DIABETES",
        cohortRule: { matchMode: "ALL", filters: [] },
        tenantId: "tenant-1",
        createdBy: "user-doc",
      },
    ]);
    prismaMock.patient.findMany.mockResolvedValue([
      { id: "p1" },
      { id: "p2" },
    ]);
    prismaMock.chronicCarePlan.findMany.mockResolvedValue([]); // no existing plans

    const result = await autoEnrolAndRemove();
    expect(result).toEqual({
      cohortsEvaluated: 1,
      enrolled: 2,
      removed: 0,
      errors: 0,
    });
    expect(prismaMock.chronicCarePlan.create).toHaveBeenCalledTimes(2);
    expect(prismaMock.chronicCarePlan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        patientId: "p1",
        condition: "DIABETES",
        cohortId: "cohort-1",
        createdBy: "user-doc",
        tenantId: "tenant-1",
        active: true,
      }),
    });
  });

  it("defaults condition to 'OTHER' when the cohort has no condition", async () => {
    prismaMock.chronicCareCohort.findMany.mockResolvedValue([
      {
        id: "cohort-x",
        condition: null,
        cohortRule: { matchMode: "ALL", filters: [] },
        tenantId: null,
        createdBy: "user-doc",
      },
    ]);
    prismaMock.patient.findMany.mockResolvedValue([{ id: "p1" }]);

    await autoEnrolAndRemove();
    expect(prismaMock.chronicCarePlan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        patientId: "p1",
        condition: "OTHER",
        tenantId: null,
      }),
    });
  });

  it("does NOT create a new plan when the patient already has an active plan (dedupe)", async () => {
    prismaMock.chronicCareCohort.findMany.mockResolvedValue([
      {
        id: "cohort-1",
        condition: "DIABETES",
        cohortRule: { matchMode: "ALL", filters: [] },
        tenantId: "tenant-1",
        createdBy: "user-doc",
      },
    ]);
    prismaMock.patient.findMany.mockResolvedValue([{ id: "p1" }]);
    prismaMock.chronicCarePlan.findMany.mockResolvedValue([
      { id: "existing-1", patientId: "p1", active: true },
    ]);

    const result = await autoEnrolAndRemove();
    expect(result.enrolled).toBe(0);
    expect(result.removed).toBe(0);
    expect(prismaMock.chronicCarePlan.create).not.toHaveBeenCalled();
    expect(prismaMock.chronicCarePlan.update).not.toHaveBeenCalled();
  });
});

describe("autoEnrolAndRemove — re-activation", () => {
  it("re-activates a previously auto-removed plan when the patient matches again", async () => {
    prismaMock.chronicCareCohort.findMany.mockResolvedValue([
      {
        id: "cohort-1",
        condition: "DIABETES",
        cohortRule: { matchMode: "ALL", filters: [] },
        tenantId: "tenant-1",
        createdBy: "user-doc",
      },
    ]);
    prismaMock.patient.findMany.mockResolvedValue([{ id: "p1" }]);
    prismaMock.chronicCarePlan.findMany.mockResolvedValue([
      { id: "plan-1", patientId: "p1", active: false },
    ]);

    const result = await autoEnrolAndRemove();
    expect(result.enrolled).toBe(1);
    expect(result.removed).toBe(0);
    expect(prismaMock.chronicCarePlan.create).not.toHaveBeenCalled();
    expect(prismaMock.chronicCarePlan.update).toHaveBeenCalledWith({
      where: { id: "plan-1" },
      data: { active: true },
    });
  });
});

describe("autoEnrolAndRemove — auto-removal", () => {
  it("deactivates active plans whose patients no longer match the cohort", async () => {
    prismaMock.chronicCareCohort.findMany.mockResolvedValue([
      {
        id: "cohort-1",
        condition: "DIABETES",
        cohortRule: { matchMode: "ALL", filters: [] },
        tenantId: "tenant-1",
        createdBy: "user-doc",
      },
    ]);
    prismaMock.patient.findMany.mockResolvedValue([]); // nobody matches anymore
    prismaMock.chronicCarePlan.findMany.mockResolvedValue([
      { id: "plan-1", patientId: "p1", active: true },
      { id: "plan-2", patientId: "p2", active: true },
    ]);

    const result = await autoEnrolAndRemove();
    expect(result.enrolled).toBe(0);
    expect(result.removed).toBe(2);
    expect(prismaMock.chronicCarePlan.update).toHaveBeenCalledWith({
      where: { id: "plan-1" },
      data: { active: false },
    });
    expect(prismaMock.chronicCarePlan.update).toHaveBeenCalledWith({
      where: { id: "plan-2" },
      data: { active: false },
    });
  });

  it("does NOT re-deactivate plans that are already inactive (no double work)", async () => {
    prismaMock.chronicCareCohort.findMany.mockResolvedValue([
      {
        id: "cohort-1",
        condition: "DIABETES",
        cohortRule: { matchMode: "ALL", filters: [] },
        tenantId: "tenant-1",
        createdBy: "user-doc",
      },
    ]);
    prismaMock.patient.findMany.mockResolvedValue([]);
    prismaMock.chronicCarePlan.findMany.mockResolvedValue([
      { id: "plan-1", patientId: "p1", active: false }, // already inactive
    ]);

    const result = await autoEnrolAndRemove();
    expect(result.removed).toBe(0);
    expect(prismaMock.chronicCarePlan.update).not.toHaveBeenCalled();
  });

  it("uses cohortId to scope the existing-plan lookup (never touches manual plans)", async () => {
    prismaMock.chronicCareCohort.findMany.mockResolvedValue([
      {
        id: "cohort-A",
        condition: "DIABETES",
        cohortRule: { matchMode: "ALL", filters: [] },
        tenantId: "tenant-1",
        createdBy: "user-doc",
      },
    ]);
    prismaMock.patient.findMany.mockResolvedValue([]);
    await autoEnrolAndRemove();
    expect(prismaMock.chronicCarePlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cohortId: "cohort-A" },
      }),
    );
  });
});

describe("autoEnrolAndRemove — mixed deltas", () => {
  it("enrols new, re-activates dormant, and removes departed in one pass", async () => {
    prismaMock.chronicCareCohort.findMany.mockResolvedValue([
      {
        id: "cohort-1",
        condition: "HYPERTENSION",
        cohortRule: { matchMode: "ALL", filters: [] },
        tenantId: "tenant-1",
        createdBy: "user-doc",
      },
    ]);
    // p-new = new enrolment, p-back = re-activate, (p-gone is gone)
    prismaMock.patient.findMany.mockResolvedValue([
      { id: "p-new" },
      { id: "p-back" },
    ]);
    prismaMock.chronicCarePlan.findMany.mockResolvedValue([
      { id: "plan-back", patientId: "p-back", active: false },
      { id: "plan-gone", patientId: "p-gone", active: true },
    ]);

    const result = await autoEnrolAndRemove();
    expect(result).toEqual({
      cohortsEvaluated: 1,
      enrolled: 2,
      removed: 1,
      errors: 0,
    });
    expect(prismaMock.chronicCarePlan.create).toHaveBeenCalledTimes(1);
    // Two updates: re-activate p-back, deactivate p-gone
    expect(prismaMock.chronicCarePlan.update).toHaveBeenCalledTimes(2);
  });

  it("is idempotent — a re-run with identical state produces zero deltas", async () => {
    prismaMock.chronicCareCohort.findMany.mockResolvedValue([
      {
        id: "cohort-1",
        condition: "DIABETES",
        cohortRule: { matchMode: "ALL", filters: [] },
        tenantId: "tenant-1",
        createdBy: "user-doc",
      },
    ]);
    prismaMock.patient.findMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    prismaMock.chronicCarePlan.findMany.mockResolvedValue([
      { id: "plan-1", patientId: "p1", active: true },
      { id: "plan-2", patientId: "p2", active: true },
    ]);

    const result = await autoEnrolAndRemove();
    expect(result).toEqual({
      cohortsEvaluated: 1,
      enrolled: 0,
      removed: 0,
      errors: 0,
    });
    expect(prismaMock.chronicCarePlan.create).not.toHaveBeenCalled();
    expect(prismaMock.chronicCarePlan.update).not.toHaveBeenCalled();
  });
});

describe("autoEnrolAndRemove — multi-cohort isolation", () => {
  it("evaluates every active cohort and aggregates the counters", async () => {
    prismaMock.chronicCareCohort.findMany.mockResolvedValue([
      {
        id: "cohort-A",
        condition: "DIABETES",
        cohortRule: { matchMode: "ALL", filters: [] },
        tenantId: "tenant-1",
        createdBy: "user-doc",
      },
      {
        id: "cohort-B",
        condition: "HYPERTENSION",
        cohortRule: { matchMode: "ALL", filters: [] },
        tenantId: "tenant-1",
        createdBy: "user-doc",
      },
    ]);
    // cohort-A → 1 new, cohort-B → 1 removed
    prismaMock.patient.findMany
      .mockResolvedValueOnce([{ id: "p1" }])
      .mockResolvedValueOnce([]);
    prismaMock.chronicCarePlan.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "plan-old", patientId: "px", active: true },
      ]);

    const result = await autoEnrolAndRemove();
    expect(result.cohortsEvaluated).toBe(2);
    expect(result.enrolled).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.errors).toBe(0);
  });
});

describe("autoEnrolAndRemove — error resilience", () => {
  it("counts a per-plan create() failure as an error but keeps going", async () => {
    prismaMock.chronicCareCohort.findMany.mockResolvedValue([
      {
        id: "cohort-1",
        condition: "DIABETES",
        cohortRule: { matchMode: "ALL", filters: [] },
        tenantId: "tenant-1",
        createdBy: "user-doc",
      },
    ]);
    prismaMock.patient.findMany.mockResolvedValue([
      { id: "p1" },
      { id: "p2" },
    ]);
    prismaMock.chronicCarePlan.findMany.mockResolvedValue([]);
    // First create throws, second succeeds — loop must isolate the failure.
    prismaMock.chronicCarePlan.create
      .mockRejectedValueOnce(new Error("DB write blew up"))
      .mockResolvedValueOnce({ id: "plan-2" });

    const result = await autoEnrolAndRemove();
    expect(result.enrolled).toBe(1);
    expect(result.errors).toBe(1);
    expect(prismaMock.chronicCarePlan.create).toHaveBeenCalledTimes(2);
  });

  it("counts a re-activate update() failure as an error but keeps going", async () => {
    prismaMock.chronicCareCohort.findMany.mockResolvedValue([
      {
        id: "cohort-1",
        condition: "DIABETES",
        cohortRule: { matchMode: "ALL", filters: [] },
        tenantId: "tenant-1",
        createdBy: "user-doc",
      },
    ]);
    prismaMock.patient.findMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    prismaMock.chronicCarePlan.findMany.mockResolvedValue([
      { id: "plan-bad", patientId: "p1", active: false },
      { id: "plan-ok", patientId: "p2", active: false },
    ]);
    prismaMock.chronicCarePlan.update
      .mockRejectedValueOnce(new Error("update bombed"))
      .mockResolvedValueOnce({ id: "plan-ok" });

    const result = await autoEnrolAndRemove();
    expect(result.enrolled).toBe(1);
    expect(result.errors).toBe(1);
  });

  it("counts a remove update() failure as an error but keeps going", async () => {
    prismaMock.chronicCareCohort.findMany.mockResolvedValue([
      {
        id: "cohort-1",
        condition: "DIABETES",
        cohortRule: { matchMode: "ALL", filters: [] },
        tenantId: "tenant-1",
        createdBy: "user-doc",
      },
    ]);
    prismaMock.patient.findMany.mockResolvedValue([]);
    prismaMock.chronicCarePlan.findMany.mockResolvedValue([
      { id: "plan-a", patientId: "pa", active: true },
      { id: "plan-b", patientId: "pb", active: true },
    ]);
    prismaMock.chronicCarePlan.update
      .mockRejectedValueOnce(new Error("remove bombed"))
      .mockResolvedValueOnce({ id: "plan-b" });

    const result = await autoEnrolAndRemove();
    expect(result.removed).toBe(1);
    expect(result.errors).toBe(1);
  });

  it("counts a per-cohort eval failure (compileAudience throws) as an error and continues to the next cohort", async () => {
    prismaMock.chronicCareCohort.findMany.mockResolvedValue([
      {
        id: "cohort-A",
        condition: "DIABETES",
        cohortRule: { matchMode: "ALL", filters: [] },
        tenantId: "tenant-1",
        createdBy: "user-doc",
      },
      {
        id: "cohort-B",
        condition: "HYPERTENSION",
        cohortRule: { matchMode: "ALL", filters: [] },
        tenantId: "tenant-1",
        createdBy: "user-doc",
      },
    ]);
    compileAudienceMock
      .mockImplementationOnce(() => {
        throw new Error("malformed rule");
      })
      .mockReturnValueOnce({});
    prismaMock.patient.findMany.mockResolvedValueOnce([{ id: "p1" }]);
    prismaMock.chronicCarePlan.findMany.mockResolvedValueOnce([]);

    const result = await autoEnrolAndRemove();
    expect(result.cohortsEvaluated).toBe(2);
    expect(result.errors).toBe(1); // first cohort failed
    expect(result.enrolled).toBe(1); // second cohort succeeded
  });
});

describe("autoEnrolAndRemove — tenant scoping", () => {
  it("passes the cohort's tenantId through to evaluateCohortRule (via compileAudience+findMany)", async () => {
    prismaMock.chronicCareCohort.findMany.mockResolvedValue([
      {
        id: "cohort-T",
        condition: "DIABETES",
        cohortRule: { matchMode: "ALL", filters: [] },
        tenantId: "tenant-99",
        createdBy: "user-doc",
      },
    ]);
    compileAudienceMock.mockReturnValue({ gender: "MALE" });
    await autoEnrolAndRemove();
    expect(prismaMock.patient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ tenantId: "tenant-99" }, { gender: "MALE" }] },
      }),
    );
  });

  it("treats a null cohort.tenantId as unscoped (cross-tenant) — no AND wrapper", async () => {
    prismaMock.chronicCareCohort.findMany.mockResolvedValue([
      {
        id: "cohort-T",
        condition: "DIABETES",
        cohortRule: { matchMode: "ALL", filters: [] },
        tenantId: null,
        createdBy: "user-doc",
      },
    ]);
    compileAudienceMock.mockReturnValue({ gender: "MALE" });
    await autoEnrolAndRemove();
    expect(prismaMock.patient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { gender: "MALE" } }),
    );
  });
});
