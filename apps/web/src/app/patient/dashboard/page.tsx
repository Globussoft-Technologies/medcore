"use client";

// Patient PWA dashboard (Pearl §6.1 — gap #5 piece 3a of 4 + Pearl §5.3 row 147).
//
// Three tiles, all read-only, stacked on mobile and 3-up from sm: breakpoint.
// Reads existing patient-scoped endpoints (no new server surface this tick —
// each of /appointments, /prescriptions, /billing/invoices already
// self-scopes when req.user.role === "PATIENT"):
//   1. Next appointment   → GET /appointments?status=BOOKED,CHECKED_IN,IN_CONSULTATION
//                           orderBy {date desc} but we pick the soonest future
//                           one client-side (the list endpoint sorts desc and
//                           doesn't expose an `?orderDir=asc` knob today).
//   2. Recent prescriptions (top 3)  → GET /prescriptions?limit=3
//   3. Open bills                    → GET /billing/invoices?status=PENDING,PARTIAL&limit=3
//
// Every CTA is h-11 (44px) per Pearl §6.2 touch-target rule. Empty states
// render a single CTA pointing at the relevant book/list page — those pages
// land in later 3b-3i pieces and currently 404; the dashboard itself ships
// here so the post-login bounce target is real.
//
// Auth: the patient JWT cookie set by /api/v1/patient-auth/otp-verify
// (piece 2) travels automatically through the `api` wrapper's
// `credentials: "include"`. A 401 surfaces via the wrapper's central
// `handleAuthExpired` toast + redirect; this page also detects it locally
// so we can render a "Please sign in" inline state in case the toast is
// missed (e.g. SW-cached navigation from offline).

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { api } from "@/lib/api";

interface AppointmentRow {
  id: string;
  date: string;
  slotStart?: string | null;
  tokenNumber?: number | null;
  status: string;
  branchId?: string | null;
  doctor?: {
    user?: { name?: string | null } | null;
    specialty?: string | null;
  } | null;
}
interface PrescriptionRow {
  id: string;
  createdAt: string;
  diagnosis?: string | null;
  doctor?: { user?: { name?: string | null } | null } | null;
  items?: Array<{ medicineName?: string | null }> | null;
}
interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  createdAt: string;
  totalAmount: number | string;
  paidAmount?: number | string | null;
  paymentStatus: string;
}

interface ApiList<T> {
  success: boolean;
  data: T[];
  error?: string | null;
  meta?: { total: number };
}

// Pearl §5.3 row 147: optional ABHA link CTA on first login.
// The /auth/me probe returns `patient: { abhaId: string | null }` nested under
// the user row (see apps/api/src/routes/auth.ts ~L1118 — `patient: true`).
interface MeResponse {
  success: boolean;
  data: {
    id: string;
    role?: string | null;
    patient?: { abhaId?: string | null } | null;
  } | null;
  error?: string | null;
}

const ABHA_PROMPT_DISMISS_KEY = "medcore_abha_prompt_dismissed";

type LoadState = "loading" | "ready" | "unauth" | "error";

function formatDateTime(d: Date): string {
  // 22 May 2026 · 10:30 AM (locale-agnostic enough for the PWA; date-fns
  // would be cleaner but the dashboard isn't worth pulling it in for).
  const date = d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return `${date} · ${time}`;
}

function formatINR(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export default function PatientDashboardPage() {
  const [state, setState] = useState<LoadState>("loading");
  const [appointments, setAppointments] = useState<AppointmentRow[]>([]);
  const [prescriptions, setPrescriptions] = useState<PrescriptionRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  // Pearl §5.3 row 147 — ABHA-link prompt visibility. Banner shows when the
  // authed PATIENT has no linked ABHA id AND hasn't dismissed the prompt this
  // browser. Dismissal persists via `localStorage.medcore_abha_prompt_dismissed`
  // so the prompt is genuinely "one-time per device" rather than nagging on
  // every dashboard mount.
  const [abhaPromptVisible, setAbhaPromptVisible] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const [apptRes, rxRes, invRes, meRes] = await Promise.allSettled([
          // Pull a small window of active appointments — the patient
          // role-scope happens server-side. We over-fetch slightly (20) so
          // the soonest-future pick has a real chance to land even when
          // the patient has recent past + future rows in the same window.
          api.get<ApiList<AppointmentRow>>(
            "/appointments?status=BOOKED,CHECKED_IN,IN_CONSULTATION&limit=20",
            { skip401Redirect: true },
          ),
          api.get<ApiList<PrescriptionRow>>("/prescriptions?limit=3", {
            skip401Redirect: true,
          }),
          api.get<ApiList<InvoiceRow>>(
            "/billing/invoices?status=PENDING,PARTIAL&limit=3",
            { skip401Redirect: true },
          ),
          // Pearl §5.3 row 147 — pull /auth/me so we can decide whether to
          // surface the first-login ABHA prompt. Failure here is non-fatal:
          // the dashboard still renders without the banner.
          api.get<MeResponse>("/auth/me", { skip401Redirect: true }),
        ]);
        if (cancelled) return;

        // If any single call returned 401, the user isn't signed in.
        const any401 = [apptRes, rxRes, invRes].some(
          (r) =>
            r.status === "rejected" &&
            (r.reason as { status?: number })?.status === 401,
        );
        if (any401) {
          setState("unauth");
          return;
        }

        const apptList =
          apptRes.status === "fulfilled" && apptRes.value.success
            ? apptRes.value.data ?? []
            : [];
        const rxList =
          rxRes.status === "fulfilled" && rxRes.value.success
            ? rxRes.value.data ?? []
            : [];
        const invList =
          invRes.status === "fulfilled" && invRes.value.success
            ? invRes.value.data ?? []
            : [];

        setAppointments(apptList);
        setPrescriptions(rxList);
        setInvoices(invList);

        // Pearl §5.3 row 147 — decide ABHA-prompt visibility AFTER the
        // payloads land so a slow /auth/me doesn't delay the rest of the
        // dashboard render. Three conditions, all required:
        //   1. /auth/me succeeded AND the row is a PATIENT
        //   2. user.patient.abhaId is null/empty
        //   3. no prior dismissal in localStorage
        let showAbhaPrompt = false;
        if (meRes.status === "fulfilled" && meRes.value.success) {
          const u = meRes.value.data;
          const isPatient = u?.role === "PATIENT";
          const noAbha = !u?.patient?.abhaId;
          let dismissed = false;
          try {
            dismissed =
              typeof window !== "undefined" &&
              window.localStorage?.getItem(ABHA_PROMPT_DISMISS_KEY) === "1";
          } catch {
            // localStorage may throw under private-browsing / SSR. Treat as
            // not-dismissed — the user can dismiss again in this session.
            dismissed = false;
          }
          showAbhaPrompt = Boolean(isPatient && noAbha && !dismissed);
        }
        setAbhaPromptVisible(showAbhaPrompt);

        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const nextAppointment = useMemo<AppointmentRow | null>(() => {
    const now = Date.now();
    const upcoming = appointments
      .map((a) => {
        // The list endpoint stores `date` as the calendar day (UTC) and
        // `slotStart` as HH:MM:SS. Compose them for the sort; fall back
        // to date-only when slotStart is null (CALLING / WALK_IN rows).
        const base = new Date(a.date);
        if (a.slotStart) {
          const [hh, mm] = a.slotStart.split(":").map((s) => parseInt(s, 10));
          if (Number.isFinite(hh)) base.setUTCHours(hh, mm || 0, 0, 0);
        }
        return { a, ts: base.getTime() };
      })
      .filter((row) => row.ts >= now - 60 * 60 * 1000) // include rows up to 1h past so "currently checked in" still shows
      .sort((x, y) => x.ts - y.ts);
    return upcoming[0]?.a ?? null;
  }, [appointments]);

  const dismissAbhaPrompt = (): void => {
    try {
      window.localStorage?.setItem(ABHA_PROMPT_DISMISS_KEY, "1");
    } catch {
      // localStorage write may throw (quota / private mode). The session-
      // level hide still works because we toggle React state too.
    }
    setAbhaPromptVisible(false);
  };

  const openBillsTotal = useMemo(
    () =>
      invoices.reduce(
        (sum, inv) => sum + (toNumber(inv.totalAmount) - toNumber(inv.paidAmount)),
        0,
      ),
    [invoices],
  );

  if (state === "loading") {
    return (
      <section
        data-testid="patient-dashboard-loading"
        className="flex min-h-[40vh] items-center justify-center text-sm text-slate-500"
      >
        Loading your portal…
      </section>
    );
  }

  if (state === "unauth") {
    return (
      <section
        data-testid="patient-dashboard-unauth"
        className="space-y-4 py-6"
      >
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-base text-slate-600">
          Please sign in to view your appointments, prescriptions, and bills.
        </p>
        <Link
          href="/patient/login"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white"
          data-testid="patient-dashboard-signin-cta"
        >
          Sign in
        </Link>
      </section>
    );
  }

  if (state === "error") {
    return (
      <section
        data-testid="patient-dashboard-error"
        role="alert"
        className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800"
      >
        Something went wrong loading your dashboard. Please refresh.
      </section>
    );
  }

  return (
    <div className="space-y-4 py-4">
      {/* ─── Pearl §5.3 row 147 — Optional ABHA link prompt ─────────── */}
      {abhaPromptVisible ? (
        <aside
          data-testid="patient-abha-prompt-banner"
          role="region"
          aria-label="Link your ABHA Health ID"
          className="flex flex-col gap-3 rounded-lg border border-sky-200 bg-sky-50 p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="space-y-1">
            <p className="text-sm font-semibold text-sky-900">
              Link your ABHA Health ID for portable medical records.
            </p>
            <p className="text-xs text-sky-800">
              Skip for now if you don't have one — you can link it any time
              from your profile.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Link
              href="/patient/profile?section=abha"
              className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-sky-700 px-4 text-sm font-medium text-white"
              data-testid="patient-abha-prompt-link"
            >
              Link ABHA
            </Link>
            <button
              type="button"
              onClick={dismissAbhaPrompt}
              className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-sky-300 bg-white px-4 text-sm font-medium text-sky-900"
              data-testid="patient-abha-prompt-skip"
            >
              Skip for now
            </button>
          </div>
        </aside>
      ) : null}

      <section
        data-testid="patient-dashboard"
        className="space-y-4 sm:grid sm:grid-cols-3 sm:gap-4 sm:space-y-0"
      >
      {/* ─── Next Appointment ───────────────────────────────────────── */}
      <article
        data-testid="patient-dashboard-next-appointment"
        className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      >
        <header className="mb-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
            Next appointment
          </h2>
        </header>
        {nextAppointment ? (
          <div className="space-y-2">
            <p className="text-base font-semibold text-slate-900">
              {nextAppointment.doctor?.user?.name
                ? `Dr. ${nextAppointment.doctor.user.name}`
                : "Doctor TBA"}
            </p>
            {nextAppointment.doctor?.specialty ? (
              <p className="text-sm text-slate-600">
                {nextAppointment.doctor.specialty}
              </p>
            ) : null}
            <p
              data-testid="patient-dashboard-next-appointment-when"
              className="text-sm text-slate-700"
            >
              {formatDateTime(
                (() => {
                  const d = new Date(nextAppointment.date);
                  if (nextAppointment.slotStart) {
                    const [hh, mm] = nextAppointment.slotStart
                      .split(":")
                      .map((s) => parseInt(s, 10));
                    if (Number.isFinite(hh)) d.setUTCHours(hh, mm || 0, 0, 0);
                  }
                  return d;
                })(),
              )}
            </p>
            {nextAppointment.tokenNumber ? (
              <p className="text-sm text-slate-600">
                Token #{nextAppointment.tokenNumber}
              </p>
            ) : null}
            <div className="flex flex-col gap-2 pt-2 sm:flex-row">
              <Link
                href={`/patient/appointments/${nextAppointment.id}`}
                className="inline-flex h-11 min-w-[44px] flex-1 items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white"
                data-testid="patient-dashboard-next-appointment-view"
              >
                View / reschedule
              </Link>
              <button
                type="button"
                className="inline-flex h-11 min-w-[44px] flex-1 items-center justify-center rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-800"
                data-testid="patient-dashboard-next-appointment-arrived"
                title="Notify reception (coming soon)"
              >
                I've arrived
              </button>
            </div>
          </div>
        ) : (
          <div
            data-testid="patient-dashboard-next-appointment-empty"
            className="space-y-3"
          >
            <p className="text-sm text-slate-600">
              You don't have any upcoming appointments.
            </p>
            <Link
              href="/patient/appointments/book"
              className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white"
              data-testid="patient-dashboard-book-cta"
            >
              Book an appointment
            </Link>
          </div>
        )}
      </article>

      {/* ─── Recent Prescriptions ───────────────────────────────────── */}
      <article
        data-testid="patient-dashboard-prescriptions"
        className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      >
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
            Recent prescriptions
          </h2>
          {prescriptions.length > 0 ? (
            <Link
              href="/patient/prescriptions"
              className="text-xs font-medium text-slate-700 underline-offset-2 hover:underline"
              data-testid="patient-dashboard-prescriptions-all"
            >
              See all
            </Link>
          ) : null}
        </header>
        {prescriptions.length > 0 ? (
          <ul className="divide-y divide-slate-100">
            {prescriptions.map((rx) => {
              const first = rx.items?.[0]?.medicineName ?? "Prescription";
              const more = Math.max(0, (rx.items?.length ?? 0) - 1);
              return (
                <li
                  key={rx.id}
                  data-testid="patient-dashboard-prescription-row"
                  className="space-y-1 py-3 first:pt-0 last:pb-0"
                >
                  <p className="text-sm font-medium text-slate-900">
                    {first}
                    {more > 0 ? (
                      <span className="text-slate-500"> + {more} more</span>
                    ) : null}
                  </p>
                  <p className="text-xs text-slate-600">
                    {new Date(rx.createdAt).toLocaleDateString("en-IN", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })}
                    {rx.doctor?.user?.name
                      ? ` · Dr. ${rx.doctor.user.name}`
                      : ""}
                  </p>
                  <div className="flex gap-2 pt-1">
                    <Link
                      href={`/api/v1/prescriptions/${rx.id}/pdf`}
                      className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-800"
                      data-testid="patient-dashboard-prescription-download"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Download PDF
                    </Link>
                    <a
                      href={`https://wa.me/?text=${encodeURIComponent(
                        `My MedCore prescription: ${typeof window !== "undefined" ? window.location.origin : ""}/verify/${rx.id}`,
                      )}`}
                      className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-800"
                      data-testid="patient-dashboard-prescription-share"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Share on WhatsApp
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p
            data-testid="patient-dashboard-prescriptions-empty"
            className="text-sm text-slate-600"
          >
            No prescriptions yet — they'll appear here after your next visit.
          </p>
        )}
      </article>

      {/* ─── Open Bills ─────────────────────────────────────────────── */}
      <article
        data-testid="patient-dashboard-bills"
        className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      >
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
            Open bills
          </h2>
          {invoices.length > 0 ? (
            <Link
              href="/patient/bills"
              className="text-xs font-medium text-slate-700 underline-offset-2 hover:underline"
              data-testid="patient-dashboard-bills-all"
            >
              See all
            </Link>
          ) : null}
        </header>
        {invoices.length > 0 ? (
          <div className="space-y-3">
            <div
              data-testid="patient-dashboard-bills-total"
              className="rounded-md bg-amber-50 p-3 text-sm"
            >
              <p className="font-semibold text-amber-900">
                {formatINR(openBillsTotal)} outstanding
              </p>
              <p className="text-xs text-amber-800">
                {invoices.length} open bill{invoices.length === 1 ? "" : "s"}
              </p>
            </div>
            <ul className="divide-y divide-slate-100">
              {invoices.map((inv) => {
                const due =
                  toNumber(inv.totalAmount) - toNumber(inv.paidAmount);
                return (
                  <li
                    key={inv.id}
                    data-testid="patient-dashboard-bill-row"
                    className="space-y-1 py-3 first:pt-0 last:pb-0"
                  >
                    <p className="text-sm font-medium text-slate-900">
                      {inv.invoiceNumber}
                    </p>
                    <p className="text-xs text-slate-600">
                      {new Date(inv.createdAt).toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })}{" "}
                      · {formatINR(due)} due
                    </p>
                    <Link
                      href={`/patient/bills/${inv.id}/pay`}
                      className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-emerald-700 px-4 text-xs font-medium text-white"
                      data-testid="patient-dashboard-bill-pay"
                    >
                      Pay now
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <p
            data-testid="patient-dashboard-bills-empty"
            className="text-sm text-slate-600"
          >
            No open bills — you're all paid up.
          </p>
        )}
      </article>
      </section>
    </div>
  );
}
