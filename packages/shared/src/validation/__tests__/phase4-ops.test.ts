import { describe, it, expect } from "vitest";
import {
  createDonorSchema,
  createDonationSchema,
  approveDonationSchema,
  createBloodUnitSchema,
  bloodRequestSchema,
  issueBloodSchema,
  crossMatchSchema,
  createAmbulanceSchema,
  tripRequestSchema,
  updateTripStatusSchema,
  completeTripSchema,
  createAssetSchema,
  maintenanceLogSchema,
  donorDeferralSchema,
  componentSeparationSchema,
} from "../phase4-ops";

const UUID = "11111111-1111-1111-1111-111111111111";

// Adult-but-not-too-old DOB so the donor age refinement (17-65) passes.
const VALID_DOB = "1990-05-01";

describe("createDonorSchema", () => {
  const valid = {
    name: "Asha Patel",
    phone: "9876543210",
    bloodGroup: "O_POS" as const,
    gender: "FEMALE" as const,
    weight: 60,
    dateOfBirth: VALID_DOB,
  };
  it("accepts a valid donor", () => {
    expect(createDonorSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects unknown blood group", () => {
    expect(
      createDonorSchema.safeParse({ ...valid, bloodGroup: "Q_POS" as any }).success
    ).toBe(false);
  });
  it("rejects weight < 50 kg", () => {
    expect(createDonorSchema.safeParse({ ...valid, weight: 40 }).success).toBe(false);
  });
  it("rejects future dateOfBirth", () => {
    expect(
      createDonorSchema.safeParse({ ...valid, dateOfBirth: "2099-01-01" }).success
    ).toBe(false);
  });
  it("rejects donor under 17 (Issue #428)", () => {
    expect(
      createDonorSchema.safeParse({ ...valid, dateOfBirth: "2020-01-01" }).success
    ).toBe(false);
  });
});

describe("createDonationSchema", () => {
  it("accepts donation with default volume", () => {
    expect(createDonationSchema.safeParse({ donorId: UUID }).success).toBe(true);
  });
  it("rejects non-positive volumeMl", () => {
    expect(
      createDonationSchema.safeParse({ donorId: UUID, volumeMl: 0 }).success
    ).toBe(false);
  });
});

describe("approveDonationSchema", () => {
  it("accepts approval with components", () => {
    expect(
      approveDonationSchema.safeParse({
        approved: true,
        components: [{ component: "PACKED_RED_CELLS", volumeMl: 250 }],
      }).success
    ).toBe(true);
  });
  it("rejects unknown component", () => {
    expect(
      approveDonationSchema.safeParse({
        approved: true,
        components: [{ component: "GIBBERISH" as any, volumeMl: 250 }],
      }).success
    ).toBe(false);
  });
});

describe("createBloodUnitSchema", () => {
  const valid = {
    bloodGroup: "A_POS" as const,
    component: "WHOLE_BLOOD" as const,
    volumeMl: 450,
    collectedAt: "2026-04-01T10:00:00.000Z",
    expiresAt: "2026-05-15T10:00:00.000Z",
  };
  it("accepts a valid blood unit", () => {
    expect(createBloodUnitSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects malformed datetime", () => {
    expect(
      createBloodUnitSchema.safeParse({ ...valid, collectedAt: "yesterday" }).success
    ).toBe(false);
  });
});

describe("bloodRequestSchema", () => {
  const valid = {
    patientId: UUID,
    bloodGroup: "B_NEG" as const,
    component: "PLATELETS" as const,
    unitsRequested: 2,
    reason: "Surgery prep",
    urgency: "URGENT" as const,
  };
  it("accepts a valid request", () => {
    expect(bloodRequestSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects unitsRequested < 1", () => {
    expect(bloodRequestSchema.safeParse({ ...valid, unitsRequested: 0 }).success).toBe(false);
  });
  it("rejects unknown urgency", () => {
    expect(
      bloodRequestSchema.safeParse({ ...valid, urgency: "WHENEVER" as any }).success
    ).toBe(false);
  });
});

describe("issueBloodSchema", () => {
  it("accepts valid unit issue", () => {
    expect(issueBloodSchema.safeParse({ unitIds: [UUID] }).success).toBe(true);
  });
  it("rejects empty unitIds", () => {
    expect(issueBloodSchema.safeParse({ unitIds: [] }).success).toBe(false);
  });
  it("rejects clinicalReason shorter than 10 chars (Issue #93)", () => {
    expect(
      issueBloodSchema.safeParse({
        unitIds: [UUID],
        overrideAboMismatch: true,
        clinicalReason: "short",
      }).success
    ).toBe(false);
  });
});

describe("crossMatchSchema", () => {
  it("accepts a valid cross-match", () => {
    expect(
      crossMatchSchema.safeParse({ requestId: UUID, unitId: UUID, compatible: true }).success
    ).toBe(true);
  });
  it("rejects non-boolean compatible", () => {
    expect(
      crossMatchSchema.safeParse({
        requestId: UUID,
        unitId: UUID,
        compatible: "yes" as any,
      }).success
    ).toBe(false);
  });
});

describe("createAmbulanceSchema", () => {
  it("accepts a minimal ambulance", () => {
    expect(
      createAmbulanceSchema.safeParse({ vehicleNumber: "MH12AB1234", type: "BLS" }).success
    ).toBe(true);
  });
  it("rejects gibberish phone (Issue #87)", () => {
    expect(
      createAmbulanceSchema.safeParse({
        vehicleNumber: "MH12AB1234",
        type: "BLS",
        driverPhone: "asdf",
      }).success
    ).toBe(false);
  });
  it("rejects empty vehicleNumber", () => {
    expect(
      createAmbulanceSchema.safeParse({ vehicleNumber: "", type: "BLS" }).success
    ).toBe(false);
  });
});

describe("tripRequestSchema", () => {
  it("accepts a minimal trip request", () => {
    expect(
      tripRequestSchema.safeParse({ ambulanceId: UUID, pickupAddress: "123 Main St" })
        .success
    ).toBe(true);
  });
  it("rejects unknown priority", () => {
    expect(
      tripRequestSchema.safeParse({
        ambulanceId: UUID,
        pickupAddress: "123 Main St",
        priority: "PURPLE" as any,
      }).success
    ).toBe(false);
  });
});

describe("updateTripStatusSchema", () => {
  it("accepts a valid status update", () => {
    expect(
      updateTripStatusSchema.safeParse({ status: "DISPATCHED" }).success
    ).toBe(true);
  });
  it("rejects unknown status", () => {
    expect(
      updateTripStatusSchema.safeParse({ status: "TELEPORTED" as any }).success
    ).toBe(false);
  });
  it("rejects negative distanceKm", () => {
    expect(
      updateTripStatusSchema.safeParse({ status: "EN_ROUTE_HOSPITAL", distanceKm: -1 }).success
    ).toBe(false);
  });
});

describe("completeTripSchema", () => {
  const valid = {
    actualEndTime: "2026-04-30T12:00:00.000Z",
    finalDistance: 12.5,
    finalCost: 800,
    notes: "Routine transfer",
  };
  it("accepts a valid completion (Issue #87)", () => {
    expect(completeTripSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects non-positive finalDistance", () => {
    expect(completeTripSchema.safeParse({ ...valid, finalDistance: 0 }).success).toBe(false);
  });
  it("rejects empty notes", () => {
    expect(completeTripSchema.safeParse({ ...valid, notes: "  " }).success).toBe(false);
  });
});

describe("createAssetSchema", () => {
  it("accepts a minimal asset", () => {
    expect(
      createAssetSchema.safeParse({
        assetTag: "AS-001",
        name: "Defibrillator",
        category: "MEDICAL",
      }).success
    ).toBe(true);
  });
  it("rejects empty category", () => {
    expect(
      createAssetSchema.safeParse({ assetTag: "AS-001", name: "X", category: "" }).success
    ).toBe(false);
  });
});

describe("maintenanceLogSchema", () => {
  it("accepts valid maintenance log", () => {
    expect(
      maintenanceLogSchema.safeParse({
        assetId: UUID,
        type: "SCHEDULED",
        description: "Quarterly calibration",
      }).success
    ).toBe(true);
  });
  it("rejects unknown type", () => {
    expect(
      maintenanceLogSchema.safeParse({
        assetId: UUID,
        type: "MAGIC" as any,
        description: "x",
      }).success
    ).toBe(false);
  });
});

describe("donorDeferralSchema", () => {
  it("accepts a valid deferral", () => {
    expect(
      donorDeferralSchema.safeParse({ reason: "Recent surgery", deferralType: "TEMPORARY" })
        .success
    ).toBe(true);
  });
  it("rejects unknown deferralType", () => {
    expect(
      donorDeferralSchema.safeParse({ reason: "x", deferralType: "FOREVER" as any }).success
    ).toBe(false);
  });
});

describe("componentSeparationSchema", () => {
  it("accepts a valid separation", () => {
    expect(
      componentSeparationSchema.safeParse({
        components: [{ component: "PRBC", unitsProduced: 1 }],
      }).success
    ).toBe(true);
  });
  it("rejects unitsProduced > 10", () => {
    expect(
      componentSeparationSchema.safeParse({
        components: [{ component: "PRBC", unitsProduced: 50 }],
      }).success
    ).toBe(false);
  });
});
