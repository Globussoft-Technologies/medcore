"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import { Save, FileText } from "lucide-react";

interface Template {
  id: string;
  type: string;
  channel: string;
  name: string;
  subject: string | null;
  body: string;
  isActive: boolean;
}

const NOTIFICATION_TYPES = [
  "APPOINTMENT_BOOKED",
  "APPOINTMENT_REMINDER",
  "APPOINTMENT_CANCELLED",
  "TOKEN_CALLED",
  "PRESCRIPTION_READY",
  "BILL_GENERATED",
  "PAYMENT_RECEIVED",
  "SCHEDULE_SUMMARY",
  "ADMISSION",
  "DISCHARGE",
  "LAB_RESULT_READY",
  "MEDICATION_DUE",
  "LOW_STOCK_ALERT",
];

const CHANNELS = ["WHATSAPP", "SMS", "EMAIL", "PUSH"];

const DEFAULT_BODIES: Record<string, string> = {
  APPOINTMENT_BOOKED: "Hi {{patientName}}, your appointment with {{doctorName}} is booked for {{date}} at {{time}}.",
  APPOINTMENT_REMINDER: "Reminder: appointment with {{doctorName}} on {{date}} at {{time}}.",
  APPOINTMENT_CANCELLED: "Your appointment on {{date}} has been cancelled.",
  TOKEN_CALLED: "Token {{tokenNumber}} — please proceed to {{room}}.",
  PRESCRIPTION_READY: "Your prescription is ready for collection.",
  BILL_GENERATED: "Bill {{invoiceNumber}} of {{amount}} has been generated.",
  PAYMENT_RECEIVED: "Payment of {{amount}} received. Thank you.",
  SCHEDULE_SUMMARY: "Your schedule summary for {{date}}.",
  ADMISSION: "Patient {{patientName}} admitted to {{ward}}.",
  DISCHARGE: "Patient {{patientName}} discharged on {{date}}.",
  LAB_RESULT_READY: "Lab results for {{testName}} are ready.",
  MEDICATION_DUE: "Medication {{medication}} due at {{time}}.",
  LOW_STOCK_ALERT: "Low stock alert: {{itemName}} ({{quantity}} left).",
};

export default function NotificationTemplatesPage() {
  const { user } = useAuthStore();
  const router = useRouter();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Template | null>(null);

  useEffect(() => {
    if (user && user.role !== "ADMIN") {
      router.push("/dashboard");
    }
  }, [user, router]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: Template[] }>("/notifications/templates");
      setTemplates(res.data);
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Build a matrix indexed by type+channel
  const indexed = new Map<string, Template>();
  templates.forEach((t) => indexed.set(`${t.type}_${t.channel}`, t));

  async function saveTemplate() {
    if (!editing) return;
    try {
      if (editing.id) {
        await api.put(`/notifications/templates/${editing.id}`, {
          name: editing.name,
          subject: editing.subject,
          body: editing.body,
          isActive: editing.isActive,
        });
      } else {
        await api.post("/notifications/templates", {
          type: editing.type,
          channel: editing.channel,
          name: editing.name || `${editing.type} - ${editing.channel}`,
          subject: editing.subject || undefined,
          body: editing.body,
          isActive: editing.isActive,
        });
      }
      toast.success("Template saved");
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  }

  if (loading) return <p>Loading...</p>;

  return (
    <div>
      <h1 className="mb-6 flex items-center gap-2 text-2xl font-bold">
        <FileText size={22} /> Notification Templates
      </h1>

      <div className="overflow-x-auto rounded-xl bg-white shadow-sm dark:bg-gray-800">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500 dark:bg-gray-700">
            <tr>
              <th className="px-4 py-3">Type</th>
              {CHANNELS.map((c) => (
                <th key={c} className="px-4 py-3">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {NOTIFICATION_TYPES.map((type) => (
              <tr key={type} className="border-t border-gray-100 dark:border-gray-700">
                <td className="px-4 py-3 font-medium">{type}</td>
                {CHANNELS.map((channel) => {
                  const t = indexed.get(`${type}_${channel}`);
                  return (
                    <td key={channel} className="px-4 py-3">
                      <button
                        onClick={() =>
                          setEditing(
                            t || {
                              id: "",
                              type,
                              channel,
                              name: `${type} - ${channel}`,
                              subject: channel === "EMAIL" ? type.replace(/_/g, " ") : null,
                              body: DEFAULT_BODIES[type] || "",
                              isActive: true,
                            }
                          )
                        }
                        className={
                          "rounded px-2 py-1 text-xs " +
                          (t
                            ? "bg-primary/10 text-primary hover:bg-primary/20"
                            : "border border-dashed border-gray-300 text-gray-400 hover:border-primary hover:text-primary")
                        }
                      >
                        {t ? "Edit" : "Add"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800">
            <h2 className="mb-4 text-lg font-semibold">
              {editing.type} — {editing.channel}
            </h2>
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                  Template Name
                </label>
                <input
                  type="text"
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
                />
              </div>
              {editing.channel === "EMAIL" && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                    Subject
                  </label>
                  <input
                    type="text"
                    value={editing.subject || ""}
                    onChange={(e) => setEditing({ ...editing, subject: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-600 dark:bg-gray-900"
                  />
                </div>
              )}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                  Body (use {`{{variableName}}`} placeholders)
                </label>
                <textarea
                  rows={5}
                  value={editing.body}
                  onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm dark:border-gray-600 dark:bg-gray-900"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={editing.isActive}
                  onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })}
                />
                Active
              </label>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setEditing(null)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm dark:border-gray-600"
              >
                Cancel
              </button>
              <button
                onClick={saveTemplate}
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                <Save size={14} /> Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
