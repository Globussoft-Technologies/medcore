import { describe, it, expect } from "vitest";
import {
  createTelemedicineSchema,
  updateTelemedicineStatusSchema,
  rateTelemedicineSchema,
  createEmergencyCaseSchema,
  triageSchema,
  assignEmergencyDoctorSchema,
  updateEmergencyStatusSchema,
  mlcDetailsSchema,
  erTreatmentOrderSchema,
  erToAdmissionSchema,
  massCasualtySchema,
  telemedRecordingStartSchema,
  anesthesiaRecordSchema,
  bloodRequirementSchema,
  postOpObservationSchema,
} from "../phase4-clinical";

const UUID = "11111111-1111-1111-1111-111111111111";
const FUTURE_ISO = "2099-01-01T10:00:00.000Z";

describe("createTelemedicineSchema", () => {
  const valid = {
    patientId: UUID,
    doctorId: UUID,
    scheduledAt: FUTURE_ISO,
    fee: 500,
  };
  it("accepts a valid telemedicine appointment", () => {
    expect(createTelemedicineSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects past scheduledAt (Issue #18)", () => {
    expect(
      createTelemedicineSchema.safeParse({ ...valid, scheduledAt: "2020-01-01T10:00:00.000Z" })
        .success
    ).toBe(false);
  });
  it("rejects negative fee (Issue #27)", () => {
    expect(createTelemedicineSchema.safeParse({ ...valid, fee: -100 }).success).toBe(false);
  });
});

describe("updateTelemedicineStatusSchema", () => {
  it("accepts a valid status update", () => {
    expect(
      updateTelemedicineStatusSchema.safeParse({ status: "IN_PROGRESS" }).success
    ).toBe(true);
  });
  it("rejects unknown status", () => {
    expect(
      updateTelemedicineStatusSchema.safeParse({ status: "TELEPORTED" as any }).success
    ).toBe(false);
  });
  it("rejects rating > 5", () => {
    expect(
      updateTelemedicineStatusSchema.safeParse({ status: "COMPLETED", patientRating: 6 })
        .success
    ).toBe(false);
  });
});

describe("rateTelemedicineSchema", () => {
  it("accepts rating 1-5", () => {
    expect(rateTelemedicineSchema.safeParse({ patientRating: 4 }).success).toBe(true);
  });
  it("rejects rating 0", () => {
    expect(rateTelemedicineSchema.safeParse({ patientRating: 0 }).success).toBe(false);
  });
});

describe("createEmergencyCaseSchema", () => {
  it("accepts a registered-patient case", () => {
    expect(
      createEmergencyCaseSchema.safeParse({
        patientId: UUID,
        chiefComplaint: "Severe abdominal pain",
      }).success
    ).toBe(true);
  });
  it("accepts an unknown-patient case (John Doe intake)", () => {
    expect(
      createEmergencyCaseSchema.safeParse({
        unknownName: "John Doe",
        chiefComplaint: "Unconscious",
      }).success
    ).toBe(true);
  });
  it("rejects orphan case with no patient identity (Issue #171)", () => {
    expect(
      createEmergencyCaseSchema.safeParse({ chiefComplaint: "Pain" }).success
    ).toBe(false);
  });
  it("rejects XSS payload in chiefComplaint (Issue #424)", () => {
    expect(
      createEmergencyCaseSchema.safeParse({
        patientId: UUID,
        chiefComplaint: "<script>alert(1)</script>",
      }).success
    ).toBe(false);
  });
});

describe("triageSchema", () => {
  const valid = { caseId: UUID, triageLevel: "EMERGENT" as const };
  it("accepts a valid triage", () => {
    expect(triageSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects unknown triage level", () => {
    expect(
      triageSchema.safeParse({ ...valid, triageLevel: "MAYBE" as any }).success
    ).toBe(false);
  });
  it("rejects glasgowComa out of range (3-15)", () => {
    expect(triageSchema.safeParse({ ...valid, glasgowComa: 20 }).success).toBe(false);
  });
  it("rejects mewsScore > 14", () => {
    expect(triageSchema.safeParse({ ...valid, mewsScore: 30 }).success).toBe(false);
  });
});

describe("assignEmergencyDoctorSchema", () => {
  it("accepts a valid assignment", () => {
    expect(
      assignEmergencyDoctorSchema.safeParse({ attendingDoctorId: UUID }).success
    ).toBe(true);
  });
  it("rejects non-uuid doctor id", () => {
    expect(
      assignEmergencyDoctorSchema.safeParse({ attendingDoctorId: "abc" }).success
    ).toBe(false);
  });
});

describe("updateEmergencyStatusSchema", () => {
  const valid = {
    status: "DISCHARGED" as const,
    disposition: "Home with follow-up",
    outcomeNotes: "Stable on discharge",
  };
  it("accepts a valid close (Issue #88)", () => {
    expect(updateEmergencyStatusSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects empty disposition", () => {
    expect(
      updateEmergencyStatusSchema.safeParse({ ...valid, disposition: "" }).success
    ).toBe(false);
  });
  it("rejects XSS in outcomeNotes (Issue #424)", () => {
    expect(
      updateEmergencyStatusSchema.safeParse({
        ...valid,
        outcomeNotes: "<img onerror=alert(1) src=x>",
      }).success
    ).toBe(false);
  });
});

describe("mlcDetailsSchema", () => {
  it("accepts a valid MLC entry", () => {
    expect(
      mlcDetailsSchema.safeParse({
        isMLC: true,
        mlcNumber: "MLC-2026-001",
        mlcPoliceStation: "MG Road",
      }).success
    ).toBe(true);
  });
  it("rejects XSS payload in mlcNumber", () => {
    expect(
      mlcDetailsSchema.safeParse({ isMLC: true, mlcNumber: "<svg/onload=1>" }).success
    ).toBe(false);
  });
});

describe("erTreatmentOrderSchema", () => {
  it("accepts a valid treatment order", () => {
    expect(
      erTreatmentOrderSchema.safeParse({
        orders: [{ type: "MEDICATION", name: "IV Saline" }],
      }).success
    ).toBe(true);
  });
  it("rejects unknown order type", () => {
    expect(
      erTreatmentOrderSchema.safeParse({
        orders: [{ type: "MAGIC" as any, name: "x" }],
      }).success
    ).toBe(false);
  });
});

describe("erToAdmissionSchema", () => {
  it("accepts a valid ER-to-admission conversion", () => {
    expect(
      erToAdmissionSchema.safeParse({
        doctorId: UUID,
        bedId: UUID,
        reason: "Observation",
      }).success
    ).toBe(true);
  });
  it("rejects empty reason", () => {
    expect(
      erToAdmissionSchema.safeParse({ doctorId: UUID, bedId: UUID, reason: "" }).success
    ).toBe(false);
  });
});

describe("massCasualtySchema", () => {
  it("accepts within count limits", () => {
    expect(massCasualtySchema.safeParse({ count: 10 }).success).toBe(true);
  });
  it("rejects count > 50", () => {
    expect(massCasualtySchema.safeParse({ count: 100 }).success).toBe(false);
  });
});

describe("telemedRecordingStartSchema", () => {
  it("accepts consent=true", () => {
    expect(telemedRecordingStartSchema.safeParse({ consent: true }).success).toBe(true);
  });
  it("rejects missing consent", () => {
    expect(telemedRecordingStartSchema.safeParse({}).success).toBe(false);
  });
});

describe("anesthesiaRecordSchema", () => {
  it("accepts a minimal anesthesia record", () => {
    expect(
      anesthesiaRecordSchema.safeParse({ anesthesiaType: "GENERAL" }).success
    ).toBe(true);
  });
  it("rejects unknown anesthesia type", () => {
    expect(
      anesthesiaRecordSchema.safeParse({ anesthesiaType: "SLEEPY" as any }).success
    ).toBe(false);
  });
});

describe("bloodRequirementSchema", () => {
  it("accepts a valid requirement", () => {
    expect(
      bloodRequirementSchema.safeParse({ component: "PACKED_RED_CELLS", units: 2 }).success
    ).toBe(true);
  });
  it("rejects units > 20", () => {
    expect(
      bloodRequirementSchema.safeParse({ component: "PLATELETS", units: 100 }).success
    ).toBe(false);
  });
});

describe("postOpObservationSchema", () => {
  it("accepts a valid observation", () => {
    expect(
      postOpObservationSchema.safeParse({
        bpSystolic: 120,
        bpDiastolic: 80,
        pulse: 72,
        spO2: 98,
        painScore: 3,
        consciousness: "ALERT",
      }).success
    ).toBe(true);
  });
  it("rejects spO2 > 100", () => {
    expect(postOpObservationSchema.safeParse({ spO2: 110 }).success).toBe(false);
  });
  it("rejects painScore > 10", () => {
    expect(postOpObservationSchema.safeParse({ painScore: 15 }).success).toBe(false);
  });
});
