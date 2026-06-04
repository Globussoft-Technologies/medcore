"use client";

// Patient PWA — My Prescriptions (Pearl §6.1 — gap #5 piece 3c of 4).
//
// Lists the authed PATIENT's signed prescriptions newest-first with three
// per-row CTAs per the PRD:
//   • Download PDF        — opens `GET /api/v1/prescriptions/:id/pdf?format=pdf`
//                           in a new tab. Cookies travel automatically
//                           (credentials: "include" is the dashboard default
//                           on same-origin requests; PWA + API share origin
//                           in production via the reverse proxy). The route
//                           is RBAC-gated AND BOLA-gated via
//                           `assertPatientOwnsResource` (prescriptions.ts:766).
//   • Share via WhatsApp  — `https://wa.me/?text=<encoded>` with the verify
//                           URL the existing `/verify/rx/[id]` page accepts.
//                           Server-side share endpoint (`POST /:id/share`)
//                           refuses unsigned / cancelled Rx — we mirror that
//                           by hiding both Share CTAs when the row is
//                           DRAFT / CANCELLED / REJECTED.
//   • Verify QR           — opens `/verify/rx/<id>` in a new tab so the
//                           patient can see what a QR scanner would render
//                           (the public verification view).
//
// Backed by:
//   • GET /api/v1/prescriptions?limit=20&page=N — auto-scopes to the authed
//     PATIENT via the route's existing `req.user.role === "PATIENT"` branch
//     (prescriptions.ts:655-660). The endpoint also supports `?status=` so
//     a future "Hide cancelled" toggle is one query-param away.
//
// Page-shape conventions mirror `apps/web/src/app/patient/appointments/page.tsx`
// (piece 3b) — same loading / unauth / error / ready state machine; same
// 44px touch-target floor (Pearl §6.2); same testid prefix shape.
//
// "Load more" pagination: the prescriptions list endpoint exposes
// `page`/`limit` with a hard cap of 100 per page (prescriptions.ts:597). We
// default to 20 per page and append the next page when the patient taps
// the load-more CTA, until `meta.total` is reached.

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { formatDoctorName } from "@/lib/format-doctor-name";
import { toast } from "@/lib/toast";

interface PrescriptionItem {
  id: string;
  medicineName: string;
  dosage?: string | null;
  frequency?: string | null;
}

interface PrescriptionRow {
  id: string;
  createdAt: string;
  diagnosis?: string | null;
  status?: string | null;
  signatureUrl?: string | null;
  doctor?: {
    user?: { name?: string | null } | null;
    specialty?: string | null;
  } | null;
  items?: PrescriptionItem[] | null;
}

interface ApiList<T> {
  success: boolean;
  data: T[];
  error?: string | null;
  meta?: { page: number; limit: number; total: number };
}

type LoadState = "loading" | "ready" | "unauth" | "error";

const PAGE_SIZE = 20;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function statusPillClass(status: string | null | undefined): string {
  if (!status) return "bg-slate-100 dark:bg-gray-800 text-slate-700 dark:text-gray-200";
  if (status === "ACTIVE" || status === "ISSUED" || status === "SIGNED")
    return "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-900 dark:text-emerald-200";
  if (status === "DRAFT") return "bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-200";
  if (status === "CANCELLED" || status === "REJECTED")
    return "bg-slate-200 dark:bg-gray-700 text-slate-700 dark:text-gray-200";
  return "bg-slate-100 dark:bg-gray-800 text-slate-700 dark:text-gray-200";
}

// Build the verify URL the public `/verify/rx/[id]` page accepts. On the
// client we can use `window.location.origin` so the verify URL points at
// whatever host the patient is on (dev/staging/prod). On SSR we leave it
// blank and re-resolve on first effect tick.
function buildVerifyUrl(id: string): string {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "";
  return `${origin}/verify/rx/${id}`;
}

// API_BASE — same env shape `lib/api.ts` uses. For the PDF link we want a
// real anchor `href` (so right-click "Save as" / long-press "Download" both
// work) rather than a fetch + blob; the cookie auth travels along the same
// origin in production. In local dev the API lives at :4000 and the web
// app at :3000, so we point at the absolute URL.
const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";

function buildPdfUrl(id: string): string {
  return `${API_BASE.replace(/\/$/, "")}/prescriptions/${id}/pdf?format=pdf`;
}

export default function PatientPrescriptionsPage() {
  const [state, setState] = useState<LoadState>("loading");
  const [prescriptions, setPrescriptions] = useState<PrescriptionRow[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  // Same shape as the dashboard's Recent Prescriptions tile + the doctor
  // side (apps/web/src/app/dashboard/prescriptions/page.tsx `shareVia` at
  // L494): POST /prescriptions/:id/share with { channel: "WHATSAPP" }.
  // Server delivers the verify link to the patient's registered phone via
  // Meta Cloud API and logs the share — no client-side `wa.me` navigation,
  // the patient stays on this page and sees a toast. The doctor side's
  // Sign-before-share modal branch doesn't apply here (patient can't sign
  // for the doctor), so on a 409 "unsigned" we surface the API's message
  // verbatim.
  const [sharingRxId, setSharingRxId] = useState<string | null>(null);
  const shareViaWhatsApp = useCallback(async (rxId: string): Promise<void> => {
    setSharingRxId((curr) => {
      // Guard against double-click while one share is in flight.
      if (curr) return curr;
      return rxId;
    });
    try {
      await api.post(`/prescriptions/${rxId}/share`, { channel: "WHATSAPP" });
      toast.success("Prescription shared via WhatsApp");
    } catch (err) {
      const anyErr = err as Error & {
        status?: number;
        payload?: { error?: string };
      };
      const msg =
        anyErr?.payload?.error ??
        (err instanceof Error ? err.message : "Failed to share");
      toast.error(msg);
    } finally {
      setSharingRxId(null);
    }
  }, []);

  const fetchPage = useCallback(
    async (
      pageNum: number,
      mode: "replace" | "append",
    ): Promise<void> => {
      if (mode === "replace") setState("loading");
      else setLoadingMore(true);
      try {
        const res = await api.get<ApiList<PrescriptionRow>>(
          `/prescriptions?page=${pageNum}&limit=${PAGE_SIZE}`,
          { skip401Redirect: true },
        );
        if (!res.success) {
          setState("error");
          return;
        }
        const incoming = res.data ?? [];
        setPrescriptions((prev) =>
          mode === "append" ? [...prev, ...incoming] : incoming,
        );
        if (res.meta?.total != null) setTotal(res.meta.total);
        setPage(pageNum);
        setState("ready");
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status === 401) {
          setState("unauth");
          return;
        }
        setState("error");
      } finally {
        setLoadingMore(false);
      }
    },
    [],
  );

  useEffect(() => {
    void fetchPage(1, "replace");
  }, [fetchPage]);

  if (state === "loading") {
    return (
      <section
        data-testid="patient-prescriptions-loading"
        className="flex min-h-[40vh] items-center justify-center text-sm text-slate-500 dark:text-gray-400"
      >
        Loading your prescriptions…
      </section>
    );
  }

  if (state === "unauth") {
    return (
      <section
        data-testid="patient-prescriptions-unauth"
        className="space-y-4 py-6"
      >
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-base text-slate-600 dark:text-gray-300">
          Please sign in to view your prescriptions.
        </p>
        <Link
          href="/patient/login"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white"
          data-testid="patient-prescriptions-signin-cta"
        >
          Sign in
        </Link>
      </section>
    );
  }

  if (state === "error") {
    return (
      <section
        data-testid="patient-prescriptions-error"
        role="alert"
        className="rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-4 text-sm text-red-800 dark:text-red-200"
      >
        Something went wrong loading your prescriptions. Please refresh.
      </section>
    );
  }

  const isEmpty = prescriptions.length === 0;
  const hasMore = prescriptions.length < total;

  return (
    <section
      data-testid="patient-prescriptions"
      className="space-y-6 py-4"
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            My prescriptions
          </h1>
          {total > 0 ? (
            <span
              data-testid="patient-prescriptions-count"
              className="rounded-full bg-slate-100 dark:bg-gray-800 px-2 py-1 text-xs font-medium text-slate-700 dark:text-gray-200"
            >
              {total}
            </span>
          ) : null}
        </div>
      </header>

      {isEmpty ? (
        <div
          data-testid="patient-prescriptions-empty"
          className="space-y-3 rounded-lg border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 text-center shadow-sm"
        >
          <p className="text-base text-slate-700 dark:text-gray-200">
            No prescriptions yet. Your doctor will prescribe digital scripts
            here after a consult.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {prescriptions.map((rx) => (
            <PrescriptionCard
              key={rx.id}
              prescription={rx}
              onShare={shareViaWhatsApp}
              sharing={sharingRxId === rx.id}
            />
          ))}
        </ul>
      )}

      {hasMore ? (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => void fetchPage(page + 1, "append")}
            data-testid="patient-prescriptions-load-more"
            className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 dark:border-gray-600 px-6 text-sm font-medium text-slate-800 dark:text-gray-100 disabled:opacity-60"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

interface CardProps {
  prescription: PrescriptionRow;
  onShare: (rxId: string) => void | Promise<void>;
  sharing: boolean;
}

function PrescriptionCard({ prescription, onShare, sharing }: CardProps) {
  const items = prescription.items ?? [];
  const first = items[0]?.medicineName ?? "Prescription";
  const more = Math.max(0, items.length - 1);
  const doctorName = prescription.doctor?.user?.name ?? null;
  const specialty = prescription.doctor?.specialty ?? null;
  const status = prescription.status ?? null;

  // We render the Share button unconditionally now — the API's POST
  // /:id/share endpoint returns friendly 409s for unsigned /
  // cancelled / rejected rows ("Cannot share an unsigned prescription —
  // the prescribing doctor must sign it first.") which we toast
  // verbatim. The previous hide-when-not-shareable pattern left the
  // patient with no idea why share was missing.
  const verifyUrl = buildVerifyUrl(prescription.id);
  const pdfUrl = buildPdfUrl(prescription.id);

  return (
    <li
      data-testid="patient-prescriptions-row"
      data-prescription-id={prescription.id}
      className="space-y-2 rounded-lg border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <p
            data-testid="patient-prescriptions-row-date"
            className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gray-400"
          >
            {formatDate(prescription.createdAt)}
          </p>
          <p className="text-base font-semibold text-slate-900 dark:text-gray-100">
            {doctorName ? formatDoctorName(doctorName) : "Doctor"}
          </p>
          {specialty ? (
            <p className="text-sm text-slate-600 dark:text-gray-300">{specialty}</p>
          ) : null}
          <p
            data-testid="patient-prescriptions-row-items"
            className="text-sm text-slate-700 dark:text-gray-200"
          >
            {first}
            {more > 0 ? (
              <span className="text-slate-500 dark:text-gray-400"> · +{more} more</span>
            ) : null}
          </p>
          {prescription.diagnosis ? (
            <p className="text-xs text-slate-500 dark:text-gray-400">
              Diagnosis: {prescription.diagnosis}
            </p>
          ) : null}
        </div>
        {status ? (
          <span
            data-testid="patient-prescriptions-row-status"
            className={`rounded-full px-2 py-1 text-xs font-medium ${statusPillClass(
              status,
            )}`}
          >
            {status}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        <a
          href={pdfUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="patient-prescriptions-download-btn"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white"
        >
          Download PDF
        </a>
        <button
          type="button"
          onClick={() => void onShare(prescription.id)}
          disabled={sharing}
          data-testid="patient-prescriptions-share-btn"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/30 px-4 text-sm font-medium text-emerald-900 dark:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {sharing ? "Sharing…" : "Share via WhatsApp"}
        </button>
        <a
          href={verifyUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="patient-prescriptions-verify-btn"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 dark:border-gray-600 px-4 text-sm font-medium text-slate-800 dark:text-gray-100"
        >
          Verify QR
        </a>
      </div>
    </li>
  );
}
