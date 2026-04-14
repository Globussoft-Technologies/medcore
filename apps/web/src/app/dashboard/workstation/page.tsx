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
  CheckCircle2,
  ClipboardList,
  Droplet,
  Pill,
  Siren,
  Stethoscope,
  Syringe,
  Users,
} from "lucide-react";

function safe<T>(p: string, fb: T): Promise<T> {
  return api.get<T>(p).catch(() => fb);
}

export default function NurseWorkstationPage() {
  const router = useRouter();
  const { user, isLoading } = useAuthStore();
  const [loaded, setLoaded] = useState(false);
  const [medsDue, setMedsDue] = useState<any[]>([]);
  const [myPatients, setMyPatients] = useState<any[]>([]);
  const [vitalsToRecord, setVitalsToRecord] = useState<any[]>([]);
  const [erTriage, setErTriage] = useState<any[]>([]);
  const [recentRounds, setRecentRounds] = useState<any[]>([]);

  useEffect(() => {
    if (!isLoading && user && user.role !== "NURSE") {
      router.replace("/dashboard");
    }
  }, [user, isLoading, router]);

  useEffect(() => {
    if (!user || user.role !== "NURSE") return;
    (async () => {
      const today = new Date().toISOString().split("T")[0];
      const [meds, rounds, erCases, checkedIn, assignedAdm] = await Promise.all([
        safe<any>(`/medication/administrations/due?window=30`, { data: [] }),
        safe<any>(`/nurse-rounds?mine=true&limit=10`, { data: [] }),
        safe<any>(`/emergency/cases/active`, { data: [] }),
        safe<any>(`/appointments?status=CHECKED_IN&date=${today}&limit=50`, {
          data: [],
        }),
        safe<any>(`/admissions?status=ADMITTED&assignedToMe=true&limit=50`, {
          data: [],
        }),
      ]);

      setMedsDue((meds.data || []).slice(0, 10));
      setRecentRounds((rounds.data || []).slice(0, 5));
      setErTriage(
        (erCases.data || [])
          .filter(
            (c: any) => c.status === "WAITING" || c.status === "IN_TRIAGE"
          )
          .slice(0, 5)
      );
      setVitalsToRecord((checkedIn.data || []).slice(0, 10));
      setMyPatients((assignedAdm.data || []).slice(0, 10));
      setLoaded(true);
    })();
  }, [user]);

  if (!user || user.role !== "NURSE") {
    return (
      <div className="p-8 text-center text-gray-500">
        Workstation is for nurses only.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Workstation</h1>
          <p className="text-sm text-gray-500">Your nursing hub for today</p>
        </div>
        <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
          NURSE
        </span>
      </div>

      {/* Quick actions */}
      <div className="flex flex-wrap gap-2">
        <Btn
          href="/dashboard/vitals"
          Icon={Activity}
          label="Record Vitals"
          color="bg-cyan-600"
        />
        <Btn
          href="/dashboard/medication-dashboard"
          Icon={Pill}
          label="Administer Med"
          color="bg-pink-600"
        />
        <Btn
          href="/dashboard/admissions"
          Icon={Stethoscope}
          label="Start Round"
          color="bg-indigo-600"
        />
        <Btn
          href="/dashboard/emergency"
          Icon={Siren}
          label="Triage Patient"
          color="bg-red-600"
        />
      </div>

      {/* Meds due prominent */}
      <div className="rounded-xl border-2 border-pink-300 bg-gradient-to-br from-pink-50 to-white p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-bold text-pink-800">
            <Pill size={16} /> Medications Due in Next 30 Minutes
          </h2>
          <Link
            href="/dashboard/medication-dashboard"
            className="text-xs text-pink-700 hover:underline"
          >
            Full dashboard
          </Link>
        </div>
        {medsDue.length === 0 ? (
          <p className="py-4 text-center text-sm text-gray-500">
            No medications due in the next 30 minutes
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {medsDue.map((m: any) => (
              <div
                key={m.id}
                className="flex items-center gap-3 rounded-lg border border-pink-200 bg-white p-2.5"
              >
                <div className="rounded-lg bg-pink-100 p-1.5 text-pink-700">
                  <Pill size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {m.medicationOrder?.medicineName || m.medicineName || "—"}
                  </p>
                  <p className="truncate text-[11px] text-gray-500">
                    {m.medicationOrder?.admission?.patient?.user?.name ||
                      m.patientName ||
                      "Patient"}{" "}
                    · {m.medicationOrder?.dosage || ""}
                  </p>
                </div>
                <span className="shrink-0 rounded bg-pink-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                  {new Date(m.scheduledAt).toLocaleTimeString("en-IN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Assigned patients */}
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <Users size={14} /> My Assigned Patients
            </h2>
            <Link
              href="/dashboard/admissions"
              className="text-xs text-primary hover:underline"
            >
              All admissions
            </Link>
          </div>
          {myPatients.length === 0 ? (
            <p className="p-2 text-xs text-gray-400">
              No patients currently assigned
            </p>
          ) : (
            <div className="space-y-2">
              {myPatients.map((a: any) => (
                <Link
                  key={a.id}
                  href={`/dashboard/ipd/${a.id}`}
                  className="flex items-center gap-3 rounded-lg border border-gray-100 p-2.5 hover:border-primary/40"
                >
                  <div className="rounded-lg bg-indigo-100 p-1.5 text-indigo-700">
                    <BedDouble size={14} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {a.patient?.user?.name || "—"}
                    </p>
                    <p className="truncate text-[11px] text-gray-500">
                      {a.admissionNumber} · {a.bed?.ward?.name || ""} Bed{" "}
                      {a.bed?.bedNumber || ""}
                    </p>
                  </div>
                  <ArrowRight size={14} className="text-gray-400" />
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Vitals to record */}
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <Activity size={14} /> Vitals to Record
            </h2>
            <span className="rounded-full bg-cyan-100 px-2 py-0.5 text-[11px] font-semibold text-cyan-700">
              {vitalsToRecord.length}
            </span>
          </div>
          {vitalsToRecord.length === 0 ? (
            <p className="p-2 text-xs text-gray-400">All vitals up to date</p>
          ) : (
            <div className="space-y-1.5">
              {vitalsToRecord.map((a: any) => (
                <Link
                  key={a.id}
                  href={`/dashboard/vitals?appointmentId=${a.id}`}
                  className="flex items-center gap-3 rounded-lg border border-cyan-100 bg-cyan-50/40 p-2 hover:border-cyan-300"
                >
                  <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] font-semibold">
                    #{a.tokenNumber}
                  </span>
                  <span className="flex-1 truncate text-sm font-medium">
                    {a.patient?.user?.name || "—"}
                  </span>
                  <span className="text-[11px] text-gray-500">
                    Dr. {a.doctor?.user?.name || "—"}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* ER triage */}
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <Siren size={14} /> ER Cases Awaiting Triage
            </h2>
            <Link
              href="/dashboard/emergency"
              className="text-xs text-primary hover:underline"
            >
              Open ER
            </Link>
          </div>
          {erTriage.length === 0 ? (
            <p className="p-2 text-xs text-gray-400">No pending triage</p>
          ) : (
            <div className="space-y-1.5">
              {erTriage.map((c: any) => (
                <Link
                  key={c.id}
                  href={`/dashboard/emergency?id=${c.id}`}
                  className="flex items-center gap-3 rounded-lg border border-red-100 bg-red-50/40 p-2 hover:border-red-300"
                >
                  <div className="rounded-lg bg-red-100 p-1.5 text-red-700">
                    <Siren size={14} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {c.caseNumber}
                    </p>
                    <p className="truncate text-[11px] text-gray-500">
                      {c.chiefComplaint}
                    </p>
                  </div>
                  {c.triageLevel && (
                    <span className="shrink-0 rounded bg-red-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                      {c.triageLevel}
                    </span>
                  )}
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Recent rounds */}
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-700">
              <ClipboardList size={14} /> My Recent Rounds
            </h2>
          </div>
          {recentRounds.length === 0 ? (
            <p className="p-2 text-xs text-gray-400">No rounds performed yet</p>
          ) : (
            <div className="space-y-1.5">
              {recentRounds.map((r: any) => (
                <div
                  key={r.id}
                  className="flex items-center gap-3 rounded-lg border border-gray-100 p-2.5"
                >
                  <CheckCircle2 size={14} className="text-green-600" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {r.admission?.patient?.user?.name || "—"}
                    </p>
                    <p className="truncate text-[11px] text-gray-500">
                      {new Date(r.performedAt || r.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>
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

function Btn({
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
