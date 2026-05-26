// Coverage tests for Branch validation schemas (Pearl ERP Stage 1 §7.2 + §8.1).
// What: exhaustive happy / invalid / edge cases for every exported schema in
//   packages/shared/src/validation/branch.ts — createBranchSchema and
//   updateBranchSchema. Multi-tenant Branch CRUD; tenantId is resolved from
//   auth context and intentionally NOT in the schema surface.
// Which modules: imports only from ../branch (schemas).
// Why: file shipped with 0% colocated test coverage. Locks in the contract
//   shared between the admin UI form and the Express handler so neither side
//   can drift. Particularly important to pin: (a) trim+toUpperCase coercion
//   on branch `code` before the /^[A-Z0-9_-]{1,10}$/ regex (admins typing
//   "main" still pass); (b) the 6-digit `pincode` regex; (c) the loose
//   `phone` regex /^\+?\d{7,15}$/ — no spaces/dashes accepted; (d) the
//   strict GSTIN structural regex (2 digits + 5 letters + 4 digits + 1
//   letter + 1 alphanum + Z + 1 alphanum); (e) the .default(false) on
//   `isDefault` for create; (f) the update schema's all-optional patch
//   shape with nullable string fields.
import { describe, it, expect } from "vitest";
import { createBranchSchema, updateBranchSchema } from "../branch";

// ───────────────────────────────────────────────────────
// createBranchSchema
// ───────────────────────────────────────────────────────

describe("createBranchSchema", () => {
  const valid = {
    name: "Main Hospital — Jayanagar",
  };

  it("accepts a minimal valid branch (name only)", () => {
    const r = createBranchSchema.safeParse(valid);
    expect(r.success).toBe(true);
  });

  it("defaults isDefault to false when omitted", () => {
    const r = createBranchSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.isDefault).toBe(false);
  });

  it("accepts a fully-populated branch", () => {
    const r = createBranchSchema.safeParse({
      ...valid,
      code: "JKR-01",
      address: "12 MG Road, Jayanagar 4th Block",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560011",
      phone: "+919876543210",
      email: "jayanagar@medcore.example.com",
      gstin: "29ABCDE1234F1Z5",
      isDefault: true,
    });
    expect(r.success).toBe(true);
  });

  // ─── name ───
  it("trims surrounding whitespace on name", () => {
    const r = createBranchSchema.safeParse({ name: "  Whitefield Clinic  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe("Whitefield Clinic");
  });
  it("rejects name shorter than 2 chars (post-trim)", () => {
    expect(createBranchSchema.safeParse({ name: "A" }).success).toBe(false);
  });
  it("rejects name that becomes empty after trim", () => {
    expect(createBranchSchema.safeParse({ name: "   " }).success).toBe(false);
  });
  it("accepts name at exactly 2 chars (lower boundary)", () => {
    expect(createBranchSchema.safeParse({ name: "AB" }).success).toBe(true);
  });
  it("accepts name at exactly 120 chars (upper boundary)", () => {
    expect(createBranchSchema.safeParse({ name: "x".repeat(120) }).success).toBe(true);
  });
  it("rejects name longer than 120 chars", () => {
    expect(createBranchSchema.safeParse({ name: "x".repeat(121) }).success).toBe(false);
  });
  it("rejects missing name", () => {
    expect(createBranchSchema.safeParse({}).success).toBe(false);
  });
  it("rejects non-string name", () => {
    expect(createBranchSchema.safeParse({ name: 42 as any }).success).toBe(false);
  });

  // ─── code (trim + toUpperCase before regex) ───
  it("uppercases lowercase code before regex check", () => {
    const r = createBranchSchema.safeParse({ ...valid, code: "main" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.code).toBe("MAIN");
  });
  it("uppercases mixed-case code", () => {
    const r = createBranchSchema.safeParse({ ...valid, code: "JkR_01" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.code).toBe("JKR_01");
  });
  it("trims surrounding whitespace from code", () => {
    const r = createBranchSchema.safeParse({ ...valid, code: "  btm  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.code).toBe("BTM");
  });
  it("accepts code at length 1 (lower boundary)", () => {
    expect(createBranchSchema.safeParse({ ...valid, code: "A" }).success).toBe(true);
  });
  it("accepts code at length 10 (upper boundary)", () => {
    expect(createBranchSchema.safeParse({ ...valid, code: "ABCDEFGHIJ" }).success).toBe(true);
  });
  it("accepts code containing digits", () => {
    expect(createBranchSchema.safeParse({ ...valid, code: "JKR01" }).success).toBe(true);
  });
  it("accepts code containing underscore", () => {
    expect(createBranchSchema.safeParse({ ...valid, code: "MAIN_HQ" }).success).toBe(true);
  });
  it("accepts code containing dash", () => {
    expect(createBranchSchema.safeParse({ ...valid, code: "JKR-01" }).success).toBe(true);
  });
  it("rejects code longer than 10 chars", () => {
    const r = createBranchSchema.safeParse({ ...valid, code: "ABCDEFGHIJK" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Branch code must be/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects code containing space (post-trim, mid-string)", () => {
    expect(createBranchSchema.safeParse({ ...valid, code: "MAIN HQ" }).success).toBe(false);
  });
  it("rejects code containing dot", () => {
    expect(createBranchSchema.safeParse({ ...valid, code: "MAIN.HQ" }).success).toBe(false);
  });
  it("rejects code containing punctuation", () => {
    expect(createBranchSchema.safeParse({ ...valid, code: "MAIN/HQ" }).success).toBe(false);
  });
  it("rejects code that becomes empty after trim", () => {
    expect(createBranchSchema.safeParse({ ...valid, code: "   " }).success).toBe(false);
  });
  it("accepts null code (explicit clear)", () => {
    const r = createBranchSchema.safeParse({ ...valid, code: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.code).toBeNull();
  });
  it("accepts code omitted entirely", () => {
    const r = createBranchSchema.safeParse(valid);
    expect(r.success).toBe(true);
  });

  // ─── address ───
  it("accepts address at exactly 512 chars (upper boundary)", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, address: "x".repeat(512) }).success
    ).toBe(true);
  });
  it("rejects address longer than 512 chars", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, address: "x".repeat(513) }).success
    ).toBe(false);
  });
  it("accepts null address", () => {
    expect(createBranchSchema.safeParse({ ...valid, address: null }).success).toBe(true);
  });
  it("trims surrounding whitespace on address", () => {
    const r = createBranchSchema.safeParse({ ...valid, address: "  12 MG Road  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.address).toBe("12 MG Road");
  });

  // ─── city ───
  it("accepts city at exactly 80 chars (upper boundary)", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, city: "x".repeat(80) }).success
    ).toBe(true);
  });
  it("rejects city longer than 80 chars", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, city: "x".repeat(81) }).success
    ).toBe(false);
  });
  it("accepts null city", () => {
    expect(createBranchSchema.safeParse({ ...valid, city: null }).success).toBe(true);
  });

  // ─── state ───
  it("accepts state at exactly 80 chars (upper boundary)", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, state: "x".repeat(80) }).success
    ).toBe(true);
  });
  it("rejects state longer than 80 chars", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, state: "x".repeat(81) }).success
    ).toBe(false);
  });
  it("accepts null state", () => {
    expect(createBranchSchema.safeParse({ ...valid, state: null }).success).toBe(true);
  });

  // ─── pincode (Indian 6-digit) ───
  it("accepts a valid 6-digit pincode", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, pincode: "560011" }).success
    ).toBe(true);
  });
  it("trims surrounding whitespace from pincode", () => {
    const r = createBranchSchema.safeParse({ ...valid, pincode: "  560011  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.pincode).toBe("560011");
  });
  it("rejects 5-digit pincode", () => {
    const r = createBranchSchema.safeParse({ ...valid, pincode: "56001" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /Pincode must be 6 digits/.test(i.message))).toBe(
        true
      );
    }
  });
  it("rejects 7-digit pincode", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, pincode: "5600110" }).success
    ).toBe(false);
  });
  it("rejects pincode containing letters", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, pincode: "56001A" }).success
    ).toBe(false);
  });
  it("rejects pincode containing dash", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, pincode: "560-011" }).success
    ).toBe(false);
  });
  it("rejects empty-string pincode (regex floor)", () => {
    expect(createBranchSchema.safeParse({ ...valid, pincode: "" }).success).toBe(false);
  });
  it("accepts null pincode", () => {
    expect(createBranchSchema.safeParse({ ...valid, pincode: null }).success).toBe(true);
  });

  // ─── phone (loose /^\+?\d{7,15}$/) ───
  it("accepts phone with leading +", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, phone: "+919876543210" }).success
    ).toBe(true);
  });
  it("accepts phone without +", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, phone: "9876543210" }).success
    ).toBe(true);
  });
  it("accepts phone at exactly 7 digits (regex floor)", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, phone: "1234567" }).success
    ).toBe(true);
  });
  it("accepts phone at exactly 15 digits (regex ceiling)", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, phone: "123456789012345" }).success
    ).toBe(true);
  });
  it("trims surrounding whitespace from phone", () => {
    const r = createBranchSchema.safeParse({ ...valid, phone: "  +919876543210  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.phone).toBe("+919876543210");
  });
  it("rejects phone shorter than 7 digits", () => {
    const r = createBranchSchema.safeParse({ ...valid, phone: "123456" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /Invalid phone/.test(i.message))).toBe(true);
    }
  });
  it("rejects phone longer than 15 digits", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, phone: "1234567890123456" }).success
    ).toBe(false);
  });
  it("rejects phone with internal spaces", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, phone: "+91 98765 43210" }).success
    ).toBe(false);
  });
  it("rejects phone with dashes", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, phone: "+1-555-867-5309" }).success
    ).toBe(false);
  });
  it("rejects phone with letters", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, phone: "98765abcde" }).success
    ).toBe(false);
  });
  it("accepts null phone", () => {
    expect(createBranchSchema.safeParse({ ...valid, phone: null }).success).toBe(true);
  });

  // ─── email ───
  it("accepts a normal email", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, email: "branch@medcore.example.com" })
        .success
    ).toBe(true);
  });
  it("rejects malformed email (no @)", () => {
    const r = createBranchSchema.safeParse({ ...valid, email: "not-an-email" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /Invalid email/.test(i.message))).toBe(true);
    }
  });
  it("rejects email missing domain", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, email: "branch@" }).success
    ).toBe(false);
  });
  it("rejects email missing local part", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, email: "@example.com" }).success
    ).toBe(false);
  });
  it("accepts null email", () => {
    expect(createBranchSchema.safeParse({ ...valid, email: null }).success).toBe(true);
  });

  // ─── gstin (15-char structural) ───
  it("accepts a valid GSTIN", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, gstin: "29ABCDE1234F1Z5" }).success
    ).toBe(true);
  });
  it("uppercases lowercase GSTIN before regex check", () => {
    const r = createBranchSchema.safeParse({ ...valid, gstin: "29abcde1234f1z5" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.gstin).toBe("29ABCDE1234F1Z5");
  });
  it("trims surrounding whitespace from GSTIN", () => {
    const r = createBranchSchema.safeParse({ ...valid, gstin: "  29ABCDE1234F1Z5  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.gstin).toBe("29ABCDE1234F1Z5");
  });
  it("rejects GSTIN of wrong length (14 chars)", () => {
    const r = createBranchSchema.safeParse({ ...valid, gstin: "29ABCDE1234F1Z" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /Invalid GSTIN/.test(i.message))).toBe(true);
    }
  });
  it("rejects GSTIN of wrong length (16 chars)", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, gstin: "29ABCDE1234F1Z55" }).success
    ).toBe(false);
  });
  it("rejects GSTIN missing the Z separator (13th char)", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, gstin: "29ABCDE1234F1A5" }).success
    ).toBe(false);
  });
  it("rejects GSTIN with letters in state-code position", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, gstin: "AAABCDE1234F1Z5" }).success
    ).toBe(false);
  });
  it("rejects GSTIN with digits in PAN-letters position", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, gstin: "2912345E1234F1Z5" }).success
    ).toBe(false);
  });
  it("rejects GSTIN with entity char = 0 ([1-9A-Z] excludes 0)", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, gstin: "29ABCDE1234F0Z5" }).success
    ).toBe(false);
  });
  it("accepts GSTIN with entity char as letter", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, gstin: "29ABCDE1234FAZ5" }).success
    ).toBe(true);
  });
  it("accepts null GSTIN", () => {
    expect(createBranchSchema.safeParse({ ...valid, gstin: null }).success).toBe(true);
  });

  // ─── isDefault ───
  it("accepts isDefault true", () => {
    const r = createBranchSchema.safeParse({ ...valid, isDefault: true });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.isDefault).toBe(true);
  });
  it("accepts isDefault false (explicit)", () => {
    const r = createBranchSchema.safeParse({ ...valid, isDefault: false });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.isDefault).toBe(false);
  });
  it("rejects non-boolean isDefault", () => {
    expect(
      createBranchSchema.safeParse({ ...valid, isDefault: "yes" as any }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// updateBranchSchema
// ───────────────────────────────────────────────────────

describe("updateBranchSchema", () => {
  it("accepts an empty patch (every field optional)", () => {
    expect(updateBranchSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a name-only patch", () => {
    expect(updateBranchSchema.safeParse({ name: "Renamed Branch" }).success).toBe(true);
  });

  it("accepts a code-only patch and uppercases it", () => {
    const r = updateBranchSchema.safeParse({ code: "main_hq" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.code).toBe("MAIN_HQ");
  });

  it("accepts an isDefault toggle", () => {
    expect(updateBranchSchema.safeParse({ isDefault: true }).success).toBe(true);
  });

  it("accepts an active=false deactivation", () => {
    expect(updateBranchSchema.safeParse({ active: false }).success).toBe(true);
  });

  it("accepts an active=true reactivation", () => {
    expect(updateBranchSchema.safeParse({ active: true }).success).toBe(true);
  });

  it("rejects non-boolean active", () => {
    expect(updateBranchSchema.safeParse({ active: "yes" as any }).success).toBe(false);
  });

  it("rejects non-boolean isDefault", () => {
    expect(updateBranchSchema.safeParse({ isDefault: "yes" as any }).success).toBe(false);
  });

  // ─── name ───
  it("rejects name below 2 chars", () => {
    expect(updateBranchSchema.safeParse({ name: "A" }).success).toBe(false);
  });
  it("rejects name above 120 chars", () => {
    expect(updateBranchSchema.safeParse({ name: "x".repeat(121) }).success).toBe(false);
  });
  it("accepts name at exactly 120 chars", () => {
    expect(updateBranchSchema.safeParse({ name: "x".repeat(120) }).success).toBe(true);
  });
  it("trims whitespace on name", () => {
    const r = updateBranchSchema.safeParse({ name: "  Trimmed  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe("Trimmed");
  });
  it("rejects name that becomes empty after trim", () => {
    expect(updateBranchSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  // ─── code (nullable + uppercase + regex) ───
  it("accepts null code (clears the field)", () => {
    expect(updateBranchSchema.safeParse({ code: null }).success).toBe(true);
  });
  it("rejects code longer than 10 chars", () => {
    expect(updateBranchSchema.safeParse({ code: "ABCDEFGHIJK" }).success).toBe(false);
  });
  it("rejects code containing dot", () => {
    expect(updateBranchSchema.safeParse({ code: "A.B" }).success).toBe(false);
  });
  it("rejects code containing space", () => {
    expect(updateBranchSchema.safeParse({ code: "A B" }).success).toBe(false);
  });
  it("accepts code with dash", () => {
    const r = updateBranchSchema.safeParse({ code: "JKR-01" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.code).toBe("JKR-01");
  });

  // ─── address (nullable) ───
  it("accepts null address", () => {
    expect(updateBranchSchema.safeParse({ address: null }).success).toBe(true);
  });
  it("rejects address longer than 512 chars", () => {
    expect(updateBranchSchema.safeParse({ address: "x".repeat(513) }).success).toBe(false);
  });
  it("accepts address at exactly 512 chars", () => {
    expect(updateBranchSchema.safeParse({ address: "x".repeat(512) }).success).toBe(true);
  });

  // ─── city / state (nullable + max 80) ───
  it("accepts null city", () => {
    expect(updateBranchSchema.safeParse({ city: null }).success).toBe(true);
  });
  it("rejects city longer than 80 chars", () => {
    expect(updateBranchSchema.safeParse({ city: "x".repeat(81) }).success).toBe(false);
  });
  it("accepts null state", () => {
    expect(updateBranchSchema.safeParse({ state: null }).success).toBe(true);
  });
  it("rejects state longer than 80 chars", () => {
    expect(updateBranchSchema.safeParse({ state: "x".repeat(81) }).success).toBe(false);
  });

  // ─── pincode (nullable + regex) ───
  it("accepts null pincode", () => {
    expect(updateBranchSchema.safeParse({ pincode: null }).success).toBe(true);
  });
  it("accepts valid 6-digit pincode", () => {
    expect(updateBranchSchema.safeParse({ pincode: "110001" }).success).toBe(true);
  });
  it("rejects 5-digit pincode", () => {
    expect(updateBranchSchema.safeParse({ pincode: "11000" }).success).toBe(false);
  });
  it("rejects letters in pincode", () => {
    expect(updateBranchSchema.safeParse({ pincode: "11000A" }).success).toBe(false);
  });

  // ─── phone (nullable + regex) ───
  it("accepts null phone", () => {
    expect(updateBranchSchema.safeParse({ phone: null }).success).toBe(true);
  });
  it("accepts valid phone", () => {
    expect(updateBranchSchema.safeParse({ phone: "+919876543210" }).success).toBe(true);
  });
  it("rejects phone with spaces", () => {
    expect(updateBranchSchema.safeParse({ phone: "+91 98765 43210" }).success).toBe(false);
  });
  it("rejects phone with letters", () => {
    expect(updateBranchSchema.safeParse({ phone: "abc1234567" }).success).toBe(false);
  });
  it("rejects phone shorter than 7 digits", () => {
    expect(updateBranchSchema.safeParse({ phone: "123" }).success).toBe(false);
  });
  it("rejects phone longer than 15 digits", () => {
    expect(updateBranchSchema.safeParse({ phone: "1234567890123456" }).success).toBe(false);
  });

  // ─── email (nullable) ───
  it("accepts null email", () => {
    expect(updateBranchSchema.safeParse({ email: null }).success).toBe(true);
  });
  it("accepts valid email", () => {
    expect(
      updateBranchSchema.safeParse({ email: "ops@medcore.example.com" }).success
    ).toBe(true);
  });
  it("rejects malformed email", () => {
    expect(updateBranchSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
  });

  // ─── gstin (nullable + uppercase + structural) ───
  it("accepts null GSTIN", () => {
    expect(updateBranchSchema.safeParse({ gstin: null }).success).toBe(true);
  });
  it("accepts valid GSTIN", () => {
    expect(updateBranchSchema.safeParse({ gstin: "29ABCDE1234F1Z5" }).success).toBe(true);
  });
  it("uppercases lowercase GSTIN before regex check", () => {
    const r = updateBranchSchema.safeParse({ gstin: "29abcde1234f1z5" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.gstin).toBe("29ABCDE1234F1Z5");
  });
  it("rejects malformed GSTIN", () => {
    expect(updateBranchSchema.safeParse({ gstin: "GARBAGE" }).success).toBe(false);
  });
  it("rejects GSTIN of wrong length", () => {
    expect(updateBranchSchema.safeParse({ gstin: "29ABCDE1234F1Z" }).success).toBe(false);
  });

  // ─── multi-field combo ───
  it("accepts a multi-field patch updating address + phone + isDefault", () => {
    expect(
      updateBranchSchema.safeParse({
        address: "New address line",
        phone: "+918888888888",
        isDefault: true,
      }).success
    ).toBe(true);
  });
});
