// Coverage tests for clinical validation schemas.
// What: exhaustive happy / invalid / edge cases for every exported Zod schema
//   in packages/shared/src/validation/clinical.ts — referrals (create + update
//   status), OT (create + update), surgeries (schedule + update + complete +
//   cancel), and the OR-phase artefacts (preOpChecklist, intraOpTiming,
//   complications).
// Which modules: imports only schemas from ../clinical.
// Why: file shipped with 0% colocated coverage (141 lines). Critical
//   refinements to lock in: (1) createReferralSchema's "either toDoctorId OR
//   externalProvider" disjunction (lines 20-26) — losing it lets dangling
//   referrals through; (2) scheduleSurgerySchema's "no past times" refine
//   with 5-min clock-skew tolerance (lines 64-67, Issue #86); (3) Issue #53
//   non-negative cost + positive durationMin on both schedule + update paths;
//   (4) commissionPercent 0-100 range on referrals (Pearl §4.1 gap row 101)
//   plus the nullable-on-update extension. Tests are written against parsed
//   output shape, not just success/failure, where defaults are applied
//   (e.g. createOTSchema.dailyRate defaulting to 0).
import { describe, it, expect } from "vitest";
import {
  createReferralSchema,
  updateReferralStatusSchema,
  createOTSchema,
  updateOTSchema,
  scheduleSurgerySchema,
  updateSurgerySchema,
  completeSurgerySchema,
  cancelSurgerySchema,
  preOpChecklistSchema,
  intraOpTimingSchema,
  complicationsSchema,
} from "../clinical";

const UUID = "550e8400-e29b-41d4-a716-446655441111";
const UUID_2 = "550e8400-e29b-41d4-a716-446655442222";
const UUID_3 = "550e8400-e29b-41d4-a716-446655443333";
const UUID_4 = "550e8400-e29b-41d4-a716-446655444444";

// Helper: an ISO-8601 timestamp 1 hour in the future relative to now.
// Keeps scheduleSurgerySchema's past-time refine happy without racing the clock.
const futureIso = (offsetMs = 60 * 60 * 1000) =>
  new Date(Date.now() + offsetMs).toISOString();

// ───────────────────────────────────────────────────────
// createReferralSchema
// ───────────────────────────────────────────────────────

describe("createReferralSchema", () => {
  const validInternal = {
    patientId: UUID,
    fromDoctorId: UUID_2,
    toDoctorId: UUID_3,
    reason: "Cardiology evaluation",
  };
  const validExternal = {
    patientId: UUID,
    fromDoctorId: UUID_2,
    externalProvider: "Apollo Hospitals — Cardiology Dept",
    reason: "Outside-network MRI follow-up",
  };

  it("accepts a minimal internal referral (toDoctorId branch)", () => {
    expect(createReferralSchema.safeParse(validInternal).success).toBe(true);
  });
  it("accepts a minimal external referral (externalProvider branch)", () => {
    expect(createReferralSchema.safeParse(validExternal).success).toBe(true);
  });
  it("accepts a fully-populated internal referral", () => {
    expect(
      createReferralSchema.safeParse({
        ...validInternal,
        externalContact: "+91-98765-43210",
        specialty: "Interventional cardiology",
        notes: "Patient reports chest tightness on exertion",
        commissionPercent: 12.5,
      }).success
    ).toBe(true);
  });
  it("rejects when both toDoctorId and externalProvider are missing (refine branch)", () => {
    const r = createReferralSchema.safeParse({
      patientId: UUID,
      fromDoctorId: UUID_2,
      reason: "Unspecified",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) =>
          /Either toDoctorId or externalProvider is required/.test(i.message)
        )
      ).toBe(true);
      // Refine path is hung on toDoctorId per source line 24
      expect(
        r.error.issues.some((i) => i.path.join(".") === "toDoctorId")
      ).toBe(true);
    }
  });
  it("rejects non-uuid patientId", () => {
    expect(
      createReferralSchema.safeParse({ ...validInternal, patientId: "abc" }).success
    ).toBe(false);
  });
  it("rejects non-uuid fromDoctorId", () => {
    expect(
      createReferralSchema.safeParse({ ...validInternal, fromDoctorId: "abc" }).success
    ).toBe(false);
  });
  it("rejects non-uuid toDoctorId when supplied", () => {
    expect(
      createReferralSchema.safeParse({ ...validInternal, toDoctorId: "not-uuid" }).success
    ).toBe(false);
  });
  it("rejects empty reason (min 1)", () => {
    const r = createReferralSchema.safeParse({ ...validInternal, reason: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /Reason is required/.test(i.message))).toBe(true);
    }
  });
  it("rejects missing reason", () => {
    const { reason: _r, ...rest } = validInternal;
    expect(createReferralSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects commissionPercent below 0", () => {
    expect(
      createReferralSchema.safeParse({ ...validInternal, commissionPercent: -0.01 }).success
    ).toBe(false);
  });
  it("rejects commissionPercent above 100", () => {
    expect(
      createReferralSchema.safeParse({ ...validInternal, commissionPercent: 100.01 }).success
    ).toBe(false);
  });
  it("accepts commissionPercent at 0 (lower boundary)", () => {
    expect(
      createReferralSchema.safeParse({ ...validInternal, commissionPercent: 0 }).success
    ).toBe(true);
  });
  it("accepts commissionPercent at 100 (upper boundary)", () => {
    expect(
      createReferralSchema.safeParse({ ...validInternal, commissionPercent: 100 }).success
    ).toBe(true);
  });
  it("accepts non-integer commissionPercent (e.g. 7.5%)", () => {
    expect(
      createReferralSchema.safeParse({ ...validInternal, commissionPercent: 7.5 }).success
    ).toBe(true);
  });
  it("rejects non-number commissionPercent", () => {
    expect(
      createReferralSchema.safeParse({
        ...validInternal,
        commissionPercent: "12" as any,
      }).success
    ).toBe(false);
  });
  it("accepts BOTH toDoctorId and externalProvider together (refine passes if either present)", () => {
    expect(
      createReferralSchema.safeParse({
        ...validInternal,
        externalProvider: "Backup external provider",
      }).success
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────
// updateReferralStatusSchema
// ───────────────────────────────────────────────────────

describe("updateReferralStatusSchema", () => {
  it("accepts each canonical status", () => {
    for (const s of [
      "PENDING",
      "ACCEPTED",
      "COMPLETED",
      "DECLINED",
      "EXPIRED",
    ] as const) {
      expect(updateReferralStatusSchema.safeParse({ status: s }).success).toBe(true);
    }
  });
  it("rejects unknown status", () => {
    expect(
      updateReferralStatusSchema.safeParse({ status: "REJECTED" as any }).success
    ).toBe(false);
  });
  it("rejects missing status (required)", () => {
    expect(updateReferralStatusSchema.safeParse({}).success).toBe(false);
  });
  it("accepts status + notes", () => {
    expect(
      updateReferralStatusSchema.safeParse({
        status: "ACCEPTED",
        notes: "Cardiology accepted, slot scheduled for 2026-05-30",
      }).success
    ).toBe(true);
  });
  it("accepts status + commissionPercent override", () => {
    expect(
      updateReferralStatusSchema.safeParse({
        status: "ACCEPTED",
        commissionPercent: 15,
      }).success
    ).toBe(true);
  });
  it("accepts commissionPercent explicitly null (clear override)", () => {
    const r = updateReferralStatusSchema.safeParse({
      status: "ACCEPTED",
      commissionPercent: null,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.commissionPercent).toBeNull();
  });
  it("rejects commissionPercent below 0", () => {
    expect(
      updateReferralStatusSchema.safeParse({
        status: "PENDING",
        commissionPercent: -1,
      }).success
    ).toBe(false);
  });
  it("rejects commissionPercent above 100", () => {
    expect(
      updateReferralStatusSchema.safeParse({
        status: "PENDING",
        commissionPercent: 101,
      }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// createOTSchema
// ───────────────────────────────────────────────────────

describe("createOTSchema", () => {
  it("accepts a minimal OT (name only) and stamps dailyRate=0 default", () => {
    const r = createOTSchema.safeParse({ name: "OT-1" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.dailyRate).toBe(0);
      expect(r.data.floor).toBeUndefined();
      expect(r.data.equipment).toBeUndefined();
    }
  });
  it("accepts a fully-populated OT", () => {
    const r = createOTSchema.safeParse({
      name: "OT-Main",
      floor: "3rd floor, East wing",
      equipment: "C-arm, anesthesia workstation, defibrillator",
      dailyRate: 25000,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.dailyRate).toBe(25000);
  });
  it("rejects empty name (min 1)", () => {
    expect(createOTSchema.safeParse({ name: "" }).success).toBe(false);
  });
  it("rejects missing name", () => {
    expect(createOTSchema.safeParse({}).success).toBe(false);
  });
  it("rejects negative dailyRate", () => {
    expect(createOTSchema.safeParse({ name: "OT-1", dailyRate: -1 }).success).toBe(false);
  });
  it("accepts dailyRate=0 (free OT, nonnegative boundary)", () => {
    const r = createOTSchema.safeParse({ name: "OT-1", dailyRate: 0 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.dailyRate).toBe(0);
  });
  it("rejects non-numeric dailyRate", () => {
    expect(
      createOTSchema.safeParse({ name: "OT-1", dailyRate: "free" as any }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// updateOTSchema
// ───────────────────────────────────────────────────────

describe("updateOTSchema", () => {
  it("accepts an empty patch (all fields optional)", () => {
    expect(updateOTSchema.safeParse({}).success).toBe(true);
  });
  it("accepts a name-only patch", () => {
    expect(updateOTSchema.safeParse({ name: "OT-Main (renamed)" }).success).toBe(true);
  });
  it("accepts an isActive=false patch (decommissioning)", () => {
    expect(updateOTSchema.safeParse({ isActive: false }).success).toBe(true);
  });
  it("accepts isActive=true patch (recommissioning)", () => {
    expect(updateOTSchema.safeParse({ isActive: true }).success).toBe(true);
  });
  it("rejects empty name when supplied (min 1 retained)", () => {
    expect(updateOTSchema.safeParse({ name: "" }).success).toBe(false);
  });
  it("rejects negative dailyRate", () => {
    expect(updateOTSchema.safeParse({ dailyRate: -100 }).success).toBe(false);
  });
  it("rejects non-boolean isActive", () => {
    expect(updateOTSchema.safeParse({ isActive: "yes" as any }).success).toBe(false);
  });
  it("accepts a full update", () => {
    expect(
      updateOTSchema.safeParse({
        name: "OT-Main",
        floor: "3rd floor",
        equipment: "Updated equipment list",
        dailyRate: 30000,
        isActive: true,
      }).success
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────
// scheduleSurgerySchema
// ───────────────────────────────────────────────────────

describe("scheduleSurgerySchema", () => {
  const valid = () => ({
    patientId: UUID,
    surgeonId: UUID_2,
    otId: UUID_3,
    procedure: "Laparoscopic cholecystectomy",
    scheduledAt: futureIso(),
  });

  it("accepts a minimal valid surgery (future scheduledAt)", () => {
    expect(scheduleSurgerySchema.safeParse(valid()).success).toBe(true);
  });
  it("accepts a fully-populated surgery", () => {
    expect(
      scheduleSurgerySchema.safeParse({
        ...valid(),
        durationMin: 90,
        anaesthesiologist: "Dr. Mehra",
        assistants: "Dr. Sharma, Dr. Iyer",
        preOpNotes: "NPO since midnight",
        diagnosis: "Acute cholecystitis",
        cost: 75000,
      }).success
    ).toBe(true);
  });
  it("rejects non-uuid patientId", () => {
    expect(
      scheduleSurgerySchema.safeParse({ ...valid(), patientId: "abc" }).success
    ).toBe(false);
  });
  it("rejects non-uuid surgeonId", () => {
    expect(
      scheduleSurgerySchema.safeParse({ ...valid(), surgeonId: "abc" }).success
    ).toBe(false);
  });
  it("rejects non-uuid otId", () => {
    expect(
      scheduleSurgerySchema.safeParse({ ...valid(), otId: "abc" }).success
    ).toBe(false);
  });
  it("rejects empty procedure (min 1)", () => {
    const r = scheduleSurgerySchema.safeParse({ ...valid(), procedure: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /Procedure is required/.test(i.message))).toBe(true);
    }
  });
  it("rejects non-ISO scheduledAt", () => {
    const r = scheduleSurgerySchema.safeParse({
      ...valid(),
      scheduledAt: "tomorrow at 10am",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Scheduled date\/time must be ISO-8601/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects scheduledAt clearly in the past (Issue #86)", () => {
    // 1 hour ago — well past the 5-min clock-skew tolerance.
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const r = scheduleSurgerySchema.safeParse({ ...valid(), scheduledAt: past });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) =>
          /Scheduled date\/time cannot be in the past/.test(i.message)
        )
      ).toBe(true);
    }
  });
  it("accepts scheduledAt at 'now' (within the 5-min clock-skew tolerance)", () => {
    // 30 seconds in the past — inside the 5-min tolerance.
    const nowish = new Date(Date.now() - 30 * 1000).toISOString();
    expect(
      scheduleSurgerySchema.safeParse({ ...valid(), scheduledAt: nowish }).success
    ).toBe(true);
  });
  it("rejects scheduledAt just OUTSIDE the 5-min tolerance window", () => {
    // 6 minutes ago — past the 5-min skew tolerance.
    const stale = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    expect(
      scheduleSurgerySchema.safeParse({ ...valid(), scheduledAt: stale }).success
    ).toBe(false);
  });
  it("rejects durationMin=0 (Issue #53 — must be strictly positive)", () => {
    const r = scheduleSurgerySchema.safeParse({ ...valid(), durationMin: 0 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Duration must be greater than 0/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects negative durationMin", () => {
    expect(
      scheduleSurgerySchema.safeParse({ ...valid(), durationMin: -30 }).success
    ).toBe(false);
  });
  it("rejects non-integer durationMin", () => {
    expect(
      scheduleSurgerySchema.safeParse({ ...valid(), durationMin: 45.5 }).success
    ).toBe(false);
  });
  it("accepts durationMin=1 (smallest positive integer)", () => {
    expect(
      scheduleSurgerySchema.safeParse({ ...valid(), durationMin: 1 }).success
    ).toBe(true);
  });
  it("rejects negative cost (Issue #53)", () => {
    const r = scheduleSurgerySchema.safeParse({ ...valid(), cost: -1 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Cost cannot be negative/.test(i.message))
      ).toBe(true);
    }
  });
  it("accepts cost=0 (pro-bono / charity case — Issue #53)", () => {
    expect(scheduleSurgerySchema.safeParse({ ...valid(), cost: 0 }).success).toBe(true);
  });
  it("rejects missing scheduledAt", () => {
    const { scheduledAt: _s, ...rest } = valid();
    expect(scheduleSurgerySchema.safeParse(rest).success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// updateSurgerySchema
// ───────────────────────────────────────────────────────

describe("updateSurgerySchema", () => {
  it("accepts an empty patch (all fields optional)", () => {
    expect(updateSurgerySchema.safeParse({}).success).toBe(true);
  });
  it("accepts a status-only patch", () => {
    expect(updateSurgerySchema.safeParse({ status: "IN_PROGRESS" }).success).toBe(true);
  });
  it("accepts each canonical status", () => {
    for (const s of [
      "SCHEDULED",
      "IN_PROGRESS",
      "COMPLETED",
      "CANCELLED",
      "POSTPONED",
    ] as const) {
      expect(updateSurgerySchema.safeParse({ status: s }).success).toBe(true);
    }
  });
  it("rejects unknown status", () => {
    expect(
      updateSurgerySchema.safeParse({ status: "ABORTED" as any }).success
    ).toBe(false);
  });
  it("rejects empty procedure on update (min 1)", () => {
    expect(updateSurgerySchema.safeParse({ procedure: "" }).success).toBe(false);
  });
  it("rejects durationMin=0 on update (Issue #53 still applies)", () => {
    expect(updateSurgerySchema.safeParse({ durationMin: 0 }).success).toBe(false);
  });
  it("rejects negative durationMin on update", () => {
    expect(updateSurgerySchema.safeParse({ durationMin: -1 }).success).toBe(false);
  });
  it("rejects non-integer durationMin on update", () => {
    expect(updateSurgerySchema.safeParse({ durationMin: 30.7 }).success).toBe(false);
  });
  it("rejects negative cost on update (Issue #53)", () => {
    expect(updateSurgerySchema.safeParse({ cost: -100 }).success).toBe(false);
  });
  it("accepts cost=0 on update", () => {
    expect(updateSurgerySchema.safeParse({ cost: 0 }).success).toBe(true);
  });
  it("rejects malformed scheduledAt on update (non-ISO)", () => {
    expect(
      updateSurgerySchema.safeParse({ scheduledAt: "not-a-date" }).success
    ).toBe(false);
  });
  it("accepts past scheduledAt on update (no past-time refine on this path)", () => {
    // Note: updateSurgerySchema deliberately omits the past-time refine that
    // scheduleSurgerySchema has — back-dating a record for documentation is
    // a legal admin/clinical action.
    const past = new Date("2024-01-01T10:00:00.000Z").toISOString();
    expect(updateSurgerySchema.safeParse({ scheduledAt: past }).success).toBe(true);
  });
  it("rejects malformed actualStartAt / actualEndAt (non-ISO)", () => {
    expect(updateSurgerySchema.safeParse({ actualStartAt: "abc" }).success).toBe(false);
    expect(updateSurgerySchema.safeParse({ actualEndAt: "abc" }).success).toBe(false);
  });
  it("accepts valid ISO actualStartAt + actualEndAt", () => {
    expect(
      updateSurgerySchema.safeParse({
        actualStartAt: "2026-04-15T09:00:00.000Z",
        actualEndAt: "2026-04-15T10:30:00.000Z",
      }).success
    ).toBe(true);
  });
  it("rejects non-uuid otId on update", () => {
    expect(updateSurgerySchema.safeParse({ otId: "abc" }).success).toBe(false);
  });
  it("rejects non-uuid surgeonId on update", () => {
    expect(updateSurgerySchema.safeParse({ surgeonId: "abc" }).success).toBe(false);
  });
  it("accepts a full update payload", () => {
    expect(
      updateSurgerySchema.safeParse({
        procedure: "Lap chole — converted to open",
        scheduledAt: "2026-04-15T09:00:00.000Z",
        durationMin: 150,
        anaesthesiologist: "Dr. Mehra",
        assistants: "Dr. Sharma",
        preOpNotes: "NPO confirmed",
        postOpNotes: "Patient stable, shifted to recovery",
        diagnosis: "Acute calculous cholecystitis",
        cost: 95000,
        status: "COMPLETED",
        actualStartAt: "2026-04-15T09:05:00.000Z",
        actualEndAt: "2026-04-15T11:35:00.000Z",
        otId: UUID_4,
        surgeonId: UUID_2,
      }).success
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────
// completeSurgerySchema
// ───────────────────────────────────────────────────────

describe("completeSurgerySchema", () => {
  it("accepts an empty completion payload (both fields optional)", () => {
    expect(completeSurgerySchema.safeParse({}).success).toBe(true);
  });
  it("accepts postOpNotes only", () => {
    expect(
      completeSurgerySchema.safeParse({ postOpNotes: "Patient stable" }).success
    ).toBe(true);
  });
  it("accepts diagnosis only", () => {
    expect(
      completeSurgerySchema.safeParse({ diagnosis: "Confirmed acute cholecystitis" }).success
    ).toBe(true);
  });
  it("accepts both fields together", () => {
    expect(
      completeSurgerySchema.safeParse({
        postOpNotes: "Patient stable, no complications",
        diagnosis: "Acute calculous cholecystitis",
      }).success
    ).toBe(true);
  });
  it("rejects non-string postOpNotes", () => {
    expect(
      completeSurgerySchema.safeParse({ postOpNotes: 42 as any }).success
    ).toBe(false);
  });
  it("rejects non-string diagnosis", () => {
    expect(
      completeSurgerySchema.safeParse({ diagnosis: { icd: "K81.0" } as any }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// cancelSurgerySchema
// ───────────────────────────────────────────────────────

describe("cancelSurgerySchema", () => {
  it("accepts a minimal cancellation with reason", () => {
    expect(
      cancelSurgerySchema.safeParse({ reason: "Patient developed pre-op fever" }).success
    ).toBe(true);
  });
  it("rejects empty reason (min 1)", () => {
    const r = cancelSurgerySchema.safeParse({ reason: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Cancellation reason is required/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects missing reason (required)", () => {
    expect(cancelSurgerySchema.safeParse({}).success).toBe(false);
  });
  it("rejects non-string reason", () => {
    expect(cancelSurgerySchema.safeParse({ reason: 42 as any }).success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// preOpChecklistSchema
// ───────────────────────────────────────────────────────

describe("preOpChecklistSchema", () => {
  it("accepts an empty checklist (all fields optional)", () => {
    expect(preOpChecklistSchema.safeParse({}).success).toBe(true);
  });
  it("accepts a fully-checked checklist", () => {
    expect(
      preOpChecklistSchema.safeParse({
        consentSigned: true,
        npoSince: "2026-04-15T00:00:00.000Z",
        allergiesVerified: true,
        antibioticsGiven: true,
        antibioticsAt: "2026-04-15T07:30:00.000Z",
        siteMarked: true,
        bloodReserved: true,
      }).success
    ).toBe(true);
  });
  it("accepts a partial checklist (consent + site only)", () => {
    expect(
      preOpChecklistSchema.safeParse({
        consentSigned: true,
        siteMarked: true,
      }).success
    ).toBe(true);
  });
  it("rejects non-boolean consentSigned", () => {
    expect(
      preOpChecklistSchema.safeParse({ consentSigned: "yes" as any }).success
    ).toBe(false);
  });
  it("rejects non-boolean allergiesVerified", () => {
    expect(
      preOpChecklistSchema.safeParse({ allergiesVerified: 1 as any }).success
    ).toBe(false);
  });
  it("rejects non-boolean antibioticsGiven", () => {
    expect(
      preOpChecklistSchema.safeParse({ antibioticsGiven: "true" as any }).success
    ).toBe(false);
  });
  it("rejects non-boolean siteMarked", () => {
    expect(
      preOpChecklistSchema.safeParse({ siteMarked: null as any }).success
    ).toBe(false);
  });
  it("rejects non-boolean bloodReserved", () => {
    expect(
      preOpChecklistSchema.safeParse({ bloodReserved: 0 as any }).success
    ).toBe(false);
  });
  it("rejects malformed npoSince (non-ISO)", () => {
    expect(
      preOpChecklistSchema.safeParse({ npoSince: "midnight" }).success
    ).toBe(false);
  });
  it("rejects malformed antibioticsAt (non-ISO)", () => {
    expect(
      preOpChecklistSchema.safeParse({ antibioticsAt: "7:30 AM" }).success
    ).toBe(false);
  });
  it("accepts well-formed ISO timestamps for npoSince + antibioticsAt", () => {
    expect(
      preOpChecklistSchema.safeParse({
        npoSince: "2026-04-15T00:00:00.000Z",
        antibioticsAt: "2026-04-15T07:30:00.000Z",
      }).success
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────
// intraOpTimingSchema
// ───────────────────────────────────────────────────────

describe("intraOpTimingSchema", () => {
  it("accepts an empty timing payload (all fields optional)", () => {
    expect(intraOpTimingSchema.safeParse({}).success).toBe(true);
  });
  it("accepts a fully-populated timing payload", () => {
    expect(
      intraOpTimingSchema.safeParse({
        anesthesiaStartAt: "2026-04-15T09:00:00.000Z",
        anesthesiaEndAt: "2026-04-15T11:00:00.000Z",
        incisionAt: "2026-04-15T09:15:00.000Z",
        closureAt: "2026-04-15T10:45:00.000Z",
      }).success
    ).toBe(true);
  });
  it("accepts partial timing (anesthesiaStartAt + incisionAt only)", () => {
    expect(
      intraOpTimingSchema.safeParse({
        anesthesiaStartAt: "2026-04-15T09:00:00.000Z",
        incisionAt: "2026-04-15T09:15:00.000Z",
      }).success
    ).toBe(true);
  });
  it("rejects malformed anesthesiaStartAt", () => {
    expect(
      intraOpTimingSchema.safeParse({ anesthesiaStartAt: "9am" }).success
    ).toBe(false);
  });
  it("rejects malformed anesthesiaEndAt", () => {
    expect(
      intraOpTimingSchema.safeParse({ anesthesiaEndAt: "later" }).success
    ).toBe(false);
  });
  it("rejects malformed incisionAt", () => {
    expect(intraOpTimingSchema.safeParse({ incisionAt: "abc" }).success).toBe(false);
  });
  it("rejects malformed closureAt", () => {
    expect(intraOpTimingSchema.safeParse({ closureAt: "abc" }).success).toBe(false);
  });
  it("accepts logically reversed times (no chronological refine in schema)", () => {
    // Schema does NOT enforce ordering — that's a business-rule check at
    // the handler / DB level. Locking in the actual contract here so a
    // future refine addition gets a clear test signal.
    expect(
      intraOpTimingSchema.safeParse({
        anesthesiaStartAt: "2026-04-15T11:00:00.000Z",
        anesthesiaEndAt: "2026-04-15T09:00:00.000Z",
      }).success
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────
// complicationsSchema
// ───────────────────────────────────────────────────────

describe("complicationsSchema", () => {
  it("accepts a minimal complication record (complications text only)", () => {
    expect(
      complicationsSchema.safeParse({ complications: "Minor bleeding at port site" }).success
    ).toBe(true);
  });
  it("accepts a fully-populated complication record", () => {
    expect(
      complicationsSchema.safeParse({
        complications: "Bile duct injury, repair attempted",
        complicationSeverity: "SEVERE",
        bloodLossMl: 850,
      }).success
    ).toBe(true);
  });
  it("rejects empty complications (min 1)", () => {
    expect(complicationsSchema.safeParse({ complications: "" }).success).toBe(false);
  });
  it("rejects missing complications (required)", () => {
    expect(complicationsSchema.safeParse({}).success).toBe(false);
  });
  it("accepts each canonical complicationSeverity", () => {
    for (const sev of ["MILD", "MODERATE", "SEVERE"] as const) {
      expect(
        complicationsSchema.safeParse({
          complications: "Some text",
          complicationSeverity: sev,
        }).success
      ).toBe(true);
    }
  });
  it("rejects unknown complicationSeverity", () => {
    expect(
      complicationsSchema.safeParse({
        complications: "X",
        complicationSeverity: "CRITICAL" as any,
      }).success
    ).toBe(false);
  });
  it("rejects negative bloodLossMl", () => {
    expect(
      complicationsSchema.safeParse({ complications: "X", bloodLossMl: -10 }).success
    ).toBe(false);
  });
  it("accepts bloodLossMl=0 (nonnegative boundary)", () => {
    expect(
      complicationsSchema.safeParse({ complications: "X", bloodLossMl: 0 }).success
    ).toBe(true);
  });
  it("rejects non-integer bloodLossMl", () => {
    expect(
      complicationsSchema.safeParse({ complications: "X", bloodLossMl: 100.5 }).success
    ).toBe(false);
  });
  it("rejects non-numeric bloodLossMl", () => {
    expect(
      complicationsSchema.safeParse({ complications: "X", bloodLossMl: "lots" as any }).success
    ).toBe(false);
  });
});
