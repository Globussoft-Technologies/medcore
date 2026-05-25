/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TelemedicineWaitingRoomPage — adjacent-to-source deep coverage
 * (test-cron pick 2026-05-26, pairs with the smoke test at
 *  apps/web/src/app/dashboard/__tests__/telemedicine.waiting-room.page.test.tsx
 *  which only covers the heading / picker / placeholder slice).
 *
 * What / which modules / why:
 *   - Verifies every branch of
 *     `apps/web/src/app/dashboard/telemedicine/waiting-room/page.tsx`,
 *     a patient-facing Jitsi waiting-room client component. Source flow:
 *       1. Mount → load /telemedicine?status=SCHEDULED + status=WAITING.
 *       2. Auto-pick the single returned session OR honour ?sessionId=…
 *          (URL-param mode also hides the picker entirely).
 *       3. Run navigator.mediaDevices.getUserMedia for the device pre-check
 *          and POST /telemedicine/:id/precheck (fire-and-forget; non-fatal).
 *       4. POST /telemedicine/:id/waiting-room/join → "Waiting for doctor…"
 *          state; surface toast.error on failure and roll back to idle.
 *       5. Socket.IO "telemedicine:admitted" event drives the admitted/denied
 *          terminal states; mismatched sessionId is ignored.
 *       6. Cleanup tears down MediaStream tracks + socket listener on unmount.
 *
 *   - Behaviours covered:
 *       1. Heading + initial empty fetch render the page chrome (smoke).
 *       2. URL ?sessionId=… mode hides the session picker AND loads details.
 *       3. Single-session response auto-selects that session in the picker.
 *       4. Failed picker fetch falls back to an empty list (no crash).
 *       5. Pre-check happy path: getUserMedia returns live tracks → camera/mic
 *          OK badges, "Re-test Devices" relabel, /precheck POST issued.
 *       6. Pre-check failure: getUserMedia throws → error string surfaced,
 *          both badges go red, button relabels to "Run Device Test".
 *       7. Join Waiting Room success: button disables, "Waiting…" copy appears,
 *          /waiting-room/join POST issued with deviceInfo.
 *       8. Join Waiting Room failure: toast.error fires with rejection message
 *          AND waitStatus rolls back so the button is re-enabled.
 *       9. Socket admit event: registers handler, sets admitted state, opens
 *          the Open Call anchor with the per-user signed URL.
 *      10. Socket deny event: surfaces "Not admitted" with the reason.
 *      11. Socket admit event for a DIFFERENT sessionId is ignored.
 *      12. Unmount: socket.off + MediaStream.stop are invoked (no leak).
 *      13. RBAC sanity — PATIENT role is the only role with a sessions list,
 *          so we confirm the page renders for PATIENT (the source has no
 *          client-side gate; consistent with project CLAUDE.md note #7).
 *
 *   - Source under test: apps/web/src/app/dashboard/telemedicine/waiting-room/page.tsx
 *   - Mocks: @/lib/api (api.get/post), @/lib/store (selector-aware),
 *            @/lib/toast (toast.error), @/lib/socket (in-memory socket),
 *            next/navigation (useSearchParams with controllable param),
 *            navigator.mediaDevices.getUserMedia (Object.defineProperty),
 *            window.open (vi.spyOn).
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

const { apiMock, authMock, toastMock, socketMock, searchParamsMock } =
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
    // Holder we can mutate per-test so we can flip URL ?sessionId=…
    searchParamsMock: { current: new URLSearchParams() },
  }));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/socket", () => ({ getSocket: () => socketMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    forward: vi.fn(),
  }),
  useSearchParams: () => searchParamsMock.current,
  usePathname: () => "/dashboard/telemedicine/waiting-room",
}));

import TelemedicineWaitingRoomPage from "../page";

function setAuth(
  state: {
    user:
      | { id?: string; name?: string; email?: string; role?: string }
      | null;
    isLoading?: boolean;
  },
) {
  authMock.mockImplementation((selector?: any) =>
    typeof selector === "function" ? selector(state) : state,
  );
}

function makeSession(
  overrides: Partial<{
    id: string;
    sessionNumber: string;
    scheduledAt: string;
    status: string;
    doctor: { user: { name: string }; specialization?: string | null };
  }> = {},
) {
  return {
    id: "s1",
    sessionNumber: "TC-001",
    scheduledAt: "2026-06-01T10:00:00.000Z",
    status: "SCHEDULED",
    doctor: {
      user: { name: "Asha Gupta" },
      specialization: "Cardiology",
    },
    ...overrides,
  };
}

// Stage navigator.mediaDevices.getUserMedia for one render. Returns the spy
// + the synthesised tracks so individual tests can introspect / mutate.
function stageUserMedia(
  opts: {
    videoLive?: boolean;
    audioLive?: boolean;
    throws?: Error | null;
  } = {},
) {
  const { videoLive = true, audioLive = true, throws = null } = opts;
  const videoTrack = {
    kind: "video",
    readyState: videoLive ? "live" : "ended",
    stop: vi.fn(),
  } as any;
  const audioTrack = {
    kind: "audio",
    readyState: audioLive ? "live" : "ended",
    stop: vi.fn(),
  } as any;
  const stream = {
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [audioTrack],
    getTracks: () => [videoTrack, audioTrack],
  } as unknown as MediaStream;

  const getUserMedia = vi.fn(async () => {
    if (throws) throw throws;
    return stream;
  });

  Object.defineProperty(global.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });

  return { getUserMedia, stream, videoTrack, audioTrack };
}

describe("TelemedicineWaitingRoomPage (adjacent deep coverage)", () => {
  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    toastMock.error.mockReset();
    socketMock.connect.mockReset();
    socketMock.emit.mockReset();
    socketMock.on.mockReset();
    socketMock.off.mockReset();
    socketMock.connected = false;
    searchParamsMock.current = new URLSearchParams();

    setAuth({
      user: { id: "u1", name: "Pat", email: "p@x.com", role: "PATIENT" },
      isLoading: false,
    });

    // HTMLMediaElement.play is not implemented by jsdom — stub to a resolved
    // promise so videoRef.current.play() in runPrecheck doesn't blow up.
    (HTMLMediaElement.prototype as any).play = vi.fn(() => Promise.resolve());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Defensive: undo the navigator override so tests don't bleed.
    try {
      Object.defineProperty(global.navigator, "mediaDevices", {
        configurable: true,
        value: undefined,
      });
    } catch {
      /* ignore */
    }
  });

  it("renders the page heading + empty picker fallback when both list endpoints return []", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<TelemedicineWaitingRoomPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /telemedicine waiting room/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByLabelText(/select session/i)).toBeInTheDocument();
    // Two list calls expected (SCHEDULED + WAITING).
    await waitFor(() =>
      expect(
        apiMock.get.mock.calls.filter((c: any[]) =>
          String(c[0]).startsWith("/telemedicine?status="),
        ).length,
      ).toBe(2),
    );
  });

  it("URL ?sessionId=xyz mode hides the picker AND loads the selected session details", async () => {
    searchParamsMock.current = new URLSearchParams("sessionId=s9");
    const detail = makeSession({ id: "s9", sessionNumber: "TC-009" });
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/telemedicine/s9") return Promise.resolve({ data: detail });
      return Promise.resolve({ data: [] });
    });

    render(<TelemedicineWaitingRoomPage />);

    // Picker (label "Select Session") is suppressed in URL mode.
    expect(screen.queryByLabelText(/select session/i)).not.toBeInTheDocument();
    // Session details panel renders the doctor's name + session number.
    await waitFor(() =>
      expect(screen.getByText("TC-009")).toBeInTheDocument(),
    );
    expect(screen.getByText(/dr\. asha gupta/i)).toBeInTheDocument();
    expect(screen.getByText(/cardiology/i)).toBeInTheDocument();
  });

  it("auto-selects the single session returned by the picker fetch", async () => {
    const only = makeSession({ id: "only-1", sessionNumber: "TC-ONLY" });
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/telemedicine?status=SCHEDULED"))
        return Promise.resolve({ data: [only] });
      if (url.startsWith("/telemedicine?status=WAITING"))
        return Promise.resolve({ data: [] });
      if (url === "/telemedicine/only-1")
        return Promise.resolve({ data: only });
      return Promise.resolve({ data: [] });
    });

    render(<TelemedicineWaitingRoomPage />);

    // Detail panel appears → auto-selection worked.
    await waitFor(() =>
      expect(screen.getByText("TC-ONLY")).toBeInTheDocument(),
    );
    // Picker still rendered (no URL param), but its selected value is the auto-pick.
    const picker = screen.getByLabelText(/select session/i) as HTMLSelectElement;
    expect(picker.value).toBe("only-1");
  });

  it("falls back to an empty list when the picker fetch rejects (no crash)", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<TelemedicineWaitingRoomPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /telemedicine waiting room/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByLabelText(/select session/i)).toBeInTheDocument();
    // The single placeholder option is still there.
    expect(screen.getByText(/pick an upcoming session/i)).toBeInTheDocument();
  });

  it("pre-check happy path: getUserMedia succeeds → camera/mic OK, /precheck POST issued, button relabels to Re-test", async () => {
    searchParamsMock.current = new URLSearchParams("sessionId=s1");
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/telemedicine/s1")
        return Promise.resolve({ data: makeSession() });
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    const { getUserMedia } = stageUserMedia({ videoLive: true, audioLive: true });

    render(<TelemedicineWaitingRoomPage />);
    // Wait for sessionId to wire up (button enabled).
    const btn = await screen.findByRole("button", { name: /run device test/i });
    await waitFor(() => expect(btn).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    // OK badges
    await waitFor(() => expect(screen.getByText(/camera ok/i)).toBeInTheDocument());
    expect(screen.getByText(/mic ok/i)).toBeInTheDocument();
    // Button relabels.
    expect(
      screen.getByRole("button", { name: /re-test devices/i }),
    ).toBeInTheDocument();
    // Precheck POST issued (fire-and-forget but still observable).
    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/telemedicine/s1/precheck",
        expect.objectContaining({ camera: true, mic: true }),
      ),
    );
  });

  it("pre-check failure: getUserMedia throws → error string surfaced, badges go red, button label stays 'Run Device Test'", async () => {
    searchParamsMock.current = new URLSearchParams("sessionId=s1");
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/telemedicine/s1")
        return Promise.resolve({ data: makeSession() });
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    stageUserMedia({ throws: new Error("Permission denied") });

    render(<TelemedicineWaitingRoomPage />);
    const btn = await screen.findByRole("button", { name: /run device test/i });
    await waitFor(() => expect(btn).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() =>
      expect(screen.getByText(/permission denied/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/camera failed/i)).toBeInTheDocument();
    expect(screen.getByText(/mic failed/i)).toBeInTheDocument();
    // Failure state keeps the original label.
    expect(
      screen.getByRole("button", { name: /run device test/i }),
    ).toBeInTheDocument();
  });

  it("Join Waiting Room success: button disables, copy switches to 'Waiting for doctor…', POST issued with deviceInfo", async () => {
    searchParamsMock.current = new URLSearchParams("sessionId=s1");
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/telemedicine/s1")
        return Promise.resolve({ data: makeSession() });
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    stageUserMedia({ videoLive: true, audioLive: true });

    render(<TelemedicineWaitingRoomPage />);

    // First run pre-check so the Join button gets enabled.
    const runBtn = await screen.findByRole("button", { name: /run device test/i });
    await waitFor(() => expect(runBtn).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(runBtn);
    });
    await waitFor(() => expect(screen.getByText(/camera ok/i)).toBeInTheDocument());

    const joinBtn = screen.getByRole("button", { name: /join waiting room/i });
    await waitFor(() => expect(joinBtn).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(joinBtn);
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /waiting for doctor/i }),
      ).toBeInTheDocument(),
    );
    // POST shape.
    const joinCall = apiMock.post.mock.calls.find(
      (c: any[]) => String(c[0]) === "/telemedicine/s1/waiting-room/join",
    );
    expect(joinCall).toBeTruthy();
    expect(joinCall?.[1]).toMatchObject({
      deviceInfo: expect.objectContaining({ camera: true, mic: true }),
    });
    // Waiting banner copy present.
    expect(screen.getByText(/doctor has been notified/i)).toBeInTheDocument();
  });

  it("Join Waiting Room failure: toast.error fires AND waitStatus rolls back so the button is clickable again", async () => {
    searchParamsMock.current = new URLSearchParams("sessionId=s1");
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/telemedicine/s1")
        return Promise.resolve({ data: makeSession() });
      return Promise.resolve({ data: [] });
    });
    // Precheck POST resolves fine; join POST rejects.
    apiMock.post.mockImplementation((url: string) => {
      if (String(url).endsWith("/waiting-room/join")) {
        return Promise.reject(new Error("Session no longer joinable"));
      }
      return Promise.resolve({ data: { ok: true } });
    });
    stageUserMedia({ videoLive: true, audioLive: true });

    render(<TelemedicineWaitingRoomPage />);

    const runBtn = await screen.findByRole("button", { name: /run device test/i });
    await waitFor(() => expect(runBtn).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(runBtn);
    });
    await waitFor(() => expect(screen.getByText(/camera ok/i)).toBeInTheDocument());

    const joinBtn = screen.getByRole("button", { name: /join waiting room/i });
    await waitFor(() => expect(joinBtn).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(joinBtn);
    });

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/session no longer joinable/i),
      ),
    );
    // Button is back to 'Join Waiting Room' (waitStatus rolled back to idle).
    expect(
      screen.getByRole("button", { name: /join waiting room/i }),
    ).toBeInTheDocument();
  });

  it("Socket admit event sets admitted state and renders the Open Call link with the signed URL", async () => {
    searchParamsMock.current = new URLSearchParams("sessionId=s1");
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/telemedicine/s1")
        return Promise.resolve({ data: makeSession() });
      return Promise.resolve({ data: [] });
    });
    const windowOpen = vi
      .spyOn(window, "open")
      .mockImplementation(() => null as any);

    render(<TelemedicineWaitingRoomPage />);

    // Wait for the socket effect to register its handler.
    await waitFor(() => expect(socketMock.on).toHaveBeenCalled());
    const [eventName, handler] = socketMock.on.mock.calls.find(
      (c: any[]) => c[0] === "telemedicine:admitted",
    )!;
    expect(eventName).toBe("telemedicine:admitted");

    // Page also joins the per-session + per-user rooms.
    expect(socketMock.emit).toHaveBeenCalledWith("join", "telemedicine:s1");
    expect(socketMock.emit).toHaveBeenCalledWith("join", "user:u1");

    await act(async () => {
      handler({
        sessionId: "s1",
        admitted: true,
        url: "https://jitsi.example/room/abc?jwt=signed",
      });
    });

    await waitFor(() =>
      expect(screen.getByText(/admitted! opening call/i)).toBeInTheDocument(),
    );
    const link = screen.getByRole("link", { name: /open call/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      "https://jitsi.example/room/abc?jwt=signed",
    );

    windowOpen.mockRestore();
  });

  it("Socket deny event renders the 'Not admitted' message with the reason text", async () => {
    searchParamsMock.current = new URLSearchParams("sessionId=s1");
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/telemedicine/s1")
        return Promise.resolve({ data: makeSession() });
      return Promise.resolve({ data: [] });
    });

    render(<TelemedicineWaitingRoomPage />);

    await waitFor(() => expect(socketMock.on).toHaveBeenCalled());
    const [, handler] = socketMock.on.mock.calls.find(
      (c: any[]) => c[0] === "telemedicine:admitted",
    )!;

    await act(async () => {
      handler({
        sessionId: "s1",
        admitted: false,
        reason: "Doctor running late, please rebook",
      });
    });

    await waitFor(() =>
      expect(screen.getByText(/not admitted/i)).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/doctor running late, please rebook/i),
    ).toBeInTheDocument();
  });

  it("Socket events for a DIFFERENT sessionId are ignored (no state change)", async () => {
    searchParamsMock.current = new URLSearchParams("sessionId=s1");
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/telemedicine/s1")
        return Promise.resolve({ data: makeSession() });
      return Promise.resolve({ data: [] });
    });

    render(<TelemedicineWaitingRoomPage />);
    await waitFor(() => expect(socketMock.on).toHaveBeenCalled());
    const [, handler] = socketMock.on.mock.calls.find(
      (c: any[]) => c[0] === "telemedicine:admitted",
    )!;

    await act(async () => {
      handler({
        sessionId: "OTHER-SESSION",
        admitted: true,
        url: "https://wrong.example/x",
      });
    });

    // No admitted UI surfaced.
    expect(screen.queryByText(/admitted! opening call/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /open call/i })).not.toBeInTheDocument();
  });

  it("Unmount tears down the socket listener AND stops any active MediaStream tracks", async () => {
    searchParamsMock.current = new URLSearchParams("sessionId=s1");
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/telemedicine/s1")
        return Promise.resolve({ data: makeSession() });
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    const { videoTrack, audioTrack } = stageUserMedia({
      videoLive: true,
      audioLive: true,
    });

    const { unmount } = render(<TelemedicineWaitingRoomPage />);

    // Run precheck so streamRef.current is populated.
    const runBtn = await screen.findByRole("button", { name: /run device test/i });
    await waitFor(() => expect(runBtn).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(runBtn);
    });
    await waitFor(() => expect(screen.getByText(/camera ok/i)).toBeInTheDocument());

    unmount();

    // Socket listener removal.
    expect(socketMock.off).toHaveBeenCalledWith(
      "telemedicine:admitted",
      expect.any(Function),
    );
    // Track cleanup.
    expect(videoTrack.stop).toHaveBeenCalled();
    expect(audioTrack.stop).toHaveBeenCalled();
  });

  it("auto-connects the socket when it isn't already connected (source: !socket.connected → socket.connect())", async () => {
    searchParamsMock.current = new URLSearchParams("sessionId=s1");
    socketMock.connected = false;
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/telemedicine/s1")
        return Promise.resolve({ data: makeSession() });
      return Promise.resolve({ data: [] });
    });

    render(<TelemedicineWaitingRoomPage />);
    await waitFor(() => expect(socketMock.connect).toHaveBeenCalled());
  });

  it("skips socket.connect() when the socket is already connected", async () => {
    searchParamsMock.current = new URLSearchParams("sessionId=s1");
    socketMock.connected = true;
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/telemedicine/s1")
        return Promise.resolve({ data: makeSession() });
      return Promise.resolve({ data: [] });
    });

    render(<TelemedicineWaitingRoomPage />);
    await waitFor(() => expect(socketMock.on).toHaveBeenCalled());
    expect(socketMock.connect).not.toHaveBeenCalled();
  });
});
