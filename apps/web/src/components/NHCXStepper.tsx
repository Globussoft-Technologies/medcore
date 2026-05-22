"use client";

// NHCX cashless stub stepper — Pearl §4.2 (gap-row 103, "stage-1 stub").
//
// Renders the horizontal 4-stage Pearl lifecycle (Submitted → In Review →
// Approved → Settled) for a single InsuranceClaim row off an invoice. The
// 4-stage shape is Pearl's simplified visual; the underlying enum on
// `InsuranceClaim` is the legacy 4-value `ClaimStatus`
// (SUBMITTED / APPROVED / REJECTED / SETTLED). The richer
// `InsuranceClaim2.NormalisedClaimStatus` (QUERY_RAISED / IN_REVIEW /
// PARTIALLY_APPROVED / DENIED / CANCELLED) is surfaced as a variant pill
// next to the stepper rather than as a stage node, because Pearl asks for
// a fixed-position visual and variants would distort the geometry.
//
// Mirrors the patient-surface stepper at
// `apps/web/src/app/patient/bills/[id]/page.tsx:706-763` (shipped 4f5ec68).
// The two are deliberately kept in lock-step shape so a patient + staff
// looking at the same claim see the same lifecycle position.
//
// Sections:
//   1. Header row — provider name + claimed/approved amounts (when known).
//   2. Variant pill — only when `status` is off the 4-stage happy path
//      (REJECTED in the legacy enum; or any of the v2 variants if the
//      caller passes one of those strings — the component tolerates
//      unknown strings so it stays compatible with both InsuranceClaim
//      and InsuranceClaim2 callers).
//   3. Horizontal stepper — 4 nodes, current highlighted, past
//      checkmarked, future ghosted. Stacks vertically on `sm:` viewports.
//   4. Admin "Move to next stage" button — only rendered when
//      `userRole === "ADMIN"` AND `onAdvance` is wired. Per PRD §4.2,
//      this is a test-only admin operation; we deliberately keep it off
//      RECEPTION + DOCTOR even though the underlying PATCH endpoint
//      accepts RECEPTION too.
//
// Server-side counterpart: PATCH `/api/v1/billing/claims/:id`
// (apps/api/src/routes/billing.ts:861) — ADMIN+RECEPTION, body
// `{ status }`. The "next stage" map is local-only.

import { useState } from "react";

// Pearl 4-stage shape (label + the legacy ClaimStatus enum value that
// most cleanly represents it). The stepper maps any incoming claim
// status (legacy 4-enum OR the richer NormalisedClaimStatus 8-enum) to
// one of these four positions via `stageIndexFor` below.
export const NHCX_STAGES = [
  { key: "SUBMITTED", label: "Submitted" },
  { key: "IN_REVIEW", label: "In Review" },
  { key: "APPROVED", label: "Approved" },
  { key: "SETTLED", label: "Settled" },
] as const;

// Variant statuses — rendered as a pill next to the stepper rather than
// as a stage node, to keep the 4-position geometry stable per Pearl §4.2.
const VARIANT_LABELS: Record<string, { label: string; tone: string }> = {
  REJECTED: { label: "Rejected", tone: "bg-red-100 text-red-800" },
  DENIED: { label: "Denied", tone: "bg-red-100 text-red-800" },
  QUERY_RAISED: { label: "Query raised", tone: "bg-amber-100 text-amber-800" },
  PARTIALLY_APPROVED: {
    label: "Partially approved",
    tone: "bg-amber-100 text-amber-800",
  },
  CANCELLED: { label: "Cancelled", tone: "bg-slate-200 text-slate-700" },
};

/**
 * Map either a legacy `ClaimStatus` value or a `NormalisedClaimStatus`
 * value onto a 4-stage Pearl position. Unknown / variant statuses fall
 * back to a position derived from intent:
 *  - REJECTED / DENIED / QUERY_RAISED / CANCELLED → stay at stage 1
 *    (In Review), so the operator can see "we got to the insurer but
 *    didn't settle". The variant pill clarifies the why.
 *  - PARTIALLY_APPROVED → stage 2 (Approved).
 */
export function stageIndexFor(status: string | null | undefined): number {
  if (!status) return -1;
  switch (status) {
    case "SUBMITTED":
      return 0;
    case "IN_REVIEW":
      return 1;
    case "APPROVED":
    case "PARTIALLY_APPROVED":
      return 2;
    case "SETTLED":
      return 3;
    case "REJECTED":
    case "DENIED":
    case "QUERY_RAISED":
      return 1;
    case "CANCELLED":
      return 0;
    default:
      return 0;
  }
}

/** Next stage on the 4-stage happy path, or null if already terminal. */
export function nextHappyPathStatus(
  status: string | null | undefined,
): "APPROVED" | "SETTLED" | null {
  switch (status) {
    case "SUBMITTED":
      // Legacy enum has no IN_REVIEW; the visual "In Review" stage maps
      // to the SUBMITTED-but-not-yet-APPROVED window — clicking "Move
      // to next stage" from SUBMITTED therefore jumps to APPROVED. This
      // matches the legacy API behaviour and the way the existing
      // claim-list page transitions today.
      return "APPROVED";
    case "APPROVED":
      return "SETTLED";
    default:
      return null;
  }
}

export interface NHCXClaimSummary {
  id: string;
  status: string; // ClaimStatus OR NormalisedClaimStatus
  insuranceProvider?: string | null;
  insurerName?: string | null; // v2 field name
  claimAmount?: number | null;
  amountClaimed?: number | null; // v2 field name
  approvedAmount?: number | null;
  amountApproved?: number | null; // v2 field name
}

interface NHCXStepperProps {
  claim: NHCXClaimSummary;
  /** Role of the viewer; only "ADMIN" gets the Move-to-next button. */
  userRole?: string | null;
  /**
   * Called when the admin clicks "Move to next stage" with the next
   * legacy enum value. Resolves on server ack; caller is responsible
   * for refetching state.
   */
  onAdvance?: (nextStatus: "APPROVED" | "SETTLED") => Promise<void>;
}

function formatRupees(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `Rs. ${Number(n).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function NHCXStepper({
  claim,
  userRole,
  onAdvance,
}: NHCXStepperProps): React.ReactElement {
  const [advancing, setAdvancing] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);

  const activeIdx = stageIndexFor(claim.status);
  const variant = VARIANT_LABELS[claim.status];
  const provider = claim.insuranceProvider ?? claim.insurerName ?? null;
  const claimAmt = claim.claimAmount ?? claim.amountClaimed ?? null;
  const approvedAmt = claim.approvedAmount ?? claim.amountApproved ?? null;

  const next = nextHappyPathStatus(claim.status);
  const showAdvance =
    userRole === "ADMIN" && typeof onAdvance === "function" && next !== null;

  async function handleAdvance() {
    if (!next || !onAdvance) return;
    setAdvancing(true);
    setAdvanceError(null);
    try {
      await onAdvance(next);
    } catch (err) {
      setAdvanceError(err instanceof Error ? err.message : "Advance failed");
    } finally {
      setAdvancing(false);
    }
  }

  return (
    <section
      data-testid="nhcx-stepper"
      data-claim-id={claim.id}
      data-claim-status={claim.status}
      aria-labelledby="nhcx-stepper-heading"
      className="mb-6 space-y-3 rounded-lg border border-blue-100 bg-blue-50/40 p-4 dark:border-blue-900/40 dark:bg-blue-900/10 print:border-blue-100 print:bg-blue-50/40"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h3
            id="nhcx-stepper-heading"
            className="text-xs font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-200"
          >
            NHCX cashless claim status
          </h3>
          {provider ? (
            <p
              data-testid="nhcx-stepper-provider"
              className="text-xs text-gray-600 dark:text-gray-300"
            >
              {provider}
              {claimAmt !== null ? ` · Claimed ${formatRupees(claimAmt)}` : ""}
              {approvedAmt !== null
                ? ` · Approved ${formatRupees(approvedAmt)}`
                : ""}
            </p>
          ) : null}
        </div>
        {variant ? (
          <span
            data-testid="nhcx-stepper-variant"
            className={`whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium ${variant.tone}`}
          >
            {variant.label}
          </span>
        ) : null}
      </div>

      {/* Stepper — horizontal on >=sm, stacks vertically below */}
      <ol
        aria-label="NHCX cashless claim stages"
        className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-1"
      >
        {NHCX_STAGES.map((stage, idx) => {
          const active = idx === activeIdx;
          const done = idx < activeIdx;
          const cls = active
            ? "bg-blue-600 text-white border-blue-600"
            : done
              ? "bg-emerald-100 text-emerald-900 border-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-100"
              : "bg-white text-gray-500 border-gray-300 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-600";
          return (
            <li
              key={stage.key}
              data-testid={`nhcx-stepper-stage-${idx}`}
              data-stage-key={stage.key}
              data-active={active ? "true" : "false"}
              data-done={done ? "true" : "false"}
              className="flex items-center gap-1 sm:flex-1"
            >
              <span
                className={`flex w-full items-center justify-center gap-1 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium ${cls}`}
              >
                {done ? (
                  <span aria-hidden="true" className="font-bold">
                    ✓
                  </span>
                ) : (
                  <span aria-hidden="true">{idx + 1}.</span>
                )}
                {stage.label}
              </span>
              {idx < NHCX_STAGES.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="hidden h-0.5 w-2 bg-gray-300 dark:bg-gray-600 sm:inline-block"
                />
              ) : null}
            </li>
          );
        })}
      </ol>

      {showAdvance ? (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={handleAdvance}
            disabled={advancing}
            data-testid="nhcx-stepper-advance-btn"
            // 44px touch target per Pearl §6.2 — h-11 = 44px exactly.
            className="inline-flex h-11 min-w-11 items-center justify-center rounded-md border border-blue-600 bg-white px-4 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-60 dark:bg-gray-800 dark:text-blue-200 dark:hover:bg-gray-700"
          >
            {advancing ? "Advancing..." : `Move to next stage → ${next}`}
          </button>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Admin-only test action; live insurer integration is Stage 3.
          </p>
        </div>
      ) : null}

      {advanceError ? (
        <p
          role="alert"
          data-testid="nhcx-stepper-error"
          className="text-xs text-red-600 dark:text-red-400"
        >
          {advanceError}
        </p>
      ) : null}
    </section>
  );
}
