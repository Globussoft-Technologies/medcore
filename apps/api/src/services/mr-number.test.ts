// Unit tests for services/mr-number.ts — the per-tenant MR-number scheme
// (<tenant code><zero-padded sequence>, e.g. PG01000001) shared by staff
// registration (routes/patients.ts) and public self-registration
// (routes/auth.ts). Pure-function coverage + the prisma-backed resolvers
// with a lightweight mock client (no DB).
import { describe, it, expect, vi } from "vitest";
import {
  slugifyMrPrefix,
  formatMrNumber,
  resolveMrPrefix,
  nextMrSeq,
  mrCounterKey,
} from "./mr-number";

describe("slugifyMrPrefix", () => {
  it("uppercases and strips non-alphanumerics", () => {
    expect(slugifyMrPrefix("PG-01")).toBe("PG01");
    expect(slugifyMrPrefix("pg hostpital kolkata")).toBe("PGHOSTPITALK"); // capped at 12
  });
  it("caps at 12 chars", () => {
    expect(slugifyMrPrefix("ABCDEFGHIJKLMNOP")).toHaveLength(12);
  });
  it("empty / symbols-only → empty string", () => {
    expect(slugifyMrPrefix("---")).toBe("");
    expect(slugifyMrPrefix("")).toBe("");
  });
});

describe("formatMrNumber", () => {
  it("zero-pads the sequence to 6 digits", () => {
    expect(formatMrNumber("PG01", 1)).toBe("PG01000001");
    expect(formatMrNumber("PG01", 42)).toBe("PG01000042");
  });
  it("keeps longer sequences intact", () => {
    expect(formatMrNumber("MR", 1234567)).toBe("MR1234567");
  });
});

describe("mrCounterKey", () => {
  it("is per-tenant", () => {
    expect(mrCounterKey("t-1")).toBe("next_mr_number:t-1");
  });
  it("falls back to a global key when no tenant", () => {
    expect(mrCounterKey(null)).toBe("next_mr_number:global");
    expect(mrCounterKey(undefined)).toBe("next_mr_number:global");
  });
});

describe("resolveMrPrefix", () => {
  it("returns 'MR' when there is no tenant", async () => {
    expect(await resolveMrPrefix({} as any, null)).toBe("MR");
  });

  it("uses the tenant CODE (SystemConfig tenant:<id>:code) when present", async () => {
    const prisma = {
      systemConfig: { findUnique: vi.fn(async () => ({ value: "PG-01" })) },
      tenant: { findUnique: vi.fn() },
    };
    expect(await resolveMrPrefix(prisma as any, "t-1")).toBe("PG01");
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled(); // code short-circuits
  });

  it("falls back to the subdomain slug when no code is set", async () => {
    const prisma = {
      systemConfig: { findUnique: vi.fn(async () => null) },
      tenant: { findUnique: vi.fn(async () => ({ subdomain: "apollo-clinic" })) },
    };
    expect(await resolveMrPrefix(prisma as any, "t-1")).toBe("APOLLOCLINIC");
  });

  it("falls back to 'MR' when neither code nor subdomain resolves", async () => {
    const prisma = {
      systemConfig: { findUnique: vi.fn(async () => null) },
      tenant: { findUnique: vi.fn(async () => ({ subdomain: "" })) },
    };
    expect(await resolveMrPrefix(prisma as any, "t-1")).toBe("MR");
  });
});

describe("nextMrSeq", () => {
  it("starts from the counter when no existing rows", async () => {
    const prisma = {
      systemConfig: { findUnique: vi.fn(async () => ({ value: "5" })) },
      patient: { findMany: vi.fn(async () => []) },
    };
    expect(await nextMrSeq(prisma as any, "k", "PG01")).toBe(5);
  });

  it("self-heals: starts ABOVE the highest existing MR even when counter is stale", async () => {
    const prisma = {
      systemConfig: { findUnique: vi.fn(async () => ({ value: "1" })) }, // stale
      patient: {
        findMany: vi.fn(async () => [
          { mrNumber: "PG01000045" },
          { mrNumber: "PG01000044" },
        ]),
      },
    };
    // max existing = 45 → next = 46 (not the stale counter's 1)
    expect(await nextMrSeq(prisma as any, "k", "PG01")).toBe(46);
  });

  it("ignores rows of a DIFFERENT prefix (and non-numeric tails)", async () => {
    const prisma = {
      systemConfig: { findUnique: vi.fn(async () => ({ value: "1" })) },
      patient: {
        findMany: vi.fn(async () => [
          { mrNumber: "PG01000003" }, // ours
          { mrNumber: "PGSEED000099" }, // different prefix — must NOT count
          { mrNumber: "PG01" }, // no numeric tail — ignored
        ]),
      },
    };
    expect(await nextMrSeq(prisma as any, "k", "PG01")).toBe(4);
  });

  it("defaults the counter to 1 when SystemConfig has no row", async () => {
    const prisma = {
      systemConfig: { findUnique: vi.fn(async () => null) },
      patient: { findMany: vi.fn(async () => []) },
    };
    expect(await nextMrSeq(prisma as any, "k", "PG01")).toBe(1);
  });
});
