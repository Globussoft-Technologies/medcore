"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Upload, Edit2 } from "lucide-react";
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
  PUBLIC: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
  OPTIONAL: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  RESTRICTED: "bg-yellow-100 text-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-300",
};

// Shared styling for the Add/Edit-Holiday modal form controls. The modal
// renders on the dark dashboard layout, so without explicit colors the inputs
// inherit the layout's light text (dark:text-gray-100) and wash out; the dark
// variants give them a legible dark surface.
const MODAL_FIELD =
  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500";

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
  // Issue #692 (BUG-A08, 2026-05-09): per-row Edit. The form below is
  // re-used for both create + edit; `editingHoliday` flips the dialog
  // into PATCH mode and pre-fills the form fields. Null means we are
  // in create mode.
  const [editingHoliday, setEditingHoliday] = useState<Holiday | null>(null);

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

  async function saveHoliday() {
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
    const body = {
      date: form.date,
      name: nameCheck.value,
      type: form.type,
      description: form.description || undefined,
    };
    try {
      // Issue #692: Edit mode → PATCH /hr-ops/holidays/:id; create mode
      // continues to POST. Same form, same field-error handling, just
      // different verb + path.
      if (editingHoliday) {
        await api.patch(`/hr-ops/holidays/${editingHoliday.id}`, body);
        toast.success(`Updated "${body.name}"`);
      } else {
        await api.post("/hr-ops/holidays", body);
      }
      setShowForm(false);
      setEditingHoliday(null);
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

  // Issue #692: open the same form pre-populated with the row's data.
  function openEdit(h: Holiday) {
    setEditingHoliday(h);
    setHolidayFieldErrors({});
    setForm({
      // h.date is an ISO string from the server — strip the time portion
      // so the <input type="date"> accepts it.
      date: h.date.slice(0, 10),
      name: h.name,
      type: h.type,
      description: h.description || "",
    });
    setShowForm(true);
  }

  // Issue #726 (2026-05-08): the trash icon was already wired to this
  // handler, but the only feedback after a delete was the table reload.
  // Surface a success toast (and an explicit error toast on failure) so
  // the click is unambiguously confirmed.
  async function deleteHoliday(id: string, name: string) {
    if (
      !(await confirm({
        title: "Delete this holiday?",
        message: `"${name}" will be removed from the calendar.`,
        confirmLabel: "Delete",
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await api.delete(`/hr-ops/holidays/${id}`);
      toast.success(`Deleted "${name}"`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
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
            className="rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          >
            {Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - 2 + i).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <button
            onClick={importTemplate}
            className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
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

      <div className="rounded-xl bg-white shadow-sm dark:bg-gray-800">
        {loading ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">Loading...</div>
        ) : holidays.length === 0 ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">
            No holidays configured for {year}. Click &ldquo;Import Template&rdquo; to start.
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="border-b text-left text-xs text-gray-500 dark:border-gray-700 dark:text-gray-300">
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
                  <tr key={h.id} className="border-b last:border-0 text-sm dark:border-gray-700">
                    <td className="px-4 py-3 font-mono text-xs">
                      {d.toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
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
                    <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-300">
                      {h.description || "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => openEdit(h)}
                          data-testid={`holiday-edit-${h.id}`}
                          aria-label={`Edit ${h.name}`}
                          title={`Edit ${h.name}`}
                          className="rounded p-1 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                        >
                          <Edit2 size={14} />
                        </button>
                        <button
                          onClick={() => deleteHoliday(h.id, h.name)}
                          data-testid={`holiday-delete-${h.id}`}
                          aria-label={`Delete ${h.name}`}
                          title={`Delete ${h.name}`}
                          className="rounded p-1 text-red-500 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10"
                        >
                          <Trash2 size={14} />
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

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div
            className="w-full max-h-[90vh] overflow-y-auto max-w-md rounded-2xl bg-white p-6 text-gray-900 shadow-xl dark:bg-gray-800 dark:text-gray-100"
            data-testid="holiday-form-modal"
          >
            <h3 className="mb-4 text-lg font-semibold">
              {editingHoliday ? `Edit Holiday — ${editingHoliday.name}` : "Add Holiday"}
            </h3>
            <div className="space-y-3">
              <div>
                <label htmlFor="add-holiday-date" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
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
                  className={MODAL_FIELD}
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
                <label htmlFor="add-holiday-name" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
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
                  className={MODAL_FIELD}
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
                <label htmlFor="add-holiday-type" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                  Type
                </label>
                <select
                  id="add-holiday-type"
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                  className={MODAL_FIELD}
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="add-holiday-description" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                  Description
                </label>
                <textarea
                  id="add-holiday-description"
                  value={form.description}
                  onChange={(e) =>
                    setForm({ ...form, description: e.target.value })
                  }
                  rows={2}
                  className={MODAL_FIELD}
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowForm(false);
                  setEditingHoliday(null);
                  setForm({ date: "", name: "", type: "PUBLIC", description: "" });
                }}
                className="rounded-lg border px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={saveHoliday}
                data-testid="holiday-save"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                {editingHoliday ? "Update Holiday" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
