"use client";

import { useEffect, useState, use, useCallback } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { api, openPrintEndpoint } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { useAuthStore } from "@/lib/store";
import { ArrowLeft, FlaskConical, Printer, Upload, FileImage } from "lucide-react";
import { formatDoctorName } from "@/lib/format-doctor-name";
import { formatDateTime } from "@/lib/format";
import {
  isImagingLabTest,
  getLabTestResultMode,
  QUALITATIVE_RESULT_OPTIONS,
} from "@medcore/shared";

// Issue #90: RECEPTION must NOT see the lab order detail / result-entry UI.
const LAB_ALLOWED = new Set(["ADMIN", "DOCTOR", "NURSE", "LAB_TECH", "PATIENT"]);

// Issue #622: imaging-report attachments are capped at 10 MB on the API
// (matches the global UPLOAD_MAX_BYTES on /api/v1/uploads). Pre-flight the
// cap on the client to avoid a wasted base64 encode + 413 round-trip.
const LAB_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const LAB_ATTACHMENT_ACCEPT =
  "application/pdf,image/png,image/jpeg,image/webp,application/dicom,.dcm";

interface LabTest {
  id: string;
  name: string;
  normalRange?: string | null;
  unit?: string | null;
  category?: string | null;
  panicLow?: number | null;
  panicHigh?: number | null;
}

interface LabResult {
  id: string;
  parameter: string;
  value: string;
  unit?: string | null;
  normalRange?: string | null;
  flag?: string | null;
  notes?: string | null;
}

interface LabOrderItem {
  id: string;
  status: string;
  test: LabTest;
  results?: LabResult[];
}

interface LabOrder {
  id: string;
  orderNumber?: string;
  orderedAt: string;
  status: string;
  notes?: string | null;
  patient: {
    id: string;
    mrNumber?: string;
    age?: number | null;
    gender?: string;
    user: { name: string; phone?: string };
  };
  doctor?: { user: { name: string } };
  items: LabOrderItem[];
}

const FLAG_COLORS: Record<string, string> = {
  NORMAL: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-200",
  LOW: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200",
  HIGH: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-200",
  CRITICAL: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200",
};

// Issue #624: keys must match the LabTestStatus DB enum
// (ORDERED / SAMPLE_COLLECTED / IN_PROGRESS / COMPLETED / CANCELLED /
// SAMPLE_REJECTED). The legacy "PENDING" key was a no-op.
const STATUS_COLORS: Record<string, string> = {
  ORDERED: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-200",
  SAMPLE_COLLECTED: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200",
  IN_PROGRESS: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-200",
  COMPLETED: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-200",
  CANCELLED: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200",
  SAMPLE_REJECTED: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200",
};

export default function LabOrderPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = use(params);
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const confirm = useConfirm();
  const [order, setOrder] = useState<LabOrder | null>(null);
  const [loading, setLoading] = useState(true);

  // Issue #90: redirect RECEPTION away from lab detail / result-entry form.
  // Issue #179: target /dashboard/not-authorized so the layout chrome stays.
  useEffect(() => {
    if (!isLoading && user && !LAB_ALLOWED.has(user.role)) {
      toast.error("Lab orders & results are restricted to clinical staff.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || `/dashboard/lab/${orderId}`)}`,
      );
    }
  }, [user, isLoading, router, pathname, orderId]);

  useEffect(() => {
    if (user && !LAB_ALLOWED.has(user.role)) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, user]);

  async function load() {
    setLoading(true);
    try {
      const res = await api.get<{ data: LabOrder }>(`/lab/orders/${orderId}`);
      setOrder(res.data);
    } catch {
      // empty
    }
    setLoading(false);
  }

  async function markComplete() {
    if (!(await confirm({ title: "Mark this order as complete?" }))) return;
    try {
      await api.patch(`/lab/orders/${orderId}/status`, { status: "COMPLETED" });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    }
  }

  // Issue #624: pre-analytical workflow — LAB_TECH/NURSE/ADMIN move the
  // order from ORDERED → SAMPLE_COLLECTED before any results are entered.
  // The PATCH /status endpoint stamps `collectedAt = now()` server-side
  // when the new status is SAMPLE_COLLECTED.
  async function markSampleCollected() {
    if (
      !(await confirm({
        title: "Mark sample as collected?",
        message: "This stamps the collection time and unlocks result entry.",
      }))
    )
      return;
    try {
      await api.patch(`/lab/orders/${orderId}/status`, {
        status: "SAMPLE_COLLECTED",
      });
      toast.success("Sample marked as collected.");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    }
  }

  if (loading)
    return <div className="p-8 text-center text-gray-500 dark:text-gray-400">Loading...</div>;
  if (!order)
    // Issue #627: previously rendered a single muted line with no escape
    // route. Add an explicit Back link and contact pointer so a stray
    // bookmark or stale link doesn't strand the user.
    return (
      <div className="mx-auto max-w-md p-8 text-center">
        <p className="text-lg font-semibold text-gray-800 dark:text-gray-100">
          Order not found
        </p>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          The lab order you're looking for doesn't exist or was removed.
        </p>
        <div className="mt-5 flex items-center justify-center gap-3">
          <Link
            href="/dashboard/lab"
            className="inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <ArrowLeft size={16} aria-hidden="true" /> Back to Lab Orders
          </Link>
          <button
            type="button"
            onClick={() => router.back()}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            Go back
          </button>
        </div>
      </div>
    );

  const allItemsHaveResults = order.items.every(
    (i) => i.results && i.results.length > 0
  );

  return (
    <div>
      <div className="no-print">
        <Link
          href="/dashboard/lab"
          className="mb-4 inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100"
        >
          <ArrowLeft size={14} /> Back to Lab Orders
        </Link>
      </div>

      {/* Issue #626: explicit text-gray-900 on headers and key fields. Card is
          bg-white so dark-mode text needs to remain dark — the previous `font-bold`
          alone inherited near-white from the parent body's color in dark theme,
          producing white-on-white. */}
      <div className="mb-6 rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
              <FlaskConical className="text-primary" /> Order{" "}
              {order.orderNumber || order.id.slice(0, 8)}
            </h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {/* Issue #643: previously rendered via toLocaleString() which
                  emitted US-style `4/14/2026, 12:59:07 AM` while the orders
                  list uses `14 Apr 2026`. Use the canonical formatDateTime so
                  every Lab surface speaks the same date-format. */}
              Ordered {formatDateTime(order.orderedAt)}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => openPrintEndpoint(`/lab/orders/${order.id}/pdf`)}
              aria-label="Print lab report"
              className="no-print inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 dark:border-white/15 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"
            >
              <Printer size={14} aria-hidden="true" /> Print Report
            </button>
            <span
              className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_COLORS[order.status] || ""}`}
            >
              {order.status.replace(/_/g, " ")}
            </span>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs text-gray-500 dark:text-gray-400">Patient</p>
            <p className="font-medium text-gray-900 dark:text-gray-100">{order.patient.user.name}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              MR: {order.patient.mrNumber} · {order.patient.gender} ·{" "}
              {order.patient.age ?? "—"} yrs
            </p>
          </div>
          {order.doctor && (
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400">Ordering Doctor</p>
              <p className="font-medium text-gray-900 dark:text-gray-100">{formatDoctorName(order.doctor.user.name)}</p>
            </div>
          )}
          {order.notes && (
            <div className="sm:col-span-2">
              <p className="text-xs text-gray-500 dark:text-gray-400">Notes</p>
              <p className="text-sm text-gray-900 dark:text-gray-100">{order.notes}</p>
            </div>
          )}
        </div>
      </div>

      {/* Issue #624: pre-analytical CTA. Visible to LAB_TECH/NURSE/ADMIN
          when the order is still in the initial ORDERED state, so the
          sample can be marked collected before any results are entered. */}
      {order.status === "ORDERED" &&
        (user?.role === "LAB_TECH" ||
          user?.role === "NURSE" ||
          user?.role === "ADMIN") && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-700/50 dark:bg-blue-900/30">
            <div>
              <p className="text-sm font-semibold text-blue-900 dark:text-blue-100">
                Sample not collected yet
              </p>
              <p className="text-xs text-blue-700 dark:text-blue-200">
                Mark the sample as collected to start the analytical phase.
              </p>
            </div>
            <button
              type="button"
              onClick={markSampleCollected}
              data-testid="lab-mark-collected-btn"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Mark Sample Collected
            </button>
          </div>
        )}

      {order.status !== "COMPLETED" && allItemsHaveResults && (
        <div className="mb-4 flex justify-end">
          <button
            onClick={markComplete}
            className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
          >
            Mark Order Complete
          </button>
        </div>
      )}

      {/* Issue #622: imaging / radiology orders need a file artefact
          (DICOM, PDF report, JPEG/PNG image), not a numeric value. Render
          the upload + attachment list panel only when at least one test
          on the order looks imaging-shaped (Ultrasound, X-Ray, ECG,
          Echocardiogram, MRI, CT, etc.). */}
      {order.items.some((it) =>
        isImagingLabTest({ name: it.test.name, category: it.test.category ?? null })
      ) && (
        <RadiologyAttachmentsPanel
          orderId={order.id}
          orderStatus={order.status}
          userRole={user?.role ?? null}
        />
      )}

      <div className="space-y-4">
        {order.items.map((item) => (
          <OrderItemCard
            key={item.id}
            item={item}
            orderStatus={order.status}
            onSaved={load}
            userRole={user?.role ?? null}
          />
        ))}
      </div>
    </div>
  );
}

// Imaging / radiology attachments panel (Issue #622). Lists existing
// uploads + provides an inline upload control for LAB_TECH/ADMIN/DOCTOR.
// Files are sent as base64 to POST /lab/orders/:id/attachments which
// magic-byte-sniffs and stores the artefact via services/storage.
interface LabAttachment {
  id: string;
  title: string;
  filePath: string;
  fileSize?: number | null;
  mimeType?: string | null;
  createdAt: string;
}

function RadiologyAttachmentsPanel({
  orderId,
  orderStatus,
  userRole,
}: {
  orderId: string;
  orderStatus: string;
  userRole: string | null;
}) {
  const [attachments, setAttachments] = useState<LabAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const canUpload =
    !!userRole &&
    (userRole === "LAB_TECH" || userRole === "ADMIN" || userRole === "DOCTOR") &&
    orderStatus !== "CANCELLED";

  const loadAttachments = useCallback(async () => {
    try {
      const res = await api.get<{ data: LabAttachment[] }>(
        `/lab/orders/${orderId}/attachments`,
      );
      setAttachments(res.data || []);
    } catch {
      // Empty list on any read failure — UI degrades gracefully.
      setAttachments([]);
    }
  }, [orderId]);

  useEffect(() => {
    loadAttachments();
  }, [loadAttachments]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      toast.error("Choose a file to upload");
      return;
    }
    if (file.size > LAB_ATTACHMENT_MAX_BYTES) {
      toast.error("File exceeds 10 MB cap. Compress before re-uploading.");
      return;
    }
    if (!title.trim()) {
      toast.error("Title is required (e.g. \"USG Abdomen — final report\")");
      return;
    }
    setBusy(true);
    try {
      const base64: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const r = reader.result as string;
          resolve(r.split(",")[1] || r);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await api.post(`/lab/orders/${orderId}/attachments`, {
        filename: file.name,
        base64Content: base64,
        title: title.trim(),
        notes: notes.trim() || undefined,
      });
      toast.success("Attachment uploaded");
      setFile(null);
      setTitle("");
      setNotes("");
      await loadAttachments();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to upload attachment",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mb-6 rounded-xl border border-indigo-100 bg-white p-5 shadow-sm dark:border-indigo-700/40 dark:bg-gray-800"
      data-testid="lab-radiology-panel"
    >
      <div className="mb-3 flex items-center gap-2 border-b pb-2 dark:border-white/10">
        <FileImage className="text-indigo-600 dark:text-indigo-400" size={18} aria-hidden="true" />
        <h3 className="font-semibold text-gray-900 dark:text-gray-100">
          Imaging report &amp; attachments
        </h3>
      </div>

      {attachments.length === 0 ? (
        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
          No imaging artefacts uploaded yet.
        </p>
      ) : (
        <ul className="mb-4 space-y-1.5">
          {attachments.map((a) => (
            <li
              key={a.id}
              data-testid="lab-attachment-row"
              className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-white/10"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-gray-900 dark:text-gray-100">{a.title}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {a.mimeType || "file"}
                  {a.fileSize
                    ? ` · ${(a.fileSize / 1024).toFixed(1)} KB`
                    : ""}
                  {" · "}
                  {formatDateTime(a.createdAt)}
                </p>
              </div>
              <Link
                href={`/api/v1/uploads/document/${a.id}`}
                target="_blank"
                rel="noopener"
                className="ml-3 shrink-0 rounded-lg border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-white/15 dark:text-gray-200 dark:hover:bg-white/5"
              >
                Open
              </Link>
            </li>
          ))}
        </ul>
      )}

      {canUpload ? (
        <form
          onSubmit={submit}
          data-testid="lab-attachment-upload-form"
          className="space-y-2 rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40"
        >
          <p className="text-xs font-semibold text-gray-600 dark:text-gray-300">
            Upload imaging report (PDF / JPEG / PNG / DICOM, max 10 MB)
          </p>
          <input
            type="text"
            placeholder='Title — e.g. "USG Abdomen final report"'
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-testid="lab-attachment-title"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 dark:border-white/15 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
          <input
            type="text"
            placeholder="Notes / impressions (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 dark:border-white/15 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="file"
              accept={LAB_ATTACHMENT_ACCEPT}
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              data-testid="lab-attachment-file"
              className="text-sm text-gray-700 file:mr-2 file:rounded file:border-0 file:bg-gray-200 file:px-2 file:py-1 file:text-xs file:font-medium file:text-gray-700 dark:text-gray-300 dark:file:bg-white/10 dark:file:text-gray-200"
            />
            <button
              type="submit"
              disabled={busy}
              data-testid="lab-attachment-submit"
              className="ml-auto inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              <Upload size={14} aria-hidden="true" />
              {busy ? "Uploading..." : "Upload"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function OrderItemCard({
  item,
  orderStatus,
  onSaved,
  userRole,
}: {
  item: LabOrderItem;
  orderStatus: string;
  onSaved: () => void;
  userRole: string | null;
}) {
  // Issue #255 (Apr 2026): the Add Result form must NOT render for the
  // PATIENT role. The backend already 403s the POST, but rendering the
  // form was confusing — patients would type values, hit Save, and see
  // a generic "request failed" toast. Hide the form entirely; recorded
  // results still display read-only above.
  //
  // Issue #459 (May 2026 — A5 RBAC drift): the allow-list previously
  // included DOCTOR and NURSE, but POST /lab/results is LAB_TECH | ADMIN
  // only (apps/api/src/routes/lab.ts:372 — separation of duties from
  // issue #14: the ordering doctor must not enter their own values).
  // Tighten the client to match the server, mirroring the canEnterResults
  // predicate that /dashboard/lab already uses (page.tsx:122).
  //
  // Issue #609 (May 2026): hide the Add Result form once the order is
  // finalised (COMPLETED) or CANCELLED. Backend now 409s the POST, but
  // showing the form was confusing — LabTechs would type values, hit
  // Save, and see a generic toast. Server-side guard remains the source
  // of truth; this gates the UI for parity.
  const isOrderFinalised =
    orderStatus === "COMPLETED" || orderStatus === "CANCELLED";
  const canAddResults =
    (userRole === "ADMIN" || userRole === "LAB_TECH") && !isOrderFinalised;
  const [form, setForm] = useState({
    parameter: "",
    value: "",
    unit: item.test.unit || "",
    normalRange: item.test.normalRange || "",
    flag: "NORMAL",
    notes: "",
  });
  const [valueError, setValueError] = useState<string | null>(null);

  // Issue #95: a test is "numeric" when it has a default unit OR panic
  // thresholds — those tests must accept a number, not free text. Parameters
  // like "Color" / "Appearance" on a urinalysis are still text-only.
  // Issue #620: the result mode is a 3-way (imaging / qualitative / numeric).
  // Qualitative tests (Hep B / HIV / Widal / ANA / Dengue / etc.) get a
  // POSITIVE/NEGATIVE/REACTIVE/NON-REACTIVE picker instead of free text.
  // Imaging is handled by the RadiologyAttachmentsPanel above.
  const resultMode = getLabTestResultMode({
    name: item.test.name,
    category: item.test.category ?? null,
    unit: item.test.unit ?? null,
    panicLow: item.test.panicLow ?? null,
    panicHigh: item.test.panicHigh ?? null,
  });
  const isNumericTest = resultMode === "numeric" &&
    (!!(item.test.unit && item.test.unit.trim().length > 0) ||
      typeof item.test.panicLow === "number" ||
      typeof item.test.panicHigh === "number");
  const isQualitativeTest = resultMode === "qualitative";
  const numericRegex = /^-?\d+(\.\d+)?$/;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // React-side guard for parameter + value presence (HTML5 `required` was
    // removed when the parent form adopted `noValidate` — see A4 sweep).
    if (!form.parameter.trim()) {
      setValueError(null);
      toast.error("Parameter is required");
      return;
    }
    if (!form.value.trim()) {
      setValueError("Value is required");
      return;
    }
    // Client-side mirror of validateNumericLabResult — fails fast before POST
    if (isNumericTest && !numericRegex.test(form.value.trim())) {
      setValueError(
        "Value must be a number for this test (e.g. 12.5). Free text is not allowed.",
      );
      toast.error("Result value must be a number for this test");
      return;
    }
    // Range check for numeric tests with panic thresholds — mirror of the
    // HTML5 min/max attrs that were dropped under A4.
    if (isNumericTest) {
      const num = parseFloat(form.value.trim());
      // Issue #638: even when the test has no panicLow/panicHigh range,
      // values like `1e308` or `99999999999999` are clinically impossible
      // and likely paste accidents. Cap at ±1e9 (one billion in any unit
      // — vastly above every real lab analyte) to catch overflow.
      if (!Number.isFinite(num) || Math.abs(num) > 1_000_000_000) {
        setValueError(
          "Value is outside the supported numeric range (±1e9). Re-check the entry.",
        );
        return;
      }
      if (
        typeof item.test.panicLow === "number" &&
        num < item.test.panicLow
      ) {
        setValueError(`Value must be ≥ ${item.test.panicLow}`);
        return;
      }
      if (
        typeof item.test.panicHigh === "number" &&
        num > item.test.panicHigh
      ) {
        setValueError(`Value must be ≤ ${item.test.panicHigh}`);
        return;
      }
    }
    // Issue #640: a Unit field that's only whitespace would be sent as a
    // truthy string (`"   "`) and fail server-side with a generic schema
    // error, leaving the user without a unit-specific hint. Strip whitespace
    // and surface a unit-specific error here when the user typed only spaces.
    const trimmedUnit = form.unit.trim();
    if (form.unit && !trimmedUnit) {
      toast.error("Unit cannot be only whitespace. Leave blank or enter a real unit.");
      return;
    }
    setValueError(null);
    try {
      await api.post("/lab/results", {
        orderItemId: item.id,
        parameter: form.parameter,
        value: form.value,
        unit: trimmedUnit || undefined,
        normalRange: form.normalRange || undefined,
        flag: form.flag,
        notes: form.notes || undefined,
      });
      setForm({
        parameter: "",
        value: "",
        unit: item.test.unit || "",
        normalRange: item.test.normalRange || "",
        flag: "NORMAL",
        notes: "",
      });
      onSaved();
    } catch (err) {
      // Issue #95: surface API field-level reject ("value must be a number")
      // by reading the same error.payload.details shape the zod middleware
      // emits. Fall back to the toast for everything else.
      const payload = (err as { payload?: { details?: Array<{ field?: string; message?: string }> } })
        .payload;
      const valueDetail = payload?.details?.find((d) => d?.field === "value");
      if (valueDetail?.message) {
        setValueError(valueDetail.message);
        toast.error(valueDetail.message);
        return;
      }
      toast.error(err instanceof Error ? err.message : "Failed to save result");
    }
  }

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
      <div className="mb-3 flex items-center justify-between border-b pb-3 dark:border-white/10">
        <div>
          {/* Issue #626: explicit dark text on white card. */}
          <h3 className="font-semibold text-gray-900 dark:text-gray-100">{item.test.name}</h3>
          {item.test.normalRange && (
            <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="lab-range-hint">
              {/*
               * Issue #147: the unit was being rendered twice — most lab
               * `normalRange` strings already include the unit (e.g.
               * "5-10 mg/dL"), so appending {item.test.unit} produced
               * "5-10 mg/dL mg/dL". We now only append the unit when the
               * range string does not already contain it.
               */}
              Normal range: {item.test.normalRange}
              {item.test.unit &&
              !item.test.normalRange
                .toLowerCase()
                .includes(item.test.unit.toLowerCase())
                ? ` ${item.test.unit}`
                : ""}
            </p>
          )}
        </div>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[item.status] || ""}`}
        >
          {item.status.replace(/_/g, " ")}
        </span>
      </div>

      {item.results && item.results.length > 0 && (
        <div className="mb-4">
          <p className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-300">
            Recorded Results
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-gray-500 dark:border-white/10 dark:text-gray-400">
                <th className="py-1">Parameter</th>
                <th className="py-1">Value</th>
                <th className="py-1">Unit</th>
                <th className="py-1">Normal</th>
                <th className="py-1">Flag</th>
                <th className="py-1">Notes</th>
              </tr>
            </thead>
            <tbody>
              {item.results.map((r) => (
                <tr key={r.id} className="border-b last:border-0 dark:border-white/5">
                  <td className="py-1.5 font-medium text-gray-900 dark:text-gray-100">{r.parameter}</td>
                  <td className="py-1.5 text-gray-900 dark:text-gray-100">{r.value}</td>
                  <td className="py-1.5 text-gray-600 dark:text-gray-300">{r.unit || "—"}</td>
                  <td className="py-1.5 text-xs text-gray-600 dark:text-gray-300">
                    {r.normalRange || "—"}
                  </td>
                  <td className="py-1.5">
                    {r.flag && (
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs font-medium ${FLAG_COLORS[r.flag] || ""}`}
                      >
                        {r.flag}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 text-xs text-gray-600 dark:text-gray-300">
                    {r.notes || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Issue #609: surface a finalised-order notice (no form) when the
          order is COMPLETED/CANCELLED. */}
      {isOrderFinalised && (userRole === "ADMIN" || userRole === "LAB_TECH") ? (
        <div
          data-testid="lab-result-finalised-notice"
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700/50 dark:bg-amber-900/30 dark:text-amber-200"
        >
          This order is finalised — new results cannot be added. Use the
          amendment workflow if a correction is required.
        </div>
      ) : null}

      {/* Issue #255: hide Add Result form from PATIENT role. */}
      {canAddResults ? (
      <form onSubmit={submit} noValidate className="rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40" data-testid="lab-add-result-form">
        <p className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-300">Add Result</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <input
            placeholder="Parameter"
            value={form.parameter}
            onChange={(e) => setForm({ ...form, parameter: e.target.value })}
            className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 dark:border-white/15 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
          <div>
            {isQualitativeTest ? (
              // Issue #620: qualitative tests (Hep B / HIV / Widal / ANA /
              // Dengue / urine-pregnancy / etc.) get a canonical
              // POSITIVE/NEGATIVE/REACTIVE/NON-REACTIVE picker instead of
              // free text. Stored as the raw string (no DB schema change —
              // `value` is already a free-form string up to 400 chars).
              <select
                value={form.value}
                onChange={(e) => {
                  setForm({ ...form, value: e.target.value });
                  if (valueError) setValueError(null);
                }}
                data-testid="lab-result-value"
                aria-invalid={valueError ? "true" : undefined}
                className={
                  "w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-white/15 dark:bg-gray-900 dark:text-gray-100 " +
                  (valueError ? "border-red-500 bg-red-50 dark:bg-red-900/20" : "")
                }
              >
                <option value="">Select result…</option>
                {QUALITATIVE_RESULT_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            ) : (
              <input
                // Issue #95: numeric tests accept only numbers; type=number
                // also lets browsers reject free text in supported chrome.
                // A4: dropped HTML5 `required`/`min`/`max` — React-side checks
                // (parameter/value presence + panic-range bounds) own truth so
                // inline `valueError` rendering isn't short-circuited by the
                // browser's native constraint UI.
                type={isNumericTest ? "number" : "text"}
                step={isNumericTest ? "any" : undefined}
                placeholder={
                  isNumericTest
                    ? typeof item.test.panicLow === "number" &&
                      typeof item.test.panicHigh === "number"
                      ? `Value (${item.test.panicLow}–${item.test.panicHigh})`
                      : "Value (number)"
                    : "Value"
                }
                value={form.value}
                onChange={(e) => {
                  setForm({ ...form, value: e.target.value });
                  if (valueError) setValueError(null);
                }}
                data-testid="lab-result-value"
                aria-invalid={valueError ? "true" : undefined}
                className={
                  "w-full rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 dark:border-white/15 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500 " +
                  (valueError ? "border-red-500 bg-red-50 dark:bg-red-900/20" : "")
                }
              />
            )}
            {isNumericTest &&
              (typeof item.test.panicLow === "number" ||
                typeof item.test.panicHigh === "number") && (
                <p className="mt-0.5 text-[10px] text-gray-500 dark:text-gray-400">
                  Panic range: {item.test.panicLow ?? "—"} to{" "}
                  {item.test.panicHigh ?? "—"} {item.test.unit ?? ""}
                </p>
              )}
            {valueError && (
              <p
                data-testid="error-lab-result-value"
                className="mt-1 text-xs text-red-600 dark:text-red-400"
              >
                {valueError}
              </p>
            )}
          </div>
          <input
            placeholder="Unit"
            value={form.unit}
            onChange={(e) => setForm({ ...form, unit: e.target.value })}
            className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 dark:border-white/15 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
          <input
            placeholder="Normal Range"
            value={form.normalRange}
            onChange={(e) => setForm({ ...form, normalRange: e.target.value })}
            className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 dark:border-white/15 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
          <select
            value={form.flag}
            onChange={(e) => setForm({ ...form, flag: e.target.value })}
            className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-white/15 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="NORMAL">Normal</option>
            <option value="LOW">Low</option>
            <option value="HIGH">High</option>
            <option value="CRITICAL">Critical</option>
          </select>
        </div>
        <div className="mt-2 flex gap-2">
          <input
            placeholder="Notes (optional)"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            className="flex-1 rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 dark:border-white/15 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
          <button
            type="submit"
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-dark"
          >
            Add Result
          </button>
        </div>
      </form>
      ) : null}
    </div>
  );
}
