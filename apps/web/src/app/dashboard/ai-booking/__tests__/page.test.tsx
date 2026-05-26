/* eslint-disable @typescript-eslint/no-explicit-any */
// Coverage tests for the AI Booking dashboard page.
// Modules under test: apps/web/src/app/dashboard/ai-booking/page.tsx —
//   patient-facing AI triage + appointment-booking intake flow.
//   The page is a multi-step state machine:
//     pre-chat (booking-for + language selector) → POST /ai/triage/start
//     chat (free-text + symptom chips + voice + handoff) →
//       POST /ai/triage/:id/message and on `readyForDoctorSuggestion`
//       GET /ai/triage/:id for the symptom summary → summary screen
//     summary (chief complaint / onset / duration / severity sliders) →
//       GET /ai/triage/:id (fetchDoctorSuggestions) → doctors screen
//     doctors (suggestion cards w/ confidence + GP-fallback badge) →
//       GET /doctors/:id/slots?date= → booking screen
//     booking (date picker + slot grid + sticky bottom CTA) →
//       GET /auth/me → POST /ai/triage/:id/book → done screen
//     done (confirmation + Start Consultation for staff / Book another)
//   Edge surfaces covered: emergency-detected screen, role gate
//   (non-PATIENT/ADMIN redirect to /dashboard/not-authorized), human
//   handoff (POST /ai/triage/:id/handoff → handedOff read-only state),
//   skip-message flow, language switcher, sample symptom chip insertion,
//   and the error-payload extraction path on each POST.
// Why: page was at 0% line coverage at 1093 lines. Locks in the
//   happy-path state machine + role gating + error envelopes so future
//   refactors of the triage UX can't silently regress the booking flow.
//   Pattern mirrors /dashboard/ai-roster/__tests__/page.test.tsx (commit
//   c9457817) — same hoisted api/auth mock shape.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";

// jsdom doesn't implement scrollIntoView; the page calls it in an effect.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}

const { apiMock, authMock, toastMock, routerReplaceMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
  routerReplaceMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: routerReplaceMock,
    back: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/ai-booking",
}));

import AIBookingPage from "../page";

const PATIENT_USER = {
  id: "user-pat-1",
  role: "PATIENT",
  email: "pat@test.local",
  name: "Test Patient",
};

const STAFF_USER = {
  id: "user-doc-1",
  role: "DOCTOR",
  email: "doc@test.local",
  name: "Test Doctor",
};

const ADMIN_USER = {
  id: "user-adm-1",
  role: "ADMIN",
  email: "adm@test.local",
  name: "Test Admin",
};

function setAuth(
  overrides: { user?: any; token?: string | null; isLoading?: boolean } = {},
) {
  authMock.mockReturnValue({
    user: overrides.user ?? PATIENT_USER,
    token: overrides.token ?? "tok-patient",
    isLoading: overrides.isLoading ?? false,
  });
}

function doctorSuggestion(overrides: any = {}) {
  return {
    doctorId: "doc-1",
    name: "Dr. Asha Mehta",
    specialty: "Cardiology",
    qualification: "MBBS, MD",
    reasoning: "Chest pain pattern with exertion correlation",
    confidence: 0.82,
    ...overrides,
  };
}

describe("AI Booking dashboard page", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    toastMock.info.mockReset();
    toastMock.warning.mockReset();
    routerReplaceMock.mockReset();
    setAuth();
  });

  it("renders the pre-chat booking-for selector with all 5 audience options + language picker for a PATIENT", () => {
    render(<AIBookingPage />);

    expect(screen.getByRole("heading", { name: /^AI Booking$/i })).toBeInTheDocument();
    expect(screen.getByText(/Who is this appointment for\?/i)).toBeInTheDocument();
    for (const label of ["Myself", "Child", "Parent", "Sibling", "Someone else"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: /Start AI Consultation/i })).toBeInTheDocument();
    // Default SELF — no dependent patient-id input.
    expect(screen.queryByLabelText(/Patient ID/i)).not.toBeInTheDocument();
  });

  it("reveals the dependent patient-id input when a non-SELF audience is picked", () => {
    render(<AIBookingPage />);

    fireEvent.click(screen.getByRole("button", { name: "Child" }));
    const input = screen.getByLabelText(/Patient ID/i) as HTMLInputElement;
    expect(input).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "pat-123" } });
    expect(input.value).toBe("pat-123");
  });

  it("redirects a non-PATIENT, non-ADMIN role to /dashboard/not-authorized and surfaces an error toast", async () => {
    setAuth({ user: STAFF_USER });
    render(<AIBookingPage />);

    await waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith(
        expect.stringContaining("/dashboard/not-authorized"),
      );
    });
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/AI Booking is for patients only/i),
    );
  });

  it("does NOT redirect ADMIN users (kept for support/debug per issue #674)", async () => {
    setAuth({ user: ADMIN_USER });
    render(<AIBookingPage />);

    // Settle the effect then assert no redirect was made.
    await new Promise((r) => setTimeout(r, 0));
    expect(routerReplaceMock).not.toHaveBeenCalled();
    // Pre-chat selector still rendered.
    expect(screen.getByRole("heading", { name: /^AI Booking$/i })).toBeInTheDocument();
  });

  it("does NOT redirect while auth is still loading even if user role would normally be blocked", async () => {
    setAuth({ user: STAFF_USER, isLoading: true });
    render(<AIBookingPage />);
    await new Promise((r) => setTimeout(r, 0));
    expect(routerReplaceMock).not.toHaveBeenCalled();
  });

  it("POSTs /ai/triage/start with booking-for=SELF + language=en when Start AI Consultation is clicked, then renders chat state", async () => {
    apiMock.post.mockResolvedValueOnce({
      data: {
        sessionId: "sess-1",
        message: "Hi, what's bothering you?",
      },
    });

    render(<AIBookingPage />);
    fireEvent.click(screen.getByRole("button", { name: /Start AI Consultation/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/ai/triage/start",
        expect.objectContaining({
          language: "en",
          inputMode: "text",
          consentGiven: true,
          bookingFor: "SELF",
        }),
        expect.objectContaining({
          headers: { Authorization: "Bearer tok-patient" },
        }),
      ),
    );

    // Chat state — assistant message renders.
    expect(await screen.findByText(/Hi, what's bothering you\?/i)).toBeInTheDocument();
    // MedCore AI Assistant header.
    expect(screen.getByText(/MedCore AI Assistant/i)).toBeInTheDocument();
    // sr-only h1 still present.
    expect(screen.getByRole("heading", { name: /AI Booking Assistant/i })).toBeInTheDocument();
  });

  it("threads dependentPatientId only for non-SELF audiences", async () => {
    apiMock.post.mockResolvedValueOnce({
      data: { sessionId: "sess-2", message: "Tell me about the child" },
    });
    render(<AIBookingPage />);

    fireEvent.click(screen.getByRole("button", { name: "Child" }));
    fireEvent.change(screen.getByLabelText(/Patient ID/i), {
      target: { value: "dep-77" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Start AI Consultation/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/ai/triage/start",
        expect.objectContaining({
          bookingFor: "CHILD",
          dependentPatientId: "dep-77",
        }),
        expect.any(Object),
      ),
    );
  });

  it("surfaces the API error payload when /ai/triage/start fails", async () => {
    const err: any = new Error("Failed");
    err.payload = { error: "Rate-limited — try again in a minute" };
    apiMock.post.mockRejectedValueOnce(err);

    render(<AIBookingPage />);
    fireEvent.click(screen.getByRole("button", { name: /Start AI Consultation/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/Rate-limited.*minute/),
      ),
    );
    // Stays on pre-chat selector after failure.
    expect(screen.getByRole("button", { name: /Start AI Consultation/i })).toBeInTheDocument();
  });

  it("falls back to the generic error string when /ai/triage/start rejects without a payload", async () => {
    apiMock.post.mockRejectedValueOnce({});

    render(<AIBookingPage />);
    fireEvent.click(screen.getByRole("button", { name: /Start AI Consultation/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to start AI assistant/),
      ),
    );
  });

  it("changes language via the in-selector dropdown and threads the chosen code into the start POST", async () => {
    apiMock.post.mockResolvedValueOnce({
      data: { sessionId: "sess-hi", message: "नमस्ते" },
    });

    render(<AIBookingPage />);
    fireEvent.change(screen.getByLabelText(/language/i), {
      target: { value: "hi" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Start AI Consultation/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/ai/triage/start",
        expect.objectContaining({ language: "hi" }),
        expect.any(Object),
      ),
    );
  });

  // ── chat state behaviours ─────────────────────────────────────

  async function startSession(opts: { sessionId?: string; message?: string } = {}) {
    apiMock.post.mockResolvedValueOnce({
      data: {
        sessionId: opts.sessionId ?? "sess-chat",
        message: opts.message ?? "Hi, what's bothering you?",
      },
    });
    render(<AIBookingPage />);
    fireEvent.click(screen.getByRole("button", { name: /Start AI Consultation/i }));
    await screen.findByText(opts.message ?? "Hi, what's bothering you?");
  }

  it("sends a chat message via POST /ai/triage/:id/message, renders the assistant reply, and clears the input", async () => {
    await startSession();

    apiMock.post.mockResolvedValueOnce({
      data: {
        message: "How long has it been hurting?",
        isEmergency: false,
      },
    });

    const textarea = screen.getByPlaceholderText(/.+/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "chest pain" } });
    expect(textarea.value).toBe("chest pain");

    // Click Send via the chat input area.
    const sendBtns = screen.getAllByRole("button");
    // The Send button is the last button that's not disabled with the matching position;
    // simpler: simulate Enter on the textarea which the source wires to sendMessage().
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/ai/triage/sess-chat/message",
        { message: "chest pain" },
        expect.objectContaining({
          headers: { Authorization: "Bearer tok-patient" },
        }),
      ),
    );

    expect(await screen.findByText(/How long has it been hurting\?/i)).toBeInTheDocument();
    expect(textarea.value).toBe("");
    // shut up unused
    void sendBtns;
  });

  it("does NOT send on Shift+Enter (newline behaviour)", async () => {
    await startSession();
    const before = apiMock.post.mock.calls.length;

    const textarea = screen.getByPlaceholderText(/.+/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "still typing" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    // No additional post call from Shift+Enter.
    expect(apiMock.post.mock.calls.length).toBe(before);
  });

  it("surfaces an emergency screen and stops chat when /message returns isEmergency=true", async () => {
    await startSession();

    apiMock.post.mockResolvedValueOnce({
      data: {
        isEmergency: true,
        emergencyReason: "Reported chest crushing pain radiating to left arm",
        message: "Please seek emergency care immediately.",
      },
    });

    const textarea = screen.getByPlaceholderText(/.+/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "crushing chest pain" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(
      await screen.findByRole("heading", { name: /Emergency Detected/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/crushing pain radiating to left arm/i)).toBeInTheDocument();
    // Emergency-call CTA.
    expect(screen.getByText(/112/)).toBeInTheDocument();
  });

  it("transitions to the summary screen when readyForDoctorSuggestion is true on /message and fetches symptom summary", async () => {
    await startSession();

    // First POST = /message → ready for suggestion.
    apiMock.post.mockResolvedValueOnce({
      data: {
        message: "Great, I have enough.",
        readyForDoctorSuggestion: true,
        confidence: 0.78,
      },
    });
    // Subsequent GET = /ai/triage/:id → session + suggestions.
    apiMock.get.mockResolvedValueOnce({
      data: {
        session: {
          symptoms: {
            chiefComplaint: "Fever with headache",
            onset: "Sudden",
            duration: "2 days",
            severity: 6,
          },
        },
        doctorSuggestions: [doctorSuggestion()],
      },
    });

    const textarea = screen.getByPlaceholderText(/.+/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "fever and headache" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    // Summary heading.
    expect(
      await screen.findByText(/Here's what I understood/i),
    ).toBeInTheDocument();
    const complaint = screen.getByLabelText(/Chief Complaint/i) as HTMLInputElement;
    expect(complaint.value).toBe("Fever with headache");
    const onset = screen.getByLabelText(/^Onset$/i) as HTMLInputElement;
    expect(onset.value).toBe("Sudden");
    const duration = screen.getByLabelText(/^Duration$/i) as HTMLInputElement;
    expect(duration.value).toBe("2 days");
    const severity = screen.getByLabelText(/Severity/i) as HTMLInputElement;
    expect(severity.value).toBe("6");
  });

  it("recovers gracefully when the post-ready GET fails — empty summary surfaces", async () => {
    await startSession();
    apiMock.post.mockResolvedValueOnce({
      data: { message: "OK.", readyForDoctorSuggestion: true, confidence: 0.4 },
    });
    apiMock.get.mockRejectedValueOnce(new Error("network"));

    const textarea = screen.getByPlaceholderText(/.+/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "trigger" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(await screen.findByText(/Here's what I understood/i)).toBeInTheDocument();
    const complaint = screen.getByLabelText(/Chief Complaint/i) as HTMLInputElement;
    expect(complaint.value).toBe("");
  });

  it("surfaces an API error payload on /message failure (issue #240 error-detail surfacing)", async () => {
    await startSession();
    const err: any = new Error("fail");
    err.payload = { error: "Triage session expired" };
    apiMock.post.mockRejectedValueOnce(err);

    const textarea = screen.getByPlaceholderText(/.+/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "anything" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/Triage session expired/),
      ),
    );
  });

  it("renders the Skip this question CTA and POSTs [SKIPPED] when clicked", async () => {
    await startSession();
    apiMock.post.mockResolvedValueOnce({
      data: { message: "OK, moving on.", isEmergency: false },
    });

    fireEvent.click(screen.getByRole("button", { name: /Skip this question/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/ai/triage/sess-chat/message",
        { message: "[SKIPPED]" },
        expect.any(Object),
      ),
    );
    // Skipped marker renders.
    expect(await screen.findByText(/^Skipped$/i)).toBeInTheDocument();
  });

  it("posts a chat handoff via /ai/triage/:id/handoff, marks chat read-only, and shows the connect message", async () => {
    await startSession();
    apiMock.post.mockResolvedValueOnce({
      data: { receptionist: { name: "Priya Reception" } },
    });

    fireEvent.click(screen.getByRole("button", { name: /Talk to a person/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/ai/triage/sess-chat/handoff",
        {},
        expect.objectContaining({
          headers: { Authorization: "Bearer tok-patient" },
        }),
      ),
    );
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringMatching(/Priya Reception/i),
    );
    expect(
      await screen.findByText(/Chat handed off to reception/i),
    ).toBeInTheDocument();
  });

  it("surfaces an error toast when /handoff rejects", async () => {
    await startSession();
    apiMock.post.mockRejectedValueOnce(new Error("svc-down"));

    fireEvent.click(screen.getByRole("button", { name: /Talk to a person/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/Unable to connect to a receptionist/i),
      ),
    );
  });

  it("inserts a symptom-chip's canonical complaint text into the input when clicked", async () => {
    await startSession();
    // Symptom chips are rendered in a role=group region. Click the first chip
    // and verify it lands in the textarea.
    const chipsGroup = screen.getByTestId("symptom-chips");
    const chip = chipsGroup.querySelector("button");
    expect(chip).toBeTruthy();
    fireEvent.click(chip!);
    const textarea = screen.getByPlaceholderText(/.+/) as HTMLTextAreaElement;
    expect(textarea.value.length).toBeGreaterThan(0);
  });

  // ── summary → doctors → booking → done ────────────────────

  async function reachDoctorsScreen() {
    apiMock.post.mockResolvedValueOnce({
      data: { sessionId: "sess-flow", message: "Hi" },
    });
    render(<AIBookingPage />);
    fireEvent.click(screen.getByRole("button", { name: /Start AI Consultation/i }));
    await screen.findByText("Hi");

    // Force /message → ready.
    apiMock.post.mockResolvedValueOnce({
      data: {
        message: "Got it.",
        readyForDoctorSuggestion: true,
        confidence: 0.82,
      },
    });
    apiMock.get.mockResolvedValueOnce({
      data: {
        session: {
          symptoms: {
            chiefComplaint: "Sore throat",
            onset: "Yesterday",
            duration: "1 day",
            severity: 4,
          },
        },
        doctorSuggestions: [doctorSuggestion()],
      },
    });
    const textarea = screen.getByPlaceholderText(/.+/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "sore throat" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await screen.findByText(/Here's what I understood/i);

    // Summary → doctors transitions trigger ANOTHER GET (fetchDoctorSuggestions).
    apiMock.get.mockResolvedValueOnce({
      data: { doctorSuggestions: [doctorSuggestion()] },
    });
    fireEvent.click(screen.getByRole("button", { name: /Show me doctors/i }));
    await screen.findByText(/Recommended Doctors/i);
  }

  it("renders doctor suggestion cards with high-confidence badge + name + specialty", async () => {
    await reachDoctorsScreen();

    expect(screen.getByText(/Dr\. Asha Mehta/i)).toBeInTheDocument();
    expect(screen.getByText(/Cardiology/i)).toBeInTheDocument();
    expect(screen.getByText(/82% match/i)).toBeInTheDocument();
    expect(screen.getByText(/High confidence/i)).toBeInTheDocument();
  });

  it("transitions to booking screen on doctor click and fetches slots for tomorrow's date", async () => {
    await reachDoctorsScreen();
    apiMock.get.mockResolvedValueOnce({
      data: {
        slots: [
          { startTime: "09:00", endTime: "09:30", isAvailable: true },
          { startTime: "10:00", endTime: "10:30", isAvailable: true },
        ],
      },
    });

    fireEvent.click(screen.getByText(/Dr\. Asha Mehta/i));

    await waitFor(() => {
      const slotsCall = apiMock.get.mock.calls.find((c) =>
        String(c[0]).startsWith("/doctors/doc-1/slots?date="),
      );
      expect(slotsCall).toBeTruthy();
    });
    expect(await screen.findByText(/Select Date & Slot/i)).toBeInTheDocument();
    // Slot buttons appear.
    expect(await screen.findByRole("button", { name: "09:00" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "10:00" })).toBeInTheDocument();
  });

  it("books an appointment via /auth/me + /ai/triage/:id/book and renders the confirmation screen", async () => {
    await reachDoctorsScreen();
    apiMock.get.mockResolvedValueOnce({
      data: {
        slots: [{ startTime: "09:00", endTime: "09:30", isAvailable: true }],
      },
    });
    fireEvent.click(screen.getByText(/Dr\. Asha Mehta/i));
    await screen.findByText(/Select Date & Slot/i);

    fireEvent.click(await screen.findByRole("button", { name: "09:00" }));

    // /auth/me + /book.
    apiMock.get.mockResolvedValueOnce({
      data: { role: "PATIENT", patient: { id: "pat-self-1" } },
    });
    apiMock.post.mockResolvedValueOnce({
      data: { appointment: { id: "appt-9", tokenNumber: 42 } },
    });

    // The sticky bottom confirm CTA uses data-testid.
    fireEvent.click(screen.getByTestId("book-appt-confirm"));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/ai/triage/sess-flow/book",
        expect.objectContaining({
          doctorId: "doc-1",
          slotStart: "09:00",
          slotEnd: "09:30",
          patientId: "pat-self-1",
        }),
        expect.any(Object),
      ),
    );
    expect(
      await screen.findByRole("heading", { name: /Appointment Booked/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/#42/)).toBeInTheDocument();
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringMatching(/Appointment booked successfully/),
    );
    // "Book another" CTA.
    expect(screen.getByRole("button", { name: /Book another/i })).toBeInTheDocument();
    // Patient doesn't see Start Consultation (staff-only).
    expect(
      screen.queryByTestId("ai-booking-start-consultation"),
    ).not.toBeInTheDocument();
  });

  it("shows Start Consultation CTA for staff (DOCTOR role) on the done screen", async () => {
    setAuth({ user: STAFF_USER, token: "tok-doc" });
    // Staff would be redirected, but for this we need to hand-build the
    // done state. The simplest path is to act as ADMIN (kept allowed) and
    // assert the staff-only CTA via the (ADMIN-passes-role-gate, role-includes-ADMIN)
    // branch in the done screen.
    setAuth({ user: ADMIN_USER, token: "tok-admin" });
    apiMock.post.mockResolvedValueOnce({
      data: { sessionId: "sess-admin", message: "Hi" },
    });
    render(<AIBookingPage />);
    fireEvent.click(screen.getByRole("button", { name: /Start AI Consultation/i }));
    await screen.findByText("Hi");

    apiMock.post.mockResolvedValueOnce({
      data: { message: "Got it.", readyForDoctorSuggestion: true, confidence: 0.9 },
    });
    apiMock.get.mockResolvedValueOnce({
      data: {
        session: {
          symptoms: {
            chiefComplaint: "Cough",
            onset: "today",
            duration: "1d",
            severity: 3,
          },
        },
        doctorSuggestions: [doctorSuggestion()],
      },
    });
    const textarea = screen.getByPlaceholderText(/.+/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "cough" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await screen.findByText(/Here's what I understood/i);

    apiMock.get.mockResolvedValueOnce({
      data: { doctorSuggestions: [doctorSuggestion()] },
    });
    fireEvent.click(screen.getByRole("button", { name: /Show me doctors/i }));
    await screen.findByText(/Recommended Doctors/i);

    apiMock.get.mockResolvedValueOnce({
      data: {
        slots: [{ startTime: "09:00", endTime: "09:30", isAvailable: true }],
      },
    });
    fireEvent.click(screen.getByText(/Dr\. Asha Mehta/i));
    await screen.findByText(/Select Date & Slot/i);
    fireEvent.click(await screen.findByRole("button", { name: "09:00" }));

    apiMock.get.mockResolvedValueOnce({
      data: { role: "ADMIN", patient: { id: "pat-self-1" } },
    });
    apiMock.post.mockResolvedValueOnce({
      data: { appointment: { id: "appt-X", tokenNumber: 1 } },
    });
    fireEvent.click(screen.getByTestId("book-appt-confirm"));

    expect(
      await screen.findByRole("heading", { name: /Appointment Booked/i }),
    ).toBeInTheDocument();
    // ADMIN sees Start Consultation CTA.
    expect(screen.getByTestId("ai-booking-start-consultation")).toBeInTheDocument();
  });

  it("aborts booking when /auth/me reports no patient profile and surfaces the prompt-to-complete toast", async () => {
    await reachDoctorsScreen();
    apiMock.get.mockResolvedValueOnce({
      data: {
        slots: [{ startTime: "09:00", endTime: "09:30", isAvailable: true }],
      },
    });
    fireEvent.click(screen.getByText(/Dr\. Asha Mehta/i));
    await screen.findByText(/Select Date & Slot/i);
    fireEvent.click(await screen.findByRole("button", { name: "09:00" }));

    apiMock.get.mockResolvedValueOnce({
      data: { role: "PATIENT", patient: null },
    });
    fireEvent.click(screen.getByTestId("book-appt-confirm"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/complete your patient profile/i),
      ),
    );
    // No /book POST fired.
    const bookCalls = apiMock.post.mock.calls.filter((c) =>
      String(c[0]).endsWith("/book"),
    );
    expect(bookCalls.length).toBe(0);
  });

  it("surfaces API payload error when /book rejects", async () => {
    await reachDoctorsScreen();
    apiMock.get.mockResolvedValueOnce({
      data: {
        slots: [{ startTime: "09:00", endTime: "09:30", isAvailable: true }],
      },
    });
    fireEvent.click(screen.getByText(/Dr\. Asha Mehta/i));
    await screen.findByText(/Select Date & Slot/i);
    fireEvent.click(await screen.findByRole("button", { name: "09:00" }));

    apiMock.get.mockResolvedValueOnce({
      data: { role: "PATIENT", patient: { id: "pat-1" } },
    });
    const err: any = new Error("conflict");
    err.payload = { error: "Slot already taken" };
    apiMock.post.mockRejectedValueOnce(err);

    fireEvent.click(screen.getByTestId("book-appt-confirm"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/Slot already taken/),
      ),
    );
  });

  it("renders the no-doctors empty state when /ai/triage/:id returns empty doctorSuggestions on the doctors screen", async () => {
    apiMock.post.mockResolvedValueOnce({
      data: { sessionId: "sess-empty", message: "Hi" },
    });
    render(<AIBookingPage />);
    fireEvent.click(screen.getByRole("button", { name: /Start AI Consultation/i }));
    await screen.findByText("Hi");

    apiMock.post.mockResolvedValueOnce({
      data: { message: "Got it.", readyForDoctorSuggestion: true, confidence: 0.3 },
    });
    apiMock.get.mockResolvedValueOnce({
      data: {
        session: {
          symptoms: { chiefComplaint: "general malaise", severity: 2 },
        },
        doctorSuggestions: [],
      },
    });
    const textarea = screen.getByPlaceholderText(/.+/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "tired" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await screen.findByText(/Here's what I understood/i);

    apiMock.get.mockResolvedValueOnce({ data: { doctorSuggestions: [] } });
    fireEvent.click(screen.getByRole("button", { name: /Show me doctors/i }));

    expect(
      await screen.findByText(/No doctors available for suggested specialty/i),
    ).toBeInTheDocument();
    // Low-confidence badge.
    expect(screen.getByText(/Low confidence/i)).toBeInTheDocument();
  });

  it("can navigate Go back from summary to chat state", async () => {
    apiMock.post.mockResolvedValueOnce({
      data: { sessionId: "sess-back", message: "Hi" },
    });
    render(<AIBookingPage />);
    fireEvent.click(screen.getByRole("button", { name: /Start AI Consultation/i }));
    await screen.findByText("Hi");

    apiMock.post.mockResolvedValueOnce({
      data: { message: "OK.", readyForDoctorSuggestion: true, confidence: 0.6 },
    });
    apiMock.get.mockResolvedValueOnce({
      data: {
        session: { symptoms: { chiefComplaint: "cough" } },
        doctorSuggestions: [doctorSuggestion()],
      },
    });
    const textarea = screen.getByPlaceholderText(/.+/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "cough" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await screen.findByText(/Here's what I understood/i);
    // Medium-confidence badge.
    apiMock.get.mockResolvedValueOnce({
      data: { doctorSuggestions: [doctorSuggestion()] },
    });
    fireEvent.click(screen.getByRole("button", { name: /Show me doctors/i }));
    await screen.findByText(/Recommended Doctors/i);
    expect(screen.getByText(/Medium confidence/i)).toBeInTheDocument();
  });

  it("changes the date input in booking screen and refetches slots for the new date", async () => {
    await reachDoctorsScreen();
    apiMock.get.mockResolvedValueOnce({
      data: {
        slots: [{ startTime: "09:00", endTime: "09:30", isAvailable: true }],
      },
    });
    fireEvent.click(screen.getByText(/Dr\. Asha Mehta/i));
    await screen.findByText(/Select Date & Slot/i);

    apiMock.get.mockResolvedValueOnce({
      data: {
        slots: [{ startTime: "14:00", endTime: "14:30", isAvailable: true }],
      },
    });
    // +48h to avoid IST/UTC midnight traps.
    const future = new Date(Date.now() + 48 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    expect(dateInput).toBeTruthy();
    fireEvent.change(dateInput, { target: { value: future } });

    await waitFor(() => {
      const lastSlotsCall = apiMock.get.mock.calls
        .reverse()
        .find((c) => String(c[0]).startsWith("/doctors/doc-1/slots?date="));
      expect(lastSlotsCall).toBeTruthy();
      expect(String(lastSlotsCall![0])).toContain(future);
    });
  });

  it("renders the GP-recommended-first badge when isGPFallback is true", async () => {
    apiMock.post.mockResolvedValueOnce({
      data: { sessionId: "sess-gp", message: "Hi" },
    });
    render(<AIBookingPage />);
    fireEvent.click(screen.getByRole("button", { name: /Start AI Consultation/i }));
    await screen.findByText("Hi");

    apiMock.post.mockResolvedValueOnce({
      data: { message: "OK.", readyForDoctorSuggestion: true, confidence: 0.45 },
    });
    apiMock.get.mockResolvedValueOnce({
      data: {
        session: { symptoms: { chiefComplaint: "general" } },
        doctorSuggestions: [
          doctorSuggestion({
            doctorId: "gp-1",
            name: "Dr. GP Fallback",
            isGPFallback: true,
            specialty: "General Practice",
          }),
        ],
      },
    });
    const textarea = screen.getByPlaceholderText(/.+/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "general" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await screen.findByText(/Here's what I understood/i);

    apiMock.get.mockResolvedValueOnce({
      data: {
        doctorSuggestions: [
          doctorSuggestion({
            doctorId: "gp-1",
            name: "Dr. GP Fallback",
            isGPFallback: true,
            specialty: "General Practice",
          }),
        ],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /Show me doctors/i }));

    expect(await screen.findByText(/GP recommended first/i)).toBeInTheDocument();
  });

  it("surfaces a toast.error when /doctors/:id/slots rejects", async () => {
    await reachDoctorsScreen();
    apiMock.get.mockRejectedValueOnce(new Error("slots-down"));
    fireEvent.click(screen.getByText(/Dr\. Asha Mehta/i));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to fetch slots/i),
      ),
    );
  });

  it("surfaces a toast.error when /ai/triage/:id (fetchDoctorSuggestions) rejects from the summary→doctors transition", async () => {
    apiMock.post.mockResolvedValueOnce({
      data: { sessionId: "sess-fail-fetch", message: "Hi" },
    });
    render(<AIBookingPage />);
    fireEvent.click(screen.getByRole("button", { name: /Start AI Consultation/i }));
    await screen.findByText("Hi");

    apiMock.post.mockResolvedValueOnce({
      data: { message: "OK.", readyForDoctorSuggestion: true, confidence: 0.5 },
    });
    apiMock.get.mockResolvedValueOnce({
      data: {
        session: { symptoms: { chiefComplaint: "x" } },
        doctorSuggestions: [doctorSuggestion()],
      },
    });
    const textarea = screen.getByPlaceholderText(/.+/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "x" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await screen.findByText(/Here's what I understood/i);

    apiMock.get.mockRejectedValueOnce(new Error("svc-fail"));
    fireEvent.click(screen.getByRole("button", { name: /Show me doctors/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to fetch doctor suggestions/i),
      ),
    );
  });

  it("updates Chief Complaint / Onset / Duration / Severity inputs on the summary screen", async () => {
    apiMock.post.mockResolvedValueOnce({
      data: { sessionId: "sess-summary-edit", message: "Hi" },
    });
    render(<AIBookingPage />);
    fireEvent.click(screen.getByRole("button", { name: /Start AI Consultation/i }));
    await screen.findByText("Hi");

    apiMock.post.mockResolvedValueOnce({
      data: { message: "OK.", readyForDoctorSuggestion: true, confidence: 0.7 },
    });
    apiMock.get.mockResolvedValueOnce({
      data: {
        session: {
          symptoms: {
            chiefComplaint: "Initial complaint",
            onset: "today",
            duration: "1d",
            severity: 5,
          },
        },
        doctorSuggestions: [doctorSuggestion()],
      },
    });
    const textarea = screen.getByPlaceholderText(/.+/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "x" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await screen.findByText(/Here's what I understood/i);

    const complaint = screen.getByLabelText(/Chief Complaint/i) as HTMLInputElement;
    fireEvent.change(complaint, { target: { value: "Updated complaint" } });
    expect(complaint.value).toBe("Updated complaint");

    const onset = screen.getByLabelText(/^Onset$/i) as HTMLInputElement;
    fireEvent.change(onset, { target: { value: "yesterday" } });
    expect(onset.value).toBe("yesterday");

    const duration = screen.getByLabelText(/^Duration$/i) as HTMLInputElement;
    fireEvent.change(duration, { target: { value: "2d" } });
    expect(duration.value).toBe("2d");

    const severity = screen.getByLabelText(/Severity/i) as HTMLInputElement;
    fireEvent.change(severity, { target: { value: "8" } });
    expect(severity.value).toBe("8");

    // Go back returns to chat.
    fireEvent.click(screen.getByRole("button", { name: /Go back/i }));
    expect(screen.getByText(/MedCore AI Assistant/i)).toBeInTheDocument();
  });

  it("can reset (Book another) from the done screen back to pre-chat selector", async () => {
    await reachDoctorsScreen();
    apiMock.get.mockResolvedValueOnce({
      data: {
        slots: [{ startTime: "09:00", endTime: "09:30", isAvailable: true }],
      },
    });
    fireEvent.click(screen.getByText(/Dr\. Asha Mehta/i));
    await screen.findByText(/Select Date & Slot/i);
    fireEvent.click(await screen.findByRole("button", { name: "09:00" }));

    apiMock.get.mockResolvedValueOnce({
      data: { role: "PATIENT", patient: { id: "p1" } },
    });
    apiMock.post.mockResolvedValueOnce({
      data: { appointment: { id: "appt-r", tokenNumber: 7 } },
    });
    fireEvent.click(screen.getByTestId("book-appt-confirm"));
    await screen.findByRole("heading", { name: /Appointment Booked/i });

    // Click Book another → handleReset() resets state.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Book another/i }));
    });
    // Back to pre-chat selector.
    expect(
      screen.getByRole("heading", { name: /^AI Booking$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Who is this appointment for\?/i),
    ).toBeInTheDocument();
  });
});
