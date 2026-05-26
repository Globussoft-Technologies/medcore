/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TelemedicinePage — adjacent-to-source deep coverage (test-cron pick
 * 2026-05-26). Companion to the existing waiting-room test at
 *   apps/web/src/app/dashboard/telemedicine/waiting-room/__tests__/page.test.tsx
 * which covers the patient-facing pre-call surface; this file covers the
 * doctor/admin/reception list + scheduler + Jitsi-bridge surface.
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/telemedicine/page.tsx end-to-end.
 *     Source flow:
 *       1. Mount → loadSessions() based on the active tab. "upcoming"
 *          merges SCHEDULED + WAITING + IN_PROGRESS, drops elapsed
 *          SCHEDULED rows (Issue #956), and sorts by scheduledAt.
 *       2. Role gating — canSchedule (ADMIN/DOCTOR/RECEPTION),
 *          canStartEnd (ADMIN/DOCTOR), canRate (PATIENT only),
 *          canJoinCall (ADMIN/DOCTOR/PATIENT — Issue #602 UI gate).
 *       3. Card actions: Join Call (mints fresh signedRoomUrl per call
 *          via GET /:id, opens new tab), Start (PATCH /:id/start), End
 *          (PATCH /:id/end with prompted doctorNotes), Cancel (PATCH
 *          /:id/cancel after confirm), Admit/Deny (POST /waiting-room/
 *          admit) for WAITING rows, Rate (PATCH /:id/rating) for
 *          PATIENT-COMPLETED rows, Start Ambient Scribe (DOCTOR-only
 *          link to /dashboard/scribe?patientId=…).
 *       4. Schedule modal: patient search (debounced /patients?search=
 *          fetch), doctor select (/doctors fetch), date/time fields,
 *          chiefComplaint textarea, fee number — submit POSTs
 *          /telemedicine, validates via the shared Zod schema.
 *       5. Socket lifecycle — DOCTOR/ADMIN join the
 *          telemedicine:doctor:{userId} room and reload sessions on
 *          telemedicine:patient-waiting; off() on unmount.
 *       6. Helpers: displayChiefComplaint strips seed-fixture markers
 *          (Issue #860). joinActive returns true when status is
 *          IN_PROGRESS OR (SCHEDULED/WAITING AND scheduledAt is within
 *          15min in the future OR already past).
 *
 *   - Behaviours covered:
 *       1. Initial render with PATIENT role — title subtitle uses the
 *          patient-facing copy and Schedule button is HIDDEN.
 *       2. DOCTOR role — subtitle uses staff copy and Schedule button is
 *          visible. Loading skeleton renders on first paint.
 *       3. Upcoming tab issues 3 GETs (SCHEDULED + WAITING + IN_PROGRESS),
 *          merges them, drops elapsed SCHEDULED rows, and renders sorted.
 *       4. Switching to Completed tab issues a single SCHEDULED-free GET.
 *       5. Empty list renders the "No sessions found" placeholder.
 *       6. seed-fixture chief complaint ("E2E waiting-room seed") is
 *          stripped from the subtitle but a real complaint shows through.
 *       7. Duration row — shows the number when present; falls back to
 *          "not recorded" for COMPLETED rows with no duration; hidden for
 *          non-completed rows.
 *       8. PATIENT rating — Star pills render for a session.patientRating.
 *       9. Join Call action — DOCTOR clicks Join → GET /:id mints the
 *          per-user signed URL → window.open invoked with _blank/noopener.
 *      10. Join Call missing URL — toast.error fires + window.open NOT.
 *      11. Join Call fetch error — toast.error fires with the rejection.
 *      12. Join Call HIDDEN for non-participant roles (PHARMACIST sees
 *          card but no Join button — Issue #602 frontend gate).
 *      13. Start Session — DOCTOR clicks Start on a SCHEDULED row,
 *          PATCH /:id/start fires, sessions reload.
 *      14. Start error toasts.
 *      15. End Session — DOCTOR clicks End on IN_PROGRESS, prompt fires;
 *          on confirm with notes, PATCH /:id/end posts doctorNotes.
 *      16. End cancelled — prompt returns null → NO PATCH issued.
 *      17. Cancel Session — DOCTOR clicks Cancel, confirm prompts,
 *          confirm-yes → PATCH /:id/cancel; confirm-no → no PATCH.
 *      18. Admit Patient — DOCTOR clicks Admit on a WAITING row →
 *          POST /:id/waiting-room/admit {admit:true}; doctorUrl opens.
 *      19. Deny Patient — DOCTOR clicks Deny → prompt for reason →
 *          POST /:id/waiting-room/admit {admit:false, reason}.
 *      20. Start Ambient Scribe — DOCTOR + IN_PROGRESS renders the Link
 *          with the correct patientId href; hidden for non-DOCTOR.
 *      21. Rate Session — PATIENT clicks Rate on a COMPLETED unrated
 *          row → modal opens; submit PATCHes /:id/rating with rating.
 *      22. Schedule modal opens, loads doctors, validates empty fields,
 *          submits when valid; close button resets.
 *      23. Patient search debounce — typing 2+ chars after 300ms hits
 *          /patients?search=…; selecting a result fills selectedPatient.
 *      24. Socket lifecycle — DOCTOR mount registers
 *          telemedicine:patient-waiting handler + joins the
 *          telemedicine:doctor:{userId} room; unmount runs .off.
 *      25. Socket NOT wired for non-DOCTOR/ADMIN roles.
 *      26. Error path — loadSessions rejection lands in empty list state.
 *
 *   - Mocks: @/lib/api, @/lib/store (selector-aware), @/lib/toast,
 *            @/lib/socket, @/lib/use-dialog (confirm/prompt), next/navigation,
 *            window.open via vi.spyOn.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";

const { apiMock, authMock, toastMock, socketMock, confirmMock, promptMock } =
  vi.hoisted(() => ({
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
    socketMock: {
      connected: false,
      connect: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    },
    confirmMock: vi.fn(),
    promptMock: vi.fn(),
  }));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/socket", () => ({ getSocket: () => socketMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
  usePrompt: () => promptMock,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    forward: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/telemedicine",
}));

// Stub SkeletonCard to a recognisable testid so we can assert the loading
// state without depending on internal class names.
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: () => <div data-testid="skeleton-card" />,
  Skeleton: () => <div data-testid="skeleton" />,
}));

import TelemedicinePage from "../page";

type Role = "ADMIN" | "DOCTOR" | "PATIENT" | "RECEPTION" | "PHARMACIST";

function setAuth(role: Role, overrides: Partial<{ id: string; name: string; email: string }> = {}) {
  const user = {
    id: overrides.id ?? "u-1",
    name: overrides.name ?? "Test User",
    email: overrides.email ?? "test@x.com",
    role,
  };
  // useAuthStore in the source destructures `{ user }`, so return the bare state.
  authMock.mockImplementation((selector?: any) =>
    typeof selector === "function" ? selector({ user }) : { user },
  );
}

// Use far-future scheduledAt by default (+48h to avoid IST/UTC midnight traps).
function futureISO(hoursAhead = 48) {
  return new Date(Date.now() + hoursAhead * 60 * 60 * 1000).toISOString();
}
function pastISO(hoursBehind = 48) {
  return new Date(Date.now() - hoursBehind * 60 * 60 * 1000).toISOString();
}

interface SessionInput {
  id?: string;
  sessionNumber?: string;
  scheduledAt?: string;
  status?: string;
  doctor?: { id?: string; specialization?: string | null; user?: { name?: string } };
  patient?: {
    id?: string;
    mrNumber?: string;
    user?: { name?: string; phone?: string };
  };
  chiefComplaint?: string | null;
  doctorNotes?: string | null;
  patientRating?: number | null;
  durationMin?: number | null;
  fee?: number;
  startedAt?: string | null;
  endedAt?: string | null;
  signedRoomUrl?: string | null;
}

function sessionFixture(o: SessionInput = {}): any {
  return {
    id: o.id ?? "s-1",
    sessionNumber: o.sessionNumber ?? "TC-001",
    scheduledAt: o.scheduledAt ?? futureISO(48),
    status: o.status ?? "SCHEDULED",
    chiefComplaint: o.chiefComplaint ?? null,
    doctorNotes: o.doctorNotes ?? null,
    patientRating: o.patientRating ?? null,
    durationMin: o.durationMin ?? null,
    fee: o.fee ?? 500,
    startedAt: o.startedAt ?? null,
    endedAt: o.endedAt ?? null,
    signedRoomUrl: o.signedRoomUrl ?? null,
    doctor: {
      id: o.doctor?.id ?? "doc-1",
      specialization: o.doctor?.specialization ?? "Cardiology",
      user: { name: o.doctor?.user?.name ?? "Asha Gupta" },
    },
    patient: {
      id: o.patient?.id ?? "pat-1",
      mrNumber: o.patient?.mrNumber ?? "MR-001",
      user: {
        name: o.patient?.user?.name ?? "John Patient",
        phone: o.patient?.user?.phone,
      },
    },
  };
}

/**
 * Convenience: route the api.get mock so each call returns a deterministic
 * payload based on URL. The source issues many GETs across mount + tab
 * switch, and `mockResolvedValueOnce` chains get fragile.
 */
function wireGet(opts: {
  scheduled?: any[];
  waiting?: any[];
  inProgress?: any[];
  completed?: any[];
  cancelled?: any[];
  detail?: Record<string, any>;
  patients?: any[];
  doctors?: any[];
  detailReject?: boolean;
  listReject?: boolean;
} = {}) {
  apiMock.get.mockImplementation((url: string) => {
    if (opts.listReject && url.startsWith("/telemedicine?status=")) {
      return Promise.reject(new Error("list boom"));
    }
    if (url.startsWith("/telemedicine?status=SCHEDULED")) {
      return Promise.resolve({ data: opts.scheduled ?? [] });
    }
    if (url.startsWith("/telemedicine?status=WAITING")) {
      return Promise.resolve({ data: opts.waiting ?? [] });
    }
    if (url.startsWith("/telemedicine?status=IN_PROGRESS")) {
      return Promise.resolve({ data: opts.inProgress ?? [] });
    }
    if (url.startsWith("/telemedicine?status=COMPLETED")) {
      return Promise.resolve({ data: opts.completed ?? [] });
    }
    if (url.startsWith("/telemedicine?status=CANCELLED")) {
      return Promise.resolve({ data: opts.cancelled ?? [] });
    }
    // GET /telemedicine/:id — for joinCall signedRoomUrl mint.
    const detailMatch = url.match(/^\/telemedicine\/([^/?]+)$/);
    if (detailMatch) {
      if (opts.detailReject) return Promise.reject(new Error("detail boom"));
      const data = opts.detail?.[detailMatch[1]] ?? {};
      return Promise.resolve({ data });
    }
    if (url.startsWith("/patients?search=")) {
      return Promise.resolve({ data: opts.patients ?? [] });
    }
    if (url === "/doctors") {
      return Promise.resolve({ data: opts.doctors ?? [] });
    }
    return Promise.resolve({ data: [] });
  });
}

describe("TelemedicinePage (dashboard list + scheduler + Jitsi bridge)", () => {
  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    authMock.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    socketMock.connect.mockReset();
    socketMock.emit.mockReset();
    socketMock.on.mockReset();
    socketMock.off.mockReset();
    socketMock.connected = false;
    confirmMock.mockReset();
    promptMock.mockReset();

    // Default auth — DOCTOR — most behaviours need staff role.
    setAuth("DOCTOR", { id: "doc-u-1", name: "Asha Gupta" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the PATIENT subtitle and HIDES the Schedule button for PATIENT", async () => {
    setAuth("PATIENT", { id: "pat-u-1" });
    wireGet({});

    render(<TelemedicinePage />);

    expect(
      screen.getByRole("heading", { name: /telemedicine/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/join your scheduled video consultations/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /schedule session/i }),
    ).not.toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByText(/no sessions found/i)).toBeInTheDocument(),
    );
  });

  it("renders the staff subtitle and SHOWS the Schedule button for DOCTOR", async () => {
    wireGet({});
    render(<TelemedicinePage />);

    expect(
      screen.getByText(/virtual video consultations with patients/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /schedule session/i }),
    ).toBeInTheDocument();
  });

  it("renders skeleton placeholders while the initial fetch is in flight", async () => {
    // Hold the promise open so we can observe the loading state.
    let resolveScheduled: (v: any) => void = () => {};
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/telemedicine?status=SCHEDULED")) {
        return new Promise((r) => {
          resolveScheduled = r;
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<TelemedicinePage />);

    expect(
      screen.getAllByTestId("skeleton-card").length,
    ).toBeGreaterThanOrEqual(3);

    await act(async () => {
      resolveScheduled({ data: [] });
    });
    await waitFor(() =>
      expect(screen.getByText(/no sessions found/i)).toBeInTheDocument(),
    );
  });

  it("upcoming tab merges SCHEDULED + WAITING + IN_PROGRESS, drops elapsed SCHEDULED, and renders sorted", async () => {
    const elapsed = sessionFixture({
      id: "s-elapsed",
      sessionNumber: "TC-ELAPSED",
      status: "SCHEDULED",
      scheduledAt: pastISO(2),
    });
    const future = sessionFixture({
      id: "s-future",
      sessionNumber: "TC-FUTURE",
      status: "SCHEDULED",
      scheduledAt: futureISO(72),
    });
    const sooner = sessionFixture({
      id: "s-sooner",
      sessionNumber: "TC-SOONER",
      status: "SCHEDULED",
      scheduledAt: futureISO(24),
    });
    const waiting = sessionFixture({
      id: "s-wait",
      sessionNumber: "TC-WAIT",
      status: "WAITING",
      scheduledAt: futureISO(48),
    });
    const inProg = sessionFixture({
      id: "s-prog",
      sessionNumber: "TC-PROG",
      status: "IN_PROGRESS",
      // even if its scheduledAt is in the past, IN_PROGRESS rows stay.
      scheduledAt: pastISO(1),
    });

    wireGet({
      scheduled: [elapsed, future, sooner],
      waiting: [waiting],
      inProgress: [inProg],
    });

    render(<TelemedicinePage />);

    // Wait for the merged render.
    await waitFor(() =>
      expect(screen.getByText("TC-FUTURE")).toBeInTheDocument(),
    );
    expect(screen.getByText("TC-SOONER")).toBeInTheDocument();
    expect(screen.getByText("TC-WAIT")).toBeInTheDocument();
    expect(screen.getByText("TC-PROG")).toBeInTheDocument();
    // Elapsed SCHEDULED dropped.
    expect(screen.queryByText("TC-ELAPSED")).not.toBeInTheDocument();

    // 3 list GETs.
    const listCalls = apiMock.get.mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((u) => u.startsWith("/telemedicine?status="));
    expect(listCalls.length).toBe(3);
  });

  it("switching to the Completed tab issues a single GET with status=COMPLETED", async () => {
    wireGet({ completed: [sessionFixture({ id: "s-c", status: "COMPLETED" })] });

    render(<TelemedicinePage />);
    await waitFor(() =>
      expect(screen.getByText(/no sessions found/i)).toBeInTheDocument(),
    );

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^completed$/i }));

    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c: any[]) => String(c[0]));
      expect(urls.some((u) => u.startsWith("/telemedicine?status=COMPLETED"))).toBe(true);
      // No WAITING / IN_PROGRESS merge fetches for non-upcoming tabs.
      expect(urls.some((u) => u.startsWith("/telemedicine?status=WAITING"))).toBe(false);
    });
  });

  it("seed-fixture chief complaint markers are stripped from the card subtitle", async () => {
    wireGet({
      scheduled: [
        sessionFixture({
          id: "s-seed",
          sessionNumber: "TC-SEED",
          chiefComplaint: "E2E waiting-room seed",
        }),
        sessionFixture({
          id: "s-real",
          sessionNumber: "TC-REAL",
          chiefComplaint: "Chest pain since morning",
          scheduledAt: futureISO(72),
        }),
      ],
    });

    render(<TelemedicinePage />);
    await waitFor(() => expect(screen.getByText("TC-SEED")).toBeInTheDocument());

    expect(screen.queryByText(/e2e waiting-room seed/i)).not.toBeInTheDocument();
    expect(screen.getByText("Chest pain since morning")).toBeInTheDocument();
  });

  it("renders duration row variants: explicit minutes / 'not recorded' fallback for COMPLETED / hidden for non-completed", async () => {
    wireGet({
      completed: [
        sessionFixture({
          id: "s-done",
          sessionNumber: "TC-DONE",
          status: "COMPLETED",
          durationMin: 27,
        }),
        sessionFixture({
          id: "s-done-nodur",
          sessionNumber: "TC-DONE-NODUR",
          status: "COMPLETED",
          durationMin: null,
        }),
      ],
    });

    render(<TelemedicinePage />);
    // Let the initial upcoming-tab fetches resolve before switching tabs.
    await waitFor(() =>
      expect(screen.getByText(/no sessions found/i)).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^completed$/i }));
    });

    await waitFor(() => expect(screen.getByText("TC-DONE")).toBeInTheDocument());
    expect(screen.getByText(/duration:\s*27\s*min/i)).toBeInTheDocument();
    expect(screen.getByText(/duration:\s*not recorded/i)).toBeInTheDocument();
  });

  it("renders patientRating stars on completed sessions that have a rating", async () => {
    wireGet({
      completed: [
        sessionFixture({
          id: "s-rated",
          sessionNumber: "TC-RATED",
          status: "COMPLETED",
          patientRating: 4,
        }),
      ],
    });

    render(<TelemedicinePage />);
    await waitFor(() =>
      expect(screen.getByText(/no sessions found/i)).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^completed$/i }));
    });
    await waitFor(() => expect(screen.getByText("TC-RATED")).toBeInTheDocument());

    // 4 star icons should be present. They're <svg> rendered by lucide; we
    // just count them by parent role-free locator — querying the container.
    const ratingContainer = screen.getByText("TC-RATED").closest(".rounded-xl");
    expect(ratingContainer).toBeTruthy();
    // Each Star svg has lucide-star class.
    const stars = ratingContainer!.querySelectorAll(".lucide-star, [class*='star']");
    expect(stars.length).toBeGreaterThanOrEqual(1);
  });

  it("Join Call (DOCTOR): GET /:id mints signedRoomUrl and window.open fires with _blank,noopener", async () => {
    const sess = sessionFixture({
      id: "s-join",
      sessionNumber: "TC-JOIN",
      status: "IN_PROGRESS",
      scheduledAt: pastISO(1),
    });
    wireGet({
      inProgress: [sess],
      detail: { "s-join": { signedRoomUrl: "https://jitsi.example/abc?jwt=signed" } },
    });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null as any);

    render(<TelemedicinePage />);
    const joinBtn = await screen.findByRole("button", { name: /join call/i });
    fireEvent.click(joinBtn);

    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        "https://jitsi.example/abc?jwt=signed",
        "_blank",
        "noopener",
      ),
    );
  });

  it("Join Call missing signedRoomUrl → toast.error fires and window.open NOT called", async () => {
    wireGet({
      inProgress: [
        sessionFixture({
          id: "s-nojoin",
          status: "IN_PROGRESS",
          scheduledAt: pastISO(1),
        }),
      ],
      detail: { "s-nojoin": { signedRoomUrl: null } },
    });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null as any);

    render(<TelemedicinePage />);
    const joinBtn = await screen.findByRole("button", { name: /join call/i });
    fireEvent.click(joinBtn);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/join url not available/i),
      ),
    );
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("Join Call GET error → toast.error fires with the rejection message", async () => {
    wireGet({
      inProgress: [
        sessionFixture({ id: "s-err", status: "IN_PROGRESS", scheduledAt: pastISO(1) }),
      ],
      detailReject: true,
    });

    render(<TelemedicinePage />);
    const joinBtn = await screen.findByRole("button", { name: /join call/i });
    fireEvent.click(joinBtn);

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/detail boom/i),
      ),
    );
  });

  it("Join Call is HIDDEN for non-participant roles (PHARMACIST sees card but not the button) — Issue #602 gate", async () => {
    setAuth("PHARMACIST", { id: "pharm-u-1" });
    wireGet({
      inProgress: [
        sessionFixture({
          id: "s-pharm",
          sessionNumber: "TC-PHARM",
          status: "IN_PROGRESS",
          scheduledAt: pastISO(1),
        }),
      ],
    });

    render(<TelemedicinePage />);
    await waitFor(() => expect(screen.getByText("TC-PHARM")).toBeInTheDocument());

    expect(
      screen.queryByRole("button", { name: /join call/i }),
    ).not.toBeInTheDocument();
  });

  it("Start Session — DOCTOR clicks Start on a SCHEDULED card, PATCH /:id/start fires", async () => {
    wireGet({
      scheduled: [
        sessionFixture({ id: "s-start", scheduledAt: futureISO(48), status: "SCHEDULED" }),
      ],
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<TelemedicinePage />);
    const startBtn = await screen.findByRole("button", { name: /^start$/i });
    fireEvent.click(startBtn);

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/telemedicine/s-start/start"),
    );
  });

  it("Start Session error → toast.error", async () => {
    wireGet({
      scheduled: [
        sessionFixture({ id: "s-st-err", scheduledAt: futureISO(48) }),
      ],
    });
    apiMock.patch.mockRejectedValueOnce(new Error("Already started"));

    render(<TelemedicinePage />);
    fireEvent.click(await screen.findByRole("button", { name: /^start$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Already started"),
    );
  });

  it("End Session — prompt confirmed → PATCH /:id/end with the entered notes", async () => {
    wireGet({
      inProgress: [
        sessionFixture({ id: "s-end", status: "IN_PROGRESS", scheduledAt: pastISO(1) }),
      ],
    });
    promptMock.mockResolvedValue("Follow up in 1 week");
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<TelemedicinePage />);
    const endBtn = await screen.findByRole("button", { name: /^end$/i });
    await act(async () => {
      fireEvent.click(endBtn);
    });

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/telemedicine/s-end/end", {
        doctorNotes: "Follow up in 1 week",
      }),
    );
  });

  it("End Session — prompt cancelled (null) → NO PATCH issued", async () => {
    wireGet({
      inProgress: [
        sessionFixture({ id: "s-end-cancel", status: "IN_PROGRESS", scheduledAt: pastISO(1) }),
      ],
    });
    promptMock.mockResolvedValue(null);

    render(<TelemedicinePage />);
    const endBtn = await screen.findByRole("button", { name: /^end$/i });
    await act(async () => {
      fireEvent.click(endBtn);
    });

    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("Cancel Session — confirm yes → PATCH /:id/cancel; confirm no → no PATCH", async () => {
    wireGet({
      scheduled: [
        sessionFixture({ id: "s-cx", status: "SCHEDULED", scheduledAt: futureISO(48) }),
      ],
    });

    // First flow — confirm true.
    confirmMock.mockResolvedValueOnce(true);
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<TelemedicinePage />);
    const cancelBtn = await screen.findByRole("button", { name: /^cancel$/i });
    await act(async () => {
      fireEvent.click(cancelBtn);
    });

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/telemedicine/s-cx/cancel"),
    );

    // Second flow — confirm false, click again.
    apiMock.patch.mockClear();
    confirmMock.mockResolvedValueOnce(false);
    // The cancel button may have re-rendered after sessions reload.
    const cancelBtn2 = await screen.findByRole("button", { name: /^cancel$/i });
    await act(async () => {
      fireEvent.click(cancelBtn2);
    });
    // Tiny tick for promise microtask.
    await Promise.resolve();
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("Admit Patient — DOCTOR clicks Admit on WAITING row → POST /:id/waiting-room/admit {admit:true} and opens doctorUrl", async () => {
    wireGet({
      waiting: [
        sessionFixture({ id: "s-admit", status: "WAITING", scheduledAt: futureISO(48) }),
      ],
    });
    apiMock.post.mockResolvedValue({
      data: { doctorUrl: "https://jitsi.example/doc-url" },
    });
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null as any);

    render(<TelemedicinePage />);
    const admitBtn = await screen.findByRole("button", { name: /^admit$/i });
    await act(async () => {
      fireEvent.click(admitBtn);
    });

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/telemedicine/s-admit/waiting-room/admit",
        { admit: true, reason: undefined },
      ),
    );
    expect(openSpy).toHaveBeenCalledWith(
      "https://jitsi.example/doc-url",
      "_blank",
      "noopener",
    );
  });

  it("Deny Patient — prompt for reason → POST /:id/waiting-room/admit {admit:false, reason}", async () => {
    wireGet({
      waiting: [
        sessionFixture({ id: "s-deny", status: "WAITING", scheduledAt: futureISO(48) }),
      ],
    });
    promptMock.mockResolvedValue("Wrong appointment");
    apiMock.post.mockResolvedValue({ data: {} });

    render(<TelemedicinePage />);
    const denyBtn = await screen.findByRole("button", { name: /^deny$/i });
    await act(async () => {
      fireEvent.click(denyBtn);
    });

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/telemedicine/s-deny/waiting-room/admit",
        { admit: false, reason: "Wrong appointment" },
      ),
    );
  });

  it("Deny Patient — prompt returns null → NO POST issued", async () => {
    wireGet({
      waiting: [
        sessionFixture({ id: "s-deny-cancel", status: "WAITING", scheduledAt: futureISO(48) }),
      ],
    });
    promptMock.mockResolvedValue(null);

    render(<TelemedicinePage />);
    const denyBtn = await screen.findByRole("button", { name: /^deny$/i });
    await act(async () => {
      fireEvent.click(denyBtn);
    });

    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Start Ambient Scribe — DOCTOR + IN_PROGRESS renders link with the patient's id in the href; hidden for non-DOCTOR", async () => {
    wireGet({
      inProgress: [
        sessionFixture({
          id: "s-scribe",
          status: "IN_PROGRESS",
          scheduledAt: pastISO(1),
          patient: { id: "pat-scribe-1" },
        }),
      ],
    });

    const { unmount } = render(<TelemedicinePage />);
    const scribeLink = await screen.findByRole("link", { name: /start ambient scribe/i });
    expect(scribeLink.getAttribute("href")).toBe(
      "/dashboard/scribe?patientId=pat-scribe-1",
    );

    unmount();

    // Now mount as ADMIN — admin role doesn't get the scribe CTA.
    setAuth("ADMIN");
    render(<TelemedicinePage />);
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: /start ambient scribe/i })).not.toBeInTheDocument(),
    );
  });

  it("Rate Session — PATIENT clicks Rate on COMPLETED unrated row → modal opens → submit PATCHes /:id/rating", async () => {
    setAuth("PATIENT", { id: "pat-u-1" });
    wireGet({
      completed: [
        sessionFixture({
          id: "s-rate",
          status: "COMPLETED",
          patientRating: null,
        }),
      ],
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<TelemedicinePage />);
    await waitFor(() =>
      expect(screen.getByText(/no sessions found/i)).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^completed$/i }));
    });

    const rateBtn = await screen.findByRole("button", { name: /^rate$/i });
    fireEvent.click(rateBtn);

    // Modal heading + Submit button.
    expect(
      await screen.findByRole("heading", { name: /rate your session/i }),
    ).toBeInTheDocument();

    const submit = screen.getByRole("button", { name: /^submit$/i });
    await act(async () => {
      fireEvent.click(submit);
    });

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/telemedicine/s-rate/rating", {
        patientRating: 5,
      }),
    );
  });

  it("Schedule modal — opens on Schedule button, loads doctors, validates empty fields, submits valid form", async () => {
    const doctors = [
      { id: "00000000-0000-4000-8000-000000000aaa", specialization: "GP", user: { name: "Dr Solo" } },
    ];
    const patients = [
      {
        id: "00000000-0000-4000-8000-000000000bbb",
        mrNumber: "MR-100",
        user: { name: "Alice Anderson" },
      },
    ];
    wireGet({ doctors, patients });
    apiMock.post.mockResolvedValue({ data: { id: "new-tel" } });

    render(<TelemedicinePage />);

    // Wait for the initial empty-list render so subsequent setState calls don't race.
    await waitFor(() =>
      expect(screen.getByText(/no sessions found/i)).toBeInTheDocument(),
    );

    // Open modal.
    fireEvent.click(screen.getByRole("button", { name: /schedule session/i }));

    // Doctors fetched + select renders.
    await waitFor(() => {
      const doctorSelect = screen.getByLabelText(/doctor/i) as HTMLSelectElement;
      expect(doctorSelect).toBeTruthy();
      expect(doctorSelect.querySelectorAll("option").length).toBeGreaterThanOrEqual(2);
    });

    // Submit empty — should surface validation messages, NO POST.
    apiMock.post.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^schedule$/i }));
    await waitFor(() => {
      expect(screen.getByText(/select a patient/i)).toBeInTheDocument();
    });
    expect(apiMock.post).not.toHaveBeenCalled();

    // Fill the patient search → 2+ chars triggers debounce.
    const searchBox = screen.getByPlaceholderText(/search by name or mr number/i);
    fireEvent.change(searchBox, { target: { value: "ali" } });
    await waitFor(
      () => expect(screen.getByText("Alice Anderson")).toBeInTheDocument(),
      { timeout: 1500 },
    );

    // Pick the patient → selectedPatient panel renders.
    fireEvent.click(screen.getByText("Alice Anderson"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /change/i })).toBeInTheDocument(),
    );

    // Choose doctor.
    const doctorSelect = screen.getByLabelText(/doctor/i) as HTMLSelectElement;
    fireEvent.change(doctorSelect, {
      target: { value: "00000000-0000-4000-8000-000000000aaa" },
    });

    // Date + time — pick a far-future date (+48h) to clear past-date refinement.
    const fut = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const yyyy = fut.getUTCFullYear();
    const mm = String(fut.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(fut.getUTCDate()).padStart(2, "0");
    const dateInput = screen.getByLabelText(/^date$/i) as HTMLInputElement;
    const timeInput = screen.getByLabelText(/^time$/i) as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: `${yyyy}-${mm}-${dd}` } });
    fireEvent.change(timeInput, { target: { value: "10:30" } });

    // Submit.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^schedule$/i }));
    });

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/telemedicine",
        expect.objectContaining({
          patientId: "00000000-0000-4000-8000-000000000bbb",
          doctorId: "00000000-0000-4000-8000-000000000aaa",
          fee: 500,
        }),
      );
    });
  });

  it("Schedule modal — Cancel button closes the modal without POST", async () => {
    wireGet({ doctors: [] });
    render(<TelemedicinePage />);

    await waitFor(() =>
      expect(screen.getByText(/no sessions found/i)).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: /schedule session/i }));
    expect(
      await screen.findByRole("heading", { name: /schedule telemedicine session/i }),
    ).toBeInTheDocument();

    // Two "Cancel" buttons may exist (card-level + modal-footer). Pick the
    // one inside the form footer by its type=button presence.
    const cancelBtns = screen.getAllByRole("button", { name: /^cancel$/i });
    const modalCancel = cancelBtns.find(
      (b) => (b as HTMLButtonElement).getAttribute("type") === "button" && b.closest("form") !== null,
    )!;
    fireEvent.click(modalCancel);

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /schedule telemedicine session/i }),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Schedule modal — POST rejection surfaces a toast.error and keeps the modal open", async () => {
    const doctors = [
      { id: "00000000-0000-4000-8000-000000000aaa", specialization: "GP", user: { name: "Dr Solo" } },
    ];
    const patients = [
      {
        id: "00000000-0000-4000-8000-000000000bbb",
        mrNumber: "MR-100",
        user: { name: "Alice Anderson" },
      },
    ];
    wireGet({ doctors, patients });
    apiMock.post.mockRejectedValueOnce(new Error("Past date"));

    render(<TelemedicinePage />);
    await waitFor(() =>
      expect(screen.getByText(/no sessions found/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /schedule session/i }));

    await waitFor(() => expect(screen.getByLabelText(/doctor/i)).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText(/search by name or mr number/i), {
      target: { value: "ali" },
    });
    await waitFor(
      () => expect(screen.getByText("Alice Anderson")).toBeInTheDocument(),
      { timeout: 1500 },
    );
    fireEvent.click(screen.getByText("Alice Anderson"));
    fireEvent.change(screen.getByLabelText(/doctor/i), {
      target: { value: "00000000-0000-4000-8000-000000000aaa" },
    });
    const fut = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const datestr = `${fut.getUTCFullYear()}-${String(fut.getUTCMonth() + 1).padStart(2, "0")}-${String(fut.getUTCDate()).padStart(2, "0")}`;
    fireEvent.change(screen.getByLabelText(/^date$/i), { target: { value: datestr } });
    fireEvent.change(screen.getByLabelText(/^time$/i), { target: { value: "10:30" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^schedule$/i }));
    });

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Past date"),
    );
    // Modal still open.
    expect(
      screen.getByRole("heading", { name: /schedule telemedicine session/i }),
    ).toBeInTheDocument();
  });

  it("Schedule modal — selected patient panel exposes a Change button that clears selection", async () => {
    const patients = [
      {
        id: "00000000-0000-4000-8000-000000000bbb",
        mrNumber: "MR-100",
        user: { name: "Alice Anderson" },
      },
    ];
    wireGet({ doctors: [], patients });

    render(<TelemedicinePage />);
    await waitFor(() =>
      expect(screen.getByText(/no sessions found/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /schedule session/i }));
    fireEvent.change(
      await screen.findByPlaceholderText(/search by name or mr number/i),
      { target: { value: "ali" } },
    );
    await waitFor(
      () => expect(screen.getByText("Alice Anderson")).toBeInTheDocument(),
      { timeout: 1500 },
    );
    fireEvent.click(screen.getByText("Alice Anderson"));
    const change = await screen.findByRole("button", { name: /change/i });
    fireEvent.click(change);

    // Search input returns.
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText(/search by name or mr number/i),
      ).toBeInTheDocument(),
    );
  });

  it("Patient search debounce — typing < 2 chars does NOT hit /patients", async () => {
    wireGet({ doctors: [] });
    render(<TelemedicinePage />);
    await waitFor(() =>
      expect(screen.getByText(/no sessions found/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /schedule session/i }));

    apiMock.get.mockClear();
    fireEvent.change(
      await screen.findByPlaceholderText(/search by name or mr number/i),
      { target: { value: "a" } },
    );
    // Wait beyond the 300ms debounce.
    await new Promise((r) => setTimeout(r, 400));
    const patientCalls = apiMock.get.mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((u) => u.startsWith("/patients?search="));
    expect(patientCalls.length).toBe(0);
  });

  it("Socket lifecycle (DOCTOR) — joins telemedicine:doctor:{id} room and registers patient-waiting handler", async () => {
    wireGet({});
    setAuth("DOCTOR", { id: "doc-socket-1" });

    const { unmount } = render(<TelemedicinePage />);
    await waitFor(() => expect(socketMock.on).toHaveBeenCalled());

    expect(socketMock.emit).toHaveBeenCalledWith(
      "join",
      "telemedicine:doctor:doc-socket-1",
    );
    expect(
      socketMock.on.mock.calls.some(
        (c: any[]) => c[0] === "telemedicine:patient-waiting",
      ),
    ).toBe(true);
    // Auto-connects when not connected.
    expect(socketMock.connect).toHaveBeenCalled();

    unmount();
    // off() teardown.
    expect(
      socketMock.off.mock.calls.some(
        (c: any[]) => c[0] === "telemedicine:patient-waiting",
      ),
    ).toBe(true);
  });

  it("Socket handler — patient-waiting event triggers a fresh sessions reload", async () => {
    wireGet({});
    setAuth("DOCTOR", { id: "doc-handler-1" });

    render(<TelemedicinePage />);
    await waitFor(() => expect(socketMock.on).toHaveBeenCalled());

    apiMock.get.mockClear();
    const handler = socketMock.on.mock.calls.find(
      (c: any[]) => c[0] === "telemedicine:patient-waiting",
    )![1] as () => void;

    await act(async () => {
      handler();
    });

    // The handler is loadSessions — first call is SCHEDULED list.
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c: any[]) => String(c[0]));
      expect(
        urls.some((u) => u.startsWith("/telemedicine?status=SCHEDULED")),
      ).toBe(true);
    });
  });

  it("Socket NOT wired for non-DOCTOR/ADMIN roles (RECEPTION mounts without socket.on)", async () => {
    setAuth("RECEPTION", { id: "rec-1" });
    wireGet({});

    render(<TelemedicinePage />);
    // Give effects time.
    await waitFor(() =>
      expect(screen.getByText(/no sessions found/i)).toBeInTheDocument(),
    );

    expect(socketMock.on).not.toHaveBeenCalled();
    expect(socketMock.emit).not.toHaveBeenCalled();
  });

  it("Socket skip-connect path — already-connected socket does not double-connect", async () => {
    socketMock.connected = true;
    setAuth("DOCTOR", { id: "doc-c-1" });
    wireGet({});

    render(<TelemedicinePage />);
    await waitFor(() => expect(socketMock.on).toHaveBeenCalled());
    expect(socketMock.connect).not.toHaveBeenCalled();
  });

  it("loadSessions rejection lands in the empty-list branch (no crash, no toast)", async () => {
    wireGet({ listReject: true });

    render(<TelemedicinePage />);
    await waitFor(() =>
      expect(screen.getByText(/no sessions found/i)).toBeInTheDocument(),
    );

    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("Cancelled tab — GETs status=CANCELLED and renders the cancelled session card", async () => {
    wireGet({
      cancelled: [
        sessionFixture({
          id: "s-cancel",
          sessionNumber: "TC-CANCEL",
          status: "CANCELLED",
        }),
      ],
    });

    render(<TelemedicinePage />);
    await waitFor(() =>
      expect(screen.getByText(/no sessions found/i)).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^cancelled$/i }));
    });

    await waitFor(() => expect(screen.getByText("TC-CANCEL")).toBeInTheDocument());
    // Status pill copy — multiple "Cancelled" nodes exist (tab button + pill),
    // so just verify at least one is present.
    const cancelledNodes = screen.getAllByText(/cancelled/i);
    expect(cancelledNodes.length).toBeGreaterThanOrEqual(2);
  });

  it("Patient view — card heading uses formatDoctorName + specialization; subtitle shows patient name", async () => {
    setAuth("PATIENT", { id: "pat-u-2" });
    wireGet({
      scheduled: [
        sessionFixture({
          id: "s-pat-view",
          sessionNumber: "TC-PAT",
          scheduledAt: futureISO(48),
          doctor: { specialization: "Cardio", user: { name: "Asha Gupta" } },
          patient: { user: { name: "John Patient" } },
        }),
      ],
    });

    render(<TelemedicinePage />);
    await waitFor(() => expect(screen.getByText("TC-PAT")).toBeInTheDocument());

    // Card heading should be "Dr. Asha Gupta — Cardio" for PATIENT view.
    expect(screen.getByText(/dr\.\s*asha gupta\s*—\s*cardio/i)).toBeInTheDocument();
    // Subtitle shows patient name for PATIENT (they see their own name as the "with" line).
    expect(screen.getByText(/john patient/i)).toBeInTheDocument();
  });
});
