"use client";

// Issue #213-B (Apr 30 2026): /dashboard/doctors cards were "non-clickable"
// because `/dashboard/doctors/[id]` did not exist — the Link wrapper landed
// on a 404. This is the minimal read-only doctor profile that closes the
// click loop:
//   • name, specialization, qualification, registration #
//   • weekly schedule list (read-only)
//   • "Edit" button visible only to ADMIN — wired to a TODO modal for now
//     (full edit flow is a follow-up; the bug we're closing is "card does
//     nothing", which a useful read-only landing page resolves).
//
// Backend gap (NOT modified — out of scope for the bug-fix):
//   • There is no GET /api/v1/doctors/:id endpoint. We fetch the list and
//     filter client-side. The dataset is small (one row per doctor) so the
//     extra payload is fine; once the endpoint exists, swap the loader.

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { ArrowLeft, Stethoscope, Edit as EditIcon, Calendar, Settings } from "lucide-react";
import { SkeletonCard } from "@/components/Skeleton";

type AppointmentMode = "CALLING" | "TOKEN" | "SLOT";
type LastHourPolicy = "ACCEPT_ALL" | "BLOCK_NEW" | "WALK_IN_ONLY";
// Pearl §3.2 (gap row 77 final 2 knobs, 2026-05-22) — per-doctor
// booking-channel allow-list. Empty array = "all channels permitted".
type AppointmentChannel = "CALLING" | "SLOT" | "TOKEN" | "WALKIN";
const ALL_CHANNELS: AppointmentChannel[] = ["CALLING", "SLOT", "TOKEN", "WALKIN"];
const CHANNEL_LABEL: Record<AppointmentChannel, string> = {
  CALLING: "Calling",
  SLOT: "Slot",
  TOKEN: "Token",
  WALKIN: "Walk-in",
};

interface DoctorRecord {
  id: string;
  specialization: string;
  qualification: string;
  // Legacy field name from the early read-only page; kept for back-compat
  // with any cached payload. The canonical Pearl §2.1.4 field is
  // `nmcRegNumber` below — the page renders that one preferentially.
  registrationNumber?: string | null;
  // Pearl ERP Stage 1 §2.1.2 / §3.2 — per-doctor appointment mode + knobs.
  appointmentMode?: AppointmentMode;
  tokenPrefix?: string | null;
  tokenStartNumber?: number | null;
  dailyAppointmentLimit?: number | null;
  nearTurnAlertThreshold?: number | null;
  lastHourPolicy?: LastHourPolicy | null;
  // Pearl ERP Stage 1 §3.2 (gap row 77 final 2 knobs, 2026-05-22).
  enabledChannels?: AppointmentChannel[];
  bufferMinutes?: number;
  // Pearl ERP Stage 1 §2.1.4 — NMC registration number printed on every
  // signed Rx PDF.
  nmcRegNumber?: string | null;
  user: {
    id: string;
    name: string;
    email: string;
    phone: string;
    isActive: boolean;
  };
  schedules: Array<{
    id?: string;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    slotDurationMinutes: number;
  }>;
}

const MODE_LABEL: Record<AppointmentMode, string> = {
  CALLING: "Calling (arrival-order queue)",
  TOKEN: "Token (sequential numbers)",
  SLOT: "Slot (fixed appointment times)",
};

const POLICY_LABEL: Record<LastHourPolicy, string> = {
  ACCEPT_ALL: "Accept all bookings",
  BLOCK_NEW: "Block new bookings",
  WALK_IN_ONLY: "Walk-ins only",
};

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export default function DoctorDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const { user } = useAuthStore();
  const [doctor, setDoctor] = useState<DoctorRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // No GET /doctors/:id today — read the list and pick our row.
        const res = await api.get<{ data: DoctorRecord[] }>(`/doctors`);
        if (cancelled) return;
        const found = (res.data || []).find((d) => d.id === id);
        if (!found) {
          setNotFound(true);
        } else {
          setDoctor(found);
        }
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : "Failed to load doctor");
          setNotFound(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const isAdmin = user?.role === "ADMIN";

  if (loading) {
    // Pearl §7.2 wave 11: skeleton card matches the eventual doctor profile
    // header so the layout doesn't jump after fetch.
    return (
      <div
        className="space-y-3 p-6"
        data-testid="doctor-detail-loading"
        aria-busy="true"
      >
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (notFound || !doctor) {
    return (
      <div className="p-6">
        <Link
          href="/dashboard/doctors"
          className="mb-4 inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          <ArrowLeft size={14} /> Back to doctors
        </Link>
        <div
          className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-center"
          data-testid="doctor-detail-notfound"
        >
          <Stethoscope size={28} className="mx-auto mb-2 text-amber-500" />
          <p className="text-sm text-amber-900">Doctor not found.</p>
        </div>
      </div>
    );
  }

  // Sort schedule rows by day-of-week then start-time so the read-only grid
  // renders in a predictable order (Sunday → Saturday, earliest first).
  const sortedSchedules = [...(doctor.schedules || [])].sort((a, b) => {
    if (a.dayOfWeek !== b.dayOfWeek) return a.dayOfWeek - b.dayOfWeek;
    return a.startTime.localeCompare(b.startTime);
  });

  return (
    <div data-testid="doctor-detail-page">
      <div className="mb-4 flex items-center justify-between">
        <Link
          href="/dashboard/doctors"
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          <ArrowLeft size={14} /> Back to doctors
        </Link>
        {isAdmin && (
          <button
            type="button"
            data-testid="doctor-detail-edit"
            onClick={() => {
              // TODO (#213 follow-up): full edit modal — for now the
              // existing "Add Doctor" flow on the list page covers create,
              // and admins edit profiles via the user row. Surfacing this
              // intent so a follow-up issue can pick it up.
              toast.success("Edit flow coming soon — see #213 follow-up");
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <EditIcon size={14} /> Edit
          </button>
        )}
      </div>

      <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <div className="mb-4 flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Stethoscope size={24} />
          </div>
          <div className="flex-1">
            <h1
              className="text-2xl font-bold text-gray-900 dark:text-gray-100"
              data-testid="doctor-detail-name"
            >
              {doctor.user?.name || "—"}
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              <span data-testid="doctor-detail-spec">
                {doctor.specialization || "—"}
              </span>
              {doctor.qualification ? (
                <>
                  {" · "}
                  <span data-testid="doctor-detail-qual">{doctor.qualification}</span>
                </>
              ) : null}
            </p>
            {(doctor.nmcRegNumber || doctor.registrationNumber) && (
              <p
                className="mt-1 text-xs text-gray-500"
                data-testid="doctor-detail-regno"
              >
                NMC Reg #{doctor.nmcRegNumber || doctor.registrationNumber}
              </p>
            )}
          </div>
          <span
            className={
              doctor.user?.isActive
                ? "rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700"
                : "rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700"
            }
          >
            {doctor.user?.isActive ? "Active" : "Inactive"}
          </span>
        </div>

        <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase text-gray-500">Email</dt>
            <dd className="text-sm text-gray-900 dark:text-gray-100">
              {doctor.user?.email || "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-gray-500">Phone</dt>
            <dd className="text-sm text-gray-900 dark:text-gray-100">
              {doctor.user?.phone || "—"}
            </dd>
          </div>
        </dl>
      </div>

      <AppointmentModeCard doctor={doctor} isAdmin={isAdmin} onUpdated={setDoctor} />

      <div className="mt-6 rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
          <Calendar size={14} /> Weekly Schedule
        </h2>
        {sortedSchedules.length === 0 ? (
          <p
            className="text-sm text-gray-400"
            data-testid="doctor-detail-schedule-empty"
          >
            No schedule configured.
          </p>
        ) : (
          <table
            className="w-full text-sm"
            data-testid="doctor-detail-schedule-table"
          >
            <thead>
              <tr className="border-b text-left text-xs uppercase text-gray-500">
                <th className="px-3 py-2">Day</th>
                <th className="px-3 py-2">Start</th>
                <th className="px-3 py-2">End</th>
                <th className="px-3 py-2">Slot</th>
              </tr>
            </thead>
            <tbody>
              {sortedSchedules.map((s, idx) => (
                <tr
                  key={s.id ?? `${s.dayOfWeek}-${s.startTime}-${idx}`}
                  className="border-b last:border-0"
                >
                  <td className="px-3 py-2 font-medium">
                    {DAY_NAMES[s.dayOfWeek] ?? `Day ${s.dayOfWeek}`}
                  </td>
                  <td className="px-3 py-2">{s.startTime}</td>
                  <td className="px-3 py-2">{s.endTime}</td>
                  <td className="px-3 py-2 text-gray-600">
                    {s.slotDurationMinutes} min
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Pearl ERP Stage 1 §2.1.2 / §3.2 — per-doctor appointment-mode editor.
// Non-admins see a read-only summary. Admins can edit mode + knobs and
// the form PATCHes /api/v1/doctors/:id/appointment-mode on save.
function AppointmentModeCard({
  doctor,
  isAdmin,
  onUpdated,
}: {
  doctor: DoctorRecord;
  isAdmin: boolean;
  onUpdated: (next: DoctorRecord) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const currentMode: AppointmentMode = doctor.appointmentMode ?? "TOKEN";
  const [mode, setMode] = useState<AppointmentMode>(currentMode);
  const [tokenPrefix, setTokenPrefix] = useState<string>(doctor.tokenPrefix ?? "");
  const [tokenStartNumber, setTokenStartNumber] = useState<string>(
    doctor.tokenStartNumber != null ? String(doctor.tokenStartNumber) : "",
  );
  const [dailyLimit, setDailyLimit] = useState<string>(
    doctor.dailyAppointmentLimit != null ? String(doctor.dailyAppointmentLimit) : "",
  );
  const [nearTurn, setNearTurn] = useState<string>(
    doctor.nearTurnAlertThreshold != null ? String(doctor.nearTurnAlertThreshold) : "",
  );
  const [policy, setPolicy] = useState<LastHourPolicy | "">(doctor.lastHourPolicy ?? "");
  const [nmcReg, setNmcReg] = useState<string>(doctor.nmcRegNumber ?? "");
  // Pearl §3.2 (gap row 77 final 2 knobs, 2026-05-22) — channels +
  // buffer minutes. Empty `channels` array submits as `[]` which the
  // API treats as "all channels permitted" (back-compat default).
  const [channels, setChannels] = useState<AppointmentChannel[]>(
    doctor.enabledChannels ?? [],
  );
  const [bufferMinutes, setBufferMinutes] = useState<string>(
    doctor.bufferMinutes != null ? String(doctor.bufferMinutes) : "0",
  );

  const toggleChannel = (ch: AppointmentChannel) => {
    setChannels((prev) =>
      prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch],
    );
  };

  const onSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { appointmentMode: mode };
      // Blank text → explicit null (clear). Non-blank → value.
      body.tokenPrefix = tokenPrefix.trim() === "" ? null : tokenPrefix.trim();
      body.tokenStartNumber = tokenStartNumber.trim() === "" ? null : Number(tokenStartNumber);
      body.dailyAppointmentLimit = dailyLimit.trim() === "" ? null : Number(dailyLimit);
      body.nearTurnAlertThreshold = nearTurn.trim() === "" ? null : Number(nearTurn);
      body.lastHourPolicy = policy === "" ? null : policy;
      body.nmcRegNumber = nmcReg.trim() === "" ? null : nmcReg.trim();
      // Pearl §3.2 final 2 knobs — channels submit verbatim ([] is the
      // valid back-compat sentinel meaning "all permitted"); buffer
      // defaults to 0 on blank or non-numeric input (matches column
      // default — the column is NOT NULL so we never POST null).
      body.enabledChannels = channels;
      const parsedBuffer = Number(bufferMinutes);
      body.bufferMinutes = Number.isFinite(parsedBuffer) && parsedBuffer >= 0 ? parsedBuffer : 0;

      const res = await api.patch<{ data: DoctorRecord }>(
        `/doctors/${doctor.id}/appointment-mode`,
        body,
      );
      // The PATCH endpoint returns only the new mode/knob fields; merge
      // them back onto the existing doctor record so other panels (e.g.
      // weekly schedule) stay rendered.
      const next: DoctorRecord = { ...doctor, ...res.data };
      onUpdated(next);
      toast.success("Appointment mode updated");
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save appointment mode");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="mt-6 rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800"
      data-testid="doctor-detail-appointment-mode"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
          <Settings size={14} /> Appointment Mode
        </h2>
        {isAdmin && !editing && (
          <button
            type="button"
            data-testid="appointment-mode-edit"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            <EditIcon size={12} /> Edit
          </button>
        )}
      </div>

      {!editing ? (
        <dl
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          data-testid="appointment-mode-summary"
        >
          <div>
            <dt className="text-xs font-medium uppercase text-gray-500">Mode</dt>
            <dd
              className="text-sm text-gray-900 dark:text-gray-100"
              data-testid="appointment-mode-value"
            >
              {MODE_LABEL[currentMode]}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-gray-500">Token prefix</dt>
            <dd className="text-sm text-gray-900 dark:text-gray-100">
              {doctor.tokenPrefix || "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-gray-500">Token start #</dt>
            <dd className="text-sm text-gray-900 dark:text-gray-100">
              {doctor.tokenStartNumber ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-gray-500">Daily limit</dt>
            <dd className="text-sm text-gray-900 dark:text-gray-100">
              {doctor.dailyAppointmentLimit ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-gray-500">Near-turn alert</dt>
            <dd className="text-sm text-gray-900 dark:text-gray-100">
              {doctor.nearTurnAlertThreshold != null
                ? `${doctor.nearTurnAlertThreshold} patients away`
                : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-gray-500">Last-hour policy</dt>
            <dd className="text-sm text-gray-900 dark:text-gray-100">
              {doctor.lastHourPolicy ? POLICY_LABEL[doctor.lastHourPolicy] : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-gray-500">Enabled channels</dt>
            <dd
              className="text-sm text-gray-900 dark:text-gray-100"
              data-testid="appointment-mode-channels-summary"
            >
              {doctor.enabledChannels && doctor.enabledChannels.length > 0
                ? doctor.enabledChannels.map((c) => CHANNEL_LABEL[c]).join(", ")
                : "All (default)"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-gray-500">Buffer (min)</dt>
            <dd
              className="text-sm text-gray-900 dark:text-gray-100"
              data-testid="appointment-mode-buffer-summary"
            >
              {doctor.bufferMinutes != null ? `${doctor.bufferMinutes} min` : "0 min"}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs font-medium uppercase text-gray-500">NMC Reg #</dt>
            <dd
              className="text-sm text-gray-900 dark:text-gray-100"
              data-testid="appointment-mode-nmc-reg-summary"
            >
              {doctor.nmcRegNumber || "—"}
            </dd>
          </div>
        </dl>
      ) : (
        <form
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            onSave();
          }}
        >
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-medium uppercase text-gray-500">
              Mode
            </label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as AppointmentMode)}
              data-testid="appointment-mode-select"
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
            >
              <option value="CALLING">Calling (arrival-order queue)</option>
              <option value="TOKEN">Token (sequential numbers)</option>
              <option value="SLOT">Slot (fixed appointment times)</option>
            </select>
            <p className="mt-1 text-xs text-gray-500">
              {mode === "CALLING" &&
                "Patients arrive and are seen in arrival order. No tokens, no slot times."}
              {mode === "TOKEN" &&
                "Each booking gets a sequential token number. Slot time is optional."}
              {mode === "SLOT" &&
                "Each booking takes a fixed HH:MM slot. The system blocks double-booking."}
            </p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-gray-500">
              Token prefix
            </label>
            <input
              type="text"
              maxLength={8}
              value={tokenPrefix}
              onChange={(e) => setTokenPrefix(e.target.value)}
              placeholder="T"
              data-testid="appointment-mode-token-prefix"
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-gray-500">
              Token start #
            </label>
            <input
              type="number"
              min={1}
              max={99999}
              value={tokenStartNumber}
              onChange={(e) => setTokenStartNumber(e.target.value)}
              data-testid="appointment-mode-token-start"
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-gray-500">
              Daily appointment limit
            </label>
            <input
              type="number"
              min={1}
              max={500}
              value={dailyLimit}
              onChange={(e) => setDailyLimit(e.target.value)}
              data-testid="appointment-mode-daily-limit"
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-gray-500">
              Near-turn alert (patients away)
            </label>
            <input
              type="number"
              min={1}
              max={50}
              value={nearTurn}
              onChange={(e) => setNearTurn(e.target.value)}
              data-testid="appointment-mode-near-turn"
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-medium uppercase text-gray-500">
              Last-hour policy
            </label>
            <select
              value={policy}
              onChange={(e) => setPolicy(e.target.value as LastHourPolicy | "")}
              data-testid="appointment-mode-policy"
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
            >
              <option value="">— Default —</option>
              <option value="ACCEPT_ALL">Accept all bookings</option>
              <option value="BLOCK_NEW">Block new bookings</option>
              <option value="WALK_IN_ONLY">Walk-ins only</option>
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-medium uppercase text-gray-500">
              Enabled channels
            </label>
            <div
              className="flex flex-wrap gap-2"
              data-testid="appointment-mode-channels"
              role="group"
              aria-label="Enabled appointment channels"
            >
              {ALL_CHANNELS.map((ch) => {
                const active = channels.includes(ch);
                return (
                  <button
                    key={ch}
                    type="button"
                    role="checkbox"
                    aria-checked={active}
                    aria-label={CHANNEL_LABEL[ch]}
                    data-testid={`appointment-mode-channel-${ch.toLowerCase()}`}
                    data-active={active ? "true" : "false"}
                    onClick={() => toggleChannel(ch)}
                    className={
                      "inline-flex min-h-[44px] items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-medium transition " +
                      (active
                        ? "border-primary bg-primary text-white"
                        : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200")
                    }
                  >
                    {CHANNEL_LABEL[ch]}
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-gray-500">
              If empty, all channels matching the appointment mode are accepted.
            </p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase text-gray-500">
              Buffer minutes
            </label>
            <input
              type="number"
              min={0}
              max={120}
              value={bufferMinutes}
              onChange={(e) => setBufferMinutes(e.target.value)}
              data-testid="appointment-mode-buffer"
              className="min-h-[44px] w-full rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
            <p className="mt-1 text-xs text-gray-500">
              Minutes between consecutive slots/tokens for this doctor.
            </p>
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-medium uppercase text-gray-500">
              NMC Reg # (printed on every Rx)
            </label>
            <input
              type="text"
              maxLength={32}
              value={nmcReg}
              onChange={(e) => setNmcReg(e.target.value)}
              placeholder="e.g. NMC/2024/12345"
              data-testid="appointment-mode-nmc-reg"
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
          </div>
          <div className="flex gap-2 sm:col-span-2">
            <button
              type="submit"
              disabled={saving}
              data-testid="appointment-mode-save"
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                // reset form to current values
                setMode(currentMode);
                setTokenPrefix(doctor.tokenPrefix ?? "");
                setTokenStartNumber(
                  doctor.tokenStartNumber != null ? String(doctor.tokenStartNumber) : "",
                );
                setDailyLimit(
                  doctor.dailyAppointmentLimit != null
                    ? String(doctor.dailyAppointmentLimit)
                    : "",
                );
                setNearTurn(
                  doctor.nearTurnAlertThreshold != null
                    ? String(doctor.nearTurnAlertThreshold)
                    : "",
                );
                setPolicy(doctor.lastHourPolicy ?? "");
                setNmcReg(doctor.nmcRegNumber ?? "");
                setChannels(doctor.enabledChannels ?? []);
                setBufferMinutes(
                  doctor.bufferMinutes != null ? String(doctor.bufferMinutes) : "0",
                );
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
