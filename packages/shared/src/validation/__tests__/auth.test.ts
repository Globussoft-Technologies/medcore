import { describe, it, expect } from "vitest";
import {
  loginSchema,
  registerSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  updateProfileSchema,
} from "../auth";

describe("loginSchema", () => {
  it("accepts a valid login payload", () => {
    expect(loginSchema.safeParse({ email: "a@b.com", password: "secret123" }).success).toBe(true);
  });
  it("rejects invalid email", () => {
    expect(loginSchema.safeParse({ email: "not-an-email", password: "secret123" }).success).toBe(false);
  });
  it("rejects short password", () => {
    expect(loginSchema.safeParse({ email: "a@b.com", password: "12345" }).success).toBe(false);
  });
  it("rejects missing fields", () => {
    expect(loginSchema.safeParse({ email: "a@b.com" }).success).toBe(false);
  });
});

describe("registerSchema", () => {
  const valid = {
    name: "Alice",
    email: "alice@example.com",
    phone: "9000000000",
    // Issue #266: `password123` is on the denylist; use a unique strong pw.
    password: "Br0nzeFalc0n",
    role: "DOCTOR" as const,
  };
  it("accepts a valid register payload", () => {
    expect(registerSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects invalid role", () => {
    expect(registerSchema.safeParse({ ...valid, role: "GOD" as any }).success).toBe(false);
  });
  it("rejects too-short name", () => {
    expect(registerSchema.safeParse({ ...valid, name: "A" }).success).toBe(false);
  });
  it("rejects too-short phone", () => {
    expect(registerSchema.safeParse({ ...valid, phone: "12345" }).success).toBe(false);
  });
});

describe("changePasswordSchema", () => {
  it("accepts valid input", () => {
    expect(
      changePasswordSchema.safeParse({ currentPassword: "old", newPassword: "newer123" }).success
    ).toBe(true);
  });
  it("rejects empty current password", () => {
    expect(
      changePasswordSchema.safeParse({ currentPassword: "", newPassword: "newer123" }).success
    ).toBe(false);
  });
  it("rejects short new password", () => {
    expect(
      changePasswordSchema.safeParse({ currentPassword: "x", newPassword: "1" }).success
    ).toBe(false);
  });
});

describe("forgotPasswordSchema", () => {
  it("accepts a valid email", () => {
    expect(forgotPasswordSchema.safeParse({ email: "a@b.com" }).success).toBe(true);
  });
  it("rejects bad email", () => {
    expect(forgotPasswordSchema.safeParse({ email: "nope" }).success).toBe(false);
  });
});

describe("resetPasswordSchema", () => {
  it("accepts a valid reset payload", () => {
    expect(
      resetPasswordSchema.safeParse({
        email: "a@b.com",
        code: "123456",
        newPassword: "newer123",
      }).success
    ).toBe(true);
  });
  it("rejects code that is not exactly 6 chars", () => {
    expect(
      resetPasswordSchema.safeParse({
        email: "a@b.com",
        code: "12345",
        newPassword: "newer123",
      }).success
    ).toBe(false);
  });

  // Issue #493 (May 2026): the new-password field on /reset-password must
  // enforce the SAME strongPassword rules as /register and /change-password —
  // otherwise an attacker can use the reset flow as a back-door to set a
  // weak password (e.g. "password", "123456", any 6-char string). These
  // tests pin the contract that the schema (and therefore the route) rejects
  // weak passwords with a 400 BEFORE the route handler runs, regardless of
  // whether the email is known.
  it("rejects newPassword that is too short (<8 chars) (#493)", () => {
    const r = resetPasswordSchema.safeParse({
      email: "a@b.com",
      code: "123456",
      newPassword: "abc12",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join(" ");
      expect(msg.toLowerCase()).toMatch(/8 characters|too weak/);
    }
  });
  it("rejects newPassword on the common-password denylist (#493)", () => {
    // "password" is in the top-100 list — even though it's 8 chars long it
    // still must fail strongPassword.
    const r = resetPasswordSchema.safeParse({
      email: "a@b.com",
      code: "123456",
      newPassword: "password",
    });
    expect(r.success).toBe(false);
  });
  it("rejects newPassword 'password1' (denylisted) (#493)", () => {
    const r = resetPasswordSchema.safeParse({
      email: "a@b.com",
      code: "123456",
      newPassword: "password1",
    });
    expect(r.success).toBe(false);
  });
  it("rejects numeric-only newPassword (no letter) (#493)", () => {
    // 8+ chars but no letter — strongPassword requires letter+digit.
    const r = resetPasswordSchema.safeParse({
      email: "a@b.com",
      code: "123456",
      newPassword: "98765432",
    });
    expect(r.success).toBe(false);
  });
  it("rejects letter-only newPassword (no digit) (#493)", () => {
    const r = resetPasswordSchema.safeParse({
      email: "a@b.com",
      code: "123456",
      newPassword: "onlyletters",
    });
    expect(r.success).toBe(false);
  });
  it("accepts a strong newPassword (#493)", () => {
    // Long, mixed letter+digit, NOT on denylist.
    const r = resetPasswordSchema.safeParse({
      email: "a@b.com",
      code: "123456",
      newPassword: "Br0nzeFalc0n",
    });
    expect(r.success).toBe(true);
  });
});

// Issue #138 (Apr 2026)
describe("updateProfileSchema", () => {
  it("accepts a valid update", () => {
    expect(
      updateProfileSchema.safeParse({ name: "Anand", phone: "9876543210" })
        .success
    ).toBe(true);
  });
  it("accepts E.164 phones with leading +", () => {
    expect(
      updateProfileSchema.safeParse({ phone: "+919876543210" }).success
    ).toBe(true);
  });
  it("rejects empty (only whitespace) name", () => {
    expect(updateProfileSchema.safeParse({ name: "   " }).success).toBe(false);
  });
  it("rejects bogus phone", () => {
    expect(updateProfileSchema.safeParse({ phone: "abc" }).success).toBe(false);
  });
  it("rejects too-short phone", () => {
    expect(
      updateProfileSchema.safeParse({ phone: "12345" }).success
    ).toBe(false);
  });
  it("rejects phone with spaces", () => {
    expect(
      updateProfileSchema.safeParse({ phone: "987 654 3210" }).success
    ).toBe(false);
  });
  it("rejects empty body (nothing to update)", () => {
    expect(updateProfileSchema.safeParse({}).success).toBe(false);
  });
});
