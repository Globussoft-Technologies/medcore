"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { api, openPrintEndpoint } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { useAuthStore } from "@/lib/store";
import { ArrowLeft, FlaskConical, Printer } from "lucide-react";
import { formatDoctorName } from "@/lib/format-doctor-name";

// Issue #90: RECEPTION must NOT see the lab order detail / result-entry UI.
const LAB_ALLOWED = new Set(["ADMIN", "DOCTOR", "NURSE", "LAB_TECH", "PATIENT"]);

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
  NORMAL: "bg-green-100 text-green-700",
  LOW: "bg-blue-100 text-blue-700",
  HIGH: "bg-orange-100 text-orange-700",
  CRITICAL: "bg-red-100 text-red-700",
};

const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-700",
  SAMPLE_COLLECTED: "bg-blue-100 text-blue-700",
  IN_PROGRESS: "bg-indigo-100 text-indigo-700",
  COMPLETED: "bg-green-100 text-green-700",
  CANCELLED: "bg-red-100 text-red-700",
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

  if (loading)
    return <div className="p-8 text-center text-gray-500">Loading...</div>;
  if (!order)
    return <div className="p-8 text-center text-gray-500">Order not found.</div>;

  const allItemsHaveResults = order.items.every(
    (i) => i.results && i.results.length > 0
  );

  return (
    <div>
      <div className="no-print">
        <Link
          href="/dashboard/lab"
          className="mb-4 inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-800"
        >
          <ArrowLeft size={14} /> Back to Lab Orders
        </Link>
      </div>

      <div className="mb-6 rounded-xl bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold">
              <FlaskConical className="text-primary" /> Order{" "}
              {order.orderNumber || order.id.slice(0, 8)}
            </h1>
            <p className="mt-1 text-sm text-gray-500">
              Ordered {new Date(order.orderedAt).toLocaleString()}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => openPrintEndpoint(`/lab/orders/${order.id}/pdf`)}
              aria-label="Print lab report"
              className="no-print inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
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
            <p className="text-xs text-gray-500">Patient</p>
            <p className="font-medium">{order.patient.user.name}</p>
            <p className="text-xs text-gray-500">
              MR: {order.patient.mrNumber} · {order.patient.gender} ·{" "}
              {order.patient.age ?? "—"} yrs
            </p>
          </div>
          {order.doctor && (
            <div>
              <p className="text-xs text-gray-500">Ordering Doctor</p>
              <p className="font-medium">{formatDoctorName(order.doctor.user.name)}</p>
            </div>
          )}
          {order.notes && (
            <div className="sm:col-span-2">
              <p className="text-xs text-gray-500">Notes</p>
              <p className="text-sm">{order.notes}</p>
            </div>
          )}
        </div>
      </div>

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

      <div className="space-y-4">
        {order.items.map((item) => (
          <OrderItemCard
            key={item.id}
            item={item}
            onSaved={load}
            userRole={user?.role ?? null}
          />
        ))}
      </div>
    </div>
  );
}

function OrderItemCard({
  item,
  onSaved,
  userRole,
}: {
  item: LabOrderItem;
  onSaved: () => void;
  userRole: string | null;
}) {
  // Issue #255 (Apr 2026): the Add Result form must NOT render for the
  // PATIENT role. The backend already 403s the POST, but rendering the
  // form was confusing — patients would type values, hit Save, and see
  // a generic "request failed" toast. Hide the form entirely; recorded
  // results still display read-only above.
  const canAddResults =
    userRole === "ADMIN" ||
    userRole === "DOCTOR" ||
    userRole === "NURSE" ||
    userRole === "LAB_TECH";
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
  const isNumericTest =
    !!(item.test.unit && item.test.unit.trim().length > 0) ||
    typeof item.test.panicLow === "number" ||
    typeof item.test.panicHigh === "number";
  const numericRegex = /^-?\d+(\.\d+)?$/;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Client-side mirror of validateNumericLabResult — fails fast before POST
    if (isNumericTest && !numericRegex.test(form.value.trim())) {
      setValueError(
        "Value must be a number for this test (e.g. 12.5). Free text is not allowed.",
      );
      toast.error("Result value must be a number for this test");
      return;
    }
    setValueError(null);
    try {
      await api.post("/lab/results", {
        orderItemId: item.id,
        parameter: form.parameter,
        value: form.value,
        unit: form.unit || undefined,
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
    <div className="rounded-xl bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between border-b pb-3">
        <div>
          <h3 className="font-semibold">{item.test.name}</h3>
          {item.test.normalRange && (
            <p className="text-xs text-gray-500" data-testid="lab-range-hint">
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
          <p className="mb-2 text-xs font-semibold text-gray-600">
            Recorded Results
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-gray-500">
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
                <tr key={r.id} className="border-b last:border-0">
                  <td className="py-1.5 font-medium">{r.parameter}</td>
                  <td className="py-1.5">{r.value}</td>
                  <td className="py-1.5 text-gray-600">{r.unit || "—"}</td>
                  <td className="py-1.5 text-xs text-gray-600">
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
                  <td className="py-1.5 text-xs text-gray-600">
                    {r.notes || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Issue #255: hide Add Result form from PATIENT role. */}
      {canAddResults ? (
      <form onSubmit={submit} className="rounded-lg bg-gray-50 p-3" data-testid="lab-add-result-form">
        <p className="mb-2 text-xs font-semibold text-gray-600">Add Result</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <input
            required
            placeholder="Parameter"
            value={form.parameter}
            onChange={(e) => setForm({ ...form, parameter: e.target.value })}
            className="rounded-lg border px-2 py-1.5 text-sm"
          />
          <div>
            <input
              required
              // Issue #95: numeric tests accept only numbers; type=number
              // also lets browsers reject free text in supported chrome.
              type={isNumericTest ? "number" : "text"}
              step={isNumericTest ? "any" : undefined}
              min={
                isNumericTest && typeof item.test.panicLow === "number"
                  ? item.test.panicLow
                  : undefined
              }
              max={
                isNumericTest && typeof item.test.panicHigh === "number"
                  ? item.test.panicHigh
                  : undefined
              }
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
                "w-full rounded-lg border px-2 py-1.5 text-sm " +
                (valueError ? "border-red-500 bg-red-50" : "")
              }
            />
            {isNumericTest &&
              (typeof item.test.panicLow === "number" ||
                typeof item.test.panicHigh === "number") && (
                <p className="mt-0.5 text-[10px] text-gray-500">
                  Panic range: {item.test.panicLow ?? "—"} to{" "}
                  {item.test.panicHigh ?? "—"} {item.test.unit ?? ""}
                </p>
              )}
            {valueError && (
              <p
                data-testid="error-lab-result-value"
                className="mt-1 text-xs text-red-600"
              >
                {valueError}
              </p>
            )}
          </div>
          <input
            placeholder="Unit"
            value={form.unit}
            onChange={(e) => setForm({ ...form, unit: e.target.value })}
            className="rounded-lg border px-2 py-1.5 text-sm"
          />
          <input
            placeholder="Normal Range"
            value={form.normalRange}
            onChange={(e) => setForm({ ...form, normalRange: e.target.value })}
            className="rounded-lg border px-2 py-1.5 text-sm"
          />
          <select
            value={form.flag}
            onChange={(e) => setForm({ ...form, flag: e.target.value })}
            className="rounded-lg border px-2 py-1.5 text-sm"
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
            className="flex-1 rounded-lg border px-2 py-1.5 text-sm"
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
