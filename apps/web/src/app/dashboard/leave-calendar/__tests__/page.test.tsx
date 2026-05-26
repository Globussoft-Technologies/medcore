/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * LeaveCalendarPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every branch of `apps/web/src/app/dashboard/leave-calendar/page.tsx`,
 *     the ADMIN-only monthly leave-calendar grid. The page issues two parallel
 *     fetches per month — GET /leaves?status=APPROVED&from&to and
 *     GET /leaves?status=PENDING&from&to (the latter wrapped in `.catch` so a
 *     403/500 from the pending endpoint silently degrades to an empty merge,
 *     covering Issue #69). The grid renders a Sunday-start month, badges
 *     per-day leave counts, opens a click-through modal with details, and
 *     pads the leading/trailing weeks with empty cells.
 *
 *   - Behaviours covered:
 *       1. Loading skeleton — `data-testid="leave-calendar-loading"` with
 *          `aria-busy` renders while the first fetch is in flight; the page
 *          header (month label + nav buttons + Today) stays visible.
 *       2. Non-ADMIN redirect — DOCTOR triggers router.push("/dashboard") and
 *          the page renders `null` (no calendar grid, no API fetch).
 *       3. Happy fetch — APPROVED + PENDING merged, multi-day leave shows on
 *          every day it covers, the count badge reflects per-day stack size,
 *          and leaves that overflow the 3-row preview show "+N more".
 *       4. Empty fetch — calendar grid still renders with no leave swatches.
 *       5. PENDING-endpoint rejection is swallowed (per Issue #69 .catch).
 *       6. Out-of-month leaves get filtered out at the client merge step.
 *       7. Month navigation — prev/next/Today buttons re-anchor the grid and
 *          re-issue the fetch with updated from/to params.
 *       8. Day-cell click opens the modal with the per-day leave list +
 *          name + role + type + date range + reason; backdrop click closes
 *          the modal; explicit close button (×) closes the modal.
 *       9. "No one is on leave" modal copy when an empty day is clicked.
 *      10. RBAC short-circuit — pre-redirect `user.role !== "ADMIN"` returns
 *          `null` synchronously, so no fetch fires even on initial render.
 *
 *   - Source under test: apps/web/src/app/dashboard/leave-calendar/page.tsx
 *   - Mocks: @/lib/api (api.get), @/lib/store (useAuthStore), next/navigation
 *            (useRouter), @/components/Skeleton (SkeletonCard passthrough),
 *            lucide-react (ChevronLeft/ChevronRight icon stubs).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
  within,
} from "@testing-library/react";

const { apiMock, routerMock, authMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  routerMock: {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  },
  authMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  usePathname: () => "/dashboard/leave-calendar",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: ({ className }: { className?: string }) => (
    <div data-testid="skeleton-card" className={className} />
  ),
}));
vi.mock("lucide-react", () => ({
  ChevronLeft: () => <span data-testid="icon-chevron-left" />,
  ChevronRight: () => <span data-testid="icon-chevron-right" />,
}));

import LeaveCalendarPage from "../page";

type Leave = {
  id: string;
  userId: string;
  type: string;
  fromDate: string;
  toDate: string;
  totalDays: number;
  reason: string;
  status: string;
  user?: { id: string; name: string; role: string };
};

// Anchor the test month to a fixed date so day-cell math is deterministic.
// 2026-05-15 is a Friday; May 2026 starts on Friday too, so the grid layout
// is easy to reason about (5 leading empty cells before the 1st).
const FIXED_NOW = new Date("2026-05-15T10:00:00.000Z");

function leaveFixture(overrides: Partial<Leave> = {}): Leave {
  return {
    id: "leave-1",
    userId: "user-1",
    type: "CASUAL",
    // Use mid-day UTC so the timezone shift (e.g. IST +5:30) doesn't push
    // getDate() across a day boundary and out of the displayed month window.
    fromDate: "2026-05-10T12:00:00.000Z",
    toDate: "2026-05-10T12:00:00.000Z",
    totalDays: 1,
    reason: "Personal errand",
    status: "APPROVED",
    user: { id: "user-1", name: "Asha Iyer", role: "NURSE" },
    ...overrides,
  };
}

// Wire api.get to dispatch by status querystring so tests don't have to
// manage call-order sequencing. APPROVED first, PENDING second matches the
// source's Promise.all ordering.
function wireLeaves(opts: {
  approved?: Leave[] | Error;
  pending?: Leave[] | Error;
} = {}) {
  apiMock.get.mockImplementation((url: string) => {
    if (url.includes("status=APPROVED")) {
      if (opts.approved instanceof Error) return Promise.reject(opts.approved);
      return Promise.resolve({ data: opts.approved ?? [] });
    }
    if (url.includes("status=PENDING")) {
      if (opts.pending instanceof Error) return Promise.reject(opts.pending);
      return Promise.resolve({ data: opts.pending ?? [] });
    }
    return Promise.resolve({ data: [] });
  });
}

describe("LeaveCalendarPage", () => {
  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
    routerMock.push.mockReset();
    authMock.mockReset();
    // Default: ADMIN user so the fetch fires.
    authMock.mockReturnValue({
      user: { id: "u-admin", role: "ADMIN", name: "Admin" },
    });
    // Pin Date.now() without enabling fake timers — fake timers break
    // waitFor()'s real-time polling. vi.setSystemTime keeps timers real
    // but anchors clock reads (Date, performance.now), which is exactly
    // what the page's startOfMonth(new Date()) needs to be deterministic.
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders the loading skeleton while the first fetch is in flight", async () => {
    // Never-settling APPROVED promise pins the loading branch.
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("status=APPROVED")) return new Promise(() => {});
      return Promise.resolve({ data: [] });
    });

    render(<LeaveCalendarPage />);

    const loading = await screen.findByTestId("leave-calendar-loading");
    expect(loading).toBeInTheDocument();
    expect(loading).toHaveAttribute("aria-busy", "true");
    // 35 skeleton cells per the source.
    expect(screen.getAllByTestId("skeleton-card")).toHaveLength(35);
    // Header chrome stays.
    expect(
      screen.getByRole("heading", { name: /leave calendar/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /today/i })).toBeInTheDocument();
  });

  it("redirects non-ADMIN users to /dashboard and skips the fetch", async () => {
    authMock.mockReturnValue({
      user: { id: "u-doc", role: "DOCTOR", name: "Doc" },
    });
    wireLeaves({ approved: [], pending: [] });

    const { container } = render(<LeaveCalendarPage />);

    await waitFor(() => {
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard");
    });

    // Page returns null for non-ADMIN — the container is empty.
    expect(container.firstChild).toBeNull();
    // No fetch dispatched (the load() useEffect is gated by ADMIN).
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("renders the calendar grid with weekday headers + month label on happy fetch", async () => {
    wireLeaves({ approved: [], pending: [] });

    render(<LeaveCalendarPage />);

    // Wait for grid to replace loading.
    await waitFor(() =>
      expect(
        screen.queryByTestId("leave-calendar-loading")
      ).not.toBeInTheDocument()
    );

    // Month label.
    expect(screen.getByText(/may 2026/i)).toBeInTheDocument();
    // Weekday headers.
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((d) => {
      expect(screen.getByText(d)).toBeInTheDocument();
    });
    // Fetched APPROVED + PENDING.
    expect(apiMock.get).toHaveBeenCalledWith(
      expect.stringMatching(/^\/leaves\?status=APPROVED&from=2026-05-01&to=2026-05-31/)
    );
    expect(apiMock.get).toHaveBeenCalledWith(
      expect.stringMatching(/^\/leaves\?status=PENDING&from=2026-05-01&to=2026-05-31/)
    );
  });

  it("merges APPROVED + PENDING and renders per-day leave swatches with the count badge", async () => {
    wireLeaves({
      approved: [
        leaveFixture({
          id: "L-approved",
          status: "APPROVED",
          fromDate: "2026-05-10T12:00:00.000Z",
          toDate: "2026-05-10T12:00:00.000Z",
          user: { id: "u1", name: "Asha Iyer", role: "NURSE" },
        }),
      ],
      pending: [
        leaveFixture({
          id: "L-pending",
          status: "PENDING",
          type: "SICK",
          fromDate: "2026-05-10T12:00:00.000Z",
          toDate: "2026-05-10T12:00:00.000Z",
          user: { id: "u2", name: "Bob Tan", role: "DOCTOR" },
        }),
      ],
    });

    render(<LeaveCalendarPage />);

    // Wait for fetch to complete and loading to clear.
    await waitFor(() =>
      expect(
        screen.queryByTestId("leave-calendar-loading")
      ).not.toBeInTheDocument()
    );

    // Both names render in their day cell preview.
    expect(await screen.findByText("Asha Iyer")).toBeInTheDocument();
    // PENDING preview prefixes "* ".
    expect(screen.getByText(/^\* Bob Tan$/)).toBeInTheDocument();

    // The count badge for the day should be "2".
    const ashaCell = screen.getByText("Asha Iyer").closest("button");
    expect(ashaCell).not.toBeNull();
    expect(within(ashaCell as HTMLElement).getByText("2")).toBeInTheDocument();
  });

  it("renders '+N more' when a single day stacks more than 3 leaves", async () => {
    const day = "2026-05-12";
    const approved: Leave[] = Array.from({ length: 5 }).map((_, i) =>
      leaveFixture({
        id: `L-${i}`,
        userId: `u-${i}`,
        fromDate: `${day}T12:00:00.000Z`,
        toDate: `${day}T12:00:00.000Z`,
        user: { id: `u-${i}`, name: `Person ${i}`, role: "NURSE" },
      })
    );
    wireLeaves({ approved, pending: [] });

    render(<LeaveCalendarPage />);

    // 3 names visible, the rest collapsed into "+2 more".
    expect(await screen.findByText("Person 0")).toBeInTheDocument();
    expect(screen.getByText("Person 1")).toBeInTheDocument();
    expect(screen.getByText("Person 2")).toBeInTheDocument();
    expect(screen.queryByText("Person 3")).not.toBeInTheDocument();
    expect(screen.getByText("+2 more")).toBeInTheDocument();
  });

  it("swallows a rejected PENDING endpoint and still renders APPROVED leaves (Issue #69)", async () => {
    wireLeaves({
      approved: [
        leaveFixture({
          id: "ok",
          user: { id: "u-x", name: "Approved Only", role: "NURSE" },
        }),
      ],
      pending: new Error("403 forbidden"),
    });

    render(<LeaveCalendarPage />);

    expect(await screen.findByText("Approved Only")).toBeInTheDocument();
    // Loading is gone — the rejection was caught, no error UI.
    expect(
      screen.queryByTestId("leave-calendar-loading")
    ).not.toBeInTheDocument();
  });

  it("falls back to an empty grid when the APPROVED fetch rejects", async () => {
    wireLeaves({ approved: new Error("500 db down"), pending: [] });

    render(<LeaveCalendarPage />);

    // Grid still renders (no leave names, no count badges).
    await waitFor(() =>
      expect(
        screen.queryByTestId("leave-calendar-loading")
      ).not.toBeInTheDocument()
    );
    expect(screen.getByText(/may 2026/i)).toBeInTheDocument();
  });

  it("filters out leaves that don't overlap the displayed month", async () => {
    wireLeaves({
      approved: [
        // Out of window — June.
        leaveFixture({
          id: "L-out",
          fromDate: "2026-06-05T12:00:00.000Z",
          toDate: "2026-06-05T12:00:00.000Z",
          user: { id: "u-out", name: "Out Of Window", role: "NURSE" },
        }),
        // In window.
        leaveFixture({
          id: "L-in",
          user: { id: "u-in", name: "In Window", role: "NURSE" },
        }),
      ],
      pending: [],
    });

    render(<LeaveCalendarPage />);

    expect(await screen.findByText("In Window")).toBeInTheDocument();
    expect(screen.queryByText("Out Of Window")).not.toBeInTheDocument();
  });

  it("Prev / Next month buttons re-anchor the grid and re-issue the fetch", async () => {
    wireLeaves({ approved: [], pending: [] });

    render(<LeaveCalendarPage />);

    await waitFor(() => expect(screen.getByText(/may 2026/i)).toBeInTheDocument());

    const buttons = screen.getAllByRole("button");
    // Prev/next are the two icon-only buttons that contain the chevron stubs.
    const prevBtn = buttons.find((b) =>
      within(b).queryByTestId("icon-chevron-left")
    );
    const nextBtn = buttons.find((b) =>
      within(b).queryByTestId("icon-chevron-right")
    );
    expect(prevBtn).toBeTruthy();
    expect(nextBtn).toBeTruthy();

    fireEvent.click(prevBtn as HTMLElement);
    await waitFor(() =>
      expect(screen.getByText(/april 2026/i)).toBeInTheDocument()
    );
    expect(apiMock.get).toHaveBeenCalledWith(
      expect.stringMatching(/^\/leaves\?status=APPROVED&from=2026-04-01&to=2026-04-30/)
    );

    fireEvent.click(nextBtn as HTMLElement);
    fireEvent.click(nextBtn as HTMLElement);
    await waitFor(() =>
      expect(screen.getByText(/june 2026/i)).toBeInTheDocument()
    );
    expect(apiMock.get).toHaveBeenCalledWith(
      expect.stringMatching(/^\/leaves\?status=APPROVED&from=2026-06-01&to=2026-06-30/)
    );
  });

  it("Today button re-anchors to the current month", async () => {
    wireLeaves({ approved: [], pending: [] });

    render(<LeaveCalendarPage />);

    await waitFor(() => expect(screen.getByText(/may 2026/i)).toBeInTheDocument());

    // Navigate to April.
    const prevBtn = screen
      .getAllByRole("button")
      .find((b) => within(b).queryByTestId("icon-chevron-left"));
    fireEvent.click(prevBtn as HTMLElement);
    await waitFor(() =>
      expect(screen.getByText(/april 2026/i)).toBeInTheDocument()
    );

    // Click Today.
    fireEvent.click(screen.getByRole("button", { name: /today/i }));
    await waitFor(() => expect(screen.getByText(/may 2026/i)).toBeInTheDocument());
  });

  it("clicking a populated day cell opens the detail modal with the leave list", async () => {
    wireLeaves({
      approved: [
        leaveFixture({
          id: "L-detail",
          type: "SICK",
          reason: "Flu",
          totalDays: 2,
          fromDate: "2026-05-10T12:00:00.000Z",
          toDate: "2026-05-11T12:00:00.000Z",
          user: { id: "u-d", name: "Carol Singh", role: "NURSE" },
        }),
      ],
      pending: [],
    });

    render(<LeaveCalendarPage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("leave-calendar-loading")
      ).not.toBeInTheDocument()
    );

    // Multi-day leave renders the name in both day-10 and day-11 cells.
    const cells = await screen.findAllByText("Carol Singh");
    expect(cells.length).toBeGreaterThanOrEqual(2);
    const cell = cells[0].closest("button") as HTMLElement;
    fireEvent.click(cell);

    // Modal heading.
    expect(
      await screen.findByRole("heading", { name: /leaves on/i })
    ).toBeInTheDocument();
    // Role pill.
    expect(screen.getByText("NURSE")).toBeInTheDocument();
    // Type + day-count copy.
    expect(screen.getByText(/SICK ·/)).toBeInTheDocument();
    expect(screen.getByText(/\(2d\)/)).toBeInTheDocument();
    // Reason rendered in smart quotes.
    expect(screen.getByText(/Flu/)).toBeInTheDocument();
  });

  it("clicking the modal backdrop closes the modal", async () => {
    wireLeaves({
      approved: [
        leaveFixture({
          user: { id: "u-bd", name: "Backdrop Test", role: "NURSE" },
        }),
      ],
      pending: [],
    });

    render(<LeaveCalendarPage />);

    const cell = (await screen.findByText("Backdrop Test")).closest(
      "button"
    ) as HTMLElement;
    fireEvent.click(cell);

    const heading = await screen.findByRole("heading", { name: /leaves on/i });
    // The backdrop is the modal's outermost fixed container.
    const backdrop = heading.closest("div.fixed") as HTMLElement;
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop);

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /leaves on/i })
      ).not.toBeInTheDocument()
    );
  });

  it("clicking the × close button closes the modal", async () => {
    wireLeaves({
      approved: [
        leaveFixture({
          user: { id: "u-x", name: "Close X Test", role: "NURSE" },
        }),
      ],
      pending: [],
    });

    render(<LeaveCalendarPage />);

    const cell = (await screen.findByText("Close X Test")).closest(
      "button"
    ) as HTMLElement;
    fireEvent.click(cell);

    const heading = await screen.findByRole("heading", { name: /leaves on/i });
    const modalRoot = heading.closest("div.fixed") as HTMLElement;
    // The × close button is the only button inside the modal whose text is "×".
    const closeBtn = within(modalRoot)
      .getAllByRole("button")
      .find((b) => b.textContent?.trim() === "×");
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn as HTMLElement);

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /leaves on/i })
      ).not.toBeInTheDocument()
    );
  });

  it("renders 'No one is on leave this day' when an empty day is clicked", async () => {
    wireLeaves({ approved: [], pending: [] });

    render(<LeaveCalendarPage />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("leave-calendar-loading")
      ).not.toBeInTheDocument()
    );

    // Find any day-cell button — the grid renders buttons for each in-month day.
    // Pick the "15" button (matches FIXED_NOW so we know it's there).
    const dayButtons = screen
      .getAllByRole("button")
      .filter((b) => /^\d+$/.test(b.textContent?.trim() ?? ""));
    expect(dayButtons.length).toBeGreaterThan(0);
    fireEvent.click(dayButtons[0]);

    expect(
      await screen.findByText(/no one is on leave this day/i)
    ).toBeInTheDocument();
  });
});
