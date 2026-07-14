/**
 * PM-JAY services — beneficiary + package (simulation mode) unit tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: `beneficiary.service` (verify persists eligibility + a history row;
 *   ELIGIBLE vs NOT_ELIGIBLE sim rule; the getEligibleBeneficiary claim-gate
 *   read) and `package.service` (sync writes the sim master, then SKIPS on an
 *   unchanged checksum — refinement #3).
 * - MODULES: mocks `@medcore/db` (tenantScopedPrisma + runWithTenant). Config is
 *   real, driven into simulation by clearing TPA_PMJAY_* env.
 * - WHY: eligibility persistence is what the claim route gates on, and the
 *   checksum short-circuit is the guard against re-downloading the whole master.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    pmjayBeneficiary: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "ben-new" })),
      update: vi.fn(async (a: any) => ({ id: a.where.id })),
      count: vi.fn(async () => 0),
    },
    pmjayVerificationHistory: { create: vi.fn(async () => ({ id: "hist-1" })) },
    pmjayPackage: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({
  tenantScopedPrisma: prismaMock,
  prisma: prismaMock,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  // config.ts reads the tenant from ALS; undefined here → simulation fallback.
  getTenantId: () => undefined,
}));

import { verifyBeneficiary, getEligibleBeneficiary } from "./beneficiary.service";
import { syncPackages } from "./package.service";

const ENV = ["TPA_PMJAY_BASE_URL", "TPA_PMJAY_AUTH_URL", "TPA_PMJAY_CLIENT_ID", "TPA_PMJAY_CLIENT_SECRET", "TPA_PMJAY_HOSPITAL_ID", "TPA_PMJAY_SIMULATION", "TPA_PMJAY_ENABLED"];

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV) delete process.env[k]; // creds absent ⇒ simulation
  prismaMock.pmjayBeneficiary.findFirst.mockResolvedValue(null);
  prismaMock.pmjayBeneficiary.create.mockResolvedValue({ id: "ben-new" });
  prismaMock.pmjayPackage.findFirst.mockResolvedValue(null);
});

describe("verifyBeneficiary (simulation)", () => {
  it("marks a normal card ELIGIBLE, persists the beneficiary + a history row", async () => {
    const r = await verifyBeneficiary({ patientId: "p-1", ayushmanCardNumber: "PMJAY-CARD-9", checkedBy: "u-1" });
    expect(r.eligibilityStatus).toBe("ELIGIBLE");
    expect(r.beneficiaryId).toMatch(/^BEN/);
    expect(prismaMock.pmjayBeneficiary.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ patientId: "p-1", eligibilityStatus: "ELIGIBLE" }),
      })
    );
    expect(prismaMock.pmjayVerificationHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ patientId: "p-1", eligibilityStatus: "ELIGIBLE", checkedBy: "u-1" }),
      })
    );
  });

  it("marks a DENY card NOT_ELIGIBLE with null beneficiary/family ids", async () => {
    const r = await verifyBeneficiary({ patientId: "p-2", ayushmanCardNumber: "DENY-0001", checkedBy: null });
    expect(r.eligibilityStatus).toBe("NOT_ELIGIBLE");
    expect(r.beneficiaryId).toBeNull();
    expect(r.familyId).toBeNull();
  });

  it("updates the existing beneficiary row instead of creating a duplicate", async () => {
    prismaMock.pmjayBeneficiary.findFirst.mockResolvedValue({ id: "ben-existing" });
    await verifyBeneficiary({ patientId: "p-3", ayushmanCardNumber: "PMJAY-CARD-3" });
    expect(prismaMock.pmjayBeneficiary.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ben-existing" } })
    );
    expect(prismaMock.pmjayBeneficiary.create).not.toHaveBeenCalled();
  });
});

describe("getEligibleBeneficiary", () => {
  it("returns the patient's ELIGIBLE beneficiary row when present", async () => {
    prismaMock.pmjayBeneficiary.findFirst.mockResolvedValue({ id: "ben-9", ayushmanCardNumber: "C", beneficiaryId: "B" });
    const r = await getEligibleBeneficiary("p-1");
    expect(r?.id).toBe("ben-9");
    expect(prismaMock.pmjayBeneficiary.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { patientId: "p-1", eligibilityStatus: "ELIGIBLE" } })
    );
  });

  it("returns null when the patient has no eligible beneficiary", async () => {
    prismaMock.pmjayBeneficiary.findFirst.mockResolvedValue(null);
    expect(await getEligibleBeneficiary("p-x")).toBeNull();
  });
});

describe("syncPackages (simulation)", () => {
  it("writes the simulated master on first sync", async () => {
    prismaMock.pmjayPackage.findFirst.mockImplementation(async (args: any) =>
      args?.orderBy ? null : null
    );
    const r = await syncPackages();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.skipped).toBe(false);
      expect(r.result.synced).toBeGreaterThan(0);
    }
    expect(prismaMock.pmjayPackage.create).toHaveBeenCalled();
  });

  it("SKIPS when the stored checksum already matches (no writes)", async () => {
    // First run to learn the checksum.
    prismaMock.pmjayPackage.findFirst.mockResolvedValue(null);
    const first = await syncPackages();
    const checksum = first.ok ? first.result.checksum : "";
    vi.clearAllMocks();
    // Now the checksum-latest lookup returns the same checksum.
    prismaMock.pmjayPackage.findFirst.mockImplementation(async (args: any) =>
      args?.orderBy ? { checksum } : { id: "pkg-x" }
    );
    const second = await syncPackages();
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.result.skipped).toBe(true);
    expect(prismaMock.pmjayPackage.create).not.toHaveBeenCalled();
    expect(prismaMock.pmjayPackage.update).not.toHaveBeenCalled();
  });
});
