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
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────────────

type TabKey = "link" | "consents" | "careContexts";

interface PatientOpt {
  id: string;
  user: { name: string; phone?: string | null };
  dateOfBirth?: string | null;
}

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

// ─── Component ──────────────────────────────────────────────────────────────

export default function AbdmPage() {
  const router = useRouter();
  const { user, isLoading } = useAuthStore();
  const [tab, setTab] = useState<TabKey>("link");

  // Detect SANDBOX MODE purely client-side — no env var on the browser,
  // so fall back to a prop we ship via NEXT_PUBLIC or default to sandbox.
  const sandbox =
    typeof process !== "undefined" &&
    (process.env.NEXT_PUBLIC_ABDM_MODE ?? "sandbox") !== "production";

  // Patient search (shared across tabs)
  const [patientSearch, setPatientSearch] = useState("");
  const [patientResults, setPatientResults] = useState<PatientOpt[]>([]);
  const [patient, setPatient] = useState<PatientOpt | null>(null);

  useEffect(() => {
    if (!isLoading && user && !["ADMIN", "DOCTOR", "RECEPTION"].includes(user.role)) {
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

  if (user && !["ADMIN", "DOCTOR", "RECEPTION"].includes(user.role)) {
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

      {/* Patient picker (shared) */}
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

      {/* Tabs */}
      <div className="mb-4 flex gap-1 border-b border-gray-200 dark:border-gray-800">
        <TabButton
          active={tab === "link"}
          onClick={() => setTab("link")}
          icon={LinkIcon}
          label="Link ABHA"
        />
        <TabButton
          active={tab === "consents"}
          onClick={() => setTab("consents")}
          icon={FileCheck}
          label="Consents"
        />
        <TabButton
          active={tab === "careContexts"}
          onClick={() => setTab("careContexts")}
          icon={Activity}
          label="Care Contexts"
        />
      </div>

      {tab === "link" && <LinkAbhaTab patient={patient} />}
      {tab === "consents" && <ConsentsTab patient={patient} />}
      {tab === "careContexts" && <CareContextsTab patient={patient} />}
    </div>
  );
}

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
  const [verifying, setVerifying] = useState(false);
  const [linking, setLinking] = useState(false);
  const [result, setResult] = useState<{
    kind: "ok" | "err";
    message: string;
  } | null>(null);

  async function verify() {
    setVerifying(true);
    setResult(null);
    try {
      const res = await api.post<{ data: { ok: boolean; name?: string } }>(
        "/abdm/abha/verify",
        {
          abhaAddress: abhaAddress || undefined,
          abhaNumber: abhaNumber || undefined,
        }
      );
      setResult({
        kind: res.data.ok ? "ok" : "err",
        message: res.data.ok
          ? `Verified — ${res.data.name ?? "ABHA account valid"}`
          : "ABHA could not be verified",
      });
    } catch (err) {
      setResult({
        kind: "err",
        message: (err as Error).message || "Verification failed",
      });
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
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            ABHA address
          </label>
          <input
            type="text"
            value={abhaAddress}
            onChange={(e) => setAbhaAddress(e.target.value)}
            placeholder="rahul@sbx"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            ABHA number <span className="text-xs text-gray-400">(optional)</span>
          </label>
          <input
            type="text"
            value={abhaNumber}
            onChange={(e) => setAbhaNumber(e.target.value)}
            placeholder="12-3456-7890-1234"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            OTP (mock)
          </label>
          <input
            type="text"
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
            placeholder="123456"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
        </div>
      </div>

      <div className="mt-4 flex gap-3">
        <button
          onClick={verify}
          disabled={verifying || (!abhaAddress && !abhaNumber)}
          className="flex items-center gap-2 rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
        >
          {verifying && <Loader2 className="h-4 w-4 animate-spin" />} Verify
          ABHA
        </button>
        <button
          onClick={link}
          disabled={linking || !patient || !abhaAddress}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {linking && <Loader2 className="h-4 w-4 animate-spin" />} Link to
          patient
        </button>
      </div>

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

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <h2 className="mb-3 text-lg font-semibold">Request new consent</h2>

        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              ABHA address
            </label>
            <input
              type="text"
              value={abhaAddress}
              onChange={(e) => setAbhaAddress(e.target.value)}
              placeholder="rahul@sbx"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Purpose
            </label>
            <select
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
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Data from
            </label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Data to
            </label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Expires
            </label>
            <input
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

      {loading && <p className="text-sm text-gray-500">Loading…</p>}
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
              <button
                onClick={() => revoke(c.id)}
                className="flex items-center gap-1 rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/40"
              >
                <Trash2 className="h-3 w-3" /> Revoke
              </button>
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
        Link a MedCore consultation or discharge to the patient's ABHA so it
        appears in the national health locker.
      </p>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            ABHA address
          </label>
          <input
            type="text"
            value={abhaAddress}
            onChange={(e) => setAbhaAddress(e.target.value)}
            placeholder="rahul@sbx"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Care context type
          </label>
          <select
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
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Care context reference (consultation ID)
          </label>
          <input
            type="text"
            value={careContextRef}
            onChange={(e) => setCareContextRef(e.target.value)}
            placeholder="e.g. consultation/a1b2c3"
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Display name
          </label>
          <input
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
