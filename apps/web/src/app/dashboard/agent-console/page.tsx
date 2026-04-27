"use client";

/**
 * Agent Console (PRD §3.5.6).
 *
 * Three-pane workstation for RECEPTION/ADMIN to pick up AI-Triage handoffs:
 *   - LEFT: list of active handoff ChatRooms sorted by most-recent activity
 *   - MIDDLE: chat thread (reuses the same message + socket patterns as
 *     `/dashboard/chat`; we intentionally duplicate the minimal UI here so
 *     the co-pilot pane on the right can influence the composer)
 *   - RIGHT: AI triage co-pilot — transcript + SOAP extract + top doctors
 *     with a "Suggest this doctor" button that drops a templated message
 *     via the backend's /suggest-doctor endpoint
 *
 * Role-gating is client-side only (the server enforces it too). Non-agents
 * are bounced to /dashboard with a toast.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { getSocket } from "@/lib/socket";
import { usePrompt } from "@/lib/use-dialog";

interface HandoffSummary {
  chatRoomId: string;
  sessionId: string;
  roomName: string | null;
  patient: { id: string; name: string; mrNumber: string } | null;
  presentingComplaint: string;
  language: string;
  confidence: number | null;
  handoffAt: string;
  lastActivityAt: string | null;
  unreadCount: number;
  lastMessage:
    | {
        id: string;
        content: string;
        createdAt: string;
        senderName: string | null;
      }
    | null;
}

interface TranscriptTurn {
  role: string;
  content: string;
  timestamp?: string;
}

interface TopDoctor {
  doctorId: string;
  name: string;
  specialty: string;
  subSpecialty: string | null;
  qualification: string | null;
  experienceYears: number | null;
  consultationFee: number | null;
  reasoning: string | null;
}

interface HandoffContext {
  sessionId: string;
  chatRoomId: string;
  language: string;
  status: string;
  redFlagDetected: boolean;
  redFlagReason: string | null;
  patient: {
    id: string;
    mrNumber: string | null;
    name: string | null;
    phone: string | null;
    dateOfBirth: string | null;
    gender: string | null;
  } | null;
  transcript: TranscriptTurn[];
  soap: {
    subjective: {
      chiefComplaint: string | null;
      onset: string | null;
      duration: string | null;
      severity: number | null;
      associatedSymptoms: string[];
      relevantHistory: string | null;
    } | null;
    assessment: {
      suggestedSpecialties: Array<{
        specialty: string;
        reasoning?: string;
        confidence?: number;
      }>;
      confidence: number | null;
    };
  };
  topDoctors: TopDoctor[];
}

interface ChatMessage {
  id: string;
  roomId: string;
  senderId: string;
  content: string;
  type: string;
  createdAt: string;
  sender: { id: string; name: string; role: string };
}

function timeSince(iso: string, t: (k: string, fb?: string) => string): string {
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return "";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return t("agentConsole.time.justNow", "just now");
  if (mins < 60)
    return `${mins}${t("agentConsole.time.minsAgo", "m ago")}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24)
    return `${hours}${t("agentConsole.time.hoursAgo", "h ago")}`;
  const days = Math.floor(hours / 24);
  return `${days}${t("agentConsole.time.daysAgo", "d ago")}`;
}

export default function AgentConsolePage() {
  const router = useRouter();
  const { user, isLoading } = useAuthStore();
  const { t } = useTranslation();
  const promptDialog = usePrompt();

  const [handoffs, setHandoffs] = useState<HandoffSummary[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [context, setContext] = useState<HandoffContext | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ─── Role guard ───────────────────────────────────────────────────
  useEffect(() => {
    if (isLoading || !user) return;
    if (user.role !== "RECEPTION" && user.role !== "ADMIN") {
      toast.error(
        t(
          "agentConsole.forbidden",
          "Agent Console is only available to reception and admin staff.",
        ),
      );
      router.replace("/dashboard");
    }
  }, [user, isLoading, router, t]);

  // ─── Load active handoffs + refresh on new handoff socket event ───
  async function loadHandoffs() {
    try {
      const res = await api.get<{ data: HandoffSummary[] }>(
        "/agent-console/handoffs",
      );
      setHandoffs(res.data || []);
    } catch {
      // Intentionally swallow — the empty state will render.
      setHandoffs([]);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    if (!user || (user.role !== "RECEPTION" && user.role !== "ADMIN")) return;
    loadHandoffs();
    const sock = getSocket();
    if (!sock.connected) sock.connect();
    const handler = () => {
      loadHandoffs();
    };
    sock.on("agent-console:new-handoff", handler);
    return () => {
      sock.off("agent-console:new-handoff", handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // ─── Load context + messages + subscribe to chat socket for selected room
  useEffect(() => {
    if (!selectedRoomId) {
      setContext(null);
      setMessages([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [ctxRes, msgRes] = await Promise.all([
          api.get<{ data: HandoffContext }>(
            `/agent-console/handoffs/${selectedRoomId}/context`,
          ),
          api.get<{ data: ChatMessage[] }>(
            `/chat/rooms/${selectedRoomId}/messages?limit=100`,
          ),
        ]);
        if (cancelled) return;
        setContext(ctxRes.data);
        setMessages(msgRes.data || []);
        api.patch(`/chat/rooms/${selectedRoomId}/read`, {}).catch(() => {});
      } catch (err) {
        if (!cancelled) {
          toast.error(
            err instanceof Error
              ? err.message
              : t(
                  "agentConsole.loadError",
                  "Failed to load handoff context",
                ),
          );
        }
      }
    })();

    const sock = getSocket();
    sock.emit("chat:join", selectedRoomId);
    const handler = (msg: ChatMessage) => {
      if (msg.roomId === selectedRoomId) {
        setMessages((prev) => [msg, ...prev]);
        setTimeout(() => scrollRef.current?.scrollTo(0, 0), 50);
      }
    };
    sock.on("chat:message", handler);
    return () => {
      cancelled = true;
      sock.emit("chat:leave", selectedRoomId);
      sock.off("chat:message", handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRoomId]);

  const orderedMessages = useMemo(
    () => [...messages].reverse(),
    [messages],
  );

  async function send() {
    if (!composer.trim() || !selectedRoomId) return;
    setSending(true);
    try {
      await api.post(`/chat/rooms/${selectedRoomId}/messages`, {
        content: composer,
        type: "TEXT",
      });
      setComposer("");
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("agentConsole.sendFailed", "Failed to send message"),
      );
    } finally {
      setSending(false);
    }
  }

  async function suggestDoctor(doctor: TopDoctor) {
    if (!selectedRoomId) return;
    // Fast UX: pre-fill the composer first so the agent can review/tweak,
    // and also ping the backend template endpoint so audit trail captures
    // the suggestion regardless of whether the agent edits the text.
    const lines = [
      `Suggested doctor: Dr. ${doctor.name}`,
      `Specialty: ${doctor.specialty}`,
      doctor.consultationFee
        ? `Consultation fee: ₹${doctor.consultationFee}`
        : null,
      `Shall I confirm this appointment for you?`,
    ].filter(Boolean);
    setComposer(lines.join("\n"));
    try {
      await api.post(
        `/agent-console/handoffs/${selectedRoomId}/suggest-doctor`,
        { doctorId: doctor.doctorId },
      );
      toast.success(
        t("agentConsole.suggested", "Doctor suggestion posted to chat."),
      );
    } catch {
      // Non-fatal — the composer still carries the text the agent can send
      // manually, so we do not block them here.
    }
  }

  async function resolveHandoff() {
    if (!selectedRoomId) return;
    const note = await promptDialog({
      title: t("agentConsole.resolveTitle", "Resolve handoff"),
      label: t(
        "agentConsole.resolveNote",
        "Optional note to close this handoff:",
      ),
      placeholder: t(
        "agentConsole.resolveNotePlaceholder",
        "e.g. Booked with Dr. Sharma, follow-up in 1 week",
      ),
      multiline: true,
      confirmLabel: t("agentConsole.resolveConfirm", "Mark resolved"),
    });
    if (note === null) return; // user cancelled
    try {
      await api.post(`/agent-console/handoffs/${selectedRoomId}/resolve`, {
        note,
      });
      toast.success(
        t("agentConsole.resolved", "Handoff marked resolved."),
      );
      setSelectedRoomId(null);
      loadHandoffs();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("agentConsole.resolveFailed", "Failed to resolve handoff"),
      );
    }
  }

  async function escalate() {
    if (!selectedRoomId || !context) return;
    const first = context.topDoctors[0];
    if (!first) {
      toast.info(
        t(
          "agentConsole.escalateNoDoctor",
          "No suggested doctor to escalate to.",
        ),
      );
      return;
    }
    const reason = await promptDialog({
      title: t("agentConsole.escalateTitle", "Escalate to doctor"),
      label: t(
        "agentConsole.escalateReason",
        "Reason for doctor follow-up (optional):",
      ),
      placeholder: t(
        "agentConsole.escalateReasonPlaceholder",
        "e.g. Patient reports worsening chest tightness",
      ),
      multiline: true,
      confirmLabel: t("agentConsole.escalateConfirm", "Send to doctor"),
    });
    if (reason === null) return; // user cancelled
    try {
      await api.post(`/agent-console/handoffs/${selectedRoomId}/escalate`, {
        doctorId: first.doctorId,
        reason,
      });
      toast.success(
        t("agentConsole.escalated", "Escalated to doctor for follow-up."),
      );
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("agentConsole.escalateFailed", "Escalation failed"),
      );
    }
  }

  if (!user) {
    return (
      <div className="p-6 text-sm text-gray-500">
        {t("common.loading", "Loading...")}
      </div>
    );
  }

  if (user.role !== "RECEPTION" && user.role !== "ADMIN") {
    return (
      <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-900">
        {t(
          "agentConsole.forbidden",
          "Agent Console is only available to reception and admin staff.",
        )}
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-6rem)] flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">
            {t("agentConsole.title", "Agent Console")}
          </h1>
          <p className="text-sm text-gray-500">
            {t(
              "agentConsole.subtitle",
              "Pick up AI-Triage handoffs with full transcript and co-pilot suggestions.",
            )}
          </p>
        </div>
        {selectedRoomId && (
          <div className="flex gap-2">
            <button
              onClick={escalate}
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100"
            >
              {t("agentConsole.escalate", "Escalate to doctor")}
            </button>
            <button
              onClick={resolveHandoff}
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-dark"
            >
              {t("agentConsole.markResolved", "Mark resolved")}
            </button>
          </div>
        )}
      </header>

      <div className="flex flex-1 gap-3 overflow-hidden">
        {/* LEFT: handoff list */}
        <aside
          className="flex w-72 flex-col overflow-hidden rounded-xl border bg-white"
          aria-label={t("agentConsole.list", "Active handoffs")}
        >
          <div className="border-b p-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
            {t("agentConsole.activeHandoffs", "Active handoffs")} (
            {handoffs.length})
          </div>
          <div className="flex-1 overflow-y-auto">
            {!loaded ? (
              <p className="p-4 text-sm text-gray-400">
                {t("common.loading", "Loading...")}
              </p>
            ) : handoffs.length === 0 ? (
              <p className="p-4 text-sm text-gray-400">
                {t(
                  "agentConsole.noHandoffs",
                  "No active handoffs right now.",
                )}
              </p>
            ) : (
              handoffs.map((h) => {
                const isActive = selectedRoomId === h.chatRoomId;
                return (
                  <button
                    key={h.chatRoomId}
                    onClick={() => setSelectedRoomId(h.chatRoomId)}
                    className={`flex w-full flex-col gap-1 border-b p-3 text-left transition hover:bg-gray-50 ${isActive ? "bg-blue-50" : ""}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="truncate text-sm font-semibold">
                        {h.patient?.name ??
                          t("agentConsole.unknownPatient", "Unknown patient")}
                      </span>
                      {h.unreadCount > 0 && (
                        <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-white">
                          {h.unreadCount}
                        </span>
                      )}
                    </div>
                    <p className="truncate text-xs text-gray-600">
                      {h.presentingComplaint}
                    </p>
                    <div className="flex items-center gap-2 text-[11px] text-gray-400">
                      <span className="rounded border px-1.5 py-0.5 uppercase">
                        {h.language}
                      </span>
                      <span>{timeSince(h.handoffAt, t)}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* MIDDLE: chat thread */}
        <section
          className="flex flex-1 flex-col overflow-hidden rounded-xl border bg-white"
          aria-label={t("agentConsole.thread", "Chat thread")}
        >
          {!selectedRoomId ? (
            <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
              {t(
                "agentConsole.selectPrompt",
                "Pick a handoff on the left to start.",
              )}
            </div>
          ) : (
            <>
              <div className="border-b p-3 text-sm font-medium">
                {context?.patient?.name ??
                  t("agentConsole.handoff", "Handoff")}
                {context?.patient?.mrNumber && (
                  <span className="ml-2 text-xs text-gray-400">
                    MRN {context.patient.mrNumber}
                  </span>
                )}
              </div>
              <div
                ref={scrollRef}
                className="flex flex-1 flex-col-reverse gap-2 overflow-y-auto bg-gray-50 p-3"
              >
                {orderedMessages.length === 0 ? (
                  <p className="text-center text-xs text-gray-400">
                    {t(
                      "agentConsole.noMessages",
                      "No messages yet.",
                    )}
                  </p>
                ) : (
                  orderedMessages.map((m) => {
                    const mine = m.senderId === user?.id;
                    return (
                      <div
                        key={m.id}
                        className={`flex ${mine ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={`max-w-lg rounded-2xl px-3 py-2 text-sm ${mine ? "bg-primary text-white" : "bg-white text-gray-800 shadow-sm"}`}
                        >
                          {!mine && (
                            <p className="mb-0.5 text-[11px] font-semibold">
                              {m.sender?.name ?? "User"}
                            </p>
                          )}
                          <p className="whitespace-pre-wrap">{m.content}</p>
                          <p
                            className={`mt-1 text-[10px] ${mine ? "text-white/70" : "text-gray-400"}`}
                          >
                            {new Date(m.createdAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
              <div className="flex gap-2 border-t p-3">
                <textarea
                  aria-label={t(
                    "agentConsole.composerLabel",
                    "Message composer",
                  )}
                  data-testid="agent-console-composer"
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder={
                    t(
                      "agentConsole.composerPlaceholder",
                      "Type a message or use AI co-pilot...",
                    ) as string
                  }
                  className="flex-1 resize-none rounded-lg border px-3 py-2 text-sm"
                  rows={2}
                />
                <button
                  onClick={send}
                  disabled={!composer.trim() || sending}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
                >
                  {t("agentConsole.send", "Send")}
                </button>
              </div>
            </>
          )}
        </section>

        {/* RIGHT: AI co-pilot pane */}
        <aside
          className="flex w-96 flex-col overflow-hidden rounded-xl border bg-white"
          aria-label={t("agentConsole.copilot", "AI Triage co-pilot")}
        >
          <div className="border-b p-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
            {t("agentConsole.copilot", "AI Triage co-pilot")}
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {!context ? (
              <p className="text-sm text-gray-400">
                {t(
                  "agentConsole.selectPrompt",
                  "Pick a handoff on the left to start.",
                )}
              </p>
            ) : (
              <div className="space-y-4">
                <section data-testid="agent-console-transcript">
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {t("agentConsole.transcript", "Triage transcript")}
                  </h3>
                  <div className="space-y-1.5 rounded-lg border bg-gray-50 p-2 text-xs">
                    {context.transcript.length === 0 ? (
                      <p className="text-gray-400">
                        {t(
                          "agentConsole.noTranscript",
                          "No transcript available.",
                        )}
                      </p>
                    ) : (
                      context.transcript.map((turn, idx) => (
                        <div
                          key={idx}
                          className={
                            turn.role === "user"
                              ? "text-gray-800"
                              : "text-primary"
                          }
                        >
                          <span className="font-semibold">
                            {turn.role === "user" ? "Patient" : "AI"}:
                          </span>{" "}
                          {turn.content}
                        </div>
                      ))
                    )}
                  </div>
                </section>

                <section>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {t("agentConsole.soap", "SOAP extract")}
                  </h3>
                  <div className="rounded-lg border bg-gray-50 p-2 text-xs">
                    <p>
                      <strong>
                        {t(
                          "agentConsole.chiefComplaint",
                          "Chief complaint",
                        )}
                        :
                      </strong>{" "}
                      {context.soap.subjective?.chiefComplaint ?? "—"}
                    </p>
                    <p>
                      <strong>
                        {t("agentConsole.onset", "Onset")}:
                      </strong>{" "}
                      {context.soap.subjective?.onset ?? "—"}
                    </p>
                    <p>
                      <strong>
                        {t("agentConsole.duration", "Duration")}:
                      </strong>{" "}
                      {context.soap.subjective?.duration ?? "—"}
                    </p>
                    <p>
                      <strong>
                        {t("agentConsole.severity", "Severity")}:
                      </strong>{" "}
                      {context.soap.subjective?.severity ?? "—"}
                    </p>
                    {context.soap.subjective?.associatedSymptoms &&
                      context.soap.subjective.associatedSymptoms.length > 0 && (
                        <p>
                          <strong>
                            {t(
                              "agentConsole.associatedSymptoms",
                              "Associated",
                            )}
                            :
                          </strong>{" "}
                          {context.soap.subjective.associatedSymptoms.join(
                            ", ",
                          )}
                        </p>
                      )}
                    {context.redFlagDetected && (
                      <p className="mt-1 rounded bg-red-100 px-2 py-1 text-red-900">
                        {t("agentConsole.redFlag", "Red flag")}:{" "}
                        {context.redFlagReason}
                      </p>
                    )}
                  </div>
                </section>

                <section>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {t("agentConsole.topDoctors", "Top 3 doctor suggestions")}
                  </h3>
                  {context.topDoctors.length === 0 ? (
                    <p className="text-xs text-gray-400">
                      {t(
                        "agentConsole.noDoctors",
                        "No doctor suggestions yet.",
                      )}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {context.topDoctors.map((d) => (
                        <div
                          key={d.doctorId}
                          className="rounded-lg border p-2 text-xs"
                        >
                          <p className="font-semibold">Dr. {d.name}</p>
                          <p className="text-gray-500">
                            {d.specialty}
                            {d.subSpecialty ? ` · ${d.subSpecialty}` : ""}
                          </p>
                          {d.reasoning && (
                            <p className="mt-1 text-gray-600">{d.reasoning}</p>
                          )}
                          <button
                            onClick={() => suggestDoctor(d)}
                            data-testid={`suggest-doctor-${d.doctorId}`}
                            className="mt-2 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-white hover:bg-primary-dark"
                          >
                            {t(
                              "agentConsole.suggestThisDoctor",
                              "Suggest this doctor",
                            )}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
