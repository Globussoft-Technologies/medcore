"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { extractFieldErrors } from "@/lib/field-errors";
import { useConfirm } from "@/lib/use-dialog";
import { useAuthStore } from "@/lib/store";
import { sanitizeUserInput } from "@medcore/shared";

interface Holiday {
  id: string;
  date: string;
  name: string;
  type: string;
  description?: string | null;
}

const TYPES = ["PUBLIC", "OPTIONAL", "RESTRICTED"];

const TYPE_COLORS: Record<string, string> = {
  PUBLIC: "bg-red-100 text-red-700",
  OPTIONAL: "bg-blue-100 text-blue-700",
  RESTRICTED: "bg-yellow-100 text-yellow-800",
};

// Common Indian holiday templates (Issue #72 — corrected 2026 calendar:
// Holi 4-Mar, Eid al-Fitr 21-Mar, Diwali 8-Nov, plus the missing festivals).
const HOLIDAY_TEMPLATE: Array<{
  date: string;
  name: string;
  type: string;
}> = [
  { date: "01-26", name: "Republic Day", type: "PUBLIC" },
  { date: "03-04", name: "Holi", type: "PUBLIC" },
  { date: "03-21", name: "Eid al-Fitr", type: "PUBLIC" },
  { date: "03-26", name: "Ram Navami", type: "OPTIONAL" },
  { date: "03-31", name: "Mahavir Jayanti", type: "OPTIONAL" },
  { date: "04-03", name: "Good Friday", type: "PUBLIC" },
  { date: "04-14", name: "Dr. Ambedkar Jayanti", type: "PUBLIC" },
  { date: "05-01", name: "Buddha Purnima", type: "OPTIONAL" },
  { date: "05-27", name: "Eid al-Adha", type: "PUBLIC" },
  { date: "08-15", name: "Independence Day", type: "PUBLIC" },
  { date: "09-04", name: "Janmashtami", type: "OPTIONAL" },
  { date: "10-02", name: "Gandhi Jayanti", type: "PUBLIC" },
  { date: "10-20", name: "Dussehra", type: "PUBLIC" },
  { date: "11-08", name: "Diwali", type: "PUBLIC" },
  { date: "12-25", name: "Christmas", type: "PUBLIC" },
];

export default function HolidaysPage() {
  const { user } = useAuthStore();
  const router = useRouter();
  const confirm = useConfirm();
  const [year, setYear] = useState(new Date().getFullYear());
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    date: "",
    name: "",
    type: "PUBLIC",
    description: "",
  });

  useEffect(() => {
    if (user && user.role !== "ADMIN") {
      router.push("/dashboard");
    }
  }, [user, router]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: Holiday[] }>(
        `/hr-ops/holidays?year=${year}`
      );
      setHolidays(res.data);
    } catch {
      setHolidays([]);
    }
    setLoading(false);
  }, [year]);

  useEffect(() => {
    if (user?.role === "ADMIN") load();
  }, [load, user]);

  // Issue #293 (2026-04-26): replace the generic "Validation failed" toast
  // with field-level errors. Use `extractFieldErrors` so the user sees
  // "Date must be YYYY-MM-DD" / "Name is required" next to the offending
  // input rather than a flat surface-level message.
  const [holidayFieldErrors, setHolidayFieldErrors] = useState<{
    date?: string;
    name?: string;
    type?: string;
  }>({});

  async function createHoliday() {
    setHolidayFieldErrors({});
    const errs: typeof holidayFieldErrors = {};
    if (!form.date) errs.date = "Date is required";
    // Issue #292 (Apr 2026): the previous server-side "partial strip" let
    // `Test Holiday <script>alert(1)</script>` persist as the very weird
    // `Test Holiday alert(1)`. Reject XSS vectors outright instead.
    const nameCheck = sanitizeUserInput(form.name, {
      field: "Name",
      maxLength: 200,
    });
    if (!nameCheck.ok) errs.name = nameCheck.error || "Name is required";
    if (Object.keys(errs).length > 0) {
      setHolidayFieldErrors(errs);
      return;
    }
    try {
      await api.post("/hr-ops/holidays", {
        date: form.date,
        name: nameCheck.value,
        type: form.type,
        description: form.description || undefined,
      });
      setShowForm(false);
      setForm({ date: "", name: "", type: "PUBLIC", description: "" });
      load();
    } catch (err) {
      const fields = extractFieldErrors(err);
      if (fields) {
        setHolidayFieldErrors(fields as typeof holidayFieldErrors);
      } else {
        toast.error(err instanceof Error ? err.message : "Failed");
      }
    }
  }

  async function deleteHoliday(id: string) {
    if (!(await confirm({ title: "Delete this holiday?", danger: true }))) return;
    try {
      await api.delete(`/hr-ops/holidays/${id}`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function importTemplate() {
    if (!(await confirm({ title: `Import ${HOLIDAY_TEMPLATE.length} common Indian holidays for ${year}?` })))
      return;
    let added = 0;
    let skipped = 0;
    for (const h of HOLIDAY_TEMPLATE) {
      const date = `${year}-${h.date}`;
      // Skip if already exists on that date
      if (holidays.some((x) => x.date.startsWith(date))) {
        skipped++;
        continue;
      }
      try {
        await api.post("/hr-ops/holidays", {
          date,
          name: h.name,
          type: h.type,
        });
        added++;
      } catch {
        skipped++;
      }
    }
    toast.success(`Added ${added} holidays. Skipped ${skipped} (already exist or failed).`);
    load();
  }

  if (user && user.role !== "ADMIN") return null;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Holidays</h1>
        <div className="flex items-center gap-2">
          <select
            value={year}
            onChange={(e) => setYear(parseInt(e.target.value, 10))}
            className="rounded-lg border bg-white px-3 py-2 text-sm"
          >
            {Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - 2 + i).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <button
            onClick={importTemplate}
            className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2 text-sm hover:bg-gray-50"
          >
            <Upload size={14} /> Import Template
          </button>
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <Plus size={16} /> Add Holiday
          </button>
        </div>
      </div>

      <div className="rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : holidays.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No holidays configured for {year}. Click &ldquo;Import Template&rdquo; to start.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-xs text-gray-500">
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Day</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {holidays.map((h) => {
                const d = new Date(h.date);
                return (
                  <tr key={h.id} className="border-b last:border-0 text-sm">
                    <td className="px-4 py-3 font-mono text-xs">
                      {d.toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {d.toLocaleDateString("en-IN", { weekday: "long" })}
                    </td>
                    <td className="px-4 py-3 font-medium">{h.name}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          TYPE_COLORS[h.type] || "bg-gray-100"
                        }`}
                      >
                        {h.type}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-600">
                      {h.description || "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => deleteHoliday(h.id)}
                        className="rounded p-1 text-red-500 hover:bg-red-50"
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="mb-4 text-lg font-semibold">Add Holiday</h3>
            <div className="space-y-3">
              <div>
                <label htmlFor="add-holiday-date" className="mb-1 block text-xs font-medium text-gray-600">
                  Date
                </label>
                <input
                  id="add-holiday-date"
                  type="date"
                  value={form.date}
                  onChange={(e) => {
                    setForm({ ...form, date: e.target.value });
                    if (holidayFieldErrors.date)
                      setHolidayFieldErrors((p) => ({ ...p, date: undefined }));
                  }}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  data-testid="holiday-date"
                />
                {holidayFieldErrors.date && (
                  <p
                    className="mt-1 text-xs text-red-600"
                    data-testid="error-date"
                  >
                    {holidayFieldErrors.date}
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="add-holiday-name" className="mb-1 block text-xs font-medium text-gray-600">
                  Name
                </label>
                <input
                  id="add-holiday-name"
                  value={form.name}
                  onChange={(e) => {
                    setForm({ ...form, name: e.target.value });
                    if (holidayFieldErrors.name)
                      setHolidayFieldErrors((p) => ({ ...p, name: undefined }));
                  }}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  data-testid="holiday-name"
                />
                {holidayFieldErrors.name && (
                  <p
                    className="mt-1 text-xs text-red-600"
                    data-testid="error-name"
                  >
                    {holidayFieldErrors.name}
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="add-holiday-type" className="mb-1 block text-xs font-medium text-gray-600">
                  Type
                </label>
                <select
                  id="add-holiday-type"
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="add-holiday-description" className="mb-1 block text-xs font-medium text-gray-600">
                  Description
                </label>
                <textarea
                  id="add-holiday-description"
                  value={form.description}
                  onChange={(e) =>
                    setForm({ ...form, description: e.target.value })
                  }
                  rows={2}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowForm(false)}
                className="rounded-lg border px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={createHoliday}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
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
