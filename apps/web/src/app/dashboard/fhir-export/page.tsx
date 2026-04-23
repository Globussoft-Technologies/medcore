"use client";

/**
 * FHIR R4 export page — admin-only.
 *
 * Pick a patient, then download any of:
 *   - GET /api/v1/fhir/Patient/:id            (single Patient resource)
 *   - GET /api/v1/fhir/Patient/:id/$everything (searchset bundle)
 *   - GET /api/v1/fhir/Patient/:id/$export     (transaction bundle for ABDM push)
 *
 * The backend returns `application/fhir+json`. We fetch via the shared
 * `api` client so auth is handled, preview the JSON inline, and provide
 * download + copy actions.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import {
  FileJson,
  Download,
  Copy,
  CheckCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

interface PatientOpt {
  id: string;
  user: { name: string; phone?: string | null };
}

type ExportKind = "patient" | "everything" | "export";

const EXPORT_LABELS: Record<ExportKind, string> = {
  patient: "Patient resource",
  everything: "$everything bundle",
  export: "ABDM push bundle",
};

export default function FhirExportPage() {
  const router = useRouter();
  const { user, isLoading } = useAuthStore();

  const [search, setSearch] = useState("");
  const [results, setResults] = useState<PatientOpt[]>([]);
  const [patient, setPatient] = useState<PatientOpt | null>(null);

  const [loading, setLoading] = useState<ExportKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<unknown>(null);
  const [payloadKind, setPayloadKind] = useState<ExportKind | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isLoading && user && user.role !== "ADMIN") {
      router.push("/dashboard");
    }
  }, [user, isLoading, router]);

  useEffect(() => {
    if (search.length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ data: PatientOpt[] }>(
          `/patients?search=${encodeURIComponent(search)}`
        );
        setResults(res.data ?? []);
      } catch {
        setResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  async function runExport(kind: ExportKind) {
    if (!patient) return;
    setError(null);
    setLoading(kind);
    setPayload(null);
    setPayloadKind(null);
    setCopied(false);
    try {
      const path =
        kind === "patient"
          ? `/fhir/Patient/${patient.id}`
          : kind === "everything"
          ? `/fhir/Patient/${patient.id}/$everything`
          : `/fhir/Patient/${patient.id}/$export`;
      const data = await api.get<unknown>(path);
      setPayload(data);
      setPayloadKind(kind);
    } catch (err) {
      setError((err as Error).message || "Export failed");
    } finally {
      setLoading(null);
    }
  }

  async function copy() {
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard failures
    }
  }

  function download() {
    if (!payload || !patient || !payloadKind) return;
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/fhir+json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${patient.id}-${payloadKind}.fhir.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    );
  }
  if (user?.role !== "ADMIN") return null;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center gap-3">
        <FileJson className="h-6 w-6 text-emerald-600" />
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
            FHIR Export
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Export patient records as HL7 FHIR R4 resources and bundles —
            standards-compliant, interoperable, auditable.
          </p>
        </div>
      </div>

      {/* Patient picker */}
      <div className="mb-6 rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <label
          htmlFor="fhir-patient"
          className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Patient
        </label>
        {patient ? (
          <div className="flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2 text-sm dark:bg-emerald-950/40">
            <span>
              <strong>{patient.user.name}</strong>{" "}
              <span className="ml-2 font-mono text-xs text-gray-500">
                {patient.id.slice(0, 8)}…
              </span>
            </span>
            <button
              onClick={() => {
                setPatient(null);
                setPayload(null);
              }}
              className="text-xs text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
            >
              Change
            </button>
          </div>
        ) : (
          <>
            <input
              id="fhir-patient"
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search patient by name, phone or MRN…"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800"
            />
            {results.length > 0 && (
              <ul className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-gray-200 bg-white text-sm dark:border-gray-700 dark:bg-gray-800">
                {results.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => {
                        setPatient(p);
                        setSearch("");
                        setResults([]);
                      }}
                      className="block w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700"
                    >
                      {p.user.name}{" "}
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

      {/* Actions */}
      <div className="mb-6 grid gap-3 md:grid-cols-3">
        <ExportButton
          title="Patient resource"
          subtitle="Single FHIR Patient"
          disabled={!patient}
          busy={loading === "patient"}
          onClick={() => runExport("patient")}
        />
        <ExportButton
          title="$everything bundle"
          subtitle="All patient data (FHIR searchset)"
          disabled={!patient}
          busy={loading === "everything"}
          onClick={() => runExport("everything")}
        />
        <ExportButton
          title="ABDM push bundle"
          subtitle="Transaction bundle for ABDM"
          disabled={!patient}
          busy={loading === "export"}
          onClick={() => runExport("export")}
        />
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Preview */}
      {payload != null && payloadKind && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-800">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-100">
              <FileJson className="h-4 w-4 text-emerald-600" />
              {EXPORT_LABELS[payloadKind]} preview
              <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                application/fhir+json
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={copy}
                className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
              >
                {copied ? (
                  <>
                    <CheckCircle className="h-3 w-3 text-emerald-600" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" /> Copy
                  </>
                )}
              </button>
              <button
                onClick={download}
                className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
              >
                <Download className="h-3 w-3" /> Download
              </button>
              <button
                onClick={() => setExpanded((v) => !v)}
                aria-label="Toggle preview"
                className="rounded-lg border border-gray-300 p-1.5 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
              >
                {expanded ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
              </button>
            </div>
          </div>
          {expanded && (
            <pre className="max-h-[60vh] overflow-auto p-4 text-xs leading-relaxed text-gray-800 dark:text-gray-100">
              {JSON.stringify(payload, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ExportButton({
  title,
  subtitle,
  disabled,
  busy,
  onClick,
}: {
  title: string;
  subtitle: string;
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4 text-left shadow-sm transition hover:border-emerald-400 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-emerald-700"
    >
      {busy ? (
        <Loader2 className="h-5 w-5 animate-spin text-emerald-600" />
      ) : (
        <Download className="h-5 w-5 text-emerald-600" />
      )}
      <div>
        <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {subtitle}
        </div>
      </div>
    </button>
  );
}
