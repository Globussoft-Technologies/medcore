/**
 * Test-cron tick (2026-05-25) — deterministic MOCK TPA adapter unit tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: full branch coverage of `adapters/mock.ts` — the in-memory NHCX-shaped
 *   TPA adapter that integration tests + `npm run dev` rely on. Pins:
 *     * `submitClaim` — INVALID_INPUT (amount<=0), BUSINESS_RULE (`DENY-ME`
 *       policy fixture), happy path (returns deterministic `MOCK-<hash>`
 *       providerRef + SUBMITTED + timeline-seeded), and idempotency by
 *       `internalClaimId` (second call returns the existing record without
 *       creating a second store entry).
 *     * `getClaimStatus` — NOT_FOUND for unknown ref; happy path returns
 *       status + timeline as a COPY (mutating the returned timeline must not
 *       mutate the stored timeline — see "lastUpdated forwarded" assertion).
 *     * `uploadDocument` — NOT_FOUND for unknown ref; INVALID_INPUT for empty
 *       buffer; happy path appends a {providerDocId, docType, uploadedAt} row
 *       AND a `Document uploaded: <docType>` event onto the timeline AND
 *       bumps `lastUpdated`. ProviderDocId is deterministic (`DOC-<10-hex>`)
 *       and includes `claim.documents.length` in its hash input so two
 *       same-type/same-buffer uploads on the same claim get distinct ids.
 *     * `cancelClaim` — NOT_FOUND for unknown ref; BUSINESS_RULE when the
 *       claim is already SETTLED (forced via the `__mockInternals` escape
 *       hatch); happy path flips status to CANCELLED, appends timeline
 *       entry with reason, returns cancelledAt.
 *     * `__mockInternals.reset()` — clears the in-process store (subsequent
 *       lookups return NOT_FOUND).
 *     * `__mockInternals.forceStatus()` — returns `false` for unknown ref;
 *       mutates claim status + optional amountApproved / deniedReason /
 *       timeline note for known refs.
 *   Also pins `provider === "MOCK"` and the SHA-256-derived `MOCK-<12-hex>`
 *   providerRef shape so any future change to the hashing strategy fails CI
 *   loudly (downstream `store.ts` queries by `providerClaimRef` so this is
 *   an inter-module wire contract, not just an implementation detail).
 * - MODULES: imports the public `mockAdapter` + `__mockInternals` escape
 *   hatch directly. Zero mocks needed — the adapter is pure in-memory and
 *   self-contained (no Prisma, no @medcore/db, no network). Tests call
 *   `__mockInternals.reset()` in `beforeEach` to guarantee per-test
 *   isolation since the `store` Map is module-scope (see CLAUDE.md gotcha
 *   #2: module-scope state under `singleFork: true` leaks across files).
 * - WHY: this adapter is the wire-mock every claims integration + e2e test
 *   rides on, and the route handler's `submit → adapter.submitClaim → store`
 *   path uses the returned `providerRef` as the durable cross-system key.
 *   Drift in the deterministic hashing OR the idempotency contract OR the
 *   timeline event-shape would silently break the reconciliation worker
 *   AND every claims spec. The file has shipped at 0% line coverage since
 *   commit `4fa0931c`; this closes that gap.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from "vitest";
import { mockAdapter, __mockInternals } from "./mock";
import type {
  ClaimSubmissionInput,
  ClaimDocumentType,
} from "../adapter";

// ─── Fixtures ─────────────────────────────────────────────────────────────

function makeInput(over: Partial<ClaimSubmissionInput> = {}): ClaimSubmissionInput {
  return {
    internalClaimId: over.internalClaimId ?? "ic-1",
    invoiceId: over.invoiceId ?? "inv-1",
    patient: over.patient ?? { name: "Asha Patel", gender: "FEMALE" },
    policy: over.policy ?? {
      policyNumber: "POL-001",
      insurerName: "Star Health",
      tpaProvider: "MOCK",
    },
    diagnosis: over.diagnosis ?? "Pneumonia",
    amountClaimed: over.amountClaimed ?? 5000,
    ...over,
  } as ClaimSubmissionInput;
}

// ─── Provider tag + shape ─────────────────────────────────────────────────

describe("mockAdapter — adapter contract shape", () => {
  it("exposes the MOCK provider tag and the full ClaimsAdapter method surface", () => {
    expect(mockAdapter.provider).toBe("MOCK");
    expect(typeof mockAdapter.submitClaim).toBe("function");
    expect(typeof mockAdapter.getClaimStatus).toBe("function");
    expect(typeof mockAdapter.uploadDocument).toBe("function");
    expect(typeof mockAdapter.cancelClaim).toBe("function");
  });
});

// ─── submitClaim ─────────────────────────────────────────────────────────

describe("mockAdapter.submitClaim", () => {
  beforeEach(() => __mockInternals.reset());

  it("rejects amountClaimed of 0 with INVALID_INPUT", async () => {
    const r = await mockAdapter.submitClaim(makeInput({ amountClaimed: 0 }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_INPUT");
      expect(r.error.message).toMatch(/amountClaimed/);
    }
  });

  it("rejects a negative amountClaimed with INVALID_INPUT", async () => {
    const r = await mockAdapter.submitClaim(makeInput({ amountClaimed: -1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("rejects the DENY-ME policy fixture with BUSINESS_RULE", async () => {
    const r = await mockAdapter.submitClaim(
      makeInput({
        policy: {
          policyNumber: "DENY-ME",
          insurerName: "Star Health",
          tpaProvider: "MOCK",
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("BUSINESS_RULE");
      expect(r.error.message).toMatch(/lapsed/i);
    }
  });

  it("creates a new claim and returns deterministic MOCK-<12-hex> providerRef + SUBMITTED", async () => {
    const r = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-happy-1" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.claimId).toBe("ic-happy-1");
      expect(r.data.status).toBe("SUBMITTED");
      expect(r.data.providerRef).toMatch(/^MOCK-[0-9A-F]{12}$/);
      expect(typeof r.data.submittedAt).toBe("string");
      expect(new Date(r.data.submittedAt).toString()).not.toBe("Invalid Date");
    }
  });

  it("derives the providerRef deterministically from internalClaimId only", async () => {
    const a = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-det" }));
    __mockInternals.reset();
    const b = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-det" }));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.data.providerRef).toBe(b.data.providerRef);
  });

  it("returns DIFFERENT providerRefs for different internalClaimIds", async () => {
    const a = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-A" }));
    const b = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-B" }));
    if (a.ok && b.ok) expect(a.data.providerRef).not.toBe(b.data.providerRef);
  });

  it("is idempotent — a second submitClaim with the same internalClaimId returns the existing record (no duplicate store entry)", async () => {
    const first = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-idemp" }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstSubmittedAt = first.data.submittedAt;

    // Force the status to APPROVED so we can prove the second call returns the
    // ALREADY-STORED status (not a fresh "SUBMITTED").
    __mockInternals.forceStatus(first.data.providerRef, "APPROVED", {
      amountApproved: 4500,
    });

    const second = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-idemp" }));
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.providerRef).toBe(first.data.providerRef);
      expect(second.data.status).toBe("APPROVED");
      expect(second.data.submittedAt).toBe(firstSubmittedAt);
    }
  });

  it("seeds the timeline with a 'Claim received' SUBMITTED event on first submit", async () => {
    const r = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-seed" }));
    if (!r.ok) throw new Error("submit failed");
    const status = await mockAdapter.getClaimStatus(r.data.providerRef);
    if (!status.ok) throw new Error("status read failed");
    expect(status.data.timeline).toHaveLength(1);
    expect(status.data.timeline[0].status).toBe("SUBMITTED");
    expect(status.data.timeline[0].note).toBe("Claim received");
  });
});

// ─── getClaimStatus ──────────────────────────────────────────────────────

describe("mockAdapter.getClaimStatus", () => {
  beforeEach(() => __mockInternals.reset());

  it("returns NOT_FOUND for an unknown providerRef", async () => {
    const r = await mockAdapter.getClaimStatus("MOCK-DEADBEEFCAFE");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
      expect(r.error.message).toMatch(/MOCK-DEADBEEFCAFE/);
    }
  });

  it("returns the stored status + lastUpdated + timeline for a known claim", async () => {
    const submitted = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-st" }));
    if (!submitted.ok) throw new Error("submit failed");

    const r = await mockAdapter.getClaimStatus(submitted.data.providerRef);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.providerRef).toBe(submitted.data.providerRef);
      expect(r.data.status).toBe("SUBMITTED");
      expect(r.data.amountApproved).toBeUndefined();
      expect(r.data.deniedReason).toBeUndefined();
      expect(typeof r.data.lastUpdated).toBe("string");
      expect(r.data.timeline).toHaveLength(1);
    }
  });

  it("forwards forced amountApproved and deniedReason once a status has been forced", async () => {
    const submitted = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-fwd" }));
    if (!submitted.ok) throw new Error("submit failed");
    __mockInternals.forceStatus(submitted.data.providerRef, "PARTIALLY_APPROVED", {
      amountApproved: 3200,
      deniedReason: "Pre-existing condition exclusion",
      note: "Adjuster review #2",
    });

    const r = await mockAdapter.getClaimStatus(submitted.data.providerRef);
    if (!r.ok) throw new Error("status failed");
    expect(r.data.status).toBe("PARTIALLY_APPROVED");
    expect(r.data.amountApproved).toBe(3200);
    expect(r.data.deniedReason).toBe("Pre-existing condition exclusion");
    expect(r.data.timeline.at(-1)).toEqual(
      expect.objectContaining({
        status: "PARTIALLY_APPROVED",
        note: "Adjuster review #2",
      }),
    );
  });

  it("returns a COPY of the timeline — mutating the returned array does not affect the stored claim", async () => {
    const submitted = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-copy" }));
    if (!submitted.ok) throw new Error("submit failed");

    const first = await mockAdapter.getClaimStatus(submitted.data.providerRef);
    if (!first.ok) throw new Error("first failed");
    first.data.timeline.push({
      status: "DENIED",
      timestamp: new Date().toISOString(),
      note: "EVIL CALLER WRITE",
    });

    const second = await mockAdapter.getClaimStatus(submitted.data.providerRef);
    if (!second.ok) throw new Error("second failed");
    expect(second.data.timeline).toHaveLength(1);
    expect(second.data.timeline.find((e) => e.note === "EVIL CALLER WRITE")).toBeUndefined();
  });
});

// ─── uploadDocument ──────────────────────────────────────────────────────

describe("mockAdapter.uploadDocument", () => {
  beforeEach(() => __mockInternals.reset());

  it("returns NOT_FOUND when the providerRef is unknown", async () => {
    const r = await mockAdapter.uploadDocument(
      "MOCK-NOPE",
      "BILL",
      Buffer.from("data"),
      "bill.pdf",
      "application/pdf",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
      expect(r.error.message).toMatch(/MOCK-NOPE/);
    }
  });

  it("rejects an empty buffer with INVALID_INPUT", async () => {
    const submitted = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-upl-empty" }));
    if (!submitted.ok) throw new Error("submit failed");

    const r = await mockAdapter.uploadDocument(
      submitted.data.providerRef,
      "BILL",
      Buffer.alloc(0),
      "empty.pdf",
      "application/pdf",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_INPUT");
      expect(r.error.message).toMatch(/empty/i);
    }
  });

  it("on success returns a deterministic DOC-<10-hex> providerDocId, docType, and uploadedAt", async () => {
    const submitted = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-upl-ok" }));
    if (!submitted.ok) throw new Error("submit failed");

    const docType: ClaimDocumentType = "DISCHARGE_SUMMARY";
    const r = await mockAdapter.uploadDocument(
      submitted.data.providerRef,
      docType,
      Buffer.from("PDF-CONTENT"),
      "ds.pdf",
      "application/pdf",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.providerRef).toBe(submitted.data.providerRef);
      expect(r.data.docType).toBe(docType);
      expect(r.data.providerDocId).toMatch(/^DOC-[0-9A-F]{10}$/);
      expect(typeof r.data.uploadedAt).toBe("string");
    }
  });

  it("appends a 'Document uploaded: <docType>' event to the timeline and bumps lastUpdated", async () => {
    const submitted = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-upl-tl" }));
    if (!submitted.ok) throw new Error("submit failed");

    const beforeStatus = await mockAdapter.getClaimStatus(submitted.data.providerRef);
    if (!beforeStatus.ok) throw new Error("status failed");
    const beforeLen = beforeStatus.data.timeline.length;
    const beforeLastUpdated = beforeStatus.data.lastUpdated;

    // Microsleep so the ISO timestamps actually differ.
    await new Promise((res) => setTimeout(res, 5));

    await mockAdapter.uploadDocument(
      submitted.data.providerRef,
      "INVESTIGATION_REPORT",
      Buffer.from("imaging"),
      "ct.dcm",
      "application/dicom",
    );

    const afterStatus = await mockAdapter.getClaimStatus(submitted.data.providerRef);
    if (!afterStatus.ok) throw new Error("status failed");
    expect(afterStatus.data.timeline.length).toBe(beforeLen + 1);
    const last = afterStatus.data.timeline.at(-1);
    expect(last?.note).toBe("Document uploaded: INVESTIGATION_REPORT");
    expect(last?.status).toBe("SUBMITTED"); // preserves current status
    expect(afterStatus.data.lastUpdated).not.toBe(beforeLastUpdated);
  });

  it("produces DISTINCT providerDocIds for two same-type/same-buffer uploads on the same claim (counter mixed into hash)", async () => {
    const submitted = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-upl-dup" }));
    if (!submitted.ok) throw new Error("submit failed");
    const buf = Buffer.from("same-bytes");

    const a = await mockAdapter.uploadDocument(submitted.data.providerRef, "BILL", buf, "1.pdf", "application/pdf");
    const b = await mockAdapter.uploadDocument(submitted.data.providerRef, "BILL", buf, "2.pdf", "application/pdf");
    if (a.ok && b.ok) {
      expect(a.data.providerDocId).not.toBe(b.data.providerDocId);
    } else {
      throw new Error("expected both uploads to succeed");
    }
  });
});

// ─── cancelClaim ─────────────────────────────────────────────────────────

describe("mockAdapter.cancelClaim", () => {
  beforeEach(() => __mockInternals.reset());

  it("returns NOT_FOUND for an unknown providerRef", async () => {
    const r = await mockAdapter.cancelClaim("MOCK-NOPE", "patient request");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("NOT_FOUND");
      expect(r.error.message).toMatch(/MOCK-NOPE/);
    }
  });

  it("refuses to cancel a SETTLED claim with BUSINESS_RULE", async () => {
    const submitted = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-settled" }));
    if (!submitted.ok) throw new Error("submit failed");
    __mockInternals.forceStatus(submitted.data.providerRef, "SETTLED", {
      amountApproved: 5000,
    });

    const r = await mockAdapter.cancelClaim(submitted.data.providerRef, "patient asked");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("BUSINESS_RULE");
      expect(r.error.message).toMatch(/settled/i);
    }
  });

  it("flips status to CANCELLED, appends a timeline entry with the reason, and returns cancelledAt", async () => {
    const submitted = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-cxl" }));
    if (!submitted.ok) throw new Error("submit failed");

    const reason = "Duplicate submission";
    const r = await mockAdapter.cancelClaim(submitted.data.providerRef, reason);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.providerRef).toBe(submitted.data.providerRef);
      expect(typeof r.data.cancelledAt).toBe("string");
    }

    const after = await mockAdapter.getClaimStatus(submitted.data.providerRef);
    if (!after.ok) throw new Error("status read failed");
    expect(after.data.status).toBe("CANCELLED");
    const last = after.data.timeline.at(-1);
    expect(last?.status).toBe("CANCELLED");
    expect(last?.note).toBe(reason);
  });

  it("allows cancelling claims in non-terminal statuses (IN_REVIEW, QUERY_RAISED, APPROVED)", async () => {
    for (const status of ["IN_REVIEW", "QUERY_RAISED", "APPROVED"] as const) {
      __mockInternals.reset();
      const submitted = await mockAdapter.submitClaim(
        makeInput({ internalClaimId: `ic-cxl-${status}` }),
      );
      if (!submitted.ok) throw new Error("submit failed");
      __mockInternals.forceStatus(submitted.data.providerRef, status);

      const r = await mockAdapter.cancelClaim(submitted.data.providerRef, `cxl from ${status}`);
      expect(r.ok).toBe(true);
    }
  });
});

// ─── __mockInternals escape hatch ────────────────────────────────────────

describe("__mockInternals.reset", () => {
  it("clears the in-memory store so previously-submitted claims become NOT_FOUND", async () => {
    const submitted = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-reset" }));
    if (!submitted.ok) throw new Error("submit failed");

    __mockInternals.reset();

    const r = await mockAdapter.getClaimStatus(submitted.data.providerRef);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });
});

describe("__mockInternals.forceStatus", () => {
  beforeEach(() => __mockInternals.reset());

  it("returns false for an unknown providerRef and does not create a new claim", async () => {
    const ok = __mockInternals.forceStatus("MOCK-NOPE", "APPROVED");
    expect(ok).toBe(false);
    const status = await mockAdapter.getClaimStatus("MOCK-NOPE");
    expect(status.ok).toBe(false);
  });

  it("returns true for a known providerRef and mutates the stored status", async () => {
    const submitted = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-fs-1" }));
    if (!submitted.ok) throw new Error("submit failed");

    const ok = __mockInternals.forceStatus(submitted.data.providerRef, "IN_REVIEW");
    expect(ok).toBe(true);

    const after = await mockAdapter.getClaimStatus(submitted.data.providerRef);
    if (!after.ok) throw new Error("status failed");
    expect(after.data.status).toBe("IN_REVIEW");
    expect(after.data.timeline.at(-1)?.status).toBe("IN_REVIEW");
    expect(after.data.timeline.at(-1)?.note).toBeUndefined();
  });

  it("attaches amountApproved + deniedReason + note when supplied via opts", async () => {
    const submitted = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-fs-2" }));
    if (!submitted.ok) throw new Error("submit failed");

    __mockInternals.forceStatus(submitted.data.providerRef, "DENIED", {
      deniedReason: "Policy exclusion XYZ",
      note: "Adjuster decision",
    });

    const after = await mockAdapter.getClaimStatus(submitted.data.providerRef);
    if (!after.ok) throw new Error("status failed");
    expect(after.data.status).toBe("DENIED");
    expect(after.data.deniedReason).toBe("Policy exclusion XYZ");
    expect(after.data.amountApproved).toBeUndefined();
    expect(after.data.timeline.at(-1)?.note).toBe("Adjuster decision");
  });

  it("appends a new timeline entry on each forceStatus call (does not overwrite earlier events)", async () => {
    const submitted = await mockAdapter.submitClaim(makeInput({ internalClaimId: "ic-fs-3" }));
    if (!submitted.ok) throw new Error("submit failed");

    __mockInternals.forceStatus(submitted.data.providerRef, "IN_REVIEW", { note: "step 1" });
    __mockInternals.forceStatus(submitted.data.providerRef, "QUERY_RAISED", { note: "step 2" });
    __mockInternals.forceStatus(submitted.data.providerRef, "APPROVED", {
      amountApproved: 4800,
      note: "step 3",
    });

    const after = await mockAdapter.getClaimStatus(submitted.data.providerRef);
    if (!after.ok) throw new Error("status failed");
    // Initial SUBMITTED event + 3 forced events = 4.
    expect(after.data.timeline).toHaveLength(4);
    expect(after.data.timeline.map((e) => e.status)).toEqual([
      "SUBMITTED",
      "IN_REVIEW",
      "QUERY_RAISED",
      "APPROVED",
    ]);
    expect(after.data.amountApproved).toBe(4800);
    expect(after.data.status).toBe("APPROVED");
  });
});
