"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";

export type TourStep = {
  title: string;
  body: string;
  href?: string;
  target?: string; // CSS selector to highlight (optional)
};

const tours: Record<string, TourStep[]> = {
  ADMIN: [
    { title: "Dashboard", body: "Your command center with KPIs and quick links.", href: "/dashboard" },
    { title: "Analytics", body: "Drill into hospital-wide trends and reports.", href: "/dashboard/analytics" },
    { title: "Users", body: "Manage staff accounts, roles, and permissions.", href: "/dashboard/users" },
    { title: "Settings", body: "Configure modules from the Admin Console.", href: "/dashboard/admin-console" },
    { title: "Audit Log", body: "Track every sensitive action in the system.", href: "/dashboard/audit" },
  ],
  DOCTOR: [
    { title: "Workspace", body: "Today's patients, queue and quick actions all in one place.", href: "/dashboard/workspace" },
    { title: "Queue", body: "See and call the next patient from your live queue.", href: "/dashboard/queue" },
    { title: "Prescriptions", body: "Write and review prescriptions with autocomplete.", href: "/dashboard/prescriptions" },
    { title: "Telemedicine", body: "Start a video consultation in one click.", href: "/dashboard/telemedicine" },
    { title: "Schedule", body: "Manage your availability and appointments.", href: "/dashboard/schedule" },
  ],
  NURSE: [
    { title: "Workstation", body: "Tasks, vitals due and patient handoffs at a glance.", href: "/dashboard/workstation" },
    { title: "Medication Dashboard", body: "Administer due meds and track MAR.", href: "/dashboard/medication-dashboard" },
    { title: "Vitals", body: "Record vitals quickly with NEWS/MEWS scoring.", href: "/dashboard/vitals" },
    { title: "Admissions", body: "View admitted patients and bed assignments.", href: "/dashboard/admissions" },
    { title: "Emergency", body: "Triage and manage ER cases.", href: "/dashboard/emergency" },
  ],
  RECEPTION: [
    { title: "Dashboard", body: "Today's reception KPIs and shortcuts.", href: "/dashboard" },
    { title: "Appointments", body: "Book, reschedule and check-in patients.", href: "/dashboard/appointments" },
    { title: "Walk-in", body: "Register walk-in patients in seconds.", href: "/dashboard/walk-in" },
    { title: "Billing", body: "Generate invoices and accept payments.", href: "/dashboard/billing" },
    { title: "Visitors", body: "Manage hospital visitor passes.", href: "/dashboard/visitors" },
  ],
  PATIENT: [
    { title: "Home", body: "Your personalised health portal.", href: "/dashboard" },
    { title: "Appointments", body: "Book or join your next consult.", href: "/dashboard/appointments" },
    { title: "Prescriptions", body: "Download active prescriptions.", href: "/dashboard/prescriptions" },
    { title: "Bills", body: "View and pay your hospital bills.", href: "/dashboard/billing" },
    { title: "Notifications", body: "Stay updated on results and reminders.", href: "/dashboard/notifications" },
  ],
};

export function tourStorageKey(role: string) {
  return `mc_tour_${role}`;
}

export function hasCompletedTour(role: string): boolean {
  if (typeof window === "undefined") return true;
  return !!localStorage.getItem(tourStorageKey(role));
}

export function markTourCompleted(role: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(tourStorageKey(role), "1");
}

export function resetTour(role: string) {
  if (typeof window === "undefined") return;
  localStorage.removeItem(tourStorageKey(role));
}

export function OnboardingTour({
  role,
  open,
  onClose,
}: {
  role: string;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const steps = tours[role] || tours.PATIENT;

  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  const finish = useCallback(() => {
    markTourCompleted(role);
    onClose();
  }, [role, onClose]);

  if (!open) return null;
  const current = steps[step];

  const next = () => {
    if (step >= steps.length - 1) {
      finish();
      return;
    }
    const ns = steps[step + 1];
    if (ns?.href) router.push(ns.href);
    setStep(step + 1);
  };

  const skip = () => {
    finish();
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Product tour"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-gray-800">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wider text-primary">
            Step {step + 1} of {steps.length}
          </span>
          <button
            type="button"
            onClick={skip}
            className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          >
            Skip tour
          </button>
        </div>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          {current.title}
        </h2>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          {current.body}
        </p>
        <div className="mt-4 flex items-center gap-1.5">
          {steps.map((_, i) => (
            <span
              key={i}
              className={
                "h-1.5 rounded-full transition-all " +
                (i === step ? "w-6 bg-primary" : "w-1.5 bg-gray-300 dark:bg-gray-600")
              }
            />
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          {step > 0 && (
            <button
              type="button"
              onClick={() => setStep(step - 1)}
              className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={next}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            {step >= steps.length - 1 ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default OnboardingTour;
