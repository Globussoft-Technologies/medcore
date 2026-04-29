"use client";

import { useEffect, useState, Fragment } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { formatINR } from "@/lib/currency";
import { Plus, FlaskConical } from "lucide-react";

// Issue #90: RECEPTION must NOT see lab orders / results / result-entry form.
// Clinical roles + LAB_TECH + PATIENT (own data).
const LAB_ALLOWED = new Set(["ADMIN", "DOCTOR", "NURSE", "LAB_TECH", "PATIENT"]);

interface LabTest {
  id: string;
  name: string;
  category?: string | null;
  normalRange?: string | null;
  unit?: string | null;
  price?: number;
}

interface LabOrder {
  id: string;
  orderNumber?: string;
  orderedAt: string;
  status: string;
  priority?: string;
  stat?: boolean;
  notes?: string | null;
  patient: { id: string; mrNumber?: string; user: { name: string } };
  doctor?: { user: { name: string } };
  items: LabOrderItem[];
}

interface LabOrderItem {
  id: string;
  status: string;
  test: LabTest;
  results?: LabResult[];
}

interface LabResult {
  id: string;
  parameter: string;
  value: string;
  unit?: string | null;
  normalRange?: string | null;
  flag?: "NORMAL" | "LOW" | "HIGH" | "CRITICAL" | null;
  notes?: string | null;
}

interface Patient {
  id: string;
  mrNumber: string;
  user: { name: string; phone: string };
}

type Tab = "orders" | "catalog";

const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-700",
  SAMPLE_COLLECTED: "bg-blue-100 text-blue-700",
  IN_PROGRESS: "bg-indigo-100 text-indigo-700",
  COMPLETED: "bg-green-100 text-green-700",
  CANCELLED: "bg-red-100 text-red-700",
};

const FLAG_COLORS: Record<string, string> = {
  NORMAL: "bg-green-100 text-green-700",
  LOW: "bg-blue-100 text-blue-700",
  HIGH: "bg-orange-100 text-orange-700",
  CRITICAL: "bg-red-100 text-red-700",
};

export default function LabPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const { t } = useTranslation();

  // Issue #90: redirect RECEPTION away — clinical-data exposure.
  useEffect(() => {
    if (!isLoading && user && !LAB_ALLOWED.has(user.role)) {
      toast.error("Lab orders & results are restricted to clinical staff.");
      router.replace("/dashboard");
    }
  }, [user, isLoading, router]);
  const [tab, setTab] = useState<Tab>("orders");
  const [orders, setOrders] = useState<LabOrder[]>([]);
  const [tests, setTests] = useState<LabTest[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [statOnly, setStatOnly] = useState(false);
  const [aiInsights, setAiInsights] = useState<Record<string, {
    loading: boolean;
    data?: {
      interpretation: string;
      trend: string;
      baselineComparison: string;
      recommendedActions: string[];
      urgency: string;
    };
    error?: string;
  }>>({});

  const canOrder = user?.role === "DOCTOR";
  const canSeeAI = user?.role === "DOCTOR" || user?.role === "ADMIN";
  // Only lab techs and admins may enter results — doctors view, never enter.
  // Mirror of the backend `authorize(LAB_TECH, ADMIN)` on POST /lab/results.
  const canEnterResults = user?.role === "LAB_TECH" || user?.role === "ADMIN";

  async function fetchAIInsights(resultId: string) {
    setAiInsights((m) => ({ ...m, [resultId]: { loading: true } }));
    try {
      const res = await api.get<any>(`/ai/lab-intel/${resultId}`);
      setAiInsights((m) => ({
        ...m,
        [resultId]: { loading: false, data: res.data?.analysis ?? res.data?.data?.analysis },
      }));
    } catch (err: any) {
      setAiInsights((m) => ({
        ...m,
        [resultId]: { loading: false, error: err?.message ?? "Failed" },
      }));
    }
  }

  useEffect(() => {
    if (tab === "orders") loadOrders();
    else loadTests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, statOnly]);

  // Auto-open the order form when the doctor workspace quick-action links
  // here with ?new=1 (companion to issue #11 Write Rx fix).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!canOrder) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("new") === "1") setShowOrderModal(true);
  }, [canOrder]);

  async function loadOrders() {
    setLoading(true);
    try {
      const qs = statOnly ? "?stat=true" : "";
      const res = await api.get<{ data: LabOrder[] }>(`/lab/orders${qs}`);
      setOrders(res.data);
    } catch {
      // empty
    }
    setLoading(false);
  }

  async function loadTests() {
    setLoading(true);
    try {
      const res = await api.get<{ data: LabTest[] }>("/lab/tests");
      setTests(res.data);
    } catch {
      // empty
    }
    setLoading(false);
  }

  async function updateStatus(orderId: string, status: string) {
    try {
      await api.patch(`/lab/orders/${orderId}/status`, { status });
      loadOrders();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    }
  }

  const tabClass = (t: Tab) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition ${
      tab === t
        ? "bg-primary text-white"
        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
    }`;

  const testsByCategory = tests.reduce(
    (acc, t) => {
      const cat = t.category || "Other";
      (acc[cat] ||= []).push(t);
      return acc;
    },
    {} as Record<string, LabTest[]>
  );

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
            <FlaskConical className="text-primary" aria-hidden="true" /> {t("dashboard.lab.title")}
          </h1>
          <p className="text-sm text-gray-700 dark:text-gray-300">{t("dashboard.lab.orders")}</p>
        </div>
        {canOrder && tab === "orders" && (
          <button
            onClick={() => setShowOrderModal(true)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <Plus size={16} aria-hidden="true" /> {t("dashboard.lab.newOrder")}
          </button>
        )}
      </div>

      <div className="mb-4 flex items-center gap-2">
        <button onClick={() => setTab("orders")} className={tabClass("orders")}>
          Orders
        </button>
        <button onClick={() => setTab("catalog")} className={tabClass("catalog")}>
          Test Catalog
        </button>
        {tab === "orders" && (
          <button
            onClick={() => setStatOnly((v) => !v)}
            className={`ml-auto rounded-full border px-3 py-1 text-xs font-semibold ${
              statOnly
                ? "border-red-600 bg-red-600 text-white"
                : "border-red-300 bg-white text-red-700 hover:bg-red-50 dark:border-red-900/50 dark:bg-gray-800 dark:text-red-300 dark:hover:bg-red-900/20"
            }`}
          >
            STAT Only
          </button>
        )}
      </div>

      {tab === "catalog" ? (
        <div className="rounded-xl bg-white p-6 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100">
          {loading ? (
            <div className="text-center text-gray-500 dark:text-gray-400">Loading...</div>
          ) : tests.length === 0 ? (
            <div className="text-center text-gray-500 dark:text-gray-400">No tests defined.</div>
          ) : (
            Object.entries(testsByCategory).map(([cat, list]) => (
              <div key={cat} className="mb-6">
                <h3 className="mb-2 text-sm font-semibold uppercase text-gray-600 dark:text-gray-300">
                  {cat}
                </h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {list.map((t) => (
                    <div
                      key={t.id}
                      className="rounded-lg border border-gray-200 p-3 dark:border-gray-700"
                    >
                      <p className="font-medium">{t.name}</p>
                      {t.normalRange && (
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {/* Issue #230: extension of #147 — only append the
                              unit when the range string doesn't already
                              contain it. Prevents "0.4-4.0 mIU/L mIU/L". */}
                          Normal: {t.normalRange}
                          {t.unit &&
                          !t.normalRange.toLowerCase().includes(t.unit.toLowerCase())
                            ? ` ${t.unit}`
                            : ""}
                        </p>
                      )}
                      {t.price !== undefined && (
                        // Issue #403: canonical INR format ("₹1,200.00") via
                        // shared formatINR — was bare "₹1200" before.
                        <p className="mt-1 text-xs">{formatINR(t.price)}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="rounded-xl bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100">
          {loading ? (
            <div className="p-8 text-center text-gray-500 dark:text-gray-400">Loading...</div>
          ) : orders.length === 0 ? (
            <div className="p-8 text-center text-gray-500 dark:text-gray-400">
              No lab orders.
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <th className="px-4 py-3">Order #</th>
                  <th className="px-4 py-3">Patient</th>
                  <th className="px-4 py-3">Doctor</th>
                  <th className="px-4 py-3">Tests</th>
                  <th className="px-4 py-3">Ordered</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <Fragment key={o.id}>
                    <tr
                      className={`cursor-pointer border-b border-gray-100 last:border-0 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700 ${
                        o.stat ? "border-l-4 border-l-red-500 bg-red-50/40 dark:bg-red-900/20" : ""
                      }`}
                      onClick={() =>
                        setExpanded(expanded === o.id ? null : o.id)
                      }
                    >
                      <td className="px-4 py-3 font-medium">
                        <div className="flex items-center gap-2">
                          {o.orderNumber || o.id.slice(0, 8)}
                          {o.stat && (
                            <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                              STAT
                            </span>
                          )}
                          {!o.stat && o.priority === "URGENT" && (
                            <span className="rounded bg-orange-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                              URGENT
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium">{o.patient.user.name}</p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {o.patient.mrNumber}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {o.doctor?.user.name || "—"}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {o.items.length} test(s)
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {new Date(o.orderedAt).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[o.status] || ""}`}
                        >
                          {o.status.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div
                          className="flex gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {o.status === "PENDING" && (
                            <button
                              onClick={() =>
                                updateStatus(o.id, "SAMPLE_COLLECTED")
                              }
                              className="rounded bg-blue-500 px-2 py-1 text-xs text-white hover:bg-blue-600"
                            >
                              Collect
                            </button>
                          )}
                          {o.status === "SAMPLE_COLLECTED" && (
                            <button
                              onClick={() => updateStatus(o.id, "IN_PROGRESS")}
                              className="rounded bg-indigo-500 px-2 py-1 text-xs text-white hover:bg-indigo-600"
                            >
                              Process
                            </button>
                          )}
                          {o.status === "IN_PROGRESS" && canEnterResults && (
                            <Link
                              href={`/dashboard/lab/${o.id}`}
                              className="rounded bg-green-600 px-2 py-1 text-xs text-white hover:bg-green-700"
                            >
                              Enter Results
                            </Link>
                          )}
                          <Link
                            href={`/dashboard/lab/${o.id}`}
                            className="rounded border px-2 py-1 text-xs hover:bg-gray-50"
                          >
                            View
                          </Link>
                        </div>
                      </td>
                    </tr>
                    {expanded === o.id && (
                      <tr>
                        <td colSpan={7} className="bg-gray-50 px-4 py-3">
                          <div className="space-y-2">
                            {o.items.map((item) => (
                              <div
                                key={item.id}
                                className="rounded-lg border bg-white p-3"
                              >
                                <div className="flex items-center justify-between">
                                  <p className="font-medium">
                                    {item.test.name}
                                  </p>
                                  <span
                                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[item.status] || ""}`}
                                  >
                                    {item.status.replace(/_/g, " ")}
                                  </span>
                                </div>
                                {item.results && item.results.length > 0 && (
                                  <div className="mt-2 space-y-1">
                                    {item.results.map((r) => {
                                      const insight = aiInsights[r.id];
                                      return (
                                        <div key={r.id} className="text-sm">
                                          <div className="flex items-center gap-2">
                                            <span className="font-medium">
                                              {r.parameter}:
                                            </span>
                                            <span>
                                              {r.value} {r.unit}
                                            </span>
                                            {r.normalRange && (
                                              <span className="text-xs text-gray-500">
                                                (normal: {r.normalRange})
                                              </span>
                                            )}
                                            {r.flag && (
                                              <span
                                                className={`rounded px-1.5 py-0.5 text-xs font-medium ${FLAG_COLORS[r.flag]}`}
                                              >
                                                {r.flag}
                                              </span>
                                            )}
                                            {canSeeAI && !insight && (
                                              <button
                                                data-testid="lab-ai-insights-btn"
                                                onClick={() => fetchAIInsights(r.id)}
                                                className="text-xs text-indigo-600 hover:underline ml-2"
                                              >
                                                AI Insights
                                              </button>
                                            )}
                                            {insight?.loading && (
                                              <span className="text-xs text-gray-500 ml-2">
                                                analysing...
                                              </span>
                                            )}
                                          </div>
                                          {insight?.data && (
                                            <div className="mt-1 bg-indigo-50 border border-indigo-100 rounded p-2 text-xs space-y-1">
                                              <p>
                                                <strong>Interpretation:</strong>{" "}
                                                {insight.data.interpretation}
                                              </p>
                                              <p>
                                                <strong>Trend:</strong> {insight.data.trend}{" "}
                                                <span className="text-gray-500">·</span>{" "}
                                                <strong>Urgency:</strong> {insight.data.urgency}
                                              </p>
                                              <p>
                                                <strong>Baseline:</strong>{" "}
                                                {insight.data.baselineComparison}
                                              </p>
                                              {insight.data.recommendedActions.length > 0 && (
                                                <ul className="list-disc list-inside">
                                                  {insight.data.recommendedActions.map(
                                                    (a, i) => (
                                                      <li key={i}>{a}</li>
                                                    )
                                                  )}
                                                </ul>
                                              )}
                                            </div>
                                          )}
                                          {insight?.error && (
                                            <p className="text-xs text-red-600 mt-1">
                                              {insight.error}
                                            </p>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {showOrderModal && (
        <NewOrderModal
          onClose={() => setShowOrderModal(false)}
          onSaved={loadOrders}
        />
      )}
    </div>
  );
}

function NewOrderModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [patientSearch, setPatientSearch] = useState("");
  const [patientResults, setPatientResults] = useState<Patient[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [tests, setTests] = useState<LabTest[]>([]);
  const [selectedTests, setSelectedTests] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [priority, setPriority] = useState<"ROUTINE" | "URGENT" | "STAT">("ROUTINE");

  useEffect(() => {
    api
      .get<{ data: LabTest[] }>("/lab/tests")
      .then((res) => setTests(res.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (patientSearch.length < 2) {
      setPatientResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ data: Patient[] }>(
          `/patients?search=${encodeURIComponent(patientSearch)}&limit=10`
        );
        setPatientResults(res.data);
      } catch {
        setPatientResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [patientSearch]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPatient) {
      toast.error("Select a patient");
      return;
    }
    if (selectedTests.length === 0) {
      toast.error("Select at least one test");
      return;
    }
    try {
      await api.post("/lab/orders", {
        patientId: selectedPatient.id,
        testIds: selectedTests,
        notes: notes || undefined,
        priority,
      });
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create order");
    }
  }

  const grouped = tests.reduce(
    (acc, t) => {
      const cat = t.category || "Other";
      (acc[cat] ||= []).push(t);
      return acc;
    },
    {} as Record<string, LabTest[]>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl"
      >
        <h2 className="mb-4 text-lg font-semibold">New Lab Order</h2>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Patient</label>
            {selectedPatient ? (
              <div className="flex items-center justify-between rounded-lg border bg-gray-50 px-3 py-2 text-sm">
                <span>
                  <strong>{selectedPatient.user.name}</strong> ·{" "}
                  {selectedPatient.mrNumber}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedPatient(null)}
                  className="text-xs text-red-600"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  placeholder="Search patient"
                  value={patientSearch}
                  onChange={(e) => setPatientSearch(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
                {patientResults.length > 0 && (
                  <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border bg-white shadow-sm">
                    {patientResults.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setSelectedPatient(p);
                          setPatientResults([]);
                        }}
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
                      >
                        <strong>{p.user.name}</strong> · {p.mrNumber}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Tests</label>
            <div className="max-h-64 overflow-y-auto rounded-lg border p-3">
              {Object.keys(grouped).length === 0 ? (
                <p className="text-sm text-gray-500">Loading tests...</p>
              ) : (
                Object.entries(grouped).map(([cat, list]) => (
                  <div key={cat} className="mb-3">
                    <h4 className="mb-1 text-xs font-semibold uppercase text-gray-500">
                      {cat}
                    </h4>
                    <div className="grid grid-cols-2 gap-1">
                      {list.map((t) => (
                        <label
                          key={t.id}
                          className="flex items-center gap-2 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={selectedTests.includes(t.id)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedTests([...selectedTests, t.id]);
                              } else {
                                setSelectedTests(
                                  selectedTests.filter((id) => id !== t.id)
                                );
                              }
                            }}
                          />
                          {t.name}
                        </label>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Priority</label>
            <div className="flex gap-2">
              {(["ROUTINE", "URGENT", "STAT"] as const).map((p) => (
                <label
                  key={p}
                  className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${
                    priority === p
                      ? p === "STAT"
                        ? "border-red-600 bg-red-50 text-red-800"
                        : p === "URGENT"
                        ? "border-orange-500 bg-orange-50 text-orange-800"
                        : "border-primary bg-primary/10 text-primary"
                      : "border-gray-300 text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  <input
                    type="radio"
                    name="lab-priority"
                    value={p}
                    checked={priority === p}
                    onChange={() => setPriority(p)}
                    className="hidden"
                  />
                  {p}
                </label>
              ))}
            </div>
            {priority === "STAT" && (
              <p className="mt-1 text-xs text-red-700">
                STAT orders notify the lab team immediately.
              </p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            Create Order
          </button>
        </div>
      </form>
    </div>
  );
}
