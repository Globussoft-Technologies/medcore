// Pearl ERP Stage 1 §7.2 piece 2b — branch-scoping allow-list assertions.
// Pure unit test: no DB. Locks in BRANCH_SCOPED_MODELS so a future
// refactor can't silently drop a model and reopen the cross-branch
// read bug class.

import { describe, it, expect } from "vitest";
import { BRANCH_SCOPED_MODELS, shouldScopeBranch } from "../branch-prisma";

describe("branch-scoping allow-list", () => {
  it("includes the transactional Appointment + Invoice models", () => {
    expect(BRANCH_SCOPED_MODELS.has("Appointment")).toBe(true);
    expect(BRANCH_SCOPED_MODELS.has("Invoice")).toBe(true);
  });

  it("does NOT branch-scope Doctor / Patient identity records (2026-07 bug fix)", () => {
    // Doctor + Patient are tenant-wide master records — the booking pickers
    // list them tenant-wide, so branch-filtering their existence lookups in
    // the booking handler 404'd doctors that were visible in the dropdown.
    // Only TRANSACTIONAL rows (Appointment/Invoice) are branch-owned.
    expect(BRANCH_SCOPED_MODELS.has("Doctor")).toBe(false);
    expect(BRANCH_SCOPED_MODELS.has("Patient")).toBe(false);
  });

  it("does NOT scope unrelated models (regression: catalogs must stay global)", () => {
    expect(BRANCH_SCOPED_MODELS.has("Medicine")).toBe(false);
    expect(BRANCH_SCOPED_MODELS.has("Tenant")).toBe(false);
    expect(BRANCH_SCOPED_MODELS.has("User")).toBe(false);
    expect(BRANCH_SCOPED_MODELS.has("Branch")).toBe(false);
  });

  it("shouldScopeBranch returns true for scoped-model writes", () => {
    expect(shouldScopeBranch("Invoice", "create")).toBe(true);
    expect(shouldScopeBranch("Appointment", "createMany")).toBe(true);
    expect(shouldScopeBranch("Invoice", "upsert")).toBe(true);
  });

  it("shouldScopeBranch returns true for scoped-model reads + updates", () => {
    expect(shouldScopeBranch("Invoice", "findMany")).toBe(true);
    expect(shouldScopeBranch("Appointment", "findFirst")).toBe(true);
    expect(shouldScopeBranch("Appointment", "update")).toBe(true);
    expect(shouldScopeBranch("Invoice", "count")).toBe(true);
  });

  it("shouldScopeBranch returns false for Doctor / Patient (identity records)", () => {
    expect(shouldScopeBranch("Doctor", "findUnique")).toBe(false);
    expect(shouldScopeBranch("Patient", "findUnique")).toBe(false);
    expect(shouldScopeBranch("Doctor", "create")).toBe(false);
  });

  it("shouldScopeBranch returns false for unscoped models", () => {
    expect(shouldScopeBranch("Medicine", "create")).toBe(false);
    expect(shouldScopeBranch("Tenant", "findMany")).toBe(false);
  });

  it("shouldScopeBranch returns false for non-CRUD operations", () => {
    // $queryRaw / $executeRaw / $transaction are intentionally skipped —
    // the extension cannot rewrite raw SQL.
    expect(shouldScopeBranch("Invoice", "$queryRaw")).toBe(false);
    expect(shouldScopeBranch("Invoice", "$executeRaw")).toBe(false);
  });
});
