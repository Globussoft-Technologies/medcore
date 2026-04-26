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
  const rows = budgets.map((b) => ({
    category: b.category,
    budget: b.amount,
    actual: +(actualByCat[b.category] || 0).toFixed(2),
  }));
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
