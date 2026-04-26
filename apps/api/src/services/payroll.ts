// Shared payroll computation service.
//
// Single source of truth for payroll math. Both the calc endpoint
// (POST /hr-ops/payroll) and the salary slip generator must use this
// helper so the Net Pay shown in the dashboard table matches the Net
// Pay printed on the slip.
//
// FY 2026 statutory rules:
//   - PF (Provident Fund): 12% of basic salary (employee share)
//   - ESI: 0.75% of GROSS WAGES, but ONLY when grossWages <= 21,000/month.
//          Above the ceiling, ESI deduction is zero.

// ESI ceiling — FY 2026
export const ESI_GROSS_CEILING = 21000;
export const ESI_EMPLOYEE_RATE = 0.0075; // 0.75 %
export const PF_RATE = 0.12; // 12 % of basic

export interface ShiftLite {
  status: string; // "PRESENT" | "LATE" | "ABSENT" | "LEAVE" | "SCHEDULED"
  type?: string | null; // optional "NIGHT" | "ON_CALL" | ...
}

export interface OvertimeRecordLite {
  amount?: number | null;
  approved?: boolean | null;
}

export interface PayrollInput {
  basicSalary: number;
  allowances?: number;
  deductions?: number; // ad-hoc / "other" deductions on top of statutory
  overtimeRate?: number; // per-hour rate for the simple shift heuristic
  shifts: ShiftLite[];
  approvedOvertime?: OvertimeRecordLite[];
}

export interface PayrollResult {
  // Earnings
  basicSalary: number;
  allowances: number;
  overtimeShifts: number;
  overtimePay: number;
  approvedOvertimePay: number;
  gross: number; // basic + allowances + overtime + approvedOvertime
  // Days
  workedDays: number;
  scheduledDays: number;
  leaveDays: number;
  absentDays: number;
  // Deductions
  absentPenalty: number;
  pf: number;
  esi: number;
  esiApplicable: boolean;
  otherDeductions: number;
  totalDeductions: number; // pf + esi + other + absentPenalty
  // Net
  net: number;
}

function round2(n: number): number {
  return +n.toFixed(2);
}

/**
 * Pure payroll calculation. Given basic + allowances + shifts + approved
 * overtime, returns a fully resolved payroll record with statutory
 * deductions applied (PF 12 % of basic, ESI 0.75 % of gross only when
 * gross <= ₹21 000).
 */
export function computePayroll(input: PayrollInput): PayrollResult {
  const basicSalary = input.basicSalary;
  const allowances = input.allowances ?? 0;
  const otherDeductions = input.deductions ?? 0;
  const overtimeRate = input.overtimeRate ?? 0;

  const shifts = input.shifts ?? [];
  const scheduledDays = shifts.length;
  const workedDays = shifts.filter(
    (s) => s.status === "PRESENT" || s.status === "LATE"
  ).length;
  const leaveDays = shifts.filter((s) => s.status === "LEAVE").length;
  const absentDays = shifts.filter((s) => s.status === "ABSENT").length;

  // Simple-heuristic overtime: NIGHT / ON_CALL shifts that were worked
  const overtimeShifts = shifts.filter(
    (s) =>
      (s.type === "NIGHT" || s.type === "ON_CALL") &&
      (s.status === "PRESENT" || s.status === "LATE")
  ).length;
  const overtimePay = overtimeShifts * overtimeRate * 8; // 8 hr default

  const approvedOvertimePay = (input.approvedOvertime ?? [])
    .filter((r) => r.approved)
    .reduce((sum, r) => sum + (r.amount ?? 0), 0);

  const gross = basicSalary + allowances + overtimePay + approvedOvertimePay;

  // Statutory deductions
  const pf = Math.round(basicSalary * PF_RATE);
  const esiApplicable = gross <= ESI_GROSS_CEILING;
  const esi = esiApplicable ? Math.round(gross * ESI_EMPLOYEE_RATE) : 0;

  const absentPenalty =
    scheduledDays > 0 ? (absentDays / scheduledDays) * basicSalary : 0;

  const totalDeductions = pf + esi + otherDeductions + absentPenalty;
  const net = gross - totalDeductions;

  return {
    basicSalary: round2(basicSalary),
    allowances: round2(allowances),
    overtimeShifts,
    overtimePay: round2(overtimePay),
    approvedOvertimePay: round2(approvedOvertimePay),
    gross: round2(gross),
    workedDays,
    scheduledDays,
    leaveDays,
    absentDays,
    absentPenalty: round2(absentPenalty),
    pf: round2(pf),
    esi: round2(esi),
    esiApplicable,
    otherDeductions: round2(otherDeductions),
    totalDeductions: round2(totalDeductions),
    net: round2(net),
  };
}

