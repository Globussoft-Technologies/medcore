// Coverage tests for patient phone-OTP login schemas + canonicalisePhone.
// What: exhaustive happy / invalid / edge cases for every exported schema and
//   helper in packages/shared/src/validation/patient-auth.ts —
//   requestPatientOtpSchema, verifyPatientOtpSchema, canonicalisePhone().
// Which modules: imports only from ../patient-auth.
// Why: the file shipped at 0% colocated coverage (gap #5 piece 2 of 4 — Pearl
//   §5.3 / §6.1). The schemas guard the patient login endpoint that's the
//   single entry-point for the patient PWA, so locking in the loose-accept
//   regex shape AND the canonicaliser's per-shape collapse rules prevents a
//   future schema bump from silently breaking the +91 / 91 / 0 / bare-10
//   input variants documented in the source-file comment block.
import { describe, it, expect } from "vitest";
import {
  requestPatientOtpSchema,
  verifyPatientOtpSchema,
  canonicalisePhone,
} from "../patient-auth";

// ───────────────────────────────────────────────────────
// requestPatientOtpSchema
// ───────────────────────────────────────────────────────

describe("requestPatientOtpSchema", () => {
  it("accepts a bare 10-digit Indian phone", () => {
    expect(requestPatientOtpSchema.safeParse({ phone: "9876543210" }).success).toBe(true);
  });
  it("accepts a 0-prefixed 11-digit Indian phone", () => {
    expect(requestPatientOtpSchema.safeParse({ phone: "09876543210" }).success).toBe(true);
  });
  it("accepts a 91-prefixed 12-digit Indian phone (no +)", () => {
    expect(requestPatientOtpSchema.safeParse({ phone: "919876543210" }).success).toBe(true);
  });
  it("accepts a +91-prefixed E.164 Indian phone", () => {
    expect(requestPatientOtpSchema.safeParse({ phone: "+919876543210" }).success).toBe(true);
  });
  it("accepts a +country-code E.164 non-Indian phone (loose accept)", () => {
    // The schema is intentionally permissive at this layer — Pearl scope is
    // India-only at the route, but the schema accepts other-country E.164.
    expect(requestPatientOtpSchema.safeParse({ phone: "+12025551234" }).success).toBe(true);
  });
  it("accepts a 15-digit E.164 maximum", () => {
    expect(requestPatientOtpSchema.safeParse({ phone: "+123456789012345" }).success).toBe(true);
  });
  it("trims surrounding whitespace before regex check", () => {
    const r = requestPatientOtpSchema.safeParse({ phone: "  9876543210  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.phone).toBe("9876543210");
  });
  it("rejects a phone shorter than 10 digits", () => {
    expect(requestPatientOtpSchema.safeParse({ phone: "123456789" }).success).toBe(false);
  });
  it("rejects a phone longer than 15 digits", () => {
    expect(requestPatientOtpSchema.safeParse({ phone: "+1234567890123456" }).success).toBe(false);
  });
  it("rejects a phone with letters", () => {
    expect(requestPatientOtpSchema.safeParse({ phone: "98765abcde" }).success).toBe(false);
  });
  it("rejects a phone with embedded spaces or dashes", () => {
    expect(requestPatientOtpSchema.safeParse({ phone: "98765 43210" }).success).toBe(false);
    expect(requestPatientOtpSchema.safeParse({ phone: "98765-43210" }).success).toBe(false);
  });
  it("rejects a phone with parentheses", () => {
    expect(requestPatientOtpSchema.safeParse({ phone: "(987)6543210" }).success).toBe(false);
  });
  it("rejects empty string", () => {
    expect(requestPatientOtpSchema.safeParse({ phone: "" }).success).toBe(false);
  });
  it("rejects missing phone field", () => {
    expect(requestPatientOtpSchema.safeParse({}).success).toBe(false);
  });
  it("rejects non-string phone", () => {
    expect(requestPatientOtpSchema.safeParse({ phone: 9876543210 as any }).success).toBe(false);
  });
  it("rejects phone with multiple leading + signs", () => {
    expect(requestPatientOtpSchema.safeParse({ phone: "++919876543210" }).success).toBe(false);
  });
  it("surfaces the configured error message on regex failure", () => {
    const r = requestPatientOtpSchema.safeParse({ phone: "abc" });
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
// verifyPatientOtpSchema
// ───────────────────────────────────────────────────────

describe("verifyPatientOtpSchema", () => {
  const validPhone = "9876543210";

  it("accepts a 6-digit OTP with a valid phone", () => {
    expect(
      verifyPatientOtpSchema.safeParse({ phone: validPhone, otp: "123456" }).success,
    ).toBe(true);
  });
  it("accepts an OTP of all zeros", () => {
    expect(
      verifyPatientOtpSchema.safeParse({ phone: validPhone, otp: "000000" }).success,
    ).toBe(true);
  });
  it("accepts an OTP of all nines", () => {
    expect(
      verifyPatientOtpSchema.safeParse({ phone: validPhone, otp: "999999" }).success,
    ).toBe(true);
  });
  it("trims surrounding whitespace from phone + otp before validation", () => {
    const r = verifyPatientOtpSchema.safeParse({
      phone: "  9876543210  ",
      otp: "  123456  ",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.phone).toBe("9876543210");
      expect(r.data.otp).toBe("123456");
    }
  });
  it("rejects an OTP shorter than 6 digits", () => {
    expect(
      verifyPatientOtpSchema.safeParse({ phone: validPhone, otp: "12345" }).success,
    ).toBe(false);
  });
  it("rejects an OTP longer than 6 digits", () => {
    expect(
      verifyPatientOtpSchema.safeParse({ phone: validPhone, otp: "1234567" }).success,
    ).toBe(false);
  });
  it("rejects an OTP with letters", () => {
    expect(
      verifyPatientOtpSchema.safeParse({ phone: validPhone, otp: "12345a" }).success,
    ).toBe(false);
  });
  it("rejects an OTP with embedded space", () => {
    expect(
      verifyPatientOtpSchema.safeParse({ phone: validPhone, otp: "123 56" }).success,
    ).toBe(false);
  });
  it("rejects an OTP with a leading + (regex requires digits only)", () => {
    expect(
      verifyPatientOtpSchema.safeParse({ phone: validPhone, otp: "+12345" }).success,
    ).toBe(false);
  });
  it("rejects empty OTP", () => {
    expect(verifyPatientOtpSchema.safeParse({ phone: validPhone, otp: "" }).success).toBe(false);
  });
  it("rejects missing OTP", () => {
    expect(verifyPatientOtpSchema.safeParse({ phone: validPhone }).success).toBe(false);
  });
  it("rejects non-string OTP", () => {
    expect(
      verifyPatientOtpSchema.safeParse({ phone: validPhone, otp: 123456 as any }).success,
    ).toBe(false);
  });
  it("rejects when phone is invalid even with a valid OTP", () => {
    expect(verifyPatientOtpSchema.safeParse({ phone: "abc", otp: "123456" }).success).toBe(false);
  });
  it("rejects when both phone and OTP are missing", () => {
    expect(verifyPatientOtpSchema.safeParse({}).success).toBe(false);
  });
  it("surfaces the configured length error message", () => {
    const r = verifyPatientOtpSchema.safeParse({ phone: validPhone, otp: "12345" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /OTP must be exactly 6 digits/.test(i.message)),
      ).toBe(true);
    }
  });
  it("surfaces the digit-only error message on letter contamination", () => {
    const r = verifyPatientOtpSchema.safeParse({ phone: validPhone, otp: "abcdef" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /OTP must be 6 digits/.test(i.message))).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────
// canonicalisePhone()
// ───────────────────────────────────────────────────────

describe("canonicalisePhone()", () => {
  it("returns a bare 10-digit phone unchanged", () => {
    expect(canonicalisePhone("9876543210")).toBe("9876543210");
  });
  it("strips a leading 0 from an 11-digit 0-prefixed phone", () => {
    expect(canonicalisePhone("09876543210")).toBe("9876543210");
  });
  it("strips a leading 91 from a 12-digit 91-prefixed phone", () => {
    expect(canonicalisePhone("919876543210")).toBe("9876543210");
  });
  it("strips a leading +91 from an E.164 Indian phone", () => {
    expect(canonicalisePhone("+919876543210")).toBe("9876543210");
  });
  it("strips only the + from a non-91 E.164 phone (keeps the digits intact)", () => {
    // +1 (US) — after dropping the +, we get 11 digits starting with 1, which
    // doesn't match the 12-digit "91"-prefix or 11-digit "0"-prefix branches,
    // so it stays at 11 digits.
    expect(canonicalisePhone("+12025551234")).toBe("12025551234");
  });
  it("strips only the + from a 15-digit E.164 phone (no other prefix collapse)", () => {
    expect(canonicalisePhone("+123456789012345")).toBe("123456789012345");
  });
  it("trims surrounding whitespace before canonicalising", () => {
    expect(canonicalisePhone("  9876543210  ")).toBe("9876543210");
    expect(canonicalisePhone("\t+919876543210\n")).toBe("9876543210");
  });
  it("trims whitespace around a 0-prefixed phone and still strips the 0", () => {
    expect(canonicalisePhone("  09876543210  ")).toBe("9876543210");
  });
  it("is idempotent for a canonical 10-digit input", () => {
    const once = canonicalisePhone("9876543210");
    expect(canonicalisePhone(once)).toBe(once);
  });
  it("is idempotent across all input shapes converging to the same canonical form", () => {
    const inputs = ["9876543210", "09876543210", "919876543210", "+919876543210"];
    const canonicals = inputs.map((p) => canonicalisePhone(p));
    expect(new Set(canonicals).size).toBe(1);
    expect(canonicals[0]).toBe("9876543210");
    // Second-pass: feeding each output back in should fix-point at the same value.
    for (const c of canonicals) {
      expect(canonicalisePhone(c)).toBe(c);
    }
  });
  it("does NOT strip 91 from a 10-digit number that happens to start with 91", () => {
    // Guards against false-positive country-code stripping. Only the 12-digit
    // branch triggers the 91-prefix collapse.
    expect(canonicalisePhone("9123456789")).toBe("9123456789");
  });
  it("does NOT strip leading 0 from a 10-digit number that happens to start with 0", () => {
    // Only the 11-digit branch triggers the 0-prefix collapse.
    expect(canonicalisePhone("0987654321")).toBe("0987654321");
  });
  it("does NOT collapse a 12-digit phone whose prefix is not 91", () => {
    // 12 digits but not starting with 91 → returned as-is.
    expect(canonicalisePhone("123456789012")).toBe("123456789012");
  });
  it("does NOT collapse an 11-digit phone whose prefix is not 0", () => {
    // 11 digits but not starting with 0 → returned as-is.
    expect(canonicalisePhone("19876543210")).toBe("19876543210");
  });
  it("handles the empty string deterministically (returns empty)", () => {
    expect(canonicalisePhone("")).toBe("");
  });
  it("handles a whitespace-only string by trimming to empty", () => {
    expect(canonicalisePhone("   ")).toBe("");
  });
  it("preserves non-digit junk for callers (the helper is intentionally minimal)", () => {
    // canonicalisePhone is a digit-prefix collapser, NOT a sanitiser. The
    // schema regex is the gate that rejects malformed input — the helper only
    // promises deterministic prefix collapse for already-shaped inputs.
    expect(canonicalisePhone("abc")).toBe("abc");
  });
  it("collapses + then 91 exactly once (no double-strip)", () => {
    // After dropping +, "919876543210" is 12 digits starting with 91 → strip 91 once → 10 digits.
    expect(canonicalisePhone("+919876543210")).toBe("9876543210");
    // Sanity: feeding the output back in should NOT strip another "91"-looking digit pair.
    expect(canonicalisePhone("9876543210")).toBe("9876543210");
  });
});
