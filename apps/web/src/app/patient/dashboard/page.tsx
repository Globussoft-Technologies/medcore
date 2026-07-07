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
import { toast } from "@/lib/toast";
import { formatDoctorName } from "@/lib/format-doctor-name";
import { HospitalQrScanner } from "@/components/HospitalQrScanner";
import { isAppointmentDayPast } from "@/lib/appointments";

interface AppointmentRow {
  id: string;
  date: string;
  slotStart?: string | null;
  tokenNumber?: number | null;
  status: string;
  branchId?: string | null;
  // Reschedule only applies to SLOT appointments; TOKEN/CALLING have no fixed
  // time. Mode may come as a scalar on the row or nested on the doctor.
  appointmentMode?: "SLOT" | "TOKEN" | "CALLING" | null;
  doctor?: {
    user?: { name?: string | null } | null;
    specialty?: string | null;
    appointmentMode?: "SLOT" | "TOKEN" | "CALLING" | null;
  } | null;
}
interface PrescriptionRow {
  id: string;
  createdAt: string;
  diagnosis?: string | null;
  // Mirror /patient/prescriptions/page.tsx: status + signatureUrl gate
  // the share button — an unsigned or cancelled prescription is not a
  // valid medical document and the share endpoint will 409 on it.
  status?: string | null;
  signatureUrl?: string | null;
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

// Same helpers as /patient/prescriptions/page.tsx — keep the URL-build
// logic local so the Recent Prescriptions tile's Download + Share
// buttons point at the right hosts:
//   • Download PDF — absolute API URL (web app is :3000, API is :4000 in
//     dev; in prod both live behind the same origin but the env var
//     resolves correctly either way).
//   • Share on WhatsApp — `${origin}/verify/rx/<id>` so the link the
//     patient sends lands on the public verify page that actually
//     exists. The previous `/verify/<id>` shape (no `/rx/` segment)
//     404'd in WhatsApp.
const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";

function buildPdfUrl(id: string): string {
  return `${API_BASE.replace(/\/$/, "")}/prescriptions/${id}/pdf?format=pdf`;
}

function buildVerifyUrl(id: string): string {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "";
  return `${origin}/verify/rx/${id}`;
}

// Mirror the share-rx server policy at routes/prescriptions.ts:871-887
// (and /patient/prescriptions/page.tsx:79) — these statuses indicate
// the prescription is not a valid medical document for sharing.
const NON_SHAREABLE_STATUSES = new Set(["CANCELLED", "REJECTED", "DRAFT"]);

type LoadState = "loading" | "ready" | "unauth" | "error";

// Pearl §6.3 row 340 — "I've arrived" date helpers. Mirror the server's
// YYYY-MM-DD comparison (Postgres @db.Date stripping — fix `502adf7`) in
// the Asia/Kolkata wallclock so the button only renders for rows the
// server would accept.
function ymdInIST(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function isTodayInIST(appointmentDate: string): boolean {
  return (appointmentDate ?? "").slice(0, 10) === ymdInIST(new Date());
}

// IST offset in minutes — clinic-local time is Asia/Kolkata (UTC+5:30).
// `Appointment.date` is the calendar day at UTC midnight; `slotStart` is
// "HH:MM(:SS)" in clinic-local IST clock time. See the matching helpers in
// apps/web/src/app/patient/appointments/page.tsx for the full background.
const IST_OFFSET_MIN = 330;

// Format an IST clock string "HH:MM(:SS)" as 12-hour ("10:45 PM") WITHOUT
// routing it through Date — the raw HH:MM IS the wall-clock time we want,
// independent of the viewer's browser timezone.
function formatSlotTime(slotStart: string | null | undefined): string {
  if (!slotStart) return "";
  const [hhRaw, mmRaw] = slotStart.split(":");
  const hh = parseInt(hhRaw ?? "", 10);
  const mm = parseInt(mmRaw ?? "", 10);
  if (!Number.isFinite(hh)) return "";
  const minute = Number.isFinite(mm) ? mm : 0;
  const period = hh >= 12 ? "PM" : "AM";
  const hour12 = ((hh + 11) % 12) + 1;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

function formatApptWhen(a: {
  date: string;
  slotStart?: string | null;
}): string {
  // Render the date in IST so a UTC-midnight Appointment.date lands as the
  // expected calendar day even for non-IST browsers.
  const dateStr = new Date(a.date).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
  const timeStr = formatSlotTime(a.slotStart);
  return timeStr ? `${dateStr} · ${timeStr}` : dateStr;
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
  // Pearl §6.3 row 340 — arrive state for the "I've arrived" placeholder
  // wire. idle → submitting → arrived (terminal); error transitions back
  // to idle and surfaces an inline message. We don't refetch on success —
  // the green pill IS the ack; the next natural nav will hydrate CHECKED_IN.
  const [arriveState, setArriveState] = useState<
    "idle" | "submitting" | "arrived"
  >("idle");
  const [arriveError, setArriveError] = useState<string | null>(null);

  // Mirror the doctor side (apps/web/src/app/dashboard/prescriptions/page.tsx
  // `shareVia` at L494): fire-and-toast. Holds the rx id currently in
  // flight so the clicked button can render "Sharing…" and disable to
  // prevent double-submit. Cleared on settle.
  const [sharingRxId, setSharingRxId] = useState<string | null>(null);

  async function shareViaWhatsApp(rxId: string): Promise<void> {
    if (sharingRxId) return;
    setSharingRxId(rxId);
    try {
      await api.post(`/prescriptions/${rxId}/share`, { channel: "WHATSAPP" });
      toast.success("Prescription shared via WhatsApp");
    } catch (err) {
      // The API's friendly 409 messages already explain the unsigned /
      // cancelled / no-phone cases — surface verbatim rather than
      // re-wording on the client. The doctor side has a Sign-before-share
      // modal for the unsigned 409, but a patient can't sign for the
      // doctor; the toast is the only action they have.
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
  }

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
        // `date` is UTC midnight of the calendar day; `slotStart` is IST
        // clock time. Subtract the IST offset so the composed instant is
        // the correct UTC timestamp for the appointment.
        const base = new Date(a.date);
        if (a.slotStart) {
          const [hh, mm] = a.slotStart.split(":").map((s) => parseInt(s, 10));
          if (Number.isFinite(hh)) {
            const ist = hh * 60 + (Number.isFinite(mm) ? mm : 0);
            return { a, ts: base.getTime() + (ist - IST_OFFSET_MIN) * 60_000 };
          }
        }
        return { a, ts: base.getTime() };
      })
      .filter((row) => {
        // SLOT appointments have a real slot time → compare the instant (with
        // 1h grace so a "currently checked-in" row still shows). TOKEN/CALLING
        // appointments have NO slot — their `date` is midnight UTC (≈5:30 AM
        // IST), which is always earlier than "now", so an instant comparison
        // wrongly hides TODAY's token appointment. For those, use a CALENDAR-
        // DAY check: keep it unless its day is strictly before today (so
        // today + future stay visible).
        if (row.a.slotStart) {
          return row.ts >= now - 60 * 60 * 1000;
        }
        return !isAppointmentDayPast(row.a.date ?? null, now);
      })
      .sort((x, y) => x.ts - y.ts);
    return upcoming[0]?.a ?? null;
  }, [appointments]);

  const handleArrive = async (appointmentId: string): Promise<void> => {
    // Pearl §6.3 row 340 — PATCH the appointment's status to CHECKED_IN.
    // Server enabler `683f460` + date-string fix `502adf7` allow PATIENT for
    // today's own BOOKED row. We render the green badge optimistically on
    // success and surface an inline error on failure (no toast lib in this
    // surface today; the same convention is used elsewhere on /patient).
    setArriveError(null);
    setArriveState("submitting");
    try {
      await api.patch(`/appointments/${appointmentId}/status`, {
        status: "CHECKED_IN",
      });
      setArriveState("arrived");
    } catch (err) {
      setArriveError(
        err instanceof Error
          ? err.message
          : "Could not notify reception. Please try again.",
      );
      setArriveState("idle");
    }
  };

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
        className="flex min-h-[40vh] items-center justify-center text-sm text-slate-500 dark:text-gray-400"
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
        <p className="text-base text-slate-600 dark:text-gray-300">
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
        className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-900/30 dark:text-red-200"
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
          className="flex flex-col gap-3 rounded-lg border border-sky-200 bg-sky-50 p-4 shadow-sm dark:border-sky-800 dark:bg-sky-900/30 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="space-y-1">
            <p className="text-sm font-semibold text-sky-900 dark:text-sky-200">
              Link your ABHA Health ID for portable medical records.
            </p>
            <p className="text-xs text-sky-800 dark:text-sky-300">
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
              className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-sky-300 bg-white px-4 text-sm font-medium text-sky-900 dark:border-sky-700 dark:bg-gray-800 dark:text-sky-200"
              data-testid="patient-abha-prompt-skip"
            >
              Skip for now
            </button>
          </div>
        </aside>
      ) : null}

      {/* At-the-hospital shortcut: scan the front-desk QR to open this
          hospital's kiosk (browse / book / self check-in). */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div>
          <p className="text-sm font-semibold text-slate-900 dark:text-gray-100">
            At the hospital?
          </p>
          <p className="text-xs text-slate-500 dark:text-gray-400">
            Scan the front-desk QR to check in or book.
          </p>
        </div>
        <HospitalQrScanner className="inline-flex h-11 min-w-[44px] items-center justify-center gap-2 rounded-md bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700" />
      </div>

      <section
        data-testid="patient-dashboard"
        className="space-y-4 sm:grid sm:grid-cols-3 sm:gap-4 sm:space-y-0"
      >
      {/* ─── Next Appointment ───────────────────────────────────────── */}
      <article
        data-testid="patient-dashboard-next-appointment"
        className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
      >
        <header className="mb-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500 dark:text-gray-400">
            Next appointment
          </h2>
        </header>
        {nextAppointment ? (
          <div className="space-y-2">
            <p className="text-base font-semibold text-slate-900 dark:text-gray-100">
              {nextAppointment.doctor?.user?.name
                ? formatDoctorName(nextAppointment.doctor.user.name)
                : "Doctor TBA"}
            </p>
            {nextAppointment.doctor?.specialty ? (
              <p className="text-sm text-slate-600 dark:text-gray-300">
                {nextAppointment.doctor.specialty}
              </p>
            ) : null}
            <p
              data-testid="patient-dashboard-next-appointment-when"
              className="text-sm text-slate-700 dark:text-gray-200"
            >
              {formatApptWhen(nextAppointment)}
            </p>
            {nextAppointment.tokenNumber ? (
              <p className="text-sm text-slate-600 dark:text-gray-300">
                Token #{nextAppointment.tokenNumber}
              </p>
            ) : null}
            <div className="flex flex-col gap-2 pt-2 sm:flex-row">
              <Link
                href={`/patient/appointments?reschedule=${nextAppointment.id}`}
                className="inline-flex h-11 min-w-[44px] flex-1 items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white"
                data-testid="patient-dashboard-next-appointment-view"
              >
                View / reschedule
              </Link>
              {arriveState === "arrived" ? (
                <span
                  data-testid="patient-dashboard-next-appointment-arrived-pill"
                  aria-live="polite"
                  className="inline-flex h-11 min-w-[44px] flex-1 items-center justify-center rounded-md bg-emerald-100 px-4 text-sm font-medium text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200"
                >
                  Arrived ✓
                </span>
              ) : nextAppointment.status === "BOOKED" &&
                isTodayInIST(nextAppointment.date) ? (
                <button
                  type="button"
                  onClick={() => void handleArrive(nextAppointment.id)}
                  disabled={arriveState === "submitting"}
                  className="inline-flex h-11 min-w-[44px] flex-1 items-center justify-center rounded-md bg-emerald-700 px-4 text-sm font-medium text-white disabled:opacity-60"
                  data-testid="patient-dashboard-next-appointment-arrived"
                >
                  {arriveState === "submitting" ? "Notifying…" : "I've arrived"}
                </button>
              ) : (
                <button
                  type="button"
                  disabled
                  className="inline-flex h-11 min-w-[44px] flex-1 items-center justify-center rounded-md border border-slate-300 dark:border-gray-600 px-4 text-sm font-medium text-slate-400 dark:text-gray-500 disabled:cursor-not-allowed"
                  data-testid="patient-dashboard-next-appointment-arrived"
                  title="Available on the day of your appointment"
                >
                  I've arrived
                </button>
              )}
            </div>
            {arriveError ? (
              <p
                role="alert"
                data-testid="patient-dashboard-arrive-error"
                className="rounded-md bg-red-50 p-2 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200"
              >
                {arriveError}
              </p>
            ) : null}
          </div>
        ) : (
          <div
            data-testid="patient-dashboard-next-appointment-empty"
            className="space-y-3"
          >
            <p className="text-sm text-slate-600 dark:text-gray-300">
              You don't have any upcoming appointments.
            </p>
            <Link
              href="/patient/book"
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
        className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
      >
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500 dark:text-gray-400">
            Recent prescriptions
          </h2>
          {prescriptions.length > 0 ? (
            <Link
              href="/patient/prescriptions"
              className="text-xs font-medium text-slate-700 dark:text-gray-200 underline-offset-2 hover:underline"
              data-testid="patient-dashboard-prescriptions-all"
            >
              See all
            </Link>
          ) : null}
        </header>
        {prescriptions.length > 0 ? (
          <ul className="divide-y divide-slate-100 dark:divide-gray-700">
            {prescriptions.map((rx) => {
              const first = rx.items?.[0]?.medicineName ?? "Prescription";
              const more = Math.max(0, (rx.items?.length ?? 0) - 1);
              return (
                <li
                  key={rx.id}
                  data-testid="patient-dashboard-prescription-row"
                  className="space-y-1 py-3 first:pt-0 last:pb-0"
                >
                  <p className="text-sm font-medium text-slate-900 dark:text-gray-100">
                    {first}
                    {more > 0 ? (
                      <span className="text-slate-500 dark:text-gray-400"> + {more} more</span>
                    ) : null}
                  </p>
                  <p className="text-xs text-slate-600 dark:text-gray-300">
                    {new Date(rx.createdAt).toLocaleDateString("en-IN", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })}
                    {rx.doctor?.user?.name
                      ? ` · ${formatDoctorName(rx.doctor.user.name)}`
                      : ""}
                  </p>
                  <div className="flex gap-2 pt-1">
                    <a
                      href={buildPdfUrl(rx.id)}
                      className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 dark:border-gray-600 px-3 text-xs font-medium text-slate-800 dark:text-gray-100"
                      data-testid="patient-dashboard-prescription-download"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Download PDF
                    </a>
                    {/* Same flow as the doctor side
                        (apps/web/src/app/dashboard/prescriptions/page.tsx
                        `shareVia` at L494): POST /prescriptions/:id/share
                        with { channel: "WHATSAPP" }. The server delivers
                        the verify link to the patient's registered phone
                        via the Meta Cloud API and logs the share. No new
                        tab to wa.me — the patient stays on the dashboard
                        and sees a toast.
                        The doctor-side branch that pops a SignaturePad on
                        a 409 "unsigned" response doesn't apply here — a
                        patient can't sign for their doctor — so we toast
                        the API's friendly message verbatim instead. */}
                    <button
                      type="button"
                      onClick={() => shareViaWhatsApp(rx.id)}
                      disabled={sharingRxId === rx.id}
                      className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 dark:border-gray-600 px-3 text-xs font-medium text-slate-800 dark:text-gray-100 disabled:cursor-not-allowed disabled:opacity-60"
                      data-testid="patient-dashboard-prescription-share"
                    >
                      {sharingRxId === rx.id ? "Sharing…" : "Share on WhatsApp"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p
            data-testid="patient-dashboard-prescriptions-empty"
            className="text-sm text-slate-600 dark:text-gray-300"
          >
            No prescriptions yet — they'll appear here after your next visit.
          </p>
        )}
      </article>

      {/* ─── Open Bills ─────────────────────────────────────────────── */}
      <article
        data-testid="patient-dashboard-bills"
        className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800"
      >
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500 dark:text-gray-400">
            Open bills
          </h2>
          {invoices.length > 0 ? (
            <Link
              href="/patient/bills"
              className="text-xs font-medium text-slate-700 dark:text-gray-200 underline-offset-2 hover:underline"
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
              className="rounded-md bg-amber-50 p-3 text-sm dark:bg-amber-900/30"
            >
              <p className="font-semibold text-amber-900 dark:text-amber-200">
                {formatINR(openBillsTotal)} outstanding
              </p>
              <p className="text-xs text-amber-800 dark:text-amber-300">
                {invoices.length} open bill{invoices.length === 1 ? "" : "s"}
              </p>
            </div>
            <ul className="divide-y divide-slate-100 dark:divide-gray-700">
              {invoices.map((inv) => {
                const due =
                  toNumber(inv.totalAmount) - toNumber(inv.paidAmount);
                // The server filter (?status=PENDING,PARTIAL) already
                // excludes PAID rows, but defend against stale state
                // (e.g. the patient paid in another tab and the
                // dashboard hasn't refetched yet, or a race between
                // status flip and the fetch): if the row is PAID or
                // has zero outstanding, swap Pay-now for View-detail
                // so the patient is never offered to pay a settled
                // bill. Matches the open vs paid split on
                // /patient/bills (line 562 there).
                const isSettled =
                  inv.paymentStatus === "PAID" || due <= 0;
                return (
                  <li
                    key={inv.id}
                    data-testid="patient-dashboard-bill-row"
                    className="space-y-1 py-3 first:pt-0 last:pb-0"
                  >
                    <p className="text-sm font-medium text-slate-900 dark:text-gray-100">
                      {inv.invoiceNumber}
                    </p>
                    <p className="text-xs text-slate-600 dark:text-gray-300">
                      {new Date(inv.createdAt).toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })}{" "}
                      · {formatINR(due)} due
                    </p>
                    {isSettled ? (
                      <Link
                        href={`/patient/bills/${inv.id}`}
                        className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 dark:border-gray-600 px-4 text-xs font-medium text-slate-800 dark:text-gray-100"
                        data-testid="patient-dashboard-bill-view"
                      >
                        View detail
                      </Link>
                    ) : (
                      <Link
                        href={`/patient/bills/${inv.id}/pay`}
                        className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-emerald-700 px-4 text-xs font-medium text-white"
                        data-testid="patient-dashboard-bill-pay"
                      >
                        Pay now
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <p
            data-testid="patient-dashboard-bills-empty"
            className="text-sm text-slate-600 dark:text-gray-300"
          >
            No open bills — you're all paid up.
          </p>
        )}
      </article>
      </section>
    </div>
  );
}
