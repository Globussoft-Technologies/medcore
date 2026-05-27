"use client";

// Patient PWA — My Health Records (Pearl §6.1 — gap #5 piece 3f of 4).
//
// Unified read-only timeline of the authed PATIENT's local Pearl records.
// Stage-1 scope per `docs/PEARL-ERP-STAGE-1-SOW.md` §6.1: "Read-only view of
// own records (Stage 1: local Pearl records; Stage 2: federated via ABDM
// HIU)." ABDM HIU federation is explicitly Stage 2 and out of scope here.
//
// Source endpoints (all are existing, PATIENT-self-scoped server-side — we
// do NOT touch route auth/RBAC for this tick):
//   • GET /api/v1/appointments?limit=50
//       → routes/appointments.ts auto-scopes via req.user.role === "PATIENT"
//   • GET /api/v1/prescriptions?limit=50
//       → routes/prescriptions.ts:655-660 (same self-scope branch piece 3c
//         relies on for the My-Prescriptions page).
//   • GET /api/v1/lab/orders?limit=50
//       → routes/lab.ts:154-159 (PATIENT branch overrides where.patientId
//         to caller's own Patient row before findMany; #511 audit verified-
//         safe).
//
// Scope-cut for this tick (documented in gap-row 6.1):
//   • Consultations chip — there's no patient-self-scoped /consultations
//     endpoint in the API; consultation events are embedded inside
//     prescriptions (Doctor signs a prescription as the consult artefact),
//     so the prescription row is the consultation surface in Pearl's
//     current data model. Surfacing a separate "Consultation" timeline
//     entry would mean splitting Rx rows by visit / encounter, which is a
//     non-trivial server change deferred to a later piece.
//   • Vitals / Allergies / Immunizations — these live in routes/ehr.ts
//     under `/patients/:patientId/<entity>` (the PATIENT can only access
//     them when calling with THEIR OWN patientId — see
//     assertPatientOwnsResource at ehr.ts:91). Patient row id is not
//     surfaced on the PWA today (the /auth/me payload doesn't echo
//     patient.id back; client would need an extra fetch). Including them
//     would add a 4th round-trip + a Patient-id resolution step; deferred
//     to a follow-up tick that brings the EHR sections into the timeline.
//
// Pagination shape: load most-recent 50 of each source type via
// Promise.allSettled. "Load older records" extends the window by another 50
// per source. Straight DOM render (no virtualization) — fine for Stage 1.
//
// Type filter: client-side toggle chips (Appointments / Prescriptions /
// Lab Results). All on by default. Hide entries of toggled-off type.
//
// Page-shape conventions mirror prior patient pages (loading / unauth /
// error / ready state machine + 44px touch targets per Pearl §6.2).

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { api } from "@/lib/api";

// ─── API types ────────────────────────────────────────────────────────────

interface AppointmentRow {
  id: string;
  date: string;
  slotStart?: string | null;
  status?: string | null;
  doctor?: {
    user?: { name?: string | null } | null;
    specialty?: string | null;
  } | null;
}

interface PrescriptionItem {
  id?: string;
  medicineName: string;
}

interface PrescriptionRow {
  id: string;
  createdAt: string;
  diagnosis?: string | null;
  status?: string | null;
  doctor?: {
    user?: { name?: string | null } | null;
    specialty?: string | null;
  } | null;
  items?: PrescriptionItem[] | null;
}

interface LabOrderItem {
  id?: string;
  test?: { name?: string | null; code?: string | null } | null;
}

interface LabOrderRow {
  id: string;
  orderedAt: string;
  status?: string | null;
  items?: LabOrderItem[] | null;
}

interface ApiList<T> {
  success: boolean;
  data: T[];
  error?: string | null;
  meta?: { page?: number; limit?: number; total?: number };
}

type LoadState = "loading" | "ready" | "unauth" | "error";

// ─── Timeline entry abstraction ──────────────────────────────────────────

type EntryType = "appointment" | "prescription" | "lab";

interface TimelineEntry {
  id: string;
  type: EntryType;
  when: number; // epoch ms — for sort
  whenIso: string;
  title: string;
  body: string | null;
  href: string;
}

const PAGE_SIZE = 50;

const TYPE_LABEL: Record<EntryType, string> = {
  appointment: "Appointments",
  prescription: "Prescriptions",
  lab: "Lab Results",
};

const TYPE_PILL_CLASS: Record<EntryType, string> = {
  appointment: "bg-blue-100 text-blue-900",
  prescription: "bg-emerald-100 text-emerald-900",
  lab: "bg-amber-100 text-amber-900",
};

const TYPE_ICON: Record<EntryType, string> = {
  appointment: "🗓",
  prescription: "℞",
  lab: "🧪",
};

// ─── Adapters: source row → TimelineEntry ────────────────────────────────

// IST offset in minutes — clinic-local time is Asia/Kolkata (UTC+5:30).
// `Appointment.date` is the calendar day at UTC midnight; `slotStart` is
// "HH:MM(:SS)" in clinic-local IST clock time. Composing the right UTC
// instant requires subtracting the IST offset; the older `setUTCHours`
// version treated the IST clock string AS IF it were UTC and produced a
// 5h30m-offset timestamp that mis-grouped the entry under the wrong day.
const IST_OFFSET_MIN = 330;

function appointmentToEntry(a: AppointmentRow): TimelineEntry {
  const base = new Date(a.date);
  if (a.slotStart) {
    const [hh, mm] = a.slotStart.split(":").map((s) => parseInt(s, 10));
    if (Number.isFinite(hh)) {
      const ist = hh * 60 + (Number.isFinite(mm) ? mm : 0);
      base.setTime(base.getTime() + (ist - IST_OFFSET_MIN) * 60_000);
    }
  }
  const doctorName = a.doctor?.user?.name;
  const title = doctorName
    ? `Consultation with Dr. ${doctorName}`
    : "Consultation";
  const bodyBits: string[] = [];
  if (a.doctor?.specialty) bodyBits.push(a.doctor.specialty);
  if (a.status) bodyBits.push(a.status);
  return {
    id: `appt-${a.id}`,
    type: "appointment",
    when: base.getTime(),
    whenIso: base.toISOString(),
    title,
    body: bodyBits.length ? bodyBits.join(" · ") : null,
    href: "/patient/appointments",
  };
}

function prescriptionToEntry(p: PrescriptionRow): TimelineEntry {
  const t = new Date(p.createdAt).getTime();
  const items = p.items ?? [];
  const top = items[0]?.medicineName;
  const more = Math.max(0, items.length - 1);
  const title = top
    ? `Prescription — ${top}${more > 0 ? ` (+${more} more)` : ""}`
    : "Prescription";
  const bodyBits: string[] = [];
  if (p.doctor?.user?.name) bodyBits.push(`Dr. ${p.doctor.user.name}`);
  if (p.diagnosis) bodyBits.push(p.diagnosis);
  if (p.status) bodyBits.push(p.status);
  return {
    id: `rx-${p.id}`,
    type: "prescription",
    when: t,
    whenIso: p.createdAt,
    title,
    body: bodyBits.length ? bodyBits.join(" · ") : null,
    href: "/patient/prescriptions",
  };
}

function labOrderToEntry(l: LabOrderRow): TimelineEntry {
  const t = new Date(l.orderedAt).getTime();
  const items = l.items ?? [];
  const top = items[0]?.test?.name ?? items[0]?.test?.code;
  const more = Math.max(0, items.length - 1);
  const title = top
    ? `Lab order — ${top}${more > 0 ? ` (+${more} more)` : ""}`
    : "Lab order";
  return {
    id: `lab-${l.id}`,
    type: "lab",
    when: t,
    whenIso: l.orderedAt,
    title,
    body: l.status ?? null,
    // No /patient/lab-orders page exists today; deep-link to dashboard.
    href: "/patient/dashboard",
  };
}

// ─── Formatting helpers ──────────────────────────────────────────────────

function formatDateHeader(ts: number): string {
  return new Date(ts).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

function dayKey(ts: number): string {
  // Use the IST calendar day for grouping so an appointment at 11pm IST
  // doesn't get bucketed under the next UTC day on a non-IST browser.
  // en-CA produces YYYY-MM-DD which is the canonical sortable form.
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// ─── Component ───────────────────────────────────────────────────────────

const ALL_TYPES: EntryType[] = ["appointment", "prescription", "lab"];

export default function PatientRecordsPage() {
  const [state, setState] = useState<LoadState>("loading");
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [enabled, setEnabled] = useState<Record<EntryType, boolean>>({
    appointment: true,
    prescription: true,
    lab: true,
  });
  const [windowSize, setWindowSize] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  // Track exhausted-ness per source so the "Load older" CTA hides when
  // every source has returned fewer rows than asked for.
  const [exhausted, setExhausted] = useState<Record<EntryType, boolean>>({
    appointment: false,
    prescription: false,
    lab: false,
  });

  const fetchWindow = useCallback(
    async (limit: number, mode: "replace" | "append"): Promise<void> => {
      if (mode === "replace") setState("loading");
      else setLoadingMore(true);
      try {
        const [apptRes, rxRes, labRes] = await Promise.allSettled([
          api.get<ApiList<AppointmentRow>>(
            `/appointments?limit=${limit}`,
            { skip401Redirect: true },
          ),
          api.get<ApiList<PrescriptionRow>>(`/prescriptions?limit=${limit}`, {
            skip401Redirect: true,
          }),
          api.get<ApiList<LabOrderRow>>(`/lab/orders?limit=${limit}`, {
            skip401Redirect: true,
          }),
        ]);

        const any401 = [apptRes, rxRes, labRes].some(
          (r) =>
            r.status === "rejected" &&
            (r.reason as { status?: number })?.status === 401,
        );
        if (any401) {
          setState("unauth");
          return;
        }

        const appts =
          apptRes.status === "fulfilled" && apptRes.value.success
            ? apptRes.value.data ?? []
            : [];
        const rxs =
          rxRes.status === "fulfilled" && rxRes.value.success
            ? rxRes.value.data ?? []
            : [];
        const labs =
          labRes.status === "fulfilled" && labRes.value.success
            ? labRes.value.data ?? []
            : [];

        // A source is "exhausted" when it returned strictly fewer rows than
        // we asked for — i.e. there's no further page beyond this window.
        setExhausted({
          appointment: appts.length < limit,
          prescription: rxs.length < limit,
          lab: labs.length < limit,
        });

        const merged: TimelineEntry[] = [
          ...appts.map(appointmentToEntry),
          ...rxs.map(prescriptionToEntry),
          ...labs.map(labOrderToEntry),
        ].sort((a, b) => b.when - a.when);

        setEntries(merged);
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
    void fetchWindow(PAGE_SIZE, "replace");
  }, [fetchWindow]);

  const toggleType = useCallback((t: EntryType) => {
    setEnabled((prev) => ({ ...prev, [t]: !prev[t] }));
  }, []);

  const visible = useMemo(
    () => entries.filter((e) => enabled[e.type]),
    [entries, enabled],
  );

  // Group by UTC day for the sticky date header convention. Order is
  // preserved because `entries` is already newest-first.
  const groups = useMemo(() => {
    const out: Array<{ key: string; ts: number; rows: TimelineEntry[] }> = [];
    let last: { key: string; ts: number; rows: TimelineEntry[] } | null = null;
    for (const e of visible) {
      const k = dayKey(e.when);
      if (!last || last.key !== k) {
        last = { key: k, ts: e.when, rows: [e] };
        out.push(last);
      } else {
        last.rows.push(e);
      }
    }
    return out;
  }, [visible]);

  const allExhausted =
    exhausted.appointment && exhausted.prescription && exhausted.lab;

  if (state === "loading") {
    return (
      <section
        data-testid="patient-records-loading"
        className="flex min-h-[40vh] items-center justify-center text-sm text-slate-500"
      >
        Loading your records…
      </section>
    );
  }

  if (state === "unauth") {
    return (
      <section data-testid="patient-records-unauth" className="space-y-4 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-base text-slate-600">
          Please sign in to view your health records.
        </p>
        <Link
          href="/patient/login"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white"
          data-testid="patient-records-signin-cta"
        >
          Sign in
        </Link>
      </section>
    );
  }

  if (state === "error") {
    return (
      <section
        data-testid="patient-records-error"
        role="alert"
        className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800"
      >
        Something went wrong loading your records. Please refresh.
      </section>
    );
  }

  const isEmpty = visible.length === 0;

  return (
    <section data-testid="patient-records" className="space-y-6 py-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          My health records
        </h1>
        <p className="text-sm text-slate-600">
          Your appointments, prescriptions, and lab results in one place.
          Stage 1 shows local Pearl records; Stage 2 will federate
          ABDM-linked records via HIU.
        </p>
      </header>

      {/* ─── Filter chips ──────────────────────────────────────────── */}
      <div
        data-testid="patient-records-chips"
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Filter records by type"
      >
        {ALL_TYPES.map((t) => {
          const on = enabled[t];
          return (
            <button
              key={t}
              type="button"
              onClick={() => toggleType(t)}
              aria-pressed={on}
              data-testid={`patient-records-chip-${t}`}
              data-active={on ? "true" : "false"}
              className={`inline-flex h-11 min-w-[44px] items-center justify-center gap-2 rounded-full px-4 text-sm font-medium ${
                on
                  ? "bg-slate-900 text-white"
                  : "border border-slate-300 bg-white text-slate-700"
              }`}
            >
              <span aria-hidden="true">{TYPE_ICON[t]}</span>
              {TYPE_LABEL[t]}
            </button>
          );
        })}
      </div>

      {isEmpty ? (
        <div
          data-testid="patient-records-empty"
          className="space-y-3 rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm"
        >
          <p className="text-base text-slate-700">No records yet.</p>
          <p className="text-xs text-slate-500">
            Your appointments, prescriptions, and lab results will show up
            here once they&apos;re entered by the hospital.
          </p>
        </div>
      ) : (
        <ol
          data-testid="patient-records-timeline"
          className="space-y-6"
        >
          {groups.map((g) => (
            <li
              key={g.key}
              data-testid="patient-records-day"
              data-day={g.key}
              className="space-y-2"
            >
              <h2
                data-testid="patient-records-day-header"
                className="sticky top-0 z-10 bg-white py-1 text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                {formatDateHeader(g.ts)}
              </h2>
              <ul className="space-y-2">
                {g.rows.map((e) => (
                  <RecordCard key={e.id} entry={e} />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}

      {!isEmpty && !allExhausted ? (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => {
              const next = windowSize + PAGE_SIZE;
              setWindowSize(next);
              void fetchWindow(next, "append");
            }}
            data-testid="patient-records-load-more"
            className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 px-6 text-sm font-medium text-slate-800 disabled:opacity-60"
          >
            {loadingMore ? "Loading…" : "Load older records"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

interface CardProps {
  entry: TimelineEntry;
}

function RecordCard({ entry }: CardProps) {
  return (
    <li
      data-testid="patient-records-row"
      data-entry-id={entry.id}
      data-entry-type={entry.type}
      className="space-y-2 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <p
            data-testid="patient-records-row-time"
            className="text-xs font-medium uppercase tracking-wide text-slate-500"
          >
            {formatTime(entry.when)}
          </p>
          <p
            data-testid="patient-records-row-title"
            className="text-base font-semibold text-slate-900"
          >
            {entry.title}
          </p>
          {entry.body ? (
            <p
              data-testid="patient-records-row-body"
              className="text-sm text-slate-700"
            >
              {entry.body}
            </p>
          ) : null}
        </div>
        <span
          data-testid="patient-records-row-pill"
          className={`rounded-full px-2 py-1 text-xs font-medium ${TYPE_PILL_CLASS[entry.type]}`}
        >
          <span aria-hidden="true" className="mr-1">
            {TYPE_ICON[entry.type]}
          </span>
          {TYPE_LABEL[entry.type]}
        </span>
      </div>

      <div className="pt-1">
        <Link
          href={entry.href}
          data-testid="patient-records-row-view-btn"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-800"
        >
          View detail
        </Link>
      </div>
    </li>
  );
}
