// Issue #76 (Apr 2026) — Total-Spent KPI must include uncategorised spend.
//
// Bug: Budgets dashboard reported "Total Spent" = sum(rows.actual) where rows
// are derived from budgets that exist. So a category with no budget set (e.g.
// Equipment ₹85k) silently disappeared from the headline. Variance was right
// (Variance = Spent - Budget on budgeted-only data) but the headline KPI lied.
//
// Fix: API now returns `totalSpent` = sum of ALL approved expenses for the
// month, plus `totalVarianceBudgetedOnly` for the variance card. This pure
// unit test mirrors the aggregation in `apps/api/src/routes/expenses.ts`.
import { describe, it, expect } from "vitest";

interface BudgetRow {
  category: string;
  amount: number;
}
interface ExpenseRow {
  category: string;
  amount: number;
}

function aggregate(budgets: BudgetRow[], expenses: ExpenseRow[]) {
  const actualByCat: Record<string, number> = {};
  for (const e of expenses) {
    actualByCat[e.category] = (actualByCat[e.category] || 0) + e.amount;
  }
  // Issue #699 (BUG-A19) — utilisation is the canonical formula returned
  // ONCE from the server so the FE has a single field to read across the
  // row pill / "Utilisation: N%" label / View Details modal. Mirrors the
  // production aggregator in apps/api/src/routes/expenses.ts.
  const rows = budgets.map((b) => {
    const actual = +(actualByCat[b.category] || 0).toFixed(2);
    const utilisation =
      b.amount > 0 ? Math.round((actual / b.amount) * 100) : 0;
    return {
      category: b.category,
      budget: b.amount,
      actual,
      variance: +(actual - b.amount).toFixed(2),
      utilisation,
    };
  });
  const totalSpent = +Object.values(actualByCat)
    .reduce((s, v) => s + v, 0)
    .toFixed(2);
  const totalBudget = +budgets.reduce((s, b) => s + b.amount, 0).toFixed(2);
  const totalBudgetedActual = +rows.reduce((s, r) => s + r.actual, 0).toFixed(2);
  const totalVarianceBudgetedOnly = +(totalBudgetedActual - totalBudget).toFixed(2);
  const uncategorizedActual = Object.entries(actualByCat)
    .filter(([c]) => !budgets.some((b) => b.category === c))
    .map(([category, actual]) => ({ category, actual }));
  return {
    rows,
    totalBudget,
    totalSpent,
    totalVarianceBudgetedOnly,
    uncategorizedActual,
  };
}

describe("Budgets KPI — totalSpent includes unbudgeted categories", () => {
  it("returns zeros on empty data", () => {
    const r = aggregate([], []);
    expect(r.totalBudget).toBe(0);
    expect(r.totalSpent).toBe(0);
    expect(r.totalVarianceBudgetedOnly).toBe(0);
    expect(r.uncategorizedActual).toEqual([]);
  });

  it("includes Equipment spend even though no Equipment budget exists", () => {
    // Repro of the original bug — SALARY budgeted, EQUIPMENT spent without a
    // budget. Old code dropped the EQUIPMENT spend entirely.
    const r = aggregate(
      [{ category: "SALARY", amount: 200_000 }],
      [
        { category: "SALARY", amount: 180_000 },
        { category: "EQUIPMENT", amount: 85_000 },
      ]
    );
    expect(r.totalBudget).toBe(200_000);
    // Total Spent = 180k + 85k = 265k (not just 180k).
    expect(r.totalSpent).toBe(265_000);
    // Variance is computed against budgeted-only spend so the missing
    // EQUIPMENT budget doesn't poison the over/under signal.
    expect(r.totalVarianceBudgetedOnly).toBe(-20_000);
    expect(r.uncategorizedActual).toEqual([
      { category: "EQUIPMENT", actual: 85_000 },
    ]);
  });

  it("Variance = totalBudgetedActual - totalBudget (not totalSpent - totalBudget)", () => {
    const r = aggregate(
      [{ category: "RENT", amount: 50_000 }],
      [
        { category: "RENT", amount: 60_000 }, // 10k over
        { category: "OTHER", amount: 100_000 }, // unbudgeted
      ]
    );
    expect(r.totalSpent).toBe(160_000);
    // Variance only sees RENT 60k actual vs 50k budget → 10k over.
    expect(r.totalVarianceBudgetedOnly).toBe(10_000);
  });
});

// Issue #699 (BUG-A19) — utilisation must be a single canonical figure.
// Repro of the original bug: the server returned `utilisation` rounded to
// 1 decimal place (toFixed(1)) while the FE recomputed Math.round() of
// the same fraction, and the View Details modal computed yet another
// Math.round of (actual/budget)*100. On a row like actual=999, budget=1000
// the user saw 99.9% in one place and 100% in another. Server is now the
// single source: round(actual/budget*100) returned ONCE per row.
describe("Issue #699 — utilisation is canonically round(actual/budget*100)", () => {
  it("returns 0% utilisation when budget is zero (no division by zero)", () => {
    const r = aggregate(
      [{ category: "MARKETING", amount: 0 }],
      [{ category: "MARKETING", amount: 0 }]
    );
    expect(r.rows[0].utilisation).toBe(0);
  });

  it("rounds 99.9% to 100% so card / pill / modal show the same number", () => {
    // The exact actual=999/budget=1000 case that broke before #699.
    const r = aggregate(
      [{ category: "RENT", amount: 1000 }],
      [{ category: "RENT", amount: 999 }]
    );
    expect(r.rows[0].utilisation).toBe(100);
  });

  it("computes utilisation = round(actual/budget*100) for every row", () => {
    const r = aggregate(
      [
        { category: "SALARY", amount: 200_000 },
        { category: "RENT", amount: 50_000 },
        { category: "UTILITIES", amount: 10_000 },
      ],
      [
        { category: "SALARY", amount: 180_000 }, // 90%
        { category: "RENT", amount: 60_000 }, // 120%
        { category: "UTILITIES", amount: 4_999 }, // 49.99% → 50%
      ]
    );
    for (const row of r.rows) {
      const expected =
        row.budget > 0 ? Math.round((row.actual / row.budget) * 100) : 0;
      expect(row.utilisation).toBe(expected);
    }
    // And the explicit values, to lock in the contract.
    expect(r.rows.find((x) => x.category === "SALARY")!.utilisation).toBe(90);
    expect(r.rows.find((x) => x.category === "RENT")!.utilisation).toBe(120);
    expect(r.rows.find((x) => x.category === "UTILITIES")!.utilisation).toBe(50);
  });

  it("variance sign matches utilisation - 100 (no over/under contradictions)", () => {
    // Row pill displays "X% over" derived from variance>0. utilisation
    // and variance are both derived from (actual - budget) — verify they
    // never disagree on direction.
    const r = aggregate(
      [
        { category: "SALARY", amount: 100_000 },
        { category: "RENT", amount: 100_000 },
        { category: "UTILITIES", amount: 100_000 },
      ],
      [
        { category: "SALARY", amount: 110_000 }, // over
        { category: "RENT", amount: 90_000 }, // under
        { category: "UTILITIES", amount: 100_000 }, // exactly on
      ]
    );
    for (const row of r.rows) {
      const overByVariance = row.variance > 0;
      const overByUtilisation = row.utilisation > 100;
      expect(overByVariance).toBe(overByUtilisation);
    }
  });
});
