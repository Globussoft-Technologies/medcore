"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import {
  FREQUENCY_OPTIONS,
  createPrescriptionSchema,
  updatePrescriptionSchema,
} from "@medcore/shared";
import { toast } from "@/lib/toast";
import { InfoIcon } from "@/components/Tooltip";
import { Autocomplete } from "@/components/Autocomplete";
import { EntityPicker } from "@/components/EntityPicker";
import { EmptyState } from "@/components/EmptyState";
import { SkeletonCard } from "@/components/Skeleton";
import { FileText, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { formatDoctorName } from "@/lib/format-doctor-name";
// Pearl ERP Stage 1 §2.1.4 (gap-doc row 49) — chip / segmented-control
// helpers for the structured prescription row. Lives in lib/ because
// Next.js page modules forbid non-default exports.
import {
  DOSE_PRESETS,
  ROUTE_OPTIONS,
  FREQUENCY_TOOLTIPS,
  computeAutoQuantity,
  composeInstructions,
  parseInstructions,
} from "@/lib/rx-form";

// Issue #398: render the prescription's actual issue date with explicit
// en-IN locale and Asia/Kolkata TZ, so a server in UTC doesn't shift the
// displayed date by one calendar day for late-evening prescriptions.
const RX_DATE_FMT = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

function formatRxIssuedDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return RX_DATE_FMT.format(d);
}

// Issue #399: a follow-up date in the past is meaningless to the patient
// (the visit either happened or was missed). Suppress it from the detail
// pane so the row stops looking actionable. We compare in local time using
// midnight-of-today as the cutoff so "today" is still shown.
function isFollowUpPast(value: string): boolean {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d.getTime() < today.getTime();
}

// Issue #90: RECEPTION must NOT see prescriptions / clinical diagnoses.
// PHARMACIST + NURSE keep read access (dispensing + admin); PATIENT keeps
// own-data view.
const RX_ALLOWED = new Set(["ADMIN", "DOCTOR", "NURSE", "PHARMACIST", "PATIENT"]);

interface PrescriptionRecord {
  id: string;
  diagnosis: string;
  advice: string | null;
  followUpDate: string | null;
  createdAt: string;
  printed?: boolean;
  sharedVia?: string | null;
  items: Array<{
    id?: string;
    medicineName: string;
    dosage: string;
    frequency: string;
    duration: string;
    instructions: string | null;
    refills?: number;
    refillsUsed?: number;
  }>;
  doctor: { user: { name: string } };
  patient: { user: { name: string; phone: string } };
}

interface Template {
  id: string;
  name: string;
  diagnosis: string;
  advice: string | null;
  items: Array<{
    medicineName: string;
    dosage: string;
    frequency: string;
    duration: string;
    instructions?: string;
  }>;
}

export default function PrescriptionsPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();

  // Issue #90: redirect RECEPTION (and any non-clinical role) away.
  // Issue #179: target /dashboard/not-authorized so the layout chrome stays.
  useEffect(() => {
    if (!isLoading && user && !RX_ALLOWED.has(user.role)) {
      toast.error("Prescriptions are restricted to clinical staff.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/prescriptions")}`,
      );
    }
  }, [user, isLoading, router, pathname]);
  const [prescriptions, setPrescriptions] = useState<PrescriptionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // When set, the form is in EDIT mode: submit hits PATCH /:id instead of
  // POST, and appointment/patient pickers are read-only since those are
  // immutable on an existing Rx (server-side schema also omits them).
  const [editingId, setEditingId] = useState<string | null>(null);

  // ─── Issue #169: list toolbar (search / status / date / sort / paginate) ──
  // Backend `/api/v1/prescriptions` supports `?page=&limit=&patientId=&doctorId=`
  // but does NOT honour `?search=`, `?status=`, or date range yet. We do
  // server-side pagination and apply search/status/date filters client-side
  // over the loaded page.  Sort is also client-side via DataTable-style
  // toggling (default: issuedAt desc).
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "ISSUED" | "PRINTED">("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortKey, setSortKey] = useState<"issuedAt" | "patient" | "doctor">(
    "issuedAt",
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageLimit, setPageLimit] = useState(25);
  const [total, setTotal] = useState(0);

  // Debounce search input — 300 ms.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to page 1 whenever a filter changes — otherwise we'd land on an
  // empty trailing page.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, statusFilter, dateFrom, dateTo, pageLimit]);

  // Form state
  // Pearl §2.1.3 — when the consult page deep-links here with
  // ?patientId=…&appointmentId=…, the form's EntityPickers can't
  // render their selection chips without a display label too (just
  // the ID gives them an empty search-mode UI). We pre-fetch the
  // patient name + appointment label so the chips render immediately.
  const [initialPatientLabel, setInitialPatientLabel] = useState<string | undefined>(undefined);
  const [initialAppointmentLabel, setInitialAppointmentLabel] = useState<string | undefined>(undefined);
  // Pearl §2.1.3 — when the form is opened via the consult-page Pill
  // icon (URL has `from=consult&appointmentId=…`), surface a "Back to
  // Consult" link in the form header so the doctor can return to the
  // SOAP draft in one click. Holds the appointmentId to route to;
  // null = not from consult, so no back link rendered.
  const [consultBackAppointmentId, setConsultBackAppointmentId] =
    useState<string | null>(null);
  const [form, setForm] = useState({
    appointmentId: "",
    patientId: "",
    diagnosis: "",
    advice: "",
    followUpDate: "",
    // Per-prescription signature captured via SignaturePad. Empty string =
    // "not signed yet"; otherwise a base64 PNG data URL. Submitted as
    // `signatureDataUrl` in POST/PATCH; the API persists it onto
    // Prescription.signatureUrl so the share endpoint stops rejecting.
    signatureDataUrl: "",
  });
  // Pearl §2.1.4 (gap-doc row 49): each medicine row carries the
  // wire fields PLUS purely-UI structured pieces (route / quantity /
  // qtyOverridden) that get serialized into `instructions` on submit.
  // `dosagePreset` tracks which chip is highlighted; the actual
  // `dosage` string remains the source of truth (matches the
  // dosageStringSchema regex on the wire).
  const [medicines, setMedicines] = useState<
    Array<{
      medicineName: string;
      dosage: string;
      frequency: string;
      duration: string;
      instructions: string;
      // Pearl §2.1.4 row 49 — UI-only structured fields:
      dosagePreset: string; // one of DOSE_PRESETS or "custom" or ""
      route: string; // one of ROUTE_OPTIONS.value or custom string or ""
      routeMode: "preset" | "custom"; // controls whether free-text route input is shown
      quantity: string; // auto-calculated unless qtyOverridden
      qtyOverridden: boolean; // user manually edited quantity
      // Pearl §12.c row 388 — populated when the doctor picks a medicine
      // from autocomplete AND the resolved Medicine.schedule === "X". Used
      // to render the inline controlled-substance warning banner under the
      // row and to gate the window.confirm() at submit. Free-text rows
      // (no autocomplete pick) stay false; the API enforces the gate as
      // defence-in-depth.
      scheduleX: boolean;
    }>
  >([
    {
      medicineName: "",
      dosage: "",
      frequency: "",
      duration: "",
      instructions: "",
      dosagePreset: "",
      route: "",
      routeMode: "preset",
      quantity: "",
      qtyOverridden: false,
      scheduleX: false,
    },
  ]);

  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");

  // Drug interaction warning state
  interface InteractionWarning {
    drugA: string;
    drugB: string;
    severity: string;
    description: string;
    source: string;
  }
  const [interactionWarnings, setInteractionWarnings] = useState<InteractionWarning[]>([]);
  const [showInteractionModal, setShowInteractionModal] = useState(false);
  const [checkingInteractions, setCheckingInteractions] = useState(false);
  // Issue #980: when POST /prescriptions returns 400 with an allergy
  // conflict, render the API's structured `allergyConflicts` payload as
  // an in-form banner above the Save button so the prescriber can see
  // which medicine clashed with which allergen + severity + the
  // documented reaction, instead of a generic dismissible toast that
  // drops every clinically-relevant field.
  interface AllergyConflict {
    medicineName: string;
    allergen: string;
    severity: string;
    reaction: string | null;
  }
  const [allergyConflicts, setAllergyConflicts] = useState<AllergyConflict[]>([]);

  // Pearl §2.1.4 — drug-allergy block must be overrideable WITH A REASON
  // (audit trail). Until now the banner had no override path — Save was
  // hard-disabled and the prescriber was stuck. We now open a modal that
  // captures a free-text reason (>=3 chars per the API's Zod schema),
  // then re-submits with `overrideAllergies=true` + the reason. The API
  // audit-logs `PRESCRIPTION_ALLERGY_OVERRIDE` with the conflicts list
  // and the reason so MCI-compliance can reconstruct WHY.
  const [showAllergyOverrideModal, setShowAllergyOverrideModal] =
    useState(false);
  const [allergyOverrideReason, setAllergyOverrideReason] = useState("");
  const [allergyOverrideAccepted, setAllergyOverrideAccepted] = useState(false);
  const [allergyOverrideSubmitting, setAllergyOverrideSubmitting] =
    useState(false);

  // Sign-before-share modal: when the doctor hits "Share via WhatsApp/Email"
  // on a prescription that has no signatureUrl yet, the API returns 409
  // "Cannot share an unsigned prescription". We catch that, open this
  // modal with a SignaturePad, PATCH the captured signature onto the row,
  // then retry the share. Channel is remembered so the retry hits the
  // same endpoint the doctor originally chose.
  const [signShareTarget, setSignShareTarget] = useState<{
    rx: PrescriptionRecord;
    channel: "WHATSAPP" | "EMAIL" | "SMS";
  } | null>(null);
  const [shareSignature, setShareSignature] = useState("");
  const [shareSubmitting, setShareSubmitting] = useState(false);

  // Generic substitution
  interface GenericAlt {
    id: string;
    name: string;
    brand?: string | null;
    strength?: string | null;
    form?: string | null;
    availableStock: number;
    sellingPrice: number | null;
    savingsVsBrand: number | null;
  }
  const [genericRowIdx, setGenericRowIdx] = useState<number | null>(null);
  const [renalDoseRow, setRenalDoseRow] = useState<number | null>(null);
  const [genericData, setGenericData] = useState<{
    base: { id: string; name: string; brand?: string | null };
    basePrice: number | null;
    alternatives: GenericAlt[];
  } | null>(null);
  const [genericLoading, setGenericLoading] = useState(false);

  // Inline form errors
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  async function openGenericsModal(idx: number, medicineName: string) {
    setGenericRowIdx(idx);
    setGenericData(null);
    setGenericLoading(true);
    try {
      // First resolve medicine by autocomplete
      const ac = await api.get<{ data: Array<{ id: string; name: string }> }>(
        `/medicines/search/autocomplete?q=${encodeURIComponent(medicineName)}`
      );
      const match = (ac.data ?? []).find(
        (m) => m.name.toLowerCase() === medicineName.toLowerCase()
      );
      if (!match) {
        toast.error("Could not resolve medicine for substitution lookup");
        return;
      }
      const resp = await api.get<{ data: typeof genericData }>(
        `/medicines/${match.id}/generics`
      );
      setGenericData(resp.data ?? null);
    } catch (e) {
      console.error(e);
    } finally {
      setGenericLoading(false);
    }
  }

  // Patient renal function banner
  interface RenalStatus {
    crClMlPerMin: number | null;
    ckdStage: string | null;
    latestCreatinine: { value: number; reportedAt: string } | null;
  }
  const [renalStatus, setRenalStatus] = useState<RenalStatus | null>(null);
  useEffect(() => {
    if (!form.patientId) {
      setRenalStatus(null);
      return;
    }
    (async () => {
      try {
        const resp = await api.get<{ data: RenalStatus }>(
          `/patients/${form.patientId}/renal-function`
        );
        setRenalStatus(resp.data ?? null);
      } catch (e) {
        console.error(e);
      }
    })();
  }, [form.patientId]);

  // Issue #613 (May 2026): the initial GET /api/v1/prescriptions could fire
  // before the auth-store finished hydrating from the cookie session, so the
  // request went out without the Bearer header / cookie context and the API
  // returned 401. The page then surfaced a misleading "Forbidden" error and
  // the Retry button looked like a logout. Gate the fetch on auth being both
  // hydrated (`!isLoading`) AND populated (`user` present + role allowed) so
  // the first request only goes out once we know the session is established.
  useEffect(() => {
    if (isLoading) return;
    if (!user) return;
    if (!RX_ALLOWED.has(user.role)) return;
    loadPrescriptions();
    api
      .get<{ data: Template[] }>("/prescriptions/templates/list")
      .then((r) => setTemplates(r.data))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageLimit, isLoading, user?.id, user?.role]);

  // Auto-open the Rx form when the doctor workspace quick-action links here
  // with ?new=1 (issue #11). Issue #439: also accept ?patientId=… so the
  // "Write Prescription" quick-action on the patient chart pre-fills the
  // form (this is the route the patient detail page links to).
  //
  // Issue #604: pharmacist + nurse + patient + admin opening the page with
  // ?new=1 used to render the full New Prescription form even though the
  // submit button is gated to DOCTOR. The form would 403 at POST. Auto-open
  // ONLY for DOCTOR — others can read prescriptions but never see the form
  // shell, so they don't fill clinical data they can't save.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (user?.role !== "DOCTOR") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("new") === "1") setShowForm(true);
    const pid = params.get("patientId");
    const aid = params.get("appointmentId");
    const fromParam = params.get("from");
    if (fromParam === "consult" && aid) {
      setConsultBackAppointmentId(aid);
    }
    // Pearl §2.1.3 — the consult page's Pill quick-action links here
    // with both patientId AND appointmentId so the Rx form arrives
    // already wired to the right encounter; the doctor doesn't have
    // to re-pick patient or token.
    if (pid || aid) {
      setShowForm(true);
      setForm((f) => ({
        ...f,
        ...(pid ? { patientId: pid } : {}),
        ...(aid ? { appointmentId: aid } : {}),
      }));
      // Hydrate the picker chips with display labels — the IDs alone
      // aren't enough for EntityPicker to render its "chosen" state.
      if (pid) {
        api
          .get<{
            data: { user?: { name?: string } };
          }>(`/patients/${pid}`)
          .then((r) => {
            const name = r.data?.user?.name;
            if (name) setInitialPatientLabel(name);
          })
          .catch(() => {});
      }
      if (aid) {
        api
          .get<{
            data: {
              slotStart: string | null;
              tokenNumber: number | null;
            };
          }>(`/appointments/${aid}`)
          .then((r) => {
            const slot = r.data?.slotStart ?? "—";
            const token = r.data?.tokenNumber;
            setInitialAppointmentLabel(
              token != null ? `${slot} · T-${token}` : slot,
            );
          })
          .catch(() => {});
      }
    }
  }, [user?.role]);

  // Issue #569: deep-linking to /dashboard/prescriptions?id=<uuid> (the URL
  // shape used by the dashboard "View" tile + email/notification links) used
  // to render the same list view with no detail surface. Auto-open the
  // matching row's expand pane and scroll it into view as soon as the row
  // exists in the loaded page. Works for every role that can read
  // prescriptions — patient/doctor/nurse/pharmacist/admin.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (!id) return;
    const exists = prescriptions.some((rx) => rx.id === id);
    if (!exists) return;
    setExpanded(id);
    const el = document.querySelector(`[data-testid="rx-row-${id}"]`);
    if (el && "scrollIntoView" in el) {
      (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [prescriptions]);

  function applyTemplate(tplId: string) {
    const tpl = templates.find((t) => t.id === tplId);
    if (!tpl) return;
    setForm((f) => ({
      ...f,
      diagnosis: tpl.diagnosis,
      advice: tpl.advice ?? "",
    }));
    setMedicines(
      tpl.items.map((i) => {
        const parsed = parseInstructions(i.instructions);
        const dosagePresetMatch = DOSE_PRESETS.find((p) => p === i.dosage.trim());
        const routePreset = ROUTE_OPTIONS.find((r) => r.value === parsed.route);
        return {
          medicineName: i.medicineName,
          dosage: i.dosage,
          frequency: i.frequency,
          duration: i.duration,
          instructions: parsed.notes,
          dosagePreset: dosagePresetMatch ?? (i.dosage.trim() ? "custom" : ""),
          route: parsed.route,
          routeMode: (routePreset ? "preset" : parsed.route ? "custom" : "preset") as
            | "preset"
            | "custom",
          quantity: parsed.quantity,
          qtyOverridden:
            parsed.quantity !== "" &&
            parsed.quantity !== computeAutoQuantity(i.frequency, i.duration),
          // Pearl §12.c row 388 — templates carry medicine names only, no
          // resolved Medicine row. Start at false; if the template's name
          // happens to resolve to a Schedule-X medicine, the API will still
          // gate the submit (defence-in-depth). The doctor can also tweak
          // the row via the autocomplete to refresh the flag.
          scheduleX: false,
        };
      })
    );
  }

  async function markPrinted(id: string) {
    try {
      await api.post(`/prescriptions/${id}/print`, {});
      const apiBase =
        process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";
      // Issue #523 (2026-05-05): Re-Print previously opened the HTML render
      // path which surfaced as "raw, unstyled" output in some browsers when
      // the inline <style>/CSP combo failed to apply. Prefer the real PDF
      // buffer endpoint (`?format=pdf`) which returns `application/pdf`
      // content the browser renders in its native PDF viewer with print
      // layout consistent across Chrome/Firefox/Safari.
      window.open(`${apiBase}/prescriptions/${id}/pdf?format=pdf`, "_blank");
      loadPrescriptions();
    } catch {
      /* noop */
    }
  }

  async function shareVia(rx: PrescriptionRecord, channel: "WHATSAPP" | "EMAIL" | "SMS") {
    try {
      await api.post(`/prescriptions/${rx.id}/share`, { channel });
      toast.success(`Prescription shared via ${channel}`);
      loadPrescriptions();
    } catch (err) {
      // API guard: POST /:id/share returns 409 with a "Cannot share an
      // unsigned prescription" message when Prescription.signatureUrl is
      // null. Detect that and open the Sign-before-share modal so the
      // doctor can sign retroactively, rather than just toasting an error
      // the doctor can't act on.
      const anyErr = err as Error & {
        status?: number;
        payload?: { error?: string };
      };
      const msg = anyErr?.payload?.error ?? (err instanceof Error ? err.message : "");
      if (anyErr?.status === 409 && /unsigned/i.test(msg)) {
        setShareSignature("");
        setSignShareTarget({ rx, channel });
        return;
      }
      toast.error(msg || "Failed to share");
    }
  }

  // Sign-and-share: PATCH the captured signature onto the prescription,
  // then immediately retry the original share call. If the PATCH fails we
  // MUST surface the real error and abort — the subsequent /share would
  // 409 again with the confusing "unsigned" message and the doctor would
  // be stuck re-signing in a loop.
  //
  // Legacy-data tolerance: signing is an attestation, NOT an edit. Older
  // prescriptions in the DB predate the current dosage/duration/frequency
  // regexes (Issues #9 / #542), so item fields like `duration: "2"` (bare
  // number, no unit) trip the PATCH validator and the doctor can't sign.
  // We coerce only-when-invalid: the dosage/frequency/duration shipped in
  // the PATCH payload always satisfy the shared Zod schema, even when the
  // stored item doesn't. The em-dash sentinel `—` is the validator's
  // documented "blank" escape for duration; dosage/frequency normalize to
  // safe shapes too. The Edit form remains the place to fix the actual
  // stored value if the doctor wants — this codepath only unblocks share.
  function sanitizeItemForSign(it: PrescriptionRecord["items"][number]) {
    // Duration regex (mirrors packages/shared/src/validation/prescription.ts).
    const DURATION_OK =
      /^\s*(?:\d+(?:\.\d+)?\s*(?:hour|hours|hr|hrs|h|day|days|d|week|weeks|w|wk|wks|month|months|mo|mos|m)|—|-)\s*$/i;
    // Dosage regex: number with optional unit.
    const DOSAGE_OK = /^\s*\d+(?:\.\d+)?\s*[A-Za-z%/µμ]*\s*$/;

    const rawDuration = (it.duration ?? "").trim();
    const duration = DURATION_OK.test(rawDuration) ? rawDuration : "—";

    const rawDosage = (it.dosage ?? "").trim();
    // Dosage > 0 is also enforced — "0" or "" must be coerced.
    const dosageNum = parseFloat(rawDosage);
    const dosage =
      DOSAGE_OK.test(rawDosage) && Number.isFinite(dosageNum) && dosageNum > 0
        ? rawDosage
        : "1";

    const frequency = (it.frequency ?? "").trim() || "As directed";
    const medicineName = (it.medicineName ?? "").trim() || "Unspecified";

    return {
      medicineName,
      dosage,
      frequency,
      duration,
      instructions: it.instructions ?? undefined,
    };
  }

  async function confirmShareWithSignature() {
    if (!signShareTarget || !shareSignature) return;
    const { rx, channel } = signShareTarget;
    setShareSubmitting(true);
    try {
      // followUpDate is stored as a full ISO timestamp (Prisma DateTime)
      // but updatePrescriptionSchema enforces YYYY-MM-DD only. Slice to the
      // date portion before sending so the legacy ISO shape doesn't trip
      // the validator. `undefined` for null / unparseable so the field is
      // omitted entirely (the schema treats it as optional).
      const isoDate = rx.followUpDate
        ? rx.followUpDate.slice(0, 10)
        : undefined;
      const followUpDate =
        isoDate && /^\d{4}-\d{2}-\d{2}$/.test(isoDate) ? isoDate : undefined;
      await api.patch(`/prescriptions/${rx.id}`, {
        diagnosis: rx.diagnosis,
        items: rx.items.map(sanitizeItemForSign),
        advice: rx.advice ?? undefined,
        followUpDate,
        signatureDataUrl: shareSignature,
      });
      await api.post(`/prescriptions/${rx.id}/share`, { channel });
      toast.success(`Prescription signed and shared via ${channel}`);
      setSignShareTarget(null);
      setShareSignature("");
      loadPrescriptions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to share");
    } finally {
      setShareSubmitting(false);
    }
  }

  // Issue #608 (May 2026): the prescription card had no pharmacist
  // workflow actions — only Print / Share. The pharmacy "Dispense Now"
  // tab handles the inventory deduction, but pharmacists asked for the
  // ability to mark a prescription as dispensed straight from the list,
  // and the existing /pharmacy/dispense + /pharmacy/prescriptions/:id/reject
  // endpoints already implement the underlying state changes. We expose
  // them here as buttons so the workflow no longer requires a tab swap.
  async function dispenseFromCard(id: string) {
    try {
      await api.post("/pharmacy/dispense", { prescriptionId: id });
      toast.success("Prescription dispensed");
      loadPrescriptions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to dispense");
    }
  }

  async function rejectFromCard(id: string) {
    const reason = window.prompt(
      "Rejection reason (min 10 chars — out of stock, expired, requires verification, etc.)",
      "",
    );
    if (reason === null) return;
    if (reason.trim().length < 10) {
      toast.error("Rejection reason must be at least 10 characters");
      return;
    }
    try {
      await api.post(`/pharmacy/prescriptions/${id}/reject`, {
        reason: reason.trim(),
      });
      toast.success("Prescription rejected");
      loadPrescriptions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reject");
    }
  }

  async function loadPrescriptions() {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await api.get<{
        data: PrescriptionRecord[];
        meta?: { total?: number };
      }>(`/prescriptions?page=${page}&limit=${pageLimit}`);
      setPrescriptions(res.data ?? []);
      setTotal(res.meta?.total ?? (res.data?.length ?? 0));
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to load prescriptions",
      );
      setPrescriptions([]);
      setTotal(0);
    }
    setLoading(false);
  }

  function addMedicine() {
    setMedicines([
      ...medicines,
      {
        medicineName: "",
        dosage: "",
        frequency: "",
        duration: "",
        instructions: "",
        dosagePreset: "",
        route: "",
        routeMode: "preset",
        quantity: "",
        qtyOverridden: false,
        scheduleX: false,
      },
    ]);
    // Issue #541: clear stale "At least one medicine is required" the moment
    // the user adds a row.
    if (formErrors.medicines) {
      setFormErrors((p) => ({ ...p, medicines: "" }));
    }
  }

  function removeMedicine(idx: number) {
    setMedicines(medicines.filter((_, i) => i !== idx));
  }

  function updateMedicine(idx: number, field: string, value: string) {
    const updated = [...medicines];
    const row = { ...updated[idx] };
    (row as unknown as Record<string, string>)[field] = value;

    // Pearl §2.1.4 row 49 — auto-quantity recalc whenever the
    // contributing inputs change AND the user hasn't manually
    // overridden it. Manual edits set qtyOverridden=true via a
    // separate handler so this recalc respects that.
    if ((field === "frequency" || field === "duration") && !row.qtyOverridden) {
      row.quantity = computeAutoQuantity(row.frequency, row.duration);
    }

    // Keep dosagePreset chip highlight in sync if the user types into
    // the dosage field directly: if it matches a preset, light the
    // chip; otherwise switch to "custom" so the chips don't lie.
    if (field === "dosage") {
      const match = DOSE_PRESETS.find((p) => p === value.trim());
      row.dosagePreset = match ?? (value.trim() ? "custom" : "");
    }

    updated[idx] = row;
    setMedicines(updated);
    // Issue #541: clear the medicines error as soon as any field of any row
    // is filled — the error wording covers both "no rows" and "row missing
    // fields"; once user is editing, the error will re-evaluate at submit.
    if (formErrors.medicines && value.trim()) {
      setFormErrors((p) => ({ ...p, medicines: "" }));
    }
  }

  // Pearl §2.1.4 row 49 — dedicated handler for the quantity field so
  // a manual edit flips qtyOverridden and stops the auto-recalc from
  // clobbering it on the next frequency/duration change.
  function updateQuantity(idx: number, value: string) {
    const updated = [...medicines];
    updated[idx] = { ...updated[idx], quantity: value, qtyOverridden: true };
    setMedicines(updated);
  }

  // Pearl §2.1.4 row 49 — release the manual override and snap back
  // to the auto-calculated value.
  function resetQuantityAuto(idx: number) {
    const updated = [...medicines];
    const row = { ...updated[idx], qtyOverridden: false };
    row.quantity = computeAutoQuantity(row.frequency, row.duration);
    updated[idx] = row;
    setMedicines(updated);
  }

  // Pearl §2.1.4 row 49 — chip click handler. "custom" reveals the
  // free-text input (and clears the value so the user can type fresh);
  // any other chip fills the dosage field with the chip's literal.
  function selectDosePreset(idx: number, preset: string) {
    const updated = [...medicines];
    if (preset === "custom") {
      updated[idx] = { ...updated[idx], dosagePreset: "custom", dosage: "" };
    } else {
      updated[idx] = { ...updated[idx], dosagePreset: preset, dosage: preset };
    }
    setMedicines(updated);
    if (formErrors.medicines) {
      setFormErrors((p) => ({ ...p, medicines: "" }));
    }
  }

  // Pearl §2.1.4 row 49 — frequency segmented selection. Stores the
  // canonical FREQUENCY_OPTIONS string so the wire shape is unchanged
  // (and the API's Zod schema continues to validate it).
  function selectFrequency(idx: number, freq: string) {
    updateMedicine(idx, "frequency", freq);
  }

  // Pearl §2.1.4 row 49 — route segmented selection. "Custom" flips
  // the row into a free-text input mode; otherwise stores the preset
  // literal which gets serialized into `instructions` on submit.
  function selectRoute(idx: number, route: string) {
    const updated = [...medicines];
    if (route === "custom") {
      updated[idx] = { ...updated[idx], routeMode: "custom", route: "" };
    } else {
      updated[idx] = { ...updated[idx], routeMode: "preset", route };
    }
    setMedicines(updated);
  }

  function resetForm() {
    setShowForm(false);
    setShowInteractionModal(false);
    setInteractionWarnings([]);
    setAllergyConflicts([]);
    // Pearl §2.1.4 — clear armed allergy-override state so the next
    // prescription doesn't inherit a stale override flag.
    setShowAllergyOverrideModal(false);
    setAllergyOverrideReason("");
    setAllergyOverrideAccepted(false);
    setEditingId(null);
    setForm({ appointmentId: "", patientId: "", diagnosis: "", advice: "", followUpDate: "", signatureDataUrl: "" });
    setMedicines([
      {
        medicineName: "",
        dosage: "",
        frequency: "",
        duration: "",
        instructions: "",
        dosagePreset: "",
        route: "",
        routeMode: "preset",
        quantity: "",
        qtyOverridden: false,
        scheduleX: false,
      },
    ]);
    setFormErrors({});
  }

  // Open the form pre-populated for editing. Used by the per-row Edit button
  // and by the 409-fallback flow when a doctor tries to write a new Rx for
  // an appointment that already has one.
  function openEditMode(rx: PrescriptionRecord) {
    setEditingId(rx.id);
    setShowForm(true);
    setForm({
      // appointmentId/patientId are kept in form state for display only —
      // the PATCH payload deliberately omits them.
      appointmentId: "",
      patientId: "",
      diagnosis: rx.diagnosis,
      advice: rx.advice ?? "",
      followUpDate: rx.followUpDate ? rx.followUpDate.slice(0, 10) : "",
      // Don't pre-populate the existing signature into the pad — we never
      // need to re-render an existing signature as a draw, and leaving the
      // value empty here means a PATCH that doesn't re-capture won't ship
      // an empty signatureDataUrl and (per the API guard) won't blank out
      // the stored signature.
      signatureDataUrl: "",
    });
    setMedicines(
      rx.items.length > 0
        ? rx.items.map((it) => {
            // Pearl §2.1.4 row 49 — parse the structured pieces back out
            // of the stored `instructions` so the chips/segments rehydrate.
            const parsed = parseInstructions(it.instructions);
            const dosagePresetMatch = DOSE_PRESETS.find((p) => p === it.dosage.trim());
            const routePreset = ROUTE_OPTIONS.find((r) => r.value === parsed.route);
            return {
              medicineName: it.medicineName,
              dosage: it.dosage,
              frequency: it.frequency,
              duration: it.duration,
              instructions: parsed.notes,
              dosagePreset: dosagePresetMatch ?? (it.dosage.trim() ? "custom" : ""),
              route: parsed.route,
              routeMode: (routePreset ? "preset" : parsed.route ? "custom" : "preset") as
                | "preset"
                | "custom",
              quantity: parsed.quantity,
              qtyOverridden:
                parsed.quantity !== "" &&
                parsed.quantity !== computeAutoQuantity(it.frequency, it.duration),
              // Edit mode: PrescriptionItem doesn't carry the schedule flag
              // (it's a Medicine attribute, not a copy on the item). Start
              // at false; a fresh autocomplete pick in edit mode will set
              // it. The API still re-resolves on PATCH so the gate holds.
              scheduleX: false,
            };
          })
        : [
            {
              medicineName: "",
              dosage: "",
              frequency: "",
              duration: "",
              instructions: "",
              dosagePreset: "",
              route: "",
              routeMode: "preset" as const,
              quantity: "",
              qtyOverridden: false,
              scheduleX: false,
            },
          ],
    );
    setFormErrors({});
    // Scroll up so the edit form is visible (doctor clicked the Edit button
    // on a row possibly far below the fold).
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  // Pearl §2.1.4 row 49 — collapse the row's structured route/quantity
  // pieces into the `instructions` field so the wire payload shape
  // stays exactly what the createPrescriptionSchema expects (which has
  // no route/quantity columns on PrescriptionItem). Drops the UI-only
  // fields (dosagePreset, route, routeMode, quantity, qtyOverridden)
  // before they reach the network.
  function toWireItem(m: (typeof medicines)[number]) {
    return {
      medicineName: m.medicineName,
      dosage: m.dosage,
      frequency: m.frequency,
      duration: m.duration,
      instructions: composeInstructions({
        route: m.route,
        quantity: m.quantity,
        notes: m.instructions,
      }) || undefined,
    };
  }

  async function submitPrescription(
    override: boolean,
    scheduleXAck = false,
    // Pearl §2.1.4 allergy-override fields. Plumbed through here (not on
    // a closure) so both the initial save path AND the override-modal
    // re-submit path go through one function — guarantees the wire shape
    // stays identical and audit is consistent.
    allergyOverride?: { reason: string },
  ) {
    // Issue #980: clear any stale allergy-conflict banner from a previous
    // attempt. If THIS attempt also conflicts, the catch block below
    // will repopulate it; if the doctor changed the offending medicine
    // and the API now accepts the Rx, the banner stays gone.
    setAllergyConflicts([]);
    try {
      if (editingId) {
        // Edit mode: PATCH /:id. appointment/patient are immutable on the
        // server side, so we deliberately omit them from the payload.
        await api.patch(`/prescriptions/${editingId}`, {
          diagnosis: form.diagnosis,
          items: medicines.filter((m) => m.medicineName).map(toWireItem),
          advice: form.advice || undefined,
          followUpDate: form.followUpDate || undefined,
          overrideWarnings: override,
          // Only send the signature when the doctor re-signed this session.
          // An empty string means "no new signature" — the API guard treats
          // undefined as "leave existing signature alone".
          signatureDataUrl: form.signatureDataUrl || undefined,
          // Allergy override (Pearl §2.1.4). Only sent on the re-submit
          // path after the doctor confirms in the modal — undefined on
          // the initial save so the API's allergy check runs unmuted.
          ...(allergyOverride
            ? {
                overrideAllergies: true,
                allergyOverrideReason: allergyOverride.reason,
              }
            : {}),
        });
        toast.success("Prescription updated");
      } else {
        await api.post("/prescriptions", {
          appointmentId: form.appointmentId,
          patientId: form.patientId,
          diagnosis: form.diagnosis,
          items: medicines.filter((m) => m.medicineName).map(toWireItem),
          advice: form.advice || undefined,
          followUpDate: form.followUpDate || undefined,
          overrideWarnings: override,
          // Pearl §12.c row 388 — only set when the doctor accepted the
          // window.confirm() warning. Omitted otherwise so the API can't
          // mis-attribute an Rx as acknowledged just because the flag was
          // passed through as `false`.
          ...(scheduleXAck ? { scheduleXOverrideAcknowledged: true } : {}),
          signatureDataUrl: form.signatureDataUrl || undefined,
          ...(allergyOverride
            ? {
                overrideAllergies: true,
                allergyOverrideReason: allergyOverride.reason,
              }
            : {}),
        });
      }
      // Successful save (including the override path) — clear the modal +
      // override state so the next Rx starts clean.
      setShowAllergyOverrideModal(false);
      setAllergyOverrideReason("");
      setAllergyOverrideAccepted(false);
      resetForm();
      loadPrescriptions();
    } catch (err) {
      const anyErr = err as Error & {
        payload?: {
          warnings?: InteractionWarning[];
          allergyConflicts?: AllergyConflict[];
          error?: string;
          data?: { existingPrescriptionId?: string };
        };
      };
      // Drug-interaction modal flow.
      if (anyErr.payload?.warnings && anyErr.payload.warnings.length > 0) {
        setInteractionWarnings(anyErr.payload.warnings);
        setShowInteractionModal(true);
        return;
      }
      // Issue #980: patient-allergy-conflict flow. The API returns a 400
      // with the structured `allergyConflicts` array; surface it as an
      // actionable in-form banner AND auto-open the override-with-reason
      // modal so the doctor doesn't have to hunt for the override path
      // (especially important when the allergy 400 arrives after the
      // doctor has already overridden a drug-drug warning and the
      // interactions modal has closed). Closing the modal without arming
      // still leaves the banner so they can come back to it.
      if (
        anyErr.payload?.allergyConflicts &&
        anyErr.payload.allergyConflicts.length > 0
      ) {
        setAllergyConflicts(anyErr.payload.allergyConflicts);
        // Also close the drug-drug interaction modal if it's still
        // showing — the new blocker is the allergy check, and stacking
        // two modals is confusing.
        setShowInteractionModal(false);
        setShowAllergyOverrideModal(true);
        toast.error(
          `Allergy conflict on ${anyErr.payload.allergyConflicts
            .map((c) => c.medicineName)
            .join(", ")} — record a reason to override.`,
        );
        return;
      }
      // 409 "already exists" fallback: load the existing Rx into the form
      // so the doctor can edit it instead of being stuck.
      const existingId = anyErr.payload?.data?.existingPrescriptionId;
      if (existingId && !editingId) {
        try {
          const res = await api.get<{ data: PrescriptionRecord }>(
            `/prescriptions/${existingId}`,
          );
          if (res.data) {
            toast.error(
              anyErr.payload?.error ?? "A prescription already exists — opening it for edit.",
            );
            openEditMode(res.data);
            return;
          }
        } catch {
          // Fall through to the generic toast below.
        }
      }
      toast.error(
        anyErr.payload?.error ??
          (err instanceof Error
            ? err.message
            : editingId
              ? "Failed to update prescription"
              : "Failed to create prescription"),
      );
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const items = medicines.filter((m) => m.medicineName.trim());

    // Defense-in-depth: share the Zod schema used by the API so client-side
    // rejects bad UUIDs (Issue #17) and bad dosage shapes (Issue #9) before
    // the network round-trip. In edit mode we use updatePrescriptionSchema,
    // which omits appointmentId/patientId (those are immutable server-side).
    const parsed = editingId
      ? updatePrescriptionSchema.safeParse({
          diagnosis: form.diagnosis,
          items: items.map((m) => ({
            ...toWireItem(m),
            duration: m.duration || "—",
          })),
          advice: form.advice || undefined,
          followUpDate: form.followUpDate || undefined,
        })
      : createPrescriptionSchema.safeParse({
          appointmentId: form.appointmentId,
          patientId: form.patientId,
          diagnosis: form.diagnosis,
          items: items.map((m) => ({
            ...toWireItem(m),
            duration: m.duration || "—",
          })),
          advice: form.advice || undefined,
          followUpDate: form.followUpDate || undefined,
        });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const first = issue.path[0];
        if (first === "appointmentId") {
          // Issue #490: never expose "UUID" to clinicians — when the picker
          // is empty or holds a malformed value the human-meaningful action
          // is "pick an appointment", not "fix the UUID format".
          errs.appointmentId =
            issue.message.toLowerCase().includes("uuid") ||
            issue.message === "Required" ||
            issue.message.toLowerCase().includes("invalid")
              ? "Please select an appointment"
              : issue.message;
        } else if (first === "patientId") {
          errs.patientId =
            issue.message.toLowerCase().includes("uuid") ||
            issue.message === "Required" ||
            issue.message.toLowerCase().includes("invalid")
              ? "Please select a patient"
              : issue.message;
        } else if (first === "diagnosis") {
          errs.diagnosis = "Diagnosis is required (ICD-10 recommended)";
        } else if (first === "items") {
          // Either top-level "at least one" or a per-row dosage/frequency error.
          if (!errs.medicines) {
            errs.medicines =
              issue.path.length > 1
                ? `Medicine ${Number(issue.path[1]) + 1}: ${issue.message}`
                : issue.message;
          }
        } else if (first === "followUpDate") {
          errs.followUpDate = issue.message;
        }
      }
    }
    setFormErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast.warning("Please fix the highlighted fields");
      // Issue #543: previously the toast was the only UX cue when validation
      // failed; the inline red text was easy to miss when the form scrolled
      // off-screen and the Save button stayed visible. Find the FIRST field
      // with an error and scroll-into-view + focus it so the user always
      // knows where to look.
      if (typeof window !== "undefined") {
        const order = ["patientId", "appointmentId", "diagnosis", "medicines", "followUpDate"];
        const firstWithError = order.find((k) => errs[k]);
        // Map the validation key onto a stable input id/testid in the DOM.
        const targetSelector: Record<string, string> = {
          patientId: '[data-testid="rx-patient-picker"] input, [data-testid="rx-patient-picker"]',
          appointmentId: '[data-testid="rx-appointment-picker-hint"], [data-testid="error-rx-appointment"]',
          diagnosis: '[data-testid="rx-diagnosis"] input, #rx-diagnosis',
          medicines: '[data-testid="rx-medicines"] input, [placeholder="Medicine name"]',
          followUpDate: "#rx-followup-date",
        };
        if (firstWithError) {
          const sel = targetSelector[firstWithError];
          if (sel) {
            const el =
              (document.querySelector(sel) as HTMLElement | null) ?? null;
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "center" });
              if (typeof (el as HTMLInputElement).focus === "function") {
                (el as HTMLInputElement).focus();
              }
            }
          }
        }
      }
      return;
    }
    // Pearl §12.c (gap-doc row 388) — Schedule-X controlled-substance
    // confirm. If ANY medicine row resolved to schedule "X" via the
    // autocomplete-detail fetch, the doctor must explicitly confirm the
    // dispense is medically justified before we submit. Declining cancels
    // the submit entirely. Captured in `scheduleXAck` so we can pass it
    // through to submitPrescription (which sets the wire field).
    const hasScheduleX = medicines.some(
      (m) => m.scheduleX && m.medicineName.trim(),
    );
    let scheduleXAck = false;
    if (hasScheduleX) {
      if (typeof window === "undefined" || !window.confirm) {
        toast.error(
          "Schedule-X confirmation required — please use a browser to submit.",
        );
        return;
      }
      scheduleXAck = window.confirm(
        "This prescription includes Schedule-X controlled substances. By proceeding, you confirm you have reviewed the patient's history and the dispensing is medically justified. Continue?",
      );
      if (!scheduleXAck) {
        toast.warning("Submission cancelled.");
        return;
      }
    }
    // Pearl §2.1.4 — if the prescriber armed the allergy-override via
    // the banner modal, plumb the (reason) tuple through to the wire
    // body. Undefined on the initial save so the API's allergy check
    // runs unmuted.
    const allergyOverrideArg =
      allergyOverrideAccepted && allergyOverrideReason.trim().length >= 3
        ? { reason: allergyOverrideReason.trim() }
        : undefined;
    // Preview interaction check before saving. Only runs in CREATE mode —
    // edit mode has no patientId on the form (it's immutable on the server),
    // and the PATCH handler re-runs the same check anyway, so blocking
    // interactions will still surface as a 400 with warnings on submit.
    if (editingId) {
      await submitPrescription(false, scheduleXAck, allergyOverrideArg);
      return;
    }
    setCheckingInteractions(true);
    try {
      const preview = await api.post<{
        data: { warnings: InteractionWarning[]; hasBlocking: boolean };
      }>("/prescriptions/check-interactions", {
        patientId: form.patientId,
        items,
      });
      setCheckingInteractions(false);
      if (preview.data.hasBlocking) {
        setInteractionWarnings(preview.data.warnings);
        setShowInteractionModal(true);
        return;
      }
      // Non-blocking: proceed; warnings (if any) will still be returned in response
      await submitPrescription(false, scheduleXAck, allergyOverrideArg);
    } catch (err) {
      setCheckingInteractions(false);
      // If preview itself fails, fall back to normal POST
      await submitPrescription(false, scheduleXAck, allergyOverrideArg);
    }
  }

  // ─── Issue #169: derive filtered + sorted view of the loaded page ────────
  // Backend doesn't support `?search=`, status, or date range yet, so the
  // toolbar filters apply on the client over the current page of results.
  // The exposed `total` count reflects the server-side total *before* these
  // client filters — that's fine; the per-page hit list is what the user
  // sees, and the surface area where this matters most is search-as-you-type
  // (always on the current 25 rows).
  const visiblePrescriptions = useMemo(() => {
    const q = debouncedSearch.toLowerCase();
    const fromTs = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const toTs = dateTo ? new Date(`${dateTo}T23:59:59`).getTime() : null;

    let rows = prescriptions.filter((rx) => {
      // Search across patient name + doctor name + medication names.
      if (q) {
        const hay = [
          rx.patient?.user?.name,
          rx.doctor?.user?.name,
          rx.diagnosis,
          ...(rx.items?.map((i) => i.medicineName) ?? []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      // Status filter (printed boolean → ISSUED / PRINTED).
      if (statusFilter === "PRINTED" && !rx.printed) return false;
      if (statusFilter === "ISSUED" && rx.printed) return false;
      // Date range on createdAt (issuedAt).
      if (fromTs || toTs) {
        const t = new Date(rx.createdAt).getTime();
        if (Number.isNaN(t)) return false;
        if (fromTs && t < fromTs) return false;
        if (toTs && t > toTs) return false;
      }
      return true;
    });

    const dir = sortDir === "asc" ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      let av: string | number = "";
      let bv: string | number = "";
      if (sortKey === "issuedAt") {
        av = new Date(a.createdAt).getTime();
        bv = new Date(b.createdAt).getTime();
        return ((av as number) - (bv as number)) * dir;
      }
      if (sortKey === "patient") {
        av = a.patient?.user?.name ?? "";
        bv = b.patient?.user?.name ?? "";
      } else if (sortKey === "doctor") {
        av = a.doctor?.user?.name ?? "";
        bv = b.doctor?.user?.name ?? "";
      }
      return String(av).localeCompare(String(bv)) * dir;
    });
    return rows;
  }, [prescriptions, debouncedSearch, statusFilter, dateFrom, dateTo, sortKey, sortDir]);

  function toggleSort(next: typeof sortKey) {
    if (sortKey === next) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(next);
      setSortDir(next === "issuedAt" ? "desc" : "asc");
    }
  }

  const hasActiveFilters =
    !!debouncedSearch || !!statusFilter || !!dateFrom || !!dateTo;
  const totalPages = Math.max(1, Math.ceil(total / pageLimit));

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t("dashboard.prescriptions.title")}</h1>
        <div className="flex items-center gap-2">
          {/* Pearl §2.1.3 — Back to Consult chip on the prescriptions
              list header, persists after the doctor closes/submits
              the Rx form so they can return to the SOAP draft. Shows
              only when the page was opened from /dashboard/consult. */}
          {consultBackAppointmentId && (
            <Link
              href={`/dashboard/consult/${consultBackAppointmentId}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition hover:border-primary hover:text-primary dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
              data-testid="rx-back-to-consult"
            >
              ← Back to Consult
            </Link>
          )}
          {user?.role === "DOCTOR" && (
            <button
              onClick={() => {
                // Toggle: if the form is open (in either mode) close + reset;
                // otherwise open it in CREATE mode.
                if (showForm) {
                  resetForm();
                } else {
                  setShowForm(true);
                }
              }}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
            >
              Write Prescription
            </button>
          )}
        </div>
      </div>

      {/* Prescription form */}
      {showForm && (
        // Issue #458: this form's only "required" props are passed to
        // EntityPicker (which only sets `aria-required` — the bug pattern
        // doesn't bite here) but we add `noValidate` for project-wide
        // consistency with the Option B convention adopted on
        // pharmacy / insurance-claims / login / register. React-side
        // `setFormErrors` already owns validation truth.
        <form
          data-testid="rx-new-form"
          onSubmit={handleSubmit}
          noValidate
          className="mb-6 rounded-xl bg-white p-6 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100"
        >
          <h2 className="mb-4 font-semibold">
            {editingId ? "Edit Prescription" : "New Prescription"}
          </h2>

          {editingId && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
              Editing existing prescription. Patient and appointment are locked
              — to issue an Rx for a different patient or appointment, cancel
              and write a new one.
            </div>
          )}

          {!editingId && templates.length > 0 && (
            <div className="mb-4 flex items-center gap-2 rounded-lg bg-blue-50 p-3 dark:bg-blue-900/30">
              <label htmlFor="rx-template" className="text-sm font-medium">Use Template:</label>
              <select
                id="rx-template"
                value={selectedTemplateId}
                onChange={(e) => {
                  setSelectedTemplateId(e.target.value);
                  if (e.target.value) applyTemplate(e.target.value);
                }}
                className="flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              >
                <option value="">— Select a template —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {!editingId && (
          <div className="mb-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Issue #120 (Apr 2026): replace raw "paste a UUID" inputs with
                the shared EntityPicker. Patient picker comes first so the
                appointment picker can scope to that patient — picking a
                patient automatically clears any previously selected
                appointment to prevent cross-patient prescriptions. */}
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                Patient
              </label>
              <EntityPicker
                endpoint="/patients"
                searchParam="search"
                labelField="user.name"
                subtitleField="user.phone"
                hintField="mrNumber"
                value={form.patientId}
                onChange={(id) => {
                  setForm((f) => ({
                    ...f,
                    patientId: id,
                    // Clear appointment when patient changes — avoids
                    // accidentally writing an Rx for the wrong patient.
                    appointmentId: "",
                  }));
                  if (formErrors.patientId)
                    setFormErrors((p) => ({ ...p, patientId: "" }));
                }}
                searchPlaceholder="Search patient by name, phone or MR..."
                testIdPrefix="rx-patient-picker"
                initialLabel={initialPatientLabel}
                required
              />
              {formErrors.patientId && (
                <p
                  data-testid="error-rx-patient"
                  className="mt-1 text-xs text-red-600"
                >
                  {formErrors.patientId}
                </p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                Appointment
              </label>
              {/* Issue #194: scope the appointment picker to *today*, the
                  selected patient, and only "live" statuses
                  (BOOKED / CHECKED_IN / IN_CONSULTATION) so the doctor sees
                  the active visit instead of a stale "No matches" because
                  of an off-by-one date or a CANCELLED row. The placeholder
                  drops the "Paste UUID" wording — patients shouldn't see
                  database concepts in clinical UI.
                  Note: the enum value is `IN_CONSULTATION`, not the
                  IN_PROGRESS spelling used elsewhere in the schema for
                  Admission/EmergencyCase. Sending the wrong name 500s the
                  /appointments list (Prisma enum validation). */}
              {form.patientId ? (
                <EntityPicker
                  endpoint={`/appointments?patientId=${form.patientId}&date=${
                    new Date().toISOString().split("T")[0]
                  }&status=BOOKED,CHECKED_IN,IN_CONSULTATION`}
                  searchParam="search"
                  labelField="slotStart"
                  subtitleField="doctor.user.name"
                  hintField="tokenNumber"
                  value={form.appointmentId}
                  onChange={(id) => {
                    setForm((f) => ({ ...f, appointmentId: id }));
                    if (formErrors.appointmentId)
                      setFormErrors((p) => ({ ...p, appointmentId: "" }));
                  }}
                  searchPlaceholder="Search by token / time"
                  testIdPrefix="rx-appointment-picker"
                  initialLabel={initialAppointmentLabel}
                  // Issue #194: pre-filtered URL → show today's list on
                  // focus instead of forcing 2+ chars of typing.
                  minQueryLength={0}
                  required
                />
              ) : (
                <p
                  className="rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-500 dark:border-gray-600 dark:text-gray-400"
                  data-testid="rx-appointment-picker-hint"
                >
                  Select a patient first to choose their appointment.
                </p>
              )}
              {formErrors.appointmentId && (
                <p
                  data-testid="error-rx-appointment"
                  className="mt-1 text-xs text-red-600"
                >
                  {formErrors.appointmentId}
                </p>
              )}
            </div>
          </div>
          )}

          <div className="mb-4">
            <label className="mb-1 flex items-center text-sm font-medium text-gray-700 dark:text-gray-200">
              Diagnosis
              <InfoIcon tooltip="ICD-10 codes are international standard diagnosis codes (e.g. E11.9 = Type 2 diabetes). Type to search." />
            </label>
            <Autocomplete<{ code: string; description: string }>
                value={form.diagnosis}
                onChange={(val, item) => {
                  setForm({
                    ...form,
                    diagnosis: item ? `${item.code} — ${item.description}` : val,
                  });
                  // Issue #541: stale "Diagnosis is required" persisted after
                  // the field was filled. Clear the inline error the moment
                  // the user starts typing / selects an ICD-10 entry.
                  if (formErrors.diagnosis) {
                    setFormErrors((p) => ({ ...p, diagnosis: "" }));
                  }
                }}
                fetchOptions={async (q) => {
                  const r = await api.get<{
                    data: Array<{ code: string; description: string }>;
                  }>(`/icd10?q=${encodeURIComponent(q)}`);
                  return r.data ?? [];
                }}
                getOptionLabel={(o) => `${o.code} — ${o.description}`}
                renderOption={(o) => (
                  <div>
                    <span className="font-mono text-xs text-primary">{o.code}</span>{" "}
                    <span>{o.description}</span>
                  </div>
                )}
                placeholder="Search ICD-10 (e.g. diabetes)"
                inputClassName={formErrors.diagnosis ? "border-red-500" : ""}
              />
            {formErrors.diagnosis && (
              <p className="mt-1 text-xs text-red-600">{formErrors.diagnosis}</p>
            )}
          </div>

          {/* Medicines */}
          <div className="mb-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="flex items-center text-sm font-medium">
                Medicines
                <InfoIcon tooltip="At least one medicine is required. Use the autocomplete to pick from formulary." />
              </p>
              <button
                type="button"
                onClick={addMedicine}
                className="text-sm font-medium text-primary"
              >
                + Add Medicine
              </button>
            </div>
            {medicines.map((med, idx) => (
              <div
                key={idx}
                data-testid={`rx-medicine-row-${idx}`}
                className="mb-3 flex flex-col gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/40"
              >
                {/* Medicine autocomplete + remove on the top row. */}
                <div className="flex items-start gap-2">
                  <div className="flex-1">
                    <Autocomplete<{
                      id: string;
                      name: string;
                      genericName?: string | null;
                      strength?: string | null;
                      form?: string | null;
                    }>
                      value={med.medicineName}
                      onChange={(val, item) => {
                        updateMedicine(idx, "medicineName", item ? item.name : val);
                        // Pearl §12.c row 388 — when the user picks a medicine
                        // from autocomplete, fetch its detail so we can
                        // surface the Schedule-X banner. Free-text input
                        // (no `item`) clears the flag — the API still
                        // gates the submit as defence-in-depth. The
                        // autocomplete response itself doesn't include
                        // `schedule`, so we do a single GET /medicines/:id.
                        if (item?.id) {
                          api
                            .get<{ data: { schedule?: string | null } }>(
                              `/medicines/${item.id}`,
                            )
                            .then((r) => {
                              const isX = (r.data?.schedule ?? "").toUpperCase() === "X";
                              setMedicines((prev) => {
                                const next = [...prev];
                                if (next[idx]) {
                                  next[idx] = { ...next[idx], scheduleX: isX };
                                }
                                return next;
                              });
                            })
                            .catch(() => {
                              // Swallow — the API gate still applies. We
                              // never want a transient /medicines/:id failure
                              // to block the prescriber from writing.
                            });
                        } else {
                          setMedicines((prev) => {
                            const next = [...prev];
                            if (next[idx]) {
                              next[idx] = { ...next[idx], scheduleX: false };
                            }
                            return next;
                          });
                        }
                      }}
                      fetchOptions={async (q) => {
                        const r = await api.get<{
                          data: Array<{
                            id: string;
                            name: string;
                            genericName?: string | null;
                            strength?: string | null;
                            form?: string | null;
                          }>;
                        }>(`/medicines/search/autocomplete?q=${encodeURIComponent(q)}`);
                        return r.data ?? [];
                      }}
                      getOptionLabel={(o) => o.name}
                      renderOption={(o) => (
                        <div>
                          <div className="font-medium">{o.name}</div>
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            {[o.genericName, o.strength, o.form]
                              .filter(Boolean)
                              .join(" • ")}
                          </div>
                        </div>
                      )}
                      placeholder="Medicine name"
                      inputClassName="py-1.5 text-sm"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeMedicine(idx)}
                    aria-label="Remove medicine"
                    data-testid={`rx-remove-medicine-${idx}`}
                    className="inline-flex h-11 min-w-[44px] items-center justify-center rounded px-3 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
                  >
                    Remove
                  </button>
                </div>

                {/* Pearl §12.c (gap-doc row 388) — Schedule-X controlled
                    substance warning. Surfaced inline under the medicine
                    row the moment an autocomplete-picked Medicine resolves
                    to `schedule === "X"`. On submit, a window.confirm()
                    additionally gates the POST. */}
                {med.scheduleX ? (
                  <div
                    role="alert"
                    data-testid={`rx-schedule-x-warning-${idx}`}
                    className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-600 dark:bg-amber-900/30 dark:text-amber-200"
                  >
                    <span aria-hidden>⚠ </span>
                    Schedule-X controlled substance — extra prescribing
                    controls apply. You will be asked to confirm the
                    dispense is medically justified before submitting.
                  </div>
                ) : null}

                {/* Pearl §2.1.4 row 49 — Dose chip selector. */}
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
                      Dose
                    </span>
                  </div>
                  <div
                    role="group"
                    aria-label="Dose preset"
                    data-testid={`rx-dose-chips-${idx}`}
                    className="flex flex-wrap gap-1.5"
                  >
                    {DOSE_PRESETS.map((preset) => {
                      const active = med.dosagePreset === preset;
                      return (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => selectDosePreset(idx, preset)}
                          aria-pressed={active}
                          data-testid={`rx-dose-chip-${idx}-${preset}`}
                          className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full border px-3 py-2 text-sm transition ${
                            active
                              ? "border-primary bg-primary text-white"
                              : "border-gray-300 bg-white text-gray-700 hover:border-primary hover:text-primary dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                          }`}
                        >
                          {preset}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => selectDosePreset(idx, "custom")}
                      aria-pressed={med.dosagePreset === "custom"}
                      data-testid={`rx-dose-chip-${idx}-custom`}
                      className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full border px-3 py-2 text-sm transition ${
                        med.dosagePreset === "custom"
                          ? "border-primary bg-primary text-white"
                          : "border-gray-300 bg-white text-gray-700 hover:border-primary hover:text-primary dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                      }`}
                    >
                      Custom…
                    </button>
                  </div>
                  {med.dosagePreset === "custom" || (med.dosage && !DOSE_PRESETS.some((p) => p === med.dosage.trim())) ? (
                    <input
                      placeholder="Dosage (e.g. 750mg)"
                      value={med.dosage}
                      onChange={(e) => updateMedicine(idx, "dosage", e.target.value)}
                      data-testid={`rx-dose-custom-input-${idx}`}
                      className="mt-2 min-h-[44px] w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
                    />
                  ) : null}
                </div>

                {/* Pearl §2.1.4 row 49 — Frequency segmented control. */}
                <div>
                  <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                    Frequency
                  </span>
                  <div
                    role="group"
                    aria-label="Frequency"
                    data-testid={`rx-frequency-segmented-${idx}`}
                    className="flex flex-wrap gap-1.5"
                  >
                    {FREQUENCY_OPTIONS.map((f) => {
                      const active = med.frequency === f;
                      return (
                        <button
                          key={f}
                          type="button"
                          onClick={() => selectFrequency(idx, f)}
                          aria-pressed={active}
                          title={FREQUENCY_TOOLTIPS[f] ?? f}
                          data-testid={`rx-frequency-option-${idx}-${f.split(" ")[0]}`}
                          className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border px-3 py-2 text-xs transition ${
                            active
                              ? "border-primary bg-primary text-white"
                              : "border-gray-300 bg-white text-gray-700 hover:border-primary hover:text-primary dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                          }`}
                        >
                          {f}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Pearl §2.1.4 row 49 — Route segmented control. Serialized
                    into `instructions` as `Route: XX | ...` on submit. */}
                <div>
                  <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                    Route
                  </span>
                  <div
                    role="group"
                    aria-label="Route"
                    data-testid={`rx-route-segmented-${idx}`}
                    className="flex flex-wrap gap-1.5"
                  >
                    {ROUTE_OPTIONS.map((r) => {
                      const active = med.routeMode === "preset" && med.route === r.value;
                      return (
                        <button
                          key={r.value}
                          type="button"
                          onClick={() => selectRoute(idx, r.value)}
                          aria-pressed={active}
                          title={r.tooltip}
                          data-testid={`rx-route-option-${idx}-${r.value}`}
                          className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border px-3 py-2 text-xs transition ${
                            active
                              ? "border-primary bg-primary text-white"
                              : "border-gray-300 bg-white text-gray-700 hover:border-primary hover:text-primary dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                          }`}
                        >
                          {r.label}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => selectRoute(idx, "custom")}
                      aria-pressed={med.routeMode === "custom"}
                      data-testid={`rx-route-option-${idx}-custom`}
                      className={`inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border px-3 py-2 text-xs transition ${
                        med.routeMode === "custom"
                          ? "border-primary bg-primary text-white"
                          : "border-gray-300 bg-white text-gray-700 hover:border-primary hover:text-primary dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                      }`}
                    >
                      Custom…
                    </button>
                  </div>
                  {med.routeMode === "custom" ? (
                    <input
                      placeholder="Route (e.g. Inhalation)"
                      value={med.route}
                      onChange={(e) => {
                        const updated = [...medicines];
                        updated[idx] = { ...updated[idx], route: e.target.value };
                        setMedicines(updated);
                      }}
                      data-testid={`rx-route-custom-input-${idx}`}
                      className="mt-2 min-h-[44px] w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
                    />
                  ) : null}
                </div>

                {/* Duration + auto-calc quantity side by side. */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor={`rx-duration-input-${idx}`}
                      className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300"
                    >
                      Duration
                    </label>
                    <input
                      id={`rx-duration-input-${idx}`}
                      placeholder="e.g. 5 days"
                      value={med.duration}
                      onChange={(e) => updateMedicine(idx, "duration", e.target.value)}
                      data-testid={`rx-duration-input-${idx}`}
                      className="min-h-[44px] w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
                    />
                  </div>
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <label
                        htmlFor={`rx-qty-input-${idx}`}
                        className="text-xs font-medium text-gray-600 dark:text-gray-300"
                      >
                        Quantity
                      </label>
                      {med.qtyOverridden ? (
                        <button
                          type="button"
                          onClick={() => resetQuantityAuto(idx)}
                          data-testid={`rx-qty-reset-auto-${idx}`}
                          className="text-xs text-primary hover:underline"
                        >
                          Reset to auto
                        </button>
                      ) : med.quantity ? (
                        <span
                          data-testid={`rx-qty-auto-hint-${idx}`}
                          className="text-xs text-gray-500 dark:text-gray-400"
                        >
                          auto-calculated
                        </span>
                      ) : null}
                    </div>
                    <input
                      id={`rx-qty-input-${idx}`}
                      placeholder="auto"
                      value={med.quantity}
                      onChange={(e) => updateQuantity(idx, e.target.value)}
                      data-testid={`rx-qty-input-${idx}`}
                      className="min-h-[44px] w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
                    />
                  </div>
                </div>

                {/* Optional free-text instructions, separate from
                    the structured route/qty pieces. */}
                <div>
                  <label
                    htmlFor={`rx-notes-input-${idx}`}
                    className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300"
                  >
                    Notes (optional)
                  </label>
                  <input
                    id={`rx-notes-input-${idx}`}
                    placeholder="Special instructions (e.g. after meals)"
                    value={med.instructions}
                    onChange={(e) => updateMedicine(idx, "instructions", e.target.value)}
                    data-testid={`rx-notes-input-${idx}`}
                    className="min-h-[44px] w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
                  />
                </div>

                {med.medicineName ? (
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => openGenericsModal(idx, med.medicineName)}
                      className="min-h-[44px] text-left text-xs text-emerald-700 hover:underline"
                    >
                      💰 Check for cheaper generics
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenalDoseRow(idx)}
                      className="min-h-[44px] text-left text-xs text-amber-700 hover:underline"
                    >
                      🧪 Calculate Renal Dose
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
            {formErrors.medicines && (
              <p className="mt-1 text-xs text-red-600">{formErrors.medicines}</p>
            )}
          </div>

          {renalStatus &&
          renalStatus.crClMlPerMin !== null &&
          renalStatus.crClMlPerMin < 60 ? (
            <div className="mb-4 rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm text-amber-800">
              <strong className="flex items-center">
                Renal dose adjustment needed
                <InfoIcon tooltip="CrCl (Creatinine Clearance) estimates kidney filtration rate. Below 60 mL/min may require dose reduction for many medicines." />
              </strong>
              <div className="mt-1">
                Patient CrCl {renalStatus.crClMlPerMin} mL/min ({renalStatus.ckdStage}).
                Review dosing for renally-cleared medicines before prescribing.
              </div>
            </div>
          ) : null}

          <div className="mb-4 grid grid-cols-2 gap-4">
            <textarea
              placeholder="Advice / Notes"
              value={form.advice}
              onChange={(e) => setForm({ ...form, advice: e.target.value })}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
              rows={2}
            />
            <div>
              <label htmlFor="rx-followup-date" className="mb-1 block text-sm">Follow-up Date</label>
              <input
                id="rx-followup-date"
                type="date"
                value={form.followUpDate}
                onChange={(e) => setForm({ ...form, followUpDate: e.target.value })}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
          </div>

          {/* Doctor signature — required for the prescription to be
              shareable. If left blank the row falls back to the doctor's
              pre-saved Doctor.signatureUrl, but if that's also empty the
              share endpoint will 409. The Sign-before-share modal lets
              the doctor sign retroactively. */}
          <div className="mb-4">
            <label className="mb-1 flex items-center text-sm font-medium text-gray-700 dark:text-gray-200">
              Doctor Signature
              <InfoIcon tooltip="Sign here to attest the prescription. Required before you can share via WhatsApp / Email." />
              {editingId ? null : (
                <span className="ml-1 text-xs font-normal text-gray-500 dark:text-gray-400">
                  (optional — falls back to your saved signature)
                </span>
              )}
            </label>
            <SignaturePad
              value={form.signatureDataUrl}
              onChange={(dataUrl) => setForm({ ...form, signatureDataUrl: dataUrl })}
            />
          </div>

          {/* Issue #980 + Pearl §2.1.4 (gap closed 2026-05-29): in-form
              allergy-conflict banner. Renders the structured
              `allergyConflicts` payload from the API's 400 response —
              medicine, allergen, severity, documented reaction.
              Previously the Save button was hard-disabled with no
              override path — the prescriber was stuck unless they
              changed the medicine. Now there's an explicit "Override
              with reason" button that opens a modal capturing the
              clinical justification (>=3 chars, audit-logged
              server-side as PRESCRIPTION_ALLERGY_OVERRIDE). */}
          {allergyConflicts.length > 0 && (
            <div
              role="alert"
              data-testid="rx-allergy-conflict-banner"
              className="mb-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-900/30 dark:text-red-100"
            >
              <div className="mb-2 flex items-start justify-between gap-3">
                <p className="font-semibold">
                  Allergy conflict — prescription blocked
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setAllergyConflicts([]);
                    setAllergyOverrideAccepted(false);
                    setAllergyOverrideReason("");
                  }}
                  className="text-xs text-red-700 hover:underline dark:text-red-200"
                  data-testid="rx-allergy-conflict-dismiss"
                >
                  Dismiss
                </button>
              </div>
              <ul className="space-y-1 pl-1">
                {allergyConflicts.map((c, i) => (
                  <li
                    key={`${c.medicineName}-${c.allergen}-${i}`}
                    data-testid="rx-allergy-conflict-row"
                  >
                    <span className="font-medium">{c.medicineName}</span>
                    {" conflicts with documented allergy: "}
                    <span className="font-medium">{c.allergen}</span>
                    <span
                      className={`ml-2 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                        c.severity === "SEVERE"
                          ? "bg-red-700 text-white"
                          : c.severity === "MODERATE"
                            ? "bg-amber-600 text-white"
                            : "bg-gray-500 text-white"
                      }`}
                    >
                      {c.severity}
                    </span>
                    {c.reaction ? (
                      <span className="ml-2 text-xs italic text-red-800 dark:text-red-200">
                        documented reaction: {c.reaction}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-red-800 dark:text-red-200">
                Change the medicine, or override with a documented
                clinical reason (audit-logged).
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowAllergyOverrideModal(true)}
                  data-testid="rx-allergy-override-btn"
                  className="rounded-md border border-red-400 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-600 dark:bg-red-950 dark:text-red-200"
                >
                  Override with reason
                </button>
                {allergyOverrideAccepted && (
                  <span
                    className="self-center text-xs font-medium text-amber-700 dark:text-amber-300"
                    data-testid="rx-allergy-override-armed"
                  >
                    Override armed — save to apply (reason logged)
                  </span>
                )}
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={
                allergyConflicts.length > 0 && !allergyOverrideAccepted
              }
              data-testid="rx-save-btn"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {editingId ? "Update Prescription" : "Save Prescription"}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* ── Toolbar (Issue #169): search + status + date range ──────────── */}
      <div className="mb-4 grid gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm md:grid-cols-12 dark:border-gray-700 dark:bg-gray-800">
        <div className="md:col-span-5">
          <label htmlFor="rx-search" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
            Search
          </label>
          <div className="relative">
            <Search
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              id="rx-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by patient, doctor, medicine…"
              data-testid="rx-search-input"
              aria-label="Search prescriptions"
              className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-7 pr-3 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
        </div>
        <div className="md:col-span-3">
          <label htmlFor="rx-status" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
            Status
          </label>
          <select
            id="rx-status"
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as "" | "ISSUED" | "PRINTED")
            }
            data-testid="rx-status-filter"
            aria-label="Filter by status"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">All statuses</option>
            <option value="ISSUED">Issued</option>
            <option value="PRINTED">Printed</option>
          </select>
        </div>
        <div className="md:col-span-2">
          <label htmlFor="rx-date-from-input" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
            From
          </label>
          <input
            id="rx-date-from-input"
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            data-testid="rx-date-from"
            aria-label="Issued on or after"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </div>
        <div className="md:col-span-2">
          <label htmlFor="rx-date-to-input" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
            To
          </label>
          <input
            id="rx-date-to-input"
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            data-testid="rx-date-to"
            aria-label="Issued on or before"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </div>
      </div>

      {/* Sort buttons (live above the list — DataTable-style headers don't
          fit our card layout, so we expose them as a small toolbar). */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-gray-500 dark:text-gray-400">Sort:</span>
        {(
          [
            { key: "issuedAt" as const, label: "Issued" },
            { key: "patient" as const, label: "Patient" },
            { key: "doctor" as const, label: "Doctor" },
          ]
        ).map((s) => {
          const active = sortKey === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => toggleSort(s.key)}
              data-testid={`rx-sort-${s.key}`}
              className={`rounded-full border px-3 py-1 ${
                active
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700"
              }`}
            >
              {s.label}
              {active ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
            </button>
          );
        })}
        <span
          className="ml-auto text-gray-500 dark:text-gray-400"
          data-testid="rx-total-count"
        >
          {hasActiveFilters
            ? `${visiblePrescriptions.length} of ${total} shown`
            : `${total} prescription${total === 1 ? "" : "s"}`}
        </span>
      </div>

      {/* Prescriptions list */}
      <div className="space-y-3">
        {loading ? (
          <div className="space-y-3" data-testid="rx-loading" aria-busy="true">
            <SkeletonCard className="h-32" />
            <SkeletonCard className="h-32" />
            <SkeletonCard className="h-32" />
          </div>
        ) : loadError ? (
          <div
            className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
            data-testid="rx-error"
            role="alert"
          >
            <p className="font-medium">Could not load prescriptions.</p>
            <p className="mt-1 text-xs opacity-80">{loadError}</p>
            <button
              onClick={loadPrescriptions}
              className="mt-3 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-transparent"
            >
              Retry
            </button>
          </div>
        ) : prescriptions.length === 0 ? (
          <EmptyState
            icon={<FileText size={28} aria-hidden="true" />}
            title="No prescriptions yet"
            description="Prescriptions you write will appear here."
            action={
              user?.role === "DOCTOR"
                ? { label: "Write prescription", onClick: () => setShowForm(true) }
                : undefined
            }
          />
        ) : visiblePrescriptions.length === 0 ? (
          <EmptyState
            icon={<Search size={28} aria-hidden="true" />}
            title="No matches"
            description="No prescriptions match the current search or filter. Try clearing them."
            action={{
              label: "Clear filters",
              onClick: () => {
                setSearch("");
                setStatusFilter("");
                setDateFrom("");
                setDateTo("");
              },
            }}
          />
        ) : (
          visiblePrescriptions.map((rx) => (
            <div
              key={rx.id}
              data-testid={`rx-row-${rx.id}`}
              className="rounded-xl bg-white p-4 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100"
            >
              <button
                onClick={() =>
                  setExpanded(expanded === rx.id ? null : rx.id)
                }
                className="w-full text-left"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{rx.patient.user.name}</p>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Diagnosis: {rx.diagnosis}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium">
                      {formatDoctorName(rx.doctor.user.name)}
                    </p>
                    <p
                      className="text-xs text-gray-500 dark:text-gray-400"
                      data-testid={`rx-issued-${rx.id}`}
                    >
                      Issued: {formatRxIssuedDate(rx.createdAt)}
                    </p>
                  </div>
                </div>
              </button>

              {expanded === rx.id && (
                <div className="mt-4 border-t border-gray-200 pt-4 dark:border-gray-700">
                  <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[720px]">
                    <thead>
                      <tr className="text-left text-gray-500 dark:text-gray-400">
                        <th className="pb-2">Medicine</th>
                        <th className="pb-2">Dosage</th>
                        <th className="pb-2">Frequency</th>
                        <th className="pb-2">Duration</th>
                        <th className="pb-2">Instructions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rx.items.map((item, i) => (
                        <tr key={i} className="border-t border-gray-100 dark:border-gray-700">
                          <td className="py-2 font-medium">
                            {item.medicineName}
                          </td>
                          <td className="py-2">{item.dosage}</td>
                          <td className="py-2">{item.frequency}</td>
                          <td className="py-2">{item.duration}</td>
                          <td className="py-2 text-gray-500 dark:text-gray-400">
                            {item.instructions || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                  {rx.advice && (
                    <p className="mt-3 text-sm">
                      <span className="font-medium">Advice:</span> {rx.advice}
                    </p>
                  )}
                  {rx.followUpDate && !isFollowUpPast(rx.followUpDate) && (
                    <p className="mt-1 text-sm">
                      <span className="font-medium">Follow-up:</span>{" "}
                      {formatRxIssuedDate(rx.followUpDate)}
                    </p>
                  )}
                  <div className="mt-4 flex flex-wrap gap-2">
                    {user?.role === "DOCTOR" && (
                      <button
                        type="button"
                        data-testid={`rx-edit-${rx.id}`}
                        onClick={() => openEditMode(rx)}
                        className="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
                      >
                        Edit
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => markPrinted(rx.id)}
                      className="rounded-lg border px-3 py-1.5 text-xs hover:bg-gray-50"
                    >
                      {rx.printed ? "Re-Print" : "Print"}
                    </button>
                    <button
                      type="button"
                      onClick={() => shareVia(rx, "WHATSAPP")}
                      className="rounded-lg border px-3 py-1.5 text-xs text-green-700 hover:bg-green-50"
                    >
                      Share via WhatsApp
                    </button>
                    <button
                      type="button"
                      onClick={() => shareVia(rx, "EMAIL")}
                      className="rounded-lg border px-3 py-1.5 text-xs text-blue-700 hover:bg-blue-50"
                    >
                      Share via Email
                    </button>
                    {/* Issue #608: pharmacist + admin get Dispense / Reject
                        actions on the card. Doctors/nurses keep the slimmer
                        Print + Share footer. */}
                    {(user?.role === "PHARMACIST" || user?.role === "ADMIN") && (
                      <>
                        <button
                          type="button"
                          onClick={() => dispenseFromCard(rx.id)}
                          data-testid={`rx-dispense-${rx.id}`}
                          className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
                        >
                          Dispense
                        </button>
                        <button
                          type="button"
                          onClick={() => rejectFromCard(rx.id)}
                          data-testid={`rx-reject-${rx.id}`}
                          className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100"
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {rx.sharedVia && (
                      <span className="ml-auto self-center text-xs text-gray-500 dark:text-gray-400">
                        Shared: {rx.sharedVia}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* ── Pagination (Issue #169) ─────────────────────────────────────── */}
      {!loading && !loadError && total > 0 && (
        <div
          className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
          data-testid="rx-pagination"
        >
          <div className="flex items-center gap-2">
            <label htmlFor="rx-page-size" className="text-xs">
              Rows:
            </label>
            <select
              id="rx-page-size"
              value={pageLimit}
              onChange={(e) => setPageLimit(Number(e.target.value))}
              data-testid="rx-page-size"
              aria-label="Rows per page"
              className="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span data-testid="rx-page-status">
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              data-testid="rx-page-prev"
              aria-label="Previous page"
              className="flex min-h-[32px] min-w-[32px] items-center justify-center rounded border border-gray-200 p-1 disabled:opacity-40 dark:border-gray-700"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              data-testid="rx-page-next"
              aria-label="Next page"
              className="flex min-h-[32px] min-w-[32px] items-center justify-center rounded border border-gray-200 p-1 disabled:opacity-40 dark:border-gray-700"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Pearl §2.1.4 — Drug-allergy override-with-reason modal.
          Opened from the in-form allergy-conflict banner's "Override with
          reason" button. Captures a >=3-char clinical justification
          (matches the API's Zod refine in
          packages/shared/src/validation/prescription.ts:148), arms the
          override (`allergyOverrideAccepted = true`), and closes — the
          actual submit happens via the form's Save button so all the
          normal validation (Schedule-X confirm, interactions preview)
          still runs. */}
      {showAllergyOverrideModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          data-testid="rx-allergy-override-modal"
        >
          <div className="w-full max-h-[90vh] overflow-y-auto max-w-lg rounded-xl bg-white shadow-xl dark:bg-gray-800">
            <div className="border-b border-red-200 bg-red-50 px-6 py-4 dark:border-red-800 dark:bg-red-900/40">
              <h2 className="text-lg font-semibold text-red-800 dark:text-red-100">
                Override allergy block
              </h2>
              <p className="mt-1 text-sm text-red-700 dark:text-red-200">
                You are about to prescribe a medicine the patient is
                documented as allergic to. Record a clinical reason — this
                will be audit-logged with your user ID and the conflict
                list.
              </p>
            </div>
            <div className="space-y-4 p-6">
              <ul className="space-y-1 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900 dark:border-red-700 dark:bg-red-900/30 dark:text-red-100">
                {allergyConflicts.map((c, i) => (
                  <li key={`mo-${c.medicineName}-${c.allergen}-${i}`}>
                    <span className="font-medium">{c.medicineName}</span>
                    {" ⟷ "}
                    <span className="font-medium">{c.allergen}</span>
                    {" ("}
                    {c.severity}
                    {c.reaction ? `; ${c.reaction}` : ""}
                    {")"}
                  </li>
                ))}
              </ul>
              <div>
                <label
                  htmlFor="rx-allergy-override-reason"
                  className="mb-1 block text-sm font-medium text-gray-800 dark:text-gray-200"
                >
                  Clinical reason (required, min 3 chars)
                </label>
                <textarea
                  id="rx-allergy-override-reason"
                  data-testid="rx-allergy-override-reason"
                  value={allergyOverrideReason}
                  onChange={(e) => setAllergyOverrideReason(e.target.value)}
                  rows={4}
                  maxLength={500}
                  placeholder="e.g. Prior reaction was mild rash; benefit outweighs risk; alternatives contraindicated; informed consent obtained"
                  className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {allergyOverrideReason.trim().length} / 500 characters
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-200 bg-gray-50 px-6 py-4 dark:border-gray-700 dark:bg-gray-900/40">
              <button
                type="button"
                onClick={() => {
                  setShowAllergyOverrideModal(false);
                  // Don't clear the reason in case the prescriber wants
                  // to re-open; clear `accepted` so Save stays disabled.
                  setAllergyOverrideAccepted(false);
                }}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  allergyOverrideSubmitting ||
                  allergyOverrideReason.trim().length < 3
                }
                onClick={() => {
                  setAllergyOverrideSubmitting(true);
                  setAllergyOverrideAccepted(true);
                  setShowAllergyOverrideModal(false);
                  setAllergyOverrideSubmitting(false);
                  toast.info(
                    "Override armed. Click Save Prescription to submit with the reason logged.",
                  );
                }}
                data-testid="rx-allergy-override-confirm"
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Arm override
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Drug Interaction Alert Modal */}
      {showInteractionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-h-[90vh] overflow-y-auto max-w-2xl overflow-hidden rounded-xl bg-white shadow-xl dark:bg-gray-800">
            <div className="border-b border-red-200 bg-red-50 px-6 py-4">
              <h2 className="text-lg font-semibold text-red-800">
                Drug Interaction Warning
              </h2>
              <p className="mt-1 text-sm text-red-700">
                The following interactions were detected between the prescribed medicines and the patient&apos;s active medications:
              </p>
            </div>
            <div className="max-h-[50vh] overflow-y-auto p-6">
              <ul className="space-y-3">
                {interactionWarnings.map((w, i) => (
                  <li
                    key={i}
                    className={`rounded-lg border-l-4 p-3 ${
                      w.severity === "CONTRAINDICATED" || w.severity === "SEVERE"
                        ? "border-red-500 bg-red-50"
                        : w.severity === "MODERATE"
                        ? "border-orange-400 bg-orange-50"
                        : "border-yellow-400 bg-yellow-50"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">
                        {w.drugA} ↔ {w.drugB}
                      </span>
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-semibold ${
                          w.severity === "CONTRAINDICATED" || w.severity === "SEVERE"
                            ? "bg-red-600 text-white"
                            : w.severity === "MODERATE"
                            ? "bg-orange-500 text-white"
                            : "bg-yellow-500 text-white"
                        }`}
                      >
                        {w.severity}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-gray-700 dark:text-gray-200">{w.description}</p>
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                      {w.source === "NEW_VS_NEW"
                        ? "Both medicines in this prescription"
                        : "Patient already on one of these"}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex items-center justify-end gap-3 border-t bg-gray-50 px-6 py-4">
              <button
                onClick={() => setShowInteractionModal(false)}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Cancel and revise
              </button>
              <button
                onClick={() =>
                  submitPrescription(
                    true,
                    false,
                    // Carry the armed allergy override through the
                    // drug-drug override re-submit so the API doesn't
                    // block on a fresh allergy 400. Without this, after
                    // overriding a drug-drug warning the patient-allergy
                    // check still rejects with 400 and the doctor can't
                    // tell which check is now blocking them.
                    allergyOverrideAccepted &&
                      allergyOverrideReason.trim().length >= 3
                      ? { reason: allergyOverrideReason.trim() }
                      : undefined,
                  )
                }
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                Override and continue
              </button>
            </div>
          </div>
        </div>
      )}

      {checkingInteractions && (
        <div className="fixed bottom-6 right-6 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white shadow-lg">
          Checking drug interactions...
        </div>
      )}

      {genericRowIdx !== null && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
            <div className="mb-3 flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold">Cheaper Generic Alternatives</h3>
                {genericData?.base ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    Base: {genericData.base.name}
                    {genericData.basePrice ? ` — ₹${genericData.basePrice}` : ""}
                  </p>
                ) : null}
              </div>
              <button
                onClick={() => {
                  setGenericRowIdx(null);
                  setGenericData(null);
                }}
                className="text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200"
              >
                ✕
              </button>
            </div>
            {genericLoading ? (
              <div
                data-testid="prescriptions-generic-loading"
                aria-busy="true"
                className="space-y-3"
              >
                <SkeletonCard />
                <SkeletonCard />
              </div>
            ) : !genericData || genericData.alternatives.length === 0 ? (
              <p className="text-gray-500 dark:text-gray-400">No cheaper generics in stock.</p>
            ) : (
              <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[720px]">
                <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500 dark:bg-gray-900/50 dark:text-gray-400">
                  <tr>
                    <th className="p-2">Brand</th>
                    <th className="p-2">Strength/Form</th>
                    <th className="p-2">Stock</th>
                    <th className="p-2">Price</th>
                    <th className="p-2">Savings</th>
                    <th className="p-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {genericData.alternatives.map((alt) => (
                    <tr key={alt.id} className="border-t">
                      <td className="p-2">
                        {alt.name}
                        {alt.brand ? (
                          <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">({alt.brand})</span>
                        ) : null}
                      </td>
                      <td className="p-2 text-xs text-gray-600 dark:text-gray-300">
                        {alt.strength ?? ""} {alt.form ?? ""}
                      </td>
                      <td className="p-2">{alt.availableStock}</td>
                      <td className="p-2">₹{alt.sellingPrice ?? "—"}</td>
                      <td className="p-2 text-green-700">
                        {alt.savingsVsBrand !== null && alt.savingsVsBrand > 0
                          ? `₹${alt.savingsVsBrand}`
                          : "—"}
                      </td>
                      <td className="p-2">
                        <button
                          onClick={() => {
                            if (genericRowIdx === null) return;
                            const updated = [...medicines];
                            updated[genericRowIdx] = {
                              ...updated[genericRowIdx],
                              medicineName: alt.name,
                            };
                            setMedicines(updated);
                            setGenericRowIdx(null);
                            setGenericData(null);
                          }}
                          className="rounded bg-primary px-3 py-1 text-xs text-white"
                        >
                          Switch
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Sign-before-share modal — opens when the doctor taps Share on a
          row that has no digital signature yet. Mounts the same
          SignaturePad used by the New / Edit form so the doctor can
          attest inline and continue to the share call without leaving
          the list. */}
      {signShareTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl bg-white shadow-xl dark:bg-gray-800"
            data-testid="rx-sign-share-modal"
          >
            <div className="border-b border-gray-200 px-6 py-4 dark:border-gray-700">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Sign before sharing
              </h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                This prescription for{" "}
                <span className="font-medium">
                  {signShareTarget.rx.patient.user.name}
                </span>{" "}
                has no digital signature on file. Sign below to attest the
                prescription and share via {signShareTarget.channel}.
              </p>
            </div>
            <div className="p-6">
              <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">
                Doctor Signature
                <span className="ml-1 text-red-500" aria-hidden="true">*</span>
              </label>
              <SignaturePad
                value={shareSignature}
                onChange={setShareSignature}
              />
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-gray-200 bg-gray-50 px-6 py-4 dark:border-gray-700 dark:bg-gray-900/40">
              <button
                type="button"
                onClick={() => {
                  setSignShareTarget(null);
                  setShareSignature("");
                }}
                disabled={shareSubmitting}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmShareWithSignature}
                disabled={!shareSignature || shareSubmitting}
                data-testid="rx-sign-share-confirm"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
              >
                {shareSubmitting ? "Sharing…" : `Sign & Share via ${signShareTarget.channel}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {renalDoseRow !== null && (
        <RenalDoseModal
          medicineName={medicines[renalDoseRow]?.medicineName || ""}
          patientId={form.patientId}
          onClose={() => setRenalDoseRow(null)}
          onApply={(dosage) => {
            if (renalDoseRow !== null) {
              updateMedicine(renalDoseRow, "dosage", dosage);
              toast.success("Dose applied");
            }
            setRenalDoseRow(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Renal Dose Calculator Modal ──────────────────────

interface RenalDoseResult {
  medicine: {
    id: string;
    name: string;
    requiresRenalAdjustment: boolean;
    renalAdjustmentNotes: string | null;
  };
  crClMlPerMin: number;
  ckdStage: string;
  recommendedDoseFactor: number;
  recommendation: string;
  warning: string | null;
}

function RenalDoseModal({
  medicineName,
  patientId,
  onClose,
  onApply,
}: {
  medicineName: string;
  patientId: string;
  onClose: () => void;
  onApply: (dosage: string) => void;
}) {
  const [medicineId, setMedicineId] = useState<string | null>(null);
  const [age, setAge] = useState("");
  const [weight, setWeight] = useState("");
  const [creatinine, setCreatinine] = useState("");
  const [genderMale, setGenderMale] = useState(true);
  const [result, setResult] = useState<RenalDoseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve medicine and pre-fill patient context
  useEffect(() => {
    (async () => {
      try {
        const ac = await api.get<{
          data: Array<{ id: string; name: string }>;
        }>(
          `/medicines/search/autocomplete?q=${encodeURIComponent(medicineName)}`
        );
        const match = (ac.data || []).find(
          (m) => m.name.toLowerCase() === medicineName.toLowerCase()
        );
        if (match) setMedicineId(match.id);
      } catch {
        // noop
      }

      if (!patientId) return;
      try {
        const p = await api.get<{
          data: { age: number | null; gender: string };
        }>(`/patients/${patientId}`);
        if (p.data.age != null) setAge(String(p.data.age));
        setGenderMale(p.data.gender === "MALE");
      } catch {
        // noop
      }
      try {
        const rf = await api.get<{
          data: {
            latestCreatinine: { value: number } | null;
            weightKg: number | null;
          };
        }>(`/patients/${patientId}/renal-function`);
        if (rf.data.latestCreatinine)
          setCreatinine(String(rf.data.latestCreatinine.value));
        if (rf.data.weightKg) setWeight(String(rf.data.weightKg));
      } catch {
        // noop
      }
    })();
  }, [medicineName, patientId]);

  async function calculate() {
    setError(null);
    setResult(null);
    if (!medicineId) {
      setError("Medicine not found in formulary");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post<{ data: RenalDoseResult }>(
        "/medicines/calculate-renal-dose",
        {
          medicineId,
          ageYears: parseFloat(age),
          weightKg: parseFloat(weight),
          creatinineMgDl: parseFloat(creatinine),
          genderMale,
        }
      );
      setResult(res.data);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }

  const stageColor =
    result?.ckdStage === "NORMAL"
      ? "bg-green-50 border-green-300 text-green-800"
      : result?.ckdStage === "MILD"
        ? "bg-lime-50 border-lime-300 text-lime-800"
        : result?.ckdStage === "MODERATE"
          ? "bg-amber-50 border-amber-300 text-amber-800"
          : "bg-red-50 border-red-300 text-red-800";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="mb-3 flex items-start justify-between">
          <h3 className="text-lg font-semibold">Renal Dose Calculator</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200">
            ✕
          </button>
        </div>
        <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">
          For: <span className="font-medium">{medicineName}</span>
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="renal-age" className="text-xs text-gray-600 dark:text-gray-300">Age (years)</label>
            <input
              id="renal-age"
              type="number"
              value={age}
              onChange={(e) => setAge(e.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="renal-weight" className="text-xs text-gray-600 dark:text-gray-300">Weight (kg)</label>
            <input
              id="renal-weight"
              type="number"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="renal-creatinine" className="text-xs text-gray-600 dark:text-gray-300">Creatinine (mg/dL)</label>
            <input
              id="renal-creatinine"
              type="number"
              step="0.1"
              value={creatinine}
              onChange={(e) => setCreatinine(e.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="renal-gender" className="text-xs text-gray-600 dark:text-gray-300">Gender</label>
            <select
              id="renal-gender"
              value={genderMale ? "M" : "F"}
              onChange={(e) => setGenderMale(e.target.value === "M")}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
            >
              <option value="M">Male</option>
              <option value="F">Female</option>
            </select>
          </div>
        </div>
        <button
          onClick={calculate}
          disabled={loading || !age || !weight || !creatinine}
          className="mt-4 w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Calculating..." : "Calculate"}
        </button>
        {error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            {error}
          </div>
        )}
        {result && (
          <div className={`mt-4 rounded-xl border-2 p-4 ${stageColor}`}>
            <div className="text-xs font-semibold uppercase">
              CrCl {result.crClMlPerMin} mL/min · {result.ckdStage}
            </div>
            <div className="mt-2 text-sm">
              Recommended dose factor:{" "}
              <span className="font-bold">
                {(result.recommendedDoseFactor * 100).toFixed(0)}%
              </span>{" "}
              of normal dose
            </div>
            <div className="mt-2 text-xs">{result.recommendation}</div>
            {result.warning && (
              <div className="mt-2 rounded bg-white/60 p-2 text-xs font-medium dark:bg-gray-800/60">
                ⚠️ {result.warning}
              </div>
            )}
            <button
              onClick={() =>
                onApply(
                  `${(result.recommendedDoseFactor * 100).toFixed(0)}% of normal (CrCl ${result.crClMlPerMin})`
                )
              }
              className="mt-3 w-full rounded-lg bg-white px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700"
            >
              Apply Dose
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Signature Pad ─────────────────────────────────────
//
// Mouse + touch + stylus drawable canvas. Emits a base64 PNG data URL to
// the parent on every stroke end. Used by:
//   - the New / Edit prescription form (sign at write-time), and
//   - the "Sign before sharing" modal (sign at share-time, when the
//     prescription is still unsigned and the doctor hits Share).
// The surface is intentionally always white in both light + dark themes
// so the dark ink stroke stays legible and matches the printed Rx.

function SignaturePad({
  value,
  onChange,
  hasError,
}: {
  value: string;
  onChange: (dataUrl: string) => void;
  hasError?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const hasInkRef = useRef(false);

  // Backing-store at device-pixel resolution so the signature stays crisp
  // on retina/HiDPI displays. Visible size is set by Tailwind; we only
  // scale the internal bitmap here. Runs once on mount — re-running on
  // every `value` change would wipe in-progress strokes mid-draw.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
    hasInkRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Parent clears the signature (value back to "") — for example after a
  // successful Sign & Share. Wipe the pixels so the next open starts blank.
  useEffect(() => {
    if (value) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasInkRef.current = false;
  }, [value]);

  function pointFromEvent(
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>,
  ): { x: number; y: number } | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if ("touches" in e) {
      const t = e.touches[0] ?? e.changedTouches[0];
      if (!t) return null;
      return { x: t.clientX - rect.left, y: t.clientY - rect.top };
    }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function startStroke(
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>,
  ) {
    e.preventDefault();
    const pt = pointFromEvent(e);
    if (!pt) return;
    drawingRef.current = true;
    lastPointRef.current = pt;
  }

  function moveStroke(
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>,
  ) {
    if (!drawingRef.current) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const pt = pointFromEvent(e);
    if (!canvas || !ctx || !pt || !lastPointRef.current) return;
    ctx.beginPath();
    ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
    lastPointRef.current = pt;
    hasInkRef.current = true;
  }

  function endStroke() {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    lastPointRef.current = null;
    const canvas = canvasRef.current;
    if (!canvas || !hasInkRef.current) return;
    try {
      onChange(canvas.toDataURL("image/png"));
    } catch {
      // toDataURL can fail on tainted canvases; we never draw foreign
      // images here, so this is purely defensive.
    }
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    hasInkRef.current = false;
    onChange("");
  }

  return (
    <div data-testid="rx-signature-pad">
      <div
        className={`relative rounded-lg border bg-white ${
          hasError
            ? "border-red-500"
            : "border-gray-300 dark:border-gray-700"
        }`}
      >
        <canvas
          ref={canvasRef}
          data-testid="rx-signature-canvas"
          onMouseDown={startStroke}
          onMouseMove={moveStroke}
          onMouseUp={endStroke}
          onMouseLeave={endStroke}
          onTouchStart={startStroke}
          onTouchMove={moveStroke}
          onTouchEnd={endStroke}
          className="block h-32 w-full cursor-crosshair touch-none rounded-lg"
        />
        {!value && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-gray-400 dark:text-gray-500">
            Sign here
          </span>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span
          className="text-xs text-gray-500 dark:text-gray-400"
          data-testid="rx-signature-status"
        >
          {value ? "Signature captured" : "Not signed yet"}
        </span>
        <button
          type="button"
          onClick={clear}
          data-testid="rx-signature-clear"
          className="text-xs font-medium text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
