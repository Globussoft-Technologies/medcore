"use client";

// Patient PWA — My Bills (Pearl §6.1 — gap #5 piece 3d of 4).
//
// Two sections, mirroring the prescriptions / appointments shape (pieces 3b
// + 3c):
//   • Open — paymentStatus ∈ {PENDING, PARTIAL}. Sorted ASC by dueDate (most
//     overdue first; rows with no dueDate sink to the bottom). Header carries
//     a count badge + total outstanding ₹ summary. PRD §6.1 talks about an
//     OVERDUE bucket; the PaymentStatus enum at schema.prisma:64-69 only has
//     PENDING / PAID / PARTIAL / REFUNDED, so "overdue" is DERIVED on the
//     client from `dueDate < now`. The pill flips to red and the row gets
//     an "Overdue" badge so the patient sees it.
//   • Paid — paymentStatus === PAID. Collapsed behind a "Show paid bills"
//     toggle (same UX as past appointments in piece 3b). Sorted DESC by
//     createdAt.
//
// Per-row CTAs (all 44px touch targets per Pearl §6.2):
//   • View detail        — Link to `/patient/bills/[id]` (placeholder; the
//                          detail page is piece 3e/3i work, this link will
//                          404 today and that's documented as expected).
//   • Pay now            — Primary CTA on Open rows ONLY. Links to
//                          `/patient/bills/[id]/pay` which is also a stub
//                          (Razorpay handoff is piece 3i). Hidden on Paid.
//   • Download GST       — Anchor → `GET /api/v1/billing/invoices/:id/pdf?format=pdf`.
//                          The endpoint is BOLA-gated server-side via
//                          assertPatientOwnsResource (billing.ts:2833) so
//                          a tampered :id from another patient → 403.
//
// Backed by:
//   • GET /api/v1/billing/invoices — auto-scopes to the authed PATIENT via
//     the route's `req.user.role === "PATIENT"` branch (billing.ts:526-531).
//     Supports `?status=PENDING,PARTIAL` (comma-list), `?page`, `?limit`
//     (cap 100), and returns `meta.total` for paginated "Load more". We fan
//     out two parallel requests — open + paid — so the patient sees the open
//     bucket immediately even if the paid history is long.
//
// NHCX cashless stub stepper (Pearl §4.2 — "Stage 1 displays the stub
// stepper; live insurer integration is Stage 3"):
//   The Invoice schema doesn't carry a `coverage_status` column today —
//   the gap doc's row 4.2 notes that `InsuranceClaim2.status` (richer enum)
//   serves the same lifecycle modelling at a higher fidelity than Pearl
//   asks for. We pull the row's `insuranceClaims[]` relation (legacy
//   InsuranceClaim — ClaimStatus enum SUBMITTED/APPROVED/REJECTED/SETTLED)
//   IF the server hydrated it; today the GET /invoices include block at
//   billing.ts:536-542 ships `items, payments, patient` ONLY, so the
//   stepper is dark by default and lights up the moment the server-side
//   include is extended. Scope-cut documented in gap-row 5 closure note —
//   wiring the server include is a non-trivial schema-load decision and
//   the gap doc explicitly defers it. The stepper renders 4 stages and
//   highlights the current one; if no claim row is attached, the stepper
//   is hidden entirely (a patient with no insurance coverage shouldn't see
//   a meaningless 4-step strip).
//
// Page-shape conventions copied wholesale from piece 3c (prescriptions):
//   • Loading / unauth / error / ready state machine
//   • "Load more" pagination on the OPEN bucket (PAGE_SIZE=20). The paid
//     bucket uses a single 50-row fetch — paid history rarely exceeds that
//     for the average patient over a year, and we don't paginate behind a
//     collapsed section. Documented as a follow-up.

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { api } from "@/lib/api";

interface InsuranceClaimLite {
  id: string;
  status: string; // ClaimStatus: SUBMITTED / APPROVED / REJECTED / SETTLED
}

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  patientId: string;
  totalAmount: number;
  paymentStatus: "PENDING" | "PAID" | "PARTIAL" | "REFUNDED";
  dueDate?: string | null;
  createdAt: string;
  payments?: Array<{ amount: number; status?: string }> | null;
  // Optional — server's GET /invoices include doesn't ship this today, but
  // the stepper lights up the moment a future include extension lands.
  insuranceClaims?: InsuranceClaimLite[] | null;
}

interface ApiList<T> {
  success: boolean;
  data: T[];
  error?: string | null;
  meta?: { page: number; limit: number; total: number };
}

type LoadState = "loading" | "ready" | "unauth" | "error";

const PAGE_SIZE = 20;

// NHCX cashless stepper stages — Pearl §4.2 "stub stepper". The 4 visible
// stages mirror the lifecycle Pearl PRD calls out as the canonical
// patient-facing journey: coverage check → pre-auth pending → claim
// submitted → settled. We MAP MedCore's ClaimStatus enum onto these
// stages so the existing data lights the stepper up without inventing a
// new column. Hidden if no claim is attached.
const CASHLESS_STAGES = [
  { key: "COVERAGE_CHECK", label: "Coverage check" },
  { key: "PRE_AUTH", label: "Pre-auth pending" },
  { key: "SUBMITTED", label: "Claim submitted" },
  { key: "SETTLED", label: "Settled" },
] as const;

function mapClaimStatusToStage(status: string | undefined | null): number {
  // Returns index into CASHLESS_STAGES; -1 if no claim.
  if (!status) return -1;
  switch (status) {
    case "SUBMITTED":
      return 2; // claim submitted
    case "APPROVED":
      return 2; // approved but not yet settled
    case "SETTLED":
      return 3; // settled — terminal
    case "REJECTED":
      return 2; // ended at submitted (denied)
    default:
      return 0;
  }
}

// PaymentStatus → user-facing buckets. "OVERDUE" is purely derived on the
// client (dueDate < today AND status in {PENDING, PARTIAL}) per the
// schema note above.
function isOpen(status: InvoiceRow["paymentStatus"]): boolean {
  return status === "PENDING" || status === "PARTIAL";
}

function isOverdue(row: InvoiceRow): boolean {
  if (!isOpen(row.paymentStatus)) return false;
  if (!row.dueDate) return false;
  return new Date(row.dueDate).getTime() < Date.now();
}

function statusPillClass(row: InvoiceRow): string {
  if (row.paymentStatus === "PAID") return "bg-emerald-100 text-emerald-900";
  if (row.paymentStatus === "REFUNDED") return "bg-slate-200 text-slate-700";
  if (isOverdue(row)) return "bg-red-100 text-red-900";
  if (row.paymentStatus === "PARTIAL") return "bg-amber-100 text-amber-900";
  return "bg-blue-100 text-blue-900";
}

function statusPillLabel(row: InvoiceRow): string {
  if (isOverdue(row)) return "OVERDUE";
  return row.paymentStatus;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatRupees(n: number): string {
  // INR-locale comma grouping; 2 decimals fixed. Decimal columns on the
  // server emit as JS numbers via the Decimal.prototype.toJSON shim at
  // billing.ts module load.
  const safe = Number.isFinite(n) ? n : 0;
  return `₹${safe.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function outstandingFor(row: InvoiceRow): number {
  // For PENDING / PARTIAL we want total minus payments captured. The list
  // endpoint ships `payments[]`; sum the non-FAILED ones. Defensive against
  // PAID rows showing residual outstanding via the same path.
  if (row.paymentStatus === "PAID") return 0;
  const paid = (row.payments ?? [])
    .filter((p) => (p.status ?? "CAPTURED") !== "FAILED")
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  return Math.max(0, Number(row.totalAmount) - paid);
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";

function buildGstPdfUrl(id: string): string {
  return `${API_BASE.replace(/\/$/, "")}/billing/invoices/${id}/pdf?format=pdf`;
}

export default function PatientBillsPage() {
  const [state, setState] = useState<LoadState>("loading");
  const [openRows, setOpenRows] = useState<InvoiceRow[]>([]);
  const [paidRows, setPaidRows] = useState<InvoiceRow[]>([]);
  const [openPage, setOpenPage] = useState(1);
  const [openTotal, setOpenTotal] = useState(0);
  const [showPaid, setShowPaid] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchInitial = useCallback(async (): Promise<void> => {
    setState("loading");
    try {
      const [openRes, paidRes] = await Promise.allSettled([
        api.get<ApiList<InvoiceRow>>(
          `/billing/invoices?status=PENDING,PARTIAL&page=1&limit=${PAGE_SIZE}`,
          { skip401Redirect: true },
        ),
        api.get<ApiList<InvoiceRow>>(
          `/billing/invoices?status=PAID&page=1&limit=50`,
          { skip401Redirect: true },
        ),
      ]);

      const any401 = [openRes, paidRes].some(
        (r) =>
          r.status === "rejected" &&
          (r.reason as { status?: number })?.status === 401,
      );
      if (any401) {
        setState("unauth");
        return;
      }

      const open: InvoiceRow[] =
        openRes.status === "fulfilled" && openRes.value.success
          ? openRes.value.data ?? []
          : [];
      const paid: InvoiceRow[] =
        paidRes.status === "fulfilled" && paidRes.value.success
          ? paidRes.value.data ?? []
          : [];

      setOpenRows(open);
      setPaidRows(paid);
      setOpenTotal(
        openRes.status === "fulfilled" && openRes.value.meta
          ? openRes.value.meta.total
          : open.length,
      );
      setOpenPage(1);
      setState("ready");
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 401) {
        setState("unauth");
        return;
      }
      setState("error");
    }
  }, []);

  const fetchMoreOpen = useCallback(async (): Promise<void> => {
    const nextPage = openPage + 1;
    setLoadingMore(true);
    try {
      const res = await api.get<ApiList<InvoiceRow>>(
        `/billing/invoices?status=PENDING,PARTIAL&page=${nextPage}&limit=${PAGE_SIZE}`,
        { skip401Redirect: true },
      );
      if (res.success) {
        setOpenRows((prev) => [...prev, ...(res.data ?? [])]);
        if (res.meta?.total != null) setOpenTotal(res.meta.total);
        setOpenPage(nextPage);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [openPage]);

  useEffect(() => {
    void fetchInitial();
  }, [fetchInitial]);

  // Sort: open ASC by dueDate (nulls last); paid DESC by createdAt.
  const sortedOpen = useMemo(() => {
    const copy = [...openRows];
    copy.sort((a, b) => {
      const ad = a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
      const bd = b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
      return ad - bd;
    });
    return copy;
  }, [openRows]);

  const sortedPaid = useMemo(() => {
    const copy = [...paidRows];
    copy.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return copy;
  }, [paidRows]);

  const totalOutstanding = useMemo(
    () => sortedOpen.reduce((sum, r) => sum + outstandingFor(r), 0),
    [sortedOpen],
  );

  if (state === "loading") {
    return (
      <section
        data-testid="patient-bills-loading"
        className="flex min-h-[40vh] items-center justify-center text-sm text-slate-500"
      >
        Loading your bills…
      </section>
    );
  }

  if (state === "unauth") {
    return (
      <section data-testid="patient-bills-unauth" className="space-y-4 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-base text-slate-600">
          Please sign in to view your bills.
        </p>
        <Link
          href="/patient/login"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white"
          data-testid="patient-bills-signin-cta"
        >
          Sign in
        </Link>
      </section>
    );
  }

  if (state === "error") {
    return (
      <section
        data-testid="patient-bills-error"
        role="alert"
        className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800"
      >
        Something went wrong loading your bills. Please refresh.
      </section>
    );
  }

  const isEmpty = sortedOpen.length === 0 && sortedPaid.length === 0;
  const hasMoreOpen = sortedOpen.length < openTotal;

  return (
    <section data-testid="patient-bills" className="space-y-6 py-4">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">My bills</h1>
          {sortedOpen.length > 0 ? (
            <span
              data-testid="patient-bills-open-count"
              className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700"
            >
              {sortedOpen.length} open
            </span>
          ) : null}
        </div>
        {totalOutstanding > 0 ? (
          <div
            data-testid="patient-bills-outstanding-total"
            className="rounded-md bg-red-50 px-3 py-2 text-sm font-semibold text-red-900"
          >
            Outstanding {formatRupees(totalOutstanding)}
          </div>
        ) : null}
      </header>

      {isEmpty ? (
        <div
          data-testid="patient-bills-empty"
          className="space-y-3 rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm"
        >
          <p className="text-base text-slate-700">
            No bills yet. Invoices raised after a visit will appear here.
          </p>
        </div>
      ) : (
        <>
          {/* ─── Open ─────────────────────────────────────────────────── */}
          <section
            data-testid="patient-bills-open"
            aria-labelledby="open-heading"
            className="space-y-3"
          >
            <h2
              id="open-heading"
              className="text-sm font-medium uppercase tracking-wide text-slate-500"
            >
              Open
            </h2>
            {sortedOpen.length === 0 ? (
              <p
                data-testid="patient-bills-open-empty"
                className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600"
              >
                No open bills. You&apos;re all caught up!
              </p>
            ) : (
              <ul className="space-y-3">
                {sortedOpen.map((inv) => (
                  <BillCard key={inv.id} invoice={inv} />
                ))}
              </ul>
            )}

            {hasMoreOpen ? (
              <div className="flex justify-center pt-2">
                <button
                  type="button"
                  disabled={loadingMore}
                  onClick={() => void fetchMoreOpen()}
                  data-testid="patient-bills-load-more"
                  className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 px-6 text-sm font-medium text-slate-800 disabled:opacity-60"
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
            ) : null}
          </section>

          {/* ─── Paid (collapsible) ───────────────────────────────────── */}
          {sortedPaid.length > 0 ? (
            <section
              data-testid="patient-bills-paid"
              aria-labelledby="paid-heading"
              className="space-y-3"
            >
              <div className="flex items-center justify-between">
                <h2
                  id="paid-heading"
                  className="text-sm font-medium uppercase tracking-wide text-slate-500"
                >
                  Paid
                </h2>
                <button
                  type="button"
                  onClick={() => setShowPaid((v) => !v)}
                  aria-expanded={showPaid}
                  data-testid="patient-bills-paid-toggle"
                  className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-800"
                >
                  {showPaid ? "Hide paid bills" : "Show paid bills"}
                </button>
              </div>
              {showPaid ? (
                sortedPaid.length === 0 ? (
                  <p
                    data-testid="patient-bills-paid-empty"
                    className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600"
                  >
                    No past bills yet.
                  </p>
                ) : (
                  <ul
                    data-testid="patient-bills-paid-list"
                    className="space-y-3"
                  >
                    {sortedPaid.map((inv) => (
                      <BillCard key={inv.id} invoice={inv} />
                    ))}
                  </ul>
                )
              ) : null}
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}

interface CardProps {
  invoice: InvoiceRow;
}

function BillCard({ invoice }: CardProps) {
  const open = isOpen(invoice.paymentStatus);
  const overdue = isOverdue(invoice);
  const outstanding = outstandingFor(invoice);
  const claim = invoice.insuranceClaims?.[0] ?? null;
  const activeStageIdx = mapClaimStatusToStage(claim?.status);
  const showStepper = activeStageIdx >= 0;
  const gstPdfUrl = buildGstPdfUrl(invoice.id);

  return (
    <li
      data-testid="patient-bills-row"
      data-invoice-id={invoice.id}
      className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <p
            data-testid="patient-bills-row-number"
            className="text-xs font-medium uppercase tracking-wide text-slate-500"
          >
            #{invoice.invoiceNumber}
          </p>
          <p className="text-base font-semibold text-slate-900">
            {formatRupees(Number(invoice.totalAmount))}
          </p>
          <p className="text-xs text-slate-600">
            Issued {formatDate(invoice.createdAt)}
          </p>
          {open && invoice.dueDate ? (
            <p
              data-testid="patient-bills-row-due"
              className={`text-xs font-medium ${
                overdue ? "text-red-700" : "text-slate-600"
              }`}
            >
              Due {formatDate(invoice.dueDate)}
              {overdue ? " — overdue" : ""}
            </p>
          ) : null}
          {open && outstanding > 0 && outstanding !== Number(invoice.totalAmount) ? (
            <p
              data-testid="patient-bills-row-outstanding"
              className="text-xs text-slate-700"
            >
              Outstanding {formatRupees(outstanding)}
            </p>
          ) : null}
        </div>
        <span
          data-testid="patient-bills-row-status"
          className={`rounded-full px-2 py-1 text-xs font-medium ${statusPillClass(
            invoice,
          )}`}
        >
          {statusPillLabel(invoice)}
        </span>
      </div>

      {showStepper ? (
        <div
          data-testid="patient-bills-row-stepper"
          aria-label="Cashless claim status"
          className="flex items-center gap-1 overflow-x-auto pb-1"
        >
          {CASHLESS_STAGES.map((stage, idx) => {
            const active = idx === activeStageIdx;
            const done = idx < activeStageIdx;
            const cls = active
              ? "bg-slate-900 text-white"
              : done
                ? "bg-emerald-100 text-emerald-900"
                : "bg-slate-100 text-slate-600";
            return (
              <span
                key={stage.key}
                data-testid={`patient-bills-row-stepper-stage-${idx}`}
                data-active={active ? "true" : "false"}
                data-done={done ? "true" : "false"}
                className={`whitespace-nowrap rounded-full px-2 py-1 text-[10px] font-medium ${cls}`}
              >
                {idx + 1}. {stage.label}
              </span>
            );
          })}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 pt-1">
        {open ? (
          <Link
            href={`/patient/bills/${invoice.id}/pay`}
            data-testid="patient-bills-pay-btn"
            className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white"
          >
            Pay now
          </Link>
        ) : null}
        <Link
          href={`/patient/bills/${invoice.id}`}
          data-testid="patient-bills-view-btn"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-800"
        >
          View detail
        </Link>
        <a
          href={gstPdfUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="patient-bills-gst-btn"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-800"
        >
          Download GST invoice
        </a>
      </div>
    </li>
  );
}
