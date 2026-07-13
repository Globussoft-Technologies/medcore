/**
 * Test-cron tick (2026-05-25) — TPA adapter type-contract + dispatcher tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: locks the public surface that callers depend on for the NHCX TPA
 *   plumbing — both the TYPE contract declared by `./adapter` (the
 *   `ClaimsAdapter` interface, the `AdapterResult<T>` discriminated-union, the
 *   `TpaProvider` / `NormalisedClaimStatus` / `ClaimDocumentType` / `AdapterError.code`
 *   string-literal unions, and the `ClaimSubmissionInput` shape) AND the
 *   runtime DISPATCHER in `./registry` that selects the correct adapter
 *   instance for a given `Insurance.tpaProvider` column value. The dispatcher
 *   is the only runtime surface in the `adapter.ts` / `registry.ts` pair —
 *   `adapter.ts` itself is pure TypeScript declarations (zero executable lines
 *   at runtime, so its coverage % is N/A by construction). We cover the
 *   declarations indirectly via `satisfies` checks and via the registry's
 *   `getAdapter()` return values (every returned adapter MUST conform to the
 *   `ClaimsAdapter` interface — if a stub adapter drops a method, the
 *   dispatcher tests catch it).
 * - MODULES: imports `getAdapter`, `listProviders`, `setAdapterOverride`,
 *   `clearAdapterOverrides` from `./registry`; imports type-only symbols
 *   `ClaimsAdapter`, `TpaProvider`, `NormalisedClaimStatus`, `ClaimDocumentType`,
 *   `AdapterError`, `ClaimSubmissionInput`, `AdapterResult` from `./adapter`.
 *   Zero Prisma / DB / network — adapters are pure in-memory stubs or
 *   credential-gated no-ops, so this suite needs no mocks. Uses
 *   `clearAdapterOverrides()` in `beforeEach` to guarantee per-test isolation
 *   (the registry's `overrides` Map is module-scope — CLAUDE.md gotcha #2 on
 *   module-scope state under `singleFork: true`).
 * - WHY: `getAdapter(insurance.tpaProvider)` is called from every route under
 *   `apps/api/src/routes/insurance-claims.ts` (submit / status-poll / upload /
 *   cancel). The function is the only thing standing between a tenant's
 *   `Insurance.tpaProvider` configuration column and the wire calls that talk
 *   to Medi Assist / Paramount / etc. A regression here — wrong adapter for a
 *   provider, override leak across tenants, unknown provider crashing instead
 *   of falling back to MOCK — would silently mis-route real claims. The
 *   registry has shipped at 0% line coverage since commit `4fa0931c`; this
 *   closes that gap.
 */
import { describe, it, expect, beforeEach } from "vitest";

import type {
  AdapterError,
  AdapterResult,
  ClaimDocumentType,
  ClaimsAdapter,
  ClaimSubmissionInput,
  NormalisedClaimStatus,
  TpaProvider,
} from "./adapter";
import {
  clearAdapterOverrides,
  getAdapter,
  listProviders,
  setAdapterOverride,
} from "./registry";
import { mockAdapter, __mockInternals } from "./adapters/mock";

// ─── Type-contract value pins ────────────────────────────────────────────────
//
// `adapter.ts` is a pure TypeScript declaration file (only `interface` / `type`
// exports — all erased at compile time). It has no runtime code to "cover".
// We instead pin the SHAPE of those declarations via `satisfies`-style value
// checks: if any union member is removed, a `TpaProvider` field assignment
// here breaks compilation BEFORE the test runs, which is the real protection.

describe("adapter.ts — TpaProvider union (compile-time pin)", () => {
  it("accepts every documented TPA provider as a TpaProvider value", () => {
    const all: TpaProvider[] = [
      "MEDI_ASSIST",
      "PARAMOUNT",
      "VIDAL",
      "FHPL",
      "ICICI_LOMBARD",
      "STAR_HEALTH",
      "PMJAY",
      "MOCK",
    ];
    expect(all).toHaveLength(8);
    expect(new Set(all).size).toBe(8);
  });
});

describe("adapter.ts — NormalisedClaimStatus union (compile-time pin)", () => {
  it("accepts every documented lifecycle status as a NormalisedClaimStatus value", () => {
    const all: NormalisedClaimStatus[] = [
      "SUBMITTED",
      "IN_REVIEW",
      "QUERY_RAISED",
      "APPROVED",
      "PARTIALLY_APPROVED",
      "DENIED",
      "SETTLED",
      "CANCELLED",
    ];
    expect(all).toHaveLength(8);
    expect(new Set(all).size).toBe(8);
  });
});

describe("adapter.ts — ClaimDocumentType union (compile-time pin)", () => {
  it("accepts every documented claim document type", () => {
    const all: ClaimDocumentType[] = [
      "DISCHARGE_SUMMARY",
      "INVESTIGATION_REPORT",
      "PRESCRIPTION",
      "BILL",
      "ID_PROOF",
      "CONSENT_FORM",
      "OTHER",
    ];
    expect(all).toHaveLength(7);
    expect(new Set(all).size).toBe(7);
  });
});

describe("adapter.ts — AdapterError.code union (compile-time pin)", () => {
  it("accepts every documented error code", () => {
    const all: AdapterError["code"][] = [
      "AUTH_FAILED",
      "INVALID_INPUT",
      "NOT_FOUND",
      "TPA_UNAVAILABLE",
      "RATE_LIMITED",
      "BUSINESS_RULE",
      "UNKNOWN",
    ];
    expect(all).toHaveLength(7);
    expect(new Set(all).size).toBe(7);
  });
});

describe("adapter.ts — AdapterResult<T> discriminated union", () => {
  it("narrows correctly on `ok: true`", () => {
    const r: AdapterResult<{ providerRef: string }> = {
      ok: true,
      data: { providerRef: "ref-1" },
    };
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.providerRef).toBe("ref-1");
    }
  });

  it("narrows correctly on `ok: false`", () => {
    const r: AdapterResult<{ providerRef: string }> = {
      ok: false,
      error: { code: "AUTH_FAILED", message: "bad creds" },
    };
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("AUTH_FAILED");
      expect(r.error.message).toBe("bad creds");
    }
  });

  it("permits an optional providerRaw on the error branch", () => {
    const r: AdapterResult<{ x: number }> = {
      ok: false,
      error: {
        code: "UNKNOWN",
        message: "fell off the wire",
        providerRaw: { rawHttpStatus: 502, body: "<html/>" },
      },
    };
    if (!r.ok) {
      expect(r.error.providerRaw).toBeDefined();
    }
  });
});

describe("adapter.ts — ClaimSubmissionInput required-vs-optional shape", () => {
  it("accepts the minimum legal payload", () => {
    const input: ClaimSubmissionInput = {
      internalClaimId: "ic-1",
      invoiceId: "inv-1",
      patient: { name: "Asha Patel", gender: "FEMALE" },
      policy: {
        policyNumber: "POL-001",
        insurerName: "Star Health",
        tpaProvider: "MOCK",
      },
      diagnosis: "Pneumonia",
      amountClaimed: 5000,
    };
    expect(input.icd10Codes).toBeUndefined();
    expect(input.preAuthorization).toBeUndefined();
    expect(input.admissionDate).toBeUndefined();
    expect(input.dischargeDate).toBeUndefined();
    expect(input.notes).toBeUndefined();
    expect(input.procedureName).toBeUndefined();
    expect(input.patient.dob).toBeUndefined();
    expect(input.patient.phone).toBeUndefined();
    expect(input.patient.address).toBeUndefined();
    expect(input.policy.memberId).toBeUndefined();
  });

  it("accepts the fully-populated payload with every optional field", () => {
    const input: ClaimSubmissionInput = {
      internalClaimId: "ic-2",
      invoiceId: "inv-2",
      patient: {
        name: "Rahul Sharma",
        dob: "1990-01-15",
        gender: "MALE",
        phone: "+919876543210",
        address: "12 MG Road, Bangalore",
      },
      policy: {
        policyNumber: "POL-002",
        insurerName: "ICICI Lombard",
        tpaProvider: "ICICI_LOMBARD",
        memberId: "MEM-99",
      },
      preAuthorization: {
        requestNumber: "PA-1",
        claimReferenceNumber: "CR-1",
        approvedAmount: 40000,
      },
      diagnosis: "Acute appendicitis",
      icd10Codes: ["K35.80", "K35.30"],
      procedureName: "Laparoscopic appendectomy",
      admissionDate: "2026-05-01T08:00:00.000Z",
      dischargeDate: "2026-05-03T11:00:00.000Z",
      amountClaimed: 50000,
      notes: "Standard 3-day IPD stay",
    };
    expect(input.icd10Codes).toEqual(["K35.80", "K35.30"]);
    expect(input.preAuthorization?.approvedAmount).toBe(40000);
  });
});

// ─── Registry dispatcher (the only runtime surface in the adapter pair) ──────

describe("registry.getAdapter — happy-path lookups", () => {
  beforeEach(() => {
    clearAdapterOverrides();
  });

  it("returns the MOCK adapter for 'MOCK'", () => {
    const a = getAdapter("MOCK");
    expect(a.provider).toBe("MOCK");
  });

  it("returns the Medi Assist adapter for 'MEDI_ASSIST'", () => {
    const a = getAdapter("MEDI_ASSIST");
    expect(a.provider).toBe("MEDI_ASSIST");
  });

  it("returns the Paramount adapter for 'PARAMOUNT'", () => {
    const a = getAdapter("PARAMOUNT");
    expect(a.provider).toBe("PARAMOUNT");
  });

  // VIDAL / FHPL / ICICI_LOMBARD / STAR_HEALTH currently alias to the Medi
  // Assist adapter as documented placeholders. The test pins the CURRENT
  // mapping so a future swap (e.g. wiring a real Vidal adapter) is a
  // deliberate green-to-red flip, not a silent change.
  it.each([
    ["VIDAL", "MEDI_ASSIST"],
    ["FHPL", "MEDI_ASSIST"],
    ["ICICI_LOMBARD", "MEDI_ASSIST"],
    ["STAR_HEALTH", "MEDI_ASSIST"],
  ] as const)("aliases %s to the %s adapter (placeholder)", (key, expected) => {
    const a = getAdapter(key);
    expect(a.provider).toBe(expected);
  });
});

describe("registry.getAdapter — fallback + normalisation behaviour", () => {
  beforeEach(() => {
    clearAdapterOverrides();
  });

  it("falls back to MOCK for an unknown TPA provider string", () => {
    const a = getAdapter("ACME_INSURANCE_INC");
    expect(a.provider).toBe("MOCK");
  });

  it("falls back to MOCK for an empty string", () => {
    const a = getAdapter("");
    expect(a.provider).toBe("MOCK");
  });

  it("falls back to MOCK for null", () => {
    const a = getAdapter(null);
    expect(a.provider).toBe("MOCK");
  });

  it("falls back to MOCK for undefined", () => {
    const a = getAdapter(undefined);
    expect(a.provider).toBe("MOCK");
  });

  it("upper-cases lower-case provider strings before lookup", () => {
    expect(getAdapter("mock").provider).toBe("MOCK");
    expect(getAdapter("medi_assist").provider).toBe("MEDI_ASSIST");
    expect(getAdapter("paramount").provider).toBe("PARAMOUNT");
  });

  it("upper-cases mixed-case provider strings before lookup", () => {
    expect(getAdapter("Medi_Assist").provider).toBe("MEDI_ASSIST");
    expect(getAdapter("Paramount").provider).toBe("PARAMOUNT");
  });
});

describe("registry.getAdapter — every resolved adapter satisfies the ClaimsAdapter interface", () => {
  beforeEach(() => {
    clearAdapterOverrides();
  });

  it.each(["MOCK", "MEDI_ASSIST", "PARAMOUNT", "VIDAL", "FHPL", "ICICI_LOMBARD", "STAR_HEALTH"])(
    "%s adapter exposes the full ClaimsAdapter method surface",
    (key) => {
      const a: ClaimsAdapter = getAdapter(key);
      expect(typeof a.provider).toBe("string");
      expect(typeof a.submitClaim).toBe("function");
      expect(typeof a.getClaimStatus).toBe("function");
      expect(typeof a.uploadDocument).toBe("function");
      expect(typeof a.cancelClaim).toBe("function");
    },
  );
});

describe("registry.setAdapterOverride / clearAdapterOverrides", () => {
  // After each test we MUST clear overrides — the `overrides` Map in the
  // registry is module-scope and leaks across files under singleFork:true
  // (CLAUDE.md gotcha #2).
  beforeEach(() => {
    clearAdapterOverrides();
    __mockInternals.reset();
  });

  it("returns the override adapter instead of the built-in one for the same provider key", () => {
    const sentinel: ClaimsAdapter = {
      provider: "MEDI_ASSIST",
      submitClaim: async () => ({
        ok: false,
        error: { code: "UNKNOWN", message: "from sentinel" },
      }),
      getClaimStatus: async () => ({
        ok: false,
        error: { code: "UNKNOWN", message: "from sentinel" },
      }),
      uploadDocument: async () => ({
        ok: false,
        error: { code: "UNKNOWN", message: "from sentinel" },
      }),
      cancelClaim: async () => ({
        ok: false,
        error: { code: "UNKNOWN", message: "from sentinel" },
      }),
    };

    setAdapterOverride("MEDI_ASSIST", sentinel);
    const resolved = getAdapter("MEDI_ASSIST");
    expect(resolved).toBe(sentinel);
  });

  it("does not affect non-overridden providers", () => {
    const sentinel: ClaimsAdapter = { ...mockAdapter, provider: "MEDI_ASSIST" };
    setAdapterOverride("MEDI_ASSIST", sentinel);

    expect(getAdapter("MEDI_ASSIST")).toBe(sentinel);
    expect(getAdapter("PARAMOUNT").provider).toBe("PARAMOUNT");
    expect(getAdapter("MOCK").provider).toBe("MOCK");
  });

  it("supports overriding MOCK itself (so tests can swap in a deterministic stub)", () => {
    const replacement: ClaimsAdapter = {
      ...mockAdapter,
      provider: "MOCK",
      submitClaim: async () => ({
        ok: true,
        data: {
          claimId: "stub-claim",
          providerRef: "STUB-REF",
          status: "APPROVED",
          submittedAt: new Date().toISOString(),
        },
      }),
    };
    setAdapterOverride("MOCK", replacement);

    const a = getAdapter("MOCK");
    expect(a).toBe(replacement);
  });

  it("respects override even when the provider key is supplied in lower-case (registry up-cases first)", () => {
    const sentinel: ClaimsAdapter = { ...mockAdapter, provider: "MOCK" };
    setAdapterOverride("MOCK", sentinel);
    expect(getAdapter("mock")).toBe(sentinel);
  });

  it("clearAdapterOverrides() removes every previously-set override", () => {
    const sentinelA: ClaimsAdapter = { ...mockAdapter, provider: "MEDI_ASSIST" };
    const sentinelB: ClaimsAdapter = { ...mockAdapter, provider: "PARAMOUNT" };
    setAdapterOverride("MEDI_ASSIST", sentinelA);
    setAdapterOverride("PARAMOUNT", sentinelB);
    expect(getAdapter("MEDI_ASSIST")).toBe(sentinelA);
    expect(getAdapter("PARAMOUNT")).toBe(sentinelB);

    clearAdapterOverrides();

    expect(getAdapter("MEDI_ASSIST").provider).toBe("MEDI_ASSIST");
    expect(getAdapter("MEDI_ASSIST")).not.toBe(sentinelA);
    expect(getAdapter("PARAMOUNT").provider).toBe("PARAMOUNT");
    expect(getAdapter("PARAMOUNT")).not.toBe(sentinelB);
  });

  it("overwrites an existing override when set twice for the same provider", () => {
    const first: ClaimsAdapter = { ...mockAdapter, provider: "MEDI_ASSIST" };
    const second: ClaimsAdapter = { ...mockAdapter, provider: "MEDI_ASSIST" };
    setAdapterOverride("MEDI_ASSIST", first);
    setAdapterOverride("MEDI_ASSIST", second);
    expect(getAdapter("MEDI_ASSIST")).toBe(second);
    expect(getAdapter("MEDI_ASSIST")).not.toBe(first);
  });
});

describe("registry.listProviders", () => {
  it("returns every built-in provider key", () => {
    const providers = listProviders();
    expect(providers).toEqual(
      expect.arrayContaining([
        "MOCK",
        "MEDI_ASSIST",
        "PARAMOUNT",
        "VIDAL",
        "FHPL",
        "ICICI_LOMBARD",
        "STAR_HEALTH",
        "PMJAY",
      ]),
    );
    expect(providers).toHaveLength(8);
  });

  it("does not include overridden-only entries — only built-ins", () => {
    // Sanity: setting an override does not mutate the source-of-truth list.
    setAdapterOverride("MEDI_ASSIST", mockAdapter);
    const providers = listProviders();
    expect(providers).toHaveLength(8);
    clearAdapterOverrides();
  });

  it("returns a snapshot that callers can iterate without affecting the registry", () => {
    const providers = listProviders();
    providers.push("ACME_INSURANCE_INC" as TpaProvider);
    // Re-fetching gives the original length back (caller mutation does not
    // poison subsequent lookups — registry returns Object.keys() which is a
    // fresh array each call).
    expect(listProviders()).toHaveLength(8);
  });
});
