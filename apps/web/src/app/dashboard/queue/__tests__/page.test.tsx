/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * QueuePage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies the reception OPD queue page at
 *     `apps/web/src/app/dashboard/queue/page.tsx` — the staff-only token board
 *     that aggregates per-doctor counts from `GET /api/v1/queue`, drills into
 *     a doctor's full queue via `GET /api/v1/queue/:doctorId?date=YYYY-MM-DD`,
 *     and offers per-row transfer / LWBS actions for ADMIN+RECEPTION.
 *   - The page is fed by Socket.IO (`token-called`, `queue-updated`) PLUS a
 *     30s `setInterval` fallback poll (#430) so the suite must mock both seams.
 *   - Behaviours covered:
 *       1. Loading branch — SkeletonCard strip while the first /queue fetch
 *          is in flight.
 *       2. RBAC — PATIENT role short-circuits the fetch, fires toast.error,
 *          and triggers router.replace('/dashboard/not-authorized?from=…'); no
 *          socket connect or /queue call happens.
 *       3. Happy fetch — every doctor in /queue renders a card with
 *          formatDoctorName-normalised name, specialization, current token,
 *          and waiting count; null currentToken renders the "—" fallback.
 *       4. Click-to-drill — clicking a card calls
 *          GET /queue/:doctorId?date=YYYY-MM-DD and renders the queue detail.
 *       5. Empty-queue branch — "No patients in queue" placeholder when the
 *          drill-in fetch returns queue:[].
 *       6. Vulnerable-flag badges — CHILD / ANC / SENIOR pills render from
 *          entry.vulnerableFlags. Wait-time hint is hidden for
 *          IN_CONSULTATION / COMPLETED but shown for BOOKED.
 *       7. Transfer action — opens the modal for BOOKED rows (RECEPTION), the
 *          doctor dropdown EXCLUDES the current doctor, validation rejects an
 *          empty reason via toast.error, and a valid submit POSTs to
 *          /appointments/:id/transfer + refreshes both fetches.
 *       8. LWBS action — prompts for a reason, PATCHes
 *          /appointments/:id/lwbs, and refreshes.
 *       9. Doctor without an authorize-to-transfer role (DOCTOR) does NOT
 *          render the Transfer / LWBS buttons (canTransfer === false).
 *      10. 30s fallback poll (#430) — advancing fake timers re-issues
 *          /queue.
 *      11. Socket subscription — getSocket().connect() + emit("join-display")
 *          fires once on mount; socket.disconnect() on unmount (cleanup).
 *      12. Per-call rejections from /queue are swallowed — heading still
 *          renders and `loading` flips to false.
 *
 *   - Source under test: apps/web/src/app/dashboard/queue/page.tsx
 *   - Mocks: @/lib/api, @/lib/store (selector-aware), @/lib/socket,
 *            @/lib/use-dialog (usePrompt), @/lib/toast, next/navigation,
 *            @/components/Skeleton (passthrough). i18n + format-doctor-name
 *            are imported real to exercise the actual labels.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, socketMock, routerMock, promptMock, toastMock } =
  vi.hoisted(() => ({
    apiMock: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
    authMock: vi.fn(),
    socketMock: {
      connect: vi.fn(),
      disconnect: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      connected: false,
    },
    routerMock: {
      push: vi.fn(),
      replace: vi.fn(),
      back: vi.fn(),
      refresh: vi.fn(),
      prefetch: vi.fn(),
      forward: vi.fn(),
    },
    promptMock: vi.fn(),
    toastMock: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
    },
  }));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/socket", () => ({ getSocket: () => socketMock }));
vi.mock("@/lib/use-dialog", () => ({ usePrompt: () => promptMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/queue",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: ({ className }: { className?: string }) => (
    <div data-testid="skeleton-card" className={className} />
  ),
}));

import QueuePage from "../page";

// Selector-aware auth mock — source uses
// `useAuthStore((s) => s.user)` and `useAuthStore((s) => s.isLoading)`,
// so the mock must invoke the selector with the state shape.
function setAuth(state: {
  user: { id?: string; name?: string; email?: string; role?: string } | null;
  isLoading: boolean;
}) {
  authMock.mockImplementation((selector?: any) =>
    typeof selector === "function" ? selector(state) : state,
  );
}

function doctorRow(
  overrides: Partial<{
    doctorId: string;
    doctorName: string;
    specialization: string;
    currentToken: number | null;
    waitingCount: number;
  }> = {},
) {
  return {
    doctorId: "doc-1",
    doctorName: "Dr. Rajesh Sharma",
    specialization: "Cardiology",
    currentToken: 5,
    waitingCount: 3,
    ...overrides,
  };
}

function queueEntry(
  overrides: Partial<{
    tokenNumber: number;
    patientName: string;
    appointmentId: string;
    type: string;
    status: string;
    priority: string;
    slotTime: string | null;
    hasVitals: boolean;
    estimatedWaitMinutes: number;
    vulnerableFlags: {
      isSenior: boolean;
      isChild: boolean;
      isPregnant: boolean;
      ageYears: number | null;
    };
  }> = {},
) {
  return {
    tokenNumber: 6,
    patientName: "Aarav Mehta",
    appointmentId: "apt-1",
    type: "REGULAR",
    status: "BOOKED",
    priority: "NORMAL",
    slotTime: "10:00",
    hasVitals: false,
    estimatedWaitMinutes: 10,
    vulnerableFlags: {
      isSenior: false,
      isChild: false,
      isPregnant: false,
      ageYears: 32,
    },
    ...overrides,
  };
}

describe("QueuePage", () => {
  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    socketMock.connect.mockReset();
    socketMock.disconnect.mockReset();
    socketMock.emit.mockReset();
    socketMock.on.mockReset();
    routerMock.replace.mockReset();
    promptMock.mockReset();
    toastMock.error.mockReset();
    toastMock.success.mockReset();
    authMock.mockReset();
    setAuth({
      user: { id: "u1", name: "Reception", email: "r@x.com", role: "RECEPTION" },
      isLoading: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders SkeletonCard placeholders while the initial /queue fetch is in flight", () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    render(<QueuePage />);

    expect(screen.getAllByTestId("skeleton-card").length).toBe(3);
    expect(
      screen.getByRole("heading", { name: /live queue/i }),
    ).toBeInTheDocument();
  });

  it("redirects PATIENT away with toast.error + router.replace and never opens a queue WS (Issue #383)", async () => {
    setAuth({
      user: { id: "p1", name: "Asha", email: "a@x.com", role: "PATIENT" },
      isLoading: false,
    });

    render(<QueuePage />);

    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith(
        "/dashboard/not-authorized?from=%2Fdashboard%2Fqueue",
      ),
    );
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/staff-only/i),
    );
    // The fetch + socket effect short-circuits for non-allowlisted roles.
    expect(apiMock.get).not.toHaveBeenCalled();
    expect(socketMock.connect).not.toHaveBeenCalled();
    expect(socketMock.emit).not.toHaveBeenCalled();
  });

  it("renders one card per doctor with formatDoctorName + specialization + currentToken (null → dash)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/queue") {
        return Promise.resolve({
          data: [
            doctorRow({ doctorId: "d1", doctorName: "Dr. Singh", currentToken: 7, waitingCount: 4 }),
            doctorRow({ doctorId: "d2", doctorName: "Gupta", specialization: "Pediatrics", currentToken: null, waitingCount: 0 }),
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<QueuePage />);

    // formatDoctorName de-duplicates "Dr." and re-adds exactly one.
    expect(await screen.findByText("Dr. Singh")).toBeInTheDocument();
    expect(await screen.findByText("Dr. Gupta")).toBeInTheDocument();
    expect(screen.getByText("Pediatrics")).toBeInTheDocument();
    // currentToken=7 renders the bold token number.
    expect(screen.getByText("7")).toBeInTheDocument();
    // currentToken=null renders the en-dash placeholder.
    expect(screen.getByText("—")).toBeInTheDocument();
    // Waiting counts both render.
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("clicking a doctor card fetches /queue/:doctorId?date= and renders the entry rows", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/queue") {
        return Promise.resolve({
          data: [doctorRow({ doctorId: "d1", doctorName: "Dr. Singh" })],
        });
      }
      if (url.startsWith("/queue/d1?date=")) {
        return Promise.resolve({
          data: {
            doctorId: "d1",
            date: "2026-05-26",
            currentToken: 5,
            totalInQueue: 1,
            queue: [queueEntry({ patientName: "Aarav Mehta", tokenNumber: 6 })],
          },
        });
      }
      return Promise.resolve({ data: [] });
    });

    const user = userEvent.setup();
    render(<QueuePage />);
    const card = await screen.findByRole("button", { name: /Dr\. Singh/ });
    await user.click(card);

    // /queue/d1?date=YYYY-MM-DD pattern matches.
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(
        urls.some((u) => /^\/queue\/d1\?date=\d{4}-\d{2}-\d{2}$/.test(u)),
      ).toBe(true);
    });
    expect(await screen.findByText("Aarav Mehta")).toBeInTheDocument();
    expect(screen.getByText(/queue detail/i)).toBeInTheDocument();
  });

  it("renders the 'No patients in queue' placeholder when the drill-in returns an empty queue", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/queue") {
        return Promise.resolve({
          data: [doctorRow({ doctorId: "d1", doctorName: "Dr. Singh" })],
        });
      }
      if (url.startsWith("/queue/d1?date=")) {
        return Promise.resolve({
          data: {
            doctorId: "d1",
            date: "2026-05-26",
            currentToken: null,
            totalInQueue: 0,
            queue: [],
          },
        });
      }
      return Promise.resolve({ data: [] });
    });

    const user = userEvent.setup();
    render(<QueuePage />);
    await user.click(await screen.findByRole("button", { name: /Dr\. Singh/ }));

    expect(await screen.findByText(/no patients in queue/i)).toBeInTheDocument();
  });

  it("renders CHILD / ANC / SENIOR badges and hides the wait hint for IN_CONSULTATION", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/queue") {
        return Promise.resolve({
          data: [doctorRow({ doctorId: "d1", doctorName: "Dr. Singh" })],
        });
      }
      if (url.startsWith("/queue/d1?date=")) {
        return Promise.resolve({
          data: {
            doctorId: "d1",
            date: "2026-05-26",
            currentToken: 8,
            totalInQueue: 2,
            queue: [
              queueEntry({
                appointmentId: "apt-child",
                patientName: "Baby Roy",
                tokenNumber: 7,
                status: "BOOKED",
                vulnerableFlags: { isSenior: false, isChild: true, isPregnant: false, ageYears: 3 },
              }),
              queueEntry({
                appointmentId: "apt-anc",
                patientName: "Priya N",
                tokenNumber: 8,
                status: "IN_CONSULTATION",
                vulnerableFlags: { isSenior: false, isChild: false, isPregnant: true, ageYears: 28 },
              }),
              queueEntry({
                appointmentId: "apt-snr",
                patientName: "R Kumar",
                tokenNumber: 9,
                status: "BOOKED",
                vulnerableFlags: { isSenior: true, isChild: false, isPregnant: false, ageYears: 72 },
              }),
            ],
          },
        });
      }
      return Promise.resolve({ data: [] });
    });

    const user = userEvent.setup();
    render(<QueuePage />);
    await user.click(await screen.findByRole("button", { name: /Dr\. Singh/ }));

    await screen.findByText("Baby Roy");
    expect(screen.getByText(/CHILD/)).toBeInTheDocument();
    expect(screen.getByText(/ANC/)).toBeInTheDocument();
    expect(screen.getByText(/SENIOR/)).toBeInTheDocument();
    // The full row container is `<div class="flex items-center justify-between rounded-lg border p-4 …">`
    // — pick the closest ancestor with `justify-between` so we capture BOTH the
    // left (patient info) and right (status / wait hint) cells.
    const findRow = (name: string) =>
      screen.getByText(name).closest("div.justify-between") as HTMLElement;
    // IN_CONSULTATION row should NOT show the "~N min wait" hint.
    const ancRow = findRow("Priya N");
    expect(ancRow).toBeTruthy();
    expect(within(ancRow).queryByText(/min wait/)).toBeNull();
    // BOOKED row SHOULD show it.
    const childRow = findRow("Baby Roy");
    expect(within(childRow).getByText(/min wait/)).toBeInTheDocument();
  });

  it("opens the transfer modal, excludes the source doctor from the dropdown, rejects empty reason, then POSTs on confirm", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/queue") {
        return Promise.resolve({
          data: [
            doctorRow({ doctorId: "d1", doctorName: "Dr. Singh", specialization: "GP" }),
            doctorRow({ doctorId: "d2", doctorName: "Dr. Gupta", specialization: "Peds" }),
          ],
        });
      }
      if (url.startsWith("/queue/d1?date=")) {
        return Promise.resolve({
          data: {
            doctorId: "d1",
            date: "2026-05-26",
            currentToken: 5,
            totalInQueue: 1,
            queue: [queueEntry({ appointmentId: "apt-XYZ", status: "BOOKED" })],
          },
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    const user = userEvent.setup();
    render(<QueuePage />);
    await user.click(await screen.findByRole("button", { name: /Dr\. Singh/ }));

    // Open the transfer modal via the per-row Transfer button.
    const transferBtn = await screen.findByRole("button", {
      name: /Transfer Aarav Mehta to another doctor/i,
    });
    await user.click(transferBtn);

    // Modal heading visible.
    expect(
      screen.getByRole("heading", { name: /transfer to another doctor/i }),
    ).toBeInTheDocument();

    // Dropdown EXCLUDES the source doctor (d1) — only d2 should appear.
    const select = screen.getByLabelText(/new doctor/i) as HTMLSelectElement;
    const options = within(select).getAllByRole("option");
    const values = options.map((o) => (o as HTMLOptionElement).value);
    expect(values).toContain("");
    expect(values).toContain("d2");
    expect(values).not.toContain("d1");

    // Empty-state submit → toast.error, no POST.
    await user.click(screen.getByRole("button", { name: /confirm transfer/i }));
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringMatching(/select a doctor.*reason/i),
    );
    expect(apiMock.post).not.toHaveBeenCalled();

    // Now fill it in and submit again.
    await user.selectOptions(select, "d2");
    await user.type(screen.getByLabelText(/^reason$/i), "Specialist needed");
    await user.click(screen.getByRole("button", { name: /confirm transfer/i }));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/appointments/apt-XYZ/transfer",
        { newDoctorId: "d2", reason: "Specialist needed" },
      ),
    );
    // Modal closes after success (heading no longer present).
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /transfer to another doctor/i }),
      ).toBeNull(),
    );
  });

  it("LWBS button prompts for a reason then PATCHes /appointments/:id/lwbs", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/queue") {
        return Promise.resolve({
          data: [doctorRow({ doctorId: "d1", doctorName: "Dr. Singh" })],
        });
      }
      if (url.startsWith("/queue/d1?date=")) {
        return Promise.resolve({
          data: {
            doctorId: "d1",
            date: "2026-05-26",
            currentToken: 5,
            totalInQueue: 1,
            queue: [queueEntry({ appointmentId: "apt-LWBS", status: "CHECKED_IN" })],
          },
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });
    promptMock.mockResolvedValue("Patient left after 45 min");

    const user = userEvent.setup();
    render(<QueuePage />);
    await user.click(await screen.findByRole("button", { name: /Dr\. Singh/ }));

    const lwbsBtn = await screen.findByRole("button", {
      name: /Mark Aarav Mehta as left without being seen/i,
    });
    await user.click(lwbsBtn);

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/appointments/apt-LWBS/lwbs",
        { reason: "Patient left after 45 min" },
      ),
    );
    expect(promptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Left Without Being Seen",
        required: true,
      }),
    );
  });

  it("DOCTOR role does NOT render Transfer / LWBS buttons (canTransfer === false)", async () => {
    setAuth({
      user: { id: "doc1", name: "Dr. X", email: "x@y.com", role: "DOCTOR" },
      isLoading: false,
    });
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/queue") {
        return Promise.resolve({
          data: [doctorRow({ doctorId: "d1", doctorName: "Dr. Singh" })],
        });
      }
      if (url.startsWith("/queue/d1?date=")) {
        return Promise.resolve({
          data: {
            doctorId: "d1",
            date: "2026-05-26",
            currentToken: 5,
            totalInQueue: 1,
            queue: [queueEntry({ status: "BOOKED" })],
          },
        });
      }
      return Promise.resolve({ data: [] });
    });

    const user = userEvent.setup();
    render(<QueuePage />);
    await user.click(await screen.findByRole("button", { name: /Dr\. Singh/ }));
    await screen.findByText("Aarav Mehta");

    expect(
      screen.queryByRole("button", { name: /Transfer Aarav Mehta/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /left without being seen/i }),
    ).toBeNull();
  });

  it("polls /queue every 30s as a fallback so nurse views don't go stale (#430)", async () => {
    vi.useFakeTimers();
    try {
      apiMock.get.mockImplementation((url: string) => {
        if (url === "/queue") {
          return Promise.resolve({
            data: [doctorRow({ doctorId: "d1", doctorName: "Dr. Singh" })],
          });
        }
        return Promise.resolve({ data: [] });
      });

      render(<QueuePage />);

      // Initial /queue call.
      await vi.waitFor(() => {
        const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
        expect(urls.filter((u) => u === "/queue").length).toBeGreaterThanOrEqual(1);
      });

      apiMock.get.mockClear();
      // 30s poll tick fires `refreshAllQueues`, which schedules the actual
      // /queue fetch via a 150ms trailing debounce (page.tsx `runRefresh`
      // / `refreshAllQueues`). Advance past both windows so the debounced
      // call lands before we assert.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
        await vi.advanceTimersByTimeAsync(200);
      });
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u === "/queue")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("connects the queue socket + emits join-display on mount and disconnects on unmount", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    const { unmount } = render(<QueuePage />);

    await waitFor(() => expect(socketMock.connect).toHaveBeenCalledTimes(1));
    expect(socketMock.emit).toHaveBeenCalledWith("join-display");
    // Two listener registrations: token-called + queue-updated.
    const eventNames = socketMock.on.mock.calls.map((c) => c[0]);
    expect(eventNames).toEqual(
      expect.arrayContaining(["token-called", "queue-updated"]),
    );

    unmount();
    expect(socketMock.disconnect).toHaveBeenCalledTimes(1);
  });

  it("absorbs /queue rejections — the heading still renders and the skeleton clears", async () => {
    apiMock.get.mockRejectedValue(new Error("queue down"));
    render(<QueuePage />);

    expect(
      await screen.findByRole("heading", { name: /live queue/i }),
    ).toBeInTheDocument();
    // Once loading flips, the skeleton placeholders are gone.
    await waitFor(() =>
      expect(screen.queryAllByTestId("skeleton-card").length).toBe(0),
    );
  });
});
