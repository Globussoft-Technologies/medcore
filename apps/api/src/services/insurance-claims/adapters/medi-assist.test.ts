/**
 * Test-cron tick (2026-05-25) — Medi Assist TPA adapter unit tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: full branch coverage of `adapters/medi-assist.ts` — the (currently
 *   stubbed) Medi Assist TPA partner adapter. Pins:
 *     * `provider === "MEDI_ASSIST"` and the four-method ClaimsAdapter surface.
 *     * `readConfig` via env-driven behaviour: missing `TPA_MEDIASSIST_API_KEY`
 *       OR missing `TPA_MEDIASSIST_HOSPITAL_ID` => `AUTH_FAILED` from every
 *       method; both present => methods proceed to the live-stub branch and
 *       return `TPA_UNAVAILABLE` (since live HTTP is not wired yet). The
 *       baseUrl env override is independent of the AUTH_FAILED check and is
 *       not exercised on the wire today, but the default vs override branch
 *       is covered indirectly by all happy-config paths.
 *     * Per-method `TPA_UNAVAILABLE` stub messages — pins the exact strings so
 *       a future contributor wiring a real call can spot the message change.
 *     * `__internal.mapMediAssistStatus` — every documented Medi-Assist raw
 *       string (RECEIVED, NEW, UNDER_REVIEW, PROCESSING, QUERY,
 *       ADDITIONAL_DOCS_REQUIRED, APPROVED, PART_APPROVED, REJECTED, DENIED,
 *       SETTLED, PAID, CANCELLED, WITHDRAWN) plus the unknown-string
 *       fallback to "IN_REVIEW", plus case-insensitivity (toUpperCase
 *       normalisation).
 * - MODULES: imports `mediAssistAdapter` + `__internal` directly. No HTTP is
 *   exercised today because the live methods are stubbed — once they grow
 *   real `fetch()` calls, the AUTH_FAILED tests will still pass and the
 *   TPA_UNAVAILABLE tests will need to be replaced with mocked-fetch happy
 *   paths. Env vars are mutated per-test with explicit save/restore in
 *   beforeEach/afterEach so concurrent test files don't see leaks.
 * - WHY: the adapter has shipped at 0% line coverage since commit `4fa0931c`.
 *   Even as a stub, the credential gate is real (a future regression that
 *   forgot the env check would silently call the partner API with `undefined`
 *   headers) and the status mapper is real production logic that ships now —
 *   `mapMediAssistStatus` will be exercised the moment the HTTP TODOs are
 *   filled in. Pinning the mapper today saves a class of bugs at integration
 *   time.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mediAssistAdapter, __internal } from "./medi-assist";
import type {
  ClaimSubmissionInput,
  ClaimDocumentType,
  NormalisedClaimStatus,
} from "../adapter";

// ─── env save/restore ─────────────────────────────────────────────────────

const ENV_KEYS = [
  "TPA_MEDIASSIST_API_KEY",
  "TPA_MEDIASSIST_HOSPITAL_ID",
  "TPA_MEDIASSIST_API_URL",
] as const;

const savedEnv: Record<string, string | undefined> = {};

function withFullConfig(): void {
  process.env.TPA_MEDIASSIST_API_KEY = "test-api-key-abc123";
  process.env.TPA_MEDIASSIST_HOSPITAL_ID = "HSP-001";
  // Leave TPA_MEDIASSIST_API_URL unset so the default branch runs.
  delete process.env.TPA_MEDIASSIST_API_URL;
}

function clearAllConfig(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  clearAllConfig();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ─── Fixtures ─────────────────────────────────────────────────────────────

function makeInput(over: Partial<ClaimSubmissionInput> = {}): ClaimSubmissionInput {
  return {
    internalClaimId: over.internalClaimId ?? "ic-1",
    invoiceId: over.invoiceId ?? "inv-1",
    patient: over.patient ?? { name: "Asha Patel", gender: "FEMALE" },
    policy: over.policy ?? {
      policyNumber: "POL-001",
      insurerName: "Star Health",
      tpaProvider: "MEDI_ASSIST",
    },
    diagnosis: over.diagnosis ?? "Pneumonia",
    amountClaimed: over.amountClaimed ?? 5000,
    ...over,
  } as ClaimSubmissionInput;
}

// ─── Provider tag + adapter shape ────────────────────────────────────────

describe("mediAssistAdapter — adapter contract shape", () => {
  it("exposes the MEDI_ASSIST provider tag and the full ClaimsAdapter method surface", () => {
    expect(mediAssistAdapter.provider).toBe("MEDI_ASSIST");
    expect(typeof mediAssistAdapter.submitClaim).toBe("function");
    expect(typeof mediAssistAdapter.getClaimStatus).toBe("function");
    expect(typeof mediAssistAdapter.uploadDocument).toBe("function");
    expect(typeof mediAssistAdapter.cancelClaim).toBe("function");
  });
});

// ─── readConfig — AUTH_FAILED gate (per method) ──────────────────────────

describe("mediAssistAdapter — credential gate (AUTH_FAILED when env missing)", () => {
  describe("when neither TPA_MEDIASSIST_API_KEY nor TPA_MEDIASSIST_HOSPITAL_ID are set", () => {
    it("submitClaim returns AUTH_FAILED with the credentials-missing message", async () => {
      const r = await mediAssistAdapter.submitClaim(makeInput());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("AUTH_FAILED");
        expect(r.error.message).toMatch(/TPA_MEDIASSIST_API_KEY/);
        expect(r.error.message).toMatch(/TPA_MEDIASSIST_HOSPITAL_ID/);
      }
    });

    it("getClaimStatus returns AUTH_FAILED", async () => {
      const r = await mediAssistAdapter.getClaimStatus("MA-REF-1");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("AUTH_FAILED");
    });

    it("uploadDocument returns AUTH_FAILED", async () => {
      const r = await mediAssistAdapter.uploadDocument(
        "MA-REF-1",
        "BILL",
        Buffer.from("data"),
        "bill.pdf",
        "application/pdf",
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("AUTH_FAILED");
    });

    it("cancelClaim returns AUTH_FAILED", async () => {
      const r = await mediAssistAdapter.cancelClaim("MA-REF-1", "patient request");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("AUTH_FAILED");
    });
  });

  describe("when only TPA_MEDIASSIST_API_KEY is set (hospitalId missing)", () => {
    beforeEach(() => {
      process.env.TPA_MEDIASSIST_API_KEY = "key-only";
    });

    it("submitClaim still returns AUTH_FAILED", async () => {
      const r = await mediAssistAdapter.submitClaim(makeInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("AUTH_FAILED");
    });
  });

  describe("when only TPA_MEDIASSIST_HOSPITAL_ID is set (apiKey missing)", () => {
    beforeEach(() => {
      process.env.TPA_MEDIASSIST_HOSPITAL_ID = "HSP-only";
    });

    it("submitClaim still returns AUTH_FAILED", async () => {
      const r = await mediAssistAdapter.submitClaim(makeInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("AUTH_FAILED");
    });

    it("getClaimStatus still returns AUTH_FAILED", async () => {
      const r = await mediAssistAdapter.getClaimStatus("MA-REF-2");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("AUTH_FAILED");
    });
  });

  describe("when API_KEY is the empty string (falsy)", () => {
    beforeEach(() => {
      process.env.TPA_MEDIASSIST_API_KEY = "";
      process.env.TPA_MEDIASSIST_HOSPITAL_ID = "HSP-001";
    });

    it("submitClaim returns AUTH_FAILED (empty string is falsy)", async () => {
      const r = await mediAssistAdapter.submitClaim(makeInput());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("AUTH_FAILED");
    });
  });
});

// ─── TPA_UNAVAILABLE — stub branch (creds OK, live HTTP not wired) ───────

describe("mediAssistAdapter — TPA_UNAVAILABLE stub branch (live HTTP not wired yet)", () => {
  beforeEach(() => {
    withFullConfig();
  });

  it("submitClaim returns TPA_UNAVAILABLE with the 'not wired yet' hint", async () => {
    const r = await mediAssistAdapter.submitClaim(makeInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("TPA_UNAVAILABLE");
      expect(r.error.message).toMatch(/not wired yet/i);
      expect(r.error.message).toMatch(/MOCK adapter/);
    }
  });

  it("getClaimStatus returns TPA_UNAVAILABLE with the 'status polling not implemented' hint", async () => {
    const r = await mediAssistAdapter.getClaimStatus("MA-REF-42");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("TPA_UNAVAILABLE");
      expect(r.error.message).toMatch(/status polling not implemented/i);
    }
  });

  it("uploadDocument returns TPA_UNAVAILABLE with the 'document upload not implemented' hint", async () => {
    const r = await mediAssistAdapter.uploadDocument(
      "MA-REF-42",
      "DISCHARGE_SUMMARY" as ClaimDocumentType,
      Buffer.from("PDF-bytes"),
      "ds.pdf",
      "application/pdf",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("TPA_UNAVAILABLE");
      expect(r.error.message).toMatch(/document upload not implemented/i);
    }
  });

  it("cancelClaim returns TPA_UNAVAILABLE with the 'cancel not implemented' hint", async () => {
    const r = await mediAssistAdapter.cancelClaim("MA-REF-42", "patient request");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("TPA_UNAVAILABLE");
      expect(r.error.message).toMatch(/cancel not implemented/i);
    }
  });

  it("respects an explicit TPA_MEDIASSIST_API_URL override (no AUTH_FAILED leak from the override branch)", async () => {
    process.env.TPA_MEDIASSIST_API_URL = "https://sandbox.mediassist.example/v2";
    const r = await mediAssistAdapter.submitClaim(makeInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TPA_UNAVAILABLE");
  });
});

// ─── __internal.mapMediAssistStatus — full mapping coverage ──────────────

describe("__internal.mapMediAssistStatus", () => {
  const { mapMediAssistStatus } = __internal;

  it.each<[string, NormalisedClaimStatus]>([
    ["RECEIVED", "SUBMITTED"],
    ["NEW", "SUBMITTED"],
    ["UNDER_REVIEW", "IN_REVIEW"],
    ["PROCESSING", "IN_REVIEW"],
    ["QUERY", "QUERY_RAISED"],
    ["ADDITIONAL_DOCS_REQUIRED", "QUERY_RAISED"],
    ["APPROVED", "APPROVED"],
    ["PART_APPROVED", "PARTIALLY_APPROVED"],
    ["REJECTED", "DENIED"],
    ["DENIED", "DENIED"],
    ["SETTLED", "SETTLED"],
    ["PAID", "SETTLED"],
    ["CANCELLED", "CANCELLED"],
    ["WITHDRAWN", "CANCELLED"],
  ])("maps Medi Assist raw status %s → %s", (raw, expected) => {
    expect(mapMediAssistStatus(raw)).toBe(expected);
  });

  it("falls back to IN_REVIEW for an unrecognised raw status string", () => {
    expect(mapMediAssistStatus("SOME_VENDOR_SPECIFIC_TAG")).toBe("IN_REVIEW");
  });

  it("falls back to IN_REVIEW for the empty string", () => {
    expect(mapMediAssistStatus("")).toBe("IN_REVIEW");
  });

  it("is case-insensitive (lowercase raw still maps correctly)", () => {
    expect(mapMediAssistStatus("approved")).toBe("APPROVED");
    expect(mapMediAssistStatus("part_approved")).toBe("PARTIALLY_APPROVED");
    expect(mapMediAssistStatus("withdrawn")).toBe("CANCELLED");
  });

  it("is case-insensitive (mixed-case raw still maps correctly)", () => {
    expect(mapMediAssistStatus("Settled")).toBe("SETTLED");
    expect(mapMediAssistStatus("Under_Review")).toBe("IN_REVIEW");
  });
});
