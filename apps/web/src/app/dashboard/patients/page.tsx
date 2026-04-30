"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { formatPatientAge } from "@/lib/format";
import { Search, Plus, Users } from "lucide-react";
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
const PATIENTS_ALLOWED = new Set([
  "ADMIN",
  "RECEPTION",
  "DOCTOR",
  "NURSE",
]);

interface PatientRecord {
  id: string;
  mrNumber: string;
  gender: string;
  age: number | null;
  dateOfBirth?: string | null;
  bloodGroup: string | null;
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
  const [loading, setLoading] = useState(true);

  // Issue #382: redirect non-staff (PATIENT, etc.) away before any data fetch.
  useEffect(() => {
    if (!authLoading && user && !PATIENTS_ALLOWED.has(user.role)) {
      // Issue #179: redirect to chrome-wrapped /dashboard/not-authorized so
      // the user keeps the sidebar and gets a real "Access Denied" page
      // instead of a generic 404.
      toast.error("Patient registry is staff-only.");
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
  });
  const [total, setTotal] = useState(0);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    loadPatients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function loadPatients() {
    setLoading(true);
    try {
      const q = search ? `&search=${encodeURIComponent(search)}` : "";
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
    if (form.age) {
      const ageNum = parseInt(form.age, 10);
      // Issue #167 (Apr 2026): adult registration form. age=0 was
      // silently accepted because reception's empty input coerced to 0;
      // newborns are registered with date-of-birth via the pediatric
      // flow, not this form. Reject < 1 explicitly.
      if (Number.isNaN(ageNum) || ageNum < 1 || ageNum > 130)
        errs.age = "Age must be between 1 and 130";
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
  ];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {t("dashboard.patients.title")}
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {total} {t("dashboard.patients.subtitle")}
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
          className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600"
        />
        <label htmlFor="patient-search" className="sr-only">
          {t("common.search")}
        </label>
        <input
          id="patient-search"
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
