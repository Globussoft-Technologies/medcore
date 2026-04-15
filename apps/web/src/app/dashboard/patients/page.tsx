"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { Search, Plus, Users } from "lucide-react";
import { DataTable, Column } from "@/components/DataTable";

interface PatientRecord {
  id: string;
  mrNumber: string;
  gender: string;
  age: number | null;
  bloodGroup: string | null;
  user: { id: string; name: string; email: string; phone: string };
  // Flattened fields for sort/filter/CSV:
  name?: string;
  phone?: string;
}

export default function PatientsPage() {
  const { user } = useAuthStore();
  const { t } = useTranslation();
  const [patients, setPatients] = useState<PatientRecord[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
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

  async function handleCreatePatient(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = "Full name is required";
    const phoneDigits = form.phone.replace(/\D/g, "");
    if (!form.phone.trim()) errs.phone = "Phone number is required";
    else if (phoneDigits.length < 10 || phoneDigits.length > 13)
      errs.phone = "Enter a valid phone number (10 digits)";
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email))
      errs.email = "Enter a valid email address";
    if (form.age) {
      const ageNum = parseInt(form.age, 10);
      if (Number.isNaN(ageNum) || ageNum < 0 || ageNum > 130)
        errs.age = "Age must be between 0 and 130";
    }
    if (form.address) {
      const pinMatch = form.address.match(/\b(\d{6})\b/);
      if (form.address.match(/\bpin[: ]/i) && !pinMatch)
        errs.address = "PIN code must be 6 digits";
    }
    setFormErrors(errs);
    if (Object.keys(errs).length > 0) return;
    try {
      await api.post("/patients", {
        ...form,
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
      alert(err instanceof Error ? err.message : "Failed to register patient");
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
    { key: "age", label: t("dashboard.patients.col.age"), sortable: true, hideMobile: true },
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
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className={
                  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                  (formErrors.name ? "border-red-500" : "border-gray-200 dark:border-gray-600")
                }
              />
              {formErrors.name && (
                <p className="mt-1 text-xs text-red-600">{formErrors.name}</p>
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
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className={
                  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                  (formErrors.phone ? "border-red-500" : "border-gray-200 dark:border-gray-600")
                }
              />
              {formErrors.phone && (
                <p className="mt-1 text-xs text-red-600">{formErrors.phone}</p>
              )}
            </div>
            <div>
              <label htmlFor="patient-email" className="sr-only">
                {t("common.email")}
              </label>
              <input
                id="patient-email"
                placeholder="Email (optional)"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className={
                  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                  (formErrors.email ? "border-red-500" : "border-gray-200 dark:border-gray-600")
                }
              />
              {formErrors.email && (
                <p className="mt-1 text-xs text-red-600">{formErrors.email}</p>
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
                value={form.age}
                onChange={(e) => setForm({ ...form, age: e.target.value })}
                className={
                  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:bg-gray-900 dark:text-gray-100 " +
                  (formErrors.age ? "border-red-500" : "border-gray-200 dark:border-gray-600")
                }
              />
              {formErrors.age && (
                <p className="mt-1 text-xs text-red-600">{formErrors.age}</p>
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
