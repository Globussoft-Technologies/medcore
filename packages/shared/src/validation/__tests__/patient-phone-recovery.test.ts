// Coverage tests for reception-mediated patient forgot-phone recovery schemas.
// What: exhaustive happy / invalid / edge cases for every exported schema in
//   packages/shared/src/validation/patient-phone-recovery.ts —
//   recoverPhoneIdentityMethodSchema and recoverPhoneSchema (Pearl §5.3 / gap
//   row 149).
// Which modules: imports only from ../patient-phone-recovery.
// Why: the file shipped at 0% colocated coverage and guards the body of POST
//   /api/v1/patients/:id/recover-phone — the staff-driven path that attaches
//   a new phone to a patient's User row when self-service phone OTP is
//   unavailable. Locking down the identity-method enum + the 10–500 char
//   note bounds protects the DPDP/HIPAA audit-trail contract: a future
//   schema bump can't silently widen the enum or drop the note's min/max
//   without these tests catching the regression.
import { describe, it, expect } from "vitest";
import {
  recoverPhoneIdentityMethodSchema,
  recoverPhoneSchema,
} from "../patient-phone-recovery";

// ───────────────────────────────────────────────────────
// recoverPhoneIdentityMethodSchema
// ───────────────────────────────────────────────────────

describe("recoverPhoneIdentityMethodSchema", () => {
  it("accepts AADHAAR", () => {
    expect(recoverPhoneIdentityMethodSchema.safeParse("AADHAAR").success).toBe(true);
  });
  it("accepts PAN", () => {
    expect(recoverPhoneIdentityMethodSchema.safeParse("PAN").success).toBe(true);
  });
  it("accepts VOTER_ID", () => {
    expect(recoverPhoneIdentityMethodSchema.safeParse("VOTER_ID").success).toBe(true);
  });
  it("accepts DRIVING_LICENSE", () => {
    expect(recoverPhoneIdentityMethodSchema.safeParse("DRIVING_LICENSE").success).toBe(true);
  });
  it("accepts PHOTO_MATCH (no-ID fallback for minors/elderly)", () => {
    expect(recoverPhoneIdentityMethodSchema.safeParse("PHOTO_MATCH").success).toBe(true);
  });
  it("rejects a lower-case variant (enum is case-sensitive)", () => {
    expect(recoverPhoneIdentityMethodSchema.safeParse("aadhaar").success).toBe(false);
  });
  it("rejects a mixed-case variant", () => {
    expect(recoverPhoneIdentityMethodSchema.safeParse("Aadhaar").success).toBe(false);
  });
  it("rejects a method not in the enum (e.g. PASSPORT)", () => {
    expect(recoverPhoneIdentityMethodSchema.safeParse("PASSPORT").success).toBe(false);
  });
  it("rejects an empty string", () => {
    expect(recoverPhoneIdentityMethodSchema.safeParse("").success).toBe(false);
  });
  it("rejects undefined", () => {
    expect(recoverPhoneIdentityMethodSchema.safeParse(undefined).success).toBe(false);
  });
  it("rejects null", () => {
    expect(recoverPhoneIdentityMethodSchema.safeParse(null).success).toBe(false);
  });
  it("rejects a numeric value", () => {
    expect(recoverPhoneIdentityMethodSchema.safeParse(1 as any).success).toBe(false);
  });
  it("rejects an object", () => {
    expect(recoverPhoneIdentityMethodSchema.safeParse({ method: "AADHAAR" } as any).success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// recoverPhoneSchema — happy paths
// ───────────────────────────────────────────────────────

const validNote = "Aadhaar last 4: 1234, DOB matches chart on file.";

const buildInput = (overrides: Partial<{ newPhone: string; method: string; note: string }> = {}) => ({
  newPhone: overrides.newPhone ?? "9876543210",
  identityVerification: {
    method: overrides.method ?? "AADHAAR",
    note: overrides.note ?? validNote,
  },
});

describe("recoverPhoneSchema — happy paths", () => {
  it("accepts a bare 10-digit Indian phone with AADHAAR + valid note", () => {
    expect(recoverPhoneSchema.safeParse(buildInput()).success).toBe(true);
  });
  it("accepts a +91-prefixed E.164 phone", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ newPhone: "+919876543210" })).success).toBe(true);
  });
  it("accepts a 91-prefixed 12-digit phone (no +)", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ newPhone: "919876543210" })).success).toBe(true);
  });
  it("accepts a 15-digit E.164 maximum", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ newPhone: "+123456789012345" })).success).toBe(true);
  });
  it("accepts each identity method in turn", () => {
    for (const m of ["AADHAAR", "PAN", "VOTER_ID", "DRIVING_LICENSE", "PHOTO_MATCH"]) {
      expect(recoverPhoneSchema.safeParse(buildInput({ method: m })).success).toBe(true);
    }
  });
  it("accepts a note at the minimum boundary (exactly 10 chars)", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ note: "1234567890" })).success).toBe(true);
  });
  it("accepts a note at the maximum boundary (exactly 500 chars)", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ note: "x".repeat(500) })).success).toBe(true);
  });
  it("trims surrounding whitespace on newPhone before regex check", () => {
    const r = recoverPhoneSchema.safeParse(buildInput({ newPhone: "  9876543210  " }));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.newPhone).toBe("9876543210");
  });
  it("trims surrounding whitespace on note before length check", () => {
    // Note with 10 inner chars + leading/trailing whitespace should pass (trim → 10).
    const r = recoverPhoneSchema.safeParse(buildInput({ note: "   1234567890   " }));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.identityVerification.note).toBe("1234567890");
  });
});

// ───────────────────────────────────────────────────────
// recoverPhoneSchema — newPhone invalid paths
// ───────────────────────────────────────────────────────

describe("recoverPhoneSchema — newPhone validation", () => {
  it("rejects a phone shorter than 10 digits", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ newPhone: "123456789" })).success).toBe(false);
  });
  it("rejects a phone longer than 15 digits", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ newPhone: "+1234567890123456" })).success).toBe(false);
  });
  it("rejects a phone with letters", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ newPhone: "98765abcde" })).success).toBe(false);
  });
  it("rejects a phone with embedded spaces", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ newPhone: "98765 43210" })).success).toBe(false);
  });
  it("rejects a phone with dashes", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ newPhone: "98765-43210" })).success).toBe(false);
  });
  it("rejects a phone with parentheses", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ newPhone: "(987)6543210" })).success).toBe(false);
  });
  it("rejects an empty newPhone", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ newPhone: "" })).success).toBe(false);
  });
  it("rejects a missing newPhone field", () => {
    const r = recoverPhoneSchema.safeParse({
      identityVerification: { method: "AADHAAR", note: validNote },
    });
    expect(r.success).toBe(false);
  });
  it("rejects a non-string newPhone", () => {
    const r = recoverPhoneSchema.safeParse({
      newPhone: 9876543210 as any,
      identityVerification: { method: "AADHAAR", note: validNote },
    });
    expect(r.success).toBe(false);
  });
  it("rejects multiple leading + signs", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ newPhone: "++919876543210" })).success).toBe(false);
  });
  it("surfaces the configured regex error message", () => {
    const r = recoverPhoneSchema.safeParse(buildInput({ newPhone: "abc" }));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) =>
          /Phone must be 10[-–]15 digits, optional leading \+/.test(i.message),
        ),
      ).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────
// recoverPhoneSchema — identityVerification.method invalid paths
// ───────────────────────────────────────────────────────

describe("recoverPhoneSchema — identityVerification.method validation", () => {
  it("rejects an unknown method string", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ method: "PASSPORT" })).success).toBe(false);
  });
  it("rejects a lower-case method", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ method: "aadhaar" })).success).toBe(false);
  });
  it("rejects an empty method", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ method: "" })).success).toBe(false);
  });
  it("rejects a missing method field", () => {
    const r = recoverPhoneSchema.safeParse({
      newPhone: "9876543210",
      identityVerification: { note: validNote } as any,
    });
    expect(r.success).toBe(false);
  });
  it("rejects a numeric method", () => {
    const r = recoverPhoneSchema.safeParse({
      newPhone: "9876543210",
      identityVerification: { method: 1 as any, note: validNote },
    });
    expect(r.success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// recoverPhoneSchema — identityVerification.note invalid paths
// ───────────────────────────────────────────────────────

describe("recoverPhoneSchema — identityVerification.note validation", () => {
  it("rejects a note shorter than 10 characters", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ note: "too short" })).success).toBe(false);
  });
  it("rejects a one-word note like 'verified' (defeats audit purpose)", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ note: "verified" })).success).toBe(false);
  });
  it("rejects a one-word note like 'ok'", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ note: "ok" })).success).toBe(false);
  });
  it("rejects an empty note", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ note: "" })).success).toBe(false);
  });
  it("rejects a whitespace-only note (trim → empty → below min)", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ note: "           " })).success).toBe(false);
  });
  it("rejects a note one character below min (9 chars after trim)", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ note: "123456789" })).success).toBe(false);
  });
  it("rejects a note one character above max (501 chars)", () => {
    expect(recoverPhoneSchema.safeParse(buildInput({ note: "x".repeat(501) })).success).toBe(false);
  });
  it("rejects a missing note field", () => {
    const r = recoverPhoneSchema.safeParse({
      newPhone: "9876543210",
      identityVerification: { method: "AADHAAR" } as any,
    });
    expect(r.success).toBe(false);
  });
  it("rejects a non-string note", () => {
    const r = recoverPhoneSchema.safeParse({
      newPhone: "9876543210",
      identityVerification: { method: "AADHAAR", note: 12345 as any },
    });
    expect(r.success).toBe(false);
  });
  it("surfaces the configured min-length error message", () => {
    const r = recoverPhoneSchema.safeParse(buildInput({ note: "short" }));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) =>
          /Identity verification note must be at least 10 characters/.test(i.message),
        ),
      ).toBe(true);
    }
  });
  it("surfaces the configured max-length error message", () => {
    const r = recoverPhoneSchema.safeParse(buildInput({ note: "x".repeat(600) }));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) =>
          /Identity verification note must be at most 500 characters/.test(i.message),
        ),
      ).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────
// recoverPhoneSchema — structural / object-shape invalids
// ───────────────────────────────────────────────────────

describe("recoverPhoneSchema — structural validation", () => {
  it("rejects an empty object", () => {
    expect(recoverPhoneSchema.safeParse({}).success).toBe(false);
  });
  it("rejects a missing identityVerification object", () => {
    expect(recoverPhoneSchema.safeParse({ newPhone: "9876543210" }).success).toBe(false);
  });
  it("rejects a null identityVerification", () => {
    const r = recoverPhoneSchema.safeParse({
      newPhone: "9876543210",
      identityVerification: null as any,
    });
    expect(r.success).toBe(false);
  });
  it("rejects an identityVerification that is not an object", () => {
    const r = recoverPhoneSchema.safeParse({
      newPhone: "9876543210",
      identityVerification: "AADHAAR" as any,
    });
    expect(r.success).toBe(false);
  });
  it("rejects an array as the top-level input", () => {
    expect(recoverPhoneSchema.safeParse([] as any).success).toBe(false);
  });
  it("rejects a string as the top-level input", () => {
    expect(recoverPhoneSchema.safeParse("9876543210" as any).success).toBe(false);
  });
  it("aggregates multiple errors across newPhone + method + note in one report", () => {
    const r = recoverPhoneSchema.safeParse({
      newPhone: "bad",
      identityVerification: { method: "PASSPORT", note: "x" },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // Should surface at least one error per failing field.
      const paths = r.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p === "newPhone")).toBe(true);
      expect(paths.some((p) => p === "identityVerification.method")).toBe(true);
      expect(paths.some((p) => p === "identityVerification.note")).toBe(true);
    }
  });
});
