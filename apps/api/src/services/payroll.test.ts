// Unit tests for the shared payroll computation. The same `computePayroll`
// is used by:
//   * POST /hr-ops/payroll  — the dashboard table
//   * generatePaySlipHTML   — the printable salary slip
// so these assertions are the contract for "Net Pay on the slip == Net Pay
// in the table" parity, plus the FY-2026 ESI ceiling guard.

import { describe, it, expect } from "vitest";
import {
  computePayroll,
  ESI_GROSS_CEILING,
} from "./payroll";

describe("computePayroll — ESI ceiling (FY 2026)", () => {
  it("applies ESI when gross wages are at or below ₹21,000", () => {
    const r = computePayroll({
      basicSalary: 18000,
      allowances: 2000, // gross = 20,000
      shifts: [],
    });
    expect(r.gross).toBe(20000);
    expect(r.esiApplicable).toBe(true);
    // 0.75% of 20,000 = 150
    expect(r.esi).toBe(150);
  });

  it("applies ESI exactly at the ceiling boundary (gross = ₹21,000)", () => {
    const r = computePayroll({
      basicSalary: 21000,
      shifts: [],
    });
    expect(r.gross).toBe(ESI_GROSS_CEILING);
    expect(r.esiApplicable).toBe(true);
    expect(r.esi).toBe(Math.round(21000 * 0.0075)); // 158
  });

  it("skips ESI when gross wages exceed the ₹21,000 ceiling", () => {
    const r = computePayroll({
      basicSalary: 30000,
      allowances: 5000, // gross = 35,000
      shifts: [],
    });
    expect(r.gross).toBe(35000);
    expect(r.esiApplicable).toBe(false);
    expect(r.esi).toBe(0);
  });

  it("does not double-count overtime when checking the ESI ceiling", () => {
    // Basic 20k pushes us under the ceiling, but a single OT shift takes us
    // above it. ESI must drop to zero.
    const r = computePayroll({
      basicSalary: 20000,
      overtimeRate: 200,
      shifts: [{ status: "PRESENT", type: "NIGHT" }], // +200*8 = 1,600 OT pay
    });
    expect(r.overtimePay).toBe(1600);
    expect(r.gross).toBe(21600);
    expect(r.esiApplicable).toBe(false);
    expect(r.esi).toBe(0);
  });
});

describe("computePayroll — Days Worked from shifts", () => {
  it("counts PRESENT and LATE as worked", () => {
    const r = computePayroll({
      basicSalary: 30000,
      shifts: [
        { status: "PRESENT" },
        { status: "PRESENT" },
        { status: "LATE" },
        { status: "ABSENT" },
        { status: "LEAVE" },
        { status: "SCHEDULED" },
      ],
    });
    expect(r.scheduledDays).toBe(6);
    expect(r.workedDays).toBe(3); // 2 PRESENT + 1 LATE
    expect(r.absentDays).toBe(1);
    expect(r.leaveDays).toBe(1);
  });

  it("returns 0 worked / 0 scheduled when no shifts exist (does not crash)", () => {
    const r = computePayroll({ basicSalary: 30000, shifts: [] });
    expect(r.scheduledDays).toBe(0);
    expect(r.workedDays).toBe(0);
    expect(r.absentPenalty).toBe(0);
  });
});

describe("computePayroll — Net Pay parity (table === slip)", () => {
  // The contract: given the same inputs, the slip and the dashboard MUST
  // arrive at the same Net Pay. We assert the formula directly so the
  // shape never silently drifts.

  it("net = gross - (pf + esi + absentPenalty + otherDeductions) [legacy: no daysInMonth]", () => {
    const r = computePayroll({
      basicSalary: 18000,
      allowances: 1500,
      deductions: 500,
      shifts: [
        { status: "PRESENT" },
        { status: "PRESENT" },
        { status: "ABSENT" },
        { status: "ABSENT" },
      ],
    });
    expect(r.gross).toBe(19500);
    expect(r.pf).toBe(Math.round(18000 * 0.12)); // 2160
    // 19,500 <= 21,000 -> ESI applies
    expect(r.esi).toBe(Math.round(19500 * 0.0075)); // 146
    // 2 absent / 4 scheduled = 50 % of basic
    expect(r.absentPenalty).toBeCloseTo(9000, 2);
    expect(r.otherDeductions).toBe(500);
    expect(r.totalDeductions).toBeCloseTo(
      r.pf + r.esi + r.absentPenalty + r.otherDeductions,
      2
    );
    expect(r.net).toBeCloseTo(r.gross - r.totalDeductions, 2);
  });

  it("identical inputs yield identical Net Pay (slip <-> table)", () => {
    const inputs = {
      basicSalary: 30000,
      allowances: 5000,
      deductions: 1000,
      overtimeRate: 250,
      daysInMonth: 30,
      shifts: [
        { status: "PRESENT", type: "DAY" },
        { status: "PRESENT", type: "NIGHT" },
        { status: "ABSENT", type: "DAY" },
      ],
    };
    const a = computePayroll(inputs);
    const b = computePayroll(inputs);
    expect(a.net).toBe(b.net);
    expect(a.gross).toBe(b.gross);
    expect(a.workedDays).toBe(b.workedDays);
  });
});

// ── Issue #701/#702 — pro-rated Basic by days worked ──────
describe("computePayroll — pro-rated Basic (issue #701/#702)", () => {
  it("0 days worked → 0 Net Pay (NOT 88% of Basic)", () => {
    // Old bug: with no PRESENT/LATE shifts, scheduledDays could be 0
    // → absentPenalty = 0 → net = basic - PF = 88% of basic.
    // New behaviour: caller passes daysInMonth=30 + 30 ABSENT shifts;
    // proRatedBasic = (basic/30)*0 = 0; gross = 0; PF = 0; ESI = 0;
    // net = 0 (no absent penalty layered on top — already pro-rated).
    const shifts = Array.from({ length: 30 }, () => ({ status: "ABSENT" }));
    const r = computePayroll({
      basicSalary: 50000,
      daysInMonth: 30,
      shifts,
    });
    expect(r.workedDays).toBe(0);
    expect(r.proRatedBasic).toBe(0);
    expect(r.gross).toBe(0);
    expect(r.pf).toBe(0);
    expect(r.esi).toBe(0);
    expect(r.absentPenalty).toBe(0);
    expect(r.net).toBe(0);
  });

  it("partial-month: 15 days worked of 30 → Basic / Net halve", () => {
    const shifts = [
      ...Array.from({ length: 15 }, () => ({ status: "PRESENT" })),
      ...Array.from({ length: 15 }, () => ({ status: "ABSENT" })),
    ];
    const r = computePayroll({
      basicSalary: 60000,
      daysInMonth: 30,
      shifts,
    });
    expect(r.workedDays).toBe(15);
    expect(r.proRatedBasic).toBe(30000); // (60000 / 30) * 15
    // Gross = 30000 (no allowances/OT). PF = 12% of 30000 = 3600.
    // ESI not applicable (gross > 21000).
    expect(r.gross).toBe(30000);
    expect(r.pf).toBe(3600);
    expect(r.esi).toBe(0);
    expect(r.absentPenalty).toBe(0); // baked into pro-rating
    expect(r.net).toBe(26400);
  });

  it("ESI applies only when gross ≤ ₹21,000 — boundary at 21,001", () => {
    // Pro-rated basic 21001 (gross 21001, no allowances) -> ESI must drop to 0.
    // Choose daysInMonth=21000, workedDays=21001 to land exactly on 21001 isn't
    // possible (worked > scheduled). Use full-month worked at basic=21001.
    const shifts = Array.from({ length: 30 }, () => ({ status: "PRESENT" }));
    const above = computePayroll({
      basicSalary: 21001,
      daysInMonth: 30,
      shifts,
    });
    expect(above.gross).toBeCloseTo(21001, 2);
    expect(above.esiApplicable).toBe(false);
    expect(above.esi).toBe(0);

    const at = computePayroll({
      basicSalary: 21000,
      daysInMonth: 30,
      shifts,
    });
    expect(at.gross).toBe(21000);
    expect(at.esiApplicable).toBe(true);
    expect(at.esi).toBe(Math.round(21000 * 0.0075));
  });

  it("legacy callers (no daysInMonth) keep the old absentPenalty behavior", () => {
    // Back-compat guard: the slip generator's existing callers and any
    // test that didn't pass daysInMonth must still see PF on full basic
    // and the historic absent-penalty line.
    const r = computePayroll({
      basicSalary: 18000,
      shifts: [
        { status: "PRESENT" },
        { status: "ABSENT" },
      ],
    });
    expect(r.proRatedBasic).toBe(18000); // unchanged
    expect(r.absentPenalty).toBe(9000); // 1/2 of basic
    expect(r.daysInMonth).toBe(0); // signal: caller didn't opt in
  });
});
