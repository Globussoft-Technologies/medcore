"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
// PRD §3.5.1 Phase 2: 8-language i18n bundle (codes + native display names +
// symptom-chip translations + UI-chrome strings + BCP-47 converter).
import {
  TRIAGE_LANGUAGE_CODES,
  LANGUAGE_DISPLAY,
  SYMPTOM_CHIPS,
  TRIAGE_UI_STRINGS,
  toSarvamLanguageCode,
  type TriageLanguageCode,
} from "@medcore/shared";
import {
  Bot,
  Send,
  AlertTriangle,
  Phone,
  CheckCircle,
  Loader2,
  User,
  Stethoscope,
  Calendar,
  ChevronRight,
  RefreshCw,
  Mic,
  MicOff,
  ArrowLeft,
  UserCheck,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────

type BookingFor = "SELF" | "CHILD" | "PARENT" | "SIBLING" | "OTHER";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  /** When content is "[SKIPPED]" we render this label instead */
  displayAs?: string;
}

interface DoctorSuggestion {
  doctorId: string;
  name: string;
  specialty: string;
  qualification?: string;
  photoUrl?: string;
  reasoning: string;
  confidence: number;
  // GAP-T8: present when this card was prepended because Claude's confidence
  // was low OR because the suggested specialty is thinly staffed.
  isGPFallback?: boolean;
}

interface Slot {
  startTime: string;
  endTime: string;
  isAvailable: boolean;
}

interface SummaryFields {
  chiefComplaint: string;
  onset?: string;
  duration?: string;
  severity?: number;
}

type Step = "chat" | "summary" | "doctors" | "booking" | "done";

// ─── Constants ────────────────────────────────────────────

const BOOKING_FOR_OPTIONS: { value: BookingFor; label: string }[] = [
  { value: "SELF", label: "Myself" },
  { value: "CHILD", label: "Child" },
  { value: "PARENT", label: "Parent" },
  { value: "SIBLING", label: "Sibling" },
  { value: "OTHER", label: "Someone else" },
];

// PRD §3.5.1 Phase 2: symptom-chip labels + canonical English complaints live
// in `@medcore/shared/i18n/triage-symptom-chips`. The `complaint` field is
// kept English so the downstream LLM prompt stays consistent regardless of
// the user's display language; only the user-visible `label` is localised.

const hasSpeechRecognition =
  typeof window !== "undefined" &&
  ("SpeechRecognition" in window || "webkitSpeechRecognition" in window);

// ─── Component ───────────────────────────────────────────

export default function AIBookingPage() {
  // Issue #84: also pull `user` so the booking-confirmed CTA can show
  // "Start Consultation" only for staff roles.
  const { token, user } = useAuthStore();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [language, setLanguage] = useState<TriageLanguageCode>("en");
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [isEmergency, setIsEmergency] = useState(false);
  const [emergencyReason, setEmergencyReason] = useState("");
  const [doctorSuggestions, setDoctorSuggestions] = useState<DoctorSuggestion[]>([]);
  const [selectedDoctor, setSelectedDoctor] = useState<DoctorSuggestion | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [bookingDone, setBookingDone] = useState(false);
  const [bookedAppointment, setBookedAppointment] = useState<any>(null);
  const [listening, setListening] = useState(false);
  const [triageConfidence, setTriageConfidence] = useState<number | null>(null);
  const [step, setStep] = useState<Step>("chat");
  const [summaryFields, setSummaryFields] = useState<SummaryFields>({ chiefComplaint: "" });
  // GAP-T9: dependent booking
  const [bookingFor, setBookingFor] = useState<BookingFor>("SELF");
  const [dependentPatientId, setDependentPatientId] = useState("");
  // GAP-T11: human handoff
  const [handedOff, setHandedOff] = useState(false);
  const [handoffLoading, setHandoffLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => { scrollToBottom(); }, [messages]);

  const startSession = useCallback(async () => {
    setStarting(true);
    try {
      const body: Record<string, unknown> = {
        language,
        inputMode: "text",
        consentGiven: true,
        bookingFor,
      };
      if (bookingFor !== "SELF" && dependentPatientId.trim()) {
        body.dependentPatientId = dependentPatientId.trim();
      }
      const res = await api.post<{ data: { sessionId: string; message: string } }>(
        "/ai/triage/start",
        body,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const { sessionId: sid, message } = res.data;
      setSessionId(sid);
      setMessages([{ role: "assistant", content: message, timestamp: new Date().toISOString() }]);
    } catch (err: any) {
      const msg = err?.payload?.error || err?.message || "Failed to start AI assistant";
      toast.error(msg);
    } finally {
      setStarting(false);
    }
  }, [language, token, bookingFor, dependentPatientId]);

  // Do NOT auto-start until user has confirmed booking-for selection — see the
  // pre-chat selector below. We call startSession() explicitly on confirm.

  // ── Voice input ───────────────────────────────────────
  const toggleListening = () => {
    if (!hasSpeechRecognition) return;

    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

    const SpeechRecognitionAPI =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognitionAPI();
    // PRD §3.5.1 Phase 2: convert app language code → BCP-47 tag for the Web
    // Speech API. Covers all 8 supported languages.
    recognition.lang = toSarvamLanguageCode(language);
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onresult = (event: any) => {
      const transcript: string = event.results[0][0].transcript;
      setInput((prev) => (prev ? prev + " " + transcript : transcript));
    };

    recognition.onend = () => {
      setListening(false);
    };

    recognition.onerror = () => {
      setListening(false);
      toast.error("Voice input error. Please try again.");
    };

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  };

  // ── Doctor suggestions ────────────────────────────────
  const fetchDoctorSuggestions = async () => {
    if (!sessionId) return;
    try {
      const res = await api.get<{ data: { doctorSuggestions?: DoctorSuggestion[] } }>(
        `/ai/triage/${sessionId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setDoctorSuggestions(res.data.doctorSuggestions || []);
    } catch {
      toast.error("Failed to fetch doctor suggestions");
    }
  };

  // ── Send message (also used for skip) ────────────────
  const sendMessage = async (overrideText?: string) => {
    const isSkip = overrideText === "[SKIPPED]";
    const rawText = overrideText ?? input.trim();
    if (!rawText || !sessionId || loading) return;

    if (!isSkip) setInput("");

    // For skipped messages: show "Skipped" (italic, gray) instead of "[SKIPPED]"
    setMessages((prev) => [
      ...prev,
      {
        role: "user",
        content: rawText,
        timestamp: new Date().toISOString(),
        ...(isSkip ? { displayAs: "Skipped" } : {}),
      },
    ]);
    setLoading(true);

    try {
      const res = await api.post<any>(
        `/ai/triage/${sessionId}/message`,
        { message: rawText },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = res.data;

      if (data.isEmergency) {
        setIsEmergency(true);
        setEmergencyReason(data.emergencyReason || "");
        setMessages((prev) => [...prev, { role: "assistant", content: data.message, timestamp: new Date().toISOString() }]);
        return;
      }

      setMessages((prev) => [...prev, { role: "assistant", content: data.message, timestamp: new Date().toISOString() }]);

      if (data.readyForDoctorSuggestion) {
        // Store confidence
        if (typeof data.confidence === "number") {
          setTriageConfidence(data.confidence);
        }

        // Fetch session to extract symptoms for summary screen
        try {
          const sessionRes = await api.get<any>(`/ai/triage/${sessionId}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const symptoms = sessionRes.data.session?.symptoms;
          setSummaryFields({
            chiefComplaint: symptoms?.chiefComplaint || symptoms?.chief_complaint || "",
            onset: symptoms?.onset || "",
            duration: symptoms?.duration || "",
            severity: typeof symptoms?.severity === "number" ? symptoms.severity : undefined,
          });
          setDoctorSuggestions(sessionRes.data.doctorSuggestions || []);
        } catch {
          // Fallback: just show empty summary
          setSummaryFields({ chiefComplaint: "" });
        }

        setStep("summary");
      }
    } catch (err: any) {
      // Issue #240: surface the actual API error (validation / 5xx /
      // rate limit) so the user sees the real cause instead of an opaque
      // "Failed to send message". The fetch helper exposes the parsed
      // payload on `err.payload` (not axios `err.response`).
      const msg =
        err?.payload?.error ||
        err?.payload?.details?.formErrors?.join(", ") ||
        err?.message ||
        "Failed to send message";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  // ── Human handoff ─────────────────────────────────────
  const handleHandoff = async () => {
    if (!sessionId || handoffLoading) return;
    setHandoffLoading(true);
    try {
      const res = await api.post<any>(
        `/ai/triage/${sessionId}/handoff`,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const { receptionist } = res.data;
      setHandedOff(true);
      toast.success(`Connecting you with ${receptionist.name}...`);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `You've been connected with ${receptionist.name}. They'll be with you shortly.`,
          timestamp: new Date().toISOString(),
        },
      ]);
    } catch {
      toast.error("Unable to connect to a receptionist right now");
    } finally {
      setHandoffLoading(false);
    }
  };

  const fetchSlots = async (doctorId: string, date: string) => {
    try {
      const res = await api.get<{ data: { slots?: Slot[] } }>(
        `/doctors/${doctorId}/slots?date=${date}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSlots(res.data.slots || []);
    } catch {
      toast.error("Failed to fetch slots");
    }
  };

  const handleDoctorSelect = (doctor: DoctorSuggestion) => {
    setSelectedDoctor(doctor);
    setSelectedSlot(null);
    setSlots([]);
    const today = new Date();
    today.setDate(today.getDate() + 1);
    const dateStr = today.toISOString().split("T")[0];
    setSelectedDate(dateStr);
    setStep("booking");
    fetchSlots(doctor.doctorId, dateStr);
  };

  const handleDateChange = (date: string) => {
    setSelectedDate(date);
    if (selectedDoctor) fetchSlots(selectedDoctor.doctorId, date);
  };

  const handleBook = async () => {
    if (!sessionId || !selectedDoctor || !selectedSlot || !selectedDate) return;
    setLoading(true);
    try {
      // Resolve the logged-in user's patient record via /auth/me. The /patients
      // list endpoint is RBAC-restricted to ADMIN/DOCTOR/RECEPTION/NURSE so the
      // old lookup always 403'd for PATIENT role (issue #22).
      const me = await api.get<{ data: { role: string; patient?: { id: string } | null } }>(
        "/auth/me",
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const patientId = me.data?.patient?.id;
      if (!patientId) {
        toast.error("Please complete your patient profile before booking");
        return;
      }

      const res = await api.post<{ data: { appointment: any } }>(
        `/ai/triage/${sessionId}/book`,
        {
          doctorId: selectedDoctor.doctorId,
          date: selectedDate,
          slotStart: selectedSlot.startTime,
          slotEnd: selectedSlot.endTime,
          patientId,
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setBookedAppointment(res.data.appointment);
      setBookingDone(true);
      setStep("done");
      toast.success("Appointment booked successfully!");
    } catch (err: any) {
      const msg = err?.payload?.error || err?.message || "Booking failed";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const handleReset = () => {
    setBookingDone(false);
    setSessionId(null);
    setMessages([]);
    setStep("chat");
    setTriageConfidence(null);
    setSummaryFields({ chiefComplaint: "" });
    setDoctorSuggestions([]);
    setSelectedDoctor(null);
    setSelectedSlot(null);
    setHandedOff(false);
    setBookingFor("SELF");
    setDependentPatientId("");
  };

  // ── Confidence badge ──────────────────────────────────
  const ConfidenceBadge = ({ confidence }: { confidence: number }) => {
    if (confidence >= 0.75) {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
          High confidence
        </span>
      );
    }
    if (confidence >= 0.5) {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
          Medium confidence
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
        Low confidence — General Physician recommended first
      </span>
    );
  };

  // PRD §3.5.1 Phase 2: resolved symptom-chip list for the current language.
  // Each chip carries a localised `label` (displayed) and a canonical English
  // `complaint` (sent to the chat so the LLM prompt vocabulary stays stable).
  const symptomChips = SYMPTOM_CHIPS[language] ?? SYMPTOM_CHIPS.en;
  const uiStrings = TRIAGE_UI_STRINGS[language] ?? TRIAGE_UI_STRINGS.en;

  // ── Emergency screen ──────────────────────────────────
  if (isEmergency) {
    return (
      <div className="min-h-screen bg-red-50 flex items-center justify-center p-4">
        <div className="max-w-lg w-full bg-white rounded-2xl shadow-xl border-2 border-red-500 p-8 text-center">
          <AlertTriangle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-red-700 mb-2">Emergency Detected</h1>
          <p className="text-gray-600 mb-4">{emergencyReason}</p>
          <div className="bg-red-100 rounded-xl p-4 mb-6 text-left space-y-2">
            <p className="font-semibold text-red-800">Please act immediately:</p>
            <p className="text-red-700 flex items-center gap-2"><Phone className="w-4 h-4" /> Call <strong>112</strong> or your hospital emergency number</p>
            <p className="text-red-700">Go to the nearest Emergency Department</p>
          </div>
          <p className="text-xs text-gray-400">This AI assistant cannot handle emergencies. Please seek immediate care.</p>
        </div>
      </div>
    );
  }

  // ── Booking confirmation ──────────────────────────────
  if (step === "done" && bookingDone && bookedAppointment) {
    // Issue #84: "Start Consultation" used to be a no-op (or the button
    // didn't exist on this branch). Wire it to /dashboard/queue with the
    // newly-booked appointment pre-filtered so the doctor can land on it
    // immediately. Doctors actually call the consultation/start API from
    // there; the patient-facing flow keeps the "Book another" CTA.
    const isStaff = ["DOCTOR", "ADMIN", "RECEPTION"].includes(user?.role ?? "");
    const apptId: string | undefined = bookedAppointment?.id;
    const queueHref = apptId
      ? `/dashboard/queue?appointmentId=${encodeURIComponent(apptId)}`
      : "/dashboard/queue";
    return (
      <div className="min-h-screen bg-green-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8 text-center">
          <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-gray-800 mb-2">Appointment Booked!</h1>
          <div className="bg-gray-50 rounded-xl p-4 text-left space-y-2 mb-6">
            <p className="text-sm text-gray-600"><span className="font-medium">Doctor:</span> {selectedDoctor?.name}</p>
            <p className="text-sm text-gray-600"><span className="font-medium">Specialty:</span> {selectedDoctor?.specialty}</p>
            <p className="text-sm text-gray-600"><span className="font-medium">Date:</span> {selectedDate}</p>
            <p className="text-sm text-gray-600"><span className="font-medium">Time:</span> {selectedSlot?.startTime}</p>
            <p className="text-sm text-gray-600"><span className="font-medium">Token:</span> #{bookedAppointment.tokenNumber}</p>
          </div>
          <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:justify-center">
            {isStaff && (
              <a
                href={queueHref}
                data-testid="ai-booking-start-consultation"
                className="flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"
              >
                <Stethoscope className="w-4 h-4" /> Start Consultation
              </a>
            )}
            <button
              onClick={handleReset}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700"
            >
              <RefreshCw className="w-4 h-4" /> Book another
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── GAP-T9: Pre-chat selector — "Who is this appointment for?" ─────────
  if (!sessionId && !starting) {
    return (
      <div className="flex h-[calc(100vh-4rem)] items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden">
          <div className="px-6 py-5 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
            <p className="font-semibold text-gray-800 flex items-center gap-2">
              <Bot className="w-5 h-5 text-blue-600" />
              Who is this appointment for?
            </p>
            <p className="text-xs text-gray-500 mt-0.5">Select before we begin</p>
          </div>

          <div className="p-6 space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {BOOKING_FOR_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setBookingFor(opt.value)}
                  className={`py-2.5 px-3 rounded-xl text-sm border transition-all font-medium ${
                    bookingFor === opt.value
                      ? "border-blue-500 bg-blue-50 text-blue-700"
                      : "border-gray-200 text-gray-600 hover:border-blue-200 hover:bg-gray-50"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {bookingFor !== "SELF" && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Patient ID (if known)
                </label>
                <input
                  type="text"
                  value={dependentPatientId}
                  onChange={(e) => setDependentPatientId(e.target.value)}
                  placeholder="Optional — leave blank if unknown"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}

            <div className="pt-2">
              <label htmlFor="ai-booking-language" className="block text-xs font-medium text-gray-600 mb-2">
                {uiStrings.languageLabel}
              </label>
              <select
                id="ai-booking-language"
                aria-label={uiStrings.languagePickerAria}
                value={language}
                onChange={(e) => setLanguage(e.target.value as TriageLanguageCode)}
                className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white w-full"
              >
                {/* PRD §3.5.1 Phase 2: 8 supported languages, each shown in
                    its own native script so patients can spot their language
                    without reading English. */}
                {TRIAGE_LANGUAGE_CODES.map((code) => (
                  <option key={code} value={code}>
                    {LANGUAGE_DISPLAY[code].nativeName}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="px-6 pb-6">
            <button
              onClick={startSession}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 transition-colors"
            >
              <Bot className="w-4 h-4" />
              Start AI Consultation
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Summary screen ────────────────────────────────────
  if (step === "summary") {
    return (
      <div className="flex h-[calc(100vh-4rem)] items-center justify-center p-4">
        <div className="max-w-lg w-full bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
            <p className="font-semibold text-gray-800 flex items-center gap-2">
              <CheckCircle className="w-5 h-5 text-blue-600" />
              {language === "hi" ? "मैंने यह समझा" : "Here's what I understood"}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              {language === "hi"
                ? "कृपया जाँचें और सही करें यदि आवश्यक हो"
                : "Please review and correct if needed"}
            </p>
          </div>

          <div className="p-6 space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                {language === "hi" ? "मुख्य समस्या" : "Chief Complaint"}
              </label>
              <input
                type="text"
                value={summaryFields.chiefComplaint}
                onChange={(e) => setSummaryFields((f) => ({ ...f, chiefComplaint: e.target.value }))}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={language === "hi" ? "उदा. बुखार के साथ सिरदर्द" : "e.g. Fever with headache"}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  {language === "hi" ? "शुरुआत" : "Onset"}
                </label>
                <input
                  type="text"
                  value={summaryFields.onset || ""}
                  onChange={(e) => setSummaryFields((f) => ({ ...f, onset: e.target.value }))}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder={language === "hi" ? "उदा. अचानक" : "e.g. Sudden"}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  {language === "hi" ? "अवधि" : "Duration"}
                </label>
                <input
                  type="text"
                  value={summaryFields.duration || ""}
                  onChange={(e) => setSummaryFields((f) => ({ ...f, duration: e.target.value }))}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder={language === "hi" ? "उदा. 2 दिन" : "e.g. 2 days"}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                {language === "hi" ? "गंभीरता (1–10)" : "Severity (1–10)"}
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={summaryFields.severity ?? 5}
                  onChange={(e) =>
                    setSummaryFields((f) => ({ ...f, severity: Number(e.target.value) }))
                  }
                  className="flex-1 accent-blue-600"
                />
                <span className="w-8 text-center text-sm font-semibold text-gray-700">
                  {summaryFields.severity ?? 5}
                </span>
              </div>
            </div>
          </div>

          <div className="px-6 pb-6 flex gap-3">
            <button
              onClick={() => setStep("chat")}
              className="flex items-center gap-2 px-4 py-2 border border-gray-200 text-gray-600 rounded-xl text-sm hover:bg-gray-50 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              {language === "hi" ? "वापस जाएँ" : "Go back"}
            </button>
            <button
              onClick={() => {
                setStep("doctors");
                fetchDoctorSuggestions();
              }}
              className="flex-1 flex items-center justify-center gap-2 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 transition-colors"
            >
              <Stethoscope className="w-4 h-4" />
              {language === "hi" ? "सही है — डॉक्टर दिखाएँ" : "Looks right — Show me doctors"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] gap-4 p-4">
      {/* ── Chat panel ─────────────────────────────────── */}
      <div className="flex flex-col flex-1 bg-white rounded-2xl shadow border border-gray-100 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-indigo-50">
          <div className="w-9 h-9 rounded-full bg-blue-600 flex items-center justify-center">
            <Bot className="w-5 h-5 text-white" />
          </div>
          <div>
            <p className="font-semibold text-gray-800 text-sm">MedCore AI Assistant</p>
            <p className="text-xs text-gray-500">Appointment routing assistant — not a diagnostic tool</p>
          </div>
          <div className="ml-auto flex gap-2">
            {/* PRD §3.5.1 Phase 2: in-chat language switcher, native-script
                labels, localised aria-label for screen readers. */}
            <select
              aria-label={uiStrings.languagePickerAria}
              value={language}
              onChange={(e) => setLanguage(e.target.value as TriageLanguageCode)}
              className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white"
            >
              {TRIAGE_LANGUAGE_CODES.map((code) => (
                <option key={code} value={code}>
                  {LANGUAGE_DISPLAY[code].nativeName}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {starting ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
            </div>
          ) : (
            messages.map((msg, i) => {
              const isSkippedMsg = msg.role === "user" && msg.content === "[SKIPPED]";
              const isLastAssistant =
                msg.role === "assistant" &&
                i === messages.map((m) => m.role).lastIndexOf("assistant");

              return (
                <div key={i}>
                  <div className={`flex gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    {msg.role === "assistant" && (
                      <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <Bot className="w-4 h-4 text-blue-600" />
                      </div>
                    )}
                    {isSkippedMsg ? (
                      <em className="text-xs text-gray-400 self-center">Skipped</em>
                    ) : (
                      <div
                        className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                          msg.role === "user"
                            ? "bg-blue-600 text-white rounded-tr-sm"
                            : "bg-gray-100 text-gray-800 rounded-tl-sm"
                        }`}
                      >
                        {msg.content}
                      </div>
                    )}
                    {msg.role === "user" && !isSkippedMsg && (
                      <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <User className="w-4 h-4 text-white" />
                      </div>
                    )}
                  </div>

                  {/* GAP-T10: Skip link after last assistant message */}
                  {isLastAssistant && step === "chat" && !loading && !isEmergency && !handedOff && (
                    <div className="flex justify-start pl-9 mt-1">
                      <button
                        onClick={() => sendMessage("[SKIPPED]")}
                        className="text-xs text-gray-400 hover:text-gray-600 underline underline-offset-2"
                      >
                        Skip this question →
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
          {loading && (
            <div className="flex gap-2 justify-start">
              <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                <Bot className="w-4 h-4 text-blue-600" />
              </div>
              <div className="bg-gray-100 rounded-2xl rounded-tl-sm px-4 py-2.5">
                <div className="flex gap-1 items-center h-5">
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                  <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Symptom chips — PRD §3.5.1 Phase 2.
            The chip's button renders the localised `label`, but clicking it
            inserts the canonical English `complaint` into the input so the
            LLM prompt stays consistent across all 8 languages. */}
        {sessionId && !isEmergency && !handedOff && (
          <div
            className="px-3 pb-2 flex flex-wrap gap-1.5"
            role="group"
            aria-label={uiStrings.symptomChipsLabel}
            data-testid="symptom-chips"
          >
            {symptomChips.map((chip) => (
              <button
                key={chip.complaint}
                onClick={() => setInput(chip.complaint)}
                disabled={loading || starting}
                className="px-3 py-1 text-xs bg-blue-50 text-blue-700 rounded-full border border-blue-100 hover:bg-blue-100 hover:border-blue-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}

        {/* GAP-T11: Talk to a person button */}
        {step === "chat" && sessionId && !isEmergency && !handedOff && (
          <div className="px-3 pb-2">
            <button
              onClick={handleHandoff}
              disabled={handoffLoading || loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 hover:text-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {handoffLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <UserCheck className="w-3.5 h-3.5" />
              )}
              Talk to a person
            </button>
          </div>
        )}

        {/* Input — read-only when handed off */}
        <div className="p-3 border-t border-gray-100">
          {handedOff ? (
            <p className="text-xs text-center text-gray-400 py-1">
              Chat handed off to reception. This conversation is now read-only.
            </p>
          ) : (
            <>
              <div className="flex gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={uiStrings.inputPlaceholder}
                  rows={1}
                  disabled={loading || starting || !sessionId}
                  className="flex-1 resize-none border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50"
                />
                {hasSpeechRecognition && (
                  <button
                    onClick={toggleListening}
                    disabled={loading || starting || !sessionId}
                    title={listening ? "Stop listening" : "Start voice input"}
                    className={`w-9 h-9 rounded-xl flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                      listening
                        ? "bg-red-500 hover:bg-red-600 text-white"
                        : "bg-gray-100 hover:bg-gray-200 text-gray-600"
                    }`}
                  >
                    {listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                  </button>
                )}
                <button
                  onClick={() => sendMessage()}
                  disabled={loading || starting || !input.trim() || !sessionId}
                  className="w-9 h-9 bg-blue-600 rounded-xl flex items-center justify-center hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Send className="w-4 h-4 text-white" />
                </button>
              </div>
              <p className="text-xs text-gray-400 mt-1 text-center">
                {language === "hi"
                  ? "यह एक अपॉइंटमेंट बुकिंग सहायक है, डायग्नोसिस टूल नहीं।"
                  : "Appointment routing only — not a diagnostic tool. For emergencies, call 112."}
              </p>
            </>
          )}
        </div>
      </div>

      {/* ── Doctor suggestion panel ────────────────────── */}
      {step === "doctors" && (
        <div className="w-96 flex flex-col bg-white rounded-2xl shadow border border-gray-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 bg-gradient-to-r from-emerald-50 to-teal-50">
            <p className="font-semibold text-gray-800 text-sm flex items-center gap-2">
              <Stethoscope className="w-4 h-4 text-emerald-600" />
              {language === "hi" ? "अनुशंसित डॉक्टर" : "Recommended Doctors"}
            </p>
            <p className="text-xs text-gray-500">
              {language === "hi" ? "आपके लक्षणों के आधार पर" : "Based on your symptoms"}
            </p>
            {triageConfidence !== null && (
              <div className="mt-2">
                <ConfidenceBadge confidence={triageConfidence} />
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {doctorSuggestions.length === 0 ? (
              <div className="flex items-center justify-center h-32 text-gray-400 text-sm">
                No doctors available for suggested specialty
              </div>
            ) : (
              doctorSuggestions.map((doc) => (
                <button
                  key={doc.doctorId}
                  onClick={() => handleDoctorSelect(doc)}
                  className={`w-full text-left p-3 rounded-xl border transition-all ${
                    selectedDoctor?.doctorId === doc.doctorId
                      ? "border-blue-500 bg-blue-50"
                      : "border-gray-200 hover:border-blue-200 hover:bg-gray-50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <p className="font-medium text-sm text-gray-800">{doc.name}</p>
                        {/* GAP-T8: GP-first badge */}
                        {doc.isGPFallback && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-800 border border-amber-200">
                            GP recommended first
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-blue-600">{doc.specialty}</p>
                      {doc.qualification && <p className="text-xs text-gray-400">{doc.qualification}</p>}
                    </div>
                    <div className="flex-shrink-0 text-right">
                      <p className="text-xs font-medium text-emerald-600">{Math.round(doc.confidence * 100)}% match</p>
                      <ChevronRight className="w-4 h-4 text-gray-400 ml-auto" />
                    </div>
                  </div>
                  <p className="text-xs text-gray-500 mt-1 line-clamp-2">{doc.reasoning}</p>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* ── Issue #409: sticky bottom Confirm Booking CTA ─────────────────
          The booking flow's confirm button used to live tucked at the bottom
          of the right-side slot panel — easy to miss on mobile and below
          the fold on smaller laptop screens. Render a high-visibility CTA
          docked to the viewport bottom so the patient always knows what
          to do next. Disabled until both doctor + slot are selected. */}
      {step === "booking" && selectedDoctor && (
        <div
          className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-end gap-3 border-t border-gray-200 bg-white/95 px-4 py-3 shadow-[0_-2px_8px_rgba(0,0,0,0.04)] backdrop-blur md:px-8 dark:border-gray-700 dark:bg-gray-900/95"
        >
          <p className="hidden flex-1 truncate text-sm text-gray-600 sm:block dark:text-gray-300">
            {selectedDoctor.name}
            {selectedDate ? ` · ${selectedDate}` : ""}
            {selectedSlot?.startTime ? ` · ${selectedSlot.startTime}` : ""}
          </p>
          <button
            type="button"
            data-testid="book-appt-confirm"
            onClick={handleBook}
            disabled={!selectedSlot || !selectedDate || loading}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl bg-blue-600 px-6 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle className="h-4 w-4" />
            )}
            {language === "hi" ? "अपॉइंटमेंट पक्का करें" : "Confirm Booking"}
          </button>
        </div>
      )}

      {/* ── Slot picker panel ─────────────────────────── */}
      {step === "booking" && selectedDoctor && (
        <div className="w-96 flex flex-col bg-white rounded-2xl shadow border border-gray-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 bg-gradient-to-r from-emerald-50 to-teal-50">
            <button
              onClick={() => setStep("doctors")}
              className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 mb-1"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              {language === "hi" ? "डॉक्टर सूची" : "Doctor list"}
            </button>
            <p className="font-semibold text-gray-800 text-sm">{selectedDoctor.name}</p>
            <p className="text-xs text-blue-600">{selectedDoctor.specialty}</p>
            {triageConfidence !== null && (
              <div className="mt-2">
                <ConfidenceBadge confidence={triageConfidence} />
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            <p className="text-xs font-semibold text-gray-600 flex items-center gap-1">
              <Calendar className="w-3.5 h-3.5" />
              {language === "hi" ? "तारीख और स्लॉट चुनें" : "Select Date & Slot"}
            </p>
            <input
              type="date"
              value={selectedDate}
              min={new Date().toISOString().split("T")[0]}
              onChange={(e) => handleDateChange(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {slots.length > 0 ? (
              <div className="grid grid-cols-3 gap-1.5 max-h-28 overflow-y-auto">
                {slots.filter((s) => s.isAvailable).map((slot) => (
                  <button
                    key={slot.startTime}
                    onClick={() => setSelectedSlot(slot)}
                    className={`text-xs py-1.5 rounded-lg border transition-all ${
                      selectedSlot?.startTime === slot.startTime
                        ? "bg-blue-600 text-white border-blue-600"
                        : "border-gray-200 hover:border-blue-300"
                    }`}
                  >
                    {slot.startTime}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-400 text-center py-2">No slots available</p>
            )}
            <button
              onClick={handleBook}
              disabled={!selectedSlot || loading}
              className="w-full py-2 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
              {language === "hi" ? "अपॉइंटमेंट पक्का करें" : "Confirm Appointment"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
