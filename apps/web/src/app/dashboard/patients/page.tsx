"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { formatPatientAge } from "@/lib/format";
import { Search, Plus, Users, MessageCircle, Phone, Mail, UserPlus } from "lucide-react";
import { DataTable, Column } from "@/components/DataTable";
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
  user: { id: string; name: string; email: string; phone: string };
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
    // Pearl §2.1.1 — attribution tag. Default WALK_IN: the staff form is
    // most often used to capture an in-person walk-in registration. The
    // API treats an omitted source as "WEB" (staff web-panel keying),
    // but the form sends an explicit value so the recorded source
    // matches the receptionist's intent.
    source: "WALK_IN",
  });
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
  }, [debouncedSearch]);

  async function loadPatients() {
    setLoading(true);
    try {
      const q = debouncedSearch
        ? `&search=${encodeURIComponent(debouncedSearch)}`
        : "";
      const res = await api.get<{ data: PatientRecord[]; meta: { total: number } }>(
        `/patients?limit=50${q}`
      );
      const flat = (res.data || []).map((p) => ({
        ...p,
        name: p.user?.name,
        phone: p.user?.phone,
      }));
      setPatients(flat);
      setTotal(res.meta?.total ?? 0);
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
    setFormErrors(errs);
    setDuplicateMatch(null);
    if (Object.keys(errs).length > 0) return;
    try {
      await api.post("/patients", {
        ...form,
        name: trimmedName,
        phone: trimmedPhone,
        age: form.age ? parseInt(form.age) : undefined,
        bloodGroup: form.bloodGroup || undefined,
      });
      setShowForm(false);
      setForm({
        name: "",
        phone: "",
        email: "",
        age: "",
        gender: "MALE",
        address: "",
        bloodGroup: "",
        source: "WALK_IN",
      });
      loadPatients();
    } catch (err) {
      // Issue #103: 409 carries `existingPatient` so reception can pull up
      // the existing chart in one click. Otherwise fall through to the
      // generic field-error or toast path.
      const payload = (err as { payload?: { existingPatient?: { id: string; mrNumber: string; name: string | null } } })
        .payload;
      if (payload?.existingPatient) {
        setDuplicateMatch(payload.existingPatient);
        setFormErrors((p) => ({
          ...p,
          phone: `Already registered as ${payload.existingPatient!.name ?? "patient"} (MR: ${payload.existingPatient!.mrNumber}).`,
        }));
        toast.error(
          `Patient with this phone already exists (MR: ${payload.existingPatient.mrNumber}).`,
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
          className="font-mono font-medium text-primary hover:underline"
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
      render: (p) => <span className="font-medium">{p.user?.name}</span>,
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
      label: t("dashboard.patients.col.quickActions") || "Actions",
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
          {p.user?.email && (
            <a
              href={`mailto:${p.user.email}`}
              aria-label={`Email ${p.user.name}`}
              title="Email"
              data-testid={`quickaction-email-${p.id}`}
              className="rounded p-1.5 text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/30"
            >
              <Mail size={16} aria-hidden="true" />
            </a>
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

      {/* Search */}
      <div className="relative mb-4">
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
    </div>
  );
}
