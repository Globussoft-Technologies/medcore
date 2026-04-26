"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { EntityPicker } from "@/components/EntityPicker";
import { Award, Plus, AlertTriangle, X } from "lucide-react";

interface Cert {
  id: string;
  userId: string;
  type: string;
  title: string;
  issuingBody: string | null;
  certNumber: string | null;
  issuedDate: string | null;
  expiryDate: string | null;
  status: string;
  notes: string | null;
  user?: { id: string; name: string; role: string };
}

const CERT_TYPES = ["MEDICAL_LICENSE", "NURSING_CERT", "BLS", "ACLS", "TRAINING", "OTHER"];

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const d = new Date(dateStr);
  return Math.round((d.getTime() - now.getTime()) / 86400000);
}

function statusColor(cert: Cert) {
  const days = daysUntil(cert.expiryDate);
  if (days === null) return "bg-slate-100 text-slate-700";
  if (days < 0) return "bg-red-100 text-red-700";
  if (days <= 30) return "bg-amber-100 text-amber-700";
  if (days <= 90) return "bg-yellow-50 text-yellow-700";
  return "bg-green-100 text-green-700";
}

export default function CertificationsPage() {
  const [certs, setCerts] = useState<Cert[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [filter, setFilter] = useState<"all" | "expiring" | "expired">("all");
  const [form, setForm] = useState({
    userId: "",
    type: "MEDICAL_LICENSE",
    title: "",
    issuingBody: "",
    certNumber: "",
    issuedDate: "",
    expiryDate: "",
    notes: "",
  });

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: Cert[] }>("/hr-ops/certifications");
      setCerts(res.data || []);
    } catch (e) {
      // Issue #61 — surface a real error instead of falsifying empty state.
      // The picker (/chat/users) supplies staff lookup itself.
      setCerts([]);
      toast.error(
        (e as Error)?.message || "Failed to load certifications"
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = certs.filter((c) => {
    const d = daysUntil(c.expiryDate);
    if (filter === "expiring") return d !== null && d >= 0 && d <= 30;
    if (filter === "expired") return d !== null && d < 0;
    return true;
  });

  const submit = async () => {
    if (!form.userId || !form.title) return;
    try {
      await api.post("/hr-ops/certifications", {
        userId: form.userId,
        type: form.type,
        title: form.title,
        issuingBody: form.issuingBody || undefined,
        certNumber: form.certNumber || undefined,
        issuedDate: form.issuedDate || undefined,
        expiryDate: form.expiryDate || undefined,
        notes: form.notes || undefined,
      });
      setShowModal(false);
      setForm({
        userId: "",
        type: "MEDICAL_LICENSE",
        title: "",
        issuingBody: "",
        certNumber: "",
        issuedDate: "",
        expiryDate: "",
        notes: "",
      });
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Award className="h-7 w-7 text-blue-600" />
          <div>
            <h1 className="text-2xl font-bold">Staff Certifications</h1>
            <p className="text-sm text-slate-600">
              Licenses, certifications and training records with expiry tracking.
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-3 py-2 rounded text-sm"
        >
          <Plus className="h-4 w-4" /> Add Certification
        </button>
      </div>

      <div className="flex gap-2 mb-4">
        {(["all", "expiring", "expired"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 text-sm rounded border ${
              filter === f
                ? "bg-blue-600 text-white border-blue-600"
                : "bg-white border-slate-200 text-slate-700"
            }`}
          >
            {f === "all" ? "All" : f === "expiring" ? "Expiring (<=30d)" : "Expired"}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="p-8 text-center text-slate-500">Loading...</div>
      ) : filtered.length === 0 ? (
        <div className="p-8 text-center text-slate-500 border border-dashed rounded-lg">
          No certifications found.
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600 uppercase">
              <tr>
                <th className="px-3 py-2 text-left">Staff</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-left">Title</th>
                <th className="px-3 py-2 text-left">Issuer</th>
                <th className="px-3 py-2 text-left">Cert #</th>
                <th className="px-3 py-2 text-left">Expiry</th>
                <th className="px-3 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const d = daysUntil(c.expiryDate);
                return (
                  <tr key={c.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{c.user?.name || c.userId.slice(0, 8)}</td>
                    <td className="px-3 py-2">
                      <span className="text-xs bg-slate-100 px-2 py-0.5 rounded">
                        {c.type.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-medium">{c.title}</td>
                    <td className="px-3 py-2 text-slate-600">{c.issuingBody || "—"}</td>
                    <td className="px-3 py-2 text-slate-600">{c.certNumber || "—"}</td>
                    <td className="px-3 py-2">
                      {c.expiryDate ? c.expiryDate.slice(0, 10) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${statusColor(
                          c
                        )}`}
                      >
                        {d !== null && d < 0 && <AlertTriangle className="h-3 w-3" />}
                        {d === null
                          ? "—"
                          : d < 0
                            ? `Expired ${-d}d ago`
                            : d === 0
                              ? "Expires today"
                              : `${d}d left`}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">Add Certification</h2>
              <button onClick={() => setShowModal(false)}>
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium">Staff member</label>
                {/* Issue #84: replace raw "paste a UUID" input with the
                    shared <EntityPicker>. Endpoint /auth/users accepts
                    `?search=` and returns `{ id, name, role }`. */}
                <EntityPicker
                  endpoint="/chat/users"
                  labelField="name"
                  subtitleField="role"
                  hintField="email"
                  value={form.userId}
                  onChange={(id) => setForm({ ...form, userId: id })}
                  searchPlaceholder="Search by name, email..."
                  testIdPrefix="cert-user-picker"
                  required
                />
              </div>
              <div>
                <label className="text-sm font-medium">Type</label>
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                  className="w-full border rounded px-3 py-2 text-sm"
                >
                  {CERT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-sm font-medium">Title</label>
                <input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  className="w-full border rounded px-3 py-2 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-sm font-medium">Issuing Body</label>
                  <input
                    value={form.issuingBody}
                    onChange={(e) => setForm({ ...form, issuingBody: e.target.value })}
                    className="w-full border rounded px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Cert Number</label>
                  <input
                    value={form.certNumber}
                    onChange={(e) => setForm({ ...form, certNumber: e.target.value })}
                    className="w-full border rounded px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Issued Date</label>
                  <input
                    type="date"
                    value={form.issuedDate}
                    onChange={(e) => setForm({ ...form, issuedDate: e.target.value })}
                    className="w-full border rounded px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Expiry Date</label>
                  <input
                    type="date"
                    value={form.expiryDate}
                    onChange={(e) => setForm({ ...form, expiryDate: e.target.value })}
                    className="w-full border rounded px-3 py-2 text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm font-medium">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full border rounded px-3 py-2 text-sm"
                  rows={2}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowModal(false)}
                className="px-3 py-2 text-sm text-slate-700"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                className="px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
