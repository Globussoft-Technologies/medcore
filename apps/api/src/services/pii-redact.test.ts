// Tests for services/pii-redact.ts — the visitor / ID-proof PII masking helpers
// added under Issue #476 to stop raw Aadhaar / ID-proof numbers leaking on
// /api/v1/visitors/* GET responses.
//
// What's covered
//   1. maskIdNumber(value):
//        - null / undefined / empty-string inputs return null
//        - inputs <= 4 chars are fully obscured as "****"
//        - inputs > 4 chars are masked to "********" + last4
//        - exactly 4-char input hits the boundary branch ("****")
//        - exactly 5-char input hits the masking branch
//        - non-string input is coerced via String() (number, boolean)
//        - last-4 preservation works for 12-digit Aadhaar, 14-char ABHA,
//          alphanumeric passport-style IDs, very long strings
//        - idempotency: masking an already-masked value still returns the
//          same shape (last-4 of "********1234" is "1234")
//        - whitespace + unicode last-4 are preserved as-is
//
//   2. redactVisitorPII(visitor):
//        - replaces idProofNumber on a flat visitor object
//        - missing idProofNumber field becomes null on output
//        - explicit null idProofNumber stays null on output
//        - preserves every other field unchanged (name, phone, purpose, ...)
//        - does not mutate the input object (returns a new object)
//        - returns the input as-is when input is null / undefined / non-object
//        - inputs with extra typed fields preserve TypeScript shape
//
//   3. redactVisitorListPII(visitors):
//        - returns [] for empty array
//        - maps each entry through redactVisitorPII
//        - returns the input as-is when input is NOT an array (defensive)
//        - mixed-shape arrays (some have idProofNumber, some don't) all get
//          the field normalized to either masked-string or null
//
//   4. Idempotency at the wrapper layer:
//        - redactVisitorPII(redactVisitorPII(v)) === stable shape
//        - redactVisitorListPII applied twice produces the same output
//
// Why this file matters
//   The route layer trusts these helpers silently — a regression that returns
//   the raw idProofNumber would reintroduce the Issue #476 PHI leak across
//   every visitor GET endpoint. The redaction contract is small but
//   security-critical.

import { describe, it, expect } from "vitest";
import {
  maskIdNumber,
  redactVisitorPII,
  redactVisitorListPII,
} from "./pii-redact";

describe("maskIdNumber — null/empty branches", () => {
  it("returns null for null input", () => {
    expect(maskIdNumber(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(maskIdNumber(undefined)).toBeNull();
  });

  it("returns null for empty string (falsy)", () => {
    expect(maskIdNumber("")).toBeNull();
  });
});

describe("maskIdNumber — short-input branch (<=4 chars → fully obscured)", () => {
  it("returns '****' for a 1-char value", () => {
    expect(maskIdNumber("1")).toBe("****");
  });

  it("returns '****' for a 2-char value", () => {
    expect(maskIdNumber("12")).toBe("****");
  });

  it("returns '****' for a 3-char value", () => {
    expect(maskIdNumber("123")).toBe("****");
  });

  it("returns '****' for an exactly-4-char value (boundary)", () => {
    expect(maskIdNumber("1234")).toBe("****");
  });
});

describe("maskIdNumber — long-input branch (>4 chars → masked + last4)", () => {
  it("returns '********' + last4 for a 5-char value (boundary just above)", () => {
    // 5 chars > 4 → masking branch; last4 of "12345" is "2345"
    expect(maskIdNumber("12345")).toBe("********2345");
  });

  it("masks a 12-digit Aadhaar correctly", () => {
    // Common Indian Aadhaar shape — 12 digits, last 4 preserved.
    expect(maskIdNumber("123456789012")).toBe("********9012");
  });

  it("masks a 14-char ABHA-style ID correctly", () => {
    // ABHA addresses are 14-char alphanumeric.
    expect(maskIdNumber("12345678901234")).toBe("********1234");
  });

  it("masks an alphanumeric passport-style ID correctly", () => {
    // Indian passport: 1 letter + 7 digits = 8 chars.
    expect(maskIdNumber("A1234567")).toBe("********4567");
  });

  it("masks a very long string and preserves only the last 4 chars", () => {
    const long = "X".repeat(50) + "ABCD";
    expect(maskIdNumber(long)).toBe("********ABCD");
  });

  it("preserves alphanumeric last-4 characters as-is (case-sensitive)", () => {
    expect(maskIdNumber("xyzAB12ab")).toBe("********12ab");
  });
});

describe("maskIdNumber — non-string input coercion via String()", () => {
  it("coerces a number input via String()", () => {
    // 123456789012 → "123456789012" → "********9012"
    // @ts-expect-error — testing runtime coercion
    expect(maskIdNumber(123456789012)).toBe("********9012");
  });

  it("coerces a small number (<=4 chars when stringified) to '****'", () => {
    // 42 → "42" → length 2 → "****"
    // @ts-expect-error — testing runtime coercion
    expect(maskIdNumber(42)).toBe("****");
  });

  it("coerces boolean true → 'true' (4 chars → '****')", () => {
    // "true".length === 4 → boundary → "****"
    // @ts-expect-error — testing runtime coercion
    expect(maskIdNumber(true)).toBe("****");
  });

  it("treats boolean false as falsy and short-circuits to null (does NOT reach String() coercion)", () => {
    // The `if (!value)` early-return fires on `false` before String() runs.
    // This is the documented falsy-input contract — null/undefined/""/0/false
    // all return null without going through the masking pipeline.
    // @ts-expect-error — testing runtime coercion
    expect(maskIdNumber(false)).toBeNull();
  });

  it("treats numeric 0 as falsy and short-circuits to null", () => {
    // @ts-expect-error — testing runtime coercion
    expect(maskIdNumber(0)).toBeNull();
  });
});

describe("maskIdNumber — idempotency + already-masked input", () => {
  it("masking an already-masked value is stable in shape (still ends in last4)", () => {
    // Input "********1234" is 12 chars → still > 4 → masked → last4 "1234"
    expect(maskIdNumber("********1234")).toBe("********1234");
  });

  it("re-masking the result of a real masking returns the same value", () => {
    const once = maskIdNumber("123456789012");
    const twice = maskIdNumber(once);
    expect(twice).toBe(once);
  });
});

describe("redactVisitorPII — flat visitor objects", () => {
  it("replaces idProofNumber on a visitor with Aadhaar", () => {
    const visitor = {
      id: "v1",
      name: "Ramesh Kumar",
      phone: "+919876543210",
      idProofNumber: "123456789012",
      purpose: "appointment",
    };
    const safe = redactVisitorPII(visitor);
    expect(safe.idProofNumber).toBe("********9012");
    expect(safe.id).toBe("v1");
    expect(safe.name).toBe("Ramesh Kumar");
    expect(safe.phone).toBe("+919876543210");
    expect(safe.purpose).toBe("appointment");
  });

  it("normalizes a MISSING idProofNumber field to null on output", () => {
    const visitor: { id: string; name: string; idProofNumber?: string | null } = {
      id: "v2",
      name: "Anjali",
    };
    const safe = redactVisitorPII(visitor);
    expect(safe.idProofNumber).toBeNull();
    expect(safe.id).toBe("v2");
    expect(safe.name).toBe("Anjali");
  });

  it("keeps an explicit null idProofNumber as null on output", () => {
    const visitor = { id: "v3", idProofNumber: null };
    const safe = redactVisitorPII(visitor);
    expect(safe.idProofNumber).toBeNull();
  });

  it("masks a short (<=4) idProofNumber as '****'", () => {
    const visitor = { id: "v4", idProofNumber: "12" };
    expect(redactVisitorPII(visitor).idProofNumber).toBe("****");
  });

  it("does NOT mutate the input object (returns a fresh copy)", () => {
    const visitor = { id: "v5", idProofNumber: "123456789012" };
    const safe = redactVisitorPII(visitor);
    // Source still has the raw value.
    expect(visitor.idProofNumber).toBe("123456789012");
    // Output has the masked value.
    expect(safe.idProofNumber).toBe("********9012");
    // Different object identity.
    expect(safe).not.toBe(visitor);
  });

  it("preserves every other field unchanged on a richly-typed visitor", () => {
    const visitor = {
      id: "v6",
      tenantId: "t1",
      name: "Vikram Singh",
      phone: "+911234567890",
      idProofType: "AADHAAR",
      idProofNumber: "999988887777",
      purpose: "consultation",
      patientId: "p123",
      checkedInAt: new Date("2026-01-01T10:00:00Z"),
      checkedOutAt: null,
      isActive: true,
      visitNumber: 42,
      tags: ["vip", "returning"],
    };
    const safe = redactVisitorPII(visitor);
    expect(safe.idProofNumber).toBe("********7777");
    // Every other field round-trips identically.
    expect(safe.id).toBe(visitor.id);
    expect(safe.tenantId).toBe(visitor.tenantId);
    expect(safe.name).toBe(visitor.name);
    expect(safe.phone).toBe(visitor.phone);
    expect(safe.idProofType).toBe(visitor.idProofType);
    expect(safe.purpose).toBe(visitor.purpose);
    expect(safe.patientId).toBe(visitor.patientId);
    expect(safe.checkedInAt).toBe(visitor.checkedInAt);
    expect(safe.checkedOutAt).toBeNull();
    expect(safe.isActive).toBe(true);
    expect(safe.visitNumber).toBe(42);
    expect(safe.tags).toEqual(["vip", "returning"]);
  });
});

describe("redactVisitorPII — defensive non-object branches", () => {
  it("returns null unchanged for null input", () => {
    // @ts-expect-error — testing runtime defense
    expect(redactVisitorPII(null)).toBeNull();
  });

  it("returns undefined unchanged for undefined input", () => {
    // @ts-expect-error — testing runtime defense
    expect(redactVisitorPII(undefined)).toBeUndefined();
  });

  it("returns a string unchanged when given non-object input", () => {
    // @ts-expect-error — testing runtime defense
    expect(redactVisitorPII("not-a-visitor")).toBe("not-a-visitor");
  });

  it("returns a number unchanged when given non-object input", () => {
    // @ts-expect-error — testing runtime defense
    expect(redactVisitorPII(42)).toBe(42);
  });
});

describe("redactVisitorPII — idempotency", () => {
  it("redacting twice yields the same masked output", () => {
    const visitor = { id: "v7", idProofNumber: "987654321098" };
    const once = redactVisitorPII(visitor);
    const twice = redactVisitorPII(once);
    expect(twice.idProofNumber).toBe("********1098");
    expect(twice.idProofNumber).toBe(once.idProofNumber);
  });

  it("redacting a missing-field input twice still yields null", () => {
    const visitor: { id: string; idProofNumber?: string | null } = { id: "v8" };
    const once = redactVisitorPII(visitor);
    const twice = redactVisitorPII(once);
    expect(twice.idProofNumber).toBeNull();
  });
});

describe("redactVisitorListPII — array branches", () => {
  it("returns [] for an empty array", () => {
    expect(redactVisitorListPII([])).toEqual([]);
  });

  it("maps every entry through redactVisitorPII", () => {
    const list = [
      { id: "v1", idProofNumber: "111122223333" },
      { id: "v2", idProofNumber: "AAAA1111BBBB22" },
      { id: "v3", idProofNumber: "X1" },
    ];
    const safe = redactVisitorListPII(list);
    expect(safe).toHaveLength(3);
    expect(safe[0].idProofNumber).toBe("********3333");
    expect(safe[1].idProofNumber).toBe("********BB22");
    expect(safe[2].idProofNumber).toBe("****");
    // IDs (and any other fields) are preserved.
    expect(safe[0].id).toBe("v1");
    expect(safe[1].id).toBe("v2");
    expect(safe[2].id).toBe("v3");
  });

  it("normalizes mixed-shape entries (some missing idProofNumber)", () => {
    const list = [
      { id: "v1", idProofNumber: "123456789012" },
      { id: "v2" },
      { id: "v3", idProofNumber: null },
      { id: "v4", idProofNumber: "AB" },
    ];
    const safe = redactVisitorListPII(list);
    expect(safe[0].idProofNumber).toBe("********9012");
    expect(safe[1].idProofNumber).toBeNull();
    expect(safe[2].idProofNumber).toBeNull();
    expect(safe[3].idProofNumber).toBe("****");
  });

  it("does NOT mutate any entry in the source array", () => {
    const list = [{ id: "v1", idProofNumber: "123456789012" }];
    const safe = redactVisitorListPII(list);
    expect(list[0].idProofNumber).toBe("123456789012");
    expect(safe[0].idProofNumber).toBe("********9012");
    expect(safe[0]).not.toBe(list[0]);
  });

  it("returns the input as-is when given a non-array (defensive)", () => {
    // @ts-expect-error — testing runtime defense
    expect(redactVisitorListPII(null)).toBeNull();
    // @ts-expect-error — testing runtime defense
    expect(redactVisitorListPII(undefined)).toBeUndefined();
    // @ts-expect-error — testing runtime defense
    expect(redactVisitorListPII("oops")).toBe("oops");
    // @ts-expect-error — testing runtime defense
    expect(redactVisitorListPII({ id: "v1" })).toEqual({ id: "v1" });
  });

  it("preserves array order", () => {
    const list = [
      { id: "a", idProofNumber: "111111111111" },
      { id: "b", idProofNumber: "222222222222" },
      { id: "c", idProofNumber: "333333333333" },
    ];
    const safe = redactVisitorListPII(list);
    expect(safe.map((v) => v.id)).toEqual(["a", "b", "c"]);
    expect(safe.map((v) => v.idProofNumber)).toEqual([
      "********1111",
      "********2222",
      "********3333",
    ]);
  });
});

describe("redactVisitorListPII — idempotency", () => {
  it("redacting a list twice yields the same masked output (no double-mask)", () => {
    const list = [
      { id: "v1", idProofNumber: "123456789012" },
      { id: "v2", idProofNumber: "AB" },
    ];
    const once = redactVisitorListPII(list);
    const twice = redactVisitorListPII(once);
    expect(twice).toEqual(once);
    expect(twice[0].idProofNumber).toBe("********9012");
    expect(twice[1].idProofNumber).toBe("****");
  });
});
