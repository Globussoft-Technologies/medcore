// Coverage tests for HR validation schemas.
// What: exhaustive happy / invalid / edge cases for every exported Zod schema
//   and constant in packages/shared/src/validation/hr.ts — shifts, leave
//   requests + balances, holidays (create + Issue #692 update), payroll calc,
//   staff certifications, overtime records, and the auto-overtime computation
//   request shape.
// Which modules: imports only schemas / enums / constants from ../hr.
// Why: file shipped with 0% colocated coverage. Two prior test files touched
//   hr.ts (hr-and-phase4.test.ts — only createShiftSchema + createLeaveRequestSchema
//   minimally; validation-cluster-2026-04-26.test.ts — only payrollCalcSchema's
//   Issue #283 fix). The remaining 11 schemas + 3 enums + 1 constant were
//   uncovered. Particularly important to lock in: (a) Issue #292's no-HTML
//   guard on holiday name/description, (b) Issue #283's `.positive()` tighten
//   on basicSalary, (c) Issue #692's "at least one field" refine on
//   updateHolidaySchema, (d) the createLeaveRequestSchema fromDate≤toDate
//   refine, (e) every numeric boundary on year (2020..2100) and month (1..12).
import { describe, it, expect } from "vitest";
import {
  shiftTypeEnum,
  shiftStatusEnum,
  leaveTypeEnum,
  leaveStatusEnum,
  createShiftSchema,
  bulkShiftSchema,
  updateShiftSchema,
  updateShiftStatusSchema,
  checkOutShiftSchema,
  createLeaveRequestSchema,
  approveLeaveSchema,
  rejectLeaveSchema,
  leaveBalanceSchema,
  DEFAULT_LEAVE_ENTITLEMENT,
  createHolidaySchema,
  updateHolidaySchema,
  payrollCalcSchema,
  CertificationTypeEnum,
  CertificationStatusEnum,
  certificationSchema,
  updateCertificationSchema,
  overtimeRecordSchema,
  autoOvertimeSchema,
} from "../hr";

const UUID = "550e8400-e29b-41d4-a716-446655441111";
const UUID_2 = "550e8400-e29b-41d4-a716-446655442222";

// ───────────────────────────────────────────────────────
// Enums + constants
// ───────────────────────────────────────────────────────

describe("shiftTypeEnum", () => {
  it("accepts each canonical shift type", () => {
    for (const t of ["MORNING", "AFTERNOON", "NIGHT", "ON_CALL"]) {
      expect(shiftTypeEnum.safeParse(t).success).toBe(true);
    }
  });
  it("rejects unknown shift type", () => {
    expect(shiftTypeEnum.safeParse("EVENING").success).toBe(false);
  });
  it("rejects empty string", () => {
    expect(shiftTypeEnum.safeParse("").success).toBe(false);
  });
});

describe("shiftStatusEnum", () => {
  it("accepts each canonical status", () => {
    for (const s of ["SCHEDULED", "PRESENT", "ABSENT", "LATE", "LEAVE"]) {
      expect(shiftStatusEnum.safeParse(s).success).toBe(true);
    }
  });
  it("rejects unknown status", () => {
    expect(shiftStatusEnum.safeParse("UNKNOWN").success).toBe(false);
  });
});

describe("leaveTypeEnum", () => {
  it("accepts each canonical leave type", () => {
    for (const t of [
      "CASUAL",
      "SICK",
      "EARNED",
      "MATERNITY",
      "PATERNITY",
      "UNPAID",
    ]) {
      expect(leaveTypeEnum.safeParse(t).success).toBe(true);
    }
  });
  it("rejects unknown leave type", () => {
    expect(leaveTypeEnum.safeParse("SABBATICAL").success).toBe(false);
  });
});

describe("leaveStatusEnum", () => {
  it("accepts each canonical status", () => {
    for (const s of ["PENDING", "APPROVED", "REJECTED", "CANCELLED"]) {
      expect(leaveStatusEnum.safeParse(s).success).toBe(true);
    }
  });
  it("rejects unknown status", () => {
    expect(leaveStatusEnum.safeParse("EXPIRED").success).toBe(false);
  });
});

describe("DEFAULT_LEAVE_ENTITLEMENT", () => {
  it("provides default days per documented leave type", () => {
    expect(DEFAULT_LEAVE_ENTITLEMENT.CASUAL).toBe(12);
    expect(DEFAULT_LEAVE_ENTITLEMENT.SICK).toBe(12);
    expect(DEFAULT_LEAVE_ENTITLEMENT.EARNED).toBe(20);
    expect(DEFAULT_LEAVE_ENTITLEMENT.MATERNITY).toBe(180);
    expect(DEFAULT_LEAVE_ENTITLEMENT.PATERNITY).toBe(15);
    expect(DEFAULT_LEAVE_ENTITLEMENT.UNPAID).toBe(0);
  });
  it("covers every leaveTypeEnum value", () => {
    for (const t of [
      "CASUAL",
      "SICK",
      "EARNED",
      "MATERNITY",
      "PATERNITY",
      "UNPAID",
    ]) {
      expect(DEFAULT_LEAVE_ENTITLEMENT).toHaveProperty(t);
      expect(typeof DEFAULT_LEAVE_ENTITLEMENT[t]).toBe("number");
    }
  });
});

describe("CertificationTypeEnum", () => {
  it("accepts each canonical certification type", () => {
    for (const t of [
      "MEDICAL_LICENSE",
      "NURSING_CERT",
      "BLS",
      "ACLS",
      "TRAINING",
      "OTHER",
    ]) {
      expect(CertificationTypeEnum.safeParse(t).success).toBe(true);
    }
  });
  it("rejects unknown certification type", () => {
    expect(CertificationTypeEnum.safeParse("PALS").success).toBe(false);
  });
});

describe("CertificationStatusEnum", () => {
  it("accepts each canonical certification status", () => {
    for (const s of ["ACTIVE", "EXPIRED", "RENEWED", "REVOKED"]) {
      expect(CertificationStatusEnum.safeParse(s).success).toBe(true);
    }
  });
  it("rejects unknown certification status", () => {
    expect(CertificationStatusEnum.safeParse("PENDING").success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Shifts
// ───────────────────────────────────────────────────────

describe("createShiftSchema", () => {
  const valid = {
    userId: UUID,
    date: "2026-05-25",
    type: "MORNING" as const,
    startTime: "08:00",
    endTime: "16:00",
  };
  it("accepts a minimal valid shift", () => {
    expect(createShiftSchema.safeParse(valid).success).toBe(true);
  });
  it("accepts a shift with optional notes", () => {
    expect(
      createShiftSchema.safeParse({ ...valid, notes: "Covering for Dr. Rao" }).success
    ).toBe(true);
  });
  it("rejects non-uuid userId", () => {
    expect(createShiftSchema.safeParse({ ...valid, userId: "abc" }).success).toBe(false);
  });
  it("rejects malformed date (not YYYY-MM-DD)", () => {
    expect(createShiftSchema.safeParse({ ...valid, date: "25-05-2026" }).success).toBe(false);
  });
  it("rejects date with single-digit month", () => {
    expect(createShiftSchema.safeParse({ ...valid, date: "2026-5-25" }).success).toBe(false);
  });
  it("rejects unknown shift type", () => {
    expect(
      createShiftSchema.safeParse({ ...valid, type: "EVENING" as any }).success
    ).toBe(false);
  });
  it("rejects malformed startTime", () => {
    expect(createShiftSchema.safeParse({ ...valid, startTime: "8am" }).success).toBe(false);
  });
  it("rejects malformed endTime", () => {
    expect(createShiftSchema.safeParse({ ...valid, endTime: "4pm" }).success).toBe(false);
  });
  it("rejects missing required field (date)", () => {
    const { date: _date, ...rest } = valid;
    expect(createShiftSchema.safeParse(rest).success).toBe(false);
  });
});

describe("bulkShiftSchema", () => {
  const oneShift = {
    userId: UUID,
    date: "2026-05-25",
    type: "MORNING" as const,
    startTime: "08:00",
    endTime: "16:00",
  };
  it("accepts a single-shift array", () => {
    expect(bulkShiftSchema.safeParse({ shifts: [oneShift] }).success).toBe(true);
  });
  it("accepts a multi-shift array", () => {
    expect(
      bulkShiftSchema.safeParse({ shifts: [oneShift, { ...oneShift, type: "NIGHT" }] })
        .success
    ).toBe(true);
  });
  it("rejects an empty array (min 1)", () => {
    expect(bulkShiftSchema.safeParse({ shifts: [] }).success).toBe(false);
  });
  it("rejects missing shifts key", () => {
    expect(bulkShiftSchema.safeParse({}).success).toBe(false);
  });
  it("rejects an array containing an invalid shift", () => {
    expect(
      bulkShiftSchema.safeParse({ shifts: [oneShift, { ...oneShift, startTime: "noon" }] })
        .success
    ).toBe(false);
  });
});

describe("updateShiftSchema", () => {
  it("accepts an empty patch (all fields optional)", () => {
    expect(updateShiftSchema.safeParse({}).success).toBe(true);
  });
  it("accepts a status-only patch", () => {
    expect(updateShiftSchema.safeParse({ status: "PRESENT" }).success).toBe(true);
  });
  it("accepts a notes-only patch", () => {
    expect(updateShiftSchema.safeParse({ notes: "Late by 10m" }).success).toBe(true);
  });
  it("accepts a full update", () => {
    expect(
      updateShiftSchema.safeParse({
        date: "2026-05-25",
        type: "AFTERNOON",
        startTime: "12:00",
        endTime: "20:00",
        status: "SCHEDULED",
        notes: "Swap with Dr. Iyer",
      }).success
    ).toBe(true);
  });
  it("rejects malformed time", () => {
    expect(updateShiftSchema.safeParse({ startTime: "noon" }).success).toBe(false);
  });
  it("rejects unknown status", () => {
    expect(updateShiftSchema.safeParse({ status: "ATTENDED" as any }).success).toBe(false);
  });
});

describe("updateShiftStatusSchema", () => {
  it("accepts a status with no notes", () => {
    expect(updateShiftStatusSchema.safeParse({ status: "PRESENT" }).success).toBe(true);
  });
  it("accepts a status with notes", () => {
    expect(
      updateShiftStatusSchema.safeParse({ status: "LATE", notes: "Traffic on ring road" })
        .success
    ).toBe(true);
  });
  it("rejects missing status", () => {
    expect(updateShiftStatusSchema.safeParse({}).success).toBe(false);
  });
  it("rejects unknown status", () => {
    expect(
      updateShiftStatusSchema.safeParse({ status: "OUT" as any }).success
    ).toBe(false);
  });
});

describe("checkOutShiftSchema", () => {
  it("accepts an empty body", () => {
    expect(checkOutShiftSchema.safeParse({}).success).toBe(true);
  });
  it("accepts a body with notes", () => {
    expect(
      checkOutShiftSchema.safeParse({ notes: "Handed over to night team" }).success
    ).toBe(true);
  });
  it("rejects non-string notes", () => {
    expect(checkOutShiftSchema.safeParse({ notes: 123 as any }).success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Leave requests + balances
// ───────────────────────────────────────────────────────

describe("createLeaveRequestSchema", () => {
  const valid = {
    type: "CASUAL" as const,
    fromDate: "2026-06-01",
    toDate: "2026-06-03",
    reason: "Personal travel",
  };
  it("accepts a valid leave request", () => {
    expect(createLeaveRequestSchema.safeParse(valid).success).toBe(true);
  });
  it("accepts a single-day leave (fromDate === toDate)", () => {
    expect(
      createLeaveRequestSchema.safeParse({ ...valid, toDate: "2026-06-01" }).success
    ).toBe(true);
  });
  it("rejects toDate before fromDate (refine)", () => {
    const r = createLeaveRequestSchema.safeParse({
      ...valid,
      fromDate: "2026-06-05",
      toDate: "2026-06-01",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /toDate must be on or after fromDate/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects malformed fromDate", () => {
    expect(
      createLeaveRequestSchema.safeParse({ ...valid, fromDate: "06/01/2026" }).success
    ).toBe(false);
  });
  it("rejects malformed toDate", () => {
    expect(
      createLeaveRequestSchema.safeParse({ ...valid, toDate: "2026-13-01" }).success
    ).toBe(false);
  });
  it("rejects unknown leave type", () => {
    expect(
      createLeaveRequestSchema.safeParse({ ...valid, type: "BEREAVEMENT" as any }).success
    ).toBe(false);
  });
  it("rejects empty reason (min 1)", () => {
    expect(createLeaveRequestSchema.safeParse({ ...valid, reason: "" }).success).toBe(false);
  });
  it("rejects missing reason", () => {
    const { reason: _r, ...rest } = valid;
    expect(createLeaveRequestSchema.safeParse(rest).success).toBe(false);
  });
});

describe("approveLeaveSchema", () => {
  it("accepts APPROVED status with no reason", () => {
    expect(approveLeaveSchema.safeParse({ status: "APPROVED" }).success).toBe(true);
  });
  it("accepts REJECTED status with reason", () => {
    expect(
      approveLeaveSchema.safeParse({ status: "REJECTED", rejectionReason: "Coverage gap" })
        .success
    ).toBe(true);
  });
  it("rejects PENDING (not in approve-or-reject enum)", () => {
    expect(approveLeaveSchema.safeParse({ status: "PENDING" as any }).success).toBe(false);
  });
  it("rejects CANCELLED (not in approve-or-reject enum)", () => {
    expect(approveLeaveSchema.safeParse({ status: "CANCELLED" as any }).success).toBe(false);
  });
  it("rejects missing status", () => {
    expect(approveLeaveSchema.safeParse({}).success).toBe(false);
  });
});

describe("rejectLeaveSchema", () => {
  it("accepts a non-empty reason", () => {
    expect(rejectLeaveSchema.safeParse({ rejectionReason: "Insufficient balance" }).success).toBe(
      true
    );
  });
  it("rejects empty reason", () => {
    expect(rejectLeaveSchema.safeParse({ rejectionReason: "" }).success).toBe(false);
  });
  it("rejects missing reason", () => {
    expect(rejectLeaveSchema.safeParse({}).success).toBe(false);
  });
});

describe("leaveBalanceSchema", () => {
  const valid = {
    userId: UUID,
    type: "CASUAL" as const,
    year: 2026,
    entitled: 12,
  };
  it("accepts a minimal balance row", () => {
    expect(leaveBalanceSchema.safeParse(valid).success).toBe(true);
  });
  it("applies default carried=0", () => {
    const r = leaveBalanceSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.carried).toBe(0);
  });
  it("accepts explicit carried value", () => {
    const r = leaveBalanceSchema.safeParse({ ...valid, carried: 5 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.carried).toBe(5);
  });
  it("rejects non-uuid userId", () => {
    expect(leaveBalanceSchema.safeParse({ ...valid, userId: "abc" }).success).toBe(false);
  });
  it("rejects unknown leave type", () => {
    expect(
      leaveBalanceSchema.safeParse({ ...valid, type: "STUDY" as any }).success
    ).toBe(false);
  });
  it("rejects non-integer year", () => {
    expect(leaveBalanceSchema.safeParse({ ...valid, year: 2026.5 }).success).toBe(false);
  });
  it("rejects year below 2020", () => {
    expect(leaveBalanceSchema.safeParse({ ...valid, year: 2019 }).success).toBe(false);
  });
  it("rejects year above 2100", () => {
    expect(leaveBalanceSchema.safeParse({ ...valid, year: 2101 }).success).toBe(false);
  });
  it("accepts year boundary 2020", () => {
    expect(leaveBalanceSchema.safeParse({ ...valid, year: 2020 }).success).toBe(true);
  });
  it("accepts year boundary 2100", () => {
    expect(leaveBalanceSchema.safeParse({ ...valid, year: 2100 }).success).toBe(true);
  });
  it("rejects negative entitled", () => {
    expect(leaveBalanceSchema.safeParse({ ...valid, entitled: -1 }).success).toBe(false);
  });
  it("accepts entitled=0 (nonnegative boundary)", () => {
    expect(leaveBalanceSchema.safeParse({ ...valid, entitled: 0 }).success).toBe(true);
  });
  it("rejects negative carried", () => {
    expect(leaveBalanceSchema.safeParse({ ...valid, carried: -1 }).success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Holidays — Issue #292 + Issue #692
// ───────────────────────────────────────────────────────

describe("createHolidaySchema", () => {
  const valid = { date: "2026-08-15", name: "Independence Day" };
  it("accepts a minimal holiday and defaults type=PUBLIC", () => {
    const r = createHolidaySchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.type).toBe("PUBLIC");
  });
  it("accepts a holiday with type + description", () => {
    expect(
      createHolidaySchema.safeParse({
        ...valid,
        type: "OPTIONAL",
        description: "Regional festival",
      }).success
    ).toBe(true);
  });
  it("rejects malformed date", () => {
    expect(createHolidaySchema.safeParse({ ...valid, date: "Aug 15 2026" }).success).toBe(false);
  });
  it("rejects empty name (min 1)", () => {
    expect(createHolidaySchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });
  it("rejects name longer than 200 chars", () => {
    expect(
      createHolidaySchema.safeParse({ ...valid, name: "x".repeat(201) }).success
    ).toBe(false);
  });
  it("accepts name at exactly 200 chars", () => {
    expect(
      createHolidaySchema.safeParse({ ...valid, name: "x".repeat(200) }).success
    ).toBe(true);
  });
  it("rejects HTML in name (Issue #292)", () => {
    const r = createHolidaySchema.safeParse({
      ...valid,
      name: "Test Holiday <script>alert(1)</script>",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Cannot contain HTML or script content/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects javascript: URI in name", () => {
    expect(
      createHolidaySchema.safeParse({ ...valid, name: "javascript:alert(1)" }).success
    ).toBe(false);
  });
  it("rejects vbscript: URI in name", () => {
    expect(
      createHolidaySchema.safeParse({ ...valid, name: "VBScript:msgbox(1)" }).success
    ).toBe(false);
  });
  it("rejects data:text/html URI in name", () => {
    expect(
      createHolidaySchema.safeParse({
        ...valid,
        name: "data:text/html,<h1>x</h1>",
      }).success
    ).toBe(false);
  });
  it("rejects event-handler attribute in name (onerror= shape)", () => {
    expect(
      createHolidaySchema.safeParse({ ...valid, name: "Foo onerror=alert(1)" }).success
    ).toBe(false);
  });
  it("rejects bare < / > characters in name", () => {
    expect(createHolidaySchema.safeParse({ ...valid, name: "Foo <bar>" }).success).toBe(false);
  });
  it("accepts a clean apostrophe / dash in name", () => {
    expect(
      createHolidaySchema.safeParse({ ...valid, name: "St. Patrick's Day - Optional" }).success
    ).toBe(true);
  });
  it("rejects HTML in description", () => {
    expect(
      createHolidaySchema.safeParse({
        ...valid,
        description: "<img src=x onerror=alert(1)>",
      }).success
    ).toBe(false);
  });
  it("rejects description longer than 500 chars", () => {
    expect(
      createHolidaySchema.safeParse({ ...valid, description: "x".repeat(501) }).success
    ).toBe(false);
  });
  it("accepts description at exactly 500 chars", () => {
    expect(
      createHolidaySchema.safeParse({ ...valid, description: "x".repeat(500) }).success
    ).toBe(true);
  });
});

describe("updateHolidaySchema (Issue #692)", () => {
  it("accepts a single-field patch (date only)", () => {
    expect(updateHolidaySchema.safeParse({ date: "2026-08-15" }).success).toBe(true);
  });
  it("accepts a single-field patch (type only — PUBLIC↔OPTIONAL reclassification)", () => {
    expect(updateHolidaySchema.safeParse({ type: "OPTIONAL" }).success).toBe(true);
  });
  it("accepts a multi-field patch", () => {
    expect(
      updateHolidaySchema.safeParse({
        date: "2026-08-16",
        name: "Independence Day (observed)",
        type: "PUBLIC",
        description: "Shifted by one day",
      }).success
    ).toBe(true);
  });
  it("rejects an empty patch (refine: at least one field required)", () => {
    const r = updateHolidaySchema.safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /At least one field must be provided/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects HTML in name on update (Issue #292 carry-over to PATCH)", () => {
    expect(
      updateHolidaySchema.safeParse({ name: "<script>x</script>" }).success
    ).toBe(false);
  });
  it("rejects HTML in description on update", () => {
    expect(
      updateHolidaySchema.safeParse({ description: "<b>note</b>" }).success
    ).toBe(false);
  });
  it("rejects malformed date on update", () => {
    expect(updateHolidaySchema.safeParse({ date: "2026/08/15" }).success).toBe(false);
  });
  it("rejects empty name on update (min 1 inherited via _noHtmlString)", () => {
    expect(updateHolidaySchema.safeParse({ name: "" }).success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Payroll — Issue #283
// ───────────────────────────────────────────────────────

describe("payrollCalcSchema (Issue #283)", () => {
  const valid = {
    userId: UUID,
    year: 2026,
    month: 5,
    basicSalary: 50000,
  };
  it("accepts a minimal valid input (defaults zero-out allowances/deductions/overtime)", () => {
    const r = payrollCalcSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.allowances).toBe(0);
      expect(r.data.deductions).toBe(0);
      expect(r.data.overtimeRate).toBe(0);
    }
  });
  it("accepts a fully-populated input", () => {
    expect(
      payrollCalcSchema.safeParse({
        ...valid,
        allowances: 5000,
        deductions: 2000,
        overtimeRate: 1.5,
      }).success
    ).toBe(true);
  });
  it("rejects non-uuid userId", () => {
    expect(payrollCalcSchema.safeParse({ ...valid, userId: "abc" }).success).toBe(false);
  });
  it("rejects basicSalary = 0 (Issue #283: tightened from nonnegative to positive)", () => {
    const r = payrollCalcSchema.safeParse({ ...valid, basicSalary: 0 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) =>
          /Basic salary must be greater than 0/.test(i.message)
        )
      ).toBe(true);
    }
  });
  it("rejects basicSalary < 0 (Issue #283)", () => {
    expect(payrollCalcSchema.safeParse({ ...valid, basicSalary: -50000 }).success).toBe(false);
  });
  it("rejects non-integer year", () => {
    expect(payrollCalcSchema.safeParse({ ...valid, year: 2026.5 }).success).toBe(false);
  });
  it("rejects year below 2020 / above 2100", () => {
    expect(payrollCalcSchema.safeParse({ ...valid, year: 2019 }).success).toBe(false);
    expect(payrollCalcSchema.safeParse({ ...valid, year: 2101 }).success).toBe(false);
  });
  it("accepts year boundaries 2020 + 2100", () => {
    expect(payrollCalcSchema.safeParse({ ...valid, year: 2020 }).success).toBe(true);
    expect(payrollCalcSchema.safeParse({ ...valid, year: 2100 }).success).toBe(true);
  });
  it("rejects month < 1 / > 12", () => {
    expect(payrollCalcSchema.safeParse({ ...valid, month: 0 }).success).toBe(false);
    expect(payrollCalcSchema.safeParse({ ...valid, month: 13 }).success).toBe(false);
  });
  it("accepts month boundaries 1 + 12", () => {
    expect(payrollCalcSchema.safeParse({ ...valid, month: 1 }).success).toBe(true);
    expect(payrollCalcSchema.safeParse({ ...valid, month: 12 }).success).toBe(true);
  });
  it("rejects non-integer month", () => {
    expect(payrollCalcSchema.safeParse({ ...valid, month: 1.5 }).success).toBe(false);
  });
  it("rejects negative allowances", () => {
    expect(payrollCalcSchema.safeParse({ ...valid, allowances: -1 }).success).toBe(false);
  });
  it("rejects negative deductions", () => {
    expect(payrollCalcSchema.safeParse({ ...valid, deductions: -1 }).success).toBe(false);
  });
  it("rejects negative overtimeRate", () => {
    expect(payrollCalcSchema.safeParse({ ...valid, overtimeRate: -0.01 }).success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Certifications
// ───────────────────────────────────────────────────────

describe("certificationSchema", () => {
  const valid = {
    userId: UUID,
    type: "MEDICAL_LICENSE" as const,
    title: "MBBS Registration",
  };
  it("accepts a minimal certification", () => {
    expect(certificationSchema.safeParse(valid).success).toBe(true);
  });
  it("accepts a fully-populated certification", () => {
    expect(
      certificationSchema.safeParse({
        ...valid,
        issuingBody: "Medical Council of India",
        certNumber: "MCI/12345",
        issuedDate: "2018-07-01",
        expiryDate: "2028-07-01",
        documentPath: "/uploads/cert/12345.pdf",
        status: "ACTIVE",
        notes: "Renewed in 2023",
      }).success
    ).toBe(true);
  });
  it("rejects non-uuid userId", () => {
    expect(certificationSchema.safeParse({ ...valid, userId: "abc" }).success).toBe(false);
  });
  it("rejects unknown type", () => {
    expect(
      certificationSchema.safeParse({ ...valid, type: "PALS" as any }).success
    ).toBe(false);
  });
  it("rejects empty title", () => {
    expect(certificationSchema.safeParse({ ...valid, title: "" }).success).toBe(false);
  });
  it("rejects malformed issuedDate", () => {
    expect(certificationSchema.safeParse({ ...valid, issuedDate: "07/2018" }).success).toBe(
      false
    );
  });
  it("rejects malformed expiryDate", () => {
    expect(certificationSchema.safeParse({ ...valid, expiryDate: "2028" }).success).toBe(false);
  });
  it("rejects unknown status", () => {
    expect(
      certificationSchema.safeParse({ ...valid, status: "PENDING" as any }).success
    ).toBe(false);
  });
});

describe("updateCertificationSchema", () => {
  it("accepts an empty patch (omit+partial → all optional)", () => {
    expect(updateCertificationSchema.safeParse({}).success).toBe(true);
  });
  it("accepts a status-only patch", () => {
    expect(updateCertificationSchema.safeParse({ status: "RENEWED" }).success).toBe(true);
  });
  it("rejects userId in patch (omit()'d at schema level)", () => {
    const r = updateCertificationSchema.safeParse({ userId: UUID_2 } as any);
    // userId was omitted; with default Zod object behavior, unknown keys
    // are stripped silently — so parsing succeeds but the field doesn't
    // round-trip into the parsed output.
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as any).userId).toBeUndefined();
  });
  it("accepts a title patch", () => {
    expect(updateCertificationSchema.safeParse({ title: "Renewed BLS" }).success).toBe(true);
  });
  it("rejects empty title", () => {
    expect(updateCertificationSchema.safeParse({ title: "" }).success).toBe(false);
  });
  it("rejects malformed expiryDate", () => {
    expect(updateCertificationSchema.safeParse({ expiryDate: "tomorrow" }).success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Overtime
// ───────────────────────────────────────────────────────

describe("overtimeRecordSchema", () => {
  const valid = {
    userId: UUID,
    date: "2026-05-25",
    regularHours: 8,
    overtimeHours: 2,
    hourlyRate: 500,
  };
  it("accepts a minimal record and defaults overtimeRate=1.5", () => {
    const r = overtimeRecordSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.overtimeRate).toBe(1.5);
  });
  it("accepts an explicit overtimeRate", () => {
    const r = overtimeRecordSchema.safeParse({ ...valid, overtimeRate: 2 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.overtimeRate).toBe(2);
  });
  it("accepts notes", () => {
    expect(overtimeRecordSchema.safeParse({ ...valid, notes: "weekend OT" }).success).toBe(true);
  });
  it("rejects non-uuid userId", () => {
    expect(overtimeRecordSchema.safeParse({ ...valid, userId: "abc" }).success).toBe(false);
  });
  it("rejects malformed date", () => {
    expect(overtimeRecordSchema.safeParse({ ...valid, date: "25-May-2026" }).success).toBe(
      false
    );
  });
  it("rejects negative regularHours", () => {
    expect(overtimeRecordSchema.safeParse({ ...valid, regularHours: -1 }).success).toBe(false);
  });
  it("accepts regularHours=0 (nonnegative boundary)", () => {
    expect(overtimeRecordSchema.safeParse({ ...valid, regularHours: 0 }).success).toBe(true);
  });
  it("rejects negative overtimeHours", () => {
    expect(overtimeRecordSchema.safeParse({ ...valid, overtimeHours: -1 }).success).toBe(false);
  });
  it("accepts overtimeHours=0", () => {
    expect(overtimeRecordSchema.safeParse({ ...valid, overtimeHours: 0 }).success).toBe(true);
  });
  it("rejects negative hourlyRate", () => {
    expect(overtimeRecordSchema.safeParse({ ...valid, hourlyRate: -1 }).success).toBe(false);
  });
  it("accepts hourlyRate=0", () => {
    expect(overtimeRecordSchema.safeParse({ ...valid, hourlyRate: 0 }).success).toBe(true);
  });
  it("rejects overtimeRate=0 (positive constraint)", () => {
    expect(overtimeRecordSchema.safeParse({ ...valid, overtimeRate: 0 }).success).toBe(false);
  });
  it("rejects negative overtimeRate", () => {
    expect(overtimeRecordSchema.safeParse({ ...valid, overtimeRate: -1 }).success).toBe(false);
  });
});

describe("autoOvertimeSchema", () => {
  const valid = { year: 2026, month: 5 };
  it("accepts a minimal request and applies all defaults", () => {
    const r = autoOvertimeSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.defaultHourlyRate).toBe(0);
      expect(r.data.regularHoursPerDay).toBe(8);
      expect(r.data.overtimeRate).toBe(1.5);
      expect(r.data.userId).toBeUndefined();
    }
  });
  it("accepts an optional userId scoping", () => {
    expect(autoOvertimeSchema.safeParse({ ...valid, userId: UUID }).success).toBe(true);
  });
  it("rejects non-uuid userId", () => {
    expect(autoOvertimeSchema.safeParse({ ...valid, userId: "abc" }).success).toBe(false);
  });
  it("rejects non-integer year", () => {
    expect(autoOvertimeSchema.safeParse({ ...valid, year: 2026.5 }).success).toBe(false);
  });
  it("rejects year below 2020 / above 2100", () => {
    expect(autoOvertimeSchema.safeParse({ ...valid, year: 2019 }).success).toBe(false);
    expect(autoOvertimeSchema.safeParse({ ...valid, year: 2101 }).success).toBe(false);
  });
  it("accepts year boundaries", () => {
    expect(autoOvertimeSchema.safeParse({ ...valid, year: 2020 }).success).toBe(true);
    expect(autoOvertimeSchema.safeParse({ ...valid, year: 2100 }).success).toBe(true);
  });
  it("rejects month < 1 / > 12", () => {
    expect(autoOvertimeSchema.safeParse({ ...valid, month: 0 }).success).toBe(false);
    expect(autoOvertimeSchema.safeParse({ ...valid, month: 13 }).success).toBe(false);
  });
  it("rejects non-integer month", () => {
    expect(autoOvertimeSchema.safeParse({ ...valid, month: 5.5 }).success).toBe(false);
  });
  it("rejects negative defaultHourlyRate", () => {
    expect(autoOvertimeSchema.safeParse({ ...valid, defaultHourlyRate: -1 }).success).toBe(
      false
    );
  });
  it("accepts defaultHourlyRate=0", () => {
    expect(autoOvertimeSchema.safeParse({ ...valid, defaultHourlyRate: 0 }).success).toBe(true);
  });
  it("rejects regularHoursPerDay=0 (positive constraint)", () => {
    expect(autoOvertimeSchema.safeParse({ ...valid, regularHoursPerDay: 0 }).success).toBe(
      false
    );
  });
  it("rejects negative regularHoursPerDay", () => {
    expect(autoOvertimeSchema.safeParse({ ...valid, regularHoursPerDay: -1 }).success).toBe(
      false
    );
  });
  it("rejects overtimeRate=0 (positive constraint)", () => {
    expect(autoOvertimeSchema.safeParse({ ...valid, overtimeRate: 0 }).success).toBe(false);
  });
  it("rejects negative overtimeRate", () => {
    expect(autoOvertimeSchema.safeParse({ ...valid, overtimeRate: -1 }).success).toBe(false);
  });
});
