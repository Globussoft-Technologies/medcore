// Coverage tests for the WhatsApp per-tenant provider config validation schemas.
// What: exhaustive happy / invalid / edge cases for every exported Zod schema
//   in packages/shared/src/validation/whatsapp-config.ts — the provider enum,
//   the per-provider credential discriminated union (Gupshup, WATI, AiSensei,
//   Interakt, Meta Cloud API), and the PUT /api/v1/wa/config payload wrapper.
// Which modules: imports only schemas / types from ../whatsapp-config.
// Why: file shipped with 0% colocated coverage (Pearl §6.1 gap row 167, piece
//   3j-i — commit e9948e1). The discriminated-union shape is the load-bearing
//   guarantee: a payload claiming provider=GUPSHUP but carrying META fields
//   must fail server-side before we'd hand it to the AES-256-GCM crypto layer
//   in apps/api/src/services/whatsapp-crypto.ts. Whitespace-only credential
//   strings (trimmed.min(1)) are also explicitly locked — those would
//   otherwise round-trip into encrypted-at-rest storage as empty secrets.
import { describe, it, expect } from "vitest";
import {
  whatsappProviderSchema,
  whatsappCredentialsSchema,
  whatsappConfigPutSchema,
} from "../whatsapp-config";

// ───────────────────────────────────────────────────────
// Provider enum
// ───────────────────────────────────────────────────────

describe("whatsappProviderSchema", () => {
  it("accepts each canonical provider", () => {
    for (const p of ["GUPSHUP", "WATI", "AISENSEI", "INTERAKT", "META"]) {
      expect(whatsappProviderSchema.safeParse(p).success).toBe(true);
    }
  });
  it("rejects unknown provider value", () => {
    expect(whatsappProviderSchema.safeParse("TWILIO").success).toBe(false);
  });
  it("rejects lowercase variant (case-sensitive)", () => {
    expect(whatsappProviderSchema.safeParse("gupshup").success).toBe(false);
  });
  it("rejects empty string", () => {
    expect(whatsappProviderSchema.safeParse("").success).toBe(false);
  });
  it("rejects null", () => {
    expect(whatsappProviderSchema.safeParse(null).success).toBe(false);
  });
  it("rejects undefined", () => {
    expect(whatsappProviderSchema.safeParse(undefined).success).toBe(false);
  });
  it("rejects non-string types", () => {
    expect(whatsappProviderSchema.safeParse(123).success).toBe(false);
    expect(whatsappProviderSchema.safeParse({}).success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Credentials discriminated union — GUPSHUP
// ───────────────────────────────────────────────────────

describe("whatsappCredentialsSchema — GUPSHUP variant", () => {
  const valid = {
    provider: "GUPSHUP" as const,
    apiKey: "gs_live_abc123",
    appName: "MedCoreInbox",
    sourcePhone: "+919876543210",
  };
  it("accepts a fully-populated GUPSHUP credential", () => {
    expect(whatsappCredentialsSchema.safeParse(valid).success).toBe(true);
  });
  it("trims surrounding whitespace on string fields", () => {
    const r = whatsappCredentialsSchema.safeParse({
      ...valid,
      apiKey: "  gs_live_abc123  ",
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.provider === "GUPSHUP") {
      expect(r.data.apiKey).toBe("gs_live_abc123");
    }
  });
  it("rejects empty apiKey", () => {
    const r = whatsappCredentialsSchema.safeParse({ ...valid, apiKey: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Gupshup API key is required/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects whitespace-only apiKey (trim+min(1))", () => {
    expect(
      whatsappCredentialsSchema.safeParse({ ...valid, apiKey: "   " }).success
    ).toBe(false);
  });
  it("rejects empty appName", () => {
    const r = whatsappCredentialsSchema.safeParse({ ...valid, appName: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Gupshup app name is required/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects whitespace-only appName", () => {
    expect(
      whatsappCredentialsSchema.safeParse({ ...valid, appName: "\t\n" }).success
    ).toBe(false);
  });
  it("rejects empty sourcePhone", () => {
    const r = whatsappCredentialsSchema.safeParse({ ...valid, sourcePhone: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) =>
          /Gupshup source phone \(E\.164\) is required/.test(i.message)
        )
      ).toBe(true);
    }
  });
  it("rejects missing apiKey field", () => {
    const { apiKey: _a, ...rest } = valid;
    expect(whatsappCredentialsSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects missing appName field", () => {
    const { appName: _a, ...rest } = valid;
    expect(whatsappCredentialsSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects missing sourcePhone field", () => {
    const { sourcePhone: _s, ...rest } = valid;
    expect(whatsappCredentialsSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects non-string apiKey", () => {
    expect(
      whatsappCredentialsSchema.safeParse({ ...valid, apiKey: 12345 as any }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Credentials discriminated union — WATI
// ───────────────────────────────────────────────────────

describe("whatsappCredentialsSchema — WATI variant", () => {
  const valid = {
    provider: "WATI" as const,
    bearerToken: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    tenantUrl: "https://live-server-12345.wati.io",
  };
  it("accepts a fully-populated WATI credential", () => {
    expect(whatsappCredentialsSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects empty bearerToken", () => {
    const r = whatsappCredentialsSchema.safeParse({ ...valid, bearerToken: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /WATI bearer token is required/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects whitespace-only bearerToken", () => {
    expect(
      whatsappCredentialsSchema.safeParse({ ...valid, bearerToken: "    " }).success
    ).toBe(false);
  });
  it("rejects empty tenantUrl", () => {
    const r = whatsappCredentialsSchema.safeParse({ ...valid, tenantUrl: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /WATI tenant URL is required/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects missing bearerToken", () => {
    const { bearerToken: _b, ...rest } = valid;
    expect(whatsappCredentialsSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects missing tenantUrl", () => {
    const { tenantUrl: _t, ...rest } = valid;
    expect(whatsappCredentialsSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects payload mixing WATI provider with GUPSHUP-only fields", () => {
    // Provider says WATI, but the bearerToken/tenantUrl are missing — the
    // discriminator picks the WATI branch and reports the missing-field
    // errors. apiKey/appName are stripped silently.
    const r = whatsappCredentialsSchema.safeParse({
      provider: "WATI",
      apiKey: "gs_live_abc123",
      appName: "MedCoreInbox",
      sourcePhone: "+919876543210",
    });
    expect(r.success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Credentials discriminated union — AISENSEI
// ───────────────────────────────────────────────────────

describe("whatsappCredentialsSchema — AISENSEI variant", () => {
  const valid = {
    provider: "AISENSEI" as const,
    apiKey: "ai_live_xyz789",
    baseUrl: "https://api.aisensy.com/v2",
  };
  it("accepts a fully-populated AISENSEI credential", () => {
    expect(whatsappCredentialsSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects empty apiKey", () => {
    const r = whatsappCredentialsSchema.safeParse({ ...valid, apiKey: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /AiSensei API key is required/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects whitespace-only apiKey", () => {
    expect(
      whatsappCredentialsSchema.safeParse({ ...valid, apiKey: " " }).success
    ).toBe(false);
  });
  it("rejects empty baseUrl", () => {
    const r = whatsappCredentialsSchema.safeParse({ ...valid, baseUrl: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /AiSensei base URL is required/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects missing apiKey", () => {
    const { apiKey: _a, ...rest } = valid;
    expect(whatsappCredentialsSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects missing baseUrl", () => {
    const { baseUrl: _b, ...rest } = valid;
    expect(whatsappCredentialsSchema.safeParse(rest).success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Credentials discriminated union — INTERAKT
// ───────────────────────────────────────────────────────

describe("whatsappCredentialsSchema — INTERAKT variant", () => {
  const valid = {
    provider: "INTERAKT" as const,
    apiKey: "ik_live_PQR456",
  };
  it("accepts a minimal INTERAKT credential (only apiKey required)", () => {
    expect(whatsappCredentialsSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects empty apiKey", () => {
    const r = whatsappCredentialsSchema.safeParse({ ...valid, apiKey: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Interakt API key is required/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects whitespace-only apiKey", () => {
    expect(
      whatsappCredentialsSchema.safeParse({ ...valid, apiKey: "\t" }).success
    ).toBe(false);
  });
  it("rejects missing apiKey", () => {
    expect(
      whatsappCredentialsSchema.safeParse({ provider: "INTERAKT" } as any).success
    ).toBe(false);
  });
  it("strips unknown fields (apiKey is the only declared field)", () => {
    // Zod default behavior strips unknown keys; an extra `extra` field will
    // not cause the parse to fail.
    const r = whatsappCredentialsSchema.safeParse({ ...valid, extra: "ignored" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as any).extra).toBeUndefined();
    }
  });
});

// ───────────────────────────────────────────────────────
// Credentials discriminated union — META (Cloud API)
// ───────────────────────────────────────────────────────

describe("whatsappCredentialsSchema — META variant", () => {
  const valid = {
    provider: "META" as const,
    accessToken: "EAAGm0ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
    phoneNumberId: "112233445566778",
    appSecret: "9a8b7c6d5e4f3g2h1i0j",
    verifyToken: "medcore-webhook-verify-secret-2026",
  };
  it("accepts a fully-populated META credential", () => {
    expect(whatsappCredentialsSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects empty accessToken", () => {
    const r = whatsappCredentialsSchema.safeParse({ ...valid, accessToken: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) =>
          /Meta Cloud API access token is required/.test(i.message)
        )
      ).toBe(true);
    }
  });
  it("rejects whitespace-only accessToken", () => {
    expect(
      whatsappCredentialsSchema.safeParse({ ...valid, accessToken: "   " }).success
    ).toBe(false);
  });
  it("rejects empty phoneNumberId", () => {
    const r = whatsappCredentialsSchema.safeParse({ ...valid, phoneNumberId: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) =>
          /Meta Cloud API phone-number id is required/.test(i.message)
        )
      ).toBe(true);
    }
  });
  // appSecret + verifyToken are INBOUND (webhook) creds — only needed to
  // RECEIVE messages / auto-reply. On the credentials union alone they are
  // OPTIONAL (send-only configs skip them); they're conditionally required by
  // whatsappConfigPutSchema when autoReply is true (see the put-schema block
  // below). So the credentials schema accepts them empty / absent.
  it("accepts empty appSecret (webhook cred — required only with auto-reply)", () => {
    expect(
      whatsappCredentialsSchema.safeParse({ ...valid, appSecret: "" }).success
    ).toBe(true);
  });
  it("accepts empty verifyToken (webhook cred — required only with auto-reply)", () => {
    expect(
      whatsappCredentialsSchema.safeParse({ ...valid, verifyToken: "" }).success
    ).toBe(true);
  });
  it("rejects missing accessToken field", () => {
    const { accessToken: _a, ...rest } = valid;
    expect(whatsappCredentialsSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects missing phoneNumberId field", () => {
    const { phoneNumberId: _p, ...rest } = valid;
    expect(whatsappCredentialsSchema.safeParse(rest).success).toBe(false);
  });
  it("accepts missing appSecret field (webhook cred — required only with auto-reply)", () => {
    const { appSecret: _s, ...rest } = valid;
    expect(whatsappCredentialsSchema.safeParse(rest).success).toBe(true);
  });
  it("accepts missing verifyToken field (webhook cred — required only with auto-reply)", () => {
    const { verifyToken: _v, ...rest } = valid;
    expect(whatsappCredentialsSchema.safeParse(rest).success).toBe(true);
  });
  it("rejects payload mixing META provider with GUPSHUP-only fields", () => {
    // Discriminator says META → expects accessToken/phoneNumberId/appSecret/
    // verifyToken; the GUPSHUP-only fields are stripped, leaving META's
    // required fields missing.
    const r = whatsappCredentialsSchema.safeParse({
      provider: "META",
      apiKey: "ai_live_xyz",
      appName: "MedCoreInbox",
    });
    expect(r.success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Discriminated union — top-level discrimination behavior
// ───────────────────────────────────────────────────────

describe("whatsappCredentialsSchema — discriminator behavior", () => {
  it("rejects payload with no provider field", () => {
    expect(
      whatsappCredentialsSchema.safeParse({ apiKey: "x" } as any).success
    ).toBe(false);
  });
  it("rejects payload with unknown provider value", () => {
    expect(
      whatsappCredentialsSchema.safeParse({
        provider: "TWILIO",
        apiKey: "x",
      } as any).success
    ).toBe(false);
  });
  it("rejects payload with provider=null", () => {
    expect(
      whatsappCredentialsSchema.safeParse({ provider: null, apiKey: "x" } as any).success
    ).toBe(false);
  });
  it("rejects entirely empty payload", () => {
    expect(whatsappCredentialsSchema.safeParse({}).success).toBe(false);
  });
  it("rejects non-object payload", () => {
    expect(whatsappCredentialsSchema.safeParse("GUPSHUP").success).toBe(false);
    expect(whatsappCredentialsSchema.safeParse(null).success).toBe(false);
    expect(whatsappCredentialsSchema.safeParse(undefined).success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// PUT /api/v1/wa/config payload wrapper
// ───────────────────────────────────────────────────────

describe("whatsappConfigPutSchema", () => {
  const validCredentials = {
    provider: "META" as const,
    accessToken: "EAAGm0live_token",
    phoneNumberId: "112233445566778",
    appSecret: "secret",
    verifyToken: "verify-2026",
  };
  const minimal = { credentials: validCredentials };

  it("accepts a minimal payload with only credentials", () => {
    expect(whatsappConfigPutSchema.safeParse(minimal).success).toBe(true);
  });
  it("accepts a fully-populated payload", () => {
    expect(
      whatsappConfigPutSchema.safeParse({
        credentials: validCredentials,
        defaultProductId: "prod_abc",
        autoReply: true,
        active: true,
      }).success
    ).toBe(true);
  });
  it("accepts defaultProductId = null (nullable)", () => {
    expect(
      whatsappConfigPutSchema.safeParse({
        ...minimal,
        defaultProductId: null,
      }).success
    ).toBe(true);
  });
  it("trims defaultProductId", () => {
    const r = whatsappConfigPutSchema.safeParse({
      ...minimal,
      defaultProductId: "  prod_abc  ",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.defaultProductId).toBe("prod_abc");
  });
  it("rejects defaultProductId longer than 120 chars", () => {
    expect(
      whatsappConfigPutSchema.safeParse({
        ...minimal,
        defaultProductId: "x".repeat(121),
      }).success
    ).toBe(false);
  });
  it("accepts defaultProductId at exactly 120 chars", () => {
    expect(
      whatsappConfigPutSchema.safeParse({
        ...minimal,
        defaultProductId: "x".repeat(120),
      }).success
    ).toBe(true);
  });
  it("rejects non-string defaultProductId", () => {
    expect(
      whatsappConfigPutSchema.safeParse({
        ...minimal,
        defaultProductId: 123 as any,
      }).success
    ).toBe(false);
  });
  it("rejects non-boolean autoReply", () => {
    expect(
      whatsappConfigPutSchema.safeParse({
        ...minimal,
        autoReply: "yes" as any,
      }).success
    ).toBe(false);
  });
  it("rejects non-boolean active", () => {
    expect(
      whatsappConfigPutSchema.safeParse({
        ...minimal,
        active: 1 as any,
      }).success
    ).toBe(false);
  });
  it("rejects payload missing credentials", () => {
    expect(
      whatsappConfigPutSchema.safeParse({ autoReply: true } as any).success
    ).toBe(false);
  });
  it("propagates credential-shape errors upward", () => {
    // Invalid (empty) META access token must fail the outer parse as well.
    const r = whatsappConfigPutSchema.safeParse({
      credentials: { ...validCredentials, accessToken: "" },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) =>
          /Meta Cloud API access token is required/.test(i.message)
        )
      ).toBe(true);
    }
  });
  it("accepts each provider variant inside the wrapper", () => {
    const variants = [
      {
        provider: "GUPSHUP" as const,
        apiKey: "gs_live",
        appName: "MedCoreInbox",
        sourcePhone: "+919999999999",
      },
      {
        provider: "WATI" as const,
        bearerToken: "Bearer xxx",
        tenantUrl: "https://wati.io/abc",
      },
      {
        provider: "AISENSEI" as const,
        apiKey: "ai_live",
        baseUrl: "https://aisensy.com/v2",
      },
      { provider: "INTERAKT" as const, apiKey: "ik_live" },
      validCredentials,
    ];
    for (const credentials of variants) {
      expect(whatsappConfigPutSchema.safeParse({ credentials }).success).toBe(true);
    }
  });

  // Meta webhook creds (appSecret / verifyToken) are required ONLY when
  // auto-reply (receiving) is enabled. Send-only configs may omit them.
  const sendOnlyMeta = {
    provider: "META" as const,
    accessToken: "EAAGm0live_token",
    phoneNumberId: "112233445566778",
  };
  it("accepts META send-only (no appSecret/verifyToken) when autoReply is off", () => {
    expect(
      whatsappConfigPutSchema.safeParse({ credentials: sendOnlyMeta }).success
    ).toBe(true);
    expect(
      whatsappConfigPutSchema.safeParse({
        credentials: sendOnlyMeta,
        autoReply: false,
      }).success
    ).toBe(true);
  });
  it("rejects META with autoReply on but missing appSecret", () => {
    const r = whatsappConfigPutSchema.safeParse({
      credentials: { ...sendOnlyMeta, verifyToken: "verify-2026" },
      autoReply: true,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /App secret is required/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects META with autoReply on but missing verifyToken", () => {
    const r = whatsappConfigPutSchema.safeParse({
      credentials: { ...sendOnlyMeta, appSecret: "secret" },
      autoReply: true,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Verify token is required/.test(i.message))
      ).toBe(true);
    }
  });
  it("accepts META with autoReply on when both webhook creds are present", () => {
    expect(
      whatsappConfigPutSchema.safeParse({
        credentials: validCredentials,
        autoReply: true,
      }).success
    ).toBe(true);
  });
});
