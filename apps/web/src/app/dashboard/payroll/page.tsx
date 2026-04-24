"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Calculator, Loader2 } from "lucide-react";
import { api, openPrintEndpoint } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";

interface Staff {
  id: string;
  name: string;
  role: string;
  email?: string;
}

interface PayrollRow {
  userId: string;
  year: number;
  month: number;
  basicSalary: number;
  allowances: number;
  deductions: number;
  absentPenalty: number;
  overtimeShifts: number;
  overtimePay: number;
  workedDays: number;
  scheduledDays: number;
  gross: number;
  net: number;
}

interface Settings {
  basicSalary: string;
  allowances: string;
  deductions: string;
  overtimeRate: string;
}

const DEFAULT_SALARY: Record<string, number> = {
  DOCTOR: 80000,
  NURSE: 30000,
  RECEPTION: 20000,
  ADMIN: 50000,
};

function fmtMoney(n: number) {
  return `Rs. ${n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function currentMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function PayrollPage() {
  const { user } = useAuthStore();
  const router = useRouter();
  const [staff, setStaff] = useState<Staff[]>([]);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState<string>(currentMonthStr());
  const [results, setResults] = useState<Record<string, PayrollRow>>({});
  const [settings, setSettings] = useState<Record<string, Settings>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [bulkRunning, setBulkRunning] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"payroll" | "overtime">("payroll");

  useEffect(() => {
    if (user && user.role !== "ADMIN") {
      router.push("/dashboard");
    }
  }, [user, router]);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await api.get<{ data: Staff[] }>("/chat/users");
        const list = res.data.filter(
          (u) => u.role !== "PATIENT" && u.role !== "ADMIN" ? true : u.role === "ADMIN"
        );
        setStaff(list);
        const defaults: Record<string, Settings> = {};
        for (const s of list) {
          defaults[s.id] = {
            basicSalary: String(DEFAULT_SALARY[s.role] || 25000),
            allowances: "0",
            deductions: "0",
            overtimeRate: "250",
          };
        }
        setSettings(defaults);
      } catch {
        setStaff([]);
      }
      setLoading(false);
    }
    if (user?.role === "ADMIN") load();
  }, [user]);

  async function calculate(s: Staff) {
    const cfg = settings[s.id];
    if (!cfg) return;
    setPending((p) => ({ ...p, [s.id]: true }));
    try {
      const [y, m] = month.split("-").map((n) => parseInt(n, 10));
      const res = await api.post<{ data: PayrollRow }>("/hr-ops/payroll", {
        userId: s.id,
        year: y,
        month: m,
        basicSalary: parseFloat(cfg.basicSalary) || 0,
        allowances: parseFloat(cfg.allowances) || 0,
        deductions: parseFloat(cfg.deductions) || 0,
        overtimeRate: parseFloat(cfg.overtimeRate) || 0,
      });
      setResults((r) => ({ ...r, [s.id]: res.data }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
    setPending((p) => ({ ...p, [s.id]: false }));
  }

  async function generateAll() {
    setBulkRunning(true);
    for (const s of staff) {
      await calculate(s);
    }
    setBulkRunning(false);
  }

  function exportCSV() {
    const rows: string[][] = [
      [
        "Name",
        "Role",
        "Month",
        "Basic",
        "Allowances",
        "Overtime Pay",
        "Deductions",
        "Absent Penalty",
        "Gross",
        "Net",
      ],
    ];
    for (const s of staff) {
      const r = results[s.id];
      const cfg = settings[s.id];
      rows.push([
        s.name,
        s.role,
        month,
        cfg?.basicSalary || "",
        r ? String(r.allowances) : "",
        r ? String(r.overtimePay) : "",
        r ? String(r.deductions) : "",
        r ? String(r.absentPenalty) : "",
        r ? String(r.gross) : "",
        r ? String(r.net) : "",
      ]);
    }
    const csv = rows
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payroll-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function updateSetting(id: string, key: keyof Settings, v: string) {
    setSettings((s) => ({ ...s, [id]: { ...s[id], [key]: v } }));
  }

  if (user && user.role !== "ADMIN") return null;

  return (
    <div>
      <div className="mb-4 flex gap-2 border-b border-slate-200">
        <button
          onClick={() => setActiveTab("payroll")}
          className={`px-3 py-2 text-sm border-b-2 -mb-0.5 ${
            activeTab === "payroll"
              ? "border-primary text-primary font-semibold"
              : "border-transparent text-slate-600"
          }`}
        >
          Payroll
        </button>
        <button
          onClick={() => setActiveTab("overtime")}
          className={`px-3 py-2 text-sm border-b-2 -mb-0.5 ${
            activeTab === "overtime"
              ? "border-primary text-primary font-semibold"
              : "border-transparent text-slate-600"
          }`}
        >
          Overtime
        </button>
      </div>

      {activeTab === "overtime" ? (
        <OvertimePanel month={month} onMonthChange={setMonth} />
      ) : (
      <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Payroll</h1>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded-lg border bg-white px-3 py-2 text-sm"
          />
          <button
            onClick={generateAll}
            disabled={bulkRunning || staff.length === 0}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
          >
            {bulkRunning ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Calculator size={16} />
            )}
            Generate All
          </button>
          <button
            onClick={exportCSV}
            className="flex items-center gap-2 rounded-lg border bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Download size={16} /> Export CSV
          </button>
        </div>
      </div>

      <div className="rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading staff...</div>
        ) : staff.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No staff found</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b text-left text-xs text-gray-500">
                  <th className="px-3 py-3">Name</th>
                  <th className="px-3 py-3">Role</th>
                  <th className="px-3 py-3">Basic</th>
                  <th className="px-3 py-3">Allowances</th>
                  <th className="px-3 py-3">OT Rate</th>
                  <th className="px-3 py-3">Deductions</th>
                  <th className="px-3 py-3">Overtime</th>
                  <th className="px-3 py-3">Penalty</th>
                  <th className="px-3 py-3">Net Pay</th>
                  <th className="px-3 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((s) => {
                  const cfg = settings[s.id];
                  const r = results[s.id];
                  const isEditing = editingId === s.id;
                  return (
                    <tr key={s.id} className="border-b last:border-0 text-sm">
                      <td className="px-3 py-3 font-medium">{s.name}</td>
                      <td className="px-3 py-3 text-xs text-gray-600">
                        {s.role}
                      </td>
                      <td className="px-3 py-3">
                        {isEditing ? (
                          <input
                            value={cfg.basicSalary}
                            onChange={(e) =>
                              updateSetting(s.id, "basicSalary", e.target.value)
                            }
                            className="w-24 rounded border px-2 py-1 text-xs"
                          />
                        ) : (
                          fmtMoney(parseFloat(cfg?.basicSalary || "0"))
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {isEditing ? (
                          <input
                            value={cfg.allowances}
                            onChange={(e) =>
                              updateSetting(s.id, "allowances", e.target.value)
                            }
                            className="w-20 rounded border px-2 py-1 text-xs"
                          />
                        ) : (
                          fmtMoney(parseFloat(cfg?.allowances || "0"))
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {isEditing ? (
                          <input
                            value={cfg.overtimeRate}
                            onChange={(e) =>
                              updateSetting(s.id, "overtimeRate", e.target.value)
                            }
                            className="w-20 rounded border px-2 py-1 text-xs"
                          />
                        ) : (
                          `Rs. ${cfg?.overtimeRate || 0}/h`
                        )}
                      </td>
                      <td className="px-3 py-3">
                        {isEditing ? (
                          <input
                            value={cfg.deductions}
                            onChange={(e) =>
                              updateSetting(s.id, "deductions", e.target.value)
                            }
                            className="w-20 rounded border px-2 py-1 text-xs"
                          />
                        ) : (
                          fmtMoney(parseFloat(cfg?.deductions || "0"))
                        )}
                      </td>
                      <td className="px-3 py-3 text-xs">
                        {r ? (
                          <>
                            {r.overtimeShifts} shifts ·{" "}
                            <span className="font-semibold">
                              {fmtMoney(r.overtimePay)}
                            </span>
                          </>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="px-3 py-3 text-xs text-orange-600">
                        {r ? fmtMoney(r.absentPenalty) : "-"}
                      </td>
                      <td className="px-3 py-3 font-semibold text-green-700">
                        {r ? fmtMoney(r.net) : "-"}
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex gap-1">
                          <button
                            onClick={() =>
                              setEditingId(isEditing ? null : s.id)
                            }
                            className="rounded border px-2 py-1 text-xs hover:bg-gray-50"
                          >
                            {isEditing ? "Done" : "Edit"}
                          </button>
                          <button
                            onClick={() => calculate(s)}
                            disabled={pending[s.id]}
                            className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs text-white hover:bg-primary-dark disabled:opacity-50"
                          >
                            {pending[s.id] ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Calculator size={12} />
                            )}
                            Calculate
                          </button>
                          <button
                            onClick={() =>
                              openPrintEndpoint(
                                `/hr-ops/payroll/${s.id}/slip?month=${month}`
                              )
                            }
                            className="flex items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-gray-50"
                            title="Print pay slip"
                          >
                            <Download size={12} /> Slip
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}

interface OvertimeRow {
  id: string;
  userId: string;
  date: string;
  regularHours: number;
  overtimeHours: number;
  hourlyRate: number;
  overtimeRate: number;
  amount: number;
  approved: boolean;
  notes: string | null;
  user?: { id: string; name: string; role: string };
}

function OvertimePanel({
  month,
  onMonthChange,
}: {
  month: string;
  onMonthChange: (m: string) => void;
}) {
  const [rows, setRows] = useState<OvertimeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: OvertimeRow[] }>(
        `/hr-ops/overtime?month=${month}`
      );
      setRows(res.data || []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [month]);

  const autoCalc = async () => {
    setRunning(true);
    try {
      const [y, m] = month.split("-").map((x) => parseInt(x, 10));
      await api.post("/hr-ops/overtime/auto-calculate", {
        year: y,
        month: m,
        defaultHourlyRate: 250,
        regularHoursPerDay: 8,
        overtimeRate: 1.5,
      });
      load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const approve = async (id: string) => {
    await api.patch(`/hr-ops/overtime/${id}/approve`, {});
    load();
  };

  const totalPending = rows
    .filter((r) => !r.approved)
    .reduce((s, r) => s + r.amount, 0);
  const totalApproved = rows
    .filter((r) => r.approved)
    .reduce((s, r) => s + r.amount, 0);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Overtime</h1>
          <p className="text-sm text-slate-500">
            {rows.length} records - pending Rs. {totalPending.toFixed(2)} - approved Rs. {totalApproved.toFixed(2)}
          </p>
        </div>
        <div className="flex gap-2">
          <input
            type="month"
            value={month}
            onChange={(e) => onMonthChange(e.target.value)}
            className="rounded-lg border bg-white px-3 py-2 text-sm"
          />
          <button
            onClick={autoCalc}
            disabled={running}
            className="px-3 py-2 text-sm bg-blue-600 text-white rounded disabled:opacity-50"
          >
            {running ? "Calculating..." : "Auto-calculate from shifts"}
          </button>
        </div>
      </div>

      <div className="rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-slate-500">Loading...</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-slate-500">No overtime records.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-slate-500">
                <th className="px-3 py-2">Staff</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2 text-right">Reg Hrs</th>
                <th className="px-3 py-2 text-right">OT Hrs</th>
                <th className="px-3 py-2 text-right">Rate</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{r.user?.name || r.userId.slice(0, 8)}</td>
                  <td className="px-3 py-2">{r.date.slice(0, 10)}</td>
                  <td className="px-3 py-2 text-right">{r.regularHours.toFixed(1)}</td>
                  <td className="px-3 py-2 text-right">{r.overtimeHours.toFixed(1)}</td>
                  <td className="px-3 py-2 text-right">
                    Rs. {r.hourlyRate} x {r.overtimeRate}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold">
                    Rs. {r.amount.toFixed(2)}
                  </td>
                  <td className="px-3 py-2">
                    {r.approved ? (
                      <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">
                        Approved
                      </span>
                    ) : (
                      <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded">
                        Pending
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {!r.approved && (
                      <button
                        onClick={() => approve(r.id)}
                        className="text-xs px-2 py-1 bg-blue-600 text-white rounded"
                      >
                        Approve
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )