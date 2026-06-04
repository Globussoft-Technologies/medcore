"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { formatDoctorName } from "@/lib/format-doctor-name";
import { toast } from "@/lib/toast";
import { Calendar, CheckCircle, Clock, Loader2, RefreshCw, User } from "lucide-react";
import { SkeletonCard } from "@/components/Skeleton";

// ─── Types ──────────────────────────────────────────────────

interface FollowUpSuggestion {
  consultationId: string;
  suggestedDate: string;
  slotStart: string | null;
  doctorId: string;
  reason: string;
  fallbackUsed: boolean;
}

interface ConsultationRow {
  id: string;
  appointmentId: string;
  notes: string | null;
  doctor: { user: { name: string } };
  appointment: {
    patient: { id: string; mrNumber: string; user: { name: string } };
  };
}

// ─── Page ───────────────────────────────────────────────────

export default function AIFollowupPage() {
  const [rows, setRows] = useState<ConsultationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [suggestions, setSuggestions] = useState<Record<string, FollowUpSuggestion | null>>({});
  const [bookingId, setBookingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api
        .get<any>("/ai/followup/consultations?limit=20")
        .catch(() => ({ data: { consultations: [] } }));
      setRows((data?.data?.consultations ?? []) as ConsultationRow[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function suggestFor(cid: string) {
    try {
      const res = await api.post<any>(`/ai/followup/suggest/${cid}`);
      const suggestion = res.data?.suggestion ?? null;
      if (!suggestion) {
        // Server returned 200 with suggestion=null (e.g. no follow-up timeline
        // documented in notes). Without surfacing the reason, the button would
        // appear to do nothing on repeat clicks.
        toast.error(res.data?.reason ?? "No follow-up suggestion available");
        return;
      }
      if (!suggestion.slotStart) {
        toast.error("No available slot on the suggested date");
      }
      setSuggestions((m) => ({ ...m, [cid]: suggestion }));
    } catch (err: any) {
      toast.error(err?.payload?.error ?? err?.message ?? "Suggestion failed");
    }
  }

  async function book(cid: string) {
    setBookingId(cid);
    try {
      await api.post<any>(`/ai/followup/${cid}/book`, {});
      toast.success("Follow-up booked");
      setSuggestions((m) => ({ ...m, [cid]: null }));
      await load();
    } catch (err: any) {
      toast.error(err?.payload?.error ?? err?.message ?? "Booking failed");
    } finally {
      setBookingId(null);
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-sky-50 flex items-center justify-center">
            <Calendar className="w-6 h-6 text-sky-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Smart Follow-up Suggestions</h1>
            <p className="text-sm text-gray-500">
              Review AI-computed follow-up slots and book with one click.
            </p>
          </div>
        </div>
        <button
          onClick={load}
          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border text-sm hover:bg-gray-50"
        >
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </header>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-gray-500 py-10 text-center">
          No recent consultations found.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((c) => {
            const suggestion = suggestions[c.id];
            return (
              <article
                key={c.id}
                data-testid="followup-row"
                className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <User className="w-4 h-4 text-gray-400" />
                      <h3 className="font-semibold text-gray-900">
                        {c.appointment?.patient?.user?.name}
                      </h3>
                      <span className="text-xs text-gray-500">
                        {c.appointment?.patient?.mrNumber}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      Consultation {c.id.slice(0, 8)} — {c.doctor?.user?.name ? formatDoctorName(c.doctor.user.name) : "—"}
                    </p>
                  </div>

                  {!suggestion && (
                    <button
                      data-testid="followup-suggest"
                      onClick={() => suggestFor(c.id)}
                      className="px-3 py-1.5 rounded-lg border text-xs hover:bg-gray-50"
                    >
                      Suggest follow-up
                    </button>
                  )}
                </div>

                {suggestion && (
                  <div className="mt-4 border rounded-xl p-4 bg-sky-50 border-sky-100">
                    <div className="flex items-start justify-between gap-3">
                      <div className="text-sm">
                        <div className="font-medium text-sky-900">
                          <Clock className="inline w-3.5 h-3.5 mr-1" />
                          {suggestion.suggestedDate}
                          {suggestion.slotStart ? ` at ${suggestion.slotStart}` : " (no slot)"}
                        </div>
                        <p className="text-xs text-sky-700 mt-1">Reason: {suggestion.reason}</p>
                        {suggestion.fallbackUsed && (
                          <p className="text-xs text-orange-700 mt-1">
                            Original doctor unavailable — fallback doctor assigned.
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => book(c.id)}
                        disabled={bookingId === c.id || !suggestion.slotStart}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-medium hover:bg-sky-700 disabled:opacity-60"
                      >
                        {bookingId === c.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <CheckCircle className="w-3.5 h-3.5" />
                        )}
                        Book
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
