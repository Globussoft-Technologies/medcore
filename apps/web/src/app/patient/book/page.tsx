"use client";

// Patient PWA — Book Appointment (Pearl §6.1 — gap row 161).
//
// 3-step channel-aware flow:
//   1. Pick doctor       — list of doctors with mode badge (TOKEN / SLOT / CALLING)
//                          read from GET /api/v1/doctors. PATIENT role sees
//                          only id + name + isActive of the embedded user
//                          (PII-shaped — see doctors.ts:42-49 #511 audit). The
//                          row's mode badge drives the next step's shape.
//   2. Pick date + mode-specific input:
//        • SLOT mode    — fetch GET /doctors/:id/slots?date=YYYY-MM-DD and
//                         render an availability grid; patient picks an HH:MM.
//        • TOKEN mode   — date-only pick + a preview of "you'll be issued
//                         a token at booking time" (server mints it via
//                         getNextToken at POST /book time; we cannot pre-
//                         reserve a specific token number because the API
//                         schema doesn't accept `tokenNumber` on /book —
//                         see bookAppointmentSchema in
//                         packages/shared/src/validation/appointment.ts:26-38).
//        • CALLING mode — date-only pick + "you'll be added to the live
//                         queue and called in order" hint. The API mints
//                         `arrivalSeq` at create time; no slot, no token,
//                         no ETA window in the current /book schema.
//   3. Confirm            — summary + POST /api/v1/appointments/book.
//
// On success → redirect to /patient/appointments (which lists the new row).
//
// Scope-cuts (deliberate, called out in the gap-doc closure annotation):
//   • TOKEN mode does NOT let the patient pick a specific token ahead of
//     time. The current `/book` API mints `tokenNumber` server-side via
//     getNextToken(doctorId, date) (appointments.ts:307-309); the
//     bookAppointmentSchema accepts no `tokenNumber` field. Patient sees
//     the displayToken in the success page (returned in POST /book
//     response.data.displayToken at appointments.ts:389-396).
//   • CALLING mode does NOT let the patient pick a specific ETA window.
//     bookAppointmentSchema accepts no `etaWindowStart` / `etaWindowEnd`
//     fields. The server-side queue surface (queue.ts) tracks
//     `arrivalSeq` instead. Adding ETA windows is a Stage-2 schema
//     change (the bookAppointmentSchema is referenced by every booking
//     channel including reception/walkin) and out of scope for this
//     tick — we don't touch the API in this PR.
//
// PatientId resolution: GET /auth/me carries `data.patient.id` for the
// authed PATIENT user (auth.ts:1095-1126 includes the full patient
// relation). We resolve it once on mount and use it in the POST body.
//
// Auth: the patient JWT cookie set by /api/v1/patient-auth/otp-verify
// travels automatically through the `api` wrapper's `credentials: "include"`.
// A 401 surfaces via the wrapper's central handleAuthExpired toast + redirect;
// we also detect it locally so we can render an inline sign-in nudge.
//
// Mobile-first: every CTA is `h-11 min-w-[44px]` per Pearl §6.2.

import { useEffect, useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";

type AppointmentMode = "TOKEN" | "SLOT" | "CALLING";

interface DoctorRow {
  id: string;
  specialty?: string | null;
  appointmentMode?: AppointmentMode | null;
  tokenPrefix?: string | null;
  user?: { id?: string; name?: string | null; isActive?: boolean | null } | null;
}

interface SlotRow {
  startTime: string;
  endTime: string;
  isAvailable: boolean;
}

interface ApiList<T> {
  success: boolean;
  data: T[];
  error?: string | null;
  meta?: { total: number };
}

interface ApiOne<T> {
  success: boolean;
  data: T;
  error?: string | null;
}

interface SlotsPayload {
  date: string;
  slots: SlotRow[];
  blocked?: boolean;
  reason?: string | null;
}

interface MeResponse {
  success: boolean;
  data: {
    id: string;
    role?: string | null;
    patient?: { id?: string | null } | null;
  } | null;
  error?: string | null;
}

interface BookResponse {
  success: boolean;
  data: {
    id: string;
    tokenNumber?: number | null;
    arrivalSeq?: number | null;
    slotStart?: string | null;
    displayToken?: string | null;
  } | null;
  error?: string | null;
}

type LoadState = "loading" | "ready" | "unauth" | "error";
type Step = "pick-doctor" | "pick-date" | "confirm";

function todayYmd(): string {
  // YYYY-MM-DD in the user's local calendar — matches the booking schema's
  // local-day refinement (isBookingDateNotPast in appointment.ts).
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function modeBadge(mode: AppointmentMode | null | undefined): string {
  if (mode === "TOKEN") return "Token";
  if (mode === "SLOT") return "Slot";
  if (mode === "CALLING") return "Calling";
  return "Token"; // schema default
}

function modeBadgeClass(mode: AppointmentMode | null | undefined): string {
  if (mode === "SLOT") return "bg-violet-100 dark:bg-violet-900/40 text-violet-900 dark:text-violet-200";
  if (mode === "CALLING") return "bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-200";
  return "bg-blue-100 dark:bg-blue-900/40 text-blue-900 dark:text-blue-200"; // TOKEN + default
}

export default function PatientBookAppointmentPage() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>("loading");
  const [doctors, setDoctors] = useState<DoctorRow[]>([]);
  const [patientId, setPatientId] = useState<string | null>(null);

  const [step, setStep] = useState<Step>("pick-doctor");
  const [selectedDoctor, setSelectedDoctor] = useState<DoctorRow | null>(null);
  const [date, setDate] = useState<string>(todayYmd());
  const [slots, setSlots] = useState<SlotRow[]>([]);
  const [slotsLoading, setSlotsLoading] = useState<boolean>(false);
  const [slotsBlocked, setSlotsBlocked] = useState<{
    blocked: boolean;
    reason?: string | null;
  }>({ blocked: false });
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Initial load — doctor list + patientId resolution.
  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const [docsRes, meRes] = await Promise.allSettled([
          api.get<ApiList<DoctorRow>>("/doctors", { skip401Redirect: true }),
          api.get<MeResponse>("/auth/me", { skip401Redirect: true }),
        ]);
        if (cancelled) return;

        const any401 = [docsRes, meRes].some(
          (r) =>
            r.status === "rejected" &&
            (r.reason as { status?: number })?.status === 401,
        );
        if (any401) {
          setState("unauth");
          return;
        }

        const docsList =
          docsRes.status === "fulfilled" && docsRes.value.success
            ? docsRes.value.data ?? []
            : [];
        // Hide inactive doctors from the booking surface — patient never
        // needs to pick a doctor who can't accept appointments today.
        const active = docsList.filter(
          (d) => d.user?.isActive !== false,
        );
        setDoctors(active);

        if (meRes.status === "fulfilled" && meRes.value.success) {
          const pid = meRes.value.data?.patient?.id ?? null;
          setPatientId(pid);
        }
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

  // When the date or selected doctor changes AND the doctor is SLOT-mode,
  // refetch the availability grid. TOKEN and CALLING modes don't need
  // per-date data — the server mints token / arrivalSeq at create time
  // and the bookAppointmentSchema accepts no per-slot information.
  const fetchSlots = useCallback(
    async (doctorId: string, ymd: string): Promise<void> => {
      setSlotsLoading(true);
      setSlots([]);
      setSlotsBlocked({ blocked: false });
      setSelectedSlot(null);
      try {
        const res = await api.get<ApiOne<SlotsPayload>>(
          `/doctors/${doctorId}/slots?date=${encodeURIComponent(ymd)}`,
        );
        if (res.success && res.data) {
          setSlots(res.data.slots ?? []);
          if (res.data.blocked) {
            setSlotsBlocked({
              blocked: true,
              reason: res.data.reason ?? "Doctor unavailable on this date",
            });
          }
        }
      } catch {
        // Network / 4xx — render an inline retry hint instead of bouncing
        // the whole page through the error surface.
        setSlots([]);
        setSlotsBlocked({
          blocked: true,
          reason: "Could not load slots. Please try a different date.",
        });
      } finally {
        setSlotsLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (
      step === "pick-date" &&
      selectedDoctor &&
      selectedDoctor.appointmentMode === "SLOT"
    ) {
      void fetchSlots(selectedDoctor.id, date);
    }
  }, [step, selectedDoctor, date, fetchSlots]);

  const canConfirm = useMemo<boolean>(() => {
    if (!selectedDoctor || !patientId) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    if (selectedDoctor.appointmentMode === "SLOT") {
      return !!selectedSlot;
    }
    // TOKEN + CALLING: date alone is enough — server mints the rest.
    return true;
  }, [selectedDoctor, patientId, date, selectedSlot]);

  async function handleSubmit(): Promise<void> {
    if (!selectedDoctor || !patientId) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        patientId,
        doctorId: selectedDoctor.id,
        date,
      };
      // Only SLOT mode carries the HH:MM slotId — TOKEN omits it (server
      // mints the token), CALLING ignores it server-side anyway.
      if (selectedDoctor.appointmentMode === "SLOT" && selectedSlot) {
        body.slotId = selectedSlot;
      }
      await api.post<BookResponse>("/appointments/book", body);
      // Success — bounce to the appointments list (the new row will appear
      // there with its server-minted token/arrivalSeq/slotStart).
      router.push("/patient/appointments");
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : "Could not book appointment. Please try again.",
      );
      setSubmitting(false);
    }
  }

  if (state === "loading") {
    return (
      <section
        data-testid="pwa-book-loading"
        aria-busy="true"
        className="flex min-h-[40vh] items-center justify-center text-sm text-slate-500 dark:text-gray-400"
      >
        Loading…
      </section>
    );
  }

  if (state === "unauth") {
    return (
      <section
        data-testid="pwa-book-unauth"
        className="space-y-4 py-6"
      >
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-base text-slate-600 dark:text-gray-300">
          Please sign in to book an appointment.
        </p>
        <Link
          href="/patient/login"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white"
          data-testid="pwa-book-signin-cta"
        >
          Sign in
        </Link>
      </section>
    );
  }

  if (state === "error") {
    return (
      <section
        data-testid="pwa-book-error"
        role="alert"
        className="rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-4 text-sm text-red-800 dark:text-red-200"
      >
        Something went wrong loading the booking page. Please refresh.
      </section>
    );
  }

  return (
    <section data-testid="pwa-book" className="space-y-6 py-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Book an appointment
        </h1>
        <p className="text-sm text-slate-600 dark:text-gray-300">
          {step === "pick-doctor"
            ? "Step 1 of 3 — pick your doctor"
            : step === "pick-date"
              ? "Step 2 of 3 — pick your date"
              : "Step 3 of 3 — confirm"}
        </p>
      </header>

      {/* ─── Step 1: doctor picker ─────────────────────────────────────── */}
      {step === "pick-doctor" ? (
        <div className="space-y-3">
          {doctors.length === 0 ? (
            <p
              data-testid="pwa-book-doctors-empty"
              className="rounded-md border border-dashed border-slate-300 dark:border-gray-600 bg-slate-50 dark:bg-gray-900 p-4 text-sm text-slate-600 dark:text-gray-300"
            >
              No doctors available right now. Please check back later.
            </p>
          ) : (
            <ul className="space-y-3">
              {doctors.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    data-testid={`pwa-book-doctor-${d.id}`}
                    onClick={() => {
                      setSelectedDoctor(d);
                      setSelectedSlot(null);
                      setStep("pick-date");
                    }}
                    className="block w-full rounded-lg border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 text-left shadow-sm hover:border-slate-400"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <p className="text-base font-semibold text-slate-900 dark:text-gray-100">
                          {d.user?.name ? `Dr. ${d.user.name}` : "Doctor"}
                        </p>
                        {d.specialty ? (
                          <p className="text-sm text-slate-600 dark:text-gray-300">
                            {d.specialty}
                          </p>
                        ) : null}
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-1 text-xs font-medium ${modeBadgeClass(d.appointmentMode)}`}
                        data-testid={`pwa-book-doctor-${d.id}-mode`}
                      >
                        {modeBadge(d.appointmentMode)}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {/* ─── Step 2: date + mode-specific input ────────────────────────── */}
      {step === "pick-date" && selectedDoctor ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm">
            <p className="text-sm text-slate-600 dark:text-gray-300">Booking with</p>
            <p className="text-base font-semibold text-slate-900 dark:text-gray-100">
              {selectedDoctor.user?.name
                ? `Dr. ${selectedDoctor.user.name}`
                : "Doctor"}
            </p>
            {selectedDoctor.specialty ? (
              <p className="text-sm text-slate-600 dark:text-gray-300">
                {selectedDoctor.specialty}
              </p>
            ) : null}
            <span
              className={`mt-2 inline-block rounded-full px-2 py-1 text-xs font-medium ${modeBadgeClass(selectedDoctor.appointmentMode)}`}
            >
              {modeBadge(selectedDoctor.appointmentMode)} mode
            </span>
          </div>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700 dark:text-gray-200">
              Pick a date
            </span>
            <input
              type="date"
              value={date}
              min={todayYmd()}
              onChange={(e) => setDate(e.target.value)}
              data-testid="pwa-book-date-input"
              className="block h-11 w-full rounded-md border border-slate-300 dark:border-gray-600 px-3 text-sm"
            />
          </label>

          {/* SLOT mode — availability grid */}
          {selectedDoctor.appointmentMode === "SLOT" ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-700 dark:text-gray-200">
                Pick a time slot
              </p>
              {slotsLoading ? (
                <p
                  data-testid="pwa-book-slots-loading"
                  className="text-sm text-slate-500 dark:text-gray-400"
                >
                  Loading slots…
                </p>
              ) : slotsBlocked.blocked ? (
                <p
                  data-testid="pwa-book-slots-blocked"
                  role="alert"
                  className="rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30 p-3 text-sm text-amber-900 dark:text-amber-200"
                >
                  {slotsBlocked.reason ?? "No slots on this date"}
                </p>
              ) : slots.length === 0 ? (
                <p
                  data-testid="pwa-book-slots-empty"
                  className="rounded-md border border-dashed border-slate-300 dark:border-gray-600 bg-slate-50 dark:bg-gray-900 p-3 text-sm text-slate-600 dark:text-gray-300"
                >
                  No slots available on this date.
                </p>
              ) : (
                <div
                  data-testid="pwa-book-slots-grid"
                  className="grid grid-cols-3 gap-2 sm:grid-cols-4"
                >
                  {slots.map((s) => (
                    <button
                      key={s.startTime}
                      type="button"
                      disabled={!s.isAvailable}
                      data-testid={`pwa-book-slot-${s.startTime}`}
                      data-selected={selectedSlot === s.startTime || undefined}
                      onClick={() => setSelectedSlot(s.startTime)}
                      className={`inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border px-2 text-xs font-medium ${
                        !s.isAvailable
                          ? "cursor-not-allowed border-slate-200 dark:border-gray-700 bg-slate-100 dark:bg-gray-800 text-slate-400 dark:text-gray-500"
                          : selectedSlot === s.startTime
                            ? "border-slate-900 dark:border-gray-300 bg-slate-900 text-white"
                            : "border-slate-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-slate-800 dark:text-gray-100"
                      }`}
                    >
                      {s.startTime}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {/* TOKEN mode — info card. No per-slot pick; server mints a token. */}
          {selectedDoctor.appointmentMode === "TOKEN" ? (
            <div
              data-testid="pwa-book-token-info"
              className="rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/30 p-3 text-sm text-blue-900 dark:text-blue-200"
            >
              <p className="font-medium">Token mode</p>
              <p className="text-blue-800 dark:text-blue-300">
                You'll be issued the next available token when you confirm.
                Your token number will appear on your appointments page.
              </p>
            </div>
          ) : null}

          {/* CALLING mode — info card. No slot, no token, server mints arrivalSeq. */}
          {selectedDoctor.appointmentMode === "CALLING" ? (
            <div
              data-testid="pwa-book-calling-info"
              className="rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30 p-3 text-sm text-amber-900 dark:text-amber-200"
            >
              <p className="font-medium">Calling mode</p>
              <p className="text-amber-800 dark:text-amber-300">
                This doctor sees patients in arrival order. Confirm to join
                the queue — you'll be called in turn on the clinic display.
              </p>
            </div>
          ) : null}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={() => {
                setStep("pick-doctor");
                setSelectedSlot(null);
                setSlots([]);
              }}
              data-testid="pwa-book-back-to-doctors"
              className="inline-flex h-11 min-w-[44px] flex-1 items-center justify-center rounded-md border border-slate-300 dark:border-gray-600 px-4 text-sm font-medium text-slate-800 dark:text-gray-100"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep("confirm")}
              disabled={
                selectedDoctor.appointmentMode === "SLOT"
                  ? !selectedSlot
                  : !date
              }
              data-testid="pwa-book-next-to-confirm"
              className="inline-flex h-11 min-w-[44px] flex-1 items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white disabled:opacity-50"
            >
              Continue
            </button>
          </div>
        </div>
      ) : null}

      {/* ─── Step 3: confirm summary + submit ──────────────────────────── */}
      {step === "confirm" && selectedDoctor ? (
        <div className="space-y-4">
          <div
            data-testid="pwa-book-summary"
            className="rounded-lg border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm"
          >
            <p className="text-sm font-medium uppercase tracking-wide text-slate-500 dark:text-gray-400">
              Review your booking
            </p>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-600 dark:text-gray-300">Doctor</dt>
                <dd className="font-medium text-slate-900 dark:text-gray-100">
                  {selectedDoctor.user?.name
                    ? `Dr. ${selectedDoctor.user.name}`
                    : "Doctor"}
                </dd>
              </div>
              {selectedDoctor.specialty ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-600 dark:text-gray-300">Specialty</dt>
                  <dd className="text-slate-900 dark:text-gray-100">{selectedDoctor.specialty}</dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-3">
                <dt className="text-slate-600 dark:text-gray-300">Mode</dt>
                <dd>
                  <span
                    className={`rounded-full px-2 py-1 text-xs font-medium ${modeBadgeClass(selectedDoctor.appointmentMode)}`}
                  >
                    {modeBadge(selectedDoctor.appointmentMode)}
                  </span>
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-600 dark:text-gray-300">Date</dt>
                <dd className="font-medium text-slate-900 dark:text-gray-100">{date}</dd>
              </div>
              {selectedDoctor.appointmentMode === "SLOT" && selectedSlot ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-600 dark:text-gray-300">Time</dt>
                  <dd
                    data-testid="pwa-book-summary-slot"
                    className="font-medium text-slate-900 dark:text-gray-100"
                  >
                    {selectedSlot}
                  </dd>
                </div>
              ) : null}
              {selectedDoctor.appointmentMode === "TOKEN" ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-600 dark:text-gray-300">Token</dt>
                  <dd className="text-slate-700 dark:text-gray-200">
                    Issued at confirmation
                  </dd>
                </div>
              ) : null}
              {selectedDoctor.appointmentMode === "CALLING" ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-600 dark:text-gray-300">Queue</dt>
                  <dd className="text-slate-700 dark:text-gray-200">
                    Joined on confirmation
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>

          {submitError ? (
            <p
              role="alert"
              data-testid="pwa-book-submit-error"
              className="rounded-md bg-red-50 dark:bg-red-900/30 p-2 text-sm text-red-800 dark:text-red-200"
            >
              {submitError}
            </p>
          ) : null}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setStep("pick-date")}
              disabled={submitting}
              data-testid="pwa-book-back-to-date"
              className="inline-flex h-11 min-w-[44px] flex-1 items-center justify-center rounded-md border border-slate-300 dark:border-gray-600 px-4 text-sm font-medium text-slate-800 dark:text-gray-100 disabled:opacity-60"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canConfirm || submitting}
              data-testid="pwa-book-confirm-btn"
              className="inline-flex h-11 min-w-[44px] flex-1 items-center justify-center rounded-md bg-emerald-700 px-4 text-sm font-medium text-white disabled:opacity-60"
            >
              {submitting ? "Booking…" : "Confirm booking"}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
