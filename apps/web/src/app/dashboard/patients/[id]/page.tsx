"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api, openPrintEndpoint } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { formatDoctorName } from "@/lib/format-doctor-name";
import { toast } from "@/lib/toast";
import { useConfirm, usePrompt } from "@/lib/use-dialog";
import { useTranslation } from "@/lib/i18n";
import { PatientEditModal } from "@/components/PatientEditModal";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  User,
  Phone,
  Mail,
  Activity,
  FileText,
  CreditCard,
  AlertTriangle,
  Heart,
  Users,
  Syringe,
  FolderOpen,
  Plus,
  Trash2,
  Download,
  Upload,
  X,
  Calendar,
  Stethoscope,
  BedDouble,
  FlaskConical,
  Scissors,
  Siren,
  TrendingUp,
  Receipt,
  Pill,
  ClipboardList,
  Printer,
  AlertCircle,
  Edit as EditIcon,
} from "lucide-react";

// ───────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────

interface PatientDetail {
  id: string;
  mrNumber: string;
  age: number | null;
  gender: string;
  dateOfBirth?: string | null;
  bloodGroup: string | null;
  address: string | null;
  insuranceProvider: string | null;
  insuranceId: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  noShowCount?: number;
  pricingTier?: string | null;
  user: { id: string; name: string; email: string; phone: string };
}

const PRICING_TIERS = [
  "STANDARD",
  "EMPLOYEE",
  "SENIOR_CITIZEN",
  "BPL",
  "VIP",
] as const;

const TIER_COLORS: Record<string, string> = {
  STANDARD: "bg-gray-100 text-gray-700",
  EMPLOYEE: "bg-blue-100 text-blue-700",
  SENIOR_CITIZEN: "bg-teal-100 text-teal-700",
  BPL: "bg-orange-100 text-orange-700",
  VIP: "bg-purple-100 text-purple-700",
};

interface VisitRecord {
  id: string;
  date: string;
  status: string;
  doctor: { user: { name: string }; specialization: string };
  diagnosis: string | null;
  vitals?: {
    bloodPressure: string | null;
    heartRate: number | null;
    temperature: number | null;
    weight: number | null;
    oxygenSaturation: number | null;
  } | null;
  prescription?: {
    items: Array<{
      medication: string;
      dosage: string;
      frequency: string;
      duration: string;
    }>;
  } | null;
  invoice?: {
    invoiceNumber: string;
    totalAmount: number;
    paymentStatus: string;
  } | null;
}

interface Allergy {
  id: string;
  allergen: string;
  severity: "MILD" | "MODERATE" | "SEVERE" | "LIFE_THREATENING";
  reaction: string | null;
  notes: string | null;
  notedAt: string;
}

interface Condition {
  id: string;
  condition: string;
  icd10Code: string | null;
  diagnosedDate: string | null;
  status: "ACTIVE" | "CONTROLLED" | "RESOLVED" | "RELAPSED";
  notes: string | null;
}

interface FamilyHist {
  id: string;
  relation: string;
  condition: string;
  notes: string | null;
}

interface Immunization {
  id: string;
  vaccine: string;
  doseNumber: number | null;
  dateGiven: string;
  nextDueDate: string | null;
  batchNumber: string | null;
  manufacturer: string | null;
  site: string | null;
  notes: string | null;
}

interface PatientDoc {
  id: string;
  type: string;
  title: string;
  fileSize: number | null;
  mimeType: string | null;
  createdAt: string;
  notes: string | null;
}

interface PatientStats {
  totalVisits: number;
  lastVisitDate: string | null;
  totalSpent: number;
  activeConditionsCount: number;
  activeAllergiesCount: number;
  upcomingAppointments: number;
  pendingBills: number;
  currentAdmissionId: string | null;
  currentAdmissionNumber: string | null;
}

interface TimelineEntry {
  id: string;
  type: string;
  title: string;
  description: string;
  timestamp: string;
  icon: string;
  color: string;
  link: string | null;
}

interface VitalsTrendPoint {
  recordedAt: string;
  bloodPressureSystolic: number | null;
  bloodPressureDiastolic: number | null;
  temperature: number | null;
  pulseRate: number | null;
  spO2: number | null;
  weight: number | null;
}

interface InvoiceLine {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  paymentStatus: string;
  createdAt: string;
  items: Array<{ id: string; description?: string; amount?: number }>;
  payments: Array<{ id: string; amount: number; method?: string; paidAt?: string }>;
  appointment?: {
    doctor?: { user?: { name?: string } };
  };
}

interface LabOrderFull {
  id: string;
  orderNumber: string;
  status: string;
  orderedAt: string;
  collectedAt: string | null;
  completedAt: string | null;
  notes: string | null;
  doctor?: { user?: { name?: string } };
  items: Array<{
    id: string;
    status: string;
    test: { id: string; code: string; name: string; category: string | null; normalRange: string | null };
    results: Array<{
      id: string;
      parameter: string;
      value: string;
      unit: string | null;
      normalRange: string | null;
      flag: "NORMAL" | "LOW" | "HIGH" | "CRITICAL";
      notes: string | null;
      reportedAt: string;
    }>;
  }>;
}

// ───────────────────────────────────────────────────────
// Color helpers
// ───────────────────────────────────────────────────────

const severityColors: Record<Allergy["severity"], string> = {
  MILD: "bg-yellow-100 text-yellow-800",
  MODERATE: "bg-orange-100 text-orange-800",
  SEVERE: "bg-red-100 text-red-700",
  LIFE_THREATENING: "bg-red-800 text-white",
};

const conditionColors: Record<Condition["status"], string> = {
  ACTIVE: "bg-red-100 text-red-700",
  CONTROLLED: "bg-yellow-100 text-yellow-800",
  RESOLVED: "bg-green-100 text-green-700",
  RELAPSED: "bg-orange-100 text-orange-800",
};

const DOC_TYPES = [
  "LAB_REPORT",
  "IMAGING",
  "DISCHARGE_SUMMARY",
  "CONSENT",
  "INSURANCE",
  "REFERRAL_LETTER",
  "ID_PROOF",
  "OTHER",
] as const;

const labFlagColors: Record<string, string> = {
  NORMAL: "bg-green-100 text-green-700",
  LOW: "bg-blue-100 text-blue-700",
  HIGH: "bg-orange-100 text-orange-800",
  CRITICAL: "bg-red-700 text-white",
};

const timelineColorMap: Record<string, { border: string; bg: string; icon: string }> = {
  blue: { border: "border-blue-400", bg: "bg-blue-50", icon: "text-blue-600" },
  indigo: { border: "border-indigo-400", bg: "bg-indigo-50", icon: "text-indigo-600" },
  green: { border: "border-green-400", bg: "bg-green-50", icon: "text-green-600" },
  cyan: { border: "border-cyan-400", bg: "bg-cyan-50", icon: "text-cyan-600" },
  purple: { border: "border-purple-400", bg: "bg-purple-50", icon: "text-purple-600" },
  gray: { border: "border-gray-300", bg: "bg-gray-50", icon: "text-gray-500" },
  amber: { border: "border-amber-400", bg: "bg-amber-50", icon: "text-amber-600" },
  rose: { border: "border-rose-400", bg: "bg-rose-50", icon: "text-rose-600" },
  orange: { border: "border-orange-400", bg: "bg-orange-50", icon: "text-orange-600" },
  red: { border: "border-red-500", bg: "bg-red-50", icon: "text-red-600" },
};

const timelineIconMap = {
  Calendar,
  Stethoscope,
  FileText,
  Activity,
  BedDouble,
  FlaskConical,
  Scissors,
  CreditCard,
  Siren,
} as const;

// ───────────────────────────────────────────────────────
// Page
// ───────────────────────────────────────────────────────

type TabKey =
  | "360"
  | "overview"
  | "timeline"
  | "medical"
  | "vitals"
  | "billing"
  | "labs"
  | "documents";

export default function PatientDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { user } = useAuthStore();
  const promptDialog = usePrompt();
  const [patient, setPatient] = useState<PatientDetail | null>(null);
  const [visits, setVisits] = useState<VisitRecord[]>([]);
  const [stats, setStats] = useState<PatientStats | null>(null);
  const [allergiesAlert, setAllergiesAlert] = useState<Allergy[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedVisit, setExpandedVisit] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("360");
  const [quickModal, setQuickModal] = useState<
    "vitals" | "book" | null
  >(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const { t } = useTranslation();

  const loadStats = useCallback(async () => {
    try {
      const s = await api.get<{ data: PatientStats }>(
        `/patients/${id}/stats`
      );
      setStats(s.data);
    } catch {
      // noop
    }
  }, [id]);

  const loadAlerts = useCallback(async () => {
    try {
      const res = await api.get<{ data: Allergy[] }>(
        `/ehr/patients/${id}/allergies`
      );
      setAllergiesAlert(
        res.data.filter(
          (a) => a.severity === "SEVERE" || a.severity === "LIFE_THREATENING"
        )
      );
    } catch {
      // noop
    }
  }, [id]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [patRes, histRes] = await Promise.all([
          api.get<{ data: PatientDetail }>(`/patients/${id}`),
          api
            .get<{ data: VisitRecord[] }>(`/patients/${id}/history`)
            .catch(() => ({ data: [] })),
        ]);
        setPatient(patRes.data);
        setVisits(histRes.data);
      } catch {
        // noop
      }
      setLoading(false);
      loadStats();
      loadAlerts();
    })();
  }, [id, loadStats, loadAlerts]);

  // Default tab: Timeline if currently admitted, else 360
  useEffect(() => {
    if (stats?.currentAdmissionId) {
      setTab((t) => (t === "360" || t === "overview" ? "timeline" : t));
    }
  }, [stats?.currentAdmissionId]);

  function toggleVisit(visitId: string) {
    setExpandedVisit(expandedVisit === visitId ? null : visitId);
  }

  if (loading) {
    return <div className="p-8 text-center text-gray-500">Loading...</div>;
  }

  if (!patient) {
    return (
      <div className="p-8 text-center">
        <p className="text-gray-500">Patient not found</p>
        <Link
          href="/dashboard/patients"
          className="mt-4 inline-block text-primary hover:underline"
        >
          Back to Patients
        </Link>
      </div>
    );
  }

  const statusColors: Record<string, string> = {
    COMPLETED: "bg-green-100 text-green-700",
    IN_PROGRESS: "bg-blue-100 text-blue-700",
    CHECKED_IN: "bg-amber-100 text-amber-700",
    SCHEDULED: "bg-gray-100 text-gray-600",
    CANCELLED: "bg-red-100 text-red-700",
    NO_SHOW: "bg-red-100 text-red-600",
    BOOKED: "bg-blue-100 text-blue-700",
  };

  const canEdit =
    user?.role === "DOCTOR" ||
    user?.role === "NURSE" ||
    user?.role === "ADMIN" ||
    user?.role === "RECEPTION";
  const isDoctor = user?.role === "DOCTOR";
  const isNurse = user?.role === "NURSE";
  const isReception = user?.role === "RECEPTION";
  const isAdmin = user?.role === "ADMIN";
  // Issue #185 (Apr 2026): Edit Patient (demographic data) is RECEPTION +
  // ADMIN only. A doctor's role is to write clinical notes / orders /
  // prescriptions — NOT to mutate name / phone / DOB / insurance fields.
  // Allowing it created an audit gap and was the root cause of #185.
  const canEditDemographics =
    user?.role === "ADMIN" || user?.role === "RECEPTION";

  const tabs: Array<{ key: TabKey; label: string; icon: React.ReactNode }> = [
    { key: "360", label: "360\u00B0", icon: <TrendingUp size={14} /> },
    { key: "overview", label: "Overview", icon: <ClipboardList size={14} /> },
    { key: "timeline", label: "Timeline", icon: <Activity size={14} /> },
    { key: "medical", label: "Medical Records", icon: <Heart size={14} /> },
    { key: "vitals", label: "Vitals Trends", icon: <TrendingUp size={14} /> },
    { key: "billing", label: "Billing", icon: <Receipt size={14} /> },
    { key: "labs", label: "Lab Results", icon: <FlaskConical size={14} /> },
    { key: "documents", label: "Documents", icon: <FolderOpen size={14} /> },
  ];

  return (
    <div>
      {/* Back link */}
      <Link
        href="/dashboard/patients"
        className="mb-4 inline-flex items-center gap-2 text-sm text-gray-600 hover:text-primary"
      >
        <ArrowLeft size={16} /> Back to Patients
      </Link>

      {/* DNR / Advance Directive Banner */}
      <DnrBanner patientId={id} />

      {/* ALERT BANNER */}
      {(allergiesAlert.length > 0 || stats?.currentAdmissionId) && (
        <div className="mb-4 space-y-2">
          {stats?.currentAdmissionId && (
            <div className="flex items-center gap-3 rounded-xl border border-purple-300 bg-purple-50 p-4 text-purple-800">
              <BedDouble size={20} className="text-purple-600" />
              <div className="flex-1">
                <p className="font-semibold">Patient is currently admitted</p>
                <p className="text-sm">
                  Admission #{stats.currentAdmissionNumber} — active IPD stay
                </p>
              </div>
              <Link
                href={`/dashboard/ipd/${stats.currentAdmissionId}`}
                className="rounded-lg bg-purple-600 px-3 py-1.5 text-sm text-white hover:bg-purple-700"
              >
                View IPD
              </Link>
            </div>
          )}
          {allergiesAlert.length > 0 && (
            <div className="flex items-start gap-3 rounded-xl border border-red-300 bg-red-50 p-4">
              <AlertCircle size={20} className="mt-0.5 text-red-700" />
              <div className="flex-1">
                <p className="font-bold text-red-800">
                  SEVERE ALLERGY WARNING
                </p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {allergiesAlert.map((a) => (
                    <span
                      key={a.id}
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${severityColors[a.severity]}`}
                    >
                      {a.allergen} ({a.severity.replace("_", " ")})
                      {a.reaction ? ` — ${a.reaction}` : ""}
                    </span>
                  ))}
                </div>
                {patient.emergencyContactName && (
                  <p className="mt-2 text-xs text-red-800">
                    Emergency contact: {patient.emergencyContactName}
                    {patient.emergencyContactPhone
                      ? ` — ${patient.emergencyContactPhone}`
                      : ""}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Patient Info Card
          Issue #495: the demographic header (name, age, phone, email,
          address, KPI tile labels) was rendering ~3:1 against the dark
          card surface because the entire card and every paragraph used
          plain `text-gray-400` / no-color classes with zero `dark:`
          variants. Promote name/values to `text-gray-900 dark:text-gray-100`
          and labels to `text-gray-600 dark:text-gray-300` so every line
          clears WCAG 2.1 AA (4.5:1 normal, 3:1 large) in both modes. */}
      <div
        data-testid="patient-detail-header"
        className="mb-4 rounded-xl bg-white p-6 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100"
      >
        <div className="flex items-start gap-6">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 dark:bg-primary/20">
            <User size={28} className="text-primary" aria-hidden="true" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1
                data-testid="patient-detail-name"
                className="text-2xl font-bold text-gray-900 dark:text-gray-100"
              >
                {patient.user.name}
              </h1>
              <span className="rounded-full bg-primary/10 px-3 py-0.5 font-mono text-sm font-medium text-primary">
                {patient.mrNumber}
              </span>
              <PricingTierBadge
                patient={patient}
                onUpdated={(tier) =>
                  setPatient((p) => (p ? { ...p, pricingTier: tier } : p))
                }
              />
              {patient.noShowCount != null && patient.noShowCount > 0 && (
                <span
                  className="rounded-full bg-red-100 px-3 py-0.5 text-xs font-semibold text-red-700"
                  title="Appointments missed without cancellation"
                >
                  No-shows: {patient.noShowCount}
                </span>
              )}
              {/* Issue #185: demographic Edit is RECEPTION + ADMIN only. */}
              {canEditDemographics && (
                <button
                  type="button"
                  onClick={() => setEditOpen(true)}
                  aria-label={t("patient.edit.button")}
                  data-testid="patient-edit-button"
                  className="no-print ml-auto inline-flex items-center gap-1.5 rounded-lg border border-primary bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
                >
                  <EditIcon size={13} aria-hidden="true" />{" "}
                  {t("patient.edit.button")}
                </button>
              )}
              <button
                onClick={() => window.print()}
                aria-label="Print medical record"
                className={`no-print ${canEditDemographics ? "" : "ml-auto "}inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2`}
              >
                <Printer size={13} aria-hidden="true" /> Print Medical Record
              </button>
              <button
                onClick={async () => {
                  const token = localStorage.getItem("medcore_token");
                  const API_BASE =
                    process.env.NEXT_PUBLIC_API_URL ||
                    "http://localhost:4000/api/v1";
                  const res = await fetch(
                    `${API_BASE}/patients/${patient.id}/ccda`,
                    { headers: { Authorization: `Bearer ${token}` } }
                  );
                  const blob = await res.blob();
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `ccda-${patient.mrNumber}.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                aria-label="Export medical record"
                className="no-print inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                <Download size={13} /> Export Medical Record
              </button>
              {isAdmin && (
                <button
                  onClick={() => setMergeOpen(true)}
                  aria-label="Merge duplicate patient"
                  className="no-print inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
                >
                  <Users size={13} /> Merge Duplicate
                </button>
              )}
              <button
                onClick={() => openPrintEndpoint(`/patients/${patient.id}/id-card`)}
                className="no-print inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                title="Print patient ID card"
              >
                <Printer size={13} /> ID Card
              </button>
              <button
                onClick={() => openPrintEndpoint(`/patients/${patient.id}/vitals/pdf`)}
                className="no-print inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                title="Print vitals history"
              >
                <Printer size={13} /> Vitals PDF
              </button>
              <button
                onClick={async () => {
                  const purpose = await promptDialog({
                    title: "Issue fitness certificate",
                    label: "Purpose of fitness certificate:",
                    placeholder: "e.g. general employment, school admission, gym membership",
                    initialValue: "general employment",
                    required: true,
                    confirmLabel: "Generate certificate",
                  });
                  if (purpose) {
                    openPrintEndpoint(
                      `/patients/${patient.id}/fitness-certificate?purpose=${encodeURIComponent(purpose)}`
                    );
                  }
                }}
                className="no-print inline-flex items-center gap-1.5 rounded-lg border border-green-300 bg-green-50 px-3 py-1.5 text-xs font-medium text-green-800 hover:bg-green-100"
                title="Issue fitness certificate"
              >
                <Printer size={13} /> Fitness Cert
              </button>
            </div>
            <div
              data-testid="patient-detail-demographics"
              className="mt-3 grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-4"
            >
              {patient.age != null && (
                <div>
                  <p className="text-xs text-gray-600 dark:text-gray-300">Age</p>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{patient.age} yrs</p>
                </div>
              )}
              <div>
                <p className="text-xs text-gray-600 dark:text-gray-300">Gender</p>
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{patient.gender}</p>
              </div>
              {patient.bloodGroup && (
                <div>
                  <p className="text-xs text-gray-600 dark:text-gray-300">Blood Group</p>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{patient.bloodGroup}</p>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <Phone size={13} className="text-gray-600 dark:text-gray-300" aria-hidden="true" />
                <p className="text-sm text-gray-900 dark:text-gray-100">{patient.user.phone}</p>
              </div>
              {patient.user.email && (
                <div className="flex items-center gap-1.5">
                  <Mail size={13} className="text-gray-600 dark:text-gray-300" aria-hidden="true" />
                  <p className="text-sm text-gray-900 dark:text-gray-100">{patient.user.email}</p>
                </div>
              )}
              {patient.insuranceProvider && (
                <div>
                  <p className="text-xs text-gray-600 dark:text-gray-300">Insurance</p>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {patient.insuranceProvider}
                    {patient.insuranceId ? ` (${patient.insuranceId})` : ""}
                  </p>
                </div>
              )}
              {patient.address && (
                <div className="col-span-2">
                  <p className="text-xs text-gray-600 dark:text-gray-300">Address</p>
                  <p className="text-sm text-gray-900 dark:text-gray-100">{patient.address}</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Stats strip */}
        {stats && (
          <div className="mt-5 grid grid-cols-2 gap-3 border-t pt-4 md:grid-cols-4 lg:grid-cols-6">
            <StatCard
              label="Total Visits"
              value={String(stats.totalVisits)}
              tone="blue"
            />
            <StatCard
              label="Last Visit"
              value={
                stats.lastVisitDate
                  ? new Date(stats.lastVisitDate).toLocaleDateString("en-IN", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })
                  : "—"
              }
              tone="gray"
            />
            <StatCard
              label="Total Spent"
              value={`Rs. ${stats.totalSpent.toFixed(0)}`}
              tone="green"
            />
            <StatCard
              label="Active Conditions"
              value={String(stats.activeConditionsCount)}
              tone={stats.activeConditionsCount > 0 ? "orange" : "gray"}
            />
            <StatCard
              label="Upcoming"
              value={String(stats.upcomingAppointments)}
              tone="indigo"
            />
            <StatCard
              label="Pending Bills"
              value={String(stats.pendingBills)}
              tone={stats.pendingBills > 0 ? "red" : "gray"}
            />
          </div>
        )}

        {/* Quick Actions */}
        <div className="mt-4 flex flex-wrap gap-2 border-t pt-4">
          {(isReception || isAdmin || isDoctor) && (
            <button
              onClick={() => setQuickModal("book")}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90"
            >
              <Calendar size={14} /> Book Appointment
            </button>
          )}
          {(isNurse || isDoctor || isAdmin) && (
            <button
              onClick={() => setQuickModal("vitals")}
              className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-sm text-white hover:bg-cyan-700"
            >
              <Activity size={14} /> Record Vitals
            </button>
          )}
          {isDoctor && (
            // Issue #84: button used to link to a non-existent
            // /dashboard/consultations route (404). Doctors actually start
            // consultations from the live queue, so route there with the
            // patient pre-filtered.
            <Link
              href={`/dashboard/queue?patientId=${id}`}
              data-testid="patient-start-consultation"
              className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700"
            >
              <Stethoscope size={14} /> Start Consultation
            </Link>
          )}
          {isDoctor && (
            <Link
              href={`/dashboard/prescriptions/new?patientId=${id}`}
              className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-sm text-white hover:bg-green-700"
            >
              <Pill size={14} /> Write Prescription
            </Link>
          )}
          {(isReception || isAdmin) && (
            <Link
              href={`/dashboard/billing/new?patientId=${id}`}
              className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-sm text-white hover:bg-amber-700"
            >
              <Receipt size={14} /> Create Invoice
            </Link>
          )}
          {(isDoctor || isAdmin) && !stats?.currentAdmissionId && (
            <Link
              href={`/dashboard/ipd/admit?patientId=${id}`}
              className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-sm text-white hover:bg-purple-700"
            >
              <BedDouble size={14} /> Admit
            </Link>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-6 flex gap-1 overflow-x-auto border-b">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 whitespace-nowrap px-4 py-2 text-sm font-medium transition ${
              tab === t.key
                ? "border-b-2 border-primary text-primary"
                : "text-gray-500 hover:text-gray-800"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* 360 View */}
      {tab === "360" && (
        <Patient360Tab
          patientId={id}
          patient={patient}
          stats={stats}
          canEdit={canEdit}
          onBookAppt={() => setQuickModal("book")}
        />
      )}

      {/* Overview */}
      {tab === "overview" && (
        <>
          <h2 className="mb-4 text-lg font-semibold">Visit History</h2>
          {visits.length === 0 ? (
            <div className="rounded-xl bg-white p-8 text-center shadow-sm">
              <p className="text-gray-400">No visit history found</p>
            </div>
          ) : (
            <div className="space-y-3">
              {visits.map((visit) => {
                const isExpanded = expandedVisit === visit.id;
                return (
                  <div key={visit.id} className="rounded-xl bg-white shadow-sm">
                    <button
                      onClick={() => toggleVisit(visit.id)}
                      className="flex w-full items-center gap-4 px-6 py-4 text-left hover:bg-gray-50"
                    >
                      {isExpanded ? (
                        <ChevronDown size={18} className="text-gray-400" />
                      ) : (
                        <ChevronRight size={18} className="text-gray-400" />
                      )}
                      <div className="flex-1">
                        <div className="flex items-center gap-3">
                          <p className="font-medium">
                            {new Date(visit.date).toLocaleDateString("en-IN", {
                              weekday: "short",
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                            })}
                          </p>
                          <span
                            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                              statusColors[visit.status] ||
                              "bg-gray-100 text-gray-600"
                            }`}
                          >
                            {visit.status.replace(/_/g, " ")}
                          </span>
                        </div>
                        <p className="mt-0.5 text-sm text-gray-500">
                          {visit.doctor?.user?.name ? formatDoctorName(visit.doctor.user.name) : "---"}{" "}
                          {visit.doctor?.specialization
                            ? `(${visit.doctor.specialization})`
                            : ""}
                        </p>
                        {visit.diagnosis && (
                          <p className="mt-1 text-sm text-gray-600">
                            Diagnosis: {visit.diagnosis}
                          </p>
                        )}
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="border-t px-6 py-4">
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                          {visit.vitals && (
                            <div className="rounded-lg bg-blue-50 p-4">
                              <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-blue-700">
                                <Activity size={14} /> Vitals
                              </h4>
                              <div className="space-y-1 text-sm">
                                {visit.vitals.bloodPressure && (
                                  <p>
                                    <span className="text-gray-500">BP:</span>{" "}
                                    {visit.vitals.bloodPressure} mmHg
                                  </p>
                                )}
                                {visit.vitals.heartRate && (
                                  <p>
                                    <span className="text-gray-500">HR:</span>{" "}
                                    {visit.vitals.heartRate} bpm
                                  </p>
                                )}
                                {visit.vitals.temperature && (
                                  <p>
                                    <span className="text-gray-500">Temp:</span>{" "}
                                    {visit.vitals.temperature}°F
                                  </p>
                                )}
                                {visit.vitals.weight && (
                                  <p>
                                    <span className="text-gray-500">
                                      Weight:
                                    </span>{" "}
                                    {visit.vitals.weight} kg
                                  </p>
                                )}
                                {visit.vitals.oxygenSaturation && (
                                  <p>
                                    <span className="text-gray-500">SpO2:</span>{" "}
                                    {visit.vitals.oxygenSaturation}%
                                  </p>
                                )}
                              </div>
                            </div>
                          )}

                          {visit.prescription &&
                            visit.prescription.items &&
                            visit.prescription.items.length > 0 && (
                              <div className="rounded-lg bg-green-50 p-4">
                                <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-green-700">
                                  <FileText size={14} /> Prescription
                                </h4>
                                <div className="space-y-2">
                                  {visit.prescription.items.map((item, i) => (
                                    <div key={i} className="text-sm">
                                      <p className="font-medium">
                                        {item.medication}
                                      </p>
                                      <p className="text-xs text-gray-600">
                                        {item.dosage} | {item.frequency} |{" "}
                                        {item.duration}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                          {visit.invoice && (
                            <div className="rounded-lg bg-amber-50 p-4">
                              <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-700">
                                <CreditCard size={14} /> Invoice
                              </h4>
                              <div className="text-sm">
                                <p>
                                  <span className="text-gray-500">#</span>{" "}
                                  {visit.invoice.invoiceNumber}
                                </p>
                                <p className="mt-1 text-lg font-semibold">
                                  Rs. {visit.invoice.totalAmount.toFixed(2)}
                                </p>
                                <span
                                  className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                                    visit.invoice.paymentStatus === "PAID"
                                      ? "bg-green-100 text-green-700"
                                      : "bg-red-100 text-red-700"
                                  }`}
                                >
                                  {visit.invoice.paymentStatus}
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab === "timeline" && <TimelineTab patientId={id} />}
      {tab === "medical" && <MedicalRecordsTab patientId={id} canEdit={canEdit} />}
      {tab === "vitals" && <VitalsTrendsTab patientId={id} />}
      {tab === "billing" && <BillingTab patientId={id} />}
      {tab === "labs" && <LabResultsTab patientId={id} />}
      {tab === "documents" && <DocumentsTab patientId={id} canEdit={canEdit} />}

      {/* Quick action modals */}
      {quickModal === "vitals" && (
        <QuickVitalsModal
          patientId={id}
          onClose={() => setQuickModal(null)}
          onSaved={() => {
            setQuickModal(null);
            loadStats();
          }}
        />
      )}
      {quickModal === "book" && (
        <QuickBookModal
          patientId={id}
          onClose={() => setQuickModal(null)}
          onSaved={() => {
            setQuickModal(null);
            loadStats();
          }}
        />
      )}
      {mergeOpen && (
        <MergePatientModal
          patient={patient}
          onClose={() => setMergeOpen(false)}
        />
      )}
      <PatientEditModal
        open={editOpen}
        patient={patient}
        onClose={() => setEditOpen(false)}
        onSaved={(updated) => {
          const u = updated as Partial<PatientDetail> | null | undefined;
          if (u && u.id) {
            setPatient((prev) => (prev ? { ...prev, ...u } : prev));
          } else {
            // Fall back to a re-fetch if the server didn't echo the row.
            api
              .get<{ data: PatientDetail }>(`/patients/${id}`)
              .then((r) => setPatient(r.data))
              .catch(() => {});
          }
          loadStats();
        }}
      />
    </div>
  );
}

// ───────────────────────────────────────────────────────
// Stat card
// ───────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "blue" | "green" | "gray" | "orange" | "indigo" | "red";
}) {
  // Issue #495: pre-fix labels carried `opacity-70` which knocked the
  // "Total Spent" / "Upcoming" titles to ~3:1 against the tinted bg-*-50
  // surfaces. Drop the opacity, pin to AA-passing tone-700 in light mode
  // and tone-200 in dark mode (>= 4.5:1 against the matching tinted/dark
  // backgrounds).
  const tones: Record<string, string> = {
    blue: "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200",
    green: "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-200",
    gray: "bg-gray-50 text-gray-700 dark:bg-gray-700/50 dark:text-gray-200",
    orange: "bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-200",
    indigo: "bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-200",
    red: "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-200",
  };
  return (
    <div
      data-testid="patient-stat-card"
      className={`rounded-lg p-3 ${tones[tone]}`}
    >
      <p className="text-xs font-medium">{label}</p>
      <p className="text-lg font-bold">{value}</p>
    </div>
  );
}

// ───────────────────────────────────────────────────────
// Modal helper
// ───────────────────────────────────────────────────────

function Modal({
  title,
  onClose,
  children,
  size = "md",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  size?: "md" | "lg";
}) {
  const maxW = size === "lg" ? "max-w-2xl" : "max-w-md";
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className={`w-full ${maxW} rounded-xl bg-white shadow-xl`}>
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h3 className="font-semibold">{title}</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700"
          >
            <X size={18} />
          </button>
        </div>
        <div className="max-h-[80vh] overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────
// Timeline Tab
// ───────────────────────────────────────────────────────

function TimelineTab({ patientId }: { patientId: string }) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(50);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await api.get<{ data: TimelineEntry[] }>(
          `/patients/${patientId}/timeline`
        );
        setEntries(res.data);
      } catch {
        // noop
      }
      setLoading(false);
    })();
  }, [patientId]);

  if (loading) return <div className="p-6 text-gray-500">Loading timeline...</div>;

  if (entries.length === 0) {
    return (
      <div className="rounded-xl bg-white p-8 text-center shadow-sm">
        <p className="text-gray-400">No timeline events yet</p>
      </div>
    );
  }

  const shown = entries.slice(0, visible);

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm">
      <h2 className="mb-5 text-lg font-semibold">Patient Timeline</h2>
      <div className="relative space-y-3 before:absolute before:left-5 before:top-2 before:h-full before:w-0.5 before:bg-gray-200">
        {shown.map((e) => {
          const colors =
            timelineColorMap[e.color] || timelineColorMap.gray;
          const Icon =
            (timelineIconMap as any)[e.icon] || Activity;
          return (
            <div key={e.id} className="relative flex items-start gap-4 pl-0">
              <div
                className={`relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-white bg-white shadow ${colors.icon}`}
              >
                <Icon size={18} />
              </div>
              <div
                className={`flex-1 rounded-lg border-l-4 ${colors.border} ${colors.bg} p-3`}
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium text-gray-800">{e.title}</p>
                  <p className="shrink-0 text-xs text-gray-500">
                    {new Date(e.timestamp).toLocaleString("en-IN", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
                {e.description && (
                  <p className="mt-1 text-sm text-gray-600">{e.description}</p>
                )}
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-xs uppercase tracking-wide text-gray-400">
                    {e.type}
                  </span>
                  {e.link && (
                    <Link
                      href={e.link}
                      className="text-xs text-primary hover:underline"
                    >
                      view
                    </Link>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {visible < entries.length && (
        <div className="mt-5 text-center">
          <button
            onClick={() => setVisible((v) => v + 50)}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
          >
            Load more ({entries.length - visible} remaining)
          </button>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────
// Vitals Trends Tab
// ───────────────────────────────────────────────────────

function VitalsTrendsTab({ patientId }: { patientId: string }) {
  const [data, setData] = useState<VitalsTrendPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<"30" | "90" | "365" | "all">("90");

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        let url = `/patients/${patientId}/vitals-trend`;
        if (range !== "all") {
          const days = parseInt(range);
          const from = new Date(Date.now() - days * 86400_000).toISOString();
          url += `?from=${from}`;
        }
        const res = await api.get<{ data: VitalsTrendPoint[] }>(url);
        setData(res.data);
      } catch {
        // noop
      }
      setLoading(false);
    })();
  }, [patientId, range]);

  const latestWeight = useMemo(() => {
    for (let i = data.length - 1; i >= 0; i--) {
      if (data[i].weight != null) return data[i].weight;
    }
    return null;
  }, [data]);

  if (loading) return <div className="p-6 text-gray-500">Loading vitals...</div>;

  if (data.length === 0) {
    return (
      <div className="rounded-xl bg-white p-8 text-center shadow-sm">
        <p className="text-gray-400">No vitals recorded yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-xl bg-white p-4 shadow-sm">
        <h2 className="text-lg font-semibold">Vitals Trends</h2>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {(["30", "90", "365", "all"] as const).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`rounded px-3 py-1 text-xs ${
                  range === r
                    ? "bg-primary text-white"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                {r === "all" ? "All" : `${r}d`}
              </button>
            ))}
          </div>
          <button
            onClick={() => {
              const token = localStorage.getItem("medcore_token");
              const API_BASE =
                process.env.NEXT_PUBLIC_API_URL ||
                "http://localhost:4000/api/v1";
              let qs = "";
              if (range !== "all") {
                const days = parseInt(range);
                const from = new Date(Date.now() - days * 86400_000).toISOString();
                qs = `?from=${from}`;
              }
              // Open in new window — backend responds with printable HTML
              fetch(`${API_BASE}/patients/${patientId}/vitals/pdf${qs}`, {
                headers: { Authorization: `Bearer ${token}` },
              })
                .then((r) => r.text())
                .then((html) => {
                  const win = window.open("", "_blank");
                  if (win) {
                    win.document.open();
                    win.document.write(html);
                    win.document.close();
                  }
                });
            }}
            className="rounded border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            Download Vitals Report
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ChartCard title="Blood Pressure (mmHg)" subtitle="Normal: 90–140 / 60–90">
          <BpChart data={data} />
        </ChartCard>
        <ChartCard title="Temperature & Pulse" subtitle="°F / bpm">
          <TempPulseChart data={data} />
        </ChartCard>
        <ChartCard title="SpO2 & Weight" subtitle="% / kg">
          <SpoWeightChart data={data} />
        </ChartCard>
      </div>

      {latestWeight && (
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-semibold">Latest Measurements</h3>
          <p className="text-sm text-gray-600">
            Weight: <span className="font-medium">{latestWeight} kg</span>
          </p>
        </div>
      )}
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm">
      <div className="mb-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
      </div>
      <div className="h-48 w-full">{children}</div>
    </div>
  );
}

// Generic SVG line chart helper
interface Series {
  name: string;
  color: string;
  points: Array<{ x: number; y: number | null }>;
  dash?: string;
}

function LineChart({
  series,
  yMin,
  yMax,
  bands,
  yLabel,
}: {
  series: Series[];
  yMin?: number;
  yMax?: number;
  bands?: Array<{ min: number; max: number; color: string }>;
  yLabel?: string;
}) {
  const w = 320;
  const h = 180;
  const padL = 32;
  const padR = 8;
  const padT = 10;
  const padB = 24;

  const allY = series
    .flatMap((s) => s.points.map((p) => p.y))
    .filter((y): y is number => y != null);
  const allX = series.flatMap((s) => s.points.map((p) => p.x));
  if (allY.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-gray-400">
        No data
      </div>
    );
  }

  const minY = yMin ?? Math.min(...allY) * 0.95;
  const maxY = yMax ?? Math.max(...allY) * 1.05;
  const minX = Math.min(...allX);
  const maxX = Math.max(...allX);
  const xRange = Math.max(maxX - minX, 1);
  const yRange = Math.max(maxY - minY, 1);

  const xFor = (x: number) =>
    padL + ((x - minX) / xRange) * (w - padL - padR);
  const yFor = (y: number) =>
    padT + (1 - (y - minY) / yRange) * (h - padT - padB);

  const yTicks = 4;
  const ticks: number[] = [];
  for (let i = 0; i <= yTicks; i++) {
    ticks.push(minY + (yRange * i) / yTicks);
  }

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-full w-full">
      {/* bands */}
      {bands?.map((b, i) => {
        const y1 = yFor(Math.min(b.max, maxY));
        const y2 = yFor(Math.max(b.min, minY));
        return (
          <rect
            key={i}
            x={padL}
            y={y1}
            width={w - padL - padR}
            height={Math.max(0, y2 - y1)}
            fill={b.color}
            opacity={0.15}
          />
        );
      })}

      {/* y gridlines */}
      {ticks.map((t, i) => (
        <g key={i}>
          <line
            x1={padL}
            x2={w - padR}
            y1={yFor(t)}
            y2={yFor(t)}
            stroke="#e5e7eb"
            strokeWidth={0.5}
          />
          <text x={2} y={yFor(t) + 3} fontSize={9} fill="#9ca3af">
            {t.toFixed(t > 10 ? 0 : 1)}
          </text>
        </g>
      ))}

      {/* x axis dates — show first and last */}
      {allX.length > 0 && (
        <>
          <text x={padL} y={h - 6} fontSize={9} fill="#9ca3af">
            {new Date(minX).toLocaleDateString("en-IN", {
              day: "2-digit",
              month: "short",
            })}
          </text>
          <text
            x={w - padR}
            y={h - 6}
            fontSize={9}
            fill="#9ca3af"
            textAnchor="end"
          >
            {new Date(maxX).toLocaleDateString("en-IN", {
              day: "2-digit",
              month: "short",
            })}
          </text>
        </>
      )}

      {/* series lines */}
      {series.map((s, si) => {
        const segs: string[] = [];
        let started = false;
        for (const p of s.points) {
          if (p.y == null) {
            started = false;
            continue;
          }
          const x = xFor(p.x);
          const y = yFor(p.y);
          segs.push(`${started ? "L" : "M"}${x},${y}`);
          started = true;
        }
        return (
          <g key={si}>
            <path
              d={segs.join(" ")}
              fill="none"
              stroke={s.color}
              strokeWidth={1.5}
              strokeDasharray={s.dash}
            />
            {s.points.map((p, pi) =>
              p.y != null ? (
                <circle
                  key={pi}
                  cx={xFor(p.x)}
                  cy={yFor(p.y)}
                  r={2}
                  fill={s.color}
                />
              ) : null
            )}
          </g>
        );
      })}

      {/* legend */}
      <g>
        {series.map((s, si) => (
          <g key={si} transform={`translate(${padL + si * 80}, ${padT})`}>
            <line
              x1={0}
              y1={-2}
              x2={10}
              y2={-2}
              stroke={s.color}
              strokeWidth={1.5}
              strokeDasharray={s.dash}
            />
            <text x={14} y={1} fontSize={9} fill="#374151">
              {s.name}
            </text>
          </g>
        ))}
      </g>

      {yLabel && (
        <text
          x={2}
          y={padT - 2}
          fontSize={9}
          fill="#6b7280"
          fontWeight="bold"
        >
          {yLabel}
        </text>
      )}
    </svg>
  );
}

function BpChart({ data }: { data: VitalsTrendPoint[] }) {
  const sys = data.map((d) => ({
    x: new Date(d.recordedAt).getTime(),
    y: d.bloodPressureSystolic,
  }));
  const dia = data.map((d) => ({
    x: new Date(d.recordedAt).getTime(),
    y: d.bloodPressureDiastolic,
  }));
  return (
    <LineChart
      series={[
        { name: "Systolic", color: "#dc2626", points: sys },
        { name: "Diastolic", color: "#2563eb", points: dia },
      ]}
      yMin={40}
      yMax={200}
      bands={[
        { min: 140, max: 200, color: "#ef4444" },
        { min: 40, max: 60, color: "#f59e0b" },
      ]}
    />
  );
}

function TempPulseChart({ data }: { data: VitalsTrendPoint[] }) {
  // Display both on same chart with separate scales — we'll normalize pulse into a matching range
  // But simpler: show temperature (96–104°F) on one line and pulse (40–160) separately using dual scale hack.
  // For pure SVG simplicity, show as two series scaled into same 0-100 virtual space.
  const tempPoints = data.map((d) => ({
    x: new Date(d.recordedAt).getTime(),
    y: d.temperature,
  }));
  const pulsePoints = data.map((d) => ({
    x: new Date(d.recordedAt).getTime(),
    y: d.pulseRate,
  }));
  const hasTemp = tempPoints.some((p) => p.y != null);
  const hasPulse = pulsePoints.some((p) => p.y != null);
  if (hasTemp && hasPulse) {
    return (
      <div className="flex h-full flex-col gap-1">
        <div className="h-1/2">
          <LineChart
            series={[
              { name: "Temp °F", color: "#ea580c", points: tempPoints },
            ]}
            yMin={95}
            yMax={106}
            bands={[{ min: 100.4, max: 106, color: "#ef4444" }]}
          />
        </div>
        <div className="h-1/2">
          <LineChart
            series={[
              { name: "Pulse bpm", color: "#7c3aed", points: pulsePoints },
            ]}
            yMin={40}
            yMax={160}
            bands={[
              { min: 100, max: 160, color: "#f59e0b" },
              { min: 40, max: 60, color: "#3b82f6" },
            ]}
          />
        </div>
      </div>
    );
  }
  return (
    <LineChart
      series={[
        { name: "Temp °F", color: "#ea580c", points: tempPoints },
        { name: "Pulse", color: "#7c3aed", points: pulsePoints, dash: "3,3" },
      ]}
    />
  );
}

function SpoWeightChart({ data }: { data: VitalsTrendPoint[] }) {
  const spo = data.map((d) => ({
    x: new Date(d.recordedAt).getTime(),
    y: d.spO2,
  }));
  const wt = data.map((d) => ({
    x: new Date(d.recordedAt).getTime(),
    y: d.weight,
  }));
  const hasSpo = spo.some((p) => p.y != null);
  const hasWt = wt.some((p) => p.y != null);
  if (hasSpo && hasWt) {
    return (
      <div className="flex h-full flex-col gap-1">
        <div className="h-1/2">
          <LineChart
            series={[{ name: "SpO2 %", color: "#0891b2", points: spo }]}
            yMin={85}
            yMax={100}
            bands={[{ min: 85, max: 94, color: "#ef4444" }]}
          />
        </div>
        <div className="h-1/2">
          <LineChart
            series={[{ name: "Weight kg", color: "#16a34a", points: wt }]}
          />
        </div>
      </div>
    );
  }
  return (
    <LineChart
      series={[
        { name: "SpO2", color: "#0891b2", points: spo },
        { name: "Weight kg", color: "#16a34a", points: wt, dash: "3,3" },
      ]}
    />
  );
}

// ───────────────────────────────────────────────────────
// Billing Tab
// ───────────────────────────────────────────────────────

function BillingTab({ patientId }: { patientId: string }) {
  const [invoices, setInvoices] = useState<InvoiceLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [showOlder, setShowOlder] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await api.get<{ data: InvoiceLine[] }>(
          `/patients/${patientId}/invoices`
        );
        setInvoices(res.data);
      } catch {
        // noop
      }
      setLoading(false);
    })();
  }, [patientId]);

  if (loading) return <div className="p-6 text-gray-500">Loading billing...</div>;

  const outstanding = invoices.reduce((sum, inv) => {
    if (inv.paymentStatus === "PAID") return sum;
    const paid = inv.payments.reduce((s, p) => s + p.amount, 0);
    return sum + (inv.totalAmount - paid);
  }, 0);
  const totalPaid = invoices
    .filter((i) => i.paymentStatus === "PAID")
    .reduce((s, i) => s + i.totalAmount, 0);

  const ninetyDaysAgo = Date.now() - 90 * 86400_000;
  const recent = invoices.filter(
    (i) => new Date(i.createdAt).getTime() >= ninetyDaysAgo
  );
  const older = invoices.filter(
    (i) => new Date(i.createdAt).getTime() < ninetyDaysAgo
  );

  if (invoices.length === 0) {
    return (
      <div className="rounded-xl bg-white p-8 text-center shadow-sm">
        <p className="text-gray-400">No invoices yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded-xl bg-white p-4 shadow-sm">
          <p className="text-xs text-gray-500">Total Invoices</p>
          <p className="text-2xl font-bold">{invoices.length}</p>
        </div>
        <div className="rounded-xl bg-green-50 p-4 shadow-sm">
          <p className="text-xs text-green-700">Total Paid</p>
          <p className="text-2xl font-bold text-green-700">
            Rs. {totalPaid.toFixed(2)}
          </p>
        </div>
        <div
          className={`rounded-xl p-4 shadow-sm ${
            outstanding > 0 ? "bg-red-50" : "bg-gray-50"
          }`}
        >
          <p
            className={`text-xs ${outstanding > 0 ? "text-red-700" : "text-gray-600"}`}
          >
            Outstanding Balance
          </p>
          <p
            className={`text-2xl font-bold ${outstanding > 0 ? "text-red-700" : "text-gray-700"}`}
          >
            Rs. {outstanding.toFixed(2)}
          </p>
        </div>
      </div>

      {/* Recent invoices */}
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold">
          Recent Invoices (last 90 days)
        </h3>
        {recent.length === 0 ? (
          <p className="text-sm text-gray-400">No recent invoices</p>
        ) : (
          <InvoiceList invoices={recent} />
        )}
      </div>

      {/* Older collapsible */}
      {older.length > 0 && (
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <button
            onClick={() => setShowOlder((v) => !v)}
            className="flex w-full items-center justify-between text-sm font-semibold hover:text-primary"
          >
            <span>Older Invoices ({older.length})</span>
            {showOlder ? (
              <ChevronDown size={16} />
            ) : (
              <ChevronRight size={16} />
            )}
          </button>
          {showOlder && (
            <div className="mt-3">
              <InvoiceList invoices={older} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InvoiceList({ invoices }: { invoices: InvoiceLine[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-gray-500">
          <tr className="border-b">
            <th className="py-2 text-left">Invoice</th>
            <th className="py-2 text-left">Date</th>
            <th className="py-2 text-left">Doctor</th>
            <th className="py-2 text-right">Amount</th>
            <th className="py-2 text-right">Paid</th>
            <th className="py-2 text-center">Status</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => {
            const paid = inv.payments.reduce((s, p) => s + p.amount, 0);
            const statusClass =
              inv.paymentStatus === "PAID"
                ? "bg-green-100 text-green-700"
                : inv.paymentStatus === "PARTIAL"
                  ? "bg-amber-100 text-amber-700"
                  : "bg-red-100 text-red-700";
            return (
              <tr
                key={inv.id}
                className="border-b border-gray-50 hover:bg-gray-50"
              >
                <td className="py-2 font-mono text-xs">
                  {inv.invoiceNumber}
                </td>
                <td className="py-2 text-gray-600">
                  {new Date(inv.createdAt).toLocaleDateString("en-IN", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                  })}
                </td>
                <td className="py-2 text-gray-600">
                  {inv.appointment?.doctor?.user?.name
                    ? formatDoctorName(inv.appointment.doctor.user.name)
                    : "—"}
                </td>
                <td className="py-2 text-right font-medium">
                  Rs. {inv.totalAmount.toFixed(2)}
                </td>
                <td className="py-2 text-right text-gray-600">
                  Rs. {paid.toFixed(2)}
                </td>
                <td className="py-2 text-center">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusClass}`}
                  >
                    {inv.paymentStatus}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ───────────────────────────────────────────────────────
// Lab Results Tab
// ───────────────────────────────────────────────────────

interface TrendPoint {
  orderedAt: string;
  orderNumber: string;
  testName: string;
  parameter: string;
  value: string;
  unit: string | null;
  flag: string;
}

function parseRange(r?: string | null): { low?: number; high?: number } {
  if (!r) return {};
  const m = r.match(/([\d.]+)\s*[-–]\s*([\d.]+)/);
  if (m) return { low: parseFloat(m[1]), high: parseFloat(m[2]) };
  const lt = r.match(/<\s*([\d.]+)/);
  if (lt) return { high: parseFloat(lt[1]) };
  const gt = r.match(/>\s*([\d.]+)/);
  if (gt) return { low: parseFloat(gt[1]) };
  return {};
}

function TrendSparkline({
  patientId,
  parameter,
  currentValue,
  normalRange,
}: {
  patientId: string;
  parameter: string;
  currentValue: string;
  normalRange?: string | null;
}) {
  const [points, setPoints] = useState<TrendPoint[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ data: TrendPoint[] }>(
          `/lab/results/trends?patientId=${patientId}&parameter=${encodeURIComponent(parameter)}`
        );
        if (!cancelled) setPoints(res.data);
      } catch {
        if (!cancelled) setPoints([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId, parameter]);

  if (!points) return <span className="text-xs text-gray-400">loading...</span>;

  // Take last 5 numeric values, chronological
  const numeric = points
    .map((p) => ({ ...p, v: parseFloat(p.value) }))
    .filter((p) => !isNaN(p.v))
    .sort((a, b) => new Date(a.orderedAt).getTime() - new Date(b.orderedAt).getTime())
    .slice(-5);

  if (numeric.length < 2) {
    return <span className="text-xs italic text-gray-400">No trend</span>;
  }

  const values = numeric.map((p) => p.v);
  const { low, high } = parseRange(normalRange);
  const combined = [...values];
  if (typeof low === "number") combined.push(low);
  if (typeof high === "number") combined.push(high);
  const min = Math.min(...combined);
  const max = Math.max(...combined);
  const range = max - min || 1;

  const W = 100;
  const H = 30;
  const xStep = W / (values.length - 1);
  const toY = (v: number) => H - ((v - min) / range) * H;

  const path = values
    .map((v, i) => `${i === 0 ? "M" : "L"} ${i * xStep} ${toY(v)}`)
    .join(" ");

  const curr = parseFloat(currentValue);
  const prev = numeric.length >= 2 ? numeric[numeric.length - 2].v : null;
  const significantChange =
    prev !== null && !isNaN(curr) && prev !== 0
      ? Math.abs((curr - prev) / prev) > 0.2
      : false;

  return (
    <div className="flex items-center gap-2">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {/* Reference range band */}
        {typeof low === "number" && typeof high === "number" && (
          <rect
            x="0"
            y={toY(high)}
            width={W}
            height={Math.max(0, toY(low) - toY(high))}
            className="fill-green-100"
          />
        )}
        {/* Line */}
        <path
          d={path}
          className="fill-none stroke-blue-500"
          strokeWidth="1.5"
        />
        {/* Points */}
        {values.map((v, i) => (
          <circle
            key={i}
            cx={i * xStep}
            cy={toY(v)}
            r={i === values.length - 1 ? 2.5 : 1.5}
            className={
              i === values.length - 1
                ? significantChange
                  ? "fill-red-600"
                  : "fill-blue-600"
                : "fill-blue-400"
            }
          />
        ))}
      </svg>
      {significantChange && (
        <span
          title="Changed >20% from previous"
          className="rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700"
        >
          Δ
        </span>
      )}
    </div>
  );
}

function LabResultsTab({ patientId }: { patientId: string }) {
  const [orders, setOrders] = useState<LabOrderFull[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await api.get<{ data: LabOrderFull[] }>(
          `/patients/${patientId}/lab-orders`
        );
        setOrders(res.data);
      } catch {
        // noop
      }
      setLoading(false);
    })();
  }, [patientId]);

  if (loading) return <div className="p-6 text-gray-500">Loading labs...</div>;

  if (orders.length === 0) {
    return (
      <div className="rounded-xl bg-white p-8 text-center shadow-sm">
        <p className="text-gray-400">No lab orders yet</p>
      </div>
    );
  }

  function toggle(id: string) {
    setExpanded((e) => ({ ...e, [id]: !e[id] }));
  }

  return (
    <div className="space-y-3">
      {orders.map((o) => {
        const isOpen = expanded[o.id] ?? true;
        const totalResults = o.items.reduce(
          (s, i) => s + i.results.length,
          0
        );
        const abnormal = o.items.reduce(
          (s, i) => s + i.results.filter((r) => r.flag !== "NORMAL").length,
          0
        );
        const critical = o.items.reduce(
          (s, i) => s + i.results.filter((r) => r.flag === "CRITICAL").length,
          0
        );
        return (
          <div key={o.id} className="rounded-xl bg-white shadow-sm">
            <button
              onClick={() => toggle(o.id)}
              className="flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-gray-50"
            >
              {isOpen ? (
                <ChevronDown size={16} className="text-gray-400" />
              ) : (
                <ChevronRight size={16} className="text-gray-400" />
              )}
              <div className="flex-1">
                <div className="flex items-center gap-3">
                  <p className="font-medium">{o.orderNumber}</p>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      o.status === "COMPLETED"
                        ? "bg-green-100 text-green-700"
                        : o.status === "IN_PROGRESS"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {o.status.replace(/_/g, " ")}
                  </span>
                  {critical > 0 && (
                    <span className="rounded-full bg-red-700 px-2 py-0.5 text-xs font-bold text-white">
                      {critical} CRITICAL
                    </span>
                  )}
                  {abnormal > 0 && critical === 0 && (
                    <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-800">
                      {abnormal} abnormal
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-sm text-gray-500">
                  Ordered {new Date(o.orderedAt).toLocaleDateString()}
                  {o.doctor?.user?.name
                    ? ` · ${formatDoctorName(o.doctor.user.name)}`
                    : ""}
                  {totalResults > 0
                    ? ` · ${totalResults} result(s)`
                    : ""}
                </p>
              </div>
            </button>
            {isOpen && (
              <div className="border-t px-5 py-4">
                {o.items.map((item) => (
                  <div key={item.id} className="mb-4 last:mb-0">
                    <div className="mb-2 flex items-center gap-2">
                      <FlaskConical size={14} className="text-amber-600" />
                      <p className="font-medium">{item.test.name}</p>
                      <span className="font-mono text-xs text-gray-500">
                        {item.test.code}
                      </span>
                      {item.test.category && (
                        <span className="text-xs text-gray-400">
                          · {item.test.category}
                        </span>
                      )}
                    </div>
                    {item.results.length === 0 ? (
                      <p className="pl-6 text-sm italic text-gray-400">
                        Awaiting results
                      </p>
                    ) : (
                      <div className="overflow-x-auto pl-6">
                        <table className="w-full text-sm">
                          <thead className="text-xs text-gray-500">
                            <tr className="border-b">
                              <th className="py-1.5 text-left">Parameter</th>
                              <th className="py-1.5 text-left">Value</th>
                              <th className="py-1.5 text-left">Unit</th>
                              <th className="py-1.5 text-left">Normal Range</th>
                              <th className="py-1.5 text-center">Flag</th>
                              <th className="py-1.5 text-left">Trend (last 5)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {item.results.map((r) => (
                              <tr
                                key={r.id}
                                className="border-b border-gray-50"
                              >
                                <td className="py-1.5 font-medium">
                                  {r.parameter}
                                </td>
                                <td
                                  className={`py-1.5 font-semibold ${
                                    r.flag === "CRITICAL"
                                      ? "text-red-700"
                                      : r.flag === "HIGH"
                                        ? "text-orange-700"
                                        : r.flag === "LOW"
                                          ? "text-blue-700"
                                          : "text-gray-800"
                                  }`}
                                >
                                  {r.value}
                                </td>
                                <td className="py-1.5 text-gray-500">
                                  {r.unit || "—"}
                                </td>
                                <td className="py-1.5 text-xs text-gray-500">
                                  {r.normalRange || "—"}
                                </td>
                                <td className="py-1.5 text-center">
                                  <span
                                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${labFlagColors[r.flag]}`}
                                  >
                                    {r.flag}
                                  </span>
                                </td>
                                <td className="py-1.5">
                                  <TrendSparkline
                                    patientId={patientId}
                                    parameter={r.parameter}
                                    currentValue={r.value}
                                    normalRange={r.normalRange}
                                  />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ───────────────────────────────────────────────────────
// Quick Vitals Modal
// ───────────────────────────────────────────────────────

function QuickVitalsModal({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [sys, setSys] = useState("");
  const [dia, setDia] = useState("");
  const [temp, setTemp] = useState("");
  const [pulse, setPulse] = useState("");
  const [spo2, setSpo2] = useState("");
  const [weight, setWeight] = useState("");
  const [height, setHeight] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bmi = useMemo(() => {
    const w = parseFloat(weight);
    const h = parseFloat(height);
    if (w > 0 && h > 0) {
      const hm = h / 100;
      return w / (hm * hm);
    }
    return null;
  }, [weight, height]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // Find latest open appointment to attach vitals
      const appts = await api.get<{
        data: Array<{ id: string; status: string; date: string }>;
      }>(`/patients/${patientId}/history`);
      const openAppt = appts.data.find(
        (a) => a.status === "BOOKED" || a.status === "CHECKED_IN"
      );
      if (!openAppt) {
        throw new Error(
          "No active appointment found. Please book an appointment first."
        );
      }
      await api.post(`/patients/${patientId}/vitals`, {
        appointmentId: openAppt.id,
        patientId,
        bloodPressureSystolic: sys ? parseInt(sys) : undefined,
        bloodPressureDiastolic: dia ? parseInt(dia) : undefined,
        temperature: temp ? parseFloat(temp) : undefined,
        pulseRate: pulse ? parseInt(pulse) : undefined,
        spO2: spo2 ? parseInt(spo2) : undefined,
        weight: weight ? parseFloat(weight) : undefined,
        height: height ? parseFloat(height) : undefined,
        notes: notes || undefined,
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
    setSaving(false);
  }

  return (
    <Modal title="Record Vitals" onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-3" noValidate>
        {error && (
          <div className="rounded-md bg-red-50 p-2 text-sm text-red-700">
            {error}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-600">BP Systolic</label>
            <input
              type="number"
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={sys}
              onChange={(e) => setSys(e.target.value)}
              placeholder="120"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">BP Diastolic</label>
            <input
              type="number"
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={dia}
              onChange={(e) => setDia(e.target.value)}
              placeholder="80"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Temperature (°F)</label>
            <input
              type="number"
              step="0.1"
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={temp}
              onChange={(e) => setTemp(e.target.value)}
              placeholder="98.6"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Pulse (bpm)</label>
            <input
              type="number"
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={pulse}
              onChange={(e) => setPulse(e.target.value)}
              placeholder="72"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">SpO2 (%)</label>
            <input
              type="number"
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={spo2}
              onChange={(e) => setSpo2(e.target.value)}
              placeholder="98"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Weight (kg)</label>
            <input
              type="number"
              step="0.1"
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Height (cm)</label>
            <input
              type="number"
              step="0.1"
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={height}
              onChange={(e) => setHeight(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">BMI</label>
            <div className="rounded-md bg-gray-50 px-3 py-2 text-sm">
              {bmi ? (
                <>
                  <span className="font-semibold">{bmi.toFixed(1)}</span>{" "}
                  <span
                    className={`text-xs ${
                      bmi < 18.5
                        ? "text-blue-600"
                        : bmi < 25
                          ? "text-green-600"
                          : bmi < 30
                            ? "text-orange-600"
                            : "text-red-600"
                    }`}
                  >
                    (
                    {bmi < 18.5
                      ? "Underweight"
                      : bmi < 25
                        ? "Normal"
                        : bmi < 30
                          ? "Overweight"
                          : "Obese"}
                    )
                  </span>
                </>
              ) : (
                <span className="text-gray-400">—</span>
              )}
            </div>
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-600">Notes</label>
          <textarea
            rows={2}
            className="w-full rounded-md border px-3 py-2 text-sm"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Vitals"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ───────────────────────────────────────────────────────
// Quick Book Appointment Modal
// ───────────────────────────────────────────────────────

interface DoctorLite {
  id: string;
  user: { name: string };
  specialization?: string | null;
}

interface Slot {
  startTime: string;
  endTime: string;
  available: boolean;
}

function QuickBookModal({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [doctors, setDoctors] = useState<DoctorLite[]>([]);
  const [doctorId, setDoctorId] = useState("");
  const [date, setDate] = useState(() =>
    new Date().toISOString().split("T")[0]
  );
  const [slots, setSlots] = useState<Slot[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ data: DoctorLite[] }>("/doctors");
        setDoctors(res.data);
        if (res.data.length > 0) setDoctorId(res.data[0].id);
      } catch {
        // noop
      }
    })();
  }, []);

  useEffect(() => {
    if (!doctorId || !date) return;
    (async () => {
      try {
        const res = await api.get<{ data: { slots: Slot[] } }>(
          `/doctors/${doctorId}/slots?date=${date}`
        );
        setSlots(res.data.slots);
      } catch {
        setSlots([]);
      }
    })();
  }, [doctorId, date]);

  async function book(slotStart: string) {
    setSaving(true);
    setError(null);
    try {
      await api.post("/appointments/book", {
        patientId,
        doctorId,
        date,
        slotId: slotStart,
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
    setSaving(false);
  }

  return (
    <Modal title="Book Appointment" onClose={onClose} size="lg">
      <div className="space-y-3">
        {error && (
          <div className="rounded-md bg-red-50 p-2 text-sm text-red-700">
            {error}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-600">Doctor</label>
            <select
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={doctorId}
              onChange={(e) => setDoctorId(e.target.value)}
            >
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {formatDoctorName(d.user.name)}
                  {d.specialization ? ` — ${d.specialization}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-600">Date</label>
            <input
              type="date"
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        </div>
        <div>
          <p className="mb-2 text-xs font-semibold text-gray-600">
            Available Slots
          </p>
          {slots.length === 0 ? (
            <p className="text-sm text-gray-400">No slots available</p>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {slots.map((s) => (
                <button
                  key={s.startTime}
                  type="button"
                  disabled={!s.available || saving}
                  onClick={() => book(s.startTime)}
                  className={`rounded-md px-2 py-2 text-xs ${
                    s.available
                      ? "border border-primary text-primary hover:bg-primary hover:text-white"
                      : "cursor-not-allowed bg-gray-100 text-gray-400"
                  }`}
                >
                  {s.startTime}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ───────────────────────────────────────────────────────
// Medical Records Tab (preserved from original)
// ───────────────────────────────────────────────────────

function MedicalRecordsTab({
  patientId,
  canEdit,
}: {
  patientId: string;
  canEdit: boolean;
}) {
  const confirm = useConfirm();
  const [allergies, setAllergies] = useState<Allergy[]>([]);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [family, setFamily] = useState<FamilyHist[]>([]);
  const [immunizations, setImmunizations] = useState<Immunization[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<
    "allergy" | "condition" | "family" | "immunization" | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, c, f, i] = await Promise.all([
        api.get<{ data: Allergy[] }>(`/ehr/patients/${patientId}/allergies`),
        api.get<{ data: Condition[] }>(
          `/ehr/patients/${patientId}/conditions`
        ),
        api.get<{ data: FamilyHist[] }>(
          `/ehr/patients/${patientId}/family-history`
        ),
        api.get<{ data: Immunization[] }>(
          `/ehr/patients/${patientId}/immunizations`
        ),
      ]);
      setAllergies(a.data);
      setConditions(c.data);
      setFamily(f.data);
      setImmunizations(i.data);
    } catch {
      // noop
    }
    setLoading(false);
  }, [patientId]);

  useEffect(() => {
    load();
  }, [load]);

  async function del(url: string) {
    if (!(await confirm({ title: "Delete this record?", danger: true }))) return;
    try {
      await api.delete(url);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (loading) {
    return <div className="p-6 text-gray-500">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Family Members (linked) */}
      <FamilyLinksSection patientId={patientId} canEdit={canEdit} />

      {/* Advance Directives */}
      <AdvanceDirectivesSection patientId={patientId} canEdit={canEdit} />

      {/* Allergies */}
      <section className="rounded-xl bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-lg font-semibold">
            <AlertTriangle size={18} className="text-red-600" /> Allergies
          </h3>
          {canEdit && (
            <button
              onClick={() => setModal("allergy")}
              className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90"
            >
              <Plus size={14} /> Add
            </button>
          )}
        </div>
        {allergies.length === 0 ? (
          <p className="text-sm text-gray-400">No allergies recorded</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {allergies.map((a) => (
              <div
                key={a.id}
                className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm ${severityColors[a.severity]}`}
              >
                <span className="font-medium">{a.allergen}</span>
                <span className="text-xs opacity-80">
                  ({a.severity.replace("_", " ")})
                </span>
                {a.reaction && (
                  <span className="text-xs opacity-80">- {a.reaction}</span>
                )}
                {canEdit && (
                  <button
                    onClick={() => del(`/ehr/allergies/${a.id}`)}
                    className="ml-1 opacity-60 hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Chronic Conditions */}
      <section className="rounded-xl bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-lg font-semibold">
            <Heart size={18} className="text-red-500" /> Chronic Conditions
          </h3>
          {canEdit && (
            <button
              onClick={() => setModal("condition")}
              className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90"
            >
              <Plus size={14} /> Add
            </button>
          )}
        </div>
        {conditions.length === 0 ? (
          <p className="text-sm text-gray-400">No chronic conditions</p>
        ) : (
          <div className="space-y-2">
            {conditions.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between rounded-lg border border-gray-100 p-3"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{c.condition}</span>
                    {c.icd10Code && (
                      <span className="font-mono text-xs text-gray-500">
                        {c.icd10Code}
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${conditionColors[c.status]}`}
                    >
                      {c.status}
                    </span>
                  </div>
                  {c.diagnosedDate && (
                    <p className="mt-0.5 text-xs text-gray-500">
                      Diagnosed:{" "}
                      {new Date(c.diagnosedDate).toLocaleDateString()}
                    </p>
                  )}
                  {c.notes && (
                    <p className="mt-1 text-sm text-gray-600">{c.notes}</p>
                  )}
                </div>
                {canEdit && (
                  <button
                    onClick={() => del(`/ehr/conditions/${c.id}`)}
                    className="text-gray-400 hover:text-red-600"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Family History */}
      <section className="rounded-xl bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-lg font-semibold">
            <Users size={18} className="text-blue-500" /> Family History
          </h3>
          {canEdit && (
            <button
              onClick={() => setModal("family")}
              className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90"
            >
              <Plus size={14} /> Add
            </button>
          )}
        </div>
        {family.length === 0 ? (
          <p className="text-sm text-gray-400">No family history</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {family.map((f) => (
              <li
                key={f.id}
                className="flex items-center justify-between border-b border-gray-100 pb-2"
              >
                <div>
                  <span className="font-medium">{f.relation}:</span>{" "}
                  {f.condition}
                  {f.notes && (
                    <span className="ml-2 text-xs text-gray-500">
                      ({f.notes})
                    </span>
                  )}
                </div>
                {canEdit && (
                  <button
                    onClick={() => del(`/ehr/family-history/${f.id}`)}
                    className="text-gray-400 hover:text-red-600"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Immunizations */}
      <section className="rounded-xl bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-lg font-semibold">
            <Syringe size={18} className="text-green-600" /> Immunizations
          </h3>
          {canEdit && (
            <button
              onClick={() => setModal("immunization")}
              className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90"
            >
              <Plus size={14} /> Add
            </button>
          )}
        </div>
        {immunizations.length === 0 ? (
          <p className="text-sm text-gray-400">No immunizations recorded</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500">
                <tr className="border-b">
                  <th className="py-2 text-left">Vaccine</th>
                  <th className="py-2 text-left">Dose</th>
                  <th className="py-2 text-left">Date Given</th>
                  <th className="py-2 text-left">Next Due</th>
                  <th className="py-2 text-left">Batch</th>
                  {canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {immunizations.map((im) => {
                  const due = im.nextDueDate
                    ? new Date(im.nextDueDate)
                    : null;
                  const today = new Date();
                  today.setHours(0, 0, 0, 0);
                  const soon =
                    due &&
                    due.getTime() - today.getTime() < 30 * 86400_000 &&
                    due.getTime() >= today.getTime();
                  const overdue = due && due.getTime() < today.getTime();
                  return (
                    <tr
                      key={im.id}
                      className="border-b border-gray-50 hover:bg-gray-50"
                    >
                      <td className="py-2 font-medium">{im.vaccine}</td>
                      <td>{im.doseNumber ?? "-"}</td>
                      <td>{new Date(im.dateGiven).toLocaleDateString()}</td>
                      <td>
                        {due ? (
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              overdue
                                ? "bg-red-100 text-red-700"
                                : soon
                                  ? "bg-amber-100 text-amber-800"
                                  : "bg-green-100 text-green-700"
                            }`}
                          >
                            {due.toLocaleDateString()}
                          </span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="text-xs text-gray-500">
                        {im.batchNumber || "-"}
                      </td>
                      {canEdit && (
                        <td>
                          <button
                            onClick={() =>
                              del(`/ehr/immunizations/${im.id}`)
                            }
                            className="text-gray-400 hover:text-red-600"
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {modal === "allergy" && (
        <AllergyForm
          patientId={patientId}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            load();
          }}
        />
      )}
      {modal === "condition" && (
        <ConditionForm
          patientId={patientId}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            load();
          }}
        />
      )}
      {modal === "family" && (
        <FamilyForm
          patientId={patientId}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            load();
          }}
        />
      )}
      {modal === "immunization" && (
        <ImmunizationForm
          patientId={patientId}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────
// Add-record forms
// ───────────────────────────────────────────────────────

function AllergyForm({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [allergen, setAllergen] = useState("");
  const [severity, setSeverity] = useState<Allergy["severity"]>("MILD");
  const [reaction, setReaction] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!allergen.trim()) {
      toast.error("Allergen is required");
      return;
    }
    setSaving(true);
    try {
      await api.post("/ehr/allergies", {
        patientId,
        allergen,
        severity,
        reaction: reaction || undefined,
        notes: notes || undefined,
      });
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    }
    setSaving(false);
  }

  return (
    <Modal title="Add Allergy" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3" noValidate>
        <div>
          <label className="text-xs text-gray-600">Allergen *</label>
          <input
            className="w-full rounded-md border px-3 py-2 text-sm"
            value={allergen}
            onChange={(e) => setAllergen(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-gray-600">Severity *</label>
          <select
            className="w-full rounded-md border px-3 py-2 text-sm"
            value={severity}
            onChange={(e) =>
              setSeverity(e.target.value as Allergy["severity"])
            }
          >
            <option value="MILD">Mild</option>
            <option value="MODERATE">Moderate</option>
            <option value="SEVERE">Severe</option>
            <option value="LIFE_THREATENING">Life Threatening</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-600">Reaction</label>
          <input
            className="w-full rounded-md border px-3 py-2 text-sm"
            value={reaction}
            onChange={(e) => setReaction(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-gray-600">Notes</label>
          <textarea
            className="w-full rounded-md border px-3 py-2 text-sm"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConditionForm({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [condition, setCondition] = useState("");
  const [icd10Code, setIcd10] = useState("");
  const [diagnosedDate, setDate] = useState("");
  const [status, setStatus] = useState<Condition["status"]>("ACTIVE");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!condition.trim()) {
      toast.error("Condition is required");
      return;
    }
    setSaving(true);
    try {
      await api.post("/ehr/conditions", {
        patientId,
        condition,
        icd10Code: icd10Code || undefined,
        diagnosedDate: diagnosedDate || undefined,
        status,
        notes: notes || undefined,
      });
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    }
    setSaving(false);
  }

  return (
    <Modal title="Add Chronic Condition" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3" noValidate>
        <Icd10Autocomplete
          condition={condition}
          icd10Code={icd10Code}
          onSelect={(c, code) => {
            setCondition(c);
            setIcd10(code);
          }}
          onConditionChange={setCondition}
        />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-600">ICD-10</label>
            <input
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={icd10Code}
              onChange={(e) => setIcd10(e.target.value)}
              placeholder="Auto-filled"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Diagnosed</label>
            <input
              type="date"
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={diagnosedDate}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-600">Status *</label>
          <select
            className="w-full rounded-md border px-3 py-2 text-sm"
            value={status}
            onChange={(e) =>
              setStatus(e.target.value as Condition["status"])
            }
          >
            <option value="ACTIVE">Active</option>
            <option value="CONTROLLED">Controlled</option>
            <option value="RESOLVED">Resolved</option>
            <option value="RELAPSED">Relapsed</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-600">Notes</label>
          <textarea
            className="w-full rounded-md border px-3 py-2 text-sm"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function FamilyForm({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [relation, setRelation] = useState("");
  const [condition, setCondition] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!relation.trim()) {
      toast.error("Relation is required");
      return;
    }
    if (!condition.trim()) {
      toast.error("Condition is required");
      return;
    }
    setSaving(true);
    try {
      await api.post("/ehr/family-history", {
        patientId,
        relation,
        condition,
        notes: notes || undefined,
      });
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    }
    setSaving(false);
  }

  return (
    <Modal title="Add Family History" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3" noValidate>
        <div>
          <label className="text-xs text-gray-600">Relation *</label>
          <input
            placeholder="Mother, Father, Sibling..."
            className="w-full rounded-md border px-3 py-2 text-sm"
            value={relation}
            onChange={(e) => setRelation(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-gray-600">Condition *</label>
          <input
            className="w-full rounded-md border px-3 py-2 text-sm"
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-gray-600">Notes</label>
          <textarea
            className="w-full rounded-md border px-3 py-2 text-sm"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ImmunizationForm({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [vaccine, setVaccine] = useState("");
  const [doseNumber, setDose] = useState("");
  const [dateGiven, setDateGiven] = useState("");
  const [nextDueDate, setNextDue] = useState("");
  const [batchNumber, setBatch] = useState("");
  const [manufacturer, setMfg] = useState("");
  const [site, setSite] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!vaccine.trim()) {
      toast.error("Vaccine is required");
      return;
    }
    if (!dateGiven) {
      toast.error("Date given is required");
      return;
    }
    if (doseNumber && parseInt(doseNumber) < 1) {
      toast.error("Dose # must be 1 or greater");
      return;
    }
    setSaving(true);
    try {
      await api.post("/ehr/immunizations", {
        patientId,
        vaccine,
        doseNumber: doseNumber ? parseInt(doseNumber) : undefined,
        dateGiven,
        nextDueDate: nextDueDate || undefined,
        batchNumber: batchNumber || undefined,
        manufacturer: manufacturer || undefined,
        site: site || undefined,
        notes: notes || undefined,
      });
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    }
    setSaving(false);
  }

  return (
    <Modal title="Record Immunization" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3" noValidate>
        <div>
          <label className="text-xs text-gray-600">Vaccine *</label>
          <input
            className="w-full rounded-md border px-3 py-2 text-sm"
            value={vaccine}
            onChange={(e) => setVaccine(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-600">Dose #</label>
            <input
              type="number"
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={doseNumber}
              onChange={(e) => setDose(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Date Given *</label>
            <input
              type="date"
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={dateGiven}
              onChange={(e) => setDateGiven(e.target.value)}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-600">Next Due</label>
            <input
              type="date"
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={nextDueDate}
              onChange={(e) => setNextDue(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Site</label>
            <input
              placeholder="Left arm"
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={site}
              onChange={(e) => setSite(e.target.value)}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-600">Batch #</label>
            <input
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={batchNumber}
              onChange={(e) => setBatch(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Manufacturer</label>
            <input
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={manufacturer}
              onChange={(e) => setMfg(e.target.value)}
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-600">Notes</label>
          <textarea
            className="w-full rounded-md border px-3 py-2 text-sm"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ───────────────────────────────────────────────────────
// Documents Tab
// ───────────────────────────────────────────────────────

function DocumentsTab({
  patientId,
  canEdit,
}: {
  patientId: string;
  canEdit: boolean;
}) {
  const confirm = useConfirm();
  const [docs, setDocs] = useState<PatientDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: PatientDoc[] }>(
        `/ehr/patients/${patientId}/documents`
      );
      setDocs(res.data);
    } catch {
      // noop
    }
    setLoading(false);
  }, [patientId]);

  useEffect(() => {
    load();
  }, [load]);

  async function openDoc(id: string) {
    try {
      const res = await api.get<{
        data: PatientDoc & { downloadUrl: string };
      }>(`/ehr/documents/${id}`);
      const url = res.data.downloadUrl;
      if (url) {
        const base =
          process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";
        const origin = base.replace(/\/api\/v1$/, "");
        window.open(origin + url, "_blank");
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function del(id: string) {
    if (!(await confirm({ title: "Delete this document?", danger: true }))) return;
    try {
      await api.delete(`/ehr/documents/${id}`);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (loading) {
    return <div className="p-6 text-gray-500">Loading...</div>;
  }

  const grouped = DOC_TYPES.reduce<Record<string, PatientDoc[]>>((acc, t) => {
    acc[t] = docs.filter((d) => d.type === t);
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <FolderOpen size={18} className="text-primary" /> Documents
        </h3>
        {canEdit && (
          <button
            onClick={() => setShowUpload(true)}
            className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90"
          >
            <Upload size={14} /> Upload
          </button>
        )}
      </div>

      {docs.length === 0 ? (
        <div className="rounded-xl bg-white p-8 text-center shadow-sm">
          <p className="text-gray-400">No documents uploaded</p>
        </div>
      ) : (
        <div className="space-y-4">
          {DOC_TYPES.map((t) => {
            const group = grouped[t];
            if (group.length === 0) return null;
            return (
              <div key={t} className="rounded-xl bg-white p-5 shadow-sm">
                <h4 className="mb-3 text-sm font-semibold text-gray-600">
                  {t.replace(/_/g, " ")}
                </h4>
                <ul className="space-y-2">
                  {group.map((d) => (
                    <li
                      key={d.id}
                      className="flex items-center justify-between rounded-lg border border-gray-100 p-3"
                    >
                      <div>
                        <p className="font-medium">{d.title}</p>
                        <p className="text-xs text-gray-500">
                          {new Date(d.createdAt).toLocaleString()}
                          {d.fileSize
                            ? ` · ${Math.round(d.fileSize / 1024)} KB`
                            : ""}
                          {d.mimeType ? ` · ${d.mimeType}` : ""}
                        </p>
                        {d.notes && (
                          <p className="mt-1 text-xs text-gray-600">
                            {d.notes}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => openDoc(d.id)}
                          className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-primary"
                          title="Download"
                        >
                          <Download size={14} />
                        </button>
                        {canEdit && (
                          <button
                            onClick={() => del(d.id)}
                            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-red-600"
                            title="Delete"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {showUpload && (
        <DocumentUploadForm
          patientId={patientId}
          onClose={() => setShowUpload(false)}
          onSaved={() => {
            setShowUpload(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function DocumentUploadForm({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<(typeof DOC_TYPES)[number]>("LAB_REPORT");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return toast.error("Please choose a file");
    setSaving(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const r = reader.result as string;
          resolve(r.split(",")[1] || r);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const upload = await api.post<{
        data: { filePath: string; fileSize: number };
      }>("/uploads", {
        filename: file.name,
        base64Content: base64,
        patientId,
        type,
      });

      await api.post("/ehr/documents", {
        patientId,
        type,
        title: title || file.name,
        notes: notes || undefined,
        filePath: upload.data.filePath,
        fileSize: upload.data.fileSize,
        mimeType: file.type,
      });
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    }
    setSaving(false);
  }

  return (
    <Modal title="Upload Document" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3" noValidate>
        <div>
          <label className="text-xs text-gray-600">Type *</label>
          <select
            className="w-full rounded-md border px-3 py-2 text-sm"
            value={type}
            onChange={(e) =>
              setType(e.target.value as (typeof DOC_TYPES)[number])
            }
          >
            {DOC_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-600">Title</label>
          <input
            className="w-full rounded-md border px-3 py-2 text-sm"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Optional – defaults to filename"
          />
        </div>
        <div>
          <label className="text-xs text-gray-600">File *</label>
          <input
            type="file"
            className="w-full text-sm"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </div>
        <div>
          <label className="text-xs text-gray-600">Notes</label>
          <textarea
            className="w-full rounded-md border px-3 py-2 text-sm"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Uploading..." : "Upload"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ───────────────────────────────────────────────────────
// Problem List Card (top of Patient 360)
// ───────────────────────────────────────────────────────

interface ProblemItem {
  id: string;
  type: "condition" | "allergy" | "diagnosis" | "admission";
  title: string;
  severity: string;
  status: string;
  lastUpdated: string;
  source: string;
  icd10Code?: string | null;
}

function ProblemListCard({ patientId }: { patientId: string }) {
  const [items, setItems] = useState<ProblemItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ data: ProblemItem[] }>(
          `/ehr/patients/${patientId}/problem-list?activeOnly=true`
        );
        setItems(res.data || []);
      } catch {
        setItems([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [patientId]);

  if (loading) return null;
  if (items.length === 0) return null;

  const top = items.slice(0, 5);
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm border-l-4 border-red-500">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-red-600" />
          Problem List ({items.length})
        </h3>
        <Link
          href={`/dashboard/patients/${patientId}/problem-list`}
          className="text-xs text-blue-600 hover:underline"
        >
          View all
        </Link>
      </div>
      <ul className="space-y-1.5">
        {top.map((p) => (
          <li
            key={`${p.type}-${p.id}`}
            className="flex items-start gap-2 text-sm"
          >
            <span
              className={`mt-0.5 inline-block w-2 h-2 rounded-full shrink-0 ${
                p.severity === "LIFE_THREATENING" || p.severity === "SEVERE"
                  ? "bg-red-500"
                  : p.severity === "ACTIVE" || p.severity === "RELAPSED"
                    ? "bg-amber-500"
                    : "bg-slate-400"
              }`}
            />
            <div className="flex-1 min-w-0">
              <span className="font-medium text-gray-900">{p.title}</span>
              <span className="ml-2 text-xs text-gray-500">{p.source}</span>
            </div>
            <span
              className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
                p.severity === "LIFE_THREATENING"
                  ? "bg-red-100 text-red-700"
                  : p.severity === "SEVERE"
                    ? "bg-orange-100 text-orange-700"
                    : "bg-amber-100 text-amber-700"
              }`}
            >
              {p.severity}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ───────────────────────────────────────────────────────
// DNR / Advance Directive Banner
// ───────────────────────────────────────────────────────

interface AdvanceDirective {
  id: string;
  type: string;
  effectiveDate: string;
  expiryDate: string | null;
  notes: string;
  active: boolean;
}

function DnrBanner({ patientId }: { patientId: string }) {
  const [directives, setDirectives] = useState<AdvanceDirective[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ data: AdvanceDirective[] }>(
          `/ehr/patients/${patientId}/advance-directives`
        );
        setDirectives((res.data || []).filter((d) => d.active));
      } catch {
        setDirectives([]);
      }
    })();
  }, [patientId]);

  const dnr = directives.find(
    (d) =>
      d.active &&
      (d.type === "DNR" || d.type === "DNI" || d.type === "DNA") &&
      (!d.expiryDate || new Date(d.expiryDate) >= new Date())
  );
  if (!dnr) return null;
  return (
    <div className="mb-3 rounded-lg bg-red-50 border-2 border-red-500 p-3 flex items-center gap-3">
      <AlertTriangle className="h-6 w-6 text-red-600 shrink-0" />
      <div>
        <div className="font-bold text-red-800">{dnr.type} ORDER ACTIVE</div>
        <div className="text-sm text-red-700">{dnr.notes}</div>
        <div className="text-xs text-red-600">
          Effective: {dnr.effectiveDate.slice(0, 10)}
          {dnr.expiryDate ? ` · Expires: ${dnr.expiryDate.slice(0, 10)}` : ""}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────
// Patient 360 Tab
// ───────────────────────────────────────────────────────

function Patient360Tab({
  patientId,
  patient,
  stats,
  canEdit,
  onBookAppt,
}: {
  patientId: string;
  patient: PatientDetail & { photoUrl?: string | null };
  stats: PatientStats | null;
  canEdit: boolean;
  onBookAppt: () => void;
}) {
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [vitals, setVitals] = useState<VitalsTrendPoint[]>([]);
  const [prescriptions, setPrescriptions] = useState<
    Array<{
      id: string;
      diagnosis: string;
      createdAt: string;
      doctor?: { user?: { name?: string } };
      items: Array<{ medicineName: string; dosage: string; frequency: string; duration: string }>;
    }>
  >([]);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [allergyCount, setAllergyCount] = useState(0);
  const [immunOverdue, setImmunOverdue] = useState(0);
  const [labUnread, setLabUnread] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const ninety = new Date(Date.now() - 90 * 86400_000).toISOString();
        const thirty = new Date(Date.now() - 30 * 86400_000).toISOString();

        const [tRes, vRes, hRes, aRes, imRes, rxRes, cRes] = await Promise.all([
          api
            .get<{ data: TimelineEntry[] }>(`/patients/${patientId}/timeline`)
            .catch(() => ({ data: [] })),
          api
            .get<{ data: VitalsTrendPoint[] }>(
              `/patients/${patientId}/vitals-trend?from=${thirty}`
            )
            .catch(() => ({ data: [] })),
          api
            .get<{ data: any[] }>(`/patients/${patientId}/history`)
            .catch(() => ({ data: [] })),
          api
            .get<{ data: Allergy[] }>(`/ehr/patients/${patientId}/allergies`)
            .catch(() => ({ data: [] })),
          api
            .get<{ data: any[] }>(
              `/ehr/patients/${patientId}/immunizations/schedule?filter=overdue`
            )
            .catch(() =>
              api
                .get<{ data: any[] }>(
                  `/ehr/immunizations/schedule?patientId=${patientId}&filter=overdue`
                )
                .catch(() => ({ data: [] }))
            ),
          api
            .get<{ data: any[] }>(`/prescriptions?patientId=${patientId}&limit=3`)
            .catch(() => ({ data: [] })),
          api
            .get<{ data: Condition[] }>(`/ehr/patients/${patientId}/conditions`)
            .catch(() => ({ data: [] })),
        ]);

        if (cancelled) return;
        setTimeline((tRes.data || []).slice(0, 10));
        setVitals(vRes.data || []);
        setAllergyCount((aRes.data || []).length);
        setImmunOverdue(Array.isArray(imRes.data) ? imRes.data.length : 0);
        setPrescriptions((rxRes.data || []).slice(0, 3));
        setConditions(
          (cRes.data || []).filter(
            (c: Condition) => c.status === "ACTIVE" || c.status === "RELAPSED"
          )
        );
        // lab unread = orders completed but not yet "read" — approximate via completed in last 30d
        //
        // Issue #330: align this filter with /patients/:id/stats — the
        // header KPI counts BOOKED + CHECKED_IN + IN_CONSULTATION +
        // COMPLETED (i.e. anything except CANCELLED / NO_SHOW). Without
        // mirroring the same exclusion here, the "Last 90 Days" Visits
        // metric could diverge whenever a recent visit was cancelled.
        const VISIT_STATUSES = new Set([
          "BOOKED",
          "CHECKED_IN",
          "IN_CONSULTATION",
          "COMPLETED",
        ]);
        const visits = (hRes.data || []).filter((v: any) =>
          VISIT_STATUSES.has(v.status)
        );
        const since90 = new Date(ninety).getTime();
        const recent = visits.filter(
          (v: any) => new Date(v.date).getTime() >= since90
        );
        // compute metrics from recent visits
        const labs = recent.filter((v: any) => v.labOrder || v.lab);
        setLabUnread(labs.length);
        (window as any).__p360_recent = recent;
      } catch {
        // noop
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  const metrics = useMemo(() => {
    const recent = (typeof window !== "undefined" && (window as any).__p360_recent) || [];
    const total = recent.length;
    let totalSpent = 0;
    let consultDurSum = 0;
    let consultCount = 0;
    for (const v of recent) {
      if (v.invoice?.paymentStatus === "PAID") totalSpent += v.invoice.totalAmount || 0;
      if (v.consultationStartedAt && v.consultationEndedAt) {
        const d =
          new Date(v.consultationEndedAt).getTime() -
          new Date(v.consultationStartedAt).getTime();
        if (d > 0 && d < 4 * 3600_000) {
          consultDurSum += d;
          consultCount++;
        }
      }
    }
    const avgConsultMin =
      consultCount > 0 ? Math.round(consultDurSum / consultCount / 60000) : 0;
    return { visits: total, totalSpent, avgConsultMin };
  }, [timeline.length, vitals.length]);

  const bpPoints = vitals
    .map((v) => v.bloodPressureSystolic)
    .filter((x): x is number => x != null);
  const pulsePoints = vitals
    .map((v) => v.pulseRate)
    .filter((x): x is number => x != null);
  const weightPoints = vitals
    .map((v) => v.weight)
    .filter((x): x is number => x != null);

  if (loading) return <div className="p-6 text-gray-500">Loading 360° view...</div>;

  return (
    <div className="space-y-4">
      <ProblemListCard patientId={patientId} />
      {/* Active items row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <ActiveTile
          label="Admission"
          value={stats?.currentAdmissionId ? "Active" : "None"}
          tone={stats?.currentAdmissionId ? "purple" : "gray"}
          subtitle={stats?.currentAdmissionNumber || "not admitted"}
          href={stats?.currentAdmissionId ? `/dashboard/ipd/${stats.currentAdmissionId}` : undefined}
          Icon={BedDouble}
        />
        <ActiveTile
          label="Pending Bills"
          value={String(stats?.pendingBills || 0)}
          tone={stats && stats.pendingBills > 0 ? "amber" : "gray"}
          subtitle="unpaid invoices"
          href="/dashboard/billing"
          Icon={CreditCard}
        />
        <ActiveTile
          label="Unread Labs"
          value={String(labUnread)}
          tone={labUnread > 0 ? "blue" : "gray"}
          subtitle="recent results"
          Icon={FlaskConical}
        />
        <ActiveTile
          label="Overdue Immun."
          value={String(immunOverdue)}
          tone={immunOverdue > 0 ? "orange" : "gray"}
          subtitle="vaccines due"
          Icon={Syringe}
        />
        <ActiveTile
          label="Active Allergies"
          value={String(allergyCount)}
          tone={allergyCount > 0 ? "red" : "gray"}
          subtitle="recorded"
          Icon={AlertTriangle}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Left column */}
        <div className="space-y-4 lg:col-span-2">
          {/* Quick actions strip */}
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <h3 className="mb-3 text-sm font-semibold text-gray-700">Quick Actions</h3>
            <div className="flex flex-wrap gap-2">
              <QuickBtn
                label="Book Appointment"
                color="bg-primary"
                Icon={Calendar}
                onClick={onBookAppt}
              />
              <QuickLink
                href={`/dashboard/telemedicine/new?patientId=${patientId}`}
                label="Telemedicine"
                color="bg-purple-600"
                Icon={User}
              />
              {!stats?.currentAdmissionId && (
                <QuickLink
                  href={`/dashboard/ipd/admit?patientId=${patientId}`}
                  label="Admit"
                  color="bg-indigo-600"
                  Icon={BedDouble}
                />
              )}
              <QuickLink
                href={`/dashboard/lab/new?patientId=${patientId}`}
                label="Order Lab"
                color="bg-teal-600"
                Icon={FlaskConical}
              />
              <QuickLink
                href={`/dashboard/prescriptions/new?patientId=${patientId}`}
                label="Write Prescription"
                color="bg-green-600"
                Icon={Pill}
              />
              <QuickLink
                href={`/dashboard/billing/new?patientId=${patientId}`}
                label="Generate Bill"
                color="bg-amber-600"
                Icon={Receipt}
              />
            </div>
          </div>

          {/* Recent activity feed */}
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700">Recent Activity</h3>
              <span className="text-xs text-gray-400">Last 10 events</span>
            </div>
            {timeline.length === 0 ? (
              <p className="py-6 text-center text-xs text-gray-400">No events yet</p>
            ) : (
              <div className="space-y-2">
                {timeline.map((e) => {
                  const colors = timelineColorMap[e.color] || timelineColorMap.gray;
                  const Icon = (timelineIconMap as any)[e.icon] || Activity;
                  return (
                    <div
                      key={e.id}
                      className={`flex items-start gap-3 rounded-lg border-l-4 ${colors.border} ${colors.bg} p-2.5`}
                    >
                      <Icon size={16} className={colors.icon} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <p className="truncate text-sm font-medium text-gray-800">
                            {e.title}
                          </p>
                          <p className="shrink-0 text-[11px] text-gray-500">
                            {new Date(e.timestamp).toLocaleDateString("en-IN", {
                              day: "2-digit",
                              month: "short",
                            })}
                          </p>
                        </div>
                        {e.description && (
                          <p className="mt-0.5 truncate text-xs text-gray-600">
                            {e.description}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Recent prescriptions */}
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700">Recent Prescriptions</h3>
              <Link
                href="/dashboard/prescriptions"
                className="text-xs text-primary hover:underline"
              >
                View all
              </Link>
            </div>
            {prescriptions.length === 0 ? (
              <p className="py-4 text-center text-xs text-gray-400">No prescriptions</p>
            ) : (
              <div className="space-y-2">
                {prescriptions.map((rx) => (
                  <details key={rx.id} className="rounded-lg bg-green-50 p-3">
                    <summary className="flex cursor-pointer items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-gray-800">
                          {rx.diagnosis}
                        </p>
                        <p className="text-xs text-gray-500">
                          {rx.doctor?.user?.name ? formatDoctorName(rx.doctor.user.name) : "—"} ·{" "}
                          {new Date(rx.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                      <span className="text-xs text-gray-500">
                        {rx.items.length} item{rx.items.length === 1 ? "" : "s"}
                      </span>
                    </summary>
                    <div className="mt-2 space-y-1 border-t border-green-200 pt-2">
                      {rx.items.map((it, i) => (
                        <p key={i} className="text-xs text-gray-700">
                          <span className="font-medium">{it.medicineName}</span>{" "}
                          — {it.dosage} · {it.frequency} · {it.duration}
                        </p>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          {/* Hero */}
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <div className="flex items-center gap-3">
              {patient.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={patient.photoUrl}
                  alt={patient.user.name}
                  className="h-14 w-14 rounded-full object-cover"
                />
              ) : (
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
                  <User size={24} className="text-primary" />
                </div>
              )}
              <div className="min-w-0">
                <p className="truncate font-semibold text-gray-800">
                  {patient.user.name}
                </p>
                <p className="truncate text-xs text-gray-500">
                  {patient.mrNumber} ·{" "}
                  {patient.age != null ? `${patient.age} y` : ""} ·{" "}
                  {patient.gender}
                </p>
                {patient.bloodGroup && (
                  <p className="text-xs text-gray-500">
                    Blood: {patient.bloodGroup}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Key metrics */}
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <h3 className="mb-3 text-sm font-semibold text-gray-700">
              Last 90 Days
            </h3>
            <div className="grid grid-cols-2 gap-2">
              <Metric label="Visits" value={String(metrics.visits)} />
              <Metric
                label="Spent"
                value={`Rs. ${metrics.totalSpent.toFixed(0)}`}
              />
              <Metric
                label="Avg Consult"
                value={metrics.avgConsultMin ? `${metrics.avgConsultMin}m` : "—"}
              />
              <Metric label="Rx Count" value={String(prescriptions.length)} />
            </div>
          </div>

          {/* Vital sparklines */}
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <h3 className="mb-3 text-sm font-semibold text-gray-700">
              Vital Trends (30d)
            </h3>
            <div className="space-y-3">
              <Sparkline label="BP Systolic" unit="mmHg" values={bpPoints} color="#ef4444" />
              <Sparkline label="Pulse" unit="bpm" values={pulsePoints} color="#3b82f6" />
              <Sparkline label="Weight" unit="kg" values={weightPoints} color="#10b981" />
            </div>
          </div>

          {/* Diagnoses */}
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <h3 className="mb-3 text-sm font-semibold text-gray-700">
              Active Diagnoses
            </h3>
            {conditions.length === 0 ? (
              <p className="py-3 text-center text-xs text-gray-400">
                No active conditions
              </p>
            ) : (
              <div className="space-y-2">
                {conditions.slice(0, 6).map((c) => (
                  <div key={c.id} className="flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-gray-800">
                        {c.condition}
                      </p>
                      {c.icd10Code && (
                        <p className="text-xs text-gray-500">
                          ICD-10: {c.icd10Code}
                        </p>
                      )}
                    </div>
                    <span
                      className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        conditionColors[c.status]
                      }`}
                    >
                      {c.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ActiveTile({
  label,
  value,
  subtitle,
  tone,
  href,
  Icon,
}: {
  label: string;
  value: string;
  subtitle: string;
  tone: "purple" | "amber" | "blue" | "orange" | "red" | "gray";
  href?: string;
  Icon: React.ElementType;
}) {
  const toneMap: Record<string, string> = {
    purple: "bg-purple-50 border-purple-200 text-purple-700",
    amber: "bg-amber-50 border-amber-200 text-amber-700",
    blue: "bg-blue-50 border-blue-200 text-blue-700",
    orange: "bg-orange-50 border-orange-200 text-orange-700",
    red: "bg-red-50 border-red-200 text-red-700",
    gray: "bg-gray-50 border-gray-200 text-gray-600",
  };
  const body = (
    <div className={`rounded-xl border p-3 ${toneMap[tone]}`}>
      <div className="mb-1 flex items-center gap-1.5">
        <Icon size={14} />
        <p className="text-[11px] font-semibold uppercase tracking-wide opacity-80">
          {label}
        </p>
      </div>
      <p className="text-lg font-bold">{value}</p>
      <p className="text-[11px] opacity-70">{subtitle}</p>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

function QuickBtn({
  onClick,
  label,
  color,
  Icon,
}: {
  onClick: () => void;
  label: string;
  color: string;
  Icon: React.ElementType;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-lg ${color} px-3 py-1.5 text-xs font-medium text-white hover:opacity-90`}
    >
      <Icon size={13} /> {label}
    </button>
  );
}

function QuickLink({
  href,
  label,
  color,
  Icon,
}: {
  href: string;
  label: string;
  color: string;
  Icon: React.ElementType;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-1.5 rounded-lg ${color} px-3 py-1.5 text-xs font-medium text-white hover:opacity-90`}
    >
      <Icon size={13} /> {label}
    </Link>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-50 p-2">
      <p className="text-[11px] text-gray-500">{label}</p>
      <p className="text-sm font-bold text-gray-800">{value}</p>
    </div>
  );
}

function Sparkline({
  label,
  unit,
  values,
  color,
}: {
  label: string;
  unit: string;
  values: number[];
  color: string;
}) {
  if (values.length === 0) {
    return (
      <div>
        <p className="mb-1 text-xs text-gray-500">
          {label} <span className="text-gray-400">— no data</span>
        </p>
        <div className="h-8 rounded bg-gray-50" />
      </div>
    );
  }
  const w = 220;
  const h = 32;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = values.length > 1 ? w / (values.length - 1) : w;
  const pts = values
    .map((v, i) => {
      const x = i * stepX;
      const y = h - ((v - min) / range) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const latest = values[values.length - 1];
  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-600">{label}</p>
        <p className="text-xs font-semibold text-gray-800">
          {latest}
          <span className="ml-0.5 text-gray-400">{unit}</span>
        </p>
      </div>
      <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <polyline
          points={pts}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

// ───────────────────────────────────────────────────────
// Merge Patient Modal
// ───────────────────────────────────────────────────────

interface PatientSearchResult {
  id: string;
  mrNumber: string;
  age: number | null;
  gender: string;
  user: { name: string; phone: string };
}

function MergePatientModal({
  patient,
  onClose,
}: {
  patient: PatientDetail;
  onClose: () => void;
}) {
  const confirm = useConfirm();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PatientSearchResult[]>([]);
  const [selected, setSelected] = useState<PatientSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    if (!query || query.length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await api.get<{ data: PatientSearchResult[] }>(
          `/patients?search=${encodeURIComponent(query)}&limit=10`
        );
        setResults((res.data || []).filter((p) => p.id !== patient.id));
      } catch {
        setResults([]);
      }
      setSearching(false);
    }, 300);
    return () => clearTimeout(t);
  }, [query, patient.id]);

  async function confirmMerge() {
    if (!selected) return;
    if (
      !(await confirm({
        title: `Merge "${selected.user.name}" (${selected.mrNumber}) into "${patient.user.name}" (${patient.mrNumber})?`,
        message: "This cannot be undone.",
        danger: true,
      }))
    )
      return;
    setMerging(true);
    try {
      await api.post(`/patients/${patient.id}/merge`, {
        otherPatientId: selected.id,
      });
      toast.success("Patients merged");
      window.location.href = `/dashboard/patients/${patient.id}`;
    } catch (e) {
      toast.error((e as Error).message);
      setMerging(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Merge Duplicate Patient</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-800">
            <X size={18} />
          </button>
        </div>
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
          All records (appointments, prescriptions, invoices, labs, conditions,
          allergies...) from the source patient will be moved to this patient.
          The source record will be marked as merged.
        </div>
        <div className="mb-3">
          <label className="text-xs text-gray-600">
            Search patient to merge INTO this one
          </label>
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
            }}
            placeholder="Name, phone, or MR number"
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
          />
        </div>
        {searching && (
          <p className="text-xs text-gray-500">Searching...</p>
        )}
        {results.length > 0 && !selected && (
          <ul className="mb-3 max-h-52 divide-y divide-gray-100 overflow-y-auto rounded-lg border">
            {results.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => setSelected(r)}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-50"
                >
                  <div>
                    <div className="font-medium">{r.user.name}</div>
                    <div className="text-xs text-gray-500">
                      {r.mrNumber} · {r.user.phone}
                      {r.age != null ? ` · ${r.age}y` : ""} · {r.gender}
                    </div>
                  </div>
                  <span className="text-xs text-primary">Select</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {selected && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-green-300 bg-green-50 p-3 text-sm">
              <div className="mb-1 text-xs font-semibold text-green-700">
                KEEP (surviving)
              </div>
              <div className="font-medium">{patient.user.name}</div>
              <div className="text-xs text-gray-600">
                {patient.mrNumber} · {patient.user.phone}
              </div>
            </div>
            <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm">
              <div className="mb-1 text-xs font-semibold text-red-700">
                MERGE (will be archived)
              </div>
              <div className="font-medium">{selected.user.name}</div>
              <div className="text-xs text-gray-600">
                {selected.mrNumber} · {selected.user.phone}
              </div>
            </div>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            disabled={!selected || merging}
            onClick={confirmMerge}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {merging ? "Merging..." : "Confirm Merge"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────
// ICD-10 Autocomplete
// ───────────────────────────────────────────────────────

interface Icd10CodeResult {
  code: string;
  description: string;
  category: string | null;
}

function Icd10Autocomplete({
  condition,
  onSelect,
  onConditionChange,
}: {
  condition: string;
  icd10Code: string;
  onSelect: (condition: string, code: string) => void;
  onConditionChange: (v: string) => void;
}) {
  const [results, setResults] = useState<Icd10CodeResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!condition || condition.length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.get<{ data: Icd10CodeResult[] }>(
          `/icd10?q=${encodeURIComponent(condition)}&limit=10`
        );
        setResults(res.data || []);
        setOpen(true);
      } catch {
        setResults([]);
      }
      setLoading(false);
    }, 250);
    return () => clearTimeout(t);
  }, [condition]);

  return (
    <div className="relative">
      <label className="text-xs text-gray-600">Condition *</label>
      <input
        className="w-full rounded-md border px-3 py-2 text-sm"
        value={condition}
        onChange={(e) => {
          onConditionChange(e.target.value);
          setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        onFocus={() => results.length > 0 && setOpen(true)}
        placeholder="Type to search ICD-10 codes..."
        autoComplete="off"
      />
      {open && (results.length > 0 || loading) && (
        <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border bg-white shadow-lg">
          {loading && (
            <li className="px-3 py-2 text-xs text-gray-400">Searching...</li>
          )}
          {results.map((r) => (
            <li key={r.code}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(r.description, r.code);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
              >
                <span className="flex-1">{r.description}</span>
                <span className="font-mono text-xs text-primary">{r.code}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────
// Family Links Section
// ───────────────────────────────────────────────────────

interface FamilyData {
  guardian: {
    id: string;
    mrNumber: string;
    user: { name: string; phone: string };
  } | null;
  dependents: Array<{
    id: string;
    mrNumber: string;
    user: { name: string; phone: string };
  }>;
  familyLinks: Array<{
    id: string;
    relationship: string;
    relatedPatientId: string;
    relatedPatient: {
      id: string;
      mrNumber: string;
      user: { name: string; phone: string };
    };
  }>;
}

const RELATIONSHIPS = ["PARENT", "CHILD", "SPOUSE", "SIBLING", "GUARDIAN"] as const;
type Relationship = (typeof RELATIONSHIPS)[number];

const relColors: Record<string, string> = {
  PARENT: "bg-blue-100 text-blue-700",
  CHILD: "bg-green-100 text-green-700",
  SPOUSE: "bg-purple-100 text-purple-700",
  SIBLING: "bg-amber-100 text-amber-700",
  GUARDIAN: "bg-indigo-100 text-indigo-700",
};

function FamilyLinksSection({
  patientId,
  canEdit,
}: {
  patientId: string;
  canEdit: boolean;
}) {
  const confirm = useConfirm();
  const [data, setData] = useState<FamilyData | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: FamilyData }>(
        `/patients/${patientId}/family`
      );
      setData(res.data);
    } catch {
      setData(null);
    }
  }, [patientId]);

  useEffect(() => {
    load();
  }, [load]);

  async function unlink(relatedId: string) {
    if (!(await confirm({ title: "Unlink this family member?", danger: true }))) return;
    try {
      await api.delete(`/patients/${patientId}/link-family/${relatedId}`);
      toast.success("Unlinked");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const hasAny =
    data &&
    (data.guardian ||
      data.dependents.length > 0 ||
      data.familyLinks.length > 0);

  return (
    <section className="rounded-xl bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Users size={18} className="text-indigo-500" /> Family
        </h3>
        {canEdit && (
          <button
            onClick={() => setModalOpen(true)}
            className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90"
          >
            <Plus size={14} /> Add Family Member
          </button>
        )}
      </div>
      {!hasAny ? (
        <p className="text-sm text-gray-400">No linked family members.</p>
      ) : (
        <div className="space-y-3">
          {data?.guardian && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
              <div className="mb-1 text-xs font-semibold text-indigo-700">
                GUARDIAN
              </div>
              <Link
                href={`/dashboard/patients/${data.guardian.id}`}
                className="text-sm font-medium hover:underline"
              >
                {data.guardian.user.name}
              </Link>
              <div className="text-xs text-gray-600">
                {data.guardian.mrNumber} · {data.guardian.user.phone}
              </div>
            </div>
          )}
          {data && data.dependents.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-semibold text-gray-500">
                DEPENDENTS
              </div>
              <ul className="space-y-1">
                {data.dependents.map((d) => (
                  <li
                    key={d.id}
                    className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2 text-sm"
                  >
                    <Link
                      href={`/dashboard/patients/${d.id}`}
                      className="font-medium hover:underline"
                    >
                      {d.user.name}
                    </Link>
                    <span className="text-xs text-gray-500">
                      {d.mrNumber}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data && data.familyLinks.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-semibold text-gray-500">
                FAMILY MEMBERS
              </div>
              <ul className="space-y-1">
                {data.familyLinks.map((l) => (
                  <li
                    key={l.id}
                    className="flex items-center justify-between rounded-lg border border-gray-100 px-3 py-2 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          relColors[l.relationship] || "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {l.relationship}
                      </span>
                      <Link
                        href={`/dashboard/patients/${l.relatedPatient.id}`}
                        className="font-medium hover:underline"
                      >
                        {l.relatedPatient.user.name}
                      </Link>
                      <span className="text-xs text-gray-500">
                        {l.relatedPatient.mrNumber}
                      </span>
                    </div>
                    {canEdit && (
                      <button
                        onClick={() => unlink(l.relatedPatientId)}
                        className="text-gray-400 hover:text-red-600"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {modalOpen && (
        <LinkFamilyModal
          patientId={patientId}
          onClose={() => setModalOpen(false)}
          onSaved={() => {
            setModalOpen(false);
            load();
          }}
        />
      )}
    </section>
  );
}

function LinkFamilyModal({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PatientSearchResult[]>([]);
  const [selected, setSelected] = useState<PatientSearchResult | null>(null);
  const [relationship, setRelationship] = useState<Relationship>("PARENT");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!query || query.length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ data: PatientSearchResult[] }>(
          `/patients?search=${encodeURIComponent(query)}&limit=10`
        );
        setResults((res.data || []).filter((p) => p.id !== patientId));
      } catch {
        setResults([]);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, patientId]);

  async function submit() {
    if (!selected) return;
    setSaving(true);
    try {
      await api.post(`/patients/${patientId}/link-family`, {
        relatedPatientId: selected.id,
        relationship,
      });
      toast.success("Family member linked");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    }
    setSaving(false);
  }

  return (
    <Modal title="Add Family Member" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="text-xs text-gray-600">Search patient *</label>
          <input
            className="w-full rounded-md border px-3 py-2 text-sm"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
            }}
            placeholder="Name, phone, or MR number"
          />
        </div>
        {results.length > 0 && !selected && (
          <ul className="max-h-40 divide-y divide-gray-100 overflow-y-auto rounded-lg border">
            {results.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelected(r)}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-50"
                >
                  <div>
                    <div className="font-medium">{r.user.name}</div>
                    <div className="text-xs text-gray-500">
                      {r.mrNumber} · {r.user.phone}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
        {selected && (
          <div className="rounded-lg border border-green-300 bg-green-50 p-3 text-sm">
            <div className="font-medium">{selected.user.name}</div>
            <div className="text-xs text-gray-600">
              {selected.mrNumber} · {selected.user.phone}
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="mt-1 text-xs text-primary"
            >
              Change
            </button>
          </div>
        )}
        <div>
          <label className="text-xs text-gray-600">Relationship *</label>
          <select
            value={relationship}
            onChange={(e) => setRelationship(e.target.value as Relationship)}
            className="w-full rounded-md border px-3 py-2 text-sm"
          >
            {RELATIONSHIPS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            disabled={!selected || saving}
            onClick={submit}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Linking..." : "Link"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ───────────────────────────────────────────────────────
// Advance Directives Section
// ───────────────────────────────────────────────────────

const DIRECTIVE_TYPES = [
  "DNR",
  "DNI",
  "DNA",
  "LIVING_WILL",
  "ORGAN_DONATION",
  "OTHER",
] as const;

const directiveColors: Record<string, string> = {
  DNR: "bg-red-100 text-red-700",
  DNI: "bg-red-100 text-red-700",
  DNA: "bg-red-100 text-red-700",
  LIVING_WILL: "bg-blue-100 text-blue-700",
  ORGAN_DONATION: "bg-green-100 text-green-700",
  OTHER: "bg-gray-100 text-gray-700",
};

function AdvanceDirectivesSection({
  patientId,
  canEdit,
}: {
  patientId: string;
  canEdit: boolean;
}) {
  const confirm = useConfirm();
  const [directives, setDirectives] = useState<AdvanceDirective[]>([]);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ data: AdvanceDirective[] }>(
        `/ehr/patients/${patientId}/advance-directives?includeInactive=true`
      );
      setDirectives(res.data || []);
    } catch {
      setDirectives([]);
    }
  }, [patientId]);

  useEffect(() => {
    load();
  }, [load]);

  async function softDelete(id: string) {
    if (!(await confirm({ title: "Mark this directive inactive?", danger: true }))) return;
    try {
      await api.delete(`/ehr/advance-directives/${id}`);
      toast.success("Directive inactivated");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <section className="rounded-xl bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <AlertTriangle size={18} className="text-amber-600" /> Advance Directives
        </h3>
        {canEdit && (
          <button
            onClick={() => setModalOpen(true)}
            className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90"
          >
            <Plus size={14} /> Add Directive
          </button>
        )}
      </div>
      {directives.length === 0 ? (
        <p className="text-sm text-gray-400">No advance directives recorded.</p>
      ) : (
        <ul className="space-y-2">
          {directives.map((d) => (
            <li
              key={d.id}
              className={`rounded-lg border p-3 ${
                d.active
                  ? "border-gray-200"
                  : "border-gray-100 bg-gray-50 opacity-70"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        directiveColors[d.type] || "bg-gray-100 text-gray-700"
                      }`}
                    >
                      {d.type.replace("_", " ")}
                    </span>
                    {!d.active && (
                      <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-600">
                        INACTIVE
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    Effective: {d.effectiveDate.slice(0, 10)}
                    {d.expiryDate ? ` · Expires: ${d.expiryDate.slice(0, 10)}` : ""}
                  </div>
                  {d.notes && (
                    <div className="mt-1 text-sm text-gray-700">{d.notes}</div>
                  )}
                </div>
                {canEdit && d.active && (
                  <button
                    onClick={() => softDelete(d.id)}
                    className="text-gray-400 hover:text-red-600"
                    title="Mark inactive"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {modalOpen && (
        <AdvanceDirectiveForm
          patientId={patientId}
          onClose={() => setModalOpen(false)}
          onSaved={() => {
            setModalOpen(false);
            load();
          }}
        />
      )}
    </section>
  );
}

function AdvanceDirectiveForm({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<(typeof DIRECTIVE_TYPES)[number]>("DNR");
  const [effectiveDate, setEffectiveDate] = useState(
    new Date().toISOString().slice(0, 10)
  );
  const [expiryDate, setExpiryDate] = useState("");
  const [witnessedBy, setWitnessedBy] = useState("");
  const [notes, setNotes] = useState("");
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!effectiveDate) {
      toast.error("Effective date is required");
      return;
    }
    if (!notes.trim()) {
      toast.error("Notes are required");
      return;
    }
    setSaving(true);
    try {
      await api.post(`/ehr/patients/${patientId}/advance-directives`, {
        type,
        effectiveDate,
        expiryDate: expiryDate || undefined,
        witnessedBy: witnessedBy || undefined,
        notes,
        active,
      });
      toast.success("Directive added");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    }
    setSaving(false);
  }

  return (
    <Modal title="Add Advance Directive" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3" noValidate>
        <div>
          <label className="text-xs text-gray-600">Type *</label>
          <select
            value={type}
            onChange={(e) =>
              setType(e.target.value as (typeof DIRECTIVE_TYPES)[number])
            }
            className="w-full rounded-md border px-3 py-2 text-sm"
          >
            {DIRECTIVE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-600">Effective Date *</label>
            <input
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Expiry Date</label>
            <input
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-600">Witnessed By</label>
          <input
            value={witnessedBy}
            onChange={(e) => setWitnessedBy(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-gray-600">Notes *</label>
          <textarea
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          Active
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Pricing Tier Badge + Edit ─────────────────────────

function PricingTierBadge({
  patient,
  onUpdated,
}: {
  patient: PatientDetail;
  onUpdated: (tier: string) => void;
}) {
  const { user } = useAuthStore();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(patient.pricingTier || "STANDARD");
  const [saving, setSaving] = useState(false);
  const tier = patient.pricingTier || "STANDARD";
  const isAdmin = user?.role === "ADMIN";

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/patients/${patient.id}`, { pricingTier: value });
      onUpdated(value);
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    }
    setSaving(false);
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="rounded border px-2 py-0.5 text-xs"
        >
          {PRICING_TIERS.map((t) => (
            <option key={t} value={t}>
              {t.replace("_", " ")}
            </option>
          ))}
        </select>
        <button
          onClick={save}
          disabled={saving}
          className="rounded bg-primary px-2 py-0.5 text-xs text-white disabled:opacity-50"
        >
          {saving ? "..." : "Save"}
        </button>
        <button
          onClick={() => {
            setEditing(false);
            setValue(patient.pricingTier || "STANDARD");
          }}
          className="rounded border px-2 py-0.5 text-xs"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={`rounded-full px-3 py-0.5 text-xs font-semibold ${
          TIER_COLORS[tier] || TIER_COLORS.STANDARD
        }`}
        title="Pricing tier"
      >
        {tier.replace("_", " ")}
      </span>
      {isAdmin && (
        <button
          onClick={() => setEditing(true)}
          className="rounded border border-gray-200 px-2 py-0.5 text-[10px] text-gray-500 hover:bg-gray-50"
          aria-label="Edit pricing tier"
        >
          Edit Tier
        </button>
      )}
    </span>
  );
}
