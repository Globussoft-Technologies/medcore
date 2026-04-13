"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";

interface Doctor {
  id: string;
  user: { name: string };
  specialization: string;
}

interface Appointment {
  id: string;
  tokenNumber: number;
  date: string;
  slotStart: string | null;
  type: string;
  status: string;
  priority: string;
  patient: { user: { name: string; phone: string }; mrNumber?: string };
  doctor: { user: { name: string } };
}

interface Slot {
  startTime: string;
  endTime: string;
  isAvailable: boolean;
}

type PatientTab = "upcoming" | "past" | "cancelled";

export default function AppointmentsPage() {
  const { user } = useAuthStore();
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [showBooking, setShowBooking] = useState(false);
  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [selectedDate, setSelectedDate] = useState(
    new Date().toISOString().split("T")[0]
  );
  const [slots, setSlots] = useState<Slot[]>([]);
  const [filterDate, setFilterDate] = useState(
    new Date().toISOString().split("T")[0]
  );
  const [patientTab, setPatientTab] = useState<PatientTab>("upcoming");
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const isPatient = user?.role === "PATIENT";

  useEffect(() => {
    loadAppointments();
    loadDoctors();
  }, [filterDate]);

  async function loadAppointments() {
    setLoading(true);
    try {
      const endpoint = isPatient
        ? `/appointments?limit=200`
        : `/appointments?date=${filterDate}&limit=100`;
      const res = await api.get<{ data: Appointment[] }>(endpoint);
      setAppointments(res.data);
    } catch {
      // empty
    }
    setLoading(false);
  }

  async function loadDoctors() {
    try {
      const res = await api.get<{ data: Doctor[] }>("/doctors");
      setDoctors(res.data);
    } catch {
      // empty
    }
  }

  async function loadSlots(doctorId: string, date: string) {
    try {
      const res = await api.get<{
        data: { slots: Slot[] };
      }>(`/doctors/${doctorId}/slots?date=${date}`);
      setSlots(res.data.slots);
    } catch {
      setSlots([]);
    }
  }

  async function bookAppointment(slotStartTime: string) {
    // For simplicity, we need a patient ID. In a real flow, this would come from a patient search.
    const patientId = prompt("Enter Patient ID:");
    if (!patientId) return;

    try {
      await api.post("/appointments/book", {
        patientId,
        doctorId: selectedDoctor,
        date: selectedDate,
        slotId: slotStartTime,
      });
      alert("Appointment booked!");
      setShowBooking(false);
      loadAppointments();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Booking failed");
    }
  }

  async function updateStatus(appointmentId: string, status: string) {
    try {
      await api.patch(`/appointments/${appointmentId}/status`, { status });
      loadAppointments();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Update failed");
    }
  }

  function handleCancelClick(appointmentId: string) {
    setCancellingId(appointmentId);
  }

  async function confirmCancel() {
    if (!cancellingId) return;
    try {
      await api.patch(`/appointments/${cancellingId}/status`, {
        status: "CANCELLED",
      });
      setCancellingId(null);
      loadAppointments();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Cancel failed");
      setCancellingId(null);
    }
  }

  const statusColors: Record<string, string> = {
    BOOKED: "bg-blue-100 text-blue-700",
    CHECKED_IN: "bg-yellow-100 text-yellow-700",
    IN_CONSULTATION: "bg-green-100 text-green-700",
    COMPLETED: "bg-gray-100 text-gray-700",
    CANCELLED: "bg-red-100 text-red-700",
    NO_SHOW: "bg-gray-100 text-gray-500",
  };

  // Filter appointments for patient tabs
  const today = new Date().toISOString().split("T")[0];

  function getFilteredAppointments(): Appointment[] {
    if (!isPatient) return appointments;

    switch (patientTab) {
      case "upcoming":
        return appointments.filter(
          (a) =>
            ["BOOKED", "CHECKED_IN"].includes(a.status) && a.date >= today
        );
      case "past":
        return appointments.filter((a) => a.status === "COMPLETED");
      case "cancelled":
        return appointments.filter((a) =>
          ["CANCELLED", "NO_SHOW"].includes(a.status)
        );
      default:
        return appointments;
    }
  }

  const filteredAppointments = getFilteredAppointments();

  const tabClasses = (tab: PatientTab) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition ${
      patientTab === tab
        ? "bg-primary text-white"
        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
    }`;

  return (
    <div>
      {/* Cancel confirmation dialog */}
      {cancellingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-800">
              Cancel Appointment
            </h3>
            <p className="mt-2 text-sm text-gray-600">
              Are you sure you want to cancel this appointment? This action
              cannot be undone.
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => setCancellingId(null)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Keep Appointment
              </button>
              <button
                onClick={confirmCancel}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                Yes, Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">
          {isPatient ? "My Appointments" : "Appointments"}
        </h1>
        <div className="flex items-center gap-3">
          {!isPatient && (
            <input
              type="date"
              value={filterDate}
              onChange={(e) => setFilterDate(e.target.value)}
              className="rounded-lg border px-3 py-2 text-sm"
            />
          )}
          {(user?.role === "RECEPTION" || user?.role === "ADMIN") && (
            <button
              onClick={() => setShowBooking(!showBooking)}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
            >
              Book Appointment
            </button>
          )}
        </div>
      </div>

      {/* Patient filter tabs */}
      {isPatient && (
        <div className="mb-4 flex gap-2">
          <button
            onClick={() => setPatientTab("upcoming")}
            className={tabClasses("upcoming")}
          >
            Upcoming
          </button>
          <button
            onClick={() => setPatientTab("past")}
            className={tabClasses("past")}
          >
            Past
          </button>
          <button
            onClick={() => setPatientTab("cancelled")}
            className={tabClasses("cancelled")}
          >
            Cancelled
          </button>
        </div>
      )}

      {/* Booking form */}
      {showBooking && (
        <div className="mb-6 rounded-xl bg-white p-6 shadow-sm">
          <h2 className="mb-4 font-semibold">Book New Appointment</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-sm font-medium">Doctor</label>
              <select
                value={selectedDoctor}
                onChange={(e) => {
                  setSelectedDoctor(e.target.value);
                  if (e.target.value)
                    loadSlots(e.target.value, selectedDate);
                }}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              >
                <option value="">Select Doctor</option>
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.user.name} — {d.specialization}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Date</label>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => {
                  setSelectedDate(e.target.value);
                  if (selectedDoctor)
                    loadSlots(selectedDoctor, e.target.value);
                }}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
          </div>

          {slots.length > 0 && (
            <div className="mt-4">
              <p className="mb-2 text-sm font-medium">Available Slots:</p>
              <div className="flex flex-wrap gap-2">
                {slots.map((slot) => (
                  <button
                    key={slot.startTime}
                    disabled={!slot.isAvailable}
                    onClick={() => bookAppointment(slot.startTime)}
                    className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                      slot.isAvailable
                        ? "bg-green-50 text-green-700 hover:bg-green-100"
                        : "cursor-not-allowed bg-gray-100 text-gray-400 line-through"
                    }`}
                  >
                    {slot.startTime} - {slot.endTime}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Appointments list */}
      <div className="rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : filteredAppointments.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            {isPatient
              ? patientTab === "upcoming"
                ? "No upcoming appointments"
                : patientTab === "past"
                  ? "No past appointments"
                  : "No cancelled appointments"
              : "No appointments for this date"}
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500">
                <th className="px-4 py-3">Token</th>
                {!isPatient && <th className="px-4 py-3">Patient</th>}
                <th className="px-4 py-3">Doctor</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredAppointments.map((apt) => (
                <tr key={apt.id} className="border-b last:border-0">
                  <td className="px-4 py-3 font-bold">{apt.tokenNumber}</td>
                  {!isPatient && (
                    <td className="px-4 py-3">
                      <p className="font-medium">{apt.patient.user.name}</p>
                      <p className="text-xs text-gray-500">
                        {apt.patient.user.phone}
                      </p>
                    </td>
                  )}
                  <td className="px-4 py-3 text-sm">{apt.doctor.user.name}</td>
                  <td className="px-4 py-3 text-sm">{apt.date}</td>
                  <td className="px-4 py-3 text-sm">
                    {apt.slotStart || "Walk-in"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${
                        apt.type === "WALK_IN"
                          ? "bg-orange-100 text-orange-700"
                          : "bg-blue-100 text-blue-700"
                      }`}
                    >
                      {apt.type === "WALK_IN" ? "Walk-in" : "Scheduled"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[apt.status] || ""}`}
                    >
                      {apt.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2">
                      {/* Cancel button for PATIENT, RECEPTION, ADMIN on BOOKED appointments */}
                      {apt.status === "BOOKED" &&
                        (isPatient ||
                          user?.role === "RECEPTION" ||
                          user?.role === "ADMIN") && (
                          <button
                            onClick={() => handleCancelClick(apt.id)}
                            className="rounded bg-red-500 px-2 py-1 text-xs text-white hover:bg-red-600"
                          >
                            Cancel
                          </button>
                        )}
                      {/* Staff action buttons */}
                      {!isPatient && apt.status === "BOOKED" && (
                        <button
                          onClick={() => updateStatus(apt.id, "CHECKED_IN")}
                          className="rounded bg-yellow-500 px-2 py-1 text-xs text-white hover:bg-yellow-600"
                        >
                          Check In
                        </button>
                      )}
                      {!isPatient && apt.status === "CHECKED_IN" && (
                        <button
                          onClick={() =>
                            updateStatus(apt.id, "IN_CONSULTATION")
                          }
                          className="rounded bg-green-500 px-2 py-1 text-xs text-white hover:bg-green-600"
                        >
                          Start Consult
                        </button>
                      )}
                      {!isPatient && apt.status === "IN_CONSULTATION" && (
                        <button
                          onClick={() => updateStatus(apt.id, "COMPLETED")}
                          className="rounded bg-gray-500 px-2 py-1 text-xs text-white hover:bg-gray-600"
                        >
                          Complete
                        </button>
                      )}
                    </div>
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
