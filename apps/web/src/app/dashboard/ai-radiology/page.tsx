"use client";

// AI Radiology Report Drafting (PRD §7.2).
//
// HITL flow: upload an imaging study, kick off an AI draft, radiologist
// (DOCTOR / ADMIN role) reviews side-by-side, and approves / amends.
// DICOM region-overlay rendering is deferred — see the service TODOs.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  ScanLine,
  FileSearch,
  Upload as UploadIcon,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { useTranslation } from "@/lib/i18n";

// Issue #509: page-level gate matching API authorize() in
// apps/api/src/routes/ai-radiology.ts (DOCTOR, ADMIN). The page previously
// rendered an inline "restricted" message for non-allowed roles — but that
// still leaks the route's existence and layout chrome. Replace the inline
// message with a redirect to /dashboard/not-authorized so non-allowed roles
// never see the radiology surface.
const VIEW_ALLOWED = new Set(["ADMIN", "DOCTOR"]);

// ─── Types ───────────────────────────────────────────────────────────────────

type Modality = "XRAY" | "CT" | "MRI" | "ULTRASOUND" | "MAMMOGRAPHY" | "PET";
type ReportStatus = "DRAFT" | "RADIOLOGIST_REVIEW" | "FINAL" | "AMENDED";

interface ImageRef {
  key: string;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  uploadedAt?: string;
}

interface Finding {
  description: string;
  confidence: "low" | "medium" | "high";
  suggestedFollowUp?: string;
  region?: { x: number; y: number; w: number; h: number; label?: string };
}

interface RadiologyReport {
  id: string;
  studyId: string;
  aiDraft: string;
  aiFindings: Finding[] | null;
  aiImpression: string;
  finalReport?: string | null;
  finalImpression?: string | null;
  status: ReportStatus;
  approvedAt?: string | null;
  approvedBy?: string | null;
  radiologistId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  study?: RadiologyStudy;
}

interface RadiologyStudy {
  id: string;
  patientId: string;
  modality: Modality;
  bodyPart: string;
  images: ImageRef[] | null;
  studyDate: string;
  notes?: string | null;
  patient?: { user?: { name?: string } };
  report?: RadiologyReport | null;
}

type Tab = "pending" | "all" | "upload";

const STATUS_COLOR: Record<ReportStatus, string> = {
  DRAFT: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-800",
  RADIOLOGIST_REVIEW: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-200 dark:border-blue-800",
  FINAL: "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-200 dark:border-green-800",
  AMENDED: "bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-200 dark:border-purple-800",
};

const CONFIDENCE_COLOR: Record<Finding["confidence"], string> = {
  high: "text-red-700 dark:text-red-300",
  medium: "text-amber-700 dark:text-amber-300",
  low: "text-gray-600 dark:text-gray-400",
};

// ─── Page ────────────────────────────────────────────────────────────────────

export default function AiRadiologyPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("pending");
  const [pending, setPending] = useState<RadiologyReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedReport, setSelectedReport] = useState<RadiologyReport | null>(null);

  // Issue #509: redirect non-allowed roles to /dashboard/not-authorized
  // (replaces the prior inline "restricted" message that leaked the layout).
  useEffect(() => {
    if (!isLoading && user && !VIEW_ALLOWED.has(user.role)) {
      toast.error("AI Radiology drafting is restricted to doctors and administrators.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/ai-radiology")}`,
      );
    }
  }, [user, isLoading, router, pathname]);

  const loadPending = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: RadiologyReport[] }>(
        "/ai/radiology/pending-review"
      );
      setPending(res.data || []);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 503) {
        toast.error(
          t(
            "radiology.error.notMigrated",
            "RadiologyStudy / RadiologyReport models not yet migrated."
          )
        );
      } else {
        toast.error(e.message || t("radiology.error.load", "Failed to load reports"));
      }
      setPending([]);
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    if (user && (user.role === "ADMIN" || user.role === "DOCTOR")) {
      if (tab === "pending" || tab === "all") loadPending();
    }
  }, [user, tab, loadPending]);

  // Issue #155 — bounded status-polling for non-terminal reports.
  //
  // The pending list contains reports in DRAFT / RADIOLOGIST_REVIEW. The AI
  // draft step is asynchronous (Sarvam can take 10-60s) so the radiologist
  // expects the queue to refresh on its own once a draft completes. The
  // earlier ad-hoc polling never had a stop condition and rate-limited the
  // server. We now:
  //   • Only poll when the *visible* tab is "pending" or "all" AND the list
  //     contains at least one non-terminal (DRAFT / RADIOLOGIST_REVIEW)
  //     report.
  //   • Stop polling as soon as every report is in a terminal state
  //     (FINAL / AMENDED) or once the max-attempt budget is exhausted
  //     (60 attempts ≈ 5 min at 5s base interval).
  //   • Use a 5s interval for the first 30s, then exponential backoff
  //     (10s, 20s, 40s, 60s capped) so a long-running batch doesn't
  //     hammer the API.
  const pollAttempts = useRef(0);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // Clear any prior schedule when the tab / role / list changes.
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
    pollAttempts.current = 0;

    if (!user) return;
    if (user.role !== "ADMIN" && user.role !== "DOCTOR") return;
    if (tab !== "pending" && tab !== "all") return;

    const TERMINAL: ReportStatus[] = ["FINAL", "AMENDED"];
    const hasNonTerminal = pending.some((r) => !TERMINAL.includes(r.status));
    if (!hasNonTerminal) return; // nothing to wait on

    const MAX_ATTEMPTS = 60;
    const BASE_MS = 5000;
    function nextDelay(attempt: number): number {
      // 5s for the first 6 ticks (= 30s), then exponential backoff capped
      // at 60s so the request rate eventually hits 1/min.
      if (attempt < 6) return BASE_MS;
      const exp = Math.min(BASE_MS * Math.pow(2, attempt - 5), 60_000);
      return exp;
    }

    function schedule() {
      const attempt = pollAttempts.current;
      if (attempt >= MAX_ATTEMPTS) {
        toast.error(
          t(
            "radiology.poll.giveUp",
            "Stopped checking for AI draft updates — refresh manually if needed."
          )
        );
        return;
      }
      pollTimeoutRef.current = setTimeout(async () => {
        pollAttempts.current = attempt + 1;
        await loadPending();
        // The next render will re-evaluate `pending` and decide whether
        // to keep polling or unsubscribe. Schedule the *next* tick from
        // here so a sequence-of-non-terminal-reports list keeps polling
        // until it's drained.
        schedule();
      }, nextDelay(attempt));
    }
    schedule();

    return () => {
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current);
        pollTimeoutRef.current = null;
      }
    };
  }, [user, tab, pending, loadPending, t]);

  // Role gate — DOCTOR / ADMIN only.
  if (user && user.role !== "ADMIN" && user.role !== "DOCTOR") {
    return (
      <div className="p-8 text-center text-gray-500 dark:text-gray-400">
        <ScanLine className="mx-auto mb-2 h-10 w-10 text-gray-400" />
        {t(
          "radiology.error.forbidden",
          "Radiology drafting is restricted to doctors and admins."
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
          <ScanLine className="h-6 w-6" />
          {t("radiology.title", "AI Radiology")}
        </h1>
        {(tab === "pending" || tab === "all") && (
          <button
            onClick={loadPending}
            disabled={loading}
            className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            {t("common.refresh", "Refresh")}
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-2 border-b border-gray-200 dark:border-gray-700">
        <TabButton active={tab === "pending"} onClick={() => setTab("pending")}>
          <FileSearch className="mr-1 inline h-4 w-4" />
          {t("radiology.tab.pending", "Pending Review")}
        </TabButton>
        <TabButton active={tab === "all"} onClick={() => setTab("all")}>
          <Sparkles className="mr-1 inline h-4 w-4" />
          {t("radiology.tab.all", "All Studies")}
        </TabButton>
        <TabButton active={tab === "upload"} onClick={() => setTab("upload")}>
          <UploadIcon className="mr-1 inline h-4 w-4" />
          {t("radiology.tab.upload", "Upload Study")}
        </TabButton>
      </div>

      {tab === "upload" && <UploadTab onCreated={() => setTab("pending")} />}

      {tab === "pending" && (
        <PendingTab
          loading={loading}
          reports={pending.filter((r) => r.status === "DRAFT" || r.status === "RADIOLOGIST_REVIEW")}
          onSelect={setSelectedReport}
        />
      )}

      {tab === "all" && (
        <PendingTab loading={loading} reports={pending} onSelect={setSelectedReport} />
      )}

      {selectedReport && (
        <ReportDetailModal
          report={selectedReport}
          onClose={() => setSelectedReport(null)}
          onUpdated={async () => {
            await loadPending();
            setSelectedReport(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Tab button ──────────────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`border-b-2 px-4 py-2 text-sm font-medium transition ${
        active
          ? "border-primary text-primary"
          : "border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
      }`}
    >
      {children}
    </button>
  );
}

// ─── Upload tab ──────────────────────────────────────────────────────────────

function UploadTab({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation();
  const [patientId, setPatientId] = useState("");
  const [modality, setModality] = useState<Modality>("XRAY");
  const [bodyPart, setBodyPart] = useState("");
  const [clinicalHistory, setClinicalHistory] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!patientId || !bodyPart || files.length === 0) {
      toast.error(t("radiology.upload.missing", "Patient ID, body part, and at least one image are required"));
      return;
    }
    setBusy(true);
    try {
      // 1) Upload each file via the existing /uploads flow → get file keys.
      const imageKeys: string[] = [];
      for (const f of files) {
        const base64 = await fileToBase64(f);
        const up = await api.post<{ data: { filePath: string; fileSize: number } }>(
          "/uploads",
          {
            filename: f.name,
            base64Content: base64,
            patientId,
            type: "RADIOLOGY",
          }
        );
        imageKeys.push(up.data.filePath);
      }

      // 2) Create the study.
      const studyRes = await api.post<{ data: { id: string } }>(
        "/ai/radiology/studies",
        {
          patientId,
          modality,
          bodyPart,
          imageKeys,
          notes: clinicalHistory || undefined,
        }
      );

      // 3) Kick off the AI draft.
      await api.post(`/ai/radiology/${studyRes.data.id}/draft`);

      toast.success(
        t("radiology.upload.created", "Study uploaded and AI draft queued")
      );
      setFiles([]);
      setBodyPart("");
      setClinicalHistory("");
      onCreated();
    } catch (err) {
      toast.error((err as Error).message || t("radiology.upload.failed", "Upload failed"));
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-4 rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t("radiology.field.patientId", "Patient ID")} *
        </label>
        <input
          type="text"
          value={patientId}
          onChange={(e) => setPatientId(e.target.value)}
          placeholder="patient-uuid"
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            {t("radiology.field.modality", "Modality")} *
          </label>
          <select
            value={modality}
            onChange={(e) => setModality(e.target.value as Modality)}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="XRAY">X-Ray</option>
            <option value="CT">CT</option>
            <option value="MRI">MRI</option>
            <option value="ULTRASOUND">Ultrasound</option>
            <option value="MAMMOGRAPHY">Mammography</option>
            <option value="PET">PET</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
            {t("radiology.field.bodyPart", "Body Part")} *
          </label>
          <input
            type="text"
            value={bodyPart}
            onChange={(e) => setBodyPart(e.target.value)}
            placeholder="Chest, Abdomen, Left Knee…"
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t("radiology.field.history", "Clinical History")}
        </label>
        <textarea
          value={clinicalHistory}
          onChange={(e) => setClinicalHistory(e.target.value)}
          rows={3}
          placeholder="Chief complaint, prior imaging, known conditions…"
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
          {t("radiology.field.images", "Images")} *
        </label>
        <input
          type="file"
          multiple
          accept="image/*,.dcm"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-primary file:px-3 file:py-1 file:text-white dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        />
        {files.length > 0 && (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {files.length} {t("radiology.upload.filesSelected", "file(s) selected")}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={busy}
        className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-white disabled:opacity-60"
      >
        {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <UploadIcon className="h-4 w-4" />}
        {busy ? t("radiology.upload.uploading", "Uploading…") : t("radiology.upload.submit", "Upload & Generate Draft")}
      </button>
    </form>
  );
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result as string;
      resolve(r.split(",")[1] || r);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ─── Pending / All tab ───────────────────────────────────────────────────────

function PendingTab({
  loading,
  reports,
  onSelect,
}: {
  loading: boolean;
  reports: RadiologyReport[];
  onSelect: (r: RadiologyReport) => void;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="p-8 text-center text-gray-500 dark:text-gray-400">
        {t("common.loading", "Loading…")}
      </div>
    );
  }
  if (reports.length === 0) {
    return (
      <div className="p-8 text-center text-gray-500 dark:text-gray-400">
        <CheckCircle2 className="mx-auto mb-2 h-10 w-10 text-green-500" />
        {t("radiology.empty", "No reports to review")}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {reports.map((r) => (
        <button
          key={r.id}
          onClick={() => onSelect(r)}
          className="w-full rounded-xl bg-white p-4 text-left shadow-sm transition hover:shadow-md dark:bg-gray-800"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2">
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_COLOR[r.status]}`}
                >
                  {r.status}
                </span>
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {r.study?.modality ?? "—"} · {r.study?.bodyPart ?? "—"}
                </span>
              </div>
              <p className="mb-1 text-sm text-gray-700 dark:text-gray-300">
                {t("radiology.detail.patient", "Patient")}: {r.study?.patient?.user?.name ?? r.study?.patientId ?? "—"}
              </p>
              <p className="line-clamp-2 text-xs text-gray-500 dark:text-gray-400">
                {r.aiImpression || r.aiDraft?.slice(0, 200)}
              </p>
              {r.status === "FINAL" && r.approvedAt && (
                <p className="mt-1 text-xs text-green-700 dark:text-green-300">
                  <CheckCircle2 className="mr-1 inline h-3 w-3" />
                  {t("radiology.detail.finalAt", "Finalised")} {new Date(r.approvedAt).toLocaleString()}
                </p>
              )}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

// ─── Report detail / approve modal ───────────────────────────────────────────

function ReportDetailModal({
  report,
  onClose,
  onUpdated,
}: {
  report: RadiologyReport;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const { t } = useTranslation();
  const [finalText, setFinalText] = useState(report.finalReport ?? report.aiDraft ?? "");
  const [finalImpression, setFinalImpression] = useState(
    report.finalImpression ?? report.aiImpression ?? ""
  );
  const [busy, setBusy] = useState(false);
  const [activeFindingIdx, setActiveFindingIdx] = useState<number | null>(null);
  const canApprove = report.status === "DRAFT" || report.status === "RADIOLOGIST_REVIEW";
  const canAmend = report.status === "FINAL" || report.status === "AMENDED";

  const findings = useMemo<Finding[]>(
    () => (Array.isArray(report.aiFindings) ? report.aiFindings : []),
    [report.aiFindings]
  );

  // First image in the study is the preview target. `key` is the relative
  // storage path; the `/uploads/…` path is served by the API's static mount.
  const primaryImage = Array.isArray(report.study?.images)
    ? report.study!.images![0]
    : null;
  const primaryImageUrl = primaryImage
    ? `/${primaryImage.key.replace(/^\/+/, "")}`
    : null;

  async function approve() {
    if (finalText.trim().length < 10) {
      toast.error(t("radiology.detail.tooShort", "Final report must be at least 10 characters"));
      return;
    }
    setBusy(true);
    try {
      await api.post(`/ai/radiology/${report.id}/approve`, {
        finalReport: finalText,
        finalImpression: finalImpression || undefined,
      });
      toast.success(t("radiology.detail.approved", "Report finalised"));
      onUpdated();
    } catch (err) {
      toast.error((err as Error).message || t("radiology.detail.approveFailed", "Approve failed"));
    }
    setBusy(false);
  }

  async function amend() {
    if (finalText.trim().length < 10) {
      toast.error(t("radiology.detail.tooShort", "Final report must be at least 10 characters"));
      return;
    }
    setBusy(true);
    try {
      await api.post(`/ai/radiology/${report.id}/amend`, {
        finalReport: finalText,
        finalImpression: finalImpression || undefined,
      });
      toast.success(t("radiology.detail.amended", "Report amended"));
      onUpdated();
    } catch (err) {
      toast.error((err as Error).message || t("radiology.detail.amendFailed", "Amend failed"));
    }
    setBusy(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-xl bg-white p-6 shadow-2xl dark:bg-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
              {t("radiology.detail.title", "Radiology Report")}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {report.study?.modality} · {report.study?.bodyPart} ·{" "}
              <span className={`ml-1 inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${STATUS_COLOR[report.status]}`}>
                {report.status}
              </span>
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-100">
            ×
          </button>
        </div>

        {/* Image preview with region overlay. Each `aiFinding.region` is
            rendered as an absolutely-positioned box over the primary image;
            click the finding in the left pane to highlight its region here. */}
        {primaryImageUrl && (
          <div
            data-testid="radiology-image-container"
            className="relative mb-4 w-full overflow-hidden rounded-lg border border-gray-200 bg-black dark:border-gray-700"
            style={{ aspectRatio: "4 / 3" }}
          >
            <img
              src={primaryImageUrl}
              alt={report.study?.bodyPart ?? "Radiology study"}
              className="h-full w-full object-contain"
            />
            {findings.map((f, i) =>
              f.region ? (
                <div
                  key={i}
                  data-testid={`radiology-region-${i}`}
                  data-confidence={f.confidence}
                  data-active={activeFindingIdx === i ? "true" : "false"}
                  onClick={() =>
                    setActiveFindingIdx((prev) => (prev === i ? null : i))
                  }
                  className={`absolute cursor-pointer border-2 transition ${
                    activeFindingIdx === i
                      ? "z-10 border-yellow-400 shadow-[0_0_0_2px_rgba(250,204,21,0.6)]"
                      : f.confidence === "high"
                        ? "border-red-500/80"
                        : f.confidence === "medium"
                          ? "border-amber-400/80"
                          : "border-blue-400/70"
                  }`}
                  style={{
                    left: `${Math.max(0, f.region.x) * 100}%`,
                    top: `${Math.max(0, f.region.y) * 100}%`,
                    width: `${Math.min(1, f.region.w) * 100}%`,
                    height: `${Math.min(1, f.region.h) * 100}%`,
                  }}
                  title={f.region.label ?? f.description}
                />
              ) : null,
            )}
          </div>
        )}

        {/* Side-by-side layout */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Left: AI draft */}
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
              <Sparkles className="h-4 w-4 text-purple-500" />
              {t("radiology.detail.aiDraft", "AI Draft")}
            </h3>
            <div className="mb-2 text-xs italic text-gray-600 dark:text-gray-400">
              {report.aiImpression}
            </div>
            <pre className="whitespace-pre-wrap text-xs text-gray-700 dark:text-gray-300">
              {report.aiDraft}
            </pre>
            {findings.length > 0 && (
              <div className="mt-3 border-t border-gray-200 pt-2 dark:border-gray-700">
                <h4 className="mb-1 text-xs font-semibold text-gray-700 dark:text-gray-300">
                  {t("radiology.detail.findings", "Findings")}
                </h4>
                <ul className="space-y-1">
                  {findings.map((f, i) => (
                    <li key={i} className="text-xs text-gray-600 dark:text-gray-400">
                      <button
                        type="button"
                        data-testid={`radiology-finding-${i}`}
                        onClick={() =>
                          setActiveFindingIdx((prev) => (prev === i ? null : i))
                        }
                        className={`block w-full rounded px-1 py-0.5 text-left transition hover:bg-blue-50 dark:hover:bg-blue-900/30 ${
                          activeFindingIdx === i
                            ? "bg-blue-100 dark:bg-blue-900/40"
                            : ""
                        }`}
                      >
                      <span className={`font-semibold uppercase ${CONFIDENCE_COLOR[f.confidence]}`}>
                        [{f.confidence}]
                      </span>{" "}
                      {f.description}
                      {f.suggestedFollowUp && (
                        <div className="ml-4 text-[11px] italic text-gray-500">
                          ↳ {f.suggestedFollowUp}
                        </div>
                      )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Right: Radiologist final */}
          <div className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              {t("radiology.detail.finalReport", "Radiologist Final Report")}
            </h3>
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
              {t("radiology.detail.impression", "Impression")}
            </label>
            <input
              type="text"
              value={finalImpression}
              onChange={(e) => setFinalImpression(e.target.value)}
              disabled={!canApprove && !canAmend}
              className="mb-3 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 disabled:opacity-60"
            />
            <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
              {t("radiology.detail.report", "Report Text")}
            </label>
            <textarea
              value={finalText}
              onChange={(e) => setFinalText(e.target.value)}
              disabled={!canApprove && !canAmend}
              rows={16}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 disabled:opacity-60"
            />

            <div className="mt-3 flex gap-2">
              {canApprove && (
                <button
                  onClick={approve}
                  disabled={busy}
                  className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm text-white disabled:opacity-60"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {t("radiology.detail.approve", "Approve as Final")}
                </button>
              )}
              {canAmend && (
                <button
                  onClick={amend}
                  disabled={busy}
                  className="flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-sm text-white disabled:opacity-60"
                >
                  <AlertTriangle className="h-4 w-4" />
                  {t("radiology.detail.amend", "Save Amendment")}
                </button>
              )}
              <button
                onClick={onClose}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                {t("common.close", "Close")}
              </button>
            </div>

            {report.status === "FINAL" && report.approvedAt && (
              <div className="mt-3 rounded-lg bg-green-50 p-2 text-xs text-green-800 dark:bg-green-900/30 dark:text-green-200">
                <CheckCircle2 className="mr-1 inline h-3 w-3" />
                {t("radiology.detail.finalisedBy", "Finalised by")} {report.approvedBy ?? "—"} —{" "}
                {new Date(report.approvedAt).toLocaleString()}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
