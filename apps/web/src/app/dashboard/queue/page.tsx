"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { getSocket } from "@/lib/socket";

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
  const [display, setDisplay] = useState<QueueDoctor[]>([]);
  const [selectedDoctor, setSelectedDoctor] = useState<string | null>(null);
  const [doctorQueue, setDoctorQueue] = useState<DoctorQueue | null>(null);
  const [loading, setLoading] = useState(true);

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
    BOOKED: "bg-blue-50 border-blue-200",
    CHECKED_IN: "bg-yellow-50 border-yellow-200",
    IN_CONSULTATION: "bg-green-50 border-green-300",
    COMPLETED: "bg-gray-50 border-gray-200",
  };

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Live Queue</h1>

      {/* Token display board */}
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {loading ? (
          <div className="col-span-3 text-center text-gray-500">
            Loading...
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
                  ? "border-primary bg-blue-50"
                  : "border-gray-200 bg-white hover:border-primary/50"
              }`}
            >
              <p className="font-semibold text-gray-900">{doc.doctorName}</p>
              <p className="text-sm text-gray-500">{doc.specialization}</p>
              <div className="mt-4 flex items-center justify-between">
                <div>
                  <p className="text-xs text-gray-500">Current Token</p>
                  <p className="text-4xl font-bold text-primary">
                    {doc.currentToken ?? "—"}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-gray-500">Waiting</p>
                  <p className="text-2xl font-bold text-gray-700">
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
        <div className="rounded-xl bg-white p-6 shadow-sm">
          <h2 className="mb-4 font-semibold">Queue Detail</h2>
          {doctorQueue.queue.length === 0 ? (
            <p className="text-gray-500">No patients in queue</p>
          ) : (
            <div className="space-y-2">
              {doctorQueue.queue.map((entry) => (
                <div
                  key={entry.appointmentId}
                  className={`flex items-center justify-between rounded-lg border p-4 ${statusColors[entry.status] || "bg-white"}`}
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
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
