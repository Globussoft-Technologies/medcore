/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * LabOrdersPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every branch of `apps/web/src/app/dashboard/lab-orders/page.tsx`,
 *     the patient-portal lab-orders list view shipped for Issue #715. It hits
 *     `GET /lab/orders?page=1&limit=50` (API self-scopes to the caller's
 *     patientId when role === PATIENT), renders the result as a status-tagged
 *     table, and opens the per-order PDF report (`GET /lab/orders/:id/pdf`)
 *     in a new tab via `window.open` when the row is reportable.
 *   - Behaviours covered:
 *       1. Initial loading branch — `aria-busy="true"` skeleton container
 *          (`data-testid="lab-orders-loading"`) renders while the first
 *          fetch is in flight; header copy is still visible.
 *       2. Non-allowed role — a role outside the ALLOWED allowlist triggers
 *          a toast.error + router.replace to `/dashboard/not-authorized?from=`
 *          and DOES NOT issue the lab-orders fetch.
 *       3. Allowed role but auth still loading — no fetch is dispatched
 *          (gated by `if (user && ALLOWED.has(user.role))`).
 *       4. Happy fetch — rows render with formatted date, order # (falling
 *          back to id-slice when null), tests joined by comma, STAT badge,
 *          status pill, and a working "View report" link for reportable
 *          statuses.
 *       5. STAT badge — present only when the row's `stat` flag is true.
 *       6. orderNumber fallback — when null, the first 8 chars of `id` show.
 *       7. Empty fetch — EmptyState ("No lab orders yet") renders.
 *       8. Error fetch — `data-testid="lab-orders-error"` panel renders with
 *          the thrown message and `role="alert"`.
 *       9. Error fallback (non-Error throw) — generic "Failed to load lab
 *          orders" copy renders when the rejection is not an Error.
 *      10. View-report click — fires `window.open` with the configured API
 *          base + `/lab/orders/<id>/pdf` and target `_blank`.
 *      11. Reportable vs non-reportable rows — REPORTED renders the button,
 *          PENDING renders the "Pending" placeholder, and a non-reportable
 *          status with eager-loaded `items[].results` still renders the
 *          button (covers the items-based fallback branch).
 *      12. Invalid orderedAt — the em-dash placeholder renders.
 *      13. Tests-cell fallback — when items[] is empty, the em-dash renders.
 *
 *   - Source under test: apps/web/src/app/dashboard/lab-orders/page.tsx
 *   - Mocks: @/lib/api (api.get), @/lib/store (useAuthStore), @/lib/toast,
 *            next/navigation (useRouter + usePathname),
 *            @/components/EmptyState passthrough, @/components/Skeleton
 *            passthrough, lucide-react icon stubs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";

const { apiMock, toastMock, routerMock, authMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
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
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  usePathname: () => "/dashboard/lab-orders",
}));
vi.mock("@/components/EmptyState", () => ({
  EmptyState: ({
    title,
    description,
  }: {
    title: string;
    description?: string;
  }) => (
    <div data-testid="empty-state">
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
    </div>
  ),
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({
    rows,
    columns,
  }: {
    rows?: number;
    columns?: number;
  }) => (
    <div
      data-testid="skeleton-table"
      data-rows={rows}
      data-columns={columns}
    />
  ),
}));
vi.mock("lucide-react", () => ({
  FlaskConical: () => <span data-testid="icon-flask" />,
  ExternalLink: () => <span data-testid="icon-external" />,
}));

import LabOrdersPage from "../page";

type LabOrderRow = {
  id: string;
  orderNumber?: string | null;
  orderedAt: string;
  status: string;
  priority?: string | null;
  stat?: boolean;
  items: Array<{
    id: string;
    status: string;
    test: { id: string; name: string; code?: string | null };
    results?: Array<{ id: string }>;
  }>;
  doctor?: { user: { name: string } } | null;
};

function orderFixture(overrides: Partial<LabOrderRow> = {}): LabOrderRow {
  return {
    id: "order-abcdef1234",
    orderNumber: "LO-001",
    orderedAt: "2026-04-15T08:30:00.000Z",
    status: "REPORTED",
    priority: "ROUTINE",
    stat: false,
    items: [
      {
        id: "item-1",
        status: "REPORTED",
        test: { id: "test-1", name: "CBC", code: "CBC" },
        results: [{ id: "res-1" }],
      },
    ],
    doctor: { user: { name: "Dr. Mehta" } },
    ...overrides,
  };
}

// Convenience: install an auth user before render.
function setAuthUser(opts: { role: string; isLoading?: boolean } | null) {
  if (opts === null) {
    authMock.mockReturnValue({ user: null, isLoading: false });
    return;
  }
  authMock.mockReturnValue({
    user: { id: "u1", role: opts.role, name: "Test User" },
    isLoading: opts.isLoading ?? false,
  });
}

describe("LabOrdersPage", () => {
  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
    toastMock.error.mockReset();
    routerMock.replace.mockReset();
    authMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the loading skeleton while the first fetch is in flight", async () => {
    setAuthUser({ role: "PATIENT" });
    // Never-resolving promise pins the loading branch.
    apiMock.get.mockImplementation(() => new Promise(() => {}));

    render(<LabOrdersPage />);

    const loading = await screen.findByTestId("lab-orders-loading");
    expect(loading).toBeInTheDocument();
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("skeleton-table")).toHaveAttribute(
      "data-rows",
      "5",
    );
    // Header chrome stays.
    expect(
      screen.getByRole("heading", { name: /lab orders/i }),
    ).toBeInTheDocument();
  });

  it("non-allowed role triggers toast.error + router.replace and skips the fetch", async () => {
    setAuthUser({ role: "BILLING" });
    apiMock.get.mockResolvedValue({ data: [] });

    render(<LabOrdersPage />);

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Lab orders are restricted.");
    });
    expect(routerMock.replace).toHaveBeenCalledWith(
      "/dashboard/not-authorized?from=%2Fdashboard%2Flab-orders",
    );
    // No fetch issued for a disallowed role.
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("does not dispatch a fetch and does not redirect when no user is present (anonymous bootstrap)", async () => {
    // Source: the load effect short-circuits on `if (user && ALLOWED.has(user.role))`,
    // and the redirect effect short-circuits on `if (!isLoading && user && ...)`.
    // With user = null both effects no-op, so this exercises the "before-auth-loads"
    // bootstrap state of the page.
    setAuthUser(null);
    apiMock.get.mockResolvedValue({ data: [] });

    render(<LabOrdersPage />);

    // Give effects a chance to run.
    await new Promise((r) => setTimeout(r, 20));
    expect(apiMock.get).not.toHaveBeenCalled();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("renders the table with date, order #, joined test names, status pill, and STAT badge on happy fetch", async () => {
    setAuthUser({ role: "PATIENT" });
    apiMock.get.mockResolvedValue({
      data: [
        orderFixture({
          id: "row-1",
          orderNumber: "LO-100",
          status: "REPORTED",
          stat: true,
          items: [
            {
              id: "i1",
              status: "REPORTED",
              test: { id: "t1", name: "CBC", code: "CBC" },
              results: [{ id: "r1" }],
            },
            {
              id: "i2",
              status: "REPORTED",
              test: { id: "t2", name: "LFT", code: "LFT" },
              results: [{ id: "r2" }],
            },
          ],
        }),
      ],
    });

    render(<LabOrdersPage />);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/lab/orders?page=1&limit=50"),
    );

    // Row rendered.
    expect(
      await screen.findByTestId("lab-order-row-row-1"),
    ).toBeInTheDocument();
    expect(screen.getByText("LO-100")).toBeInTheDocument();
    expect(screen.getByText("CBC, LFT")).toBeInTheDocument();
    // Status pill.
    expect(screen.getByText("REPORTED")).toBeInTheDocument();
    // STAT badge.
    expect(screen.getByText("STAT")).toBeInTheDocument();
    // View report button exists for REPORTED.
    expect(
      screen.getByTestId("lab-order-report-row-1"),
    ).toBeInTheDocument();
    // Loading marker is gone.
    expect(
      screen.queryByTestId("lab-orders-loading"),
    ).not.toBeInTheDocument();
  });

  it("falls back to the first 8 chars of id when orderNumber is null", async () => {
    setAuthUser({ role: "PATIENT" });
    apiMock.get.mockResolvedValue({
      data: [
        orderFixture({
          id: "abcd1234ZZZZZZ",
          orderNumber: null,
          status: "REPORTED",
        }),
      ],
    });

    render(<LabOrdersPage />);

    expect(await screen.findByText("abcd1234")).toBeInTheDocument();
  });

  it("renders the em-dash placeholder when orderedAt is unparseable", async () => {
    setAuthUser({ role: "PATIENT" });
    apiMock.get.mockResolvedValue({
      data: [
        orderFixture({
          id: "bad-date",
          orderedAt: "not-a-real-date",
          status: "REPORTED",
        }),
      ],
    });

    render(<LabOrdersPage />);

    const row = await screen.findByTestId("lab-order-row-bad-date");
    expect(row).toHaveTextContent("—");
  });

  it("renders the em-dash placeholder when items[] is empty (no test names to join)", async () => {
    setAuthUser({ role: "PATIENT" });
    apiMock.get.mockResolvedValue({
      data: [
        orderFixture({
          id: "no-items",
          status: "PENDING",
          items: [],
        }),
      ],
    });

    render(<LabOrdersPage />);

    const row = await screen.findByTestId("lab-order-row-no-items");
    // The em-dash is the tests-cell placeholder when there is nothing to join.
    expect(row).toHaveTextContent("—");
    // Non-reportable + no items[].results → "Pending" placeholder.
    expect(row).toHaveTextContent("Pending");
  });

  it("renders the EmptyState when the API returns no orders", async () => {
    setAuthUser({ role: "PATIENT" });
    apiMock.get.mockResolvedValue({ data: [] });

    render(<LabOrdersPage />);

    expect(await screen.findByTestId("empty-state")).toBeInTheDocument();
    expect(screen.getByText(/no lab orders yet/i)).toBeInTheDocument();
    expect(
      screen.queryByTestId("lab-orders-table-wrap"),
    ).not.toBeInTheDocument();
  });

  it("renders the error panel with the thrown message when the GET rejects with an Error", async () => {
    setAuthUser({ role: "PATIENT" });
    apiMock.get.mockRejectedValue(new Error("Network unreachable"));

    render(<LabOrdersPage />);

    const errPanel = await screen.findByTestId("lab-orders-error");
    expect(errPanel).toBeInTheDocument();
    expect(errPanel).toHaveAttribute("role", "alert");
    expect(errPanel).toHaveTextContent("Could not load lab orders.");
    expect(errPanel).toHaveTextContent("Network unreachable");
    // Table + empty-state must not render.
    expect(
      screen.queryByTestId("lab-orders-table-wrap"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument();
  });

  it("renders the generic fallback message when the GET rejects with a non-Error value", async () => {
    setAuthUser({ role: "PATIENT" });
    apiMock.get.mockRejectedValue("boom-string");

    render(<LabOrdersPage />);

    const errPanel = await screen.findByTestId("lab-orders-error");
    expect(errPanel).toHaveTextContent("Failed to load lab orders");
  });

  it("clicking View report opens the configured API PDF endpoint in a new tab", async () => {
    setAuthUser({ role: "PATIENT" });
    apiMock.get.mockResolvedValue({
      data: [
        orderFixture({
          id: "order-pdf-1",
          status: "REPORTED",
        }),
      ],
    });

    const openSpy = vi
      .spyOn(window, "open")
      .mockImplementation(() => null as unknown as Window);

    render(<LabOrdersPage />);

    const btn = await screen.findByTestId("lab-order-report-order-pdf-1");
    fireEvent.click(btn);

    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, target] = openSpy.mock.calls[0]!;
    // NEXT_PUBLIC_API_URL falls back to http://localhost:4000/api/v1 in tests.
    expect(String(url)).toMatch(/\/lab\/orders\/order-pdf-1\/pdf$/);
    expect(target).toBe("_blank");
  });

  it("non-reportable status with eager-loaded items[].results still renders the report button (items-fallback branch)", async () => {
    setAuthUser({ role: "PATIENT" });
    apiMock.get.mockResolvedValue({
      data: [
        orderFixture({
          id: "fallback-id",
          // A status NOT in the reportableStatuses set...
          status: "IN_PROGRESS",
          // ...but at least one item carries a result row → fallback hits.
          items: [
            {
              id: "i1",
              status: "IN_PROGRESS",
              test: { id: "t1", name: "ESR", code: "ESR" },
              results: [{ id: "r1" }],
            },
          ],
        }),
      ],
    });

    render(<LabOrdersPage />);

    expect(
      await screen.findByTestId("lab-order-report-fallback-id"),
    ).toBeInTheDocument();
    // Status pill shows the actual status, not the reportable label.
    expect(screen.getByText("IN_PROGRESS")).toBeInTheDocument();
  });

  it("non-reportable status without item-results shows the Pending placeholder (no button)", async () => {
    setAuthUser({ role: "PATIENT" });
    apiMock.get.mockResolvedValue({
      data: [
        orderFixture({
          id: "pending-id",
          status: "PENDING",
          items: [
            {
              id: "i1",
              status: "PENDING",
              test: { id: "t1", name: "TSH", code: "TSH" },
              results: [],
            },
          ],
        }),
      ],
    });

    render(<LabOrdersPage />);

    const row = await screen.findByTestId("lab-order-row-pending-id");
    expect(row).toHaveTextContent("Pending");
    expect(
      screen.queryByTestId("lab-order-report-pending-id"),
    ).not.toBeInTheDocument();
  });

  it("handles a response with no data field by rendering the empty-state", async () => {
    setAuthUser({ role: "PATIENT" });
    // Source: `res.data ?? []` — explicitly tests the nullish coalescing branch.
    apiMock.get.mockResolvedValue({});

    render(<LabOrdersPage />);

    expect(await screen.findByTestId("empty-state")).toBeInTheDocument();
  });

  it("issues the fetch for non-PATIENT allowed roles (e.g. DOCTOR) and does not redirect", async () => {
    setAuthUser({ role: "DOCTOR" });
    apiMock.get.mockResolvedValue({ data: [] });

    render(<LabOrdersPage />);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/lab/orders?page=1&limit=50"),
    );
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });
});
