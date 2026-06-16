"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { formatPatientAge } from "@/lib/format";
import { Search, Plus, Users, MessageCircle, Phone, Mail, UserPlus, KeyRound } from "lucide-react";
import { DataTable, Column } from "@/components/DataTable";
import { TenantSelect } from "@/components/TenantSelect";
import { PatientAvatar } from "@/components/PatientAvatar";
import { extractFieldErrors } from "@/lib/field-errors";

// Issue #104 (Apr 2026): mirror the server-side patient name regex so we
// fail fast and give the same message. Allows Devanagari + dots + hyphens
// + apostrophes; rejects digits and other symbols.
const PATIENT_NAME_REGEX = /^[A-Za-zऀ-ॿ\s.\-']{1,100}$/;
// Issue #103 / #138: 10–15 digit phone with optional leading "+".
const PATIENT_PHONE_REGEX = /^\+?\d{10,15}$/;

// Issue #382 (CRITICAL prod RBAC bypass, Apr 29 2026): Patients Registry
// holds PII for every patient in the clinic and must be staff-only. PATIENT
// role was previously able to load this page directly via URL.
// Issue #884: PHARMACIST + LAB_TECH need the patient registry to verify
// identity at the dispensing counter and the sample-collection bench
// (both already have lawful access to per-patient PHI on prescriptions
// and lab orders respectively, so the registry is in their existing
// privilege envelope, not an expansion of it). The backend `GET
// /api/v1/patients` allow-list is updated in lockstep — see
// apps/api/src/routes/patients.ts:27.
const PATIENTS_ALLOWED = new Set([
  "ADMIN",
  "RECEPTION",
  "DOCTOR",
  "NURSE",
  "PHARMACIST",
  "LAB_TECH",
]);

interface PatientRecord {
  id: string;
  mrNumber: string;
  gender: string;
  age: number | null;
  dateOfBirth?: string | null;
  bloodGroup: string | null;
  // Pearl §2.1.1 — attribution tag (WEB / PWA / WALK_IN / REFERRAL /
  // WHATSAPP / PHONE / OTHER). Optional on the wire for back-compat
  // with cached responses that pre-date the column.
  source?: string | null;
  // Signed avatar URL resolved by the list endpoint (photoUrl is the bare
  // key; this is the display URL). Null when no photo.
  photoSignedUrl?: string | null;
  user: { id: string; name: string; email: string; phone: string };
  // Patient's own email (per-tenant). May be set even when the login
  // User.email is null — e.g. a self-registered patient whose email was
  // already globally taken. The list falls back to this for the email icon.
  contactEmail?: string | null;
  // Flattened fields for sort/filter/CSV:
  name?: string;
  phone?: string;
}

export default function PatientsPage() {
  const { user, isLoading: authLoading } = useAuthStore();
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [patients, setPatients] = useState<PatientRecord[]>([]);
  const [search, setSearch] = useState("");
  // Super-admin tenant filter. A super-admin (actualRole SUPER_ADMIN, or the
  // legacy tenant-less ADMIN) bypasses tenant scoping and sees every tenant's
  // patients; the dropdown below lets them narrow to one tenant via
  // `?tenantId=`. Hidden for tenant-bound staff (already scoped to their own).
  const isSuperAdmin =
    user?.actualRole === "SUPER_ADMIN" ||
    (user?.role === "ADMIN" && !user?.tenantId);
  const [tenants, setTenants] = useState<
    Array<{ id: string; name: string; subdomain: string }>
  >([]);
  const [selectedTenantId, setSelectedTenantId] = useState("");
  // Super-admin only: which tenant a newly-registered patient is created under
  // (the super-admin has no tenant context of their own).
  const [formTenantId, setFormTenantId] = useState("");
  // Issue #427: the API call must run against a *debounced* search term so
  // typing a 5-character query doesn't fire 5 sequential `/patients?search=…`
  // requests (and so each new keystroke doesn't replace the previous result
  // set with a partial-match list mid-type, making the table appear "stuck").
  // We keep `search` as the immediate-value bound to the input and derive
  // `debouncedSearch` 250 ms later — that's the value the effect listens to.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [loading, setLoading] = useState(true);

  // Issue #382: redirect non-staff (PATIENT, etc.) away before any data fetch.
  useEffect(() => {
    if (!authLoading && user && !PATIENTS_ALLOWED.has(user.role)) {
      // Issue #179: redirect to chrome-wrapped /dashboard/not-authorized so
      // the user keeps the sidebar and gets a real "Access Denied" page
      // instead of a generic 404.
      // Issue #636 + #884: keep the toast in lockstep with PATIENTS_ALLOWED
      // above. Naming the actual permitted roles is more useful to a user
      // who hit the gate than a vague "staff-only" label.
      toast.error(
        "Patient registry is restricted to Admin, Doctor, Nurse, Reception, Pharmacist, and Lab Tech roles.",
      );
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/patients")}`,
      );
    }
  }, [authLoading, user, router, pathname]);
  // Issue #143: when redirected here from /dashboard/patients/register
  // the URL carries `?register=1` and we open the registration form.
  const [showForm, setShowForm] = useState(searchParams.get("register") === "1");
  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    age: "",
    gender: "MALE",
    address: "",
    bloodGroup: "",
    // Profile photo — bare storage key from POST /uploads ("" = none).
    photoUrl: "",
    // Pearl §2.1.1 — attribution tag. Default WALK_IN: the staff form is
    // most often used to capture an in-person walk-in registration. The
    // API treats an omitted source as "WEB" (staff web-panel keying),
    // but the form sends an explicit value so the recorded source
    // matches the receptionist's intent.
    source: "WALK_IN",
  });
  // Add-patient photo preview + uploading flag (the key lives on form.photoUrl).
  const [addPhotoPreview, setAddPhotoPreview] = useState<string | null>(null);
  const [addPhotoUploading, setAddPhotoUploading] = useState(false);
  const addPhotoInputRef = useRef<HTMLInputElement | null>(null);
  // Pearl §2.1.1 (gap row 40) — optional ABHA-link CTA on the patient
  // registration form. Collapsed by default so it does not slow the
  // happy-path register flow. When filled, the form fires a second POST
  // to /abdm/abha/link AFTER the patient is created (the create endpoint
  // does not accept abhaId on the wire — see apps/api/src/routes/patients.ts
  // POST /, which only writes the columns it explicitly lists). The
  // backend handler is the same one /dashboard/abdm uses; full OTP /
  // verify can still be driven from there.
  const [abhaExpanded, setAbhaExpanded] = useState(false);
  const [abhaAddress, setAbhaAddress] = useState("");
  const [total, setTotal] = useState(0);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  // Issue #427: 250 ms debounce — short enough to feel real-time while
  // skipping the burst of in-flight requests during a fast typist's input.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    loadPatients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, selectedTenantId]);

  // Load the tenant list for the super-admin filter dropdown (GET /tenants is
  // super-admin-only, so we only call it for super-admins; others 403 silently).
  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{
          data: Array<{ id: string; name: string; subdomain: string }>;
        }>("/tenants");
        if (!cancelled) setTenants(res.data || []);
      } catch {
        // non-super-admin / endpoint unavailable — leave the list empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSuperAdmin]);

  async function loadPatients() {
    setLoading(true);
    try {
      const q = debouncedSearch
        ? `&search=${encodeURIComponent(debouncedSearch)}`
        : "";
      // Super-admin only: narrow the cross-tenant view to one tenant.
      const tq =
        isSuperAdmin && selectedTenantId
          ? `&tenantId=${encodeURIComponent(selectedTenantId)}`
          : "";
      // Load the FULL registry (not just the first page) so the client-side
      // DataTable can paginate every patient. Previously a fixed `limit=50`
      // silently dropped any patient beyond the 50th. The API caps `take` at
      // 100, so walk the pages until we've pulled them all.
      const PAGE_LIMIT = 100;
      const all: PatientRecord[] = [];
      let pageNum = 1;
      let totalCount = 0;
      // Guard the loop so a misbehaving meta.total can't spin forever.
      for (let guard = 0; guard < 100; guard++) {
        const res = await api.get<{
          data: PatientRecord[];
          meta: { total: number };
        }>(`/patients?page=${pageNum}&limit=${PAGE_LIMIT}${q}${tq}`);
        const batch = res.data || [];
        all.push(...batch);
        totalCount = res.meta?.total ?? all.length;
        if (batch.length < PAGE_LIMIT || all.length >= totalCount) break;
        pageNum++;
      }
      const flat = all.map((p) => ({
        ...p,
        name: p.user?.name,
        phone: p.user?.phone,
      }));
      setPatients(flat);
      setTotal(totalCount);
    } catch {
      // empty
    }
    setLoading(false);
  }

  // Issue #103 (Apr 2026): when the API returns 409 because a patient with
  // this phone already exists, surface a "View existing patient" link so
  // reception can pull up the existing chart instead of creating a duplicate
  // MR record.
  const [duplicateMatch, setDuplicateMatch] = useState<{
    id: string;
    mrNumber: string;
    name: string | null;
  } | null>(null);

  // Pearl §5.3 / gap row 149 — reception-mediated forgot-phone recovery
  // modal state. Visible to RECEPTION + ADMIN only (matches the API's
  // RBAC). The patient comes to reception in person, reception verifies
  // a govt ID, then submits the new phone + identity-method + note. The
  // server invalidates outstanding OTP challenges + revokes refresh
  // tokens for the User. See apps/api/src/routes/patients.ts
  // POST /:id/recover-phone.
  const [recoverPhoneFor, setRecoverPhoneFor] = useState<PatientRecord | null>(
    null,
  );
  const [recoverForm, setRecoverForm] = useState({
    newPhone: "",
    method: "AADHAAR" as
      | "AADHAAR"
      | "PAN"
      | "VOTER_ID"
      | "DRIVING_LICENSE"
      | "PHOTO_MATCH",
    note: "",
  });
  const [recoverErrors, setRecoverErrors] = useState<Record<string, string>>(
    {},
  );
  const [recoverSubmitting, setRecoverSubmitting] = useState(false);

  function openRecoverModal(p: PatientRecord) {
    setRecoverPhoneFor(p);
    setRecoverForm({ newPhone: "", method: "AADHAAR", note: "" });
    setRecoverErrors({});
  }
  function closeRecoverModal() {
    setRecoverPhoneFor(null);
    setRecoverForm({ newPhone: "", method: "AADHAAR", note: "" });
    setRecoverErrors({});
    setRecoverSubmitting(false);
  }

  async function handleRecoverPhone(e: React.FormEvent) {
    e.preventDefault();
    if (!recoverPhoneFor) return;
    const errs: Record<string, string> = {};
    const trimmedPhone = recoverForm.newPhone.trim();
    if (!trimmedPhone) errs.newPhone = "New phone number is required";
    else if (!PATIENT_PHONE_REGEX.test(trimmedPhone))
      errs.newPhone = "Phone must be 10–15 digits, optional leading +";
    const trimmedNote = recoverForm.note.trim();
    if (trimmedNote.length < 10)
      errs.note = "Identity verification note must be at least 10 characters";
    else if (trimmedNote.length > 500)
      errs.note = "Identity verification note must be at most 500 characters";
    setRecoverErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setRecoverSubmitting(true);
    try {
      await api.post(`/patients/${recoverPhoneFor.id}/recover-phone`, {
        newPhone: trimmedPhone,
        identityVerification: {
          method: recoverForm.method,
          note: trimmedNote,
        },
      });
      toast.success(
        `Phone recovered for ${recoverPhoneFor.user?.name ?? "patient"}.`,
      );
      closeRecoverModal();
      loadPatients();
    } catch (err) {
      // Surface API-side 409 (phone-in-use) + 400 (Zod) inline.
      const status =
        err && typeof err === "object" && "status" in err
          ? (err as { status?: number }).status
          : undefined;
      const message =
        err instanceof Error ? err.message : "Failed to recover phone";
      if (status === 409) {
        setRecoverErrors((p) => ({ ...p, newPhone: message }));
      } else if (status === 400) {
        const fields = extractFieldErrors(err);
        if (fields) setRecoverErrors((p) => ({ ...p, ...fields }));
        else setRecoverErrors((p) => ({ ...p, _: message }));
      } else {
        setRecoverErrors((p) => ({ ...p, _: message }));
      }
      setRecoverSubmitting(false);
    }
  }

  // Upload the chosen image to POST /uploads (non-medical mode) and stash
  // the returned storage key on form.photoUrl (POSTed with the patient).
  async function handleAddPhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      toast.error("Photo must be a JPEG, PNG, or WEBP image.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Photo is too large (max 5 MB).");
      return;
    }
    setAddPhotoUploading(true);
    try {
      const base64Content: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not read the image."));
        reader.readAsDataURL(file);
      });
      const res = await api.post<{ data: { filePath: string; signedUrl: string } }>(
        "/uploads",
        { filename: file.name, base64Content },
      );
      setForm((f) => ({ ...f, photoUrl: res.data.filePath }));
      setAddPhotoPreview(res.data.signedUrl);
    } catch (e2) {
      toast.error((e2 as Error).message || "Photo upload failed.");
    } finally {
      setAddPhotoUploading(false);
    }
  }

  async function handleCreatePatient(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    // Issue #104: name regex covers all the valid Indian patterns; we keep
    // the existing "required" check as a separate friendlier message.
    const trimmedName = form.name.trim();
    if (!trimmedName) errs.name = "Full name is required";
    else if (!PATIENT_NAME_REGEX.test(trimmedName))
      errs.name =
        "Name may only contain letters, spaces, dots, hyphens and apostrophes";
    // Issue #103/#138 phone regex (10–15 digits, optional +).
    const trimmedPhone = form.phone.trim();
    if (!trimmedPhone) errs.phone = "Phone number is required";
    else if (!PATIENT_PHONE_REGEX.test(trimmedPhone))
      errs.phone = "Phone must be 10–15 digits, optional leading +";
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email))
      errs.email = "Enter a valid email address";
    if (form.age !== undefined && form.age !== "") {
      const ageNum = parseInt(form.age, 10);
      // Issue #555 (May 2026): allow age=0 (newborns). The original #167
      // restriction to age>=1 was an over-correction that blocked
      // legitimate newborn / infant registrations the registry was
      // already storing (MR009000 Aarav age 0, MR009003 Diya age 2).
      // Empty input is still treated as "not provided" via the outer
      // string check; only an explicitly-typed value is range-checked.
      if (Number.isNaN(ageNum) || ageNum < 0 || ageNum > 130)
        errs.age = "Age must be between 0 and 130";
    }
    if (form.address) {
      const pinMatch = form.address.match(/\b(\d{6})\b/);
      if (form.address.match(/\bpin[: ]/i) && !pinMatch)
        errs.address = "PIN code must be 6 digits";
    }
    // Super-admin must choose a target tenant (they have none of their own).
    if (isSuperAdmin && !formTenantId) {
      errs.tenantId = "Select a tenant to register the patient under";
    }
    setFormErrors(errs);
    setDuplicateMatch(null);
    if (Object.keys(errs).length > 0) return;
    try {
      const createRes = await api.post<{ data: { id: string } }>("/patients", {
        ...form,
        name: trimmedName,
        phone: trimmedPhone,
        age: form.age ? parseInt(form.age) : undefined,
        bloodGroup: form.bloodGroup || undefined,
        // Super-admin only — which tenant to create under. The API ignores it
        // for tenant-bound callers (uses their own req.tenantId).
        tenantId: isSuperAdmin && formTenantId ? formTenantId : undefined,
      });
      // Pearl §2.1.1 (gap row 40) — if reception entered an ABHA address,
      // fire the existing /abdm/abha/link endpoint with the newly-minted
      // patientId. We do NOT block the success toast/list-refresh on this
      // sidecar call: an ABDM failure should not unwind a successful
      // patient registration. A failed link surfaces as a non-fatal toast
      // so reception can retry from /dashboard/abdm.
      const trimmedAbha = abhaAddress.trim();
      const newPatientId = createRes?.data?.id;
      if (trimmedAbha && newPatientId) {
        if (!trimmedAbha.includes("@")) {
          toast.error(
            "Patient registered, but ABHA address must look like handle@domain — link skipped.",
          );
        } else {
          try {
            await api.post("/abdm/abha/link", {
              patientId: newPatientId,
              abhaAddress: trimmedAbha,
            });
            toast.success(`ABHA link initiated for ${trimmedAbha}.`);
          } catch (linkErr) {
            toast.error(
              `Patient registered, but ABHA link failed: ${
                linkErr instanceof Error ? linkErr.message : "unknown error"
              }. Retry from /dashboard/abdm.`,
            );
          }
        }
      }
      setShowForm(false);
      setForm({
        name: "",
        phone: "",
        email: "",
        age: "",
        gender: "MALE",
        address: "",
        bloodGroup: "",
        photoUrl: "",
        source: "WALK_IN",
      });
      setAddPhotoPreview(null);
      setAddPhotoUploading(false);
      setAbhaAddress("");
      setAbhaExpanded(false);
      loadPatients();
    } catch (err) {
      // Issue #103: 409 carries `existingPatient` so reception can pull up
      // the existing chart in one click. Otherwise fall through to the
      // generic field-error or toast path.
      //
      // Issue #976: the conflict field comes from the API's `details[0].field`
      // (one of "phone" | "email" | "name"). Previously this branch hard-coded
      // the error onto `phone`, so an email-duplicate surfaced red under the
      // phone input — confusing reception about which field actually clashed.
      // Read the field from details and fall back to "phone" only when the
      // API omits it.
      const payload = (err as {
        payload?: {
          existingPatient?: { id: string; mrNumber: string; name: string | null };
          details?: Array<{ field?: string; message?: string }>;
        };
      }).payload;
      if (payload?.existingPatient) {
        const conflictField =
          payload.details?.find((d) => typeof d?.field === "string")?.field ??
          "phone";
        const fieldLabel =
          conflictField === "email"
            ? "email"
            : conflictField === "name"
            ? "name and date of birth"
            : "phone";
        setDuplicateMatch(payload.existingPatient);
        setFormErrors((p) => ({
          ...p,
          [conflictField]: `Already registered as ${payload.existingPatient!.name ?? "patient"} (MR: ${payload.existingPatient!.mrNumber}).`,
        }));
        toast.error(
          `Patient with this ${fieldLabel} already exists (MR: ${payload.existingPatient.mrNumber}).`,
        );
        return;
      }
      const fields = extractFieldErrors(err);
      if (fields) {
        setFormErrors((p) => ({ ...p, ...fields }));
        toast.error(Object.values(fields)[0] || "Failed to register patient");
        return;
      }
      // Issue #547: a generic "Forbidden" toast leaves the user clueless
      // about why the action failed. The Register Patient form is visible
      // to several roles (RECEPTION + ADMIN allowlist on the API) but the
      // sidebar+chrome render the button to anyone who reaches the page,
      // so a stray 403 is reachable. Translate the generic "Forbidden"
      // (or any 403 status) into something actionable.
      const status =
        err && typeof err === "object" && "status" in err
          ? (err as { status?: number }).status
          : undefined;
      if (status === 403) {
        toast.error(
          "Your role doesn't have permission to register patients. Please contact an administrator.",
        );
        return;
      }
      toast.error(err instanceof Error ? err.message : "Failed to register patient");
    }
  }

  const columns: Column<PatientRecord>[] = [
    {
      key: "mrNumber",
      label: t("dashboard.patients.col.mr"),
      sortable: true,
      filterable: true,
      render: (p) => (
        <Link
          href={`/dashboard/patients/${p.id}`}
          className="font-mono font-medium text-primary hover:underline dark:text-blue-400"
          onClick={(e) => e.stopPropagation()}
        >
          {p.mrNumber}
        </Link>
      ),
    },
    {
      key: "name",
      label: t("dashboard.patients.col.name"),
      sortable: true,
      filterable: true,
      render: (p) => (
        <span className="flex items-center gap-2">
          <PatientAvatar
            photoUrl={p.photoSignedUrl}
            name={p.user?.name}
            size={28}
          />
          <span className="font-medium">{p.user?.name}</span>
        </span>
      ),
    },
    {
      key: "phone",
      label: t("dashboard.patients.col.phone"),
      sortable: true,
      filterable: true,
      hideMobile: false,
      render: (p) => p.user?.phone,
    },
    {
      key: "age",
      label: t("dashboard.patients.col.age"),
      sortable: true,
      hideMobile: true,
      // Never render "0" for a legacy row with missing DOB — fall back to "—".
      // Issue #13: pediatric infants (DOB < 1y) still correctly render "0".
      render: (p) => formatPatientAge(p),
    },
    { key: "gender", label: t("dashboard.patients.col.gender"), sortable: true, filterable: true, hideMobile: true },
    {
      key: "bloodGroup",
      label: t("dashboard.patients.col.bloodGroup"),
      sortable: true,
      filterable: true,
      hideMobile: true,
      render: (p) => p.bloodGroup || "—",
    },
    // Pearl §2.1.1 — attribution chip. Hidden on mobile to keep the
    // dense list usable; visible on desktop / tablet so marketing
    // analytics can be sanity-checked at a glance.
    {
      key: "source",
      label: "Source",
      sortable: true,
      filterable: true,
      hideMobile: true,
      render: (p) =>
        p.source ? (
          <span
            data-testid={`patient-source-chip-${p.id}`}
            className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200"
          >
            {p.source.replace(/_/g, " ").toLowerCase()}
          </span>
        ) : (
          <span className="text-gray-400">—</span>
        ),
    },
    // Pearl §2.1.8 — per-row Quick-Action buttons (WhatsApp / Email /
    // Call / Add-to-Lead). Pure client-side links (wa.me, mailto:, tel:)
    // for the first three; the "Add to Lead" action is a stub awaiting
    // the Lead pipeline (Pearl Stage-1 item #3, tracked separately).
    // PATIENT role doesn't see this column because the page itself
    // already redirects them away (#382 + PATIENTS_ALLOWED Set).
    {
      key: "quickActions",
      label: t("dashboard.patients.col.quickActions", "Actions"),
      sortable: false,
      filterable: false,
      hideMobile: false,
      render: (p) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {p.user?.phone && (
            <>
              <a
                href={`https://wa.me/${p.user.phone.replace(/[^\d+]/g, "")}`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open WhatsApp chat with ${p.user.name}`}
                title="WhatsApp"
                data-testid={`quickaction-whatsapp-${p.id}`}
                className="rounded p-1.5 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/30"
              >
                <MessageCircle size={16} aria-hidden="true" />
              </a>
              <a
                href={`tel:${p.user.phone}`}
                aria-label={`Call ${p.user.name}`}
                title="Call"
                data-testid={`quickaction-call-${p.id}`}
                className="rounded p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30"
              >
                <Phone size={16} aria-hidden="true" />
              </a>
            </>
          )}
          {(p.user?.email || p.contactEmail) && (
            <a
              href={`mailto:${p.user?.email || p.contactEmail}`}
              aria-label={`Email ${p.user.name}`}
              title="Email"
              data-testid={`quickaction-email-${p.id}`}
              className="rounded p-1.5 text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/30"
            >
              <Mail size={16} aria-hidden="true" />
            </a>
          )}
          {(user?.role === "RECEPTION" || user?.role === "ADMIN") && (
            <button
              type="button"
              onClick={() => openRecoverModal(p)}
              aria-label={`Recover phone for ${p.user?.name ?? "patient"}`}
              title="Recover Phone"
              data-testid={`quickaction-recover-phone-${p.id}`}
              className="rounded p-1.5 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/30"
            >
              <KeyRound size={16} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={async () => {
              // Pearl §3.3 — promote a patient back to a lead so a
              // re-engagement / upsell flow can attach to the CRM.
              try {
                await api.post("/leads", {
                  name: p.user?.name ?? "Unknown patient",
                  phone: p.user?.phone ?? undefined,
                  email:
                    p.user?.email && !p.user.email.endsWith("@medcore.invalid")
                      ? p.user.email
                      : undefined,
                  source: "REFERRAL",
                  notes: `Promoted from patient ${p.mrNumber}`,
                });
                toast.success(`${p.user?.name ?? "Patient"} added to CRM as a lead.`);
              } catch (err: any) {
                toast.error(err?.message ?? "Failed to add to CRM");
              }
            }}
            aria-label={`Add ${p.user?.name ?? "patient"} to CRM`}
            title="Add to Lead"
            data-testid={`quickaction-add-to-lead-${p.id}`}
            className="rounded p-1.5 text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/30"
          >
            <UserPlus size={16} aria-hidden="true" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {t("dashboard.patients.title")}
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {/* Issue #590: previously read literally "0 Patient registry"
                until the count loaded — confusing when patients are
                actually present below. Show a stable label, then the
                count once the page hydrates with a real total. */}
            {total > 0
              ? `${total} ${total === 1 ? "patient" : "patients"} in registry`
              : t("dashboard.patients.subtitle")}
          </p>
        </div>
        {(user?.role === "RECEPTION" || user?.role === "ADMIN") && (
          <button
            onClick={() => setShowForm(!showForm)}
            aria-label={t("dashboard.patients.register")}
            className="flex min-h-[44px] items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <Plus size={16} aria-hidden="true" /> {t("dashboard.patients.register")}
          </button>
        )}
      </div>

      {/* Registration form */}
      {showForm && (
        <form
          onSubmit={handleCreatePatient}
          className="mb-6 rounded-xl bg-white p-6 shadow-sm dark:bg-gray-800"
          noValidate
        >
          <h2 className="mb-4 font-semibold text-gray-900 dark:text-gray-100">
            {t("dashboard.patients.register")}
          </h2>
          {/* Optional profile photo */}
          <div className="mb-4 flex items-center gap-4" data-testid="patient-add-photo">
            <PatientAvatar photoUrl={addPhotoPreview} name={form.name} size={56} />
            <div className="flex flex-col gap-1">
              <input
                ref={addPhotoInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleAddPhotoChange}
                data-testid="patient-add-photo-input"
                className="hidden"
              />
              <button
                type="button"
                onClick={() => addPhotoInputRef.current?.click()}
                disabled={addPhotoUploading}
                data-testid="patient-add-photo-upload"
                className="inline-flex w-fit items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 dark:hover:bg-gray-600"
              >
                {addPhotoUploading
                  ? "Uploading…"
                  : addPhotoPreview
                    ? "Change photo"
                    : "Upload photo (optional)"}
              </button>
              <p className="text-xs text-gray-400 dark:text-gray-500">
                JPEG, PNG, or WEBP · max 5 MB
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="patient-name" className="sr-only">
                {t("dashboard.patients.fullName")}
              </label>
              <input
                id="patient-name"
                placeholder={t("dashboard.patients.fullName")}
                value={form.name}
                data-testid="patient-name"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className={
                  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                  (formErrors.name ? "border-red-500" : "border-gray-200 dark:border-gray-600")
                }
              />
              {formErrors.name && (
                <p
                  data-testid="error-patient-name"
                  className="mt-1 text-xs text-red-600"
                >
                  {formErrors.name}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="patient-phone" className="sr-only">
                {t("common.phone")}
              </label>
              <input
                id="patient-phone"
                placeholder="Phone Number (10 digits)"
                value={form.phone}
                data-testid="patient-phone"
                onChange={(e) => {
                  setForm({ ...form, phone: e.target.value });
                  if (duplicateMatch) setDuplicateMatch(null);
                }}
                className={
                  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                  (formErrors.phone ? "border-red-500" : "border-gray-200 dark:border-gray-600")
                }
              />
              {formErrors.phone && (
                <p
                  data-testid="error-patient-phone"
                  className="mt-1 text-xs text-red-600"
                >
                  {formErrors.phone}
                </p>
              )}
              {duplicateMatch && (
                <button
                  type="button"
                  data-testid="patient-duplicate-view"
                  onClick={() =>
                    router.push(`/dashboard/patients/${duplicateMatch.id}`)
                  }
                  className="mt-1 text-xs font-medium text-blue-600 underline hover:text-blue-800"
                >
                  View existing patient ({duplicateMatch.mrNumber})
                </button>
              )}
            </div>
            <div>
              <label htmlFor="patient-email" className="sr-only">
                {t("common.email")}
              </label>
              <input
                id="patient-email"
                type="email"
                placeholder="Email (optional)"
                value={form.email}
                data-testid="patient-email"
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className={
                  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                  (formErrors.email ? "border-red-500" : "border-gray-200 dark:border-gray-600")
                }
              />
              {formErrors.email && (
                <p data-testid="error-email" className="mt-1 text-xs text-red-600">
                  {formErrors.email}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="patient-age" className="sr-only">
                {t("register.age")}
              </label>
              <input
                id="patient-age"
                placeholder={t("register.age")}
                type="number"
                min={1}
                max={130}
                value={form.age}
                data-testid="patient-age"
                onChange={(e) => setForm({ ...form, age: e.target.value })}
                className={
                  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                  (formErrors.age ? "border-red-500" : "border-gray-200 dark:border-gray-600")
                }
              />
              {formErrors.age && (
                <p data-testid="error-patient-age" className="mt-1 text-xs text-red-600">
                  {formErrors.age}
                </p>
              )}
            </div>
            <label htmlFor="patient-gender" className="sr-only">
              {t("register.gender")}
            </label>
            <select
              id="patient-gender"
              value={form.gender}
              onChange={(e) => setForm({ ...form, gender: e.target.value })}
              className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="MALE">{t("register.gender.male")}</option>
              <option value="FEMALE">{t("register.gender.female")}</option>
              <option value="OTHER">{t("register.gender.other")}</option>
            </select>
            <label htmlFor="patient-blood" className="sr-only">
              {t("dashboard.patients.bloodGroup")}
            </label>
            <select
              id="patient-blood"
              value={form.bloodGroup}
              onChange={(e) => setForm({ ...form, bloodGroup: e.target.value })}
              className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="">{t("dashboard.patients.bloodGroup")}</option>
              <option value="A+">A+</option>
              <option value="A-">A-</option>
              <option value="B+">B+</option>
              <option value="B-">B-</option>
              <option value="AB+">AB+</option>
              <option value="AB-">AB-</option>
              <option value="O+">O+</option>
              <option value="O-">O-</option>
            </select>
            <label htmlFor="patient-source" className="sr-only">
              Source
            </label>
            <select
              id="patient-source"
              data-testid="patient-source"
              value={form.source}
              onChange={(e) => setForm({ ...form, source: e.target.value })}
              className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              aria-label="Patient registration source"
            >
              {/* Pearl §2.1.1 — attribution for marketing / CRM analytics.
                  Values map 1:1 to the PatientSource Prisma enum. */}
              <option value="WALK_IN">Source: Walk-in</option>
              <option value="WEB">Source: Web</option>
              <option value="PWA">Source: PWA</option>
              <option value="REFERRAL">Source: Referral</option>
              <option value="WHATSAPP">Source: WhatsApp</option>
              <option value="PHONE">Source: Phone</option>
              <option value="OTHER">Source: Other</option>
            </select>
            {/* Super-admin only: target tenant for the new patient. A super-
                admin has no tenant of their own, so they must choose which
                tenant the patient belongs to. Tenant-bound staff never see
                this — the API pins the patient to their own tenant. */}
            {isSuperAdmin && (
              <div className="flex flex-col gap-1">
                <TenantSelect
                  tenants={tenants}
                  value={formTenantId}
                  onChange={setFormTenantId}
                  placeholder="Select tenant…"
                  error={!!formErrors.tenantId}
                  className="w-full"
                  testId="patient-form-tenant"
                />
                {formErrors.tenantId && (
                  <p
                    data-testid="error-tenant"
                    className="text-xs text-red-600 dark:text-red-400"
                  >
                    {formErrors.tenantId}
                  </p>
                )}
              </div>
            )}
            <label htmlFor="patient-address" className="sr-only">
              {t("common.address")}
            </label>
            <input
              id="patient-address"
              placeholder={t("common.address")}
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              className="col-span-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
          {/* Pearl §2.1.1 (gap row 40) — optional ABHA-link CTA. Collapsed
              by default so it does not slow the happy-path register flow.
              Expanding shows an ABHA address input; on submit, a sidecar
              POST /abdm/abha/link runs AFTER the patient create succeeds. */}
          <div className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-700">
            <button
              type="button"
              data-testid="patient-abha-toggle"
              aria-expanded={abhaExpanded}
              aria-controls="patient-abha-section"
              onClick={() => setAbhaExpanded((v) => !v)}
              className="flex items-center gap-2 text-sm font-medium text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-200"
            >
              <KeyRound size={14} aria-hidden="true" />
              {abhaExpanded ? "Hide" : "Link ABHA (optional)"}
            </button>
            {abhaExpanded && (
              <div
                id="patient-abha-section"
                data-testid="patient-abha-section"
                className="mt-3 rounded-lg border border-indigo-100 bg-indigo-50/40 p-3 dark:border-indigo-900 dark:bg-indigo-950/20"
              >
                <label
                  htmlFor="patient-abha-address"
                  className="block text-xs font-medium text-gray-700 dark:text-gray-300"
                >
                  ABHA Health ID address
                </label>
                <input
                  id="patient-abha-address"
                  data-testid="patient-abha-address"
                  type="text"
                  value={abhaAddress}
                  onChange={(e) => setAbhaAddress(e.target.value)}
                  placeholder="username@abdm"
                  className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
                <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                  Optional. Submitting the form will create the patient AND
                  initiate the ABHA link request. Don&apos;t have an ABHA?{" "}
                  <a
                    href="https://abha.abdm.gov.in"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-indigo-600 underline hover:text-indigo-800 dark:text-indigo-400"
                  >
                    Create one at abha.abdm.gov.in
                  </a>
                  . Full OTP verification can be completed later from{" "}
                  <Link
                    href="/dashboard/abdm"
                    className="text-indigo-600 underline hover:text-indigo-800 dark:text-indigo-400"
                  >
                    /dashboard/abdm
                  </Link>
                  .
                </p>
              </div>
            )}
          </div>
          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              className="min-h-[44px] rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
            >
              {t("dashboard.patients.register")}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="min-h-[44px] rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              {t("common.cancel")}
            </button>
          </div>
        </form>
      )}

      {/* Search + (super-admin only) tenant filter */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            size={16}
            aria-hidden="true"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 dark:text-gray-400"
          />
          <label htmlFor="patient-search" className="sr-only">
            {t("common.search")}
          </label>
          <input
            id="patient-search"
            data-testid="patient-search"
            placeholder={t("dashboard.patients.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-gray-200 bg-white py-2.5 pl-10 pr-4 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          />
        </div>
        {isSuperAdmin && (
          <TenantSelect
            tenants={tenants}
            value={selectedTenantId}
            onChange={setSelectedTenantId}
            allLabel="All tenants"
            className="w-full sm:w-64"
            testId="patient-tenant-filter"
          />
        )}
      </div>

      <DataTable<PatientRecord>
        data={patients}
        columns={columns}
        keyField="id"
        loading={loading}
        defaultSort={{ key: "name", dir: "asc" }}
        urlState
        csvName="patients"
        empty={{
          icon: <Users size={28} />,
          title: search ? "No patients found" : "No patients yet",
          description: search
            ? "Try a different search term."
            : "Register your first patient to get started.",
          action:
            !search && (user?.role === "RECEPTION" || user?.role === "ADMIN")
              ? {
                  label: "Register your first patient",
                  onClick: () => setShowForm(true),
                }
              : undefined,
        }}
      />

      {/* Pearl §5.3 / gap row 149 — Recover Phone modal. Open only when
          recoverPhoneFor is set (i.e. a row's Recover-Phone CTA was
          clicked) AND the caller is RECEPTION/ADMIN (the trigger button
          is itself role-gated; the modal markup guards in depth). */}
      {recoverPhoneFor &&
        (user?.role === "RECEPTION" || user?.role === "ADMIN") && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="recover-phone-title"
            data-testid="recover-phone-modal"
          >
            <form
              onSubmit={handleRecoverPhone}
              className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800"
              noValidate
            >
              <h2
                id="recover-phone-title"
                className="mb-1 text-lg font-semibold text-gray-900 dark:text-gray-100"
              >
                Recover Phone
              </h2>
              <p className="mb-4 text-xs text-gray-600 dark:text-gray-400">
                For{" "}
                <span className="font-medium">
                  {recoverPhoneFor.user?.name ?? "patient"}
                </span>{" "}
                ({recoverPhoneFor.mrNumber}). Verify the patient&apos;s identity
                in person, then enter the new phone number.
              </p>

              <div className="mb-3">
                <label
                  htmlFor="recover-new-phone"
                  className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-200"
                >
                  New phone number
                </label>
                <input
                  id="recover-new-phone"
                  data-testid="recover-phone-new-phone"
                  value={recoverForm.newPhone}
                  onChange={(e) =>
                    setRecoverForm({ ...recoverForm, newPhone: e.target.value })
                  }
                  placeholder="10-digit phone (e.g. 9876543210)"
                  className={
                    "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                    (recoverErrors.newPhone
                      ? "border-red-500"
                      : "border-gray-200 dark:border-gray-600")
                  }
                />
                {recoverErrors.newPhone && (
                  <p
                    data-testid="recover-phone-error-newPhone"
                    className="mt-1 text-xs text-red-600"
                  >
                    {recoverErrors.newPhone}
                  </p>
                )}
              </div>

              <div className="mb-3">
                <label
                  htmlFor="recover-method"
                  className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-200"
                >
                  Identity verification method
                </label>
                <select
                  id="recover-method"
                  data-testid="recover-phone-method"
                  value={recoverForm.method}
                  onChange={(e) =>
                    setRecoverForm({
                      ...recoverForm,
                      method: e.target.value as typeof recoverForm.method,
                    })
                  }
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                >
                  <option value="AADHAAR">Aadhaar</option>
                  <option value="PAN">PAN</option>
                  <option value="VOTER_ID">Voter ID</option>
                  <option value="DRIVING_LICENSE">Driving Licence</option>
                  <option value="PHOTO_MATCH">
                    Photo match (chart photo)
                  </option>
                </select>
              </div>

              <div className="mb-4">
                <label
                  htmlFor="recover-note"
                  className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-200"
                >
                  Verification note (10–500 chars)
                </label>
                <textarea
                  id="recover-note"
                  data-testid="recover-phone-note"
                  value={recoverForm.note}
                  onChange={(e) =>
                    setRecoverForm({ ...recoverForm, note: e.target.value })
                  }
                  rows={3}
                  placeholder='e.g. "Aadhaar last 4: 1234, DOB matches chart, photo verified"'
                  className={
                    "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                    (recoverErrors.note
                      ? "border-red-500"
                      : "border-gray-200 dark:border-gray-600")
                  }
                />
                {recoverErrors.note && (
                  <p
                    data-testid="recover-phone-error-note"
                    className="mt-1 text-xs text-red-600"
                  >
                    {recoverErrors.note}
                  </p>
                )}
              </div>

              {recoverErrors._ && (
                <p
                  data-testid="recover-phone-error-general"
                  className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-900/30 dark:text-red-200"
                >
                  {recoverErrors._}
                </p>
              )}

              <div className="flex gap-2">
                <button
                  type="submit"
                  data-testid="recover-phone-submit"
                  disabled={recoverSubmitting}
                  className="min-h-[44px] flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
                >
                  {recoverSubmitting ? "Saving…" : "Confirm recovery"}
                </button>
                <button
                  type="button"
                  data-testid="recover-phone-cancel"
                  onClick={closeRecoverModal}
                  className="min-h-[44px] rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}
    </div>
  );
}
