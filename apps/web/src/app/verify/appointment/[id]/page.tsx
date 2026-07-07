// Public appointment verification page reached via the Appointment QR shown on
// the booking confirmation. Shows only the booking itself (doctor, department,
// date, token, status) + the issuing hospital — no clinical data, no other
// patient data. Server-rendered, mirrors the patient/Rx verify pages.

import { CheckCircle2, ShieldAlert, CalendarDays, Stethoscope, Ticket } from "lucide-react";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface VerifyData {
  ok: true;
  appointmentId: string;
  status: string;
  date: string;
  slotStart: string | null;
  tokenNumber: number | null;
  arrivalSeq: number | null;
  displayToken: string | null;
  department: string | null;
  doctorName: string;
  patientName: string | null;
  hospital: { name: string; address: string; phone: string };
}

async function fetchVerification(id: string): Promise<VerifyData | null> {
  const base =
    process.env.API_INTERNAL_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "http://localhost:4000/api/v1";
  const url = `${base.replace(/\/$/, "")}/public/verify/appointment/${encodeURIComponent(id)}`;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as VerifyData;
    if (!json.ok) return null;
    return json;
  } catch {
    return null;
  }
}

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleDateString("en-IN", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return value;
  }
}

export default async function VerifyAppointmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await fetchVerification(id);

  if (!data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6 dark:bg-gray-950">
        <div className="max-w-md rounded-2xl border border-red-200 bg-white p-8 text-center shadow-sm dark:border-red-900/50 dark:bg-gray-900">
          <ShieldAlert className="mx-auto h-10 w-10 text-red-500" />
          <h1 className="mt-3 text-lg font-semibold text-gray-900 dark:text-gray-100">
            Appointment not found
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            This QR code does not match a valid appointment.
          </p>
        </div>
      </div>
    );
  }

  const token = data.displayToken ?? (data.arrivalSeq != null ? `#${data.arrivalSeq}` : null);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6 dark:bg-gray-950">
      <div className="w-full max-w-md rounded-2xl border border-emerald-200 bg-white p-8 shadow-sm dark:border-emerald-900/50 dark:bg-gray-900">
        <div className="text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-500" />
          <h1 className="mt-3 text-xl font-bold text-gray-900 dark:text-gray-100">
            {data.hospital.name}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Appointment confirmation
          </p>
        </div>

        <dl className="mt-6 space-y-3 text-sm">
          {data.patientName && (
            <Row label="Patient" value={data.patientName} />
          )}
          <Row
            label="Doctor"
            value={data.doctorName}
            icon={<Stethoscope className="h-4 w-4 text-emerald-600" />}
          />
          {data.department && <Row label="Department" value={data.department} />}
          <Row
            label="Date"
            value={
              data.slotStart ? `${formatDate(data.date)} · ${data.slotStart}` : formatDate(data.date)
            }
            icon={<CalendarDays className="h-4 w-4 text-emerald-600" />}
          />
          {token && (
            <Row
              label="Token"
              value={token}
              icon={<Ticket className="h-4 w-4 text-emerald-600" />}
            />
          )}
          <Row label="Status" value={data.status.replace(/_/g, " ")} />
        </dl>

        {data.hospital.phone && (
          <p className="mt-6 text-center text-xs text-gray-500 dark:text-gray-400">
            {data.hospital.address ? `${data.hospital.address} · ` : ""}
            {data.hospital.phone}
          </p>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-gray-100 pb-2 dark:border-gray-800">
      <dt className="flex items-center gap-1.5 text-gray-500 dark:text-gray-400">
        {icon}
        {label}
      </dt>
      <dd className="text-right font-medium text-gray-900 dark:text-gray-100">
        {value}
      </dd>
    </div>
  );
}
