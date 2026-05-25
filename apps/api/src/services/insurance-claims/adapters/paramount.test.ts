/**
 * Test-cron tick (2026-05-25) — Paramount TPA stub adapter unit tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: full branch coverage of `adapters/paramount.ts` — the Paramount
 *   Health Services TPA adapter. Currently a stub: each method returns
 *   `TPA_UNAVAILABLE` once credentials are present, OR `AUTH_FAILED` when
 *   `TPA_PARAMOUNT_API_KEY` / `TPA_PARAMOUNT_CLIENT_CODE` env vars are
 *   missing. Pins:
 *     * `paramountAdapter.provider` is `"PARAMOUNT"`.
 *     * For each of `submitClaim`, `getClaimStatus`, `uploadDocument`,
 *       `cancelClaim`:
 *         - both env vars missing → `AUTH_FAILED`
 *         - only `TPA_PARAMOUNT_API_KEY` set → `AUTH_FAILED`
 *         - only `TPA_PARAMOUNT_CLIENT_CODE` set → `AUTH_FAILED`
 *         - both set → `TPA_UNAVAILABLE` (stub not wired yet)
 *         - `TPA_PARAMOUNT_API_URL` override is honored at config-read time
 *           (no observable side effect today, but exercises the default-URL
 *           branch in `readConfig`).
 *     * `__internal.mapParamountStatus` — every documented numeric code
 *       (`"1"`..`"8"`) AND every documented string code maps to the
 *       expected `NormalisedClaimStatus`; unknown / random codes fall
 *       through to `"IN_REVIEW"`. Case-insensitive (`"approved"` ===
 *       `"APPROVED"`). Accepts both `string` and `number` raw inputs.
 *   We deliberately do NOT mock `fetch` — the stub never makes HTTP calls
 *   today. When the live integration lands (see TODO(integration) comments
 *   at lines 95, 113, 133, 150), these tests will be extended with
 *   `vi.spyOn(globalThis, "fetch")` per the canonical mock pattern.
 * - MODULES: imports the public `paramountAdapter` + `__internal` escape
 *   hatch for the status mapper. Manipulates `process.env.TPA_PARAMOUNT_*`
 *   directly with `beforeEach`/`afterEach` save+restore so tests are
 *   hermetic against the surrounding env. No Prisma, no network, no
 *   fixtures needed.
 * - WHY: the stub has shipped at 0% line coverage since commit `4fa0931c`.
 *   Even though the integration is incomplete, the `readConfig` env-var
 *   contract + the `mapParamountStatus` mapping are LIVE wire contracts —
 *   any drift in either (e.g. silently flipping the missing-creds error
 *   from `AUTH_FAILED` to `UNKNOWN`, or changing `"3"` from
 *   `QUERY_RAISED` to `IN_REVIEW`) would corrupt downstream UX without a
 *   loud test failure. Closing this gap now means when integration work
 *   does land, regressions surface immediately rather than in production.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { paramountAdapter, __internal } from "./paramount";
import type { ClaimSubmissionInput, ClaimDocumentType } from "../adapter";

// ─── env helpers ──────────────────────────────────────────────────────────

const ENV_KEYS = [
  "TPA_PARAMOUNT_API_KEY",
  "TPA_PARAMOUNT_CLIENT_CODE",
  "TPA_PARAMOUNT_API_URL",
] as const;

let savedEnv: Record<string, string | undefined> = {};

function snapshotEnv() {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
}

function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

function clearAllParamountEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

function setCreds(opts: { key?: string; clientCode?: string; url?: string } = {}) {
  clearAllParamountEnv();
  if (opts.key) process.env.TPA_PARAMOUNT_API_KEY = opts.key;
  if (opts.clientCode) process.env.TPA_PARAMOUNT_CLIENT_CODE = opts.clientCode;
  if (opts.url) process.env.TPA_PARAMOUNT_API_URL = opts.url;
}

// ─── fixtures ─────────────────────────────────────────────────────────────

function makeInput(
  over: Partial<ClaimSubmissionInput> = {},
): ClaimSubmissionInput {
  return {
    internalClaimId: over.internalClaimId ?? "ic-1",
    invoiceId: over.invoiceId ?? "inv-1",
    patient: over.patient ?? { name: "Asha Patel", gender: "FEMALE" },
    policy: over.policy ?? {
      policyNumber: "POL-001",
      insurerName: "Star Health",
      tpaProvider: "PARAMOUNT",
    },
    diagnosis: over.diagnosis ?? "Pneumonia",
    amountClaimed: over.amountClaimed ?? 5000,
    ...over,
  } as ClaimSubmissionInput;
}

// ─── lifecycle: per-test env snapshot/restore (hermetic) ─────────────────

beforeEach(() => snapshotEnv());
afterEach(() => restoreEnv());

// ─── Provider tag + shape ─────────────────────────────────────────────────

describe("paramountAdapter — adapter contract shape", () => {
  it("exposes the PARAMOUNT provider tag and the full ClaimsAdapter method surface", () => {
    expect(paramountAdapter.provider).toBe("PARAMOUNT");
    expect(typeof paramountAdapter.submitClaim).toBe("function");
    expect(typeof paramountAdapter.getClaimStatus).toBe("function");
    expect(typeof paramountAdapter.uploadDocument).toBe("function");
    expect(typeof paramountAdapter.cancelClaim).toBe("function");
  });
});

// ─── submitClaim ─────────────────────────────────────────────────────────

describe("paramountAdapter.submitClaim", () => {
  it("returns AUTH_FAILED when both TPA_PARAMOUNT_API_KEY and TPA_PARAMOUNT_CLIENT_CODE are missing", async () => {
    clearAllParamountEnv();
    const r = await paramountAdapter.submitClaim(makeInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("AUTH_FAILED");
      expect(r.error.message).toMatch(/TPA_PARAMOUNT_API_KEY/);
      expect(r.error.message).toMatch(/TPA_PARAMOUNT_CLIENT_CODE/);
    }
  });

  it("returns AUTH_FAILED when only TPA_PARAMOUNT_API_KEY is set", async () => {
    setCreds({ key: "k1" });
    const r = await paramountAdapter.submitClaim(makeInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_FAILED");
  });

  it("returns AUTH_FAILED when only TPA_PARAMOUNT_CLIENT_CODE is set", async () => {
    setCreds({ clientCode: "HOSP-007" });
    const r = await paramountAdapter.submitClaim(makeInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_FAILED");
  });

  it("returns TPA_UNAVAILABLE (stub not wired yet) when both env vars are set", async () => {
    setCreds({ key: "k1", clientCode: "HOSP-007" });
    const r = await paramountAdapter.submitClaim(makeInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("TPA_UNAVAILABLE");
      expect(r.error.message).toMatch(/Paramount/i);
      expect(r.error.message).toMatch(/MOCK/);
    }
  });

  it("still returns TPA_UNAVAILABLE when a custom TPA_PARAMOUNT_API_URL is supplied", async () => {
    setCreds({
      key: "k1",
      clientCode: "HOSP-007",
      url: "https://staging.paramounttpa.example",
    });
    const r = await paramountAdapter.submitClaim(makeInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TPA_UNAVAILABLE");
  });
});

// ─── getClaimStatus ──────────────────────────────────────────────────────

describe("paramountAdapter.getClaimStatus", () => {
  it("returns AUTH_FAILED when creds are missing", async () => {
    clearAllParamountEnv();
    const r = await paramountAdapter.getClaimStatus("PARA-REF-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_FAILED");
  });

  it("returns AUTH_FAILED when only TPA_PARAMOUNT_API_KEY is set", async () => {
    setCreds({ key: "k1" });
    const r = await paramountAdapter.getClaimStatus("PARA-REF-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_FAILED");
  });

  it("returns AUTH_FAILED when only TPA_PARAMOUNT_CLIENT_CODE is set", async () => {
    setCreds({ clientCode: "HOSP-007" });
    const r = await paramountAdapter.getClaimStatus("PARA-REF-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_FAILED");
  });

  it("returns TPA_UNAVAILABLE with a status-polling message when creds are present", async () => {
    setCreds({ key: "k1", clientCode: "HOSP-007" });
    const r = await paramountAdapter.getClaimStatus("PARA-REF-1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("TPA_UNAVAILABLE");
      expect(r.error.message).toMatch(/status polling/i);
    }
  });
});

// ─── uploadDocument ──────────────────────────────────────────────────────

describe("paramountAdapter.uploadDocument", () => {
  const buf = Buffer.from("PDF-CONTENT");
  const docType: ClaimDocumentType = "BILL";

  it("returns AUTH_FAILED when creds are missing", async () => {
    clearAllParamountEnv();
    const r = await paramountAdapter.uploadDocument(
      "PARA-REF-1",
      docType,
      buf,
      "bill.pdf",
      "application/pdf",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_FAILED");
  });

  it("returns AUTH_FAILED when only TPA_PARAMOUNT_API_KEY is set", async () => {
    setCreds({ key: "k1" });
    const r = await paramountAdapter.uploadDocument(
      "PARA-REF-1",
      docType,
      buf,
      "bill.pdf",
      "application/pdf",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_FAILED");
  });

  it("returns AUTH_FAILED when only TPA_PARAMOUNT_CLIENT_CODE is set", async () => {
    setCreds({ clientCode: "HOSP-007" });
    const r = await paramountAdapter.uploadDocument(
      "PARA-REF-1",
      docType,
      buf,
      "bill.pdf",
      "application/pdf",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_FAILED");
  });

  it("returns TPA_UNAVAILABLE with a document-upload message when creds are present", async () => {
    setCreds({ key: "k1", clientCode: "HOSP-007" });
    const r = await paramountAdapter.uploadDocument(
      "PARA-REF-1",
      docType,
      buf,
      "bill.pdf",
      "application/pdf",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("TPA_UNAVAILABLE");
      expect(r.error.message).toMatch(/document upload/i);
    }
  });
});

// ─── cancelClaim ─────────────────────────────────────────────────────────

describe("paramountAdapter.cancelClaim", () => {
  it("returns AUTH_FAILED when creds are missing", async () => {
    clearAllParamountEnv();
    const r = await paramountAdapter.cancelClaim("PARA-REF-1", "duplicate");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_FAILED");
  });

  it("returns AUTH_FAILED when only TPA_PARAMOUNT_API_KEY is set", async () => {
    setCreds({ key: "k1" });
    const r = await paramountAdapter.cancelClaim("PARA-REF-1", "duplicate");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_FAILED");
  });

  it("returns AUTH_FAILED when only TPA_PARAMOUNT_CLIENT_CODE is set", async () => {
    setCreds({ clientCode: "HOSP-007" });
    const r = await paramountAdapter.cancelClaim("PARA-REF-1", "duplicate");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_FAILED");
  });

  it("returns TPA_UNAVAILABLE with a cancel message when creds are present", async () => {
    setCreds({ key: "k1", clientCode: "HOSP-007" });
    const r = await paramountAdapter.cancelClaim("PARA-REF-1", "duplicate");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("TPA_UNAVAILABLE");
      expect(r.error.message).toMatch(/cancel/i);
    }
  });
});

// ─── __internal.mapParamountStatus ───────────────────────────────────────

describe("__internal.mapParamountStatus — numeric codes", () => {
  it.each([
    ["1", "SUBMITTED"],
    ["2", "IN_REVIEW"],
    ["3", "QUERY_RAISED"],
    ["4", "APPROVED"],
    ["5", "PARTIALLY_APPROVED"],
    ["6", "DENIED"],
    ["7", "SETTLED"],
    ["8", "CANCELLED"],
  ] as const)("maps numeric code %s to %s", (code, expected) => {
    expect(__internal.mapParamountStatus(code)).toBe(expected);
  });

  it.each([
    [1, "SUBMITTED"],
    [2, "IN_REVIEW"],
    [3, "QUERY_RAISED"],
    [4, "APPROVED"],
    [5, "PARTIALLY_APPROVED"],
    [6, "DENIED"],
    [7, "SETTLED"],
    [8, "CANCELLED"],
  ] as const)("accepts a number (not a string) %d and maps to %s", (code, expected) => {
    expect(__internal.mapParamountStatus(code)).toBe(expected);
  });
});

describe("__internal.mapParamountStatus — string codes", () => {
  it.each([
    ["SUBMITTED", "SUBMITTED"],
    ["IN_PROCESS", "IN_REVIEW"],
    ["QUERY", "QUERY_RAISED"],
    ["APPROVED", "APPROVED"],
    ["PART_APPROVED", "PARTIALLY_APPROVED"],
    ["REJECTED", "DENIED"],
    ["SETTLED", "SETTLED"],
    ["CANCELLED", "CANCELLED"],
  ] as const)("maps string code %s to %s", (code, expected) => {
    expect(__internal.mapParamountStatus(code)).toBe(expected);
  });

  it("is case-insensitive — lowercase 'approved' maps to APPROVED", () => {
    expect(__internal.mapParamountStatus("approved")).toBe("APPROVED");
  });

  it("is case-insensitive — mixed case 'In_Process' maps to IN_REVIEW", () => {
    expect(__internal.mapParamountStatus("In_Process")).toBe("IN_REVIEW");
  });
});

describe("__internal.mapParamountStatus — fallback", () => {
  it.each([
    "0",
    "9",
    "99",
    "UNKNOWN",
    "FOOBAR",
    "",
    "submitted_old",
  ])("falls through to IN_REVIEW for unknown code %j", (code) => {
    expect(__internal.mapParamountStatus(code)).toBe("IN_REVIEW");
  });
});
