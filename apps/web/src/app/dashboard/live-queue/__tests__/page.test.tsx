/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * LiveQueuePage — adjacent-to-source coverage (test-cron pick 2026-05-25).
 *
 * What / which modules / why:
 *   - Verifies every branch of `apps/web/src/app/dashboard/live-queue/page.tsx`,
 *     a client component that aggregates per-doctor queue counts from
 *     `GET /api/v1/queue` and a `GET /api/v1/appointments?date=…&status=COMPLETED`
 *     lookup for the Done bucket. Refresh contract: initial fetch on mount +
 *     30s background poll (window.setInterval) with cleanup on unmount.
 *   - Behaviours covered:
 *       1. Loading branches:
 *          - `isAuthLoading=true` renders the "Loading…" status block (no fetch).
 *          - After auth resolves but BEFORE the queue fetch settles, the
 *            `data-testid="live-queue-loading"` SkeletonText strip renders.
 *       2. Happy fetch — aggregates per-doctor `waitingCount` into Waiting,
 *          counts non-null `currentToken` into In Consult, and uses the length
 *          of the appointments array for Done.
 *       3. Empty fetch — both endpoints return [], all three tiles render 0.
 *       4. Error fallbacks:
 *          - When `/queue` rejects, the page's per-call `.catch(() => …)` swaps
 *            in an empty array; counts stay 0 and the page still renders.
 *          - When the outer try throws (Promise.all wraps a synchronous-thrown
 *            error — we simulate by stubbing `Date.prototype.toISOString` so
 *            the today-string construction explodes), the `[role="alert"]`
 *            error banner renders.
 *       5. Real-time polling — driven by vi.useFakeTimers; advancing 30s
 *          re-issues the queue + appointments fetch pair (count doubles).
 *       6. Unmount cleanup — clearInterval is called so the poll doesn't leak.
 *       7. RBAC — PATIENT role short-circuits the fetch and triggers
 *          `router.replace('/dashboard/not-authorized?from=…')`, AND renders
 *          the "Live Queue is staff-only." message.
 *
 *   - Source under test: apps/web/src/app/dashboard/live-queue/page.tsx
 *   - Mocks: @/lib/api (api.get), @/lib/store (useAuthStore, selector-aware),
 *            next/navigation (useRouter/usePathname),
 *            @/components/Skeleton (passthrough for SkeletonText).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";

const { apiMock, authMock, routerMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  routerMock: {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    forward: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/live-queue",
}));
// Keep the skeleton minimal — its real impl isn't under test here.
vi.mock("@/components/Skeleton", () => ({
  SkeletonText: ({ lines }: { lines?: number }) => (
    <div data-testid="skeleton-text" data-lines={lines ?? 1} />
  ),
}));

import LiveQueuePage from "../page";

// Selector-aware auth mock — source does `useAuthStore((s) => s.user)`
// and `useAuthStore((s) => s.isLoading)` so the mock must invoke the
// selector with the state shape.
function setAuth(
  state: { user: { id?: string; name?: string; email?: string; role?: string } | null; isLoading: boolean }
) {
  authMock.mockImplementation((selector?: any) =>
    typeof selector === "function" ? selector(state) : state
  );
}

function queueDoctor(overrides: Partial<{
  doctorId: string;
  doctorName: string;
  specialization: string;
  currentToken: number | null;
  waitingCount: number;
}> = {}) {
  return {
    doctorId: "doc-1",
    doctorName: "Dr. Rajesh Sharma",
    specialization: "Cardiology",
    currentToken: 5,
    waitingCount: 3,
    ...overrides,
  };
}

describe("LiveQueuePage", () => {
  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
    routerMock.replace.mockReset();
    authMock.mockReset();
    setAuth({
      user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
      isLoading: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the 'Loading…' status block while auth is still loading and never hits the API", () => {
    setAuth({ user: null, isLoading: true });
    render(<LiveQueuePage />);

    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
    expect(status).toHaveTextContent(/loading/i);
    expect(status).toHaveAttribute("aria-busy", "true");
    // No fetch is issued while auth is resolving.
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("shows the skeleton strip before the queue fetch settles (loaded=false branch)", async () => {
    // Never-settling promise pair keeps the page in the !loaded branch.
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    render(<LiveQueuePage />);

    expect(await screen.findByTestId("live-queue-loading")).toBeInTheDocument();
    expect(screen.getByTestId("skeleton-text")).toBeInTheDocument();
    // Page chrome still rendered.
    expect(
      screen.getByRole("heading", { name: /live queue/i })
    ).toBeInTheDocument();
  });

  it("renders the three count tiles with aggregated counts from /queue + completed-appointments fetch", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/queue")) {
        return Promise.resolve({
          data: [
            queueDoctor({ doctorId: "d1", waitingCount: 3, currentToken: 5 }),
            queueDoctor({ doctorId: "d2", waitingCount: 7, currentToken: 2 }),
            // currentToken null → does NOT contribute to In Consult.
            queueDoctor({ doctorId: "d3", waitingCount: 1, currentToken: null }),
          ],
        });
      }
      if (url.startsWith("/appointments")) {
        return Promise.resolve({
          data: [{ id: "a1", status: "COMPLETED" }, { id: "a2", status: "COMPLETED" }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<LiveQueuePage />);

    // Waiting = 3 + 7 + 1 = 11; In Consult = 2 (d1, d2); Done = 2.
    const waiting = await screen.findByTestId("live-queue-waiting");
    const inConsult = await screen.findByTestId("live-queue-in-consult");
    const done = await screen.findByTestId("live-queue-done");

    await waitFor(() => expect(waiting).toHaveTextContent("11"));
    expect(inConsult).toHaveTextContent("2");
    expect(done).toHaveTextContent("2");

    // The page sends today's date and limit=200 on the appointments call.
    const apptCall = apiMock.get.mock.calls.find((c: any[]) =>
      String(c[0]).startsWith("/appointments")
    );
    expect(apptCall?.[0]).toMatch(/^\/appointments\?date=\d{4}-\d{2}-\d{2}&status=COMPLETED&limit=200$/);
    expect(apiMock.get).toHaveBeenCalledWith("/queue");
  });

  it("renders all-zero tiles when both endpoints return empty arrays", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<LiveQueuePage />);

    await waitFor(() =>
      expect(screen.getByTestId("live-queue-waiting")).toHaveTextContent("0")
    );
    expect(screen.getByTestId("live-queue-in-consult")).toHaveTextContent("0");
    expect(screen.getByTestId("live-queue-done")).toHaveTextContent("0");
    // After load, skeleton is removed.
    expect(screen.queryByTestId("live-queue-loading")).not.toBeInTheDocument();
    // No error banner.
    expect(
      document.querySelector('[role="alert"]:not(#__next-route-announcer__)')
    ).toBeNull();
  });

  it("absorbs per-call rejections via .catch(() => empty) — counts stay 0 and no error banner surfaces", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/queue")) return Promise.reject(new Error("queue down"));
      if (url.startsWith("/appointments"))
        return Promise.reject(new Error("appts down"));
      return Promise.resolve({ data: [] });
    });

    render(<LiveQueuePage />);

    await waitFor(() =>
      expect(screen.getByTestId("live-queue-waiting")).toHaveTextContent("0")
    );
    expect(screen.getByTestId("live-queue-in-consult")).toHaveTextContent("0");
    expect(screen.getByTestId("live-queue-done")).toHaveTextContent("0");
    // Per-call .catch swallows the rejection so the outer try-block never sets
    // the error string — no [role=alert] banner.
    expect(
      document.querySelector('[role="alert"]:not(#__next-route-announcer__)')
    ).toBeNull();
  });

  it("surfaces the error banner when the outer try-block throws (e.g. Date construction fails)", async () => {
    // Force the today-string construction in `refresh()` to throw BEFORE the
    // Promise.all is even built, so the outer try/catch sets `error`.
    const origToISOString = Date.prototype.toISOString;
    Date.prototype.toISOString = function () {
      throw new Error("clock exploded");
    };
    try {
      apiMock.get.mockResolvedValue({ data: [] });
      render(<LiveQueuePage />);

      const alert = await waitFor(() => {
        const a = document.querySelector(
          '[role="alert"]:not(#__next-route-announcer__)'
        );
        if (!a) throw new Error("alert not yet present");
        return a as HTMLElement;
      });
      expect(alert).toHaveTextContent(/clock exploded/i);
    } finally {
      Date.prototype.toISOString = origToISOString;
    }
  });

  it("re-fetches both endpoints every 30s while mounted (real-time polling contract)", async () => {
    // Intercept setInterval at the page-source seam so we can drive the poll
    // by hand — avoids fake-timer/awaited-Promise scheduling races on jsdom
    // (initially attempted with vi.useFakeTimers + advanceTimersByTime, but
    // the awaited Promise.all in refresh() wouldn't settle within act()).
    let capturedTick: (() => void) | null = null;
    let capturedDelay = -1;
    const realSetInterval = window.setInterval.bind(window);
    const setIntervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation(((fn: any, delay: any, ...rest: any[]) => {
        // The page registers exactly one 30s interval — capture that one
        // and ignore stray jsdom/library intervals (some setup helpers
        // schedule short polls that would otherwise overwrite our capture).
        if (delay === 30_000) {
          capturedTick = fn;
          capturedDelay = delay;
          return 12345 as any;
        }
        return realSetInterval(fn, delay, ...rest);
      }) as any);

    try {
      apiMock.get.mockResolvedValue({ data: [] });
      render(<LiveQueuePage />);

      // Initial render fires the fetch pair (1 call each) AND registers the
      // 30s interval with our captured callback.
      await waitFor(() => {
        const queueCalls = apiMock.get.mock.calls.filter((c: any[]) =>
          String(c[0]).startsWith("/queue")
        );
        expect(queueCalls.length).toBe(1);
      });
      expect(capturedTick).toBeTypeOf("function");
      expect(capturedDelay).toBe(30_000);

      // Manually invoke the poll callback — drives a second fetch pair.
      await act(async () => {
        await capturedTick!();
      });

      await waitFor(() => {
        const queueCalls = apiMock.get.mock.calls.filter((c: any[]) =>
          String(c[0]).startsWith("/queue")
        );
        const apptCalls = apiMock.get.mock.calls.filter((c: any[]) =>
          String(c[0]).startsWith("/appointments")
        );
        expect(queueCalls.length).toBe(2);
        expect(apptCalls.length).toBe(2);
      });
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("clears the poll interval on unmount so the timer doesn't leak", async () => {
    // Intercept setInterval to return a sentinel id and assert clearInterval
    // is called with the same id on unmount.
    const sentinelId = 99887 as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation((() => sentinelId) as any);
    const clearSpy = vi
      .spyOn(window, "clearInterval")
      .mockImplementation(() => {});

    try {
      apiMock.get.mockResolvedValue({ data: [] });
      const { unmount } = render(<LiveQueuePage />);
      await waitFor(() =>
        expect(apiMock.get.mock.calls.length).toBeGreaterThan(0)
      );

      unmount();
      expect(clearSpy).toHaveBeenCalledWith(sentinelId);
    } finally {
      clearSpy.mockRestore();
      setIntervalSpy.mockRestore();
    }
  });

  it("redirects PATIENT to /dashboard/not-authorized with the encoded from= param and never fetches", async () => {
    setAuth({
      user: { id: "p1", name: "Asha", email: "a@x.com", role: "PATIENT" },
      isLoading: false,
    });

    render(<LiveQueuePage />);

    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith(
        "/dashboard/not-authorized?from=%2Fdashboard%2Flive-queue"
      )
    );
    // The fetch effect short-circuits for non-allowlisted roles.
    expect(apiMock.get).not.toHaveBeenCalled();
    // Staff-only message rendered (count tiles never appear).
    expect(screen.getByText(/live queue is staff-only/i)).toBeInTheDocument();
    expect(screen.queryByTestId("live-queue-waiting")).not.toBeInTheDocument();
  });
});
