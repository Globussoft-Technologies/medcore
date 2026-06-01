"use client";

// Patient PWA — My Appointments (Pearl §6.1 — gap #5 piece 3b of 4).
//
// Two sections:
//   • Upcoming — sorted ascending by composed date+slotStart; reschedule + cancel
//     CTAs available for rows whose status is BOOKED/CHECKED_IN.
//   • Past — collapsed by default behind a "Show past appointments" toggle;
//     sorted descending. No mutating actions.
//
// Backed by:
//   • GET   /api/v1/appointments?status=…&limit=…   — auto-scopes to the authed
//     PATIENT via the route's existing `req.user.role === "PATIENT"` branch
//     (apps/api/src/routes/appointments.ts:578).
//   • PATCH /api/v1/appointments/:id/reschedule     — { date: "YYYY-MM-DD",
//     slotStart: "HH:MM" }. Helper-gated per-row.
//   • PATCH /api/v1/appointments/:id/status         — { status: "CANCELLED" }.
//     The route accepts PATIENT for this transition only (gotcha #14 — handler
//     re-runs assertPatientOwnsResource server-side).
//
// No "reason" field is sent to the server today — neither endpoint's schema
// accepts one. We capture it in the modal anyway so future audit-richer
// schemas can pick it up without a UI change.
//
// Pearl §6.2 touch-target rule: every CTA is `h-11 min-w-[44px]`. Same shape
// as `apps/web/src/app/patient/dashboard/page.tsx` (piece 3a). Mobile-first.
//
// Share-location: opens `https://maps.google.com/?q=<branch.address>` in a
// new tab when the row carries a branch with an address. The current list
// endpoint doesn't include Branch in its `include` block (only patient +
// doctor + vitals), so this CTA is hidden unless a future server change
// hydrates it. Kept the wiring in so it lights up automatically.

import { useEffect, useState, useMemo, useCallback } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";

interface BranchLite {
  id: string;
  name?: string | null;
  address?: string | null;
}

interface AppointmentRow {
  id: string;
  date: string;
  slotStart?: string | null;
  tokenNumber?: number | null;
  status: string;
  branchId?: string | null;
  branch?: BranchLite | null;
  doctor?: {
    user?: { name?: string | null } | null;
    specialty?: string | null;
  } | null;
}

interface ApiList<T> {
  success: boolean;
  data: T[];
  error?: string | null;
  meta?: { total: number };
}

type LoadState = "loading" | "ready" | "unauth" | "error";

// Status set the patient may reschedule. CONFIRMED isn't in the enum (only
// BOOKED / CHECKED_IN / IN_CONSULTATION / COMPLETED / CANCELLED / NO_SHOW per
// packages/shared/src/validation/appointment.ts:36-43); the route's own
// reschedule branch allows BOOKED + CHECKED_IN (appointments.ts:831).
const RESCHEDULABLE_STATUSES = new Set(["BOOKED", "CHECKED_IN"]);
// Cancellable from the patient side = same row that could be rescheduled,
// PLUS any other non-terminal status the patient owns. Server gates via
// PATCH /:id/status which only refuses the action if the body status isn't
// "CANCELLED"; we hide the button for already-terminal rows to avoid the
// confusing-and-then-rejected click.
const TERMINAL_STATUSES = new Set(["COMPLETED", "CANCELLED", "NO_SHOW"]);

// Pearl §6.3 row 340 — "I've arrived" button is shown only on TODAY's BOOKED
// rows. The server (appointments.ts:PATCH /:id/status PATIENT branch, enabler
// `683f460` + date-string fix `502adf7`) compares calendar days as
// YYYY-MM-DD strings against the Asia/Kolkata wallclock — we mirror that
// here so the button never appears for a row the server would reject.
function ymdInIST(d: Date): string {
  // en-CA gives ISO-ish YYYY-MM-DD; timeZone fixes the calendar day to IST
  // regardless of the device's local timezone.
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function isTodayInIST(a: AppointmentRow): boolean {
  // Appointment.date is stored at UTC-midnight for the calendar day; the
  // string slice avoids any locale drift on the server-issued ISO date.
  const apptYmd = (a.date ?? "").slice(0, 10);
  return apptYmd === ymdInIST(new Date());
}

// IST offset in minutes — clinic-local time is Asia/Kolkata (UTC+5:30).
// The DB stores `Appointment.date` as the calendar day at UTC midnight and
// `slotStart` as "HH:MM(:SS)" in clinic-local IST clock time. To compose a
// real timestamp we add the IST clock minutes back into the UTC midnight,
// then subtract the IST offset so the result is the correct UTC instant
// for the appointment. (Previously the code did `setUTCHours(hh, mm)`
// which treated the IST clock string AS IF it were UTC — that produced a
// timestamp 5:30 hours off, which then re-converted through the browser's
// local TZ in toLocaleTimeString gave wildly wrong displayed times.)
const IST_OFFSET_MIN = 330;

function composeWhen(a: AppointmentRow): number {
  const base = new Date(a.date);
  if (a.slotStart) {
    const [hh, mm] = a.slotStart.split(":").map((s) => parseInt(s, 10));
    if (Number.isFinite(hh)) {
      const istMinutesIntoDay = hh * 60 + (Number.isFinite(mm) ? mm : 0);
      const utcMinutesIntoDay = istMinutesIntoDay - IST_OFFSET_MIN;
      return base.getTime() + utcMinutesIntoDay * 60 * 1000;
    }
  }
  return base.getTime();
}

// Format an IST clock string "HH:MM(:SS)" as a 12-hour display ("10:45 PM")
// WITHOUT routing it through Date — the raw HH:MM is already the wall-clock
// time we want to render, regardless of the viewer's browser timezone.
function formatSlotTime(slotStart: string | null | undefined): string {
  if (!slotStart) return "";
  const [hhRaw, mmRaw] = slotStart.split(":");
  const hh = parseInt(hhRaw ?? "", 10);
  const mm = parseInt(mmRaw ?? "", 10);
  if (!Number.isFinite(hh)) return "";
  const minute = Number.isFinite(mm) ? mm : 0;
  const period = hh >= 12 ? "PM" : "AM";
  const hour12 = ((hh + 11) % 12) + 1; // 0→12, 13→1, etc.
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

function formatApptWhen(a: AppointmentRow): string {
  // Date: render in IST so a UTC-midnight `Appointment.date` (e.g.
  // 2026-05-26T00:00:00Z) lands as "26 May 2026" even for non-IST browsers.
  const dateStr = new Date(a.date).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
  const timeStr = formatSlotTime(a.slotStart);
  return timeStr ? `${dateStr} · ${timeStr}` : dateStr;
}

function statusPillClass(status: string): string {
  if (status === "BOOKED") return "bg-blue-100 text-blue-900";
  if (status === "CHECKED_IN") return "bg-amber-100 text-amber-900";
  if (status === "IN_CONSULTATION") return "bg-violet-100 text-violet-900";
  if (status === "COMPLETED") return "bg-emerald-100 text-emerald-900";
  if (status === "CANCELLED") return "bg-slate-200 text-slate-700";
  if (status === "NO_SHOW") return "bg-red-100 text-red-900";
  return "bg-slate-100 text-slate-700";
}

// ─── Modal helpers ──────────────────────────────────────────────────────
//
// Tiny inline modals (no portal / no focus-trap library) — the patient
// surface is mobile-first and a fixed-inset overlay is enough. Both modals
// dismiss on backdrop click and on Esc via the keydown handler in the
// page's effect.

interface RescheduleDraft {
  appointment: AppointmentRow;
  date: string;
  slotStart: string;
  reason: string;
}

interface CancelDraft {
  appointment: AppointmentRow;
  reason: string;
}

export default function PatientAppointmentsPage() {
  const [state, setState] = useState<LoadState>("loading");
  const [appointments, setAppointments] = useState<AppointmentRow[]>([]);
  const [showPast, setShowPast] = useState(false);
  const [rescheduleDraft, setRescheduleDraft] =
    useState<RescheduleDraft | null>(null);
  const [cancelDraft, setCancelDraft] = useState<CancelDraft | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Pearl §6.3 row 340 — per-row arrive state. `arriving` disables the button
  // while the PATCH is in flight; `arrived` flips the row to the "Arrived ✓"
  // pill optimistically. We don't refetch on success — the green pill is the
  // ack — but we DO surface the new status if the next refetch lands first.
  const [arriving, setArriving] = useState<Set<string>>(new Set());
  const [arrived, setArrived] = useState<Set<string>>(new Set());
  const [arriveError, setArriveError] = useState<string | null>(null);

  const refetch = useCallback(async (): Promise<void> => {
    setState("loading");
    try {
      // Two parallel pulls so the past list isn't blocked behind the upcoming
      // list when the patient toggles "Show past". The route's default order
      // is `date desc`, which is what we want for past; we sort upcoming
      // ascending client-side after composing slotStart.
      const [upcomingRes, pastRes] = await Promise.allSettled([
        api.get<ApiList<AppointmentRow>>(
          "/appointments?status=BOOKED,CHECKED_IN,IN_CONSULTATION&limit=50",
          { skip401Redirect: true },
        ),
        api.get<ApiList<AppointmentRow>>(
          "/appointments?status=COMPLETED,CANCELLED,NO_SHOW&limit=50",
          { skip401Redirect: true },
        ),
      ]);

      const any401 = [upcomingRes, pastRes].some(
        (r) =>
          r.status === "rejected" &&
          (r.reason as { status?: number })?.status === 401,
      );
      if (any401) {
        setState("unauth");
        return;
      }

      const merged: AppointmentRow[] = [];
      if (upcomingRes.status === "fulfilled" && upcomingRes.value.success) {
        merged.push(...(upcomingRes.value.data ?? []));
      }
      if (pastRes.status === "fulfilled" && pastRes.value.success) {
        merged.push(...(pastRes.value.data ?? []));
      }

      // Dedup by id — defensive against the server returning the same row
      // in both buckets (shouldn't happen given the disjoint status filter,
      // but cheap to enforce).
      const seen = new Set<string>();
      const dedup = merged.filter((a) => {
        if (seen.has(a.id)) return false;
        seen.add(a.id);
        return true;
      });

      setAppointments(dedup);
      setState("ready");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Pearl §6.1 — entry-point from the patient dashboard "Next Appointment"
  // card. When that card's "View / reschedule" button is clicked, it
  // navigates here with `?reschedule=<appointmentId>`. We watch for that
  // param + the just-loaded appointment row and auto-open the reschedule
  // modal so the patient lands on the action they intended in one click,
  // not two. Guard with a ref-like local flag (`didAutoOpenForId`) so
  // that closing the modal doesn't immediately re-open it.
  const searchParams = useSearchParams();
  const [didAutoOpenForId, setDidAutoOpenForId] = useState<string | null>(
    null,
  );
  useEffect(() => {
    const target = searchParams?.get("reschedule");
    if (!target) return;
    if (didAutoOpenForId === target) return;
    if (state !== "ready") return;
    const match = appointments.find((a) => a.id === target);
    if (!match) return;
    setRescheduleDraft({
      appointment: match,
      date: new Date(match.date).toISOString().slice(0, 10),
      slotStart: (match.slotStart ?? "10:00").slice(0, 5),
      reason: "",
    });
    setDidAutoOpenForId(target);
  }, [searchParams, appointments, state, didAutoOpenForId]);

  // Close any open modal on Esc — small QoL nicety since the modal is
  // hand-rolled without a library.
  useEffect(() => {
    if (!rescheduleDraft && !cancelDraft) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        setRescheduleDraft(null);
        setCancelDraft(null);
        setActionError(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rescheduleDraft, cancelDraft]);

  const { upcoming, past } = useMemo(() => {
    const now = Date.now();
    const rows = appointments.map((a) => ({ a, ts: composeWhen(a) }));
    // Anything in the past + terminal-status sets land in "past"; anything
    // upcoming OR non-terminal active goes to "upcoming". We INCLUDE active
    // CHECKED_IN/IN_CONSULTATION rows in upcoming even if their slot is a
    // few minutes ago — the patient might still be in the consult room.
    const up: AppointmentRow[] = [];
    const pa: AppointmentRow[] = [];
    for (const { a, ts } of rows) {
      const isTerminal = TERMINAL_STATUSES.has(a.status);
      const isFuture = ts >= now - 60 * 60 * 1000; // grace 1h
      if (!isTerminal && isFuture) up.push(a);
      else pa.push(a);
    }
    up.sort((x, y) => composeWhen(x) - composeWhen(y));
    pa.sort((x, y) => composeWhen(y) - composeWhen(x));
    return { upcoming: up, past: pa };
  }, [appointments]);

  async function submitReschedule(): Promise<void> {
    if (!rescheduleDraft) return;
    // Pearl §3.1 (gap closed 2026-05-29) — reschedule reason is now
    // required server-side (3-500 chars). The patient reschedule form's
    // reason input was already there but unwired; wire it through and
    // validate locally so the error message is friendlier than the
    // server's generic 400.
    const reason = rescheduleDraft.reason.trim();
    if (reason.length < 3) {
      setActionError("Please enter a reason for rescheduling (min 3 characters).");
      return;
    }
    setSubmitting(true);
    setActionError(null);
    try {
      await api.patch(
        `/appointments/${rescheduleDraft.appointment.id}/reschedule`,
        {
          date: rescheduleDraft.date,
          slotStart: rescheduleDraft.slotStart,
          reason,
        },
      );
      setRescheduleDraft(null);
      await refetch();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Failed to reschedule",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function submitCancel(): Promise<void> {
    if (!cancelDraft) return;
    // Pearl §3.1 (gap closed 2026-05-29) — cancellation reason is now
    // required server-side (3-500 chars). The patient cancel form's
    // reason input was already there but unwired; now it's plumbed
    // through and validated locally before the request.
    const reason = cancelDraft.reason.trim();
    if (reason.length < 3) {
      setActionError("Please enter a cancellation reason (min 3 characters).");
      return;
    }
    setSubmitting(true);
    setActionError(null);
    try {
      await api.patch(
        `/appointments/${cancelDraft.appointment.id}/status`,
        { status: "CANCELLED", cancellationReason: reason },
      );
      setCancelDraft(null);
      await refetch();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to cancel");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitArrive(appointmentId: string): Promise<void> {
    // Pearl §6.3 row 340 — patient self-check-in. Optimistic flip: disable +
    // green pill on success, re-enable + inline error on failure. We don't
    // refetch on success because the visible "Arrived ✓" badge IS the ack;
    // the next natural reload (e.g. nav-back) will hydrate `CHECKED_IN`.
    setArriveError(null);
    setArriving((prev) => {
      const next = new Set(prev);
      next.add(appointmentId);
      return next;
    });
    try {
      await api.patch(`/appointments/${appointmentId}/status`, {
        status: "CHECKED_IN",
      });
      setArrived((prev) => {
        const next = new Set(prev);
        next.add(appointmentId);
        return next;
      });
    } catch (err) {
      setArriveError(
        err instanceof Error
          ? err.message
          : "Could not notify reception. Please try again.",
      );
    } finally {
      setArriving((prev) => {
        const next = new Set(prev);
        next.delete(appointmentId);
        return next;
      });
    }
  }

  if (state === "loading") {
    return (
      <section
        data-testid="patient-appointments-loading"
        className="flex min-h-[40vh] items-center justify-center text-sm text-slate-500"
      >
        Loading your appointments…
      </section>
    );
  }

  if (state === "unauth") {
    return (
      <section
        data-testid="patient-appointments-unauth"
        className="space-y-4 py-6"
      >
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-base text-slate-600">
          Please sign in to view your appointments.
        </p>
        <Link
          href="/patient/login"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white"
          data-testid="patient-appointments-signin-cta"
        >
          Sign in
        </Link>
      </section>
    );
  }

  if (state === "error") {
    return (
      <section
        data-testid="patient-appointments-error"
        role="alert"
        className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800"
      >
        Something went wrong loading your appointments. Please refresh.
      </section>
    );
  }

  const isEmpty = upcoming.length === 0 && past.length === 0;

  return (
    <section
      data-testid="patient-appointments"
      className="space-y-6 py-4"
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">
          My appointments
        </h1>
        <Link
          href="/patient/book"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white"
          data-testid="patient-appointments-book-cta"
        >
          Book new
        </Link>
      </header>

      {isEmpty ? (
        <div
          data-testid="patient-appointments-empty"
          className="space-y-3 rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm"
        >
          <p className="text-base text-slate-700">No appointments yet.</p>
          <Link
            href="/patient/book"
            className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white"
            data-testid="patient-appointments-empty-book-cta"
          >
            Book one
          </Link>
        </div>
      ) : (
        <>
          {/* ─── Upcoming ────────────────────────────────────────────── */}
          <section
            data-testid="patient-appointments-upcoming"
            aria-labelledby="upcoming-heading"
            className="space-y-3"
          >
            <h2
              id="upcoming-heading"
              className="text-sm font-medium uppercase tracking-wide text-slate-500"
            >
              Upcoming
            </h2>
            {upcoming.length === 0 ? (
              <p
                data-testid="patient-appointments-upcoming-empty"
                className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600"
              >
                No upcoming appointments.
              </p>
            ) : (
              <>
                <ul className="space-y-3">
                  {upcoming.map((a) => (
                    <AppointmentCard
                      key={a.id}
                      appointment={a}
                      onReschedule={() =>
                        setRescheduleDraft({
                          appointment: a,
                          date: new Date(a.date).toISOString().slice(0, 10),
                          slotStart: (a.slotStart ?? "10:00").slice(0, 5),
                          reason: "",
                        })
                      }
                      onCancel={() =>
                        setCancelDraft({ appointment: a, reason: "" })
                      }
                      onArrive={() => void submitArrive(a.id)}
                      arriving={arriving.has(a.id)}
                      arrived={arrived.has(a.id)}
                    />
                  ))}
                </ul>
                {arriveError ? (
                  <p
                    role="alert"
                    data-testid="patient-appointments-arrive-error"
                    className="rounded-md bg-red-50 p-2 text-xs text-red-800"
                  >
                    {arriveError}
                  </p>
                ) : null}
              </>
            )}
          </section>

          {/* ─── Past (collapsible) ──────────────────────────────────── */}
          {past.length > 0 ? (
            <section
              data-testid="patient-appointments-past"
              aria-labelledby="past-heading"
              className="space-y-3"
            >
              <div className="flex items-center justify-between">
                <h2
                  id="past-heading"
                  className="text-sm font-medium uppercase tracking-wide text-slate-500"
                >
                  Past
                </h2>
                <button
                  type="button"
                  onClick={() => setShowPast((v) => !v)}
                  data-testid="patient-appointments-past-toggle"
                  aria-expanded={showPast}
                  className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-800"
                >
                  {showPast ? "Hide past appointments" : "Show past appointments"}
                </button>
              </div>
              {showPast ? (
                <ul
                  data-testid="patient-appointments-past-list"
                  className="space-y-3"
                >
                  {past.map((a) => (
                    <AppointmentCard
                      key={a.id}
                      appointment={a}
                      onReschedule={null}
                      onCancel={null}
                      onArrive={null}
                      arriving={false}
                      arrived={false}
                    />
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </>
      )}

      {/* ─── Reschedule modal ────────────────────────────────────────── */}
      {rescheduleDraft ? (
        <div
          data-testid="patient-appointments-reschedule-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reschedule-title"
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-4 sm:items-center"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setRescheduleDraft(null);
              setActionError(null);
            }
          }}
        >
          <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-4 shadow-xl">
            <h3 id="reschedule-title" className="text-lg font-semibold">
              Reschedule appointment
            </h3>
            <div className="space-y-3">
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-slate-700">
                  New date
                </span>
                <input
                  type="date"
                  value={rescheduleDraft.date}
                  min={new Date().toISOString().slice(0, 10)}
                  onChange={(e) =>
                    setRescheduleDraft({
                      ...rescheduleDraft,
                      date: e.target.value,
                    })
                  }
                  data-testid="patient-appointments-reschedule-date"
                  className="block h-11 w-full rounded-md border border-slate-300 px-3 text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-slate-700">
                  New time
                </span>
                <input
                  type="time"
                  value={rescheduleDraft.slotStart}
                  onChange={(e) =>
                    setRescheduleDraft({
                      ...rescheduleDraft,
                      slotStart: e.target.value,
                    })
                  }
                  data-testid="patient-appointments-reschedule-time"
                  className="block h-11 w-full rounded-md border border-slate-300 px-3 text-sm"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block font-medium text-slate-700">
                  Reason <span className="text-red-600">*</span>
                </span>
                <textarea
                  value={rescheduleDraft.reason}
                  onChange={(e) =>
                    setRescheduleDraft({
                      ...rescheduleDraft,
                      reason: e.target.value,
                    })
                  }
                  rows={2}
                  maxLength={500}
                  placeholder="e.g. Schedule conflict; need a different time"
                  data-testid="patient-appointments-reschedule-reason"
                  className="block w-full rounded-md border border-slate-300 p-2 text-sm"
                />
              </label>
            </div>
            {actionError ? (
              <p
                role="alert"
                data-testid="patient-appointments-action-error"
                className="rounded-md bg-red-50 p-2 text-xs text-red-800"
              >
                {actionError}
              </p>
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => {
                  setRescheduleDraft(null);
                  setActionError(null);
                }}
                className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-800"
                data-testid="patient-appointments-reschedule-cancel-btn"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void submitReschedule()}
                className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white disabled:opacity-60"
                data-testid="patient-appointments-reschedule-submit"
              >
                {submitting ? "Saving…" : "Confirm reschedule"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ─── Cancel modal ────────────────────────────────────────────── */}
      {cancelDraft ? (
        <div
          data-testid="patient-appointments-cancel-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-title"
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 p-4 sm:items-center"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setCancelDraft(null);
              setActionError(null);
            }
          }}
        >
          <div className="w-full max-w-md space-y-4 rounded-lg bg-white p-4 shadow-xl">
            <h3 id="cancel-title" className="text-lg font-semibold">
              Cancel appointment
            </h3>
            <p className="text-sm text-slate-700">
              Are you sure you want to cancel this appointment?
            </p>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-slate-700">
                Reason <span className="text-red-600">*</span>
              </span>
              <textarea
                value={cancelDraft.reason}
                onChange={(e) =>
                  setCancelDraft({ ...cancelDraft, reason: e.target.value })
                }
                rows={2}
                maxLength={500}
                placeholder="e.g. Schedule conflict; feeling better"
                data-testid="patient-appointments-cancel-reason"
                className="block w-full rounded-md border border-slate-300 p-2 text-sm"
              />
              <span className="mt-1 block text-xs text-slate-500">
                {cancelDraft.reason.trim().length} / 500 characters (min 3)
              </span>
            </label>
            {actionError ? (
              <p
                role="alert"
                data-testid="patient-appointments-action-error"
                className="rounded-md bg-red-50 p-2 text-xs text-red-800"
              >
                {actionError}
              </p>
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => {
                  setCancelDraft(null);
                  setActionError(null);
                }}
                className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-800"
                data-testid="patient-appointments-cancel-keep-btn"
              >
                Keep appointment
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void submitCancel()}
                className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-red-700 px-4 text-sm font-medium text-white disabled:opacity-60"
                data-testid="patient-appointments-cancel-submit"
              >
                {submitting ? "Cancelling…" : "Confirm cancel"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface CardProps {
  appointment: AppointmentRow;
  onReschedule: (() => void) | null;
  onCancel: (() => void) | null;
  onArrive: (() => void) | null;
  arriving: boolean;
  arrived: boolean;
}

function AppointmentCard({
  appointment,
  onReschedule,
  onCancel,
  onArrive,
  arriving,
  arrived,
}: CardProps) {
  const when = formatApptWhen(appointment);
  const canReschedule =
    !!onReschedule &&
    RESCHEDULABLE_STATUSES.has(appointment.status) &&
    composeWhen(appointment) >= Date.now() - 60 * 60 * 1000;
  const canCancel =
    !!onCancel && !TERMINAL_STATUSES.has(appointment.status);
  // Pearl §6.3 row 340 — the button is visible iff (a) we have a handler,
  // (b) the row is TODAY in IST (mirrors server gate at routes/appointments.ts
  // PATCH /:id/status PATIENT branch), and (c) the live status is still
  // BOOKED. Once the optimistic `arrived` flips on we render the pill
  // instead. Past + future + non-BOOKED rows never show the button — server
  // would 403 and the UI should never tempt the click.
  const canArrive =
    !!onArrive &&
    appointment.status === "BOOKED" &&
    isTodayInIST(appointment);
  const shareUrl = appointment.branch?.address
    ? `https://maps.google.com/?q=${encodeURIComponent(appointment.branch.address)}`
    : null;

  return (
    <li
      data-testid="patient-appointments-row"
      data-appointment-id={appointment.id}
      className="space-y-2 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <p className="text-base font-semibold text-slate-900">
            {appointment.doctor?.user?.name
              ? `Dr. ${appointment.doctor.user.name}`
              : "Doctor TBA"}
          </p>
          {appointment.doctor?.specialty ? (
            <p className="text-sm text-slate-600">
              {appointment.doctor.specialty}
            </p>
          ) : null}
          <p
            data-testid="patient-appointments-row-when"
            className="text-sm text-slate-700"
          >
            {when}
          </p>
          {appointment.tokenNumber ? (
            <p className="text-xs text-slate-600">
              Token #{appointment.tokenNumber}
            </p>
          ) : null}
          {appointment.branch?.name ? (
            <p className="text-xs text-slate-600">
              {appointment.branch.name}
            </p>
          ) : null}
        </div>
        <span
          data-testid="patient-appointments-row-status"
          className={`rounded-full px-2 py-1 text-xs font-medium ${statusPillClass(
            appointment.status,
          )}`}
        >
          {appointment.status}
        </span>
      </div>

      {(canReschedule || canCancel || canArrive || arrived || shareUrl) ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {arrived ? (
            <span
              data-testid={`patient-arrived-pill-${appointment.id}`}
              className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-emerald-100 px-4 text-sm font-medium text-emerald-900"
              aria-live="polite"
            >
              Arrived ✓
            </span>
          ) : canArrive ? (
            <button
              type="button"
              onClick={onArrive ?? undefined}
              disabled={arriving}
              data-testid={`patient-arrive-${appointment.id}`}
              className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-emerald-700 px-4 text-sm font-medium text-white disabled:opacity-60"
            >
              {arriving ? "Notifying…" : "I've arrived"}
            </button>
          ) : null}
          {canReschedule ? (
            <button
              type="button"
              onClick={onReschedule ?? undefined}
              data-testid="patient-appointments-reschedule-btn"
              className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white"
            >
              Reschedule
            </button>
          ) : null}
          {canCancel ? (
            <button
              type="button"
              onClick={onCancel ?? undefined}
              data-testid="patient-appointments-cancel-btn"
              className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-red-300 px-4 text-sm font-medium text-red-800"
            >
              Cancel
            </button>
          ) : null}
          {shareUrl ? (
            <a
              href={shareUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="patient-appointments-share-location"
              className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-800"
            >
              Share location
            </a>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
