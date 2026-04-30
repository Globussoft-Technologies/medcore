import { describe, it, expect } from "vitest";
import { createShiftSchema, createLeaveRequestSchema } from "../hr";
import {
  createTelemedicineSchema,
  createEmergencyCaseSchema,
  triageSchema,
  updateEmergencyStatusSchema,
} from "../phase4-clinical";
import {
  createAncCaseSchema,
  createAncVisitSchema,
  createGrowthRecordSchema,
} from "../phase4-specialty";
import {
  createDonorSchema,
  createDonationSchema,
  bloodRequestSchema,
} from "../phase4-ops";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("createShiftSchema", () => {
  it("accepts a valid shift", () => {
    expect(
      createShiftSchema.safeParse({
        userId: UUID,
        date: "2026-04-20",
        type: "MORNING",
        startTime: "08:00",
        endTime: "16:00",
      }).success
    ).toBe(true);
  });
  it("rejects bad time format", () => {
    expect(
      createShiftSchema.safeParse({
        userId: UUID,
        date: "2026-04-20",
        type: "MORNING",
        startTime: "8am",
        endTime: "16:00",
      }).success
    ).toBe(false);
  });
});

describe("createLeaveRequestSchema", () => {
  it("accepts valid leave request", () => {
    expect(
      createLeaveRequestSchema.safeParse({
        type: "CASUAL",
        fromDate: "2026-04-20",
        toDate: "2026-04-22",
        reason: "Personal",
      }).success
    ).toBe(true);
  });
  it("rejects when toDate < fromDate", () => {
    expect(
      createLeaveRequestSchema.safeParse({
        type: "CASUAL",
        fromDate: "2026-04-22",
        toDate: "2026-04-20",
        reason: "x",
      }).success
    ).toBe(false);
  });
  it("rejects empty reason", () => {
    expect(
      createLeaveRequestSchema.safeParse({
        type: "CASUAL",
        fromDate: "2026-04-20",
        toDate: "2026-04-22",
        reason: "",
      }).success
    ).toBe(false);
  });
});

describe("createTelemedicineSchema", () => {
  const FUTURE = new Date(Date.now() + 3600_000).toISOString();
  const PAST = new Date("2020-01-01T00:00:00Z").toISOString();

  it("accepts a valid telemedicine appointment", () => {
    expect(
      createTelemedicineSchema.safeParse({
        patientId: UUID,
        doctorId: UUID,
        scheduledAt: FUTURE,
      }).success
    ).toBe(true);
  });
  it("rejects negative fee (issue #18)", () => {
    const r = createTelemedicineSchema.safeParse({
      patientId: UUID,
      doctorId: UUID,
      scheduledAt: FUTURE,
      fee: -10,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path[0] === "fee")).toBe(true);
    }
  });
  it("rejects negative fee -500 (issue #18)", () => {
    expect(
      createTelemedicineSchema.safeParse({
        patientId: UUID,
        doctorId: UUID,
        scheduledAt: FUTURE,
        fee: -500,
      }).success
    ).toBe(false);
  });
  it("rejects past scheduledAt (issue #18)", () => {
    const r = createTelemedicineSchema.safeParse({
      patientId: UUID,
      doctorId: UUID,
      scheduledAt: PAST,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some(
          (i) =>
            i.path[0] === "scheduledAt" && /future/i.test(i.message)
        )
      ).toBe(true);
    }
  });
  it("rejects malformed scheduledAt 'not-a-date'", () => {
    expect(
      createTelemedicineSchema.safeParse({
        patientId: UUID,
        doctorId: UUID,
        scheduledAt: "not-a-date",
      }).success
    ).toBe(false);
  });
  it("accepts fee = 0", () => {
    expect(
      createTelemedicineSchema.safeParse({
        patientId: UUID,
        doctorId: UUID,
        scheduledAt: FUTURE,
        fee: 0,
      }).success
    ).toBe(true);
  });
});

describe("createEmergencyCaseSchema", () => {
  it("accepts a known patient", () => {
    expect(
      createEmergencyCaseSchema.safeParse({
        patientId: UUID,
        chiefComplaint: "Chest pain",
      }).success
    ).toBe(true);
  });
  it("accepts an unknown patient with name only", () => {
    expect(
      createEmergencyCaseSchema.safeParse({
        unknownName: "John Doe",
        chiefComplaint: "Unconscious",
      }).success
    ).toBe(true);
  });
  it("rejects empty chiefComplaint", () => {
    expect(
      createEmergencyCaseSchema.safeParse({ chiefComplaint: "" }).success
    ).toBe(false);
  });
  // Issue #171 (Apr 2026): require either patientId or unknownName so an
  // ER case can never be a true orphan record.
  it("rejects when neither patientId nor unknownName is provided", () => {
    const r = createEmergencyCaseSchema.safeParse({
      chiefComplaint: "Unspecified",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.includes("patientId"));
      expect(issue?.message).toMatch(/Patient is required/i);
    }
  });
  it("rejects when unknownName is empty whitespace and no patientId", () => {
    const r = createEmergencyCaseSchema.safeParse({
      chiefComplaint: "Trauma",
      unknownName: "   ",
    });
    expect(r.success).toBe(false);
  });

  // Issue #424 (Apr 2026): the ER intake form was a stored XSS sink because
  // chiefComplaint went straight to the chart. Schema-level refinements now
  // reject any HTML/script-shaped payload across every free-text leg.
  it("rejects <script> in chiefComplaint (issue #424)", () => {
    const r = createEmergencyCaseSchema.safeParse({
      patientId: UUID,
      chiefComplaint: "<script>alert(1)</script>",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) =>
        i.path.includes("chiefComplaint")
      );
      expect(issue?.message).toMatch(/aren't allowed/i);
    }
  });
  it("rejects <img onerror> in unknownName (issue #424)", () => {
    const r = createEmergencyCaseSchema.safeParse({
      unknownName: "<img src=x onerror=alert(1)>",
      chiefComplaint: "Unresponsive",
    });
    expect(r.success).toBe(false);
  });
  it("rejects HTML in arrivalMode (issue #424)", () => {
    const r = createEmergencyCaseSchema.safeParse({
      patientId: UUID,
      chiefComplaint: "Cough",
      arrivalMode: "<b>Walk-in</b>",
    });
    expect(r.success).toBe(false);
  });
  it("accepts plain-text chiefComplaint with normal punctuation (issue #424 negative)", () => {
    const r = createEmergencyCaseSchema.safeParse({
      patientId: UUID,
      chiefComplaint: "Severe chest pain (radiating to left arm) - 2hr",
    });
    expect(r.success).toBe(true);
  });
});

describe("updateEmergencyStatusSchema (issue #424)", () => {
  it("rejects <script> in outcomeNotes", () => {
    const r = updateEmergencyStatusSchema.safeParse({
      status: "DISCHARGED",
      disposition: "Home",
      outcomeNotes: "<script>alert(1)</script>",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.includes("outcomeNotes"));
      expect(issue?.message).toMatch(/aren't allowed/i);
    }
  });
  it("rejects HTML in disposition", () => {
    const r = updateEmergencyStatusSchema.safeParse({
      status: "DISCHARGED",
      disposition: "<b>Home</b>",
      outcomeNotes: "Stable",
    });
    expect(r.success).toBe(false);
  });
  it("accepts plain-text disposition + outcomeNotes", () => {
    const r = updateEmergencyStatusSchema.safeParse({
      status: "DISCHARGED",
      disposition: "Home — follow up in 48h",
      outcomeNotes: "Stable, BP 130/80, no further intervention required.",
    });
    expect(r.success).toBe(true);
  });
});

describe("triageSchema", () => {
  it("accepts valid triage", () => {
    expect(
      triageSchema.safeParse({
        caseId: UUID,
        triageLevel: "EMERGENT",
        glasgowComa: 14,
      }).success
    ).toBe(true);
  });
  it("rejects glasgowComa out of 3-15", () => {
    expect(
      triageSchema.safeParse({
        caseId: UUID,
        triageLevel: "EMERGENT",
        glasgowComa: 20,
      }).success
    ).toBe(false);
  });
});

describe("createAncCaseSchema", () => {
  // For "today", build a YYYY-MM-DD without TZ surprises.
  function ymd(d: Date): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  it("accepts a valid ANC case", () => {
    expect(
      createAncCaseSchema.safeParse({
        patientId: UUID,
        doctorId: UUID,
        lmpDate: "2026-01-01",
      }).success
    ).toBe(true);
  });
  it("rejects bad lmpDate", () => {
    expect(
      createAncCaseSchema.safeParse({
        patientId: UUID,
        doctorId: UUID,
        lmpDate: "Jan 1",
      }).success
    ).toBe(false);
  });
  // Issue #57 (Apr 2026)
  it("rejects future lmpDate", () => {
    const future = new Date();
    future.setUTCDate(future.getUTCDate() + 30);
    expect(
      createAncCaseSchema.safeParse({
        patientId: UUID,
        doctorId: UUID,
        lmpDate: ymd(future),
      }).success
    ).toBe(false);
  });
  it("accepts today's lmpDate", () => {
    expect(
      createAncCaseSchema.safeParse({
        patientId: UUID,
        doctorId: UUID,
        lmpDate: ymd(new Date()),
      }).success
    ).toBe(true);
  });
  it("rejects negative gravida", () => {
    expect(
      createAncCaseSchema.safeParse({
        patientId: UUID,
        doctorId: UUID,
        lmpDate: "2026-01-01",
        gravida: -1,
      }).success
    ).toBe(false);
  });
  it("rejects negative parity", () => {
    expect(
      createAncCaseSchema.safeParse({
        patientId: UUID,
        doctorId: UUID,
        lmpDate: "2026-01-01",
        parity: -2,
      }).success
    ).toBe(false);
  });
  it("rejects free-text bloodGroup", () => {
    expect(
      createAncCaseSchema.safeParse({
        patientId: UUID,
        doctorId: UUID,
        lmpDate: "2026-01-01",
        bloodGroup: "O+",
      }).success
    ).toBe(false);
  });
  it("accepts canonical ABO+Rh tokens", () => {
    expect(
      createAncCaseSchema.safeParse({
        patientId: UUID,
        doctorId: UUID,
        lmpDate: "2026-01-01",
        bloodGroup: "O_POS",
      }).success
    ).toBe(true);
  });
});

// Issue #423 (Apr 2026): the visit form used to accept a click-Save with
// nothing filled in, polluting the antenatal timeline with empty rows.
// Both the web form and the schema now refuse the submission unless at
// least one clinical observation OR a free-form note is supplied.
describe("createAncVisitSchema", () => {
  it("rejects a totally empty visit (no observations, no notes)", () => {
    const res = createAncVisitSchema.safeParse({
      ancCaseId: UUID,
      type: "ROUTINE",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => /at least one observation/i.test(i.message))).toBe(true);
    }
  });
  it("accepts a visit with just notes", () => {
    expect(
      createAncVisitSchema.safeParse({
        ancCaseId: UUID,
        type: "ROUTINE",
        notes: "Patient reports nausea, advised antacids.",
      }).success
    ).toBe(true);
  });
  it("accepts a visit with vitals only", () => {
    expect(
      createAncVisitSchema.safeParse({
        ancCaseId: UUID,
        type: "ROUTINE",
        bloodPressure: "120/80",
        weight: 62.5,
      }).success
    ).toBe(true);
  });
  it("rejects a visit with only whitespace strings (still effectively empty)", () => {
    expect(
      createAncVisitSchema.safeParse({
        ancCaseId: UUID,
        type: "ROUTINE",
        notes: "   ",
        bloodPressure: " ",
      }).success
    ).toBe(false);
  });
});

// Issue #435 (Apr 30 2026): the pediatric growth measurement form used to
// accept impossible weight / height / head-circumference values (negative,
// zero, absurdly large). The schema now enforces the WHO p3-p97 envelope
// plus a defensive margin, so the percentile chart never plots nonsense.
describe("createGrowthRecordSchema (Issue #435)", () => {
  const base = {
    patientId: UUID,
    ageMonths: 12,
  };
  it("accepts a clinically reasonable measurement", () => {
    expect(
      createGrowthRecordSchema.safeParse({
        ...base,
        weightKg: 9.4,
        heightCm: 76,
        headCircumference: 46,
      }).success
    ).toBe(true);
  });
  it("rejects negative weight", () => {
    expect(
      createGrowthRecordSchema.safeParse({ ...base, weightKg: -3 }).success
    ).toBe(false);
  });
  it("rejects weight above 200 kg", () => {
    expect(
      createGrowthRecordSchema.safeParse({ ...base, weightKg: 250 }).success
    ).toBe(false);
  });
  it("rejects height below 30 cm or above 220 cm", () => {
    expect(
      createGrowthRecordSchema.safeParse({ ...base, heightCm: 10 }).success
    ).toBe(false);
    expect(
      createGrowthRecordSchema.safeParse({ ...base, heightCm: 999 }).success
    ).toBe(false);
  });
  it("rejects negative or absurdly large head circumference", () => {
    expect(
      createGrowthRecordSchema.safeParse({
        ...base,
        headCircumference: -15,
      }).success
    ).toBe(false);
    expect(
      createGrowthRecordSchema.safeParse({
        ...base,
        headCircumference: 100,
      }).success
    ).toBe(false);
  });
  it("rejects ageMonths > 240 (over 20 years)", () => {
    expect(
      createGrowthRecordSchema.safeParse({
        patientId: UUID,
        ageMonths: 999,
      }).success
    ).toBe(false);
  });
  it("accepts the exact WHO envelope edges", () => {
    expect(
      createGrowthRecordSchema.safeParse({
        ...base,
        weightKg: 0.5,
        heightCm: 30,
        headCircumference: 25,
      }).success
    ).toBe(true);
    expect(
      createGrowthRecordSchema.safeParse({
        ...base,
        weightKg: 200,
        heightCm: 220,
        headCircumference: 65,
      }).success
    ).toBe(true);
  });
});

describe("createDonorSchema", () => {
  it("accepts a valid donor", () => {
    expect(
      createDonorSchema.safeParse({
        name: "Donor Joe",
        phone: "9000000000",
        bloodGroup: "O_POS",
        gender: "MALE",
      }).success
    ).toBe(true);
  });
  it("rejects unknown blood group", () => {
    expect(
      createDonorSchema.safeParse({
        name: "x",
        phone: "9000000000",
        bloodGroup: "ZZ" as any,
        gender: "MALE",
      }).success
    ).toBe(false);
  });
  // Issue #428 (Apr 30 2026): explicit guard rails on the previously-loose
  // donor schema. Empty / negative / future-dated values must be rejected.
  it("rejects garbage donor values per #428", () => {
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    // empty name + bad phone + future last-donation date — should fail.
    expect(
      createDonorSchema.safeParse({
        name: "",
        phone: "abc",
        bloodGroup: "O_POS",
        gender: "MALE",
        lastDonation: future,
      }).success
    ).toBe(false);
    // weight below 50 kg — must fail.
    expect(
      createDonorSchema.safeParse({
        name: "Donor Joe",
        phone: "9000000000",
        bloodGroup: "O_POS",
        gender: "MALE",
        weight: 40,
      }).success
    ).toBe(false);
    // age outside 17-65 — must fail (DOB making donor 10 yrs old).
    const tenYrs = new Date(Date.now() - 10 * 365.25 * 86400000)
      .toISOString()
      .slice(0, 10);
    expect(
      createDonorSchema.safeParse({
        name: "Donor Joe",
        phone: "9000000000",
        bloodGroup: "O_POS",
        gender: "MALE",
        dateOfBirth: tenYrs,
      }).success
    ).toBe(false);
  });
});

describe("createDonationSchema", () => {
  it("accepts default volume", () => {
    expect(createDonationSchema.safeParse({ donorId: UUID }).success).toBe(true);
  });
  it("rejects zero volume", () => {
    expect(createDonationSchema.safeParse({ donorId: UUID, volumeMl: 0 }).success).toBe(false);
  });
});

describe("bloodRequestSchema", () => {
  it("accepts valid request", () => {
    expect(
      bloodRequestSchema.safeParse({
        patientId: UUID,
        bloodGroup: "A_POS",
        component: "WHOLE_BLOOD",
        unitsRequested: 2,
        reason: "Surgery",
        urgency: "ROUTINE",
      }).success
    ).toBe(true);
  });
  it("rejects unitsRequested = 0", () => {
    expect(
      bloodRequestSchema.safeParse({
        patientId: UUID,
        bloodGroup: "A_POS",
        component: "WHOLE_BLOOD",
        unitsRequested: 0,
        reason: "x",
        urgency: "ROUTINE",
      }).success
    ).toBe(false);
  });
});
