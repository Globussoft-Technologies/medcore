"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { ShieldAlert, Download, FileWarning, ListTree } from "lucide-react";
import { formatDoctorName } from "@/lib/format-doctor-name";

interface CsEntry {
  id: string;
  entryNumber: string;
  dispensedAt: string;
  quantity: number;
  balance: number;
  notes?: string | null;
  medicine: { id: string; name: string; scheduleClass?: string | null; strength?: string | null; form?: string | null };
  patient?: { id: string; mrNumber: string; user: { name: string } } | null;
  doctor?: { id: string; user: { name: string } } | null;
  user: { id: string; name: string; role: string };
}

interface MedicineSummary {
  id: string;
  name: string;
  scheduleClass?: string | null;
  strength?: string | null;
  form?: string | null;
  requiresRegister?: boolean;
}

interface AuditRow {
  medicineId: string;
  medicineName?: string;
  scheduleClass?: string | null;
  totalDispensed: number;
  entryCount: number;
  currentOnHand: number;
  registerBalance: number | null;
  discrepancy: number | null;
}

type Tab = "entries" | "register" | "audit";

export default function ControlledSubstancesPage() {
  const { user } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = useState<Tab>("entries");
  const [entries, setEntries] = useState<CsEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [medicines, setMedicines] = useState<MedicineSummary[]>([]);
  const [medicineFilter, setMedicineFilter] = useState<string>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [registerData, setRegisterData] = useState<{
    medicine: MedicineSummary;
    currentOnHand: number;
    entries: CsEntry[];
  } | null>(null);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);

  // RBAC (issue #98): Schedule H/H1/X register is regulated. ADMIN +
  // PHARMACIST + DOCTOR may view/record entries. RECEPTION used to be
  // allowed and is now blocked — redirect them away with a toast so a stale
  // bookmark doesn't render an empty page.
  const canView =
    user?.role === "ADMIN" ||
    user?.role === "PHARMACIST" ||
    user?.role === "DOCTOR";

  useEffect(() => {
    if (user && !canView) {
      // Issue #179: target /dashboard/not-authorized so the user keeps the
      // sidebar/app shell instead of getting bounced to the dashboard home.
      toast.error("Controlled Substance Register is restricted to clinical and pharmacy roles.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/controlled-substances")}`,
      );
    }
  }, [user, canView, router, pathname]);

  // Load medicines flagged as requiresRegister (paginate all via search)
  useEffect(() => {
    if (!canView) return;
    (async () => {
      try {
        const resp = await api.get<{ data: MedicineSummary[] }>(
          "/medicines?limit=100"
        );
        // Backend returns all medicines; filter on client by requiresRegister if present
        const filtered = (resp.data ?? []).filter((m) => (m as any).requiresRegister);
        setMedicines(filtered);
      } catch (e) {
        console.error(e);
      }
    })();
  }, [canView]);

  const loadEntries = async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (medicineFilter) qs.set("medicineId", medicineFilter);
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      const resp = await api.get<{ data: CsEntry[] }>(
        `/controlled-substances?${qs.toString()}`
      );
      setEntries(resp.data ?? []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const loadRegister = async () => {
    if (!medicineFilter) {
      setRegisterData(null);
      return;
    }
    setLoading(true);
    try {
      const resp = await api.get<{
        data: { medicine: MedicineSummary; currentOnHand: number; entries: CsEntry[] };
      }>(`/controlled-substances/register/${medicineFilter}`);
      setRegisterData(resp.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const loadAudit = async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      const resp = await api.get<{
        data: { rows: AuditRow[]; discrepancies: AuditRow[] };
      }>(`/controlled-substances/audit-report?${qs.toString()}`);
      setAuditRows(resp.data.rows ?? []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!canView) return;
    if (tab === "entries") loadEntries();
    else if (tab === "register") loadRegister();
    else if (tab === "audit") loadAudit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, canView, medicineFilter, from, to]);

  const csv = useMemo(() => {
    const rows = [
      ["Entry #", "Date", "Medicine", "Quantity", "Balance", "Patient", "Doctor", "Dispensed By"],
      ...entries.map((e) => [
        e.entryNumber,
        new Date(e.dispensedAt).toISOString(),
        `${e.medicine.name}${e.medicine.strength ? " " + e.medicine.strength : ""}`,
        String(e.quantity),
        String(e.balance),
        e.patient?.user.name ?? "",
        e.doctor?.user.name ?? "",
        e.user.name,
      ]),
    ];
    return rows.map((r) => r.map((c) => `"${(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
  }, [entries]);

  const downloadCsv = () => {
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `controlled-substances-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!canView) {
    return (
      <div className="rounded-lg border border-red-300 bg-red-50 p-6">
        <p className="text-red-700">
          Access denied. This page is for Admin and Reception only.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <ShieldAlert className="text-red-600" size={28} />
        <div>
          <h1 className="text-2xl font-bold">Controlled Substance Register</h1>
          <p className="text-sm text-gray-500">Schedule H / H1 / X narcotic and controlled drug tracking.</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-2 border-b">
        {([
          { k: "entries", label: "All Entries", icon: ListTree },
          { k: "register", label: "Register by Medicine", icon: ShieldAlert },
          { k: "audit", label: "Audit Report", icon: FileWarning },
        ] as const).map(({ k, label, icon: Icon }) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium ${
              tab === k
                ? "border-primary text-primary"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border bg-white p-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Medicine</label>
          <select
            className="rounded border px-3 py-1.5 text-sm"
            value={medicineFilter}
            onChange={(e) => setMedicineFilter(e.target.value)}
          >
            <option value="">All controlled medicines</option>
            {medicines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} {m.strength ?? ""} {m.scheduleClass ? `[${m.scheduleClass}]` : ""}
              </option>
            ))}
          </select>
        </div>
        {tab !== "register" && (
          <>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">From</label>
              <input
                type="date"
                className="rounded border px-3 py-1.5 text-sm"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">To</label>
              <input
                type="date"
                className="rounded border px-3 py-1.5 text-sm"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </>
        )}
        {tab === "entries" && (
          <button
            onClick={downloadCsv}
            className="ml-auto flex items-center gap-2 rounded bg-primary px-3 py-1.5 text-sm text-white"
          >
            <Download size={14} /> Export CSV
          </button>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : tab === "entries" ? (
        <EntryTable entries={entries} />
      ) : tab === "register" ? (
        !medicineFilter ? (
          <p className="text-gray-500">Choose a medicine above to view its register.</p>
        ) : !registerData ? (
          <p className="text-gray-500">No data</p>
        ) : (
          <div>
            <div className="mb-3 rounded border bg-blue-50 p-3 text-sm">
              <strong>{registerData.medicine.name}</strong> {registerData.medicine.strength ?? ""}{" "}
              {registerData.medicine.scheduleClass
                ? `— Schedule ${registerData.medicine.scheduleClass}`
                : ""}
              <div>Current on-hand: <strong>{registerData.currentOnHand}</strong></div>
            </div>
            <EntryTable entries={registerData.entries} />
          </div>
        )
      ) : (
        <AuditTable rows={auditRows} />
      )}
    </div>
  );
}

function EntryTable({ entries }: { entries: CsEntry[] }) {
  if (entries.length === 0)
    return <p className="text-gray-500">No entries match the filter.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border bg-white">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
          <tr>
            <th className="p-2">Entry #</th>
            <th className="p-2">Date</th>
            <th className="p-2">Medicine</th>
            <th className="p-2">Qty</th>
            <th className="p-2">Balance</th>
            <th className="p-2">Patient</th>
            <th className="p-2">Doctor</th>
            <th className="p-2">Dispensed By</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-t hover:bg-gray-50">
              <td className="p-2 font-mono text-xs">{e.entryNumber}</td>
              <td className="p-2">{new Date(e.dispensedAt).toLocaleString()}</td>
              <td className="p-2">
                {e.medicine.name}
                {e.medicine.strength ? ` ${e.medicine.strength}` : ""}
                {e.medicine.scheduleClass ? (
                  <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700">
                    {e.medicine.scheduleClass}
                  </span>
                ) : null}
              </td>
              <td className="p-2 font-semibold">{e.quantity}</td>
              <td className="p-2">{e.balance}</td>
              <td className="p-2">
                {e.patient ? (
                  <>
                    {e.patient.user.name}
                    <div className="text-xs text-gray-500">{e.patient.mrNumber}</div>
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td className="p-2">{e.doctor?.user.name ? formatDoctorName(e.doctor.user.name) : "—"}</td>
              <td className="p-2">{e.user.name}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditTable({ rows }: { rows: AuditRow[] }) {
  if (rows.length === 0)
    return <p className="text-gray-500">No register activity in the selected window.</p>;
  return (
    <div className="overflow-x-auto rounded-lg border bg-white">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
          <tr>
            <th className="p-2">Medicine</th>
            <th className="p-2">Schedule</th>
            <th className="p-2">Entries</th>
            <th className="p-2">Total Dispensed</th>
            <th className="p-2">Register Balance</th>
            <th className="p-2">On-hand</th>
            <th className="p-2">Discrepancy</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.medicineId}
              className={`border-t ${
                r.discrepancy !== null && r.discrepancy !== 0 ? "bg-red-50" : ""
              }`}
            >
              <td className="p-2 font-medium">{r.medicineName ?? r.medicineId}</td>
              <td className="p-2">{r.scheduleClass ?? "—"}</td>
              <td className="p-2">{r.entryCount}</td>
              <td className="p-2">{r.totalDispensed}</td>
              <td className="p-2">{r.registerBalance ?? "—"}</td>
              <td className="p-2">{r.currentOnHand}</td>
              <td
                className={`p-2 font-semibold ${
                  r.discrepancy === null
                    ? ""
                    : r.discrepancy === 0
                      ? "text-green-700"
                      : "text-red-700"
                }`}
              >
                {r.discrepancy ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
