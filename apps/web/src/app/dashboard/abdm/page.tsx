"use client";

/**
 * ABDM / ABHA management page.
 *
 * Three tabs:
 *   - Link ABHA: verify + link an ABHA address to a MedCore patient.
 *   - Consents: list, request, and revoke consent artefacts for a patient.
 *   - Care Contexts: push a consultation/appointment as a care context to ABDM.
 *
 * Role-gated to ADMIN + DOCTOR + RECEPTION (matches the backend `authorize()`).
 * Backend routes: POST /api/v1/abdm/abha/verify, /abha/link,
 *                 /consent/request, GET /consent/:id, POST /consent/:id/revoke,
 *                 POST /care-context/link.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { useAuthStore } from "@/lib/store";
import {
  Shield,
  Link as LinkIcon,
  FileCheck,
  Activity,
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Trash2,
  FileText,
  Upload,
  ScrollText,
  Download,
  RefreshCw,
} from "lucide-react";
import { SkeletonText } from "@/components/Skeleton";

// ─── Types ──────────────────────────────────────────────────────────────────

type TabKey =
  | "dashboard"
  | "link"
  | "profile"
  | "consents"
  | "records"
  | "upload"
  | "careContexts"
  | "audit";

interface PatientOpt {
  id: string;
  user: { name: string; phone?: string | null };
  dateOfBirth?: string | null;
}

// Which tabs each role can see. Patients self-serve a narrower set (no upload,
// no care-context push, no admin audit); they don't search patients — they're
// scoped to their own record server-side.
const TABS_BY_ROLE: Record<string, TabKey[]> = {
  ADMIN: ["dashboard", "link", "profile", "consents", "records", "upload", "careContexts", "audit"],
  DOCTOR: ["dashboard", "link", "profile", "consents", "records", "upload", "careContexts"],
  RECEPTION: ["dashboard", "link", "profile", "consents", "records"],
  PATIENT: ["profile", "consents", "records"],
};

interface ConsentRow {
  id: string;
  status: string;
  purpose: string;
  hiTypes: string[];
  dateFrom: string;
  dateTo: string;
  expiresAt: string;
  abhaAddress: string;
  requesterName?: string;
  createdAt: string;
}

const CONSENT_PURPOSES = [
  "CAREMGT",
  "BTG",
  "PUBHLTH",
  "HPAYMT",
  "DSRCH",
  "PATRQT",
] as const;

const HI_TYPES = [
  "OPConsultation",
  "Prescription",
  "DischargeSummary",
  "DiagnosticReport",
  "ImmunizationRecord",
  "HealthDocumentRecord",
  "WellnessRecord",
] as const;

const CARE_CONTEXT_TYPES = [
  "OPConsultation",
  "DischargeSummary",
  "DiagnosticReport",
] as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function inOneYear() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

// Issue #758: previously defaulted to "sandbox" when NEXT_PUBLIC_ABDM_MODE
// was unset, which made the production deploy show the SANDBOX banner +
// mock OTP placeholder when the env var hadn't been wired through. The
// safer default is `production`: dev/staging environments opt-IN to
// sandbox via `NEXT_PUBLIC_ABDM_MODE=sandbox`, missing-env never advertises
// sandbox-mode to real users. Hoisted to module scope so sub-components
// (LinkAbhaTab, ConsentsTab, CareContextsTab) can read it without prop
// threading.
function isSandbox(): boolean {
  return (
    typeof process !== "undefined" &&
    process.env.NEXT_PUBLIC_ABDM_MODE === "sandbox"
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function AbdmPage() {
  const router = useRouter();
  const { user, isLoading } = useAuthStore();
  const role = user?.role ?? "";
  const isPatient = role === "PATIENT";
  const allowedTabs = TABS_BY_ROLE[role] ?? [];
  const [tab, setTab] = useState<TabKey>("dashboard");
  const sandbox = isSandbox();

  // Patient search (shared across staff tabs). Patients are scoped to self.
  const [patientSearch, setPatientSearch] = useState("");
  const [patientResults, setPatientResults] = useState<PatientOpt[]>([]);
  const [patient, setPatient] = useState<PatientOpt | null>(null);

  // For PATIENT role, resolve their own patient id once so the scoped tabs
  // (Profile, Consents, Records) can render without a search picker.
  useEffect(() => {
    if (!isPatient) return;
    let cancelled = false;
    (async () => {
      try {
        const me = await api.get<{ data: { patient?: { id?: string } | null } }>(
          "/auth/me",
          { skip401Redirect: true },
        );
        const pid = me.data?.patient?.id;
        if (pid && !cancelled) {
          setPatient({ id: pid, user: { name: "You" } });
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPatient]);

  // Ensure the active tab is one this role can see (default to the first).
  useEffect(() => {
    if (allowedTabs.length > 0 && !allowedTabs.includes(tab)) {
      setTab(allowedTabs[0]);
    }
  }, [allowedTabs, tab]);

  useEffect(() => {
    const allowed = ["ADMIN", "DOCTOR", "RECEPTION", "PATIENT"];
    if (!isLoading && user && !allowed.includes(user.role)) {
      router.push("/dashboard");
    }
  }, [user, isLoading, router]);

  useEffect(() => {
    if (patientSearch.length < 2) {
      setPatientResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ data: PatientOpt[] }>(
          `/patients?search=${encodeURIComponent(patientSearch)}`
        );
        setPatientResults(res.data ?? []);
      } catch {
        setPatientResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [patientSearch]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }

  if (user && !["ADMIN", "DOCTOR", "RECEPTION", "PATIENT"].includes(user.role)) {
    return null;
  }

  return (
    <div className="mx-auto max-w-5xl">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <Shield className="h-6 w-6 text-indigo-600" />
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            ABDM / ABHA
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Link Ayushman Bharat Health Accounts, manage consents and push care
            contexts to the national health stack.
          </p>
        </div>
      </div>

      {sandbox && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <div>
            <strong>SANDBOX MODE</strong> — all ABDM traffic is routed to the
            staging gateway. No real ABHA records are affected.
          </div>
        </div>
      )}

      {/* Patient picker (staff only — patients are scoped to themselves) */}
      {!isPatient && (
      <div className="mb-6 rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <label
          htmlFor="abdm-patient-search"
          className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Patient
        </label>
        {patient ? (
          <div className="flex items-center justify-between rounded-lg bg-indigo-50 px-3 py-2 text-sm dark:bg-indigo-950/40">
            <span>
              <strong>{patient.user.name}</strong>{" "}
              <span className="ml-2 font-mono text-xs text-gray-500">
                {patient.id.slice(0, 8)}…
              </span>
            </span>
            <button
              onClick={() => setPatient(null)}
              className="text-xs text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
            >
              Change
            </button>
          </div>
        ) : (
          <>
            <input
              id="abdm-patient-search"
              type="text"
              value={patientSearch}
              onChange={(e) => setPatientSearch(e.target.value)}
              placeholder="Search patient by name, phone or MRN…"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            />
            {patientResults.length > 0 && (
              <ul className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-gray-200 bg-white text-sm dark:border-gray-700 dark:bg-gray-800">
                {patientResults.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => {
                        setPatient(p);
                        setPatientSearch("");
                        setPatientResults([]);
                      }}
                      className="block w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700"
                    >
                      {p.user.name}
                      <span className="ml-2 text-xs text-gray-500">
                        {p.user.phone ?? ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      )}

      {/* Tabs — role-aware */}
      <div className="mb-4 flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-800">
        {allowedTabs.map((key) => (
          <TabButton
            key={key}
            active={tab === key}
            onClick={() => setTab(key)}
            icon={TAB_META[key].icon}
            label={TAB_META[key].label}
          />
        ))}
      </div>

      {tab === "dashboard" && <DashboardTab />}
      {tab === "link" && <LinkAbhaTab patient={patient} />}
      {tab === "profile" && <ProfileTab patient={patient} isPatient={isPatient} />}
      {tab === "consents" && <ConsentsTab patient={patient} />}
      {tab === "records" && <RecordsTab patient={patient} isPatient={isPatient} />}
      {tab === "upload" && <UploadTab patient={patient} />}
      {tab === "careContexts" && <CareContextsTab patient={patient} />}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}

// Tab labels + icons.
const TAB_META: Record<TabKey, { label: string; icon: React.ElementType }> = {
  dashboard: { label: "Dashboard", icon: Activity },
  link: { label: "Link ABHA", icon: LinkIcon },
  profile: { label: "ABHA Profile", icon: Shield },
  consents: { label: "Consents", icon: FileCheck },
  records: { label: "Medical Records", icon: FileText },
  upload: { label: "Upload Records", icon: Upload },
  careContexts: { label: "Care Contexts", icon: Activity },
  audit: { label: "Audit Logs", icon: ScrollText },
};

// ─── Tabs ───────────────────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ElementType;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={
        "flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition " +
        (active
          ? "border-indigo-600 text-indigo-700 dark:text-indigo-400"
          : "border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-gray-200")
      }
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function LinkAbhaTab({ patient }: { patient: PatientOpt | null }) {
  const [abhaAddress, setAbhaAddress] = useState("");
  const [abhaNumber, setAbhaNumber] = useState("");
  const [otp, setOtp] = useState("");
  const [txnId, setTxnId] = useState<string | null>(null);
  const [sendingOtp, setSendingOtp] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [linking, setLinking] = useState(false);
  const [result, setResult] = useState<{
    kind: "ok" | "err" | "warn";
    message: string;
  } | null>(null);

  // Step 1 — send OTP to the ABHA holder's registered mobile.
  async function sendOtp() {
    if (!abhaAddress.match(/@/)) {
      setResult({ kind: "err", message: "Enter a valid ABHA address (handle@domain)" });
      return;
    }
    setSendingOtp(true);
    setResult(null);
    try {
      const res = await api.post<{ data: { transactionId: string } }>(
        "/abdm/abha/auth/otp",
        { abhaAddress },
      );
      setTxnId(res.data.transactionId);
      setVerified(false);
      setResult({
        kind: "ok",
        message: "OTP sent to the ABHA-registered mobile. Enter it below to verify.",
      });
    } catch (err) {
      setResult({ kind: "err", message: (err as Error).message || "Could not send OTP" });
    } finally {
      setSendingOtp(false);
    }
  }

  // Step 2 — confirm the OTP → verified ABHA profile.
  async function verify() {
    if (!txnId) {
      setResult({ kind: "err", message: "Send the OTP first" });
      return;
    }
    if (!/^\d{4,8}$/.test(otp)) {
      setResult({ kind: "err", message: "Enter the OTP (4–8 digits)" });
      return;
    }
    setVerifying(true);
    setResult(null);
    try {
      const res = await api.post<{ data: { ok: boolean; name?: string } }>(
        "/abdm/abha/auth/verify",
        { transactionId: txnId, otp, abhaAddress },
      );
      if (res.data.ok) {
        setVerified(true);
        setResult({ kind: "ok", message: `Verified — ${res.data.name ?? "ABHA account valid"}` });
      } else {
        setResult({ kind: "err", message: "ABHA could not be verified" });
      }
    } catch (err) {
      setResult({ kind: "err", message: (err as Error).message || "Verification failed" });
    } finally {
      setVerifying(false);
    }
  }

  async function link() {
    if (!patient) {
      setResult({ kind: "err", message: "Pick a patient first" });
      return;
    }
    if (!abhaAddress.match(/@/)) {
      setResult({ kind: "err", message: "ABHA address must be handle@domain" });
      return;
    }
    setLinking(true);
    setResult(null);
    try {
      await api.post<{ data: { linkId: string } }>("/abdm/abha/link", {
        patientId: patient.id,
        abhaAddress,
        abhaNumber: abhaNumber || undefined,
        // Already OTP-verified in this session — tell the server to skip the
        // re-verify round-trip (which uses the legacy existsByHealthId path).
        preVerified: true,
      });
      setResult({
        kind: "ok",
        message: "Link initiated — ABDM will confirm via callback.",
      });
    } catch (err) {
      setResult({
        kind: "err",
        message: (err as Error).message || "Link failed",
      });
    } finally {
      setLinking(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <h2 className="mb-3 text-lg font-semibold">Link ABHA to patient</h2>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label htmlFor="abdm-link-abha-address" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            ABHA address
          </label>
          <input
            id="abdm-link-abha-address"
            type="text"
            value={abhaAddress}
            onChange={(e) => setAbhaAddress(e.target.value)}
            placeholder={isSandbox() ? "rahul@sbx" : "username@abdm"}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
        </div>
        <div>
          <label htmlFor="abdm-link-abha-number" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            ABHA number <span className="text-xs text-gray-400">(optional)</span>
          </label>
          <input
            id="abdm-link-abha-number"
            type="text"
            value={abhaNumber}
            onChange={(e) => setAbhaNumber(e.target.value)}
            placeholder="12-3456-7890-1234"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
        </div>
      </div>

      {/* Step 1 — send OTP. Once sent, the OTP field + Verify appear. */}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <button
          onClick={sendOtp}
          disabled={sendingOtp || !abhaAddress}
          className="flex items-center gap-2 rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
        >
          {sendingOtp && <Loader2 className="h-4 w-4 animate-spin" />}
          {txnId ? "Resend OTP" : "Send OTP"}
        </button>

        {txnId && (
          <>
            <div>
              <label htmlFor="abdm-link-otp" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                OTP{isSandbox() ? " (sandbox: 123456)" : ""}
              </label>
              <input
                id="abdm-link-otp"
                type="text"
                inputMode="numeric"
                maxLength={8}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                placeholder="123456"
                className="mt-1 w-36 rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
              />
            </div>
            <button
              onClick={verify}
              disabled={verifying || otp.length < 4}
              className="flex items-center gap-2 rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
            >
              {verifying && <Loader2 className="h-4 w-4 animate-spin" />} Verify ABHA
            </button>
          </>
        )}

        <button
          onClick={link}
          disabled={linking || !patient || !abhaAddress || !verified}
          title={!verified ? "Verify the ABHA with OTP first" : undefined}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {linking && <Loader2 className="h-4 w-4 animate-spin" />} Link to patient
        </button>
      </div>

      {result && (
        <div
          className={
            "mt-4 flex items-start gap-2 rounded-lg p-3 text-sm " +
            (result.kind === "ok"
              ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
              : result.kind === "warn"
                ? "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                : "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200")
          }
        >
          {result.kind === "ok" ? (
            <CheckCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          ) : result.kind === "warn" ? (
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          ) : (
            <XCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          )}
          {result.message}
        </div>
      )}
    </div>
  );
}

function ConsentsTab({ patient }: { patient: PatientOpt | null }) {
  const confirm = useConfirm();
  const [consents, setConsents] = useState<ConsentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New consent form
  const [abhaAddress, setAbhaAddress] = useState("");
  const [purpose, setPurpose] = useState<(typeof CONSENT_PURPOSES)[number]>(
    "CAREMGT"
  );
  const [hiTypes, setHiTypes] = useState<string[]>(["OPConsultation"]);
  const [dateFrom, setDateFrom] = useState(todayIso());
  const [dateTo, setDateTo] = useState(todayIso());
  const [expiresAt, setExpiresAt] = useState(inOneYear());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Consent id currently mid-fetch (HIU data-transfer request in flight).
  const [fetchingId, setFetchingId] = useState<string | null>(null);

  const canRequest = useMemo(
    () => !!patient && !!abhaAddress && hiTypes.length > 0,
    [patient, abhaAddress, hiTypes]
  );

  useEffect(() => {
    if (!patient) {
      setConsents([]);
      return;
    }
    // There is no list endpoint yet — the UI keeps the most recent requests
    // locally. Future: GET /abdm/consents?patientId=…
    setConsents([]);
  }, [patient]);

  function toggleHiType(t: string) {
    setHiTypes((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
    );
  }

  async function request() {
    if (!patient || !abhaAddress) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.post<{ data: { consentRequestId: string } }>(
        "/abdm/consent/request",
        {
          patientId: patient.id,
          hiuId: "medcore-hiu-sandbox",
          abhaAddress,
          purpose,
          hiTypes,
          dateFrom: new Date(dateFrom).toISOString(),
          dateTo: new Date(dateTo).toISOString(),
          expiresAt: new Date(expiresAt).toISOString(),
          requesterId: "medcore",
          requesterName: "MedCore HIU",
        }
      );
      setConsents((prev) => [
        {
          id: res.data.consentRequestId,
          status: "REQUESTED",
          purpose,
          hiTypes,
          dateFrom,
          dateTo,
          expiresAt,
          abhaAddress,
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ]);
    } catch (err) {
      setSaveError((err as Error).message || "Consent request failed");
    } finally {
      setSaving(false);
    }
  }

  async function revoke(id: string) {
    if (!(await confirm({ title: "Revoke this consent artefact?", danger: true }))) return;
    try {
      await api.post(`/abdm/consent/${id}/revoke`);
      setConsents((prev) =>
        prev.map((c) => (c.id === id ? { ...c, status: "REVOKED" } : c))
      );
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  // HIU pull: for a GRANTED consent, ask ABDM to have the remote HIP push the
  // patient's records back to our /abdm/hiu/data-push callback (built from
  // PUBLIC_API_URL). The fetch is asynchronous — the gateway 202-accepts the
  // request and the records land as HIU_EXTERNAL MedicalRecord rows once the
  // HIP pushes. Surfaced under the Records tab as they arrive.
  async function fetchRecords(id: string) {
    setFetchingId(id);
    try {
      const res = await api.post<{ data: { transactionId: string } }>(
        "/abdm/hiu/fetch",
        { consentId: id }
      );
      toast.success(
        `Data-transfer requested (txn ${res.data.transactionId.slice(0, 8)}…). ` +
          "Records will appear under the Records tab once the provider pushes them."
      );
    } catch (err) {
      toast.error((err as Error).message || "Fetch request failed");
    } finally {
      setFetchingId(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <h2 className="mb-3 text-lg font-semibold">Request new consent</h2>

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label htmlFor="abdm-consent-abha-address" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              ABHA address
            </label>
            <input
              id="abdm-consent-abha-address"
              type="text"
              value={abhaAddress}
              onChange={(e) => setAbhaAddress(e.target.value)}
              placeholder={isSandbox() ? "rahul@sbx" : "username@abdm"}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            />
          </div>
          <div>
            <label htmlFor="abdm-consent-purpose" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Purpose
            </label>
            <select
              id="abdm-consent-purpose"
              value={purpose}
              onChange={(e) =>
                setPurpose(e.target.value as (typeof CONSENT_PURPOSES)[number])
              }
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            >
              {CONSENT_PURPOSES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="abdm-consent-date-from" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Data from
            </label>
            <input
              id="abdm-consent-date-from"
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            />
          </div>
          <div>
            <label htmlFor="abdm-consent-date-to" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Data to
            </label>
            <input
              id="abdm-consent-date-to"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            />
          </div>
          <div>
            <label htmlFor="abdm-consent-expires-at" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Expires
            </label>
            <input
              id="abdm-consent-expires-at"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            />
          </div>
        </div>

        <fieldset className="mt-4">
          <legend className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Health information types
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {HI_TYPES.map((t) => {
              const on = hiTypes.includes(t);
              return (
                <label
                  key={t}
                  className={
                    "cursor-pointer rounded-full border px-3 py-1 text-xs " +
                    (on
                      ? "border-indigo-600 bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40"
                      : "border-gray-300 text-gray-600 dark:border-gray-700 dark:text-gray-400")
                  }
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggleHiType(t)}
                    className="sr-only"
                  />
                  {t}
                </label>
              );
            })}
          </div>
        </fieldset>

        <button
          onClick={request}
          disabled={!canRequest || saving}
          className="mt-4 flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} Request consent
        </button>
        {saveError && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">{saveError}</p>
        )}
      </div>

      {loading && (
        <div data-testid="abdm-loading" aria-busy="true">
          <SkeletonText lines={3} />
        </div>
      )}
      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      {!patient && (
        <p className="text-sm text-gray-500">
          Select a patient above to see their consent artefacts.
        </p>
      )}

      {patient && consents.length === 0 && !loading && (
        <p className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-gray-700">
          No consent artefacts on record yet.
        </p>
      )}

      <ul className="space-y-3">
        {consents.map((c) => (
          <li
            key={c.id}
            className="flex items-start justify-between rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900"
          >
            <div>
              <div className="flex items-center gap-2">
                <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs dark:bg-gray-800">
                  {c.id.slice(0, 12)}…
                </span>
                <span
                  className={
                    "rounded px-2 py-0.5 text-xs font-medium " +
                    (c.status === "GRANTED"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                      : c.status === "REVOKED"
                      ? "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300")
                  }
                >
                  {c.status}
                </span>
              </div>
              <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
                {c.abhaAddress} · {c.purpose}
              </p>
              <p className="mt-1 text-xs text-gray-500">
                {c.hiTypes.join(", ")} · {c.dateFrom} → {c.dateTo}
              </p>
            </div>
            {c.status !== "REVOKED" && (
              <div className="flex shrink-0 flex-col items-end gap-2">
                {c.status === "GRANTED" && (
                  <button
                    onClick={() => fetchRecords(c.id)}
                    disabled={fetchingId === c.id}
                    className="flex items-center gap-1 rounded-lg border border-indigo-200 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-900 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
                  >
                    {fetchingId === c.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Download className="h-3 w-3" />
                    )}
                    Fetch records
                  </button>
                )}
                <button
                  onClick={() => revoke(c.id)}
                  className="flex items-center gap-1 rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/40"
                >
                  <Trash2 className="h-3 w-3" /> Revoke
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CareContextsTab({ patient }: { patient: PatientOpt | null }) {
  const [abhaAddress, setAbhaAddress] = useState("");
  const [careContextRef, setCareContextRef] = useState("");
  const [display, setDisplay] = useState("");
  const [type, setType] = useState<(typeof CARE_CONTEXT_TYPES)[number]>(
    "OPConsultation"
  );
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{
    kind: "ok" | "err";
    message: string;
  } | null>(null);

  async function push() {
    if (!patient) return;
    setSaving(true);
    setResult(null);
    try {
      await api.post("/abdm/care-context/link", {
        patientId: patient.id,
        abhaAddress,
        careContextRef,
        display,
        type,
      });
      setResult({
        kind: "ok",
        message: "Care context pushed — ABDM will confirm asynchronously.",
      });
    } catch (err) {
      setResult({
        kind: "err",
        message: (err as Error).message || "Push failed",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <h2 className="mb-1 text-lg font-semibold">Push care context</h2>
      <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
        Link a MedCore consultation or discharge to the patient&apos;s ABHA so it
        appears in the national health locker.
      </p>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label htmlFor="abdm-cc-abha-address" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            ABHA address
          </label>
          <input
            id="abdm-cc-abha-address"
            type="text"
            value={abhaAddress}
            onChange={(e) => setAbhaAddress(e.target.value)}
            placeholder={isSandbox() ? "rahul@sbx" : "username@abdm"}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
        </div>
        <div>
          <label htmlFor="abdm-cc-type" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Care context type
          </label>
          <select
            id="abdm-cc-type"
            value={type}
            onChange={(e) =>
              setType(e.target.value as (typeof CARE_CONTEXT_TYPES)[number])
            }
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
          >
            {CARE_CONTEXT_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="abdm-cc-ref" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Care context reference (consultation ID)
          </label>
          <input
            id="abdm-cc-ref"
            type="text"
            value={careContextRef}
            onChange={(e) => setCareContextRef(e.target.value)}
            placeholder="e.g. consultation/a1b2c3"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
        </div>
        <div>
          <label htmlFor="abdm-cc-display" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Display name
          </label>
          <input
            id="abdm-cc-display"
            type="text"
            value={display}
            onChange={(e) => setDisplay(e.target.value)}
            placeholder="OPD Consultation on 12 Apr"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
        </div>
      </div>

      <button
        onClick={push}
        disabled={
          !patient || !abhaAddress || !careContextRef || !display || saving
        }
        className="mt-4 flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
      >
        {saving && <Loader2 className="h-4 w-4 animate-spin" />} Push to ABDM
      </button>

      {result && (
        <div
          className={
            "mt-4 flex items-start gap-2 rounded-lg p-3 text-sm " +
            (result.kind === "ok"
              ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
              : "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200")
          }
        >
          {result.kind === "ok" ? (
            <CheckCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          ) : (
            <XCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          )}
          {result.message}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// NEW TABS (2026-06 module completion)
// ═══════════════════════════════════════════════════════════════════════════

const cardCls =
  "rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900";
const inputCls =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100";
const primaryBtn =
  "inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50";

function statusBadge(status: string): string {
  const s = status.toUpperCase();
  if (["SUCCESS", "GRANTED", "PUSHED", "LINKED"].includes(s))
    return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200";
  if (["FAILED", "DENIED", "REVOKED"].includes(s))
    return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200";
  return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200";
}

interface DashboardData {
  abdmConnected: boolean;
  mode: string;
  hip: { id: string; status: string };
  hiu: { id: string; status: string };
  linkedAbhaCount: number;
  recordCount: number;
  consents: Record<string, number>;
  recentTransactions: Array<{ id: string; type: string; status: string; summary?: string | null; createdAt: string }>;
}

function DashboardTab() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ data: DashboardData }>("/abdm/dashboard");
        setData(res.data);
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  if (loading) return <SkeletonText lines={4} />;
  if (!data) return <p className="text-sm text-gray-500">Could not load the ABDM dashboard.</p>;
  return (
    <div className="space-y-4" data-testid="abdm-dashboard">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="ABDM" value={data.abdmConnected ? "Connected" : "Not configured"} tone={data.abdmConnected ? "ok" : "warn"} />
        <StatCard label="HIP" value={data.hip.status} tone={data.hip.status === "ready" ? "ok" : "warn"} />
        <StatCard label="HIU" value={data.hiu.status} tone={data.hiu.status === "ready" ? "ok" : "warn"} />
        <StatCard label="Linked ABHA" value={String(data.linkedAbhaCount)} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className={cardCls}>
          <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">Consent statistics</h3>
          {Object.keys(data.consents).length === 0 ? (
            <p className="text-sm text-gray-500">No consents yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {Object.entries(data.consents).map(([k, v]) => (
                <li key={k} className="flex justify-between">
                  <span className="text-gray-600 dark:text-gray-300">{k}</span>
                  <span className="font-medium">{v}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className={cardCls}>
          <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">Records stored</h3>
          <p className="text-3xl font-semibold text-indigo-600">{data.recordCount}</p>
          <p className="text-xs text-gray-500">across HIP-authored + HIU-fetched</p>
        </div>
      </div>
      <div className={cardCls}>
        <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">Recent transactions</h3>
        {data.recentTransactions.length === 0 ? (
          <p className="text-sm text-gray-500">No transactions yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 text-sm dark:divide-gray-800">
            {data.recentTransactions.map((t) => (
              <li key={t.id} className="flex items-center justify-between py-2">
                <span className="min-w-0">
                  <span className="font-medium">{t.type}</span>
                  <span className="ml-2 truncate text-gray-500">{t.summary}</span>
                </span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(t.status)}`}>{t.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
  const color = tone === "ok" ? "text-emerald-600" : tone === "warn" ? "text-amber-600" : "text-gray-900 dark:text-gray-100";
  return (
    <div className={cardCls}>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${color}`}>{value}</p>
    </div>
  );
}

function ProfileTab({ patient, isPatient }: { patient: PatientOpt | null; isPatient: boolean }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!patient) return;
    setLoading(true);
    (async () => {
      try {
        const res = await api.get<{ data: any }>(`/abdm/profile/${patient.id}`);
        setData(res.data);
      } catch {
        setData(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [patient]);
  if (!patient) return <p className="text-sm text-gray-500">{isPatient ? "Loading your profile…" : "Select a patient to view their ABHA profile."}</p>;
  if (loading) return <SkeletonText lines={4} />;
  if (!data) return <p className="text-sm text-gray-500">No profile found.</p>;
  const link = data.abhaLinks?.[0];
  return (
    <div className={cardCls} data-testid="abdm-profile">
      <h3 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-200">ABHA Profile</h3>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <ProfileField k="Name" v={data.user?.name} />
        <ProfileField k="Gender" v={data.gender} />
        <ProfileField k="Date of birth" v={data.dateOfBirth ? new Date(data.dateOfBirth).toLocaleDateString() : "—"} />
        <ProfileField k="Phone" v={data.user?.phone} />
        <ProfileField k="ABHA Address" v={link?.abhaAddress ?? data.abhaId ?? "Not linked"} />
        <ProfileField k="ABHA Number" v={link?.abhaNumber ?? "—"} />
      </dl>
      {link?.abhaAddress && (
        <button type="button" onClick={() => window.print()} className={`${primaryBtn} mt-4`}>
          <Download className="h-4 w-4" /> Download ABHA Card
        </button>
      )}
    </div>
  );
}

function ProfileField({ k, v }: { k: string; v?: string | null }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{k}</dt>
      <dd className="font-medium text-gray-900 dark:text-gray-100">{v || "—"}</dd>
    </div>
  );
}

interface RecordRow {
  id: string;
  source: string;
  hiType: string;
  title: string;
  providerName?: string | null;
  recordDate?: string | null;
  createdAt: string;
  fileKey?: string | null;
}

function RecordsTab({ patient, isPatient }: { patient: PatientOpt | null; isPatient: boolean }) {
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useMemo(
    () => async () => {
      if (!patient && !isPatient) return;
      setLoading(true);
      try {
        const qs = patient && !isPatient ? `?patientId=${patient.id}` : "";
        const res = await api.get<{ data: RecordRow[] }>(`/abdm/records${qs}`);
        setRows(res.data ?? []);
      } catch {
        setRows([]);
      } finally {
        setLoading(false);
      }
    },
    [patient, isPatient],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function download(id: string) {
    try {
      const res = await api.get<{ data: { url: string } }>(`/abdm/records/${id}/download`);
      window.open(res.data.url, "_blank");
    } catch (e) {
      toast.error((e as Error).message || "No file to download");
    }
  }

  if (!patient && !isPatient) return <p className="text-sm text-gray-500">Select a patient to view records.</p>;
  return (
    <div className={cardCls} data-testid="abdm-records">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Medical Records</h3>
        <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>
      {loading ? (
        <SkeletonText lines={3} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">No records yet. Records fetched via HIU (after consent) and pushed via HIP appear here.</p>
      ) : (
        <ul className="divide-y divide-gray-100 dark:divide-gray-800">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between py-2 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-gray-900 dark:text-gray-100">{r.title}</p>
                <p className="text-xs text-gray-500">
                  {r.hiType} · {r.source === "HIU_EXTERNAL" ? `from ${r.providerName ?? "external provider"}` : "MedCore"} ·{" "}
                  {new Date(r.recordDate ?? r.createdAt).toLocaleDateString()}
                </p>
              </div>
              {r.fileKey && (
                <button type="button" onClick={() => void download(r.id)} className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline">
                  <Download className="h-3.5 w-3.5" /> Download
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UploadTab({ patient }: { patient: PatientOpt | null }) {
  const [abhaAddress, setAbhaAddress] = useState("");
  const [type, setType] = useState<"OPConsultation" | "DischargeSummary" | "DiagnosticReport">("OPConsultation");
  const [title, setTitle] = useState("");
  const [diagnosis, setDiagnosis] = useState("");
  const [notes, setNotes] = useState("");
  const [fileKey, setFileKey] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !patient) return;
    setUploading(true);
    try {
      const base64 = await fileToBase64(file);
      const res = await api.post<{ data: { filePath: string } }>("/uploads", {
        filename: file.name,
        base64Content: base64,
        patientId: patient.id,
        type: "abdm-record",
      });
      setFileKey(res.data.filePath);
      toast.success("File attached");
    } catch (err) {
      toast.error((err as Error).message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    if (!patient) {
      toast.error("Select a patient first");
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ data: { status: string } }>("/abdm/records/upload", {
        patientId: patient.id,
        abhaAddress,
        type,
        title,
        fileKey: fileKey ?? undefined,
        diagnosis: diagnosis || undefined,
        notes: notes || undefined,
      });
      toast.success(`Record ${res.data.status === "PUSHED" ? "pushed to ABDM" : "saved (push pending)"}`);
      setTitle("");
      setDiagnosis("");
      setNotes("");
      setFileKey(null);
    } catch (err) {
      toast.error((err as Error).message || "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  if (!patient) return <p className="text-sm text-gray-500">Select a patient to upload a record.</p>;
  return (
    <div className={`${cardCls} space-y-3`} data-testid="abdm-upload">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Upload a record to ABDM (HIP)</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">ABHA Address</span>
          <input className={inputCls} value={abhaAddress} onChange={(e) => setAbhaAddress(e.target.value)} placeholder="rahul@sbx" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">Record type</span>
          <select className={inputCls} value={type} onChange={(e) => setType(e.target.value as any)}>
            <option value="OPConsultation">Consultation note</option>
            <option value="DischargeSummary">Discharge summary</option>
            <option value="DiagnosticReport">Lab / diagnostic report</option>
          </select>
        </label>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">Title</span>
        <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. OPD consult 12 Jun" />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">Diagnosis (optional)</span>
        <input className={inputCls} value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">Notes (optional)</span>
        <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-gray-700 dark:text-gray-300">Attach PDF / report (optional)</span>
        <input type="file" accept="application/pdf,image/*" onChange={onFile} disabled={uploading} className="text-sm" />
        {uploading && <span className="ml-2 text-xs text-gray-500">Uploading…</span>}
        {fileKey && <span className="ml-2 text-xs text-emerald-600">Attached ✓</span>}
      </label>
      <button type="button" onClick={submit} disabled={busy || !title || !abhaAddress} className={primaryBtn}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        Push to ABDM
      </button>
    </div>
  );
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

interface AuditRow {
  id: string;
  action: string;
  entity: string;
  entityId?: string | null;
  ipAddress?: string | null;
  createdAt: string;
}

function AuditTab() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ data: AuditRow[] }>("/abdm/audit");
        setRows(res.data ?? []);
      } catch {
        setRows([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  return (
    <div className={cardCls} data-testid="abdm-audit">
      <h3 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-200">ABDM Audit Logs</h3>
      {loading ? (
        <SkeletonText lines={4} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">No ABDM activity recorded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="py-2 pr-4">Action</th>
                <th className="py-2 pr-4">Entity</th>
                <th className="py-2 pr-4">When</th>
                <th className="py-2">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="py-2 pr-4 font-medium">{r.action.replace("ABDM_", "")}</td>
                  <td className="py-2 pr-4 text-gray-500">{r.entity}{r.entityId ? ` · ${r.entityId.slice(0, 8)}…` : ""}</td>
                  <td className="py-2 pr-4 text-gray-500">{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="py-2 text-gray-400">{r.ipAddress ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
