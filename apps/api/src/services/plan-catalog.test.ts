// Unit tests for the dynamic plan-catalog service (Pearl §8.3).
//
// What / which module / why: exercises the pure resolution + helper logic in
// `plan-catalog.ts` (getPlanByKey / requirePlanByKey / listPlans / planLabel /
// isPlanColumnMigrationError) against a hand-rolled prisma mock so the suite
// runs without a live DB or a regenerated Prisma client.

import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  getPlanByKey,
  requirePlanByKey,
  listPlans,
  planLabel,
  isPlanColumnMigrationError,
  PLAN_MIGRATION_USER_MESSAGE,
} from "./plan-catalog";

function mockPrisma(rows: Array<Record<string, unknown>>): PrismaClient {
  return {
    platformPlan: {
      findUnique: vi.fn(
        async ({ where }: { where: { key: string } }) =>
          rows.find((r) => r.key === where.key) ?? null,
      ),
      findMany: vi.fn(
        async ({ where }: { where?: { active?: boolean } } = {}) =>
          where?.active
            ? rows.filter((r) => r.active === true)
            : rows,
      ),
    },
  } as unknown as PrismaClient;
}

const STARTER = {
  id: "1",
  key: "STARTER",
  name: "Starter",
  monthlyPriceInPaise: 499900,
  includedFeatures: ["opd"],
  active: true,
  sortOrder: 1,
};
const RETIRED = {
  id: "2",
  key: "OLD",
  name: "Old tier",
  monthlyPriceInPaise: 100,
  includedFeatures: [],
  active: false,
  sortOrder: 2,
};

describe("plan-catalog — getPlanByKey / requirePlanByKey", () => {
  it("returns the row for a known key", async () => {
    const plan = await getPlanByKey(mockPrisma([STARTER]), "STARTER");
    expect(plan?.name).toBe("Starter");
  });

  it("returns null for an unknown key", async () => {
    const plan = await getPlanByKey(mockPrisma([STARTER]), "NOPE");
    expect(plan).toBeNull();
  });

  it("requirePlanByKey throws a named error for a missing key", async () => {
    await expect(
      requirePlanByKey(mockPrisma([STARTER]), "NOPE"),
    ).rejects.toThrow(/NOPE/);
  });
});

describe("plan-catalog — listPlans", () => {
  it("returns all tiers by default", async () => {
    const plans = await listPlans(mockPrisma([STARTER, RETIRED]));
    expect(plans).toHaveLength(2);
  });

  it("hides inactive tiers when activeOnly", async () => {
    const plans = await listPlans(mockPrisma([STARTER, RETIRED]), {
      activeOnly: true,
    });
    expect(plans.map((p) => p.key)).toEqual(["STARTER"]);
  });
});

describe("plan-catalog — planLabel", () => {
  it("prefers name, then fallback key, then em-dash", () => {
    expect(planLabel({ name: "Starter", key: "STARTER" })).toBe("Starter");
    expect(planLabel(null, "fallback")).toBe("fallback");
    expect(planLabel(null)).toBe("—");
  });
});

describe("plan-catalog — isPlanColumnMigrationError", () => {
  it("detects the enum→String plan-column mismatch", () => {
    const err = new Error(
      "Error converting field `plan` of expected non-nullable type `String`, found incompatible value of `GROWTH`",
    );
    expect(isPlanColumnMigrationError(err)).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isPlanColumnMigrationError(new Error("connection refused"))).toBe(
      false,
    );
  });

  it("exposes a clean, non-technical operator message", () => {
    expect(PLAN_MIGRATION_USER_MESSAGE).not.toMatch(/prisma|db push|migrat/i);
  });
});
