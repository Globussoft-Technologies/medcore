"use client";

import React, { useState } from "react";
import { usePathname } from "next/navigation";
import { HelpCircle, X } from "lucide-react";

const PAGE_HELP: Record<string, { title: string; bullets: string[] }> = {
  "/dashboard": {
    title: "Dashboard",
    bullets: [
      "View KPIs and key metrics for today",
      "Jump to common workflows from the quick links",
      "Use Ctrl+K for global search",
    ],
  },
  "/dashboard/appointments": {
    title: "Appointments",
    bullets: [
      "Book, reschedule and cancel appointments",
      "Filter by doctor, status, or date range",
      "Press 'n' to start a new booking",
    ],
  },
  "/dashboard/patients": {
    title: "Patients",
    bullets: [
      "Search and register patients",
      "View full medical history and visits",
      "Manage demographics and insurance",
    ],
  },
  "/dashboard/queue": {
    title: "Queue",
    bullets: [
      "See the live token queue per doctor",
      "Call the next patient or mark no-show",
      "Display board updates in real-time",
    ],
  },
  "/dashboard/wards": {
    title: "Wards",
    bullets: [
      "View bed occupancy across wards",
      "Updates live as patients are admitted/discharged",
      "Click a bed to see assigned patient",
    ],
  },
  "/dashboard/admissions": {
    title: "Admissions",
    bullets: [
      "Admit new patients to a bed",
      "Discharge or transfer between beds",
      "Record vitals, intake/output and rounds",
    ],
  },
  "/dashboard/medication-dashboard": {
    title: "Medication Dashboard",
    bullets: [
      "See medications due now and overdue",
      "Administer with one click and capture witness",
      "Filters by ward, patient or order",
    ],
  },
  "/dashboard/ot": {
    title: "Operating Theatre",
    bullets: [
      "Live OT board with surgery status",
      "Update phases (Wheel-in, Anaesthesia, Cut, Close)",
      "Real-time updates across all viewers",
    ],
  },
  "/dashboard/surgery": {
    title: "Surgery",
    bullets: [
      "Schedule surgeries and pre-op checklists",
      "Track post-op notes and complications",
      "Link to consent forms",
    ],
  },
  "/dashboard/lab": {
    title: "Lab",
    bullets: [
      "Order tests with autocomplete",
      "Record results and flag critical values",
      "TAT (Turnaround Time) is tracked per test",
    ],
  },
  "/dashboard/pharmacy": {
    title: "Pharmacy",
    bullets: [
      "Dispense prescriptions and track inventory",
      "Stock follows FEFO (First Expiry First Out)",
      "Low-stock and expiry alerts surface here",
    ],
  },
  "/dashboard/billing": {
    title: "Billing",
    bullets: [
      "Generate invoices from visits and admissions",
      "Accept multiple payment methods",
      "Apply discounts (admin-approved)",
    ],
  },
  "/dashboard/prescriptions": {
    title: "Prescriptions",
    bullets: [
      "Write prescriptions with ICD-10 and medicine autocomplete",
      "Past prescriptions surface for refills",
      "Print or share via patient portal",
    ],
  },
  "/dashboard/emergency": {
    title: "Emergency",
    bullets: [
      "Triage cases with GCS, MEWS, RTS scores",
      "Assign priority and notify on-call doctors",
      "Real-time updates as cases progress",
    ],
  },
  "/dashboard/telemedicine": {
    title: "Telemedicine",
    bullets: [
      "Start or join scheduled video consults",
      "In-call notes write back to the patient record",
      "Secure peer-to-peer connection",
    ],
  },
  "/dashboard/walk-in": {
    title: "Walk-in",
    bullets: [
      "Register walk-in patients quickly",
      "Auto-issues a queue token",
      "Useful for outpatient visits",
    ],
  },
  "/dashboard/visitors": {
    title: "Visitors",
    bullets: [
      "Issue and revoke visitor passes",
      "Search by patient or visitor name",
      "Track currently checked-in visitors",
    ],
  },
  "/dashboard/notifications": {
    title: "Notifications",
    bullets: [
      "Critical alerts and system messages",
      "Mark as read or clear",
      "Filtered by relevance to your role",
    ],
  },
  "/dashboard/analytics": {
    title: "Analytics",
    bullets: [
      "Cross-module insights and trends",
      "Filter by time range",
      "Export charts as images or CSV",
    ],
  },
  "/dashboard/audit": {
    title: "Audit Log",
    bullets: [
      "Every sensitive action is recorded",
      "Filter by user, action and time",
      "Cannot be edited or deleted",
    ],
  },
};

const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: "Ctrl+K", label: "Open global search" },
  { keys: "?", label: "Show keyboard shortcuts" },
  { keys: "g h", label: "Go to Dashboard" },
  { keys: "g a", label: "Go to Appointments" },
  { keys: "g p", label: "Go to Patients" },
  { keys: "g q", label: "Go to Queue" },
  { keys: "n", label: "New (context aware)" },
  { keys: "Esc", label: "Close modal / drawer" },
];

export function HelpPanel({ onStartTour }: { onStartTour?: () => void }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() || "";

  const entry =
    PAGE_HELP[pathname] ||
    PAGE_HELP[
      Object.keys(PAGE_HELP).find((k) => k !== "/dashboard" && pathname.startsWith(k)) || ""
    ] ||
    PAGE_HELP["/dashboard"];

  return (
    <>
      <button
        type="button"
        aria-label="Open help"
        title="Help"
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-white shadow-lg transition hover:bg-primary-dark focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
      >
        <HelpCircle size={22} aria-hidden="true" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/30"
          role="dialog"
          aria-modal="true"
          aria-label="Help panel"
          onClick={() => setOpen(false)}
        >
          <aside
            className="h-full w-full max-w-sm overflow-y-auto bg-white shadow-2xl dark:bg-gray-800"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Help
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close help"
                className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </header>

            <div className="space-y-6 p-5">
              <section>
                <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  What you can do here
                </h3>
                <p className="mt-1 text-base font-medium text-gray-900 dark:text-gray-100">
                  {entry.title}
                </p>
                <ul className="mt-2 space-y-1.5 text-sm text-gray-600 dark:text-gray-300">
                  {entry.bullets.map((b, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  Keyboard shortcuts
                </h3>
                <dl className="mt-2 space-y-1 text-sm">
                  {SHORTCUTS.map((s) => (
                    <div
                      key={s.keys}
                      className="flex items-center justify-between"
                    >
                      <dt className="text-gray-600 dark:text-gray-300">
                        {s.label}
                      </dt>
                      <dd>
                        <kbd className="rounded bg-gray-100 px-2 py-0.5 text-xs font-mono text-gray-700 dark:bg-gray-700 dark:text-gray-200">
                          {s.keys}
                        </kbd>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>

              <section className="space-y-2">
                {onStartTour && (
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onStartTour();
                    }}
                    className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
                  >
                    Take the tour
                  </button>
                )}
                <a
                  href="https://docs.medcore.example.com"
                  target="_blank"
                  rel="noreferrer"
                  className="block w-full rounded-lg border border-gray-300 px-4 py-2 text-center text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                  Open full documentation
                </a>
              </section>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

export default HelpPanel;
