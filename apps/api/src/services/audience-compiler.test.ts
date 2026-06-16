/**
 * Unit tests for services/audience-compiler.ts — Pearl ERP §5.1 piece 2a.
 *
 * What / which modules / why:
 *   - Pure-function tests. No Prisma I/O, no DB; we assert shape of the
 *     returned `where` object so we know the compiler emits valid Prisma
 *     filter shapes BEFORE the integration suite (which is slower) runs.
 *   - Covers each v1 predicate (gender / age / lastVisitDays / abhaLinked /
 *     city / branchId / optedOut), matchMode ALL vs ANY, empty filters,
 *     all-no-op filters, and unknown-field / bad-value warn-and-no-op
 *     fallbacks.
 *
 * 2026-05-25 — Pearl §5.1 row 161 closure: city / branchId / optedOut now
 *   resolve to real Prisma `where` clauses (previously no-ops pending
 *   schema). Tests below assert the compiled shapes match the new
 *   Patient.city / Patient.branchId / Patient.whatsappOptIn columns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { compileAudience } from "./audience-compiler";

describe("compileAudience — Pearl §5.1 piece 2a", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("empty filters → empty where (matches everyone, caller adds tenantId)", () => {
    expect(compileAudience({})).toEqual({});
    expect(compileAudience({ filters: [] })).toEqual({});
    expect(compileAudience({ filters: [], matchMode: "ALL" })).toEqual({});
  });

  it("single gender filter → { gender: FEMALE }", () => {
    const where = compileAudience({
      filters: [{ field: "gender", op: "eq", value: "FEMALE" }],
    });
    expect(where).toEqual({ gender: "FEMALE" });
  });

  it("age gte 60 → dateOfBirth lte (now - 60y)", () => {
    const where = compileAudience({
      filters: [{ field: "age", op: "gte", value: 60 }],
    }) as { dateOfBirth?: { lte?: Date } };
    expect(where.dateOfBirth?.lte).toBeInstanceOf(Date);
    // Should be roughly 60 years ago (give it a ±2 day fuzz for leap-year edges).
    const expectedMs = Date.now() - 60 * 365.25 * 24 * 60 * 60 * 1000;
    const diffDays =
      Math.abs((where.dateOfBirth!.lte!.getTime() - expectedMs) / (24 * 60 * 60 * 1000));
    expect(diffDays).toBeLessThan(2);
  });

  it("age lte 18 → dateOfBirth gte (now - 18y)", () => {
    const where = compileAudience({
      filters: [{ field: "age", op: "lte", value: 18 }],
    }) as { dateOfBirth?: { gte?: Date } };
    expect(where.dateOfBirth?.gte).toBeInstanceOf(Date);
  });

  it("lastVisitDays lte 30 → appointments.some.date.gte (now - 30d)", () => {
    const where = compileAudience({
      filters: [{ field: "lastVisitDays", op: "lte", value: 30 }],
    }) as { appointments?: { some?: { date?: { gte?: Date } } } };
    expect(where.appointments?.some?.date?.gte).toBeInstanceOf(Date);
    const expectedMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const diffMin =
      Math.abs((where.appointments!.some!.date!.gte!.getTime() - expectedMs) / 60_000);
    expect(diffMin).toBeLessThan(1);
  });

  it("lastVisitDays gte 90 → appointments.none.date.gte (now - 90d)  (no visit in 90d)", () => {
    const where = compileAudience({
      filters: [{ field: "lastVisitDays", op: "gte", value: 90 }],
    }) as { appointments?: { none?: { date?: { gte?: Date } } } };
    expect(where.appointments?.none?.date?.gte).toBeInstanceOf(Date);
  });

  it("abhaLinked eq true → { abhaId: { not: null } }", () => {
    expect(
      compileAudience({ filters: [{ field: "abhaLinked", op: "eq", value: true }] }),
    ).toEqual({ abhaId: { not: null } });
  });

  it("abhaLinked eq false → { abhaId: null }", () => {
    expect(
      compileAudience({ filters: [{ field: "abhaLinked", op: "eq", value: false }] }),
    ).toEqual({ abhaId: null });
  });

  it("matchMode ALL with two real filters → AND-wrapped", () => {
    const where = compileAudience({
      filters: [
        { field: "gender", op: "eq", value: "FEMALE" },
        { field: "abhaLinked", op: "eq", value: true },
      ],
      matchMode: "ALL",
    }) as { AND?: unknown[] };
    expect(Array.isArray(where.AND)).toBe(true);
    expect(where.AND).toHaveLength(2);
  });

  it("matchMode ANY with two real filters → OR-wrapped", () => {
    const where = compileAudience({
      filters: [
        { field: "gender", op: "eq", value: "MALE" },
        { field: "gender", op: "eq", value: "FEMALE" },
      ],
      matchMode: "ANY",
    }) as { OR?: unknown[] };
    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR).toHaveLength(2);
  });

  it("matchMode defaults to ALL when omitted", () => {
    const where = compileAudience({
      filters: [
        { field: "gender", op: "eq", value: "OTHER" },
        { field: "abhaLinked", op: "eq", value: false },
      ],
    }) as { AND?: unknown[] };
    expect(Array.isArray(where.AND)).toBe(true);
  });

  it("unknown field → no-op + warn + still emits a valid where", () => {
    const where = compileAudience({
      filters: [{ field: "favoriteColor", op: "eq", value: "blue" }],
    });
    expect(where).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown field "favoriteColor"'),
    );
  });

  it("unknown op on a known field → no-op + warn", () => {
    const where = compileAudience({
      filters: [{ field: "gender", op: "ne", value: "MALE" }],
    });
    expect(where).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unsupported op "ne"'));
  });

  // ── city / branchId / optedOut — Pearl §5.1 row 161 (2026-05-25) ──
  // Replaces the prior "reserved fields → no-op + warn" suite: the three
  // fields now compile to real Prisma where-clauses after the schema
  // additions (Patient.city, Patient.branchId, Patient.whatsappOptIn).

  it("city eq 'Mumbai' → { city: 'Mumbai' }", () => {
    expect(
      compileAudience({ filters: [{ field: "city", op: "eq", value: "Mumbai" }] }),
    ).toEqual({ city: "Mumbai" });
  });

  it("city in ['Mumbai','Pune'] → { city: { in: ['Mumbai','Pune'] } }", () => {
    expect(
      compileAudience({
        filters: [{ field: "city", op: "in", value: ["Mumbai", "Pune"] }],
      }),
    ).toEqual({ city: { in: ["Mumbai", "Pune"] } });
  });

  it("city eq with non-string value → no-op + warn", () => {
    const where = compileAudience({
      filters: [{ field: "city", op: "eq", value: 42 as unknown as string }],
    });
    expect(where).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
  });

  it("city in with mixed-type array → no-op + warn", () => {
    const where = compileAudience({
      filters: [
        { field: "city", op: "in", value: ["Mumbai", 42] as unknown as string[] },
      ],
    });
    expect(where).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
  });

  it("branchId eq 'branch-1' → { branchId: 'branch-1' }", () => {
    expect(
      compileAudience({
        filters: [{ field: "branchId", op: "eq", value: "branch-1" }],
      }),
    ).toEqual({ branchId: "branch-1" });
  });

  it("branchId with unsupported op (in) → no-op + warn", () => {
    const where = compileAudience({
      filters: [
        { field: "branchId", op: "in", value: ["b1", "b2"] as unknown as string },
      ],
    });
    expect(where).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unsupported op "in"'));
  });

  it("optedOut eq false → { whatsappOptIn: true } (eligible for marketing)", () => {
    expect(
      compileAudience({
        filters: [{ field: "optedOut", op: "eq", value: false }],
      }),
    ).toEqual({ whatsappOptIn: true });
  });

  it("optedOut eq true → { whatsappOptIn: false } (suppressed from marketing)", () => {
    expect(
      compileAudience({
        filters: [{ field: "optedOut", op: "eq", value: true }],
      }),
    ).toEqual({ whatsappOptIn: false });
  });

  it("optedOut with non-boolean value → no-op + warn", () => {
    const where = compileAudience({
      filters: [
        { field: "optedOut", op: "eq", value: "no" as unknown as boolean },
      ],
    });
    expect(where).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
  });

  it("composes city + branchId + optedOut + abhaLinked under AND", () => {
    const where = compileAudience({
      filters: [
        { field: "city", op: "eq", value: "Mumbai" },
        { field: "branchId", op: "eq", value: "branch-1" },
        { field: "optedOut", op: "eq", value: false },
        { field: "abhaLinked", op: "eq", value: true },
      ],
      matchMode: "ALL",
    }) as { AND?: unknown[] };
    expect(Array.isArray(where.AND)).toBe(true);
    expect(where.AND).toHaveLength(4);
  });

  it("mixed real + no-op filters → only real ones compose into AND", () => {
    const where = compileAudience({
      filters: [
        { field: "gender", op: "eq", value: "FEMALE" },
        { field: "favoriteColor", op: "eq", value: "blue" },
        { field: "abhaLinked", op: "eq", value: true },
      ],
      matchMode: "ALL",
    }) as { AND?: unknown[]; gender?: string };
    // 3 filters in, 1 no-op → 2 compiled; AND wraps because >1.
    expect(Array.isArray(where.AND)).toBe(true);
    expect(where.AND).toHaveLength(2);
  });

  it("single real filter survives the AND-wrap fast path → no envelope", () => {
    // Important: a single clause must NOT be wrapped in { AND: [...] }
    // (Prisma accepts both, but the un-wrapped form composes more cleanly
    // when the caller does { tenantId, ...compiled }).
    const where = compileAudience({
      filters: [{ field: "gender", op: "eq", value: "MALE" }],
    });
    expect(where).toEqual({ gender: "MALE" });
    expect("AND" in where).toBe(false);
  });

  it("non-string gender value → no-op + warn", () => {
    const where = compileAudience({
      filters: [{ field: "gender", op: "eq", value: 42 as unknown as string }],
    });
    expect(where).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
  });

  it("non-number age value → no-op + warn", () => {
    const where = compileAudience({
      filters: [{ field: "age", op: "gte", value: "old" as unknown as number }],
    });
    expect(where).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
  });

  // 2026-06 — diagnosis match across problem-list / prescriptions / admissions.
  it("condition eq → matches diagnosis across all three surfaces", () => {
    const where = compileAudience({
      filters: [{ field: "condition", op: "eq", value: "diabetes" }],
    }) as { OR?: unknown[]; chronicConditions?: unknown; prescriptions?: unknown };
    // Single term → returned directly (no wrapping OR). It must hit all three
    // diagnosis surfaces via an OR.
    expect(where.OR).toBeDefined();
    const surfaces = where.OR as Array<Record<string, unknown>>;
    expect(surfaces).toHaveLength(3);
    expect(surfaces.some((s) => "chronicConditions" in s)).toBe(true);
    expect(surfaces.some((s) => "prescriptions" in s)).toBe(true);
    expect(surfaces.some((s) => "admissions" in s)).toBe(true);
  });

  it("condition with an empty value → no-op + warn", () => {
    const where = compileAudience({
      filters: [{ field: "condition", op: "eq", value: "" }],
    });
    expect(where).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
  });

  it("allergy eq 'penicillin' → allergies.some.OR allergen contains", () => {
    const where = compileAudience({
      filters: [{ field: "allergy", op: "eq", value: "penicillin" }],
    }) as { allergies?: { some?: { OR?: Array<Record<string, unknown>> } } };
    expect(where.allergies?.some?.OR).toBeDefined();
    const ors = where.allergies!.some!.OR!;
    expect(ors).toHaveLength(1);
    expect(ors[0]).toEqual({ allergen: { contains: "penicillin", mode: "insensitive" } });
  });

  it("allergy in ['penicillin','sulfa'] → allergies.some.OR with both terms", () => {
    const where = compileAudience({
      filters: [{ field: "allergy", op: "in", value: ["penicillin", "sulfa"] }],
    }) as { allergies?: { some?: { OR?: unknown[] } } };
    expect(where.allergies?.some?.OR).toHaveLength(2);
  });

  it("allergy with an empty value → no-op + warn", () => {
    const where = compileAudience({
      filters: [{ field: "allergy", op: "eq", value: "" }],
    });
    expect(where).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
  });

  it("allergy with an unsupported op (gte) → no-op + warn", () => {
    const where = compileAudience({
      filters: [{ field: "allergy", op: "gte", value: "penicillin" }],
    });
    expect(where).toEqual({});
    expect(warnSpy).toHaveBeenCalled();
  });
});
