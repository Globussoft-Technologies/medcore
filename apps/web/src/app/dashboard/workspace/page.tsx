"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import {
  Activity,
  ArrowRight,
  BedDouble,
  Calendar,
  CheckCircle2,
  ClipboardList,
  FileText,
  FlaskConical,
  Monitor,
  Pill,
  Stethoscope,
  Users,
} from "lucide-react";

function safe<T>(p: string, fb: T): Promise<T> {
  return api.get<T>(p).catch(() => fb);
}

export default function DoctorWorkspacePage() {
  const router = useRouter();
  const { user, isLoading } = useAuthStore();
  const [loaded, setLoaded] = useState(false);
  const [queue, setQueue] = useState<any[]>([]);
  const [currentToken, setCurrentToken] = useState<any | null>(null);
  const [appts, setAppts] = useState<any[]>([]);
  const [admitted, setAdmitted] = useState<any[]>([]);
  const [recentRx, setRecentRx] = useState<any[]>([]);
  const [pendingLabReview, setPendingLabReview] = useState(0);
  const [pendingDischarge, setPendingDischarge] = useState(0);
  const [pendingReferrals, setPendingReferrals] = useState(0);
  const [rxToWrite, setRxToWrite] = useState(0);

  useEffect(() => {
    if (!isLoading && user && user.role !== "DOCTOR") {
      router.replace("/dashboard");
    }
  }, [user, isLoading, router]);

  useEffect(() => {
    if (!user || user.role !== "DOCTOR") return;
    (async () => {
      const today = new Date().toISOString().split("T")[0];
      const [q, apRes, admRes, rxRes, labRes, refRes, rxWrite, dischargeRes] =
        await Promise.all([
          safe<any>(`/queue/me`, { data: [] }),
          safe<any>(`/appointments?date=${today}&mine=true&limit=50`, { data: [] }),
          safe<any>(`/admissions?status=ADMITTED&mine=true&limit=50`, { data: [] }),
          safe<any>(`/prescriptions?mine=true&limit=5`, { data: [] }),
          safe<any>(`/lab/orders?status=COMPLETED&mine=true&unreviewed=true&limit=1`, {
            meta: { total: 0 },
          }),
          safe<any>(`/referrals?direction=incoming&status=PENDING&limit=1`, {
            meta: { total: 0 },
          }),
          safe<any>(
            `/appointments?status=IN_CONSULTATION&mine=true&hasPrescription=false&limit=1`,
            { meta: { total: 0 } }
          ),
          safe<any>(`/admissions?status=DISCHARGE_PENDING&mine=true&limit=1`, {
            meta: { total: 0 },
          }),
        ]);

      const qList: any[] = Array.isArray(q.data) ? q.data : [];
      const inConsult =
        qList.find((p: any) => p.status === "IN_CONSULTATION") ||
        qList.find((p: any) => p.status === "CHECKED_IN");
      setCurrentToken(inConsult || null);
      setQueue(qList.filter((x: any) => x.id !== inConsult?.id).slice(0, 3));

      setAppts(apRes.data || []);
      setAdmitted(admRes.data || []);
      setRecentRx((rxRes.data || []).slice(0, 5));
      setPendingLabReview(labRes.meta?.total || 0);
      setPendingReferrals(refRes.meta?.total || 0);
      setRxToWrite(rxWrite.meta?.total || 0);
      setPendingDischarge(dischargeRes.meta?.total || 0);
      setLoaded(true);
    })();
  }, [user]);

  if (!user || user.role !== "DOCTOR") {
    return (
      <div className="p-8 text-center text-gray-500">
        Workspace is for doctors only.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Workspace</h1>
          <p className="text-sm text-gray-500">
            Everything you need for today, Dr. {user.name}
          </p>
        </div>
        <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
          DOCTOR
        </span>
      </div>

      {/* Shortcut buttons */}
      <div className="flex flex-wrap gap-2">
        <ShortcutBtn
          href="/dashboard/queue"
          Icon={Stethoscope}
          label="Start Consultation"
          color="bg-primary"
        />
        <ShortcutBtn
          href="/dashboard/prescriptions/new"
          Icon={Pill}
          label="Write Rx"
          color="bg-green-600"
        />
        <ShortcutBtn
          href="/dashboard/lab/new"
          Icon={FlaskConical}
          label="Order Labs"
          color="bg-teal-600"
        />
        <ShortcutBtn
          href="/dashboard/patients"
          Icon={FileText}
          label="Add Note"
          color="bg-indigo-600"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Column 1: Queue right now */}
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <Monitor size={14} /> My Queue
            </h2>
            <Link
              href="/dashboard/queue"
              className="text-xs text-primary hover:underline"
            >
              Open queue
            </Link>
          </div>
          {currentToken ? (
            <div className="mb-3 rounded-lg border border-primary/50 bg-primary/5 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
                Current Token #{currentToken.tokenNumber}
              </p>
              <p className="mt-0.5 text-sm font-semibold">
                {currentToken.patient?.user?.name || "—"}
              </p>
              <p className="text-xs text-gray-500">
                {currentToken.type} · {currentToken.status.replace(/_/g, " ")}
              </p>
            </div>
          ) : (
            <p className="mb-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-500">
              No patient currently in consultation
            </p>
          )}
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            Next in line
          </p>
          {queue.length === 0 ? (
            <p className="p-2 text-xs text-gray-400">Queue is empty</p>
          ) : (
            <div className="space-y-1">
              {queue.map((q) => (
                <div
                  key={q.id}
                  className="flex items-center gap-2 rounded-lg bg-gray-50 px-2 py-1.5"
                >
                  <span className="rounded bg-white px-1.5 py-0.5 font-mono text-xs font-semibold">
                    #{q.tokenNumber}
                  </span>
                  <span className="flex-1 truncate text-xs">
                    {q.patient?.user?.name || "—"}
                  </span>
                  <span className="text-[11px] text-gray-500">
                    {q.status.replace(/_/g, " ")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Column 2: Pending Tasks */}
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-700">
            <ClipboardList size={14} /> My Pending Tasks
          </h2>
          <div className="space-y-2">
            <TaskRow
              label="Prescriptions to write"
              count={rxToWrite}
              href="/dashboard/queue"
              color="text-green-700"
            />
            <TaskRow
              label="Lab results to review"
              count={pendingLabReview}
              href="/dashboard/lab"
              color="text-teal-700"
            />
            <TaskRow
              label="Discharge summaries pending"
              count={pendingDischarge}
              href="/dashboard/admissions"
              color="text-purple-700"
            />
            <TaskRow
              label="Referrals awaiting response"
              count={pendingReferrals}
              href="/dashboard/referrals"
              color="text-blue-700"
            />
          </div>
        </div>

        {/* Column 3: Today's appointments */}
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <Calendar size={14} /> Today&apos;s Appointments
            </h2>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">
              {appts.length}
            </span>
          </div>
          {appts.length === 0 ? (
            <p className="p-2 text-xs text-gray-400">No appointments today</p>
          ) : (
            <div className="space-y-1">
              {appts.slice(0, 8).map((a) => (
                <Link
                  key={a.id}
                  href={`/dashboard/appointments?id=${a.id}`}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-gray-50"
                >
                  <span className="w-12 shrink-0 text-xs text-gray-500">
                    {a.slotStart || "—"}
                  </span>
                  <span className="flex-1 truncate text-xs font-medium">
                    {a.patient?.user?.name || "Patient"}
                  </span>
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px]">
                    {a.status.replace(/_/g, " ")}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Admitted */}
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <BedDouble size={14} /> My Admitted Patients
            </h2>
            <Link
              href="/dashboard/admissions"
              className="text-xs text-primary hover:underline"
            >
              All admissions
            </Link>
          </div>
          {admitted.length === 0 ? (
            <p className="p-2 text-xs text-gray-400">No active admissions</p>
          ) : (
            <div className="space-y-2">
              {admitted.slice(0, 8).map((a) => (
                <Link
                  key={a.id}
                  href={`/dashboard/ipd/${a.id}`}
                  className="flex items-center gap-3 rounded-lg border border-gray-100 p-2.5 hover:border-primary/40"
                >
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium">
                      {a.patient?.user?.name || "—"}
                    </p>
                    <p className="truncate text-[11px] text-gray-500">
                      {a.admissionNumber} · {a.reason}
                    </p>
                  </div>
                  <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-medium text-purple-700">
                    {a.bed?.ward?.name
                      ? `${a.bed.ward.name}/${a.bed.bedNumber}`
                      : "—"}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Recent prescriptions */}
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <Pill size={14} /> Recent Prescriptions
            </h2>
            <Link
              href="/dashboard/prescriptions"
              className="text-xs text-primary hover:underline"
            >
              All
            </Link>
          </div>
          {recentRx.length === 0 ? (
            <p className="p-2 text-xs text-gray-400">No prescriptions written yet</p>
          ) : (
            <div className="space-y-1.5">
              {recentRx.map((rx: any) => (
                <Link
                  key={rx.id}
                  href={`/dashboard/prescriptions?id=${rx.id}`}
                  className="flex items-center gap-3 rounded-lg border border-gray-100 p-2 hover:border-primary/40"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{rx.diagnosis}</p>
                    <p className="truncate text-[11px] text-gray-500">
                      {rx.patient?.user?.name || "—"} ·{" "}
                      {new Date(rx.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <span className="text-[11px] text-gray-500">
                    {rx.items?.length || 0} item
                    {rx.items?.length === 1 ? "" : "s"}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {!loaded && (
        <p className="text-center text-xs text-gray-400">Loading…</p>
      )}
    </div>
  );
}

function ShortcutBtn({
  href,
  Icon,
  label,
  color,
}: {
  href: string;
  Icon: React.ElementType;
  label: string;
  color: string;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-1.5 rounded-lg ${color} px-3 py-2 text-sm font-medium text-white hover:opacity-90`}
    >
      <Icon size={14} /> {label}
    </Link>
  );
}

function TaskRow({
  label,
  count,
  href,
  color,
}: {
  label: string;
  count: number;
  href: string;
  color: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between rounded-lg border border-gray-100 p-2.5 hover:border-primary/40"
    >
      <span className="text-sm text-gray-700">{label}</span>
      <span className="flex items-center gap-1.5">
        <span className={`text-lg font-bold ${count > 0 ? color : "text-gray-300"}`}>
          {count}
        </span>
        <ArrowRight size={14} className="text-gray-400" />
      </span>
    </Link>
  );
}
