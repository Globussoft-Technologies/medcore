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
import { ArrowLeft, Stethoscope, Edit as EditIcon, Calendar } from "lucide-react";

interface DoctorRecord {
  id: string;
  specialization: string;
  qualification: string;
  registrationNumber?: string | null;
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
    return (
      <div className="p-6">
        <p className="text-sm text-gray-500">Loading doctor…</p>
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
            {doctor.registrationNumber && (
              <p
                className="mt-1 text-xs text-gray-500"
                data-testid="doctor-detail-regno"
              >
                Reg #{doctor.registrationNumber}
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
