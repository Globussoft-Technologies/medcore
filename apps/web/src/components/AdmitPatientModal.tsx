"use client";

// Self-contained "Admit patient" modal. Opened in-place from the patient
// profile (and any other surface) so admitting doesn't navigate away to the
// Admissions list. Loads doctors + wards/beds itself, submits POST
// /admissions, and calls onAdmitted() on success. The patient is fixed
// (passed in) — no search/change, since the caller already knows who.

import { useEffect, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { getBedSummary } from "@/lib/bed-summary";

interface Doctor {
  id: string;
  user: { name: string };
  specialization: string;
}

interface Bed {
  id: string;
  bedNumber: string;
  status: string;
}

interface Ward {
  id: string;
  name: string;
  beds?: Bed[];
}

interface AdmitPatientModalProps {
  patient: { id: string; name: string; mrNumber: string };
  onClose: () => void;
  /** Fired after a successful admission so the caller can refresh. */
  onAdmitted?: () => void;
}

export function AdmitPatientModal({
  patient,
  onClose,
  onAdmitted,
}: AdmitPatientModalProps) {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [wards, setWards] = useState<Ward[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    doctorId: "",
    bedId: "",
    reason: "",
    diagnosis: "",
  });

  // Load doctors + fresh ward/bed census on open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [dRes, wRes] = await Promise.all([
          api.get<{ data: Doctor[] }>("/doctors"),
          api.get<{ data: Ward[] }>("/wards"),
        ]);
        if (cancelled) return;
        setDoctors(dRes.data || []);
        setWards(wRes.data || []);
      } catch {
        // leave dropdowns empty — the empty-bed guard below still shows.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const bedSummary = getBedSummary(wards);
  const bedsUnavailable = wards.length > 0 && bedSummary.available === 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.doctorId) {
      toast.error("Select a doctor");
      return;
    }
    if (!form.bedId) {
      toast.error("Select a bed");
      return;
    }
    if (!form.reason.trim()) {
      toast.error("Enter a reason for admission");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/admissions", {
        patientId: patient.id,
        doctorId: form.doctorId,
        bedId: form.bedId,
        reason: form.reason,
        diagnosis: form.diagnosis || undefined,
      });
      toast.success("Patient admitted");
      onAdmitted?.();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Admission failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl dark:bg-gray-800 dark:ring-1 dark:ring-white/10">
        {/* Header — title + X close, matching the Book Appointment modal. */}
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3 dark:border-white/10">
          <h3 className="font-semibold text-gray-900 dark:text-gray-100">
            Admit Patient
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200"
          >
            <X size={18} />
          </button>
        </div>
        <form onSubmit={submit} noValidate data-testid="admit-patient-modal">
          <div className="max-h-[80vh] space-y-4 overflow-y-auto p-5">
          {/* Patient — fixed (caller-supplied), shown read-only. */}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Patient
            </label>
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
              <strong>{patient.name}</strong> — {patient.mrNumber}
            </div>
          </div>

          <div>
            <label
              htmlFor="admit-doctor-select"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Doctor
            </label>
            <select
              id="admit-doctor-select"
              aria-label="Doctor"
              value={form.doctorId}
              onChange={(e) => setForm({ ...form, doctorId: e.target.value })}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
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
            <label
              htmlFor="admit-bed-select"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Available Bed
            </label>
            {bedsUnavailable ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
                No beds available. Free a bed from the{" "}
                <Link
                  href="/dashboard/wards"
                  className="font-medium underline hover:text-amber-900"
                >
                  ward management page
                </Link>{" "}
                before admitting a patient.
              </div>
            ) : (
              <select
                id="admit-bed-select"
                aria-label="Available Bed"
                value={form.bedId}
                onChange={(e) => setForm({ ...form, bedId: e.target.value })}
                data-testid="admit-bed-select"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              >
                <option value="">Select Bed</option>
                {(Array.isArray(wards) ? wards : []).map((w) => (
                  <optgroup key={w.id} label={w.name}>
                    {(Array.isArray(w.beds) ? w.beds : [])
                      .filter((b) => b?.status === "AVAILABLE")
                      .map((b) => (
                        <option key={b.id} value={b.id}>
                          {w.name} / Bed {b.bedNumber}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            )}
          </div>

          <div>
            <label
              htmlFor="admit-reason"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Reason for Admission
            </label>
            <textarea
              id="admit-reason"
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              rows={2}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>

          <div>
            <label
              htmlFor="admit-diagnosis"
              className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              Diagnosis (optional)
            </label>
            <input
              id="admit-diagnosis"
              value={form.diagnosis}
              onChange={(e) => setForm({ ...form, diagnosis: e.target.value })}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
        </div>

          <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-3 dark:border-white/10">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || bedsUnavailable}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
            >
              {submitting ? "Admitting…" : "Admit Patient"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
