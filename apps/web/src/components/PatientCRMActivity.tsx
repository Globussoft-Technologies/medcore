// Pearl ERP Stage 1 §7.1 (gap row 183) — CRM History section for the
// doctor's patient-detail page.
//
// What: read-only timeline of the originating Lead (source, dates) + the
//       last 5 LeadActivity rows when the patient was converted from a
//       lead. Empty-state when no Lead links to the patient (the common
//       case for walk-in patients).
//
// Which modules: GET /api/v1/leads/by-patient/:patientId (apps/api
//                /src/routes/leads.ts) + apps/web/src/app/dashboard
//                /patients/[id]/page.tsx (which renders this component).
//
// Why: closes the "CRM activity on a patient" surface called out in the
//      Pearl SOW §7.1 doctor view. Pre-fix doctors had no visibility into
//      WHY a patient is on the books (which marketing source, what was
//      promised on the intake call, who the assigned salesperson was).
//      Now visible to DOCTOR + ADMIN + RECEPTION; hidden from PATIENT
//      (PII / sales-context separation).

"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { TrendingUp, Calendar, User as UserIcon } from "lucide-react";

interface LeadActivity {
  id: string;
  type: string;
  body: string | null;
  createdAt: string;
  authorUser?: { id: string; name: string; role: string } | null;
}

interface CRMLead {
  id: string;
  name: string;
  source: string;
  status: string;
  createdAt: string;
  convertedAt: string | null;
  notes: string | null;
  assignedToUser?: { id: string; name: string; role: string } | null;
  activities: LeadActivity[];
}

// Source-pill palette — keeps WCAG AA in both light + dark mode.
const SOURCE_COLORS: Record<string, string> = {
  WEB: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200",
  WHATSAPP: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-200",
  PHONE: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  REFERRAL: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-200",
  WALK_IN: "bg-gray-100 text-gray-700 dark:bg-gray-700/50 dark:text-gray-200",
  CAMP: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-200",
  GOOGLE_ADS: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200",
  FACEBOOK_ADS: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200",
  OTHER: "bg-gray-100 text-gray-700 dark:bg-gray-700/50 dark:text-gray-200",
};

function sourceClass(source: string): string {
  return SOURCE_COLORS[source] || SOURCE_COLORS.OTHER;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function PatientCRMActivity({ patientId }: { patientId: string }) {
  const { user } = useAuthStore();
  const role = user?.role;
  const isStaff =
    role === "DOCTOR" || role === "ADMIN" || role === "RECEPTION" || role === "NURSE";

  const [lead, setLead] = useState<CRMLead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!isStaff) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setNotFound(false);
      try {
        const res = await api.get<{ data: CRMLead }>(
          `/leads/by-patient/${patientId}`,
        );
        if (cancelled) return;
        setLead(res.data);
      } catch (e: unknown) {
        if (cancelled) return;
        // The endpoint returns 404 when no lead links to the patient —
        // that's the "walk-in / not from a lead" case, render the
        // empty-state rather than a red error banner.
        const msg = e instanceof Error ? e.message : String(e);
        if (/404|not found|No lead/i.test(msg)) {
          setNotFound(true);
        } else {
          setError(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId, isStaff]);

  // PATIENT role never sees CRM history (PII / sales-context separation).
  if (!isStaff) return null;

  return (
    <section
      data-testid="patient-crm-history"
      className="mb-4 rounded-xl bg-white p-6 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100"
      aria-label="CRM History"
    >
      <div className="mb-3 flex items-center gap-2">
        <TrendingUp size={18} className="text-primary" aria-hidden="true" />
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          CRM History
        </h2>
      </div>

      {loading && (
        <div
          data-testid="patient-crm-loading"
          className="space-y-2"
          aria-busy="true"
        >
          <div className="h-4 w-2/3 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
          <div className="h-4 w-1/3 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
        </div>
      )}

      {!loading && error && (
        <p
          data-testid="patient-crm-error"
          className="text-sm text-red-700 dark:text-red-300"
          role="alert"
        >
          Could not load CRM history: {error}
        </p>
      )}

      {!loading && !error && notFound && (
        <p
          data-testid="patient-crm-empty"
          className="text-sm text-gray-600 dark:text-gray-300"
        >
          No CRM history. This patient was not converted from a lead.
        </p>
      )}

      {!loading && !error && lead && (
        <div className="space-y-4">
          {/* Lead header row */}
          <div className="flex flex-wrap items-center gap-3">
            <span
              data-testid="patient-crm-source"
              className={`inline-flex min-h-[44px] items-center rounded-full px-3 py-2 text-xs font-semibold ${sourceClass(lead.source)}`}
            >
              Source: {lead.source.replace(/_/g, " ")}
            </span>
            <span className="text-sm text-gray-600 dark:text-gray-300">
              <Calendar
                size={14}
                className="mr-1 inline-block align-text-bottom"
                aria-hidden="true"
              />
              Lead created {fmtDate(lead.createdAt)}
            </span>
            {lead.convertedAt && (
              <span
                data-testid="patient-crm-converted-at"
                className="text-sm text-gray-600 dark:text-gray-300"
              >
                <Calendar
                  size={14}
                  className="mr-1 inline-block align-text-bottom"
                  aria-hidden="true"
                />
                Converted {fmtDate(lead.convertedAt)}
              </span>
            )}
            {lead.assignedToUser && (
              <span className="text-sm text-gray-600 dark:text-gray-300">
                <UserIcon
                  size={14}
                  className="mr-1 inline-block align-text-bottom"
                  aria-hidden="true"
                />
                Assigned to {lead.assignedToUser.name}
              </span>
            )}
          </div>

          {/* Activity timeline (last 5) */}
          <div>
            <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
              Recent Activity
            </h3>
            {lead.activities.length === 0 ? (
              <p
                data-testid="patient-crm-no-activities"
                className="text-sm text-gray-500 dark:text-gray-400"
              >
                No activity recorded yet.
              </p>
            ) : (
              <ol
                data-testid="patient-crm-activities"
                className="space-y-2 border-l-2 border-gray-200 pl-4 dark:border-gray-700"
              >
                {lead.activities.slice(0, 5).map((a) => (
                  <li
                    key={a.id}
                    data-testid="patient-crm-activity-row"
                    className="text-sm"
                  >
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-medium text-gray-900 dark:text-gray-100">
                        {a.type.replace(/_/g, " ")}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {fmtDateTime(a.createdAt)}
                      </span>
                      {a.authorUser && (
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          by {a.authorUser.name}
                        </span>
                      )}
                    </div>
                    {a.body && (
                      <p className="mt-0.5 text-gray-700 dark:text-gray-300">
                        {a.body}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
