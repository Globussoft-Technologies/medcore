import { describe, it, expect } from "vitest";
import {
  loginSchema,
  registerSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
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
    password: "password123",
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
});
