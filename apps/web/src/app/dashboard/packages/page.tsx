"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Gift, Plus, Clock, Tag, ShoppingBag, X } from "lucide-react";
import { SkeletonCard, SkeletonTable } from "@/components/Skeleton";
import { useTranslation } from "@/lib/i18n";

interface PkgRecord {
  id: string;
  name: string;
  description?: string | null;
  services: string;
  price: number;
  discountPrice?: number | null;
  validityDays: number;
  category?: string | null;
  isActive: boolean;
  _count?: { purchases: number };
}

interface PkgPurchase {
  id: string;
  purchaseNumber: string;
  amountPaid: number;
  purchasedAt: string;
  expiresAt: string;
  isFullyUsed: boolean;
  package: { name: string; price: number; discountPrice?: number | null };
  patient: { user: { name: string; phone: string } };
}

interface PatientRecord {
  id: string;
  mrNumber: string;
  user: { name: string; phone: string };
}

const PACKAGES_FALLBACKS: Record<string, string> = {
  "common.all": "All",
  "common.status": "Status",
  "dashboard.billing.amount": "Amount",
  "dashboard.billing.patient": "Patient",
  "dashboard.packages.title": "Health Packages",
  "dashboard.packages.subtitle": "Sell curated health checkup bundles",
  "dashboard.packages.sellPackage": "Sell Package",
  "dashboard.packages.addPackage": "Add Package",
  "dashboard.packages.tab.activePackages": "Active Packages",
  "dashboard.packages.tab.purchases": "Purchases",
  "dashboard.packages.allCategories": "All Categories",
  "dashboard.packages.noPackages": "No packages found",
  "dashboard.packages.noPurchases": "No purchases found",
  "dashboard.packages.servicesIncluded": "Services Included",
  "dashboard.packages.daysValidity": "days validity",
  "dashboard.packages.sold": "sold",
  "dashboard.packages.purchaseNumber": "Purchase #",
  "dashboard.packages.package": "Package",
  "dashboard.packages.purchased": "Purchased",
  "dashboard.packages.expires": "Expires",
  "dashboard.packages.amountPaid": "Amount Paid",
  "dashboard.packages.filter.active": "Active",
  "dashboard.packages.filter.expired": "Expired",
  "dashboard.packages.status.active": "active",
  "dashboard.packages.status.expired": "expired",
  "dashboard.packages.status.used": "used",
};

const CATEGORIES = [
  "Master Health Checkup",
  "Diabetes Package",
  "Cardiac Package",
  "Pregnancy Care",
  "Senior Citizen",
  "Preventive",
  "Pediatric",
  "Gynec",
  "Other",
];

// Shared styling for the package modal form controls. The modals render on the
// dark dashboard layout, so without explicit colors the inputs inherit the
// layout's light text (dark:text-gray-100) and wash out; the dark variants give
// them a legible dark surface.
const MODAL_FIELD =
  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500";

export default function PackagesPage() {
  const { user } = useAuthStore();
  const { t: translate } = useTranslation();
  const t = useCallback(
    (key: string, fallback?: string) => {
      const resolvedFallback = fallback ?? PACKAGES_FALLBACKS[key];
      const value = translate(key, resolvedFallback);
      return value === key ? resolvedFallback ?? key : value;
    },
    [translate],
  );
  const [tab, setTab] = useState<"packages" | "purchases">("packages");
  const [packages, setPackages] = useState<PkgRecord[]>([]);
  const [purchases, setPurchases] = useState<PkgPurchase[]>([]);
  const [loading, setLoading] = useState(true);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | "active" | "expired">("all");

  const [showPkgModal, setShowPkgModal] = useState(false);
  const [showSellModal, setShowSellModal] = useState(false);

  useEffect(() => {
    if (tab === "packages") loadPackages();
    else loadPurchases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, categoryFilter, activeFilter]);

  async function loadPackages() {
    setLoading(true);
    try {
      const qs = categoryFilter ? `?category=${encodeURIComponent(categoryFilter)}` : "";
      const res = await api.get<{ data: PkgRecord[] }>(`/packages${qs}`);
      setPackages(res.data);
    } catch {
      setPackages([]);
    }
    setLoading(false);
  }

  async function loadPurchases() {
    setLoading(true);
    try {
      const qs = activeFilter === "active" ? "?active=true" : "";
      const res = await api.get<{ data: PkgPurchase[] }>(`/packages/purchases${qs}`);
      let items = res.data;
      if (activeFilter === "expired") {
        items = items.filter((p) => new Date(p.expiresAt) <= new Date());
      }
      setPurchases(items);
    } catch {
      setPurchases([]);
    }
    setLoading(false);
  }

  const canAdminPkg = user?.role === "ADMIN";
  const canSell = user?.role === "ADMIN" || user?.role === "RECEPTION";

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Gift className="text-primary" size={28} /> {t("dashboard.packages.title")}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">{t("dashboard.packages.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          {canSell && (
            <button
              onClick={() => setShowSellModal(true)}
              className="flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
            >
              <ShoppingBag size={16} /> {t("dashboard.packages.sellPackage")}
            </button>
          )}
          {canAdminPkg && (
            <button
              onClick={() => setShowPkgModal(true)}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
            >
              <Plus size={16} /> {t("dashboard.packages.addPackage")}
            </button>
          )}
        </div>
      </div>

      <div className="mb-4 flex gap-2 border-b dark:border-gray-700">
        {(["packages", "purchases"] as const).map((tabKey) => (
          <button
            key={tabKey}
            onClick={() => setTab(tabKey)}
            className={`px-4 py-2 text-sm font-medium ${
              tab === tabKey
                ? "border-b-2 border-primary text-primary dark:border-blue-400 dark:text-blue-400"
                : "text-gray-500 hover:text-gray-700 dark:text-gray-300 dark:hover:text-white"
            }`}
          >
            {tabKey === "packages" ? t("dashboard.packages.tab.activePackages") : t("dashboard.packages.tab.purchases")}
          </button>
        ))}
      </div>

      {tab === "packages" && (
        <>
          <div className="mb-4 flex gap-2">
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            >
              <option value="">{t("dashboard.packages.allCategories")}</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          {loading ? (
            <div data-testid="packages-loading" aria-busy="true" className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </div>
          ) : packages.length === 0 ? (
            <div className="rounded-xl bg-white p-16 text-center text-gray-500 shadow-sm dark:bg-gray-800 dark:text-gray-400">
              {t("dashboard.packages.noPackages")}
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {packages.map((p) => (
                <div
                  key={p.id}
                  className="rounded-xl bg-white p-5 shadow-sm transition hover:shadow-md dark:bg-gray-800"
                >
                  <div className="mb-3 flex items-start justify-between">
                    <div>
                      <h3 className="font-semibold">{p.name}</h3>
                      {p.category && (
                        <span className="mt-1 inline-block rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                          {p.category}
                        </span>
                      )}
                    </div>
                    <div className="text-right">
                      {p.discountPrice ? (
                        <>
                          <span className="text-xs text-gray-400 line-through dark:text-gray-500">
                            Rs. {p.price.toFixed(0)}
                          </span>
                          <p className="text-lg font-bold text-green-600 dark:text-green-400">
                            Rs. {p.discountPrice.toFixed(0)}
                          </p>
                        </>
                      ) : (
                        <p className="text-lg font-bold text-primary">
                          Rs. {p.price.toFixed(0)}
                        </p>
                      )}
                    </div>
                  </div>
                  {p.description && (
                    <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">{p.description}</p>
                  )}
                  <div className="mb-3">
                    <p className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">{t("dashboard.packages.servicesIncluded")}</p>
                    <div className="flex flex-wrap gap-1">
                      {(typeof p.services === "string" ? p.services : "")
                        .split(",")
                        .map((s, i) => (
                          <span
                            key={i}
                            className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-200"
                          >
                            {s.trim()}
                          </span>
                        ))}
                    </div>
                  </div>
                  <div className="flex items-center justify-between border-t pt-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
                    <span className="flex items-center gap-1">
                      <Clock size={12} /> {p.validityDays} {t("dashboard.packages.daysValidity")}
                    </span>
                    <span className="flex items-center gap-1">
                      <Tag size={12} /> {p._count?.purchases || 0} {t("dashboard.packages.sold")}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === "purchases" && (
        <>
          <div className="mb-4 flex gap-2">
            {(["all", "active", "expired"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setActiveFilter(f)}
                className={`rounded-lg px-3 py-1.5 text-sm ${
                  activeFilter === f
                    ? "bg-primary text-white"
                    : "bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
                }`}
              >
                {f === "all" ? t("common.all") : f === "active" ? t("dashboard.packages.filter.active") : t("dashboard.packages.filter.expired")}
              </button>
            ))}
          </div>

          <div className="rounded-xl bg-white shadow-sm dark:bg-gray-800">
            {loading ? (
              <div className="p-4" data-testid="package-purchases-loading" aria-busy="true">
                <SkeletonTable rows={5} columns={5} />
              </div>
            ) : purchases.length === 0 ? (
              <div className="p-8 text-center text-gray-500 dark:text-gray-400">{t("dashboard.packages.noPurchases")}</div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300">
                    <th className="px-4 py-3">{t("dashboard.packages.purchaseNumber")}</th>
                    <th className="px-4 py-3">{t("dashboard.billing.patient")}</th>
                    <th className="px-4 py-3">{t("dashboard.packages.package")}</th>
                    <th className="px-4 py-3">{t("dashboard.packages.purchased")}</th>
                    <th className="px-4 py-3">{t("dashboard.packages.expires")}</th>
                    <th className="px-4 py-3">{t("dashboard.packages.amountPaid")}</th>
                    <th className="px-4 py-3">{t("common.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {purchases.map((p) => {
                    const expired = new Date(p.expiresAt) < new Date();
                    const status = p.isFullyUsed ? "used" : expired ? "expired" : "active";
                    return (
                      <tr key={p.id} className="border-b last:border-0 dark:border-gray-700">
                        <td className="px-4 py-3 font-mono text-sm">
                          {p.purchaseNumber}
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-medium">{p.patient.user.name}</p>
                          <p className="text-xs text-gray-500 dark:text-gray-400">{p.patient.user.phone}</p>
                        </td>
                        <td className="px-4 py-3 text-sm">{p.package.name}</td>
                        <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
                          {new Date(p.purchasedAt).toLocaleDateString("en-IN")}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
                          {new Date(p.expiresAt).toLocaleDateString("en-IN")}
                        </td>
                        <td className="px-4 py-3 font-medium">
                          Rs. {p.amountPaid.toFixed(2)}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                              status === "active"
                                ? "bg-green-100 text-green-700"
                                : status === "expired"
                                  ? "bg-red-100 text-red-700"
                                  : "bg-gray-100 text-gray-700"
                            }`}
                          >
                            {t(`dashboard.packages.status.${status}`)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {showPkgModal && (
        <AddPackageModal
          onClose={() => setShowPkgModal(false)}
          onSaved={() => {
            setShowPkgModal(false);
            loadPackages();
          }}
        />
      )}
      {showSellModal && (
        <SellPackageModal
          packages={packages}
          onClose={() => setShowSellModal(false)}
          onSold={() => {
            setShowSellModal(false);
            setTab("purchases");
          }}
        />
      )}
    </div>
  );
}

function AddPackageModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: "",
    description: "",
    services: "",
    price: "",
    discountPrice: "",
    validityDays: "365",
    category: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }
    if (!form.services.trim()) {
      setError("Services are required");
      return;
    }
    const priceNum = parseFloat(form.price);
    if (!Number.isFinite(priceNum) || priceNum < 1) {
      setError("Price must be at least 1");
      return;
    }
    const discountNum = form.discountPrice ? parseFloat(form.discountPrice) : NaN;
    if (form.discountPrice && (!Number.isFinite(discountNum) || discountNum < 0)) {
      setError("Discount price must be 0 or greater");
      return;
    }
    const validityNum = parseInt(form.validityDays);
    if (!Number.isFinite(validityNum) || validityNum < 1) {
      setError("Validity must be at least 1 day");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        services: form.services,
        price: priceNum,
        validityDays: validityNum,
      };
      if (form.description) body.description = form.description;
      if (form.discountPrice) body.discountPrice = discountNum;
      if (form.category) body.category = form.category;
      await api.post("/packages", body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save package");
    }
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 text-gray-900 shadow-2xl dark:bg-gray-800 dark:text-gray-100">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Add Health Package</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300">
            <X size={20} />
          </button>
        </div>
        <form onSubmit={handleSubmit} noValidate className="space-y-3">
          <div>
            <label htmlFor="add-package-name" className="mb-1 block text-sm font-medium">Name *</label>
            <input
              id="add-package-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className={MODAL_FIELD}
            />
          </div>
          <div>
            <label htmlFor="add-package-category" className="mb-1 block text-sm font-medium">Category</label>
            <select
              id="add-package-category"
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              className={MODAL_FIELD}
            >
              <option value="">Select category</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="add-package-description" className="mb-1 block text-sm font-medium">Description</label>
            <textarea
              id="add-package-description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
              className={MODAL_FIELD}
            />
          </div>
          <div>
            <label htmlFor="add-package-services" className="mb-1 block text-sm font-medium">Services (comma-separated) *</label>
            <textarea
              id="add-package-services"
              value={form.services}
              onChange={(e) => setForm({ ...form, services: e.target.value })}
              rows={3}
              placeholder="CBC, LFT, KFT, Consultation..."
              className={MODAL_FIELD}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="add-package-price" className="mb-1 block text-sm font-medium">Price *</label>
              <input
                id="add-package-price"
                type="number"
                step="0.01"
                value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
                className={MODAL_FIELD}
              />
            </div>
            <div>
              <label htmlFor="add-package-discount-price" className="mb-1 block text-sm font-medium">Discount Price</label>
              <input
                id="add-package-discount-price"
                type="number"
                step="0.01"
                value={form.discountPrice}
                onChange={(e) => setForm({ ...form, discountPrice: e.target.value })}
                className={MODAL_FIELD}
              />
            </div>
          </div>
          <div>
            <label htmlFor="add-package-validity-days" className="mb-1 block text-sm font-medium">Validity (days)</label>
            <input
              id="add-package-validity-days"
              type="number"
              value={form.validityDays}
              onChange={(e) => setForm({ ...form, validityDays: e.target.value })}
              className={MODAL_FIELD}
            />
          </div>
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
            >
              {saving ? "Saving..." : "Create Package"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SellPackageModal({
  packages,
  onClose,
  onSold,
}: {
  packages: PkgRecord[];
  onClose: () => void;
  onSold: () => void;
}) {
  const [packageId, setPackageId] = useState("");
  const [patientSearch, setPatientSearch] = useState("");
  const [patients, setPatients] = useState<PatientRecord[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<PatientRecord | null>(null);
  const [amountPaid, setAmountPaid] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (patientSearch.length < 2) {
      setPatients([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ data: PatientRecord[] }>(
          `/patients?search=${encodeURIComponent(patientSearch)}&limit=10`
        );
        setPatients(res.data);
      } catch {
        setPatients([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [patientSearch]);

  const selectedPkg = packages.find((p) => p.id === packageId);

  useEffect(() => {
    if (selectedPkg && !amountPaid) {
      setAmountPaid(String(selectedPkg.discountPrice || selectedPkg.price));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packageId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!packageId) {
      setError("Select a package");
      return;
    }
    if (!selectedPatient) {
      setError("Select a patient");
      return;
    }
    const amt = parseFloat(amountPaid);
    if (!Number.isFinite(amt) || amt < 0.01) {
      setError("Amount paid must be at least 0.01");
      return;
    }
    setSaving(true);
    try {
      await api.post("/packages/purchase", {
        packageId,
        patientId: selectedPatient.id,
        amountPaid: amt,
      });
      onSold();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Purchase failed");
    }
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-h-[90vh] overflow-y-auto max-w-lg rounded-xl bg-white p-6 text-gray-900 shadow-2xl dark:bg-gray-800 dark:text-gray-100">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Sell Package</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300">
            <X size={20} />
          </button>
        </div>
        <form onSubmit={handleSubmit} noValidate className="space-y-3">
          <div>
            <label htmlFor="sell-package-package" className="mb-1 block text-sm font-medium">Package *</label>
            <select
              id="sell-package-package"
              value={packageId}
              onChange={(e) => setPackageId(e.target.value)}
              className={MODAL_FIELD}
            >
              <option value="">Select a package</option>
              {packages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — Rs. {(p.discountPrice || p.price).toFixed(0)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Patient *</label>
            {selectedPatient ? (
              <div className="flex items-center justify-between rounded-lg border bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-900/40">
                <div>
                  <p className="text-sm font-medium">{selectedPatient.user.name}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {selectedPatient.mrNumber} • {selectedPatient.user.phone}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedPatient(null)}
                  className="text-xs text-red-600 hover:underline"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  value={patientSearch}
                  onChange={(e) => setPatientSearch(e.target.value)}
                  placeholder="Search by name, phone, or MR #"
                  className={MODAL_FIELD}
                />
                {patients.length > 0 && (
                  <ul className="mt-1 max-h-40 overflow-y-auto rounded-lg border bg-white shadow dark:border-gray-700 dark:bg-gray-800">
                    {patients.map((pt) => (
                      <li
                        key={pt.id}
                        onClick={() => {
                          setSelectedPatient(pt);
                          setPatientSearch("");
                        }}
                        className="cursor-pointer px-3 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        <p className="font-medium">{pt.user.name}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {pt.mrNumber} • {pt.user.phone}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>

          <div>
            <label htmlFor="sell-package-amount-paid" className="mb-1 block text-sm font-medium">Amount Paid *</label>
            <input
              id="sell-package-amount-paid"
              type="number"
              step="0.01"
              value={amountPaid}
              onChange={(e) => setAmountPaid(e.target.value)}
              className={MODAL_FIELD}
            />
            {selectedPkg && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Valid for {selectedPkg.validityDays} days from today
              </p>
            )}
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !selectedPatient}
              className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {saving ? "Processing..." : "Complete Purchase"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
