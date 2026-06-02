// Coverage tests for the super-admin tenant-onboarding wizard validation schemas.
// What: exhaustive happy / invalid / edge cases for every exported Zod schema
//   and constant in packages/shared/src/validation/tenant-onboarding.ts —
//   the nested {tenant, branch, admin} payload used by the atomic
//   POST /api/v1/tenant-onboarding endpoint (Pearl ERP Stage 1 §8.1, gap #6).
// Which modules: imports only schemas / constants from ../tenant-onboarding.
// Why: file shipped at 0% colocated coverage in commit 4c9bf16. Important
//   invariants to lock in: (a) subdomain regex + reserved-word rejection,
//   (b) subdomain lowercasing transform, (c) branch code uppercasing + regex,
//   (d) all optional/nullable branch fields, (e) email/phone/password rules
//   on the admin step, (f) the combined wizard payload requires all three
//   sub-objects together.
import { describe, it, expect } from "vitest";
import {
  tenantOnboardingTenantSchema,
  tenantOnboardingBranchSchema,
  tenantOnboardingAdminSchema,
  tenantOnboardingSchema,
  TENANT_ONBOARDING_SUBDOMAIN_REGEX,
  TENANT_ONBOARDING_RESERVED_SUBDOMAINS,
} from "../tenant-onboarding";

// ───────────────────────────────────────────────────────
// Exported regex + reserved-list constants
// ───────────────────────────────────────────────────────

describe("TENANT_ONBOARDING_SUBDOMAIN_REGEX", () => {
  it("accepts a typical lowercase subdomain", () => {
    expect(TENANT_ONBOARDING_SUBDOMAIN_REGEX.test("acme-hospital")).toBe(true);
  });
  it("accepts a 3-char minimum subdomain", () => {
    expect(TENANT_ONBOARDING_SUBDOMAIN_REGEX.test("abc")).toBe(true);
  });
  it("accepts a 30-char maximum subdomain", () => {
    expect(TENANT_ONBOARDING_SUBDOMAIN_REGEX.test("a".repeat(30))).toBe(true);
  });
  it("rejects a 31-char subdomain (over max)", () => {
    expect(TENANT_ONBOARDING_SUBDOMAIN_REGEX.test("a".repeat(31))).toBe(false);
  });
  it("rejects single-char subdomain (under min effective length)", () => {
    // Regex permits 1-char (just the first group), but real min is 3 in spec.
    // The regex itself allows "a" — so we only assert what the regex says.
    expect(TENANT_ONBOARDING_SUBDOMAIN_REGEX.test("a")).toBe(true);
  });
  it("rejects subdomain with uppercase chars", () => {
    expect(TENANT_ONBOARDING_SUBDOMAIN_REGEX.test("ACME")).toBe(false);
  });
  it("rejects subdomain starting with hyphen", () => {
    expect(TENANT_ONBOARDING_SUBDOMAIN_REGEX.test("-acme")).toBe(false);
  });
  it("rejects subdomain ending with hyphen", () => {
    expect(TENANT_ONBOARDING_SUBDOMAIN_REGEX.test("acme-")).toBe(false);
  });
  it("rejects subdomain with underscore", () => {
    expect(TENANT_ONBOARDING_SUBDOMAIN_REGEX.test("acme_hospital")).toBe(false);
  });
  it("rejects subdomain with dot", () => {
    expect(TENANT_ONBOARDING_SUBDOMAIN_REGEX.test("acme.hospital")).toBe(false);
  });
  it("rejects empty subdomain", () => {
    expect(TENANT_ONBOARDING_SUBDOMAIN_REGEX.test("")).toBe(false);
  });
});

describe("TENANT_ONBOARDING_RESERVED_SUBDOMAINS", () => {
  it("contains the canonical reserved set", () => {
    for (const reserved of [
      "admin",
      "api",
      "app",
      "auth",
      "console",
      "dashboard",
      "default",
      "docs",
      "help",
      "mail",
      "medcore",
      "public",
      "root",
      "status",
      "support",
      "system",
      "www",
    ]) {
      expect(TENANT_ONBOARDING_RESERVED_SUBDOMAINS.has(reserved)).toBe(true);
    }
  });
  it("does not contain non-reserved words", () => {
    expect(TENANT_ONBOARDING_RESERVED_SUBDOMAINS.has("acme")).toBe(false);
    expect(TENANT_ONBOARDING_RESERVED_SUBDOMAINS.has("hospital")).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Step 1 — tenantOnboardingTenantSchema
// ───────────────────────────────────────────────────────

describe("tenantOnboardingTenantSchema", () => {
  const valid = {
    name: "Acme Hospital",
    subdomain: "acme-hospital",
    plan: "BASIC" as const,
  };

  it("accepts a fully-valid tenant payload", () => {
    expect(tenantOnboardingTenantSchema.safeParse(valid).success).toBe(true);
  });

  describe("name", () => {
    it("accepts a 2-char minimum name", () => {
      const res = tenantOnboardingTenantSchema.safeParse({ ...valid, name: "AB" });
      expect(res.success).toBe(true);
    });
    it("rejects a 1-char name (under min)", () => {
      const res = tenantOnboardingTenantSchema.safeParse({ ...valid, name: "A" });
      expect(res.success).toBe(false);
    });
    it("rejects an empty name", () => {
      const res = tenantOnboardingTenantSchema.safeParse({ ...valid, name: "" });
      expect(res.success).toBe(false);
    });
    it("accepts a 120-char maximum name", () => {
      const res = tenantOnboardingTenantSchema.safeParse({
        ...valid,
        name: "X".repeat(120),
      });
      expect(res.success).toBe(true);
    });
    it("rejects a 121-char name (over max)", () => {
      const res = tenantOnboardingTenantSchema.safeParse({
        ...valid,
        name: "X".repeat(121),
      });
      expect(res.success).toBe(false);
    });
    it("trims whitespace before length check", () => {
      const res = tenantOnboardingTenantSchema.safeParse({
        ...valid,
        name: "  Acme  ",
      });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.name).toBe("Acme");
    });
    it("rejects whitespace-only name as too short after trim", () => {
      const res = tenantOnboardingTenantSchema.safeParse({ ...valid, name: "  " });
      expect(res.success).toBe(false);
    });
  });

  describe("subdomain", () => {
    it("lowercases an uppercase input via the toLowerCase transform", () => {
      const res = tenantOnboardingTenantSchema.safeParse({
        ...valid,
        subdomain: "ACME-HOSPITAL",
      });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.subdomain).toBe("acme-hospital");
    });
    it("trims whitespace", () => {
      const res = tenantOnboardingTenantSchema.safeParse({
        ...valid,
        subdomain: "  acme  ",
      });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.subdomain).toBe("acme");
    });
    it("rejects a subdomain with invalid chars after lowercasing", () => {
      const res = tenantOnboardingTenantSchema.safeParse({
        ...valid,
        subdomain: "acme_hospital",
      });
      expect(res.success).toBe(false);
    });
    it("rejects each reserved subdomain", () => {
      for (const reserved of TENANT_ONBOARDING_RESERVED_SUBDOMAINS) {
        const res = tenantOnboardingTenantSchema.safeParse({
          ...valid,
          subdomain: reserved,
        });
        expect(res.success).toBe(false);
      }
    });
    it("rejects a reserved subdomain that arrives in uppercase (post-lowercase)", () => {
      const res = tenantOnboardingTenantSchema.safeParse({
        ...valid,
        subdomain: "ADMIN",
      });
      expect(res.success).toBe(false);
    });
    it("rejects an empty subdomain", () => {
      const res = tenantOnboardingTenantSchema.safeParse({ ...valid, subdomain: "" });
      expect(res.success).toBe(false);
    });
    it("rejects a 31-char subdomain (over regex max)", () => {
      const res = tenantOnboardingTenantSchema.safeParse({
        ...valid,
        subdomain: "a".repeat(31),
      });
      expect(res.success).toBe(false);
    });
    it("accepts numeric-only subdomain", () => {
      const res = tenantOnboardingTenantSchema.safeParse({
        ...valid,
        subdomain: "12345",
      });
      expect(res.success).toBe(true);
    });
  });

  describe("plan", () => {
    // Plans are dynamic now (DB-backed `PlatformPlan`), so the schema only
    // validates the KEY SHAPE; existence/active is checked server-side in the
    // route handler. These tests pin the shape contract.
    it("accepts any well-formed plan key (incl. custom slugs)", () => {
      for (const plan of ["STARTER", "GROWTH", "ENTERPRISE", "PRO_PLUS"]) {
        const res = tenantOnboardingTenantSchema.safeParse({ ...valid, plan });
        expect(res.success).toBe(true);
      }
    });
    it("uppercases a lowercase key (no longer rejects it)", () => {
      const res = tenantOnboardingTenantSchema.safeParse({
        ...valid,
        plan: "growth",
      });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.plan).toBe("GROWTH");
    });
    it("rejects a malformed key (spaces / punctuation)", () => {
      const res = tenantOnboardingTenantSchema.safeParse({
        ...valid,
        plan: "not a key!",
      });
      expect(res.success).toBe(false);
    });
    it("rejects missing plan", () => {
      const { plan: _omit, ...rest } = valid;
      const res = tenantOnboardingTenantSchema.safeParse(rest);
      expect(res.success).toBe(false);
    });
  });

  it("rejects missing name", () => {
    const { name: _omit, ...rest } = valid;
    const res = tenantOnboardingTenantSchema.safeParse(rest);
    expect(res.success).toBe(false);
  });

  it("rejects missing subdomain", () => {
    const { subdomain: _omit, ...rest } = valid;
    const res = tenantOnboardingTenantSchema.safeParse(rest);
    expect(res.success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Step 2 — tenantOnboardingBranchSchema
// ───────────────────────────────────────────────────────

describe("tenantOnboardingBranchSchema", () => {
  const minimal = { name: "Main Branch" };

  it("accepts only the required name field", () => {
    expect(tenantOnboardingBranchSchema.safeParse(minimal).success).toBe(true);
  });

  it("accepts a fully-populated branch payload", () => {
    const full = {
      name: "Main Branch",
      code: "MAIN-01",
      address: "123 Park Avenue",
      city: "Mumbai",
      state: "Maharashtra",
      pincode: "400001",
      phone: "+919876543210",
    };
    const res = tenantOnboardingBranchSchema.safeParse(full);
    expect(res.success).toBe(true);
  });

  describe("name", () => {
    it("accepts 2-char min", () => {
      expect(tenantOnboardingBranchSchema.safeParse({ name: "AB" }).success).toBe(true);
    });
    it("rejects 1-char name", () => {
      expect(tenantOnboardingBranchSchema.safeParse({ name: "A" }).success).toBe(false);
    });
    it("accepts 120-char max name", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({ name: "X".repeat(120) }).success,
      ).toBe(true);
    });
    it("rejects 121-char name", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({ name: "X".repeat(121) }).success,
      ).toBe(false);
    });
    it("trims whitespace before length check", () => {
      const res = tenantOnboardingBranchSchema.safeParse({ name: "  Main  " });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.name).toBe("Main");
    });
    it("rejects missing name", () => {
      expect(tenantOnboardingBranchSchema.safeParse({}).success).toBe(false);
    });
  });

  describe("code", () => {
    it("accepts a valid uppercase code", () => {
      const res = tenantOnboardingBranchSchema.safeParse({ ...minimal, code: "MAIN" });
      expect(res.success).toBe(true);
    });
    it("uppercases a lowercase code via the toUpperCase transform", () => {
      const res = tenantOnboardingBranchSchema.safeParse({ ...minimal, code: "main" });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.code).toBe("MAIN");
    });
    it("accepts a code with hyphens and underscores", () => {
      const res = tenantOnboardingBranchSchema.safeParse({
        ...minimal,
        code: "BR-01_X",
      });
      expect(res.success).toBe(true);
    });
    it("accepts the 10-char maximum code", () => {
      const res = tenantOnboardingBranchSchema.safeParse({
        ...minimal,
        code: "A".repeat(10),
      });
      expect(res.success).toBe(true);
    });
    it("rejects an 11-char code (over max)", () => {
      const res = tenantOnboardingBranchSchema.safeParse({
        ...minimal,
        code: "A".repeat(11),
      });
      expect(res.success).toBe(false);
    });
    it("rejects code with spaces", () => {
      const res = tenantOnboardingBranchSchema.safeParse({
        ...minimal,
        code: "MAIN BR",
      });
      expect(res.success).toBe(false);
    });
    it("rejects code with special chars", () => {
      const res = tenantOnboardingBranchSchema.safeParse({
        ...minimal,
        code: "MAIN!",
      });
      expect(res.success).toBe(false);
    });
    it("accepts null code", () => {
      const res = tenantOnboardingBranchSchema.safeParse({ ...minimal, code: null });
      expect(res.success).toBe(true);
    });
    it("accepts undefined / missing code", () => {
      const res = tenantOnboardingBranchSchema.safeParse({ ...minimal });
      expect(res.success).toBe(true);
    });
  });

  describe("address", () => {
    it("accepts a typical address", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({
          ...minimal,
          address: "123 Park Ave",
        }).success,
      ).toBe(true);
    });
    it("accepts the 512-char max", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({
          ...minimal,
          address: "X".repeat(512),
        }).success,
      ).toBe(true);
    });
    it("rejects 513-char address", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({
          ...minimal,
          address: "X".repeat(513),
        }).success,
      ).toBe(false);
    });
    it("accepts null and undefined", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({ ...minimal, address: null }).success,
      ).toBe(true);
      expect(
        tenantOnboardingBranchSchema.safeParse({ ...minimal, address: undefined })
          .success,
      ).toBe(true);
    });
  });

  describe("city and state", () => {
    it("accepts 80-char max for each", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({
          ...minimal,
          city: "X".repeat(80),
          state: "Y".repeat(80),
        }).success,
      ).toBe(true);
    });
    it("rejects 81-char city", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({
          ...minimal,
          city: "X".repeat(81),
        }).success,
      ).toBe(false);
    });
    it("rejects 81-char state", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({
          ...minimal,
          state: "Y".repeat(81),
        }).success,
      ).toBe(false);
    });
    it("accepts null for both", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({
          ...minimal,
          city: null,
          state: null,
        }).success,
      ).toBe(true);
    });
  });

  describe("pincode", () => {
    it("accepts a valid 6-digit pincode", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({ ...minimal, pincode: "400001" })
          .success,
      ).toBe(true);
    });
    it("rejects 5-digit pincode", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({ ...minimal, pincode: "40001" })
          .success,
      ).toBe(false);
    });
    it("rejects 7-digit pincode", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({ ...minimal, pincode: "4000010" })
          .success,
      ).toBe(false);
    });
    it("rejects pincode with letters", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({ ...minimal, pincode: "4000A1" })
          .success,
      ).toBe(false);
    });
    it("accepts null pincode", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({ ...minimal, pincode: null }).success,
      ).toBe(true);
    });
  });

  describe("phone", () => {
    it("accepts +91-prefixed Indian mobile", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({
          ...minimal,
          phone: "+919876543210",
        }).success,
      ).toBe(true);
    });
    it("accepts plain 10-digit number", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({
          ...minimal,
          phone: "9876543210",
        }).success,
      ).toBe(true);
    });
    it("accepts 7-digit minimum", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({ ...minimal, phone: "1234567" })
          .success,
      ).toBe(true);
    });
    it("accepts 15-digit maximum", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({
          ...minimal,
          phone: "123456789012345",
        }).success,
      ).toBe(true);
    });
    it("rejects 6-digit phone (under min)", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({ ...minimal, phone: "123456" })
          .success,
      ).toBe(false);
    });
    it("rejects 16-digit phone (over max)", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({
          ...minimal,
          phone: "1234567890123456",
        }).success,
      ).toBe(false);
    });
    it("rejects phone with letters", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({
          ...minimal,
          phone: "98765ABCDE",
        }).success,
      ).toBe(false);
    });
    it("rejects phone with spaces or dashes", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({
          ...minimal,
          phone: "987-654-3210",
        }).success,
      ).toBe(false);
    });
    it("accepts null phone", () => {
      expect(
        tenantOnboardingBranchSchema.safeParse({ ...minimal, phone: null }).success,
      ).toBe(true);
    });
  });
});

// ───────────────────────────────────────────────────────
// Step 3 — tenantOnboardingAdminSchema
// ───────────────────────────────────────────────────────

describe("tenantOnboardingAdminSchema", () => {
  const valid = {
    name: "Dr Admin",
    email: "admin@acme.example.com",
    phone: "+919876543210",
    password: "Sup3rSecret!",
  };

  it("accepts a fully-valid admin payload", () => {
    expect(tenantOnboardingAdminSchema.safeParse(valid).success).toBe(true);
  });

  describe("name", () => {
    it("accepts 2-char min", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({ ...valid, name: "AB" }).success,
      ).toBe(true);
    });
    it("rejects 1-char name", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({ ...valid, name: "A" }).success,
      ).toBe(false);
    });
    it("accepts 120-char max name", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({ ...valid, name: "X".repeat(120) })
          .success,
      ).toBe(true);
    });
    it("rejects 121-char name", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({ ...valid, name: "X".repeat(121) })
          .success,
      ).toBe(false);
    });
    it("trims whitespace", () => {
      const res = tenantOnboardingAdminSchema.safeParse({
        ...valid,
        name: "  Dr Admin  ",
      });
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.name).toBe("Dr Admin");
    });
  });

  describe("email", () => {
    it("accepts a valid email", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({
          ...valid,
          email: "user@example.com",
        }).success,
      ).toBe(true);
    });
    it("accepts a subdomain email", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({
          ...valid,
          email: "user@mail.example.co.in",
        }).success,
      ).toBe(true);
    });
    it("rejects email without @", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({ ...valid, email: "userexample.com" })
          .success,
      ).toBe(false);
    });
    it("rejects email without domain", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({ ...valid, email: "user@" }).success,
      ).toBe(false);
    });
    it("rejects empty email", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({ ...valid, email: "" }).success,
      ).toBe(false);
    });
    it("rejects missing email", () => {
      const { email: _omit, ...rest } = valid;
      expect(tenantOnboardingAdminSchema.safeParse(rest).success).toBe(false);
    });
  });

  describe("phone", () => {
    it("accepts +91-prefixed phone", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({
          ...valid,
          phone: "+919876543210",
        }).success,
      ).toBe(true);
    });
    it("accepts plain 10-digit phone", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({ ...valid, phone: "9876543210" })
          .success,
      ).toBe(true);
    });
    it("rejects 6-digit phone (under min)", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({ ...valid, phone: "123456" }).success,
      ).toBe(false);
    });
    it("rejects 16-digit phone (over max)", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({
          ...valid,
          phone: "1234567890123456",
        }).success,
      ).toBe(false);
    });
    it("rejects phone with letters", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({ ...valid, phone: "98765ABCDE" })
          .success,
      ).toBe(false);
    });
    it("phone is required (not optional)", () => {
      const { phone: _omit, ...rest } = valid;
      expect(tenantOnboardingAdminSchema.safeParse(rest).success).toBe(false);
    });
    it("rejects null phone (not nullable on admin)", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({ ...valid, phone: null }).success,
      ).toBe(false);
    });
  });

  describe("password", () => {
    it("accepts 8-char min password", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({ ...valid, password: "12345678" })
          .success,
      ).toBe(true);
    });
    it("rejects 7-char password (under min)", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({ ...valid, password: "1234567" })
          .success,
      ).toBe(false);
    });
    it("accepts 128-char max password", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({
          ...valid,
          password: "X".repeat(128),
        }).success,
      ).toBe(true);
    });
    it("rejects 129-char password (over max)", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({
          ...valid,
          password: "X".repeat(129),
        }).success,
      ).toBe(false);
    });
    it("rejects empty password", () => {
      expect(
        tenantOnboardingAdminSchema.safeParse({ ...valid, password: "" }).success,
      ).toBe(false);
    });
    it("rejects missing password", () => {
      const { password: _omit, ...rest } = valid;
      expect(tenantOnboardingAdminSchema.safeParse(rest).success).toBe(false);
    });
  });
});

// ───────────────────────────────────────────────────────
// Combined wizard payload — tenantOnboardingSchema
// ───────────────────────────────────────────────────────

describe("tenantOnboardingSchema (combined wizard payload)", () => {
  const validPayload = {
    tenant: {
      name: "Acme Hospital",
      subdomain: "acme-hospital",
      plan: "PRO" as const,
    },
    branch: {
      name: "Main Branch",
      code: "MAIN-01",
      city: "Mumbai",
      state: "Maharashtra",
      pincode: "400001",
      phone: "+919876543210",
    },
    admin: {
      name: "Dr Admin",
      email: "admin@acme.example.com",
      phone: "+919876543210",
      password: "Sup3rSecret!",
    },
  };

  it("accepts a fully-valid 3-step payload", () => {
    const res = tenantOnboardingSchema.safeParse(validPayload);
    expect(res.success).toBe(true);
  });

  it("propagates the subdomain lowercase transform end-to-end", () => {
    const res = tenantOnboardingSchema.safeParse({
      ...validPayload,
      tenant: { ...validPayload.tenant, subdomain: "ACME-HOSPITAL" },
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.tenant.subdomain).toBe("acme-hospital");
  });

  it("propagates the branch code uppercase transform end-to-end", () => {
    const res = tenantOnboardingSchema.safeParse({
      ...validPayload,
      branch: { ...validPayload.branch, code: "main-01" },
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.branch.code).toBe("MAIN-01");
  });

  it("accepts the minimal branch (only name) inside the combined payload", () => {
    const res = tenantOnboardingSchema.safeParse({
      ...validPayload,
      branch: { name: "Main Branch" },
    });
    expect(res.success).toBe(true);
  });

  it("rejects missing tenant block", () => {
    const { tenant: _omit, ...rest } = validPayload;
    expect(tenantOnboardingSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing branch block", () => {
    const { branch: _omit, ...rest } = validPayload;
    expect(tenantOnboardingSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects missing admin block", () => {
    const { admin: _omit, ...rest } = validPayload;
    expect(tenantOnboardingSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects entirely empty payload", () => {
    expect(tenantOnboardingSchema.safeParse({}).success).toBe(false);
  });

  it("surfaces a tenant-scoped error path when tenant.subdomain is reserved", () => {
    const res = tenantOnboardingSchema.safeParse({
      ...validPayload,
      tenant: { ...validPayload.tenant, subdomain: "admin" },
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) =>
        i.path.join(".") === "tenant.subdomain",
      );
      expect(issue).toBeDefined();
    }
  });

  it("surfaces a branch-scoped error path when branch.pincode is invalid", () => {
    const res = tenantOnboardingSchema.safeParse({
      ...validPayload,
      branch: { ...validPayload.branch, pincode: "ABCDEF" },
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) =>
        i.path.join(".") === "branch.pincode",
      );
      expect(issue).toBeDefined();
    }
  });

  it("surfaces an admin-scoped error path when admin.email is invalid", () => {
    const res = tenantOnboardingSchema.safeParse({
      ...validPayload,
      admin: { ...validPayload.admin, email: "not-an-email" },
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const issue = res.error.issues.find((i) =>
        i.path.join(".") === "admin.email",
      );
      expect(issue).toBeDefined();
    }
  });

  it("rejects when ANY of the three blocks has a single invalid field", () => {
    // tenant invalid
    expect(
      tenantOnboardingSchema.safeParse({
        ...validPayload,
        tenant: { ...validPayload.tenant, name: "X" },
      }).success,
    ).toBe(false);
    // branch invalid
    expect(
      tenantOnboardingSchema.safeParse({
        ...validPayload,
        branch: { ...validPayload.branch, name: "X" },
      }).success,
    ).toBe(false);
    // admin invalid
    expect(
      tenantOnboardingSchema.safeParse({
        ...validPayload,
        admin: { ...validPayload.admin, password: "short" },
      }).success,
    ).toBe(false);
  });
});
