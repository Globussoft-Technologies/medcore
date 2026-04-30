"use client";

// Issue #168 (Apr 30 2026): the admin Doctors page previously rendered a
// raw card grid with zero controls — no search, no specialization filter,
// no "+ Add Doctor" button, and no pagination. We rebuild it on the
// shared DataTable so admins get the same toolbar UX as the Patients
// registry, plus a modal-driven create flow.
//
// Backend gaps (auditied, NOT modified — out of scope per the issue):
//   • GET /api/v1/doctors does NOT support `?search=` / `?specialization=`
//     so we filter the full list client-side. The dataset is small
//     (one row per doctor) so this is fine for the foreseeable future.
//   • POST /api/v1/doctors does NOT exist. New doctors are created via
//     POST /api/v1/auth/register with role=DOCTOR — that endpoint
//     auto-creates the Doctor row with default specialization/qualification
//     (see auth.ts comment ref Issue #205). Once saved, we PATCH the
//     Doctor record with the admin-supplied specialization / qualification
//     / registrationNumber via the /doctors/:id endpoint if available;
//     otherwise the row stays at the registration defaults and the admin
//     edits from the Doctor profile.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { Search, Plus, Stethoscope, X } from "lucide-react";
import { DataTable, Column } from "@/components/DataTable";
import { EntityPicker } from "@/components/EntityPicker";
import { extractFieldErrors } from "@/lib/field-errors";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Static fallback list of specialties so the dropdown is populated on first
// load (before any doctor exists). The live list shown to the admin is the
// union of these + every distinct specialization seen in the fetched data.
const STATIC_SPECIALIZATIONS = [
  "General Medicine",
  "Cardiology",
  "Dermatology",
  "Endocrinology",
  "ENT",
  "Gastroenterology",
  "Gynecology",
  "Neurology",
  "Oncology",
  "Ophthalmology",
  "Orthopedics",
  "Pediatrics",
  "Psychiatry",
  "Pulmonology",
  "Radiology",
  "Urology",
];

// Issue #168: doctors registry is admin-only (managing the medical staff
// roster is an HR/clinical-admin concern). DOCTOR/NURSE/RECEPTION can see
// the doctor list elsewhere (queue, calendar, AI booking) where the data
// is scoped to the day's roster.
const DOCTORS_ALLOWED = new Set(["ADMIN"]);

interface DoctorRecord {
  id: string;
  specialization: string;
  qualification: string;
  registrationNumber?: string | null;
  user: {
    id: string;
    name: string;
    email: string;
    phone: string;
    isActive: boolean;
  };
  schedules: Array<{
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    slotDurationMinutes: number;
  }>;
  // Flattened for sort/filter/CSV.
  name?: string;
  email?: string;
  phone?: string;
}

export default function DoctorsPage() {
  const { user, isLoading: authLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const [doctors, setDoctors] = useState<DoctorRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [specFilter, setSpecFilter] = useState("");
  const [showForm, setShowForm] = useState(false);

  // RBAC: redirect non-admins to the chrome-wrapped not-authorized page,
  // matching the PATIENTS_ALLOWED pattern in patients/page.tsx.
  useEffect(() => {
    if (!authLoading && user && !DOCTORS_ALLOWED.has(user.role)) {
      toast.error("Doctor registry is admin-only.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/doctors")}`
      );
    }
  }, [authLoading, user, router, pathname]);

  // Debounce the search input — 300ms — so a flurry of keystrokes only
  // triggers a single (currently client-side) filter pass. When the
  // backend grows ?search= support this debounce will gate the API call.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (authLoading || !user || !DOCTORS_ALLOWED.has(user.role)) return;
    loadDoctors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user]);

  async function loadDoctors() {
    setLoading(true);
    try {
      // We pass `search` even though the current backend ignores it —
      // when the API grows support, no frontend change is required.
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (specFilter) params.set("specialization", specFilter);
      const qs = params.toString();
      const res = await api.get<{ data: DoctorRecord[] }>(
        `/doctors${qs ? `?${qs}` : ""}`
      );
      const flat = (res.data || []).map((d) => ({
        ...d,
        name: d.user?.name,
        email: d.user?.email,
        phone: d.user?.phone,
      }));
      setDoctors(flat);
    } catch {
      // empty
    }
    setLoading(false);
  }

  // ─── Derived data ──────────────────────────────────────────────────────
  // Distinct specializations from the live data set, unioned with the
  // static fallback so the dropdown is never empty.
  const specializationOptions = useMemo(() => {
    const set = new Set<string>(STATIC_SPECIALIZATIONS);
    for (const d of doctors) if (d.specialization) set.add(d.specialization);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [doctors]);

  // Client-side filter (backend ignores ?search/?specialization today).
  const filteredDoctors = useMemo(() => {
    let rows = doctors;
    if (specFilter) {
      rows = rows.filter((d) => d.specialization === specFilter);
    }
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      rows = rows.filter((d) => {
        return (
          (d.user?.name || "").toLowerCase().includes(q) ||
          (d.user?.email || "").toLowerCase().includes(q) ||
          (d.user?.phone || "").toLowerCase().includes(q) ||
          (d.specialization || "").toLowerCase().includes(q) ||
          (d.qualification || "").toLowerCase().includes(q)
        );
      });
    }
    return rows;
  }, [doctors, debouncedSearch, specFilter]);

  // ─── Add-Doctor modal ─────────────────────────────────────────────────
  const [createMode, setCreateMode] = useState<"new" | "existing">("new");
  const [form, setForm] = useState({
    // create-new-user fields
    name: "",
    email: "",
    phone: "",
    password: "",
    // existing-user picker
    userId: "",
    // doctor-specific
    specialization: "General Medicine",
    qualification: "",
    registrationNumber: "",
  });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  function resetForm() {
    setForm({
      name: "",
      email: "",
      phone: "",
      password: "",
      userId: "",
      specialization: "General Medicine",
      qualification: "",
      registrationNumber: "",
    });
    setFormErrors({});
    setCreateMode("new");
  }

  async function handleCreateDoctor(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};

    if (createMode === "new") {
      const trimmedName = form.name.trim();
      if (!trimmedName) errs.name = "Full name is required";
      else if (!/^[A-Za-zऀ-ॿ\s.\-']{1,100}$/.test(trimmedName))
        errs.name =
          "Name may only contain letters, spaces, dots, hyphens and apostrophes";
      const trimmedPhone = form.phone.trim();
      if (!trimmedPhone) errs.phone = "Phone number is required";
      else if (!/^\+?\d{10,15}$/.test(trimmedPhone))
        errs.phone = "Phone must be 10–15 digits, optional leading +";
      if (!form.email.trim()) errs.email = "Email is required";
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email))
        errs.email = "Enter a valid email address";
      if (!form.password) errs.password = "Password is required";
      else if (form.password.length < 8)
        errs.password = "Password must be at least 8 characters";
      else if (!/[A-Za-z]/.test(form.password) || !/\d/.test(form.password))
        errs.password = "Password must contain a letter and a digit";
    } else {
      if (!form.userId) errs.userId = "Pick an existing user to elevate";
    }

    if (!form.specialization) errs.specialization = "Specialization is required";
    if (!form.qualification.trim())
      errs.qualification = "Qualification is required";

    setFormErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSubmitting(true);
    try {
      if (createMode === "new") {
        // POST /auth/register with role=DOCTOR auto-creates the Doctor
        // row server-side (auth.ts ref Issue #205). We then PATCH the
        // Doctor record with the admin-supplied specialization /
        // qualification / registrationNumber. If the PATCH endpoint
        // doesn't exist yet (current backend gap), the row is still
        // created with the registration defaults and the admin can edit
        // from the Doctor profile.
        await api.post("/auth/register", {
          name: form.name.trim(),
          email: form.email.trim(),
          phone: form.phone.trim(),
          password: form.password,
          role: "DOCTOR",
        });
        // Best-effort: refresh and try to patch the just-created Doctor
        // with the admin's specialization / qualification.
        try {
          const refreshed = await api.get<{ data: DoctorRecord[] }>("/doctors");
          const created = (refreshed.data || []).find(
            (d) => d.user?.email === form.email.trim()
          );
          if (created) {
            await api
              .patch(`/doctors/${created.id}`, {
                specialization: form.specialization,
                qualification: form.qualification.trim(),
                registrationNumber: form.registrationNumber.trim() || undefined,
              })
              .catch(() => {
                // PATCH /doctors/:id is not implemented yet — the row
                // still exists with default specialization / qualification.
              });
          }
        } catch {
          // tolerate refresh failure
        }
        toast.success("Doctor added.");
      } else {
        // Elevate an existing user. PATCH /users/:id only flips the
        // User.role — the Doctor row is NOT auto-created (see API
        // gap note at top of file). Surface that loudly via toast so
        // the admin knows a follow-up is needed.
        await api.patch(`/users/${form.userId}`, { role: "DOCTOR" });
        toast.success(
          "User elevated to DOCTOR. Edit profile to set specialization."
        );
      }
      setShowForm(false);
      resetForm();
      loadDoctors();
    } catch (err) {
      const fields = extractFieldErrors(err);
      if (fields) {
        setFormErrors((p) => ({ ...p, ...fields }));
        toast.error(Object.values(fields)[0] || "Failed to add doctor");
      } else {
        toast.error(err instanceof Error ? err.message : "Failed to add doctor");
      }
    } finally {
      setSubmitting(false);
    }
  }

  // ─── DataTable columns ────────────────────────────────────────────────
  const columns: Column<DoctorRecord>[] = [
    {
      key: "name",
      label: "Name",
      sortable: true,
      filterable: true,
      render: (d) => (
        // Issue #213-B: cards on this page were not clickable because the
        // /dashboard/doctors/[id] route did not exist. We keep the Link
        // wrapper here (unchanged) and now ship a minimal read-only detail
        // page so navigation actually resolves. `doctor-card-{id}` is the
        // E2E hook the smoke test uses to assert clickability.
        <Link
          href={`/dashboard/doctors/${d.id}`}
          className="font-medium text-primary hover:underline"
          onClick={(e) => e.stopPropagation()}
          data-testid={`doctor-card-${d.id}`}
        >
          {d.user?.name || "—"}
        </Link>
      ),
    },
    {
      key: "specialization",
      label: "Specialization",
      sortable: true,
      filterable: true,
    },
    {
      key: "qualification",
      label: "Qualification",
      sortable: true,
      filterable: true,
      hideMobile: true,
      render: (d) => d.qualification || "—",
    },
    {
      key: "email",
      label: "Email",
      sortable: true,
      filterable: true,
      hideMobile: true,
      render: (d) => d.user?.email || "—",
    },
    {
      key: "phone",
      label: "Phone",
      sortable: true,
      filterable: true,
      hideMobile: true,
      render: (d) => d.user?.phone || "—",
    },
    {
      key: "schedules",
      label: "Schedule",
      hideMobile: true,
      render: (d) => {
        if (!d.schedules || d.schedules.length === 0) {
          return <span className="text-xs text-gray-400">Not configured</span>;
        }
        const days = Array.from(new Set(d.schedules.map((s) => DAYS[s.dayOfWeek]))).join(", ");
        return <span className="text-xs">{days}</span>;
      },
    },
    {
      key: "isActive",
      label: "Status",
      sortable: true,
      hideMobile: true,
      render: (d) => (
        <span
          className={
            d.user?.isActive ? "text-green-600" : "text-red-600"
          }
        >
          {d.user?.isActive ? "Active" : "Inactive"}
        </span>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Doctors
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {filteredDoctors.length} doctor{filteredDoctors.length === 1 ? "" : "s"}
            {(debouncedSearch || specFilter) && doctors.length !== filteredDoctors.length
              ? ` (filtered from ${doctors.length})`
              : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            resetForm();
            setShowForm(true);
          }}
          data-testid="doctor-add-button"
          aria-label="Add Doctor"
          className="flex min-h-[44px] items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
        >
          <Plus size={16} aria-hidden="true" /> Add Doctor
        </button>
      </div>

      {/* Filter + search row */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            size={16}
            aria-hidden="true"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600"
          />
          <label htmlFor="doctor-search" className="sr-only">
            Search doctors
          </label>
          <input
            id="doctor-search"
            data-testid="doctor-search-input"
            placeholder="Search by name, email, phone, specialization..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-gray-200 bg-white py-2.5 pl-10 pr-4 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          />
        </div>
        <div>
          <label htmlFor="doctor-spec-filter" className="sr-only">
            Filter by specialization
          </label>
          <select
            id="doctor-spec-filter"
            data-testid="doctor-spec-filter"
            value={specFilter}
            onChange={(e) => setSpecFilter(e.target.value)}
            className="min-h-[40px] rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          >
            <option value="">All specializations</option>
            {specializationOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      <DataTable<DoctorRecord>
        data={filteredDoctors}
        columns={columns}
        keyField="id"
        loading={loading}
        defaultSort={{ key: "name", dir: "asc" }}
        urlState
        csvName="doctors"
        empty={{
          icon: <Stethoscope size={28} />,
          title:
            debouncedSearch || specFilter
              ? "No doctors match your filters"
              : "No doctors yet",
          description:
            debouncedSearch || specFilter
              ? "Try a different search term or clear the specialization filter."
              : "Add your first doctor to get started.",
          action:
            !debouncedSearch && !specFilter
              ? {
                  label: "Add your first doctor",
                  onClick: () => {
                    resetForm();
                    setShowForm(true);
                  },
                }
              : undefined,
        }}
      />

      {/* Add-Doctor modal — in-DOM (NEVER native dialog). */}
      {showForm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="doctor-add-modal-title"
          data-testid="doctor-add-modal"
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800">
            <div className="mb-4 flex items-center justify-between">
              <h2
                id="doctor-add-modal-title"
                className="text-lg font-semibold text-gray-900 dark:text-gray-100"
              >
                Add Doctor
              </h2>
              <button
                type="button"
                onClick={() => {
                  setShowForm(false);
                  resetForm();
                }}
                aria-label="Close"
                data-testid="doctor-add-cancel"
                className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <X size={18} />
              </button>
            </div>

            {/* Mode toggle: create new user vs elevate existing */}
            <div className="mb-4 flex gap-2 rounded-lg bg-gray-100 p-1 dark:bg-gray-700">
              <button
                type="button"
                onClick={() => setCreateMode("new")}
                data-testid="doctor-mode-new"
                className={
                  "flex-1 rounded-md px-3 py-1.5 text-sm font-medium " +
                  (createMode === "new"
                    ? "bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100"
                    : "text-gray-600 dark:text-gray-300")
                }
              >
                Create new user
              </button>
              <button
                type="button"
                onClick={() => setCreateMode("existing")}
                data-testid="doctor-mode-existing"
                className={
                  "flex-1 rounded-md px-3 py-1.5 text-sm font-medium " +
                  (createMode === "existing"
                    ? "bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100"
                    : "text-gray-600 dark:text-gray-300")
                }
              >
                Elevate existing user
              </button>
            </div>

            <form onSubmit={handleCreateDoctor} className="space-y-3">
              {createMode === "new" ? (
                <>
                  <div>
                    <label
                      htmlFor="doctor-form-name"
                      className="block text-xs font-medium text-gray-700 dark:text-gray-300"
                    >
                      Full Name
                    </label>
                    <input
                      id="doctor-form-name"
                      data-testid="doctor-form-name"
                      value={form.name}
                      onChange={(e) =>
                        setForm({ ...form, name: e.target.value })
                      }
                      className={
                        "mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                        (formErrors.name
                          ? "border-red-500"
                          : "border-gray-200 dark:border-gray-600")
                      }
                    />
                    {formErrors.name && (
                      <p className="mt-1 text-xs text-red-600">
                        {formErrors.name}
                      </p>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label
                        htmlFor="doctor-form-email"
                        className="block text-xs font-medium text-gray-700 dark:text-gray-300"
                      >
                        Email
                      </label>
                      <input
                        id="doctor-form-email"
                        type="email"
                        data-testid="doctor-form-email"
                        value={form.email}
                        onChange={(e) =>
                          setForm({ ...form, email: e.target.value })
                        }
                        className={
                          "mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                          (formErrors.email
                            ? "border-red-500"
                            : "border-gray-200 dark:border-gray-600")
                        }
                      />
                      {formErrors.email && (
                        <p className="mt-1 text-xs text-red-600">
                          {formErrors.email}
                        </p>
                      )}
                    </div>
                    <div>
                      <label
                        htmlFor="doctor-form-phone"
                        className="block text-xs font-medium text-gray-700 dark:text-gray-300"
                      >
                        Phone
                      </label>
                      <input
                        id="doctor-form-phone"
                        data-testid="doctor-form-phone"
                        value={form.phone}
                        onChange={(e) =>
                          setForm({ ...form, phone: e.target.value })
                        }
                        className={
                          "mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                          (formErrors.phone
                            ? "border-red-500"
                            : "border-gray-200 dark:border-gray-600")
                        }
                      />
                      {formErrors.phone && (
                        <p className="mt-1 text-xs text-red-600">
                          {formErrors.phone}
                        </p>
                      )}
                    </div>
                  </div>
                  <div>
                    <label
                      htmlFor="doctor-form-password"
                      className="block text-xs font-medium text-gray-700 dark:text-gray-300"
                    >
                      Initial Password
                    </label>
                    <input
                      id="doctor-form-password"
                      type="password"
                      data-testid="doctor-form-password"
                      value={form.password}
                      onChange={(e) =>
                        setForm({ ...form, password: e.target.value })
                      }
                      className={
                        "mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                        (formErrors.password
                          ? "border-red-500"
                          : "border-gray-200 dark:border-gray-600")
                      }
                    />
                    {formErrors.password && (
                      <p className="mt-1 text-xs text-red-600">
                        {formErrors.password}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                    Pick an existing user to elevate to DOCTOR
                  </label>
                  <div className="mt-1">
                    <EntityPicker
                      endpoint="/chat/users"
                      labelField="name"
                      subtitleField="role"
                      hintField="email"
                      value={form.userId}
                      onChange={(id) => setForm({ ...form, userId: id })}
                      searchPlaceholder="Search by name, email..."
                      testIdPrefix="doctor-user-picker"
                      required
                    />
                  </div>
                  {formErrors.userId && (
                    <p className="mt-1 text-xs text-red-600">
                      {formErrors.userId}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-gray-500">
                    Note: elevating an existing user only flips their role.
                    The Doctor profile (specialization, qualification) is
                    edited from the doctor profile page after save.
                  </p>
                </div>
              )}

              <div>
                <label
                  htmlFor="doctor-form-spec"
                  className="block text-xs font-medium text-gray-700 dark:text-gray-300"
                >
                  Specialization
                </label>
                <select
                  id="doctor-form-spec"
                  data-testid="doctor-form-spec"
                  value={form.specialization}
                  onChange={(e) =>
                    setForm({ ...form, specialization: e.target.value })
                  }
                  className={
                    "mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                    (formErrors.specialization
                      ? "border-red-500"
                      : "border-gray-200 dark:border-gray-600")
                  }
                >
                  {specializationOptions.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                {formErrors.specialization && (
                  <p className="mt-1 text-xs text-red-600">
                    {formErrors.specialization}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="doctor-form-qual"
                  className="block text-xs font-medium text-gray-700 dark:text-gray-300"
                >
                  Qualification (e.g. MBBS, MD)
                </label>
                <input
                  id="doctor-form-qual"
                  data-testid="doctor-form-qual"
                  value={form.qualification}
                  onChange={(e) =>
                    setForm({ ...form, qualification: e.target.value })
                  }
                  className={
                    "mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                    (formErrors.qualification
                      ? "border-red-500"
                      : "border-gray-200 dark:border-gray-600")
                  }
                />
                {formErrors.qualification && (
                  <p className="mt-1 text-xs text-red-600">
                    {formErrors.qualification}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="doctor-form-reg"
                  className="block text-xs font-medium text-gray-700 dark:text-gray-300"
                >
                  Registration Number (optional)
                </label>
                <input
                  id="doctor-form-reg"
                  data-testid="doctor-form-reg"
                  value={form.registrationNumber}
                  onChange={(e) =>
                    setForm({ ...form, registrationNumber: e.target.value })
                  }
                  className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>

              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowForm(false);
                    resetForm();
                  }}
                  className="min-h-[40px] rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  data-testid="doctor-add-save"
                  className="min-h-[40px] rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
                >
                  {submitting ? "Saving..." : "Save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
