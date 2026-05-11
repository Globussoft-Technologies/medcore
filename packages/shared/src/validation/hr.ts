import { z } from "zod";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const timeString = z.string().regex(/^\d{2}:\d{2}$/, "Expected HH:MM");

export const shiftTypeEnum = z.enum([
  "MORNING",
  "AFTERNOON",
  "NIGHT",
  "ON_CALL",
]);

export const shiftStatusEnum = z.enum([
  "SCHEDULED",
  "PRESENT",
  "ABSENT",
  "LATE",
  "LEAVE",
]);

export const leaveTypeEnum = z.enum([
  "CASUAL",
  "SICK",
  "EARNED",
  "MATERNITY",
  "PATERNITY",
  "UNPAID",
]);

export const leaveStatusEnum = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
]);

export const createShiftSchema = z.object({
  userId: z.string().uuid(),
  date: dateString,
  type: shiftTypeEnum,
  startTime: timeString,
  endTime: timeString,
  notes: z.string().optional(),
});

export const bulkShiftSchema = z.object({
  shifts: z.array(createShiftSchema).min(1),
});

export const updateShiftSchema = z.object({
  date: dateString.optional(),
  type: shiftTypeEnum.optional(),
  startTime: timeString.optional(),
  endTime: timeString.optional(),
  status: shiftStatusEnum.optional(),
  notes: z.string().optional(),
});

export const updateShiftStatusSchema = z.object({
  status: shiftStatusEnum,
  notes: z.string().optional(),
});

export const checkOutShiftSchema = z.object({
  notes: z.string().optional(),
});

export const createLeaveRequestSchema = z
  .object({
    type: leaveTypeEnum,
    fromDate: dateString,
    toDate: dateString,
    reason: z.string().min(1, "Reason is required"),
  })
  .refine(
    (v) => new Date(v.fromDate).getTime() <= new Date(v.toDate).getTime(),
    { message: "toDate must be on or after fromDate", path: ["toDate"] }
  );

export const approveLeaveSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  rejectionReason: z.string().optional(),
});

export const rejectLeaveSchema = z.object({
  rejectionReason: z.string().min(1, "Rejection reason is required"),
});

// ─── Leave Balance ─────────────────────────────────────
export const leaveBalanceSchema = z.object({
  userId: z.string().uuid(),
  type: leaveTypeEnum,
  year: z.number().int().min(2020).max(2100),
  entitled: z.number().nonnegative(),
  carried: z.number().nonnegative().default(0),
});

// Default annual entitlement per leave type (days)
export const DEFAULT_LEAVE_ENTITLEMENT: Record<string, number> = {
  CASUAL: 12,
  SICK: 12,
  EARNED: 20,
  MATERNITY: 180,
  PATERNITY: 15,
  UNPAID: 0,
};

// ─── Holidays ──────────────────────────────────────────
// Issue #292 (Apr 2026): the prior `z.string().min(1)` allowed
// `Test Holiday <script>alert(1)</script>` to round-trip. The server's
// "partial strip" then persisted the orphan `Test Holiday alert(1)` —
// which looked like a typo, was unlogged, and wedged the holiday calendar.
// Strict rejection on `<` `>` and known XSS vectors.
const _noHtmlString = (max: number) =>
  z
    .string()
    .min(1, "Required")
    .max(max, `Max ${max} characters`)
    .refine(
      (v) =>
        !/<[^>]*>|javascript:|vbscript:|data:\s*text\/html|\bon\w+\s*=/i.test(
          v
        ),
      { message: "Cannot contain HTML or script content" }
    );

export const createHolidaySchema = z.object({
  date: dateString,
  name: _noHtmlString(200),
  type: z.string().default("PUBLIC"),
  description: _noHtmlString(500).optional(),
});

// Issue #692 (BUG-A08): the admin Holidays page lacked an Edit
// affordance — typo correction or PUBLIC↔OPTIONAL reclassification
// required deleting and re-creating the row, which broke the audit
// trail. PATCH /hr-ops/holidays/:id now uses this schema. All fields
// are optional so the FE can send only what changed; date stays
// ISO-string (YYYY-MM-DD) and the no-HTML guard mirrors the create
// schema so an XSS payload can't be smuggled in via an Edit either.
export const updateHolidaySchema = z
  .object({
    date: dateString.optional(),
    name: _noHtmlString(200).optional(),
    type: z.string().optional(),
    description: _noHtmlString(500).optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    { message: "At least one field must be provided" }
  );

// ─── Payroll (simple calculation) ──────────────────────
// Issue #283 (2026-04-26): basicSalary was `.nonnegative()`, which let
// negative values slip through if the user pasted "-50000" into the form
// (the HTML number input doesn't enforce min on paste). Tighten to
// `.positive()` so the API rejects both "0" (a clear data-entry slip)
// and negatives at the validation layer instead of the database.
export const payrollCalcSchema = z.object({
  userId: z.string().uuid(),
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  basicSalary: z
    .number()
    .positive("Basic salary must be greater than 0"),
  allowances: z.number().nonnegative().default(0),
  deductions: z.number().nonnegative().default(0),
  overtimeRate: z.number().nonnegative().default(0),
});

export type CreateShiftInput = z.infer<typeof createShiftSchema>;
export type BulkShiftInput = z.infer<typeof bulkShiftSchema>;
export type UpdateShiftInput = z.infer<typeof updateShiftSchema>;
export type UpdateShiftStatusInput = z.infer<typeof updateShiftStatusSchema>;
export type CheckOutShiftInput = z.infer<typeof checkOutShiftSchema>;
export type CreateLeaveRequestInput = z.infer<typeof createLeaveRequestSchema>;
export type ApproveLeaveInput = z.infer<typeof approveLeaveSchema>;
export type RejectLeaveInput = z.infer<typeof rejectLeaveSchema>;
export type LeaveBalanceInput = z.infer<typeof leaveBalanceSchema>;
export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;
export type UpdateHolidayInput = z.infer<typeof updateHolidaySchema>;
export type PayrollCalcInput = z.infer<typeof payrollCalcSchema>;

// ─── STAFF CERTIFICATIONS ───────────────────────────────

export const CertificationTypeEnum = z.enum([
  "MEDICAL_LICENSE",
  "NURSING_CERT",
  "BLS",
  "ACLS",
  "TRAINING",
  "OTHER",
]);

export const CertificationStatusEnum = z.enum([
  "ACTIVE",
  "EXPIRED",
  "RENEWED",
  "REVOKED",
]);

export const certificationSchema = z.object({
  userId: z.string().uuid(),
  type: CertificationTypeEnum,
  title: z.string().min(1),
  issuingBody: z.string().optional(),
  certNumber: z.string().optional(),
  issuedDate: dateString.optional(),
  expiryDate: dateString.optional(),
  documentPath: z.string().optional(),
  status: CertificationStatusEnum.optional(),
  notes: z.string().optional(),
});

export const updateCertificationSchema = certificationSchema
  .omit({ userId: true })
  .partial();

export type CertificationInput = z.infer<typeof certificationSchema>;
export type UpdateCertificationInput = z.infer<typeof updateCertificationSchema>;

// ─── OVERTIME RECORDS ───────────────────────────────────

export const overtimeRecordSchema = z.object({
  userId: z.string().uuid(),
  date: dateString,
  regularHours: z.number().nonnegative(),
  overtimeHours: z.number().nonnegative(),
  hourlyRate: z.number().nonnegative(),
  overtimeRate: z.number().positive().default(1.5),
  notes: z.string().optional(),
});

export const autoOvertimeSchema = z.object({
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  userId: z.string().uuid().optional(),
  defaultHourlyRate: z.number().nonnegative().default(0),
  regularHoursPerDay: z.number().positive().default(8),
  overtimeRate: z.number().positive().default(1.5),
});

export type OvertimeRecordInput = z.infer<typeof overtimeRecordSchema>;
export type AutoOvertimeInput = z.infer<typeof autoOvertimeSchema>;
