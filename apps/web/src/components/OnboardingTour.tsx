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

// Legacy role-keyed storage. Kept for the "have you ever seen the tour" check
// and as a fallback when the caller hasn't supplied a userId.
export function tourStorageKey(role: string) {
  return `mc_tour_${role}`;
}

// Issue #122: Skip flag is persisted globally (per user id, not per role)
// so that hitting Skip on one page doesn't let the tour pop back up when
// the user navigates to a sibling route. The previous behaviour wrote a
// per-role completion flag at finish time but the skip path was effectively
// re-evaluated on every layout mount because a number of pages reset it.
export function onboardingSkipKey(userId: string) {
  return `medcore_onboarding_skipped:${userId}`;
}

// Issue #502: the per-user-id skip flag relied on `userId` being defined at
// the moment Skip was clicked. In practice the `OnboardingTour` is rendered
// from `dashboard/layout.tsx` and `user.id` can be `undefined` for a brief
// window during session hydration / refresh, which made `markOnboardingSkipped`
// a no-op and let the tour reopen on the next dashboard visit even though
// `mc_tour_<ROLE>` had been written. The v1 key is global, single-string,
// independent of role and of user-id, so the click-to-skip path always
// successfully persists. Legacy keys are still honoured on read for users
// who already dismissed the tour before this fix shipped.
export const TOUR_COMPLETED_V1_KEY = "medcore_tour_completed_v1";

export function hasSkippedOnboarding(userId?: string | null): boolean {
  if (typeof window === "undefined") return false;
  if (!userId) return false;
  return localStorage.getItem(onboardingSkipKey(userId)) === "1";
}

export function markOnboardingSkipped(userId?: string | null) {
  if (typeof window === "undefined") return;
  if (!userId) return;
  localStorage.setItem(onboardingSkipKey(userId), "1");
}

export function clearOnboardingSkipped(userId?: string | null) {
  if (typeof window === "undefined") return;
  if (!userId) return;
  localStorage.removeItem(onboardingSkipKey(userId));
}

// Issue #502: read the global v1 flag. Returns true if the user has ever
// completed or skipped the tour, regardless of role and regardless of whether
// userId was known at the moment of skip.
function hasCompletedTourV1(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(TOUR_COMPLETED_V1_KEY) === "true";
}

function markTourCompletedV1() {
  if (typeof window === "undefined") return;
  localStorage.setItem(TOUR_COMPLETED_V1_KEY, "true");
}

function clearTourCompletedV1() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(TOUR_COMPLETED_V1_KEY);
}

export function hasCompletedTour(role: string, userId?: string | null): boolean {
  if (typeof window === "undefined") return true;
  // Issue #502: the global v1 flag is the source of truth going forward; the
  // per-user-id and per-role checks below remain only as backwards-compat
  // for sessions that dismissed the tour before this fix landed.
  if (hasCompletedTourV1()) return true;
  // Either an explicit Skip OR a finished tour suppresses the auto-launch.
  if (hasSkippedOnboarding(userId)) return true;
  return !!localStorage.getItem(tourStorageKey(role));
}

export function markTourCompleted(role: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(tourStorageKey(role), "1");
  // Issue #502: also write the global v1 flag so the auto-launch suppression
  // does not depend on role-keyed storage being read with the same role on
  // subsequent visits (which was the underlying flake mode).
  markTourCompletedV1();
}

export function resetTour(role: string, userId?: string | null) {
  if (typeof window === "undefined") return;
  localStorage.removeItem(tourStorageKey(role));
  // Clear the skip flag too so the manual "Take a tour" button can re-open
  // the dialog after a previous skip.
  clearOnboardingSkipped(userId);
  // Issue #502: clear the v1 flag as well, otherwise the explicit "Take the
  // tour" button in the sidebar would never be able to re-launch the tour.
  clearTourCompletedV1();
}

export function OnboardingTour({
  role,
  open,
  onClose,
  userId,
}: {
  role: string;
  open: boolean;
  onClose: () => void;
  /**
   * Issue #122: optional user id used to persist the "skipped" flag
   * globally so the tour does not reappear on sibling routes after Skip.
   * Falls back to the legacy role-keyed completion flag when absent.
   */
  userId?: string | null;
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
    // Issue #122: persist a per-user "skipped" flag so navigating to a
    // sibling page (which remounts the layout) doesn't auto-launch the
    // tour again. Also marks the role completion flag so the legacy
    // hasCompletedTour() check passes for the same session.
    markOnboardingSkipped(userId);
    // Issue #502: markTourCompleted now also writes the global v1 flag —
    // this is the only path that reliably survives `userId` being undefined
    // at click time (the user reported the tour reappearing on every
    // /dashboard visit despite mc_tour_<role> being '1', which is exactly
    // the symptom of `markOnboardingSkipped` being a no-op).
    markTourCompleted(role);
    onClose();
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
