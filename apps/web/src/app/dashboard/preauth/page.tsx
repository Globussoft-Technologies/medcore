"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { extractFieldErrors } from "@/lib/field-errors";
import { useAuthStore } from "@/lib/store";
import { FileCheck, Plus, X } from "lucide-react";

// Issue #509: page-level gate matching API authorize() in
// apps/api/src/routes/preauth.ts (ADMIN, RECEPTION). Page previously had no
// gate, so NURSE / DOCTOR / PATIENT could see the insurance pre-auth queue.
const VIEW_ALLOWED = new Set(["ADMIN", "RECEPTION"]);

type Tab = "PENDING" | "APPROVED" | "REJECTED" | "ALL";

interface PreAuthRow {
  id: string;
  requestNumber: string;
  insuranceProvider: string;
  policyNumber: string;
  procedureName: string;
  estimatedCost: number;
  status: string;
  approvedAmount?: number | null;
  rejectionReason?: string | null;
  submittedAt: string;
  resolvedAt?: string | null;
  claimReferenceNumber?: string | null;
  diagnosis?: string | null;
  patient: {
    id: string;
    mrNumber: string;
    user: { name: string; phone: string };
  };
}

interface PatientOpt {
  id: string;
  mrNumber: string;
  user: { name: string };
}

function fmtMoney(n: number) {
  return `Rs. ${n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function PreAuthPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = useState<Tab>("PENDING");
  const [rows, setRows] = useState<PreAuthRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [newOpen, setNewOpen] = useState(false);
  const [statusEdit, setStatusEdit] = useState<PreAuthRow | null>(null);

  // Issue #509: redirect non-allowed roles to /dashboard/not-authorized.
  useEffect(() => {
    if (!isLoading && user && !VIEW_ALLOWED.has(user.role)) {
      toast.error("Pre-authorisation is restricted to Admin and Reception.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/preauth")}`,
      );
    }
  }, [user, isLoading, router, pathname]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (tab !== "ALL") params.set("status", tab);
      const res = await api.get<{ data: PreAuthRow[] }>(
        `/preauth?${params.toString()}`
      );
      setRows(res.data);
    } catch {
      // ignore
    }
    setLoading(false);
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  const tabClass = (t: Tab) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition ${
      tab === t
        ? "bg-primary text-white"
        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
    }`;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <FileCheck className="text-primary" /> Pre-Authorization
          </h1>
          <p className="text-sm text-gray-500">
            Insurance procedure pre-approval requests
          </p>
        </div>
        <button
          onClick={() => setNewOpen(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
        >
          <Plus size={16} /> New Request
        </button>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <button onClick={() => setTab("PENDING")} className={tabClass("PENDING")}>
          Pending
        </button>
        <button
          onClick={() => setTab("APPROVED")}
          className={tabClass("APPROVED")}
        >
          Approved
        </button>
        <button
          onClick={() => setTab("REJECTED")}
          className={tabClass("REJECTED")}
        >
          Rejected
        </button>
        <button onClick={() => setTab("ALL")} className={tabClass("ALL")}>
          All
        </button>
      </div>

      <div className="rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No requests in this category.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500">
                <th className="px-4 py-3">Request #</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Procedure</th>
                <th className="px-4 py-3">Insurer</th>
                <th className="px-4 py-3">Est. Cost</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Submitted</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="px-4 py-3 font-mono text-sm">
                    {r.requestNumber}
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium">{r.patient.user.name}</p>
                    <p className="text-xs text-gray-500">
                      {r.patient.mrNumber}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-sm">{r.procedureName}</td>
                  <td className="px-4 py-3 text-sm">
                    {r.insuranceProvider}
                    <br />
                    <span className="text-xs text-gray-500">
                      {r.policyNumber}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {fmtMoney(r.estimatedCost)}
                    {r.approvedAmount != null && (
                      <span className="ml-2 text-xs text-green-700">
                        (approved {fmtMoney(r.approvedAmount)})
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        r.status === "APPROVED"
                          ? "bg-green-100 text-green-700"
                          : r.status === "REJECTED"
                            ? "bg-red-100 text-red-700"
                            : r.status === "PARTIAL"
                              ? "bg-orange-100 text-orange-700"
                              : "bg-yellow-100 text-yellow-700"
                      }`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {new Date(r.submittedAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    {r.status === "PENDING" && (
                      <button
                        onClick={() => setStatusEdit(r)}
                        className="rounded bg-primary px-3 py-1 text-xs font-medium text-white hover:bg-primary-dark"
                      >
                        Update
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {newOpen && (
        <NewRequestModal onClose={() => setNewOpen(false)} onSaved={load} />
      )}
      {statusEdit && (
        <UpdateStatusModal
          row={statusEdit}
          onClose={() => setStatusEdit(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}

function NewRequestModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<PatientOpt[]>([]);
  const [patient, setPatient] = useState<PatientOpt | null>(null);
  const [form, setForm] = useState({
    insuranceProvider: "",
    policyNumber: "",
    procedureName: "",
    estimatedCost: "",
    diagnosis: "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  // Issue #370 (2026-04-26): per-field error map so the user sees which
  // mandatory field failed instead of a generic toast.
  const [fieldErrors, setFieldErrors] = useState<{
    patientId?: string;
    insuranceProvider?: string;
    policyNumber?: string;
    procedureName?: string;
    estimatedCost?: string;
  }>({});

  useEffect(() => {
    if (search.length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ data: PatientOpt[] }>(
          `/patients?search=${encodeURIComponent(search)}`
        );
        setResults(res.data);
      } catch {
        setResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Issue #370 (2026-04-26): pre-flight every required field with a
    // per-field error so the user fixes them all in one pass instead of
    // playing whack-a-mole with the toast.
    setFieldErrors({});
    const errs: typeof fieldErrors = {};
    if (!patient) errs.patientId = "Select a patient";
    if (!form.insuranceProvider.trim())
      errs.insuranceProvider = "Insurance provider is required";
    if (!form.policyNumber.trim())
      errs.policyNumber = "Policy number is required";
    if (!form.procedureName.trim())
      errs.procedureName = "Procedure name is required";
    const estimated = parseFloat(form.estimatedCost);
    if (Number.isNaN(estimated) || estimated <= 0)
      errs.estimatedCost = "Estimated cost must be greater than 0";
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }
    setSaving(true);
    try {
      await api.post("/preauth", {
        patientId: patient!.id,
        insuranceProvider: form.insuranceProvider,
        policyNumber: form.policyNumber,
        procedureName: form.procedureName,
        estimatedCost: estimated,
        diagnosis: form.diagnosis || undefined,
        notes: form.notes || undefined,
      });
      onSaved();
      onClose();
    } catch (err) {
      const fields = extractFieldErrors(err);
      if (fields) setFieldErrors(fields as typeof fieldErrors);
      else toast.error((err as Error).message);
    }
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form
        onSubmit={submit}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">New Pre-Auth Request</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 hover:bg-gray-100"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3 text-sm">
          <div>
            <label className="mb-1 block text-xs text-gray-500">Patient</label>
            {patient ? (
              <div className="flex items-center justify-between rounded border bg-gray-50 p-2">
                <span>
                  {patient.user.name} ({patient.mrNumber})
                </span>
                <button
                  type="button"
                  onClick={() => setPatient(null)}
                  className="text-xs text-primary hover:underline"
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search patient..."
                  className="w-full rounded border px-3 py-2"
                />
                {results.length > 0 && (
                  <div className="mt-1 max-h-40 overflow-y-auto rounded border bg-white shadow">
                    {results.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setPatient(p);
                          setResults([]);
                          setSearch("");
                        }}
                        className="block w-full px-3 py-2 text-left hover:bg-gray-50"
                      >
                        {p.user.name} ({p.mrNumber})
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div>
            <label
              htmlFor="preauth-insurance-provider"
              className="mb-1 block text-xs font-medium text-slate-700"
              data-testid="label-preauth-insurance-provider"
            >
              Insurance Provider
            </label>
            <input
              id="preauth-insurance-provider"
              placeholder="Insurance Provider"
              value={form.insuranceProvider}
              onChange={(e) =>
                setForm({ ...form, insuranceProvider: e.target.value })
              }
              className="w-full rounded border px-3 py-2"
              required
            />
          </div>
          <div>
            <label
              htmlFor="preauth-policy-number"
              className="mb-1 block text-xs font-medium text-slate-700"
              data-testid="label-preauth-policy-number"
            >
              Policy Number
            </label>
            <input
              id="preauth-policy-number"
              placeholder="Policy Number"
              value={form.policyNumber}
              onChange={(e) =>
                setForm({ ...form, policyNumber: e.target.value })
              }
              className="w-full rounded border px-3 py-2"
              required
            />
          </div>
          <div>
            <label
              htmlFor="preauth-procedure-name"
              className="mb-1 block text-xs font-medium text-slate-700"
              data-testid="label-preauth-procedure-name"
            >
              Procedure Name
            </label>
            <input
              id="preauth-procedure-name"
              placeholder="Procedure Name"
              value={form.procedureName}
              onChange={(e) =>
                setForm({ ...form, procedureName: e.target.value })
              }
              className="w-full rounded border px-3 py-2"
              required
            />
          </div>
          <div>
            <label
              htmlFor="preauth-estimated-cost"
              className="mb-1 block text-xs font-medium text-slate-700"
              data-testid="label-preauth-estimated-cost"
            >
              Estimated Cost (₹)
            </label>
            <input
              id="preauth-estimated-cost"
              placeholder="Estimated Cost"
              type="number"
              step="0.01"
              value={form.estimatedCost}
              onChange={(e) =>
                setForm({ ...form, estimatedCost: e.target.value })
              }
              className="w-full rounded border px-3 py-2"
              required
            />
          </div>
          <div>
            <label
              htmlFor="preauth-diagnosis"
              className="mb-1 block text-xs font-medium text-slate-700"
              data-testid="label-preauth-diagnosis"
            >
              Diagnosis
            </label>
            <textarea
              id="preauth-diagnosis"
              placeholder="Diagnosis"
              value={form.diagnosis}
              onChange={(e) => setForm({ ...form, diagnosis: e.target.value })}
              className="w-full rounded border px-3 py-2"
              rows={2}
            />
          </div>
          <div>
            <label
              htmlFor="preauth-notes"
              className="mb-1 block text-xs font-medium text-slate-700"
              data-testid="label-preauth-notes"
            >
              Notes
            </label>
            <textarea
              id="preauth-notes"
              placeholder="Notes"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              className="w-full rounded border px-3 py-2"
              rows={2}
            />
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
          >
            {saving ? "Submitting..." : "Submit"}
          </button>
        </div>
      </form>
    </div>
  );
}

function UpdateStatusModal({
  row,
  onClose,
  onSaved,
}: {
  row: PreAuthRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState<"APPROVED" | "REJECTED" | "PARTIAL">(
    "APPROVED"
  );
  const [approvedAmount, setApprovedAmount] = useState(
    String(row.estimatedCost)
  );
  const [rejectionReason, setRejectionReason] = useState("");
  const [claimRef, setClaimRef] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.patch(`/preauth/${row.id}/status`, {
        status,
        approvedAmount:
          status !== "REJECTED" ? parseFloat(approvedAmount) : undefined,
        rejectionReason: status === "REJECTED" ? rejectionReason : undefined,
        claimReferenceNumber: claimRef || undefined,
      });
      onSaved();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    }
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Update {row.requestNumber}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 hover:bg-gray-100"
          >
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3 text-sm">
          <select
            value={status}
            onChange={(e) =>
              setStatus(e.target.value as "APPROVED" | "REJECTED" | "PARTIAL")
            }
            className="w-full rounded border px-3 py-2"
          >
            <option value="APPROVED">Approve</option>
            <option value="PARTIAL">Partial Approval</option>
            <option value="REJECTED">Reject</option>
          </select>
          {status !== "REJECTED" && (
            <input
              type="number"
              step="0.01"
              value={approvedAmount}
              onChange={(e) => setApprovedAmount(e.target.value)}
              className="w-full rounded border px-3 py-2"
              placeholder="Approved amount"
              required
            />
          )}
          {status === "REJECTED" && (
            <textarea
              placeholder="Rejection reason"
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              className="w-full rounded border px-3 py-2"
              rows={2}
              required
            />
          )}
          <input
            placeholder="Claim Reference # (optional)"
            value={claimRef}
            onChange={(e) => setClaimRef(e.target.value)}
            className="w-full rounded border px-3 py-2"
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
