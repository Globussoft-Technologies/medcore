// Shared payroll computation service.
//
// Single source of truth for payroll math. Both the calc endpoint
// (POST /hr-ops/payroll) and the salary slip generator must use this
// helper so the Net Pay shown in the dashboard table matches the Net
// Pay printed on the slip.
//
// FY 2026 statutory rules:
//   - PF (Provident Fund): 12% of (pro-rated) basic salary (employee share)
//   - ESI: 0.75% of GROSS WAGES, but ONLY when grossWages <= 21,000/month.
//          Above the ceiling, ESI deduction is zero.
//
// Issue #701/#702 (2026-05-08): Net Pay used to come out to ~88% of the
// configured Basic regardless of Days Worked (the old code applied PF on
// the FULL basic and added an "absentPenalty" line on top — but when there
// were NO recorded shifts at all, scheduledDays was 0 → absentPenalty was
// 0 → net was just basic - PF = 88% of basic). The fix: when the caller
// supplies `daysInMonth` AND there is attendance data (scheduledDays > 0),
// pro-rate Basic by `workedDays / daysInMonth`; the absent-penalty line is
// then redundant (already baked into the day-based netBasic) and zeros
// out. Result: 0 days worked → netBasic = 0 → Net Pay reflects allowances
// minus deductions, not 88% of the configured basic.

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
  // When provided AND scheduledDays > 0, Basic is pro-rated by
  // (workedDays / daysInMonth) — see header comment. Optional so that
  // legacy callers (and the slip's overrides surface) keep behaving the
  // same when no attendance is recorded.
  daysInMonth?: number;
}

export interface PayrollResult {
  // Earnings
  basicSalary: number; // configured (full-month) basic
  proRatedBasic: number; // basic actually credited this run (== basicSalary when no pro-rating)
  allowances: number;
  overtimeShifts: number;
  overtimePay: number;
  approvedOvertimePay: number;
  gross: number; // proRatedBasic + allowances + overtime + approvedOvertime
  // Days
  workedDays: number;
  scheduledDays: number;
  leaveDays: number;
  absentDays: number;
  daysInMonth: number; // 0 when caller didn't supply it
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
 * deductions applied (PF 12 % of pro-rated basic, ESI 0.75 % of gross
 * only when gross <= ₹21 000).
 *
 * Pro-rating (issue #701/#702): when `daysInMonth` is supplied AND there
 * is attendance data (scheduledDays > 0), Basic is multiplied by
 * (workedDays / daysInMonth) so an employee with 0 days worked gets a
 * Net Pay of (allowances − otherDeductions) rather than 88 % of full
 * Basic. The absent-penalty line is then 0 (already baked into the
 * day-based netBasic). When `daysInMonth` is omitted (legacy callers,
 * tests asserting the old shape), behavior is unchanged: full Basic +
 * the historic absent-penalty calculation.
 */
export function computePayroll(input: PayrollInput): PayrollResult {
  const basicSalary = input.basicSalary;
  const allowances = input.allowances ?? 0;
  const otherDeductions = input.deductions ?? 0;
  const overtimeRate = input.overtimeRate ?? 0;
  const daysInMonth = input.daysInMonth ?? 0;

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

  // Pro-rated Basic — only when caller opted in AND there's actual
  // attendance to read. If neither is true we keep the full configured
  // basic so legacy slip generators (no attendance plumbed yet) still
  // produce the same numbers.
  const prorateActive = daysInMonth > 0 && scheduledDays > 0;
  const proRatedBasic = prorateActive
    ? (basicSalary / daysInMonth) * workedDays
    : basicSalary;

  const gross = proRatedBasic + allowances + overtimePay + approvedOvertimePay;

  // Statutory deductions — PF on the pro-rated basic (so 0 days worked →
  // PF is 0 too, not 12 % of an unpaid full basic).
  const pf = Math.round(proRatedBasic * PF_RATE);
  const esiApplicable = gross <= ESI_GROSS_CEILING;
  const esi = esiApplicable ? Math.round(gross * ESI_EMPLOYEE_RATE) : 0;

  // When pro-rating is active, the absent penalty is already in the
  // pro-rated basic — adding it again would double-deduct.
  const absentPenalty = prorateActive
    ? 0
    : scheduledDays > 0
      ? (absentDays / scheduledDays) * basicSalary
      : 0;

  const totalDeductions = pf + esi + otherDeductions + absentPenalty;
  const net = gross - totalDeductions;

  return {
    basicSalary: round2(basicSalary),
    proRatedBasic: round2(proRatedBasic),
    allowances: round2(allowances),
    overtimeShifts,
    overtimePay: round2(overtimePay),
    approvedOvertimePay: round2(approvedOvertimePay),
    gross: round2(gross),
    workedDays,
    scheduledDays,
    leaveDays,
    absentDays,
    daysInMonth,
    absentPenalty: round2(absentPenalty),
    pf: round2(pf),
    esi: round2(esi),
    esiApplicable,
    otherDeductions: round2(otherDeductions),
    totalDeductions: round2(totalDeductions),
    net: round2(net),
  };
}

/**
 * Convenience: number of days in a (year, 1-indexed month) — Sunday-aware
 * via UTC so DST transitions don't throw the count off.
 */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

