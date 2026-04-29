"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { usePrompt } from "@/lib/use-dialog";
import { getSocket } from "@/lib/socket";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { formatDoctorName } from "@/lib/format-doctor-name";

// Issue #383 (CRITICAL prod RBAC bypass, Apr 29 2026): Live Queue exposes
// every patient currently waiting/in-consultation across the clinic — names,
// tokens, statuses. Staff-only.
const QUEUE_ALLOWED = new Set([
  "ADMIN",
  "RECEPTION",
  "DOCTOR",
  "NURSE",
]);

interface QueueDoctor {
  doctorId: string;
  doctorName: string;
  specialization: string;
  currentToken: number | null;
  waitingCount: number;
}

interface QueueEntry {
  tokenNumber: number;
  patientName: string;
  appointmentId: string;
  type: string;
  status: string;
  priority: string;
  slotTime: string | null;
  hasVitals: boolean;
  estimatedWaitMinutes: number;
  vulnerableFlags?: {
    isSenior: boolean;
    isChild: boolean;
    isPregnant: boolean;
    ageYears: number | null;
  };
}

interface DoctorQueue {
  doctorId: string;
  date: string;
  currentToken: number | null;
  totalInQueue: number;
  queue: QueueEntry[];
}

export default function QueuePage() {
  const user = useAuthStore((s) => s.user);
  const isAuthLoading = useAuthStore((s) => s.isLoading);
  const router = useRouter();
  const { t } = useTranslation();
  const promptUser = usePrompt();
  const canTransfer = user?.role === "ADMIN" || user?.role === "RECEPTION";

  // Issue #383: redirect PATIENT (and any other non-staff) away.
  useEffect(() => {
    if (!isAuthLoading && user && !QUEUE_ALLOWED.has(user.role)) {
      toast.error("Live queue is staff-only.");
      router.replace("/dashboard");
    }
  }, [isAuthLoading, user, router]);
  const [display, setDisplay] = useState<QueueDoctor[]>([]);
  const [selectedDoctor, setSelectedDoctor] = useState<string | null>(null);
  const [doctorQueue, setDoctorQueue] = useState<DoctorQueue | null>(null);
  const [loading, setLoading] = useState(true);
  const [transferTarget, setTransferTarget] = useState<{
    appointmentId: string;
    patientName: string;
    currentDoctorId: string;
  } | null>(null);
  const [transferDoctorId, setTransferDoctorId] = useState("");
  const [transferReason, setTransferReason] = useState("");
  const [transferring, setTransferring] = useState(false);

  async function handleTransfer() {
    if (!transferTarget || !transferDoctorId || !transferReason.trim()) {
      toast.error("Please select a doctor and enter a reason.");
      return;
    }
    setTransferring(true);
    try {
      await api.post(
        `/appointments/${transferTarget.appointmentId}/transfer`,
        { newDoctorId: transferDoctorId, reason: transferReason }
      );
      setTransferTarget(null);
      setTransferDoctorId("");
      setTransferReason("");
      loadDisplay();
      if (selectedDoctor) loadDoctorQueue(selectedDoctor);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Transfer failed");
    }
    setTransferring(false);
  }

  useEffect(() => {
    loadDisplay();

    const socket = getSocket();
    socket.connect();
    socket.emit("join-display");

    socket.on("token-called", () => {
      loadDisplay();
      if (selectedDoctor) loadDoctorQueue(selectedDoctor);
    });

    socket.on("queue-updated", () => {
      loadDisplay();
      if (selectedDoctor) loadDoctorQueue(selectedDoctor);
    });

    return () => {
      socket.disconnect();
    };
  }, [selectedDoctor]);

  async function loadDisplay() {
    try {
      const res = await api.get<{ data: QueueDoctor[] }>("/queue");
      setDisplay(res.data);
    } catch {
      // empty
    }
    setLoading(false);
  }

  async function loadDoctorQueue(doctorId: string) {
    try {
      const today = new Date().toISOString().split("T")[0];
      const res = await api.get<{ data: DoctorQueue }>(
        `/queue/${doctorId}?date=${today}`
      );
      setDoctorQueue(res.data);
    } catch {
      // empty
    }
  }

  const statusColors: Record<string, string> = {
    BOOKED: "bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800",
    CHECKED_IN: "bg-yellow-50 border-yellow-200 dark:bg-yellow-900/20 dark:border-yellow-800",
    IN_CONSULTATION: "bg-green-50 border-green-300 dark:bg-green-900/20 dark:border-green-800",
    COMPLETED: "bg-gray-50 border-gray-200 dark:bg-gray-900/40 dark:border-gray-700",
  };

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-gray-900 dark:text-gray-100">{t("dashboard.queue.title")}</h1>

      {/* Token display board */}
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {loading ? (
          <div className="col-span-3 text-center text-gray-600 dark:text-gray-300">
            {t("common.loading")}
          </div>
        ) : (
          display.map((doc) => (
            <button
              key={doc.doctorId}
              onClick={() => {
                setSelectedDoctor(doc.doctorId);
                loadDoctorQueue(doc.doctorId);
              }}
              className={`rounded-xl border-2 p-6 text-left transition ${
                selectedDoctor === doc.doctorId
                  ? "border-primary bg-blue-50 dark:bg-blue-900/30"
                  : "border-gray-200 bg-white hover:border-primary/50 dark:border-gray-700 dark:bg-gray-800"
              }`}
            >
              <p className="font-semibold text-gray-900 dark:text-gray-100">{formatDoctorName(doc.doctorName)}</p>
              <p className="text-sm text-gray-700 dark:text-gray-300">{doc.specialization}</p>
              <div className="mt-4 flex items-center justify-between">
                <div>
                  <p className="text-xs text-gray-700 dark:text-gray-300">{t("dashboard.queue.currentToken")}</p>
                  <p className="text-4xl font-bold text-primary dark:text-blue-300">
                    {doc.currentToken ?? "—"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-gray-700 dark:text-gray-300">{t("dashboard.queue.waiting")}</p>
                  <p className="text-2xl font-bold text-gray-800 dark:text-gray-100">
                    {doc.waitingCount}
                  </p>
                </div>
              </div>
            </button>
          ))
        )}
      </div>

      {/* Doctor queue detail */}
      {doctorQueue && (
        <div className="rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
          <h2 className="mb-4 font-semibold text-gray-900 dark:text-gray-100">{t("dashboard.queue.queueDetail")}</h2>
          {doctorQueue.queue.length === 0 ? (
            <p className="text-gray-700 dark:text-gray-300">{t("dashboard.queue.noPatients")}</p>
          ) : (
            <div className="space-y-2">
              {doctorQueue.queue.map((entry) => (
                <div
                  key={entry.appointmentId}
                  className={`flex items-center justify-between rounded-lg border p-4 ${statusColors[entry.status] || "bg-white dark:bg-gray-800 dark:border-gray-700"}`}
                >
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-lg font-bold text-white">
                      {entry.tokenNumber}
                    </div>
                    <div>
                      <p className="flex items-center gap-2 font-medium">
                        {entry.patientName}
                        {entry.vulnerableFlags?.isChild && (
                          <span
                            title="Child under 5"
                            className="rounded-full bg-pink-100 px-1.5 py-0.5 text-[10px] font-semibold text-pink-700"
                          >
                            👶 CHILD
                          </span>
                        )}
                        {entry.vulnerableFlags?.isPregnant && (
                          <span
                            title="Active antenatal case"
                            className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700"
                          >
                            🤰 ANC
                          </span>
                        )}
                        {entry.vulnerableFlags?.isSenior && (
                          <span
                            title="Senior citizen (65+)"
                            className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
                          >
                            🧓 SENIOR
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-gray-500">
                        {entry.type === "WALK_IN" ? "Walk-in" : `Slot: ${entry.slotTime}`}
                        {entry.priority !== "NORMAL" && (
                          <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700">
                            {entry.priority}
                          </span>
                        )}
                        {entry.vulnerableFlags?.ageYears !== null && entry.vulnerableFlags?.ageYears !== undefined && (
                          <span className="ml-2 text-gray-400">
                            · Age {entry.vulnerableFlags.ageYears}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium">
                      {entry.status.replace(/_/g, " ")}
                    </p>
                    {entry.status !== "COMPLETED" &&
                      entry.status !== "IN_CONSULTATION" && (
                        <p className="text-xs text-gray-500">
                          ~{entry.estimatedWaitMinutes} min wait
                        </p>
                      )}
                    <p className="text-xs text-gray-400">
                      {entry.hasVitals ? "Vitals recorded" : "No vitals"}
                    </p>
                    {canTransfer &&
                      ["BOOKED", "CHECKED_IN"].includes(entry.status) &&
                      selectedDoctor && (
                        <div className="mt-2 flex justify-end gap-1">
                          <button
                            onClick={() =>
                              setTransferTarget({
                                appointmentId: entry.appointmentId,
                                patientName: entry.patientName,
                                currentDoctorId: selectedDoctor,
                              })
                            }
                            aria-label={`Transfer ${entry.patientName} to another doctor`}
                            className="rounded border border-indigo-400 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-800 hover:bg-indigo-100"
                          >
                            {t("dashboard.actions.transfer")}
                          </button>
                          <button
                            onClick={async () => {
                              const reason = await promptUser({
                                title: "Left Without Being Seen",
                                label: "LWBS reason",
                                placeholder: "e.g., Long wait, Emergency, Patient left",
                                required: true,
                              });
                              if (!reason) return;
                              try {
                                await api.patch(
                                  `/appointments/${entry.appointmentId}/lwbs`,
                                  { reason }
                                );
                                loadDisplay();
                                if (selectedDoctor) loadDoctorQueue(selectedDoctor);
                              } catch (err) {
                                toast.error(
                                  err instanceof Error ? err.message : "Failed"
                                );
                              }
                            }}
                            className="rounded border border-red-400 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800 hover:bg-red-100"
                            aria-label={`Mark ${entry.patientName} as left without being seen`}
                          >
                            {t("dashboard.actions.lwbs")}
                          </button>
                        </div>
                      )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Transfer modal */}
      {transferTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
            <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100">
              {t("dashboard.queue.transfer")}
            </h3>
            <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
              {t("dashboard.appointments.col.patient")}: <span className="font-medium">{transferTarget.patientName}</span>
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label htmlFor="queue-transfer-doctor" className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                  {t("dashboard.queue.newDoctor")}
                </label>
                <select
                  id="queue-transfer-doctor"
                  value={transferDoctorId}
                  onChange={(e) => setTransferDoctorId(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                >
                  <option value="">{t("dashboard.queue.selectDoctor")}</option>
                  {display
                    .filter((d) => d.doctorId !== transferTarget.currentDoctorId)
                    .map((d) => (
                      <option key={d.doctorId} value={d.doctorId}>
                        {formatDoctorName(d.doctorName)}
                        {d.specialization ? ` — ${d.specialization}` : ""}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label htmlFor="queue-transfer-reason" className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">
                  {t("common.reason")}
                </label>
                <textarea
                  id="queue-transfer-reason"
                  value={transferReason}
                  onChange={(e) => setTransferReason(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  placeholder={t("dashboard.queue.transferReason")}
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => {
                  setTransferTarget(null);
                  setTransferDoctorId("");
                  setTransferReason("");
                }}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={handleTransfer}
                disabled={transferring}
                className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-800 disabled:opacity-60"
              >
                {transferring ? t("dashboard.queue.transferring") : t("dashboard.queue.confirmTransfer")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
