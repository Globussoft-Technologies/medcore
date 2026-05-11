"use client";

// Issue #724 (2026-05-08): admin Insurance Providers (TPA partners)
// page. Lists onboarded providers + exposes an "Add Provider" dialog
// that POSTs /api/v1/insurance-providers (Zod-validated server-side
// via createInsuranceProviderSchema in @medcore/shared). The legacy
// curated `INDIAN_INSURERS` constant in packages/shared/constants.ts
// stays in place as the dropdown source for claims/preauth — this
// page lets admins onboard new partners without a code change.
//
// RBAC: ADMIN-only for create/edit; ADMIN + RECEPTION can list (the
// list backs the future provider-pickers in claims/preauth).

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { Plus, Shield, X, Loader2, Edit2 } from "lucide-react";

const INSURANCE_ALLOWED = new Set(["ADMIN", "RECEPTION"]);

interface ProviderRow {
  id: string;
  name: string;
  code: string;
  contactPerson: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  coverageDetails: string | null;
  isActive: boolean;
}

export default function InsuranceProvidersPage() {
  const { user, isLoading: authLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  // Issue #692 (BUG-A08, 2026-05-09): per-row Edit dialog. Stores the
  // provider being edited; null means the dialog is closed. The PATCH
  // endpoint already exists at /api/v1/insurance-providers/:id; this is
  // the missing FE affordance.
  const [editingProvider, setEditingProvider] = useState<ProviderRow | null>(
    null
  );

  useEffect(() => {
    if (!authLoading && user && !INSURANCE_ALLOWED.has(user.role)) {
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/insurance")}`
      );
    }
  }, [authLoading, user, router, pathname]);

  useEffect(() => {
    if (authLoading || !user || !INSURANCE_ALLOWED.has(user.role)) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user]);

  async function load() {
    setLoading(true);
    try {
      const res = await api.get<{ data: ProviderRow[] }>(
        "/insurance-providers"
      );
      setProviders(res.data || []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  if (authLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }
  if (user && !INSURANCE_ALLOWED.has(user.role)) return null;

  const canCreate = user?.role === "ADMIN";

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            Insurance Providers
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {providers.length} provider{providers.length === 1 ? "" : "s"} onboarded
          </p>
        </div>
        {canCreate && (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            data-testid="insurance-provider-add-button"
            aria-label="Add Provider"
            className="flex min-h-[44px] items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <Plus size={16} aria-hidden="true" /> Add Provider
          </button>
        )}
      </div>

      {loading ? (
        <div className="rounded-xl bg-white p-8 text-center text-gray-500 shadow-sm dark:bg-gray-800 dark:text-gray-400">
          Loading...
        </div>
      ) : providers.length === 0 ? (
        <div
          data-testid="insurance-providers-empty"
          className="rounded-xl border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500 dark:border-gray-700"
        >
          <Shield className="mx-auto mb-2 h-6 w-6 text-gray-400" />
          No insurance providers onboarded yet.
          {canCreate && (
            <p className="mt-2 text-xs text-gray-400">
              Click <strong>Add Provider</strong> to onboard your first TPA.
            </p>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl bg-white shadow-sm dark:bg-gray-800">
          <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300">
                  Name
                </th>
                <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300">
                  Code
                </th>
                <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300">
                  Contact
                </th>
                <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300">
                  Coverage
                </th>
                <th className="px-4 py-2 text-left font-medium text-gray-600 dark:text-gray-300">
                  Status
                </th>
                {canCreate && (
                  <th className="px-4 py-2 text-right font-medium text-gray-600 dark:text-gray-300">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {providers.map((p) => (
                <tr
                  key={p.id}
                  data-testid="insurance-provider-row"
                  data-entity-id={p.id}
                >
                  <td className="px-4 py-2 font-medium text-gray-900 dark:text-gray-100">
                    {p.name}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{p.code}</td>
                  <td className="px-4 py-2 text-xs text-gray-600 dark:text-gray-300">
                    {p.contactPerson && <div>{p.contactPerson}</div>}
                    {p.contactEmail && (
                      <div className="text-gray-500">{p.contactEmail}</div>
                    )}
                    {p.contactPhone && (
                      <div className="text-gray-500">{p.contactPhone}</div>
                    )}
                  </td>
                  <td
                    className="max-w-xs truncate px-4 py-2 text-xs text-gray-600 dark:text-gray-300"
                    title={p.coverageDetails ?? ""}
                  >
                    {p.coverageDetails || "—"}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={
                        p.isActive
                          ? "rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700"
                          : "rounded bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-600"
                      }
                    >
                      {p.isActive ? "Active" : "Inactive"}
                    </span>
                  </td>
                  {canCreate && (
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setEditingProvider(p)}
                        data-testid={`provider-edit-${p.id}`}
                        aria-label={`Edit ${p.name}`}
                        title={`Edit ${p.name}`}
                        className="rounded p-1 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                      >
                        <Edit2 size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <AddProviderModal
          onClose={() => setShowForm(false)}
          onCreated={() => {
            setShowForm(false);
            load();
          }}
        />
      )}

      {/* Issue #692: per-row Edit modal — re-uses the same field set
          as the Add dialog plus an isActive toggle. PATCHes back to
          /insurance-providers/:id. */}
      {editingProvider && (
        <EditProviderModal
          provider={editingProvider}
          onClose={() => setEditingProvider(null)}
          onSaved={() => {
            setEditingProvider(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function AddProviderModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    name: "",
    code: "",
    contactPerson: "",
    contactEmail: "",
    contactPhone: "",
    coverageDetails: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.name.trim() || form.name.trim().length < 2) {
      errs.name = "Provider name is required (min 2 chars)";
    }
    const code = form.code.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,30}$/.test(code)) {
      errs.code =
        "Code must be 2–31 chars, uppercase letters/digits/underscore, starting with a letter";
    }
    if (form.contactEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.contactEmail)) {
      errs.contactEmail = "Enter a valid email address";
    }
    if (
      form.contactPhone.trim() &&
      !/^\+?\d[\d\s\-]{6,29}$/.test(form.contactPhone.trim())
    ) {
      errs.contactPhone = "Enter a valid phone number";
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSubmitting(true);
    try {
      await api.post("/insurance-providers", {
        name: form.name.trim(),
        code,
        contactPerson: form.contactPerson.trim() || undefined,
        contactEmail: form.contactEmail.trim() || undefined,
        contactPhone: form.contactPhone.trim() || undefined,
        coverageDetails: form.coverageDetails.trim() || undefined,
      });
      toast.success("Provider onboarded.");
      onCreated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to add provider";
      if (/already exists/i.test(msg)) {
        setErrors({ code: "Provider code already exists" });
      } else {
        toast.error(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="insurance-provider-add-modal-title"
      data-testid="insurance-provider-add-modal"
    >
      <form
        onSubmit={submit}
        noValidate
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2
            id="insurance-provider-add-modal-title"
            className="text-lg font-semibold"
          >
            Add Insurance Provider
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-gray-500 hover:bg-gray-100"
          >
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label
              htmlFor="provider-name"
              className="block text-xs font-medium"
            >
              Name
            </label>
            <input
              id="provider-name"
              data-testid="provider-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${
                errors.name ? "border-red-500" : "border-gray-200"
              }`}
            />
            {errors.name && (
              <p className="mt-1 text-xs text-red-600">{errors.name}</p>
            )}
          </div>
          <div>
            <label
              htmlFor="provider-code"
              className="block text-xs font-medium"
            >
              Code (short identifier, e.g. STAR_HEALTH)
            </label>
            <input
              id="provider-code"
              data-testid="provider-code"
              value={form.code}
              onChange={(e) =>
                setForm({ ...form, code: e.target.value.toUpperCase() })
              }
              className={`mt-1 w-full rounded-lg border px-3 py-2 font-mono text-sm uppercase ${
                errors.code ? "border-red-500" : "border-gray-200"
              }`}
            />
            {errors.code && (
              <p className="mt-1 text-xs text-red-600">{errors.code}</p>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="provider-contact-person"
                className="block text-xs font-medium"
              >
                Contact Person (optional)
              </label>
              <input
                id="provider-contact-person"
                data-testid="provider-contact-person"
                value={form.contactPerson}
                onChange={(e) =>
                  setForm({ ...form, contactPerson: e.target.value })
                }
                className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label
                htmlFor="provider-contact-phone"
                className="block text-xs font-medium"
              >
                Phone (optional)
              </label>
              <input
                id="provider-contact-phone"
                data-testid="provider-contact-phone"
                value={form.contactPhone}
                onChange={(e) =>
                  setForm({ ...form, contactPhone: e.target.value })
                }
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${
                  errors.contactPhone ? "border-red-500" : "border-gray-200"
                }`}
              />
              {errors.contactPhone && (
                <p className="mt-1 text-xs text-red-600">
                  {errors.contactPhone}
                </p>
              )}
            </div>
          </div>
          <div>
            <label
              htmlFor="provider-contact-email"
              className="block text-xs font-medium"
            >
              Email (optional)
            </label>
            <input
              id="provider-contact-email"
              data-testid="provider-contact-email"
              type="email"
              value={form.contactEmail}
              onChange={(e) =>
                setForm({ ...form, contactEmail: e.target.value })
              }
              className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${
                errors.contactEmail ? "border-red-500" : "border-gray-200"
              }`}
            />
            {errors.contactEmail && (
              <p className="mt-1 text-xs text-red-600">{errors.contactEmail}</p>
            )}
          </div>
          <div>
            <label
              htmlFor="provider-coverage"
              className="block text-xs font-medium"
            >
              Coverage Details (optional)
            </label>
            <textarea
              id="provider-coverage"
              data-testid="provider-coverage"
              value={form.coverageDetails}
              onChange={(e) =>
                setForm({ ...form, coverageDetails: e.target.value })
              }
              rows={3}
              placeholder="e.g. Cashless across 10000+ network hospitals; copay 10%; pre-auth required for IPD."
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            data-testid="provider-save"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

// Issue #692 (BUG-A08): per-row Edit dialog. Same field set as the
// Add dialog plus an isActive toggle (only Edit can deactivate a
// provider — the Add dialog implicitly creates active rows). Submits
// PATCH /api/v1/insurance-providers/:id which already exists and is
// ADMIN-gated.
function EditProviderModal({
  provider,
  onClose,
  onSaved,
}: {
  provider: ProviderRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: provider.name,
    code: provider.code,
    contactPerson: provider.contactPerson || "",
    contactEmail: provider.contactEmail || "",
    contactPhone: provider.contactPhone || "",
    coverageDetails: provider.coverageDetails || "",
    isActive: provider.isActive,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.name.trim() || form.name.trim().length < 2) {
      errs.name = "Provider name is required (min 2 chars)";
    }
    const code = form.code.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,30}$/.test(code)) {
      errs.code =
        "Code must be 2–31 chars, uppercase letters/digits/underscore, starting with a letter";
    }
    if (
      form.contactEmail.trim() &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.contactEmail)
    ) {
      errs.contactEmail = "Enter a valid email address";
    }
    if (
      form.contactPhone.trim() &&
      !/^\+?\d[\d\s\-]{6,29}$/.test(form.contactPhone.trim())
    ) {
      errs.contactPhone = "Enter a valid phone number";
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSubmitting(true);
    try {
      await api.patch(`/insurance-providers/${provider.id}`, {
        name: form.name.trim(),
        code,
        contactPerson: form.contactPerson.trim() || undefined,
        contactEmail: form.contactEmail.trim() || undefined,
        contactPhone: form.contactPhone.trim() || undefined,
        coverageDetails: form.coverageDetails.trim() || undefined,
        isActive: form.isActive,
      });
      toast.success("Provider updated.");
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update";
      if (/already exists/i.test(msg)) {
        setErrors({ code: "Provider code already exists" });
      } else {
        toast.error(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="insurance-provider-edit-modal-title"
      data-testid="insurance-provider-edit-modal"
    >
      <form
        onSubmit={submit}
        noValidate
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2
            id="insurance-provider-edit-modal-title"
            className="text-lg font-semibold"
          >
            Edit Provider — {provider.name}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-gray-500 hover:bg-gray-100"
          >
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label htmlFor="edit-provider-name" className="block text-xs font-medium">
              Name
            </label>
            <input
              id="edit-provider-name"
              data-testid="edit-provider-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${
                errors.name ? "border-red-500" : "border-gray-200"
              }`}
            />
            {errors.name && (
              <p className="mt-1 text-xs text-red-600">{errors.name}</p>
            )}
          </div>
          <div>
            <label htmlFor="edit-provider-code" className="block text-xs font-medium">
              Code
            </label>
            <input
              id="edit-provider-code"
              data-testid="edit-provider-code"
              value={form.code}
              onChange={(e) =>
                setForm({ ...form, code: e.target.value.toUpperCase() })
              }
              className={`mt-1 w-full rounded-lg border px-3 py-2 font-mono text-sm uppercase ${
                errors.code ? "border-red-500" : "border-gray-200"
              }`}
            />
            {errors.code && (
              <p className="mt-1 text-xs text-red-600">{errors.code}</p>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="edit-provider-contact-person"
                className="block text-xs font-medium"
              >
                Contact Person
              </label>
              <input
                id="edit-provider-contact-person"
                value={form.contactPerson}
                onChange={(e) =>
                  setForm({ ...form, contactPerson: e.target.value })
                }
                className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label
                htmlFor="edit-provider-contact-phone"
                className="block text-xs font-medium"
              >
                Phone
              </label>
              <input
                id="edit-provider-contact-phone"
                value={form.contactPhone}
                onChange={(e) =>
                  setForm({ ...form, contactPhone: e.target.value })
                }
                className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${
                  errors.contactPhone ? "border-red-500" : "border-gray-200"
                }`}
              />
              {errors.contactPhone && (
                <p className="mt-1 text-xs text-red-600">{errors.contactPhone}</p>
              )}
            </div>
          </div>
          <div>
            <label
              htmlFor="edit-provider-contact-email"
              className="block text-xs font-medium"
            >
              Email
            </label>
            <input
              id="edit-provider-contact-email"
              type="email"
              value={form.contactEmail}
              onChange={(e) =>
                setForm({ ...form, contactEmail: e.target.value })
              }
              className={`mt-1 w-full rounded-lg border px-3 py-2 text-sm ${
                errors.contactEmail ? "border-red-500" : "border-gray-200"
              }`}
            />
            {errors.contactEmail && (
              <p className="mt-1 text-xs text-red-600">{errors.contactEmail}</p>
            )}
          </div>
          <div>
            <label
              htmlFor="edit-provider-coverage"
              className="block text-xs font-medium"
            >
              Coverage Details
            </label>
            <textarea
              id="edit-provider-coverage"
              value={form.coverageDetails}
              onChange={(e) =>
                setForm({ ...form, coverageDetails: e.target.value })
              }
              rows={3}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) =>
                  setForm({ ...form, isActive: e.target.checked })
                }
                data-testid="edit-provider-active"
                className="rounded"
              />
              <span>
                Active{" "}
                <span className="text-xs text-gray-500">
                  (uncheck to mark inactive)
                </span>
              </span>
            </label>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            data-testid="edit-provider-save"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </form>
    </div>
  );
}
