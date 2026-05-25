/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * MyLeavesPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every branch of `apps/web/src/app/dashboard/my-leaves/page.tsx`,
 *     the staff self-service leave management page. The page issues
 *     `GET /leaves/my` on mount, renders a summary tile grid + a leave-request
 *     table, and exposes a Request Leave modal that POSTs `/leaves` and a
 *     per-row Cancel action that PATCHes `/leaves/:id/cancel`.
 *
 *   - Behaviours covered:
 *       1. Loading skeleton — `data-testid="my-leaves-loading"` with `aria-busy`
 *          renders while the GET /leaves/my fetch is in flight; the header
 *          (title + Request Leave button) stays visible.
 *       2. Happy fetch — leaves table + summary tiles populate; row shows
 *          type / formatted dates / days / reason / status pill / requested-at;
 *          PENDING rows expose a Cancel button, non-PENDING rows show a dash.
 *       3. Status transitions — APPROVED + REJECTED + CANCELLED rows render
 *          with the right pill class and no Cancel button; REJECTED row also
 *          surfaces the rejectionReason copy.
 *       4. Balance display — summary tiles render pending / approved counts,
 *          totalUsed sum, and per-type breakdown when any type > 0.
 *       5. Empty state — zero leaves AND zero used days both render their
 *          dedicated copy.
 *       6. Leave-request action — opens modal, submits form, calls POST
 *          /leaves with the typed values, reloads the list, closes the modal.
 *       7. Cancel-own-request — Cancel button triggers the confirm dialog;
 *          when confirmed, PATCHes /leaves/:id/cancel and reloads.
 *          When NOT confirmed, the PATCH is never issued.
 *       8. Error path — GET /leaves/my rejection clears loading without
 *          crashing; POST /leaves with field-level details surfaces inline
 *          field errors; POST /leaves with a generic error surfaces a toast.
 *       9. Validation — submitting an empty form sets fieldErrors for the
 *          three required fields; submitting with `toDate < fromDate` sets
 *          the toDate error inline.
 *
 *   - Source under test: apps/web/src/app/dashboard/my-leaves/page.tsx
 *   - Mocks: @/lib/api (api.get / api.post / api.patch), @/lib/toast
 *            (toast.error), @/lib/use-dialog (useConfirm), @/lib/format
 *            (formatDate passthrough), @/components/Skeleton (SkeletonTable
 *            passthrough), lucide-react (icon stubs).
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

const { apiMock, confirmMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  confirmMock: vi.fn(),
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmMock,
  usePrompt: () => vi.fn(),
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows?: number; columns?: number }) => (
    <div
      data-testid="skeleton-table"
      data-rows={rows}
      data-columns={columns}
    />
  ),
}));
vi.mock("lucide-react", () => ({
  PlaneTakeoff: () => <span data-testid="icon-plane-takeoff" />,
  Plus: () => <span data-testid="icon-plus" />,
  XCircle: () => <span data-testid="icon-x-circle" />,
}));

import MyLeavesPage from "../page";

type Leave = {
  id: string;
  type: string;
  fromDate: string;
  toDate: string;
  totalDays: number;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  rejectionReason?: string | null;
  approvedAt?: string | null;
  createdAt: string;
  approver?: { id: string; name: string } | null;
};

type Summary = {
  pending: number;
  approved: number;
  used: Record<string, number>;
};

function leaveFixture(overrides: Partial<Leave> = {}): Leave {
  return {
    id: "leave-pending-1",
    type: "CASUAL",
    fromDate: "2026-05-10T12:00:00.000Z",
    toDate: "2026-05-11T12:00:00.000Z",
    totalDays: 2,
    reason: "Family event",
    status: "PENDING",
    rejectionReason: null,
    approvedAt: null,
    createdAt: "2026-05-01T09:00:00.000Z",
    approver: null,
    ...overrides,
  };
}

function wireMy(opts: {
  leaves?: Leave[];
  summary?: Summary;
  error?: Error;
} = {}) {
  const summary: Summary = opts.summary ?? {
    pending: 1,
    approved: 0,
    used: {},
  };
  apiMock.get.mockImplementation((url: string) => {
    if (url === "/leaves/my") {
      if (opts.error) return Promise.reject(opts.error);
      return Promise.resolve({
        data: { leaves: opts.leaves ?? [], summary },
      });
    }
    return Promise.resolve({ data: [] });
  });
}

describe("MyLeavesPage", () => {
  beforeEach(() => {
    cleanup();
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    confirmMock.mockReset();
    toastMock.error.mockReset();
    toastMock.success.mockReset();
    // Default: confirm dialog resolves true (user accepts) so happy-path
    // tests don't have to wire it explicitly.
    confirmMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the loading skeleton while GET /leaves/my is in flight", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/leaves/my") return new Promise(() => {});
      return Promise.resolve({ data: [] });
    });

    render(<MyLeavesPage />);

    const loading = await screen.findByTestId("my-leaves-loading");
    expect(loading).toBeInTheDocument();
    expect(loading).toHaveAttribute("aria-busy", "true");
    // Skeleton table renders with the source's 5×6 spec.
    const skel = screen.getByTestId("skeleton-table");
    expect(skel).toHaveAttribute("data-rows", "5");
    expect(skel).toHaveAttribute("data-columns", "6");
    // Header chrome stays.
    expect(
      screen.getByRole("heading", { name: /my leaves/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /request leave/i })
    ).toBeInTheDocument();
  });

  it("renders the leaves table + summary tiles on happy fetch", async () => {
    wireMy({
      leaves: [
        leaveFixture({
          id: "L1",
          type: "CASUAL",
          status: "PENDING",
          totalDays: 2,
          reason: "Family event",
        }),
      ],
      summary: { pending: 1, approved: 3, used: { CASUAL: 2, SICK: 1 } },
    });

    render(<MyLeavesPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-leaves-loading")).not.toBeInTheDocument()
    );

    // Row content — scope to the table to avoid collisions with the summary
    // "By Type" tile which also renders "CASUAL" + "SICK".
    const table = document.querySelector("table") as HTMLElement;
    expect(table).not.toBeNull();
    expect(within(table).getByText("CASUAL")).toBeInTheDocument();
    expect(within(table).getByText("Family event")).toBeInTheDocument();
    expect(within(table).getByText("PENDING")).toBeInTheDocument();
    expect(within(table).getByText("2")).toBeInTheDocument();
    // PENDING row exposes a Cancel button.
    expect(within(table).getByRole("button", { name: /cancel/i })).toBeInTheDocument();

    // Summary tiles — "pending" matches both the tile label and the PENDING
    // status pill; use getAllByText and assert at least two occurrences.
    expect(screen.getAllByText(/^pending$/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/approved \(ytd\)/i)).toBeInTheDocument();
    expect(screen.getByText(/days used \(ytd\)/i)).toBeInTheDocument();
    // Per-type "By Type" breakdown — CASUAL: 2d, SICK: 1d.
    expect(screen.getByText("2d")).toBeInTheDocument();
    expect(screen.getByText("1d")).toBeInTheDocument();
  });

  it("renders APPROVED + REJECTED + CANCELLED status rows correctly", async () => {
    wireMy({
      leaves: [
        leaveFixture({
          id: "L-approved",
          status: "APPROVED",
          type: "SICK",
          reason: "Flu",
        }),
        leaveFixture({
          id: "L-rejected",
          status: "REJECTED",
          type: "EARNED",
          reason: "Vacation",
          rejectionReason: "Capacity constraints",
        }),
        leaveFixture({
          id: "L-cancelled",
          status: "CANCELLED",
          type: "UNPAID",
          reason: "Changed plans",
        }),
      ],
    });

    render(<MyLeavesPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-leaves-loading")).not.toBeInTheDocument()
    );

    expect(screen.getByText("APPROVED")).toBeInTheDocument();
    expect(screen.getByText("REJECTED")).toBeInTheDocument();
    expect(screen.getByText("CANCELLED")).toBeInTheDocument();
    // Rejection reason surfaces under the reason cell.
    expect(screen.getByText(/Rejected: Capacity constraints/i)).toBeInTheDocument();
    // None of these are PENDING, so the table should contain ZERO Cancel buttons.
    const table = document.querySelector("table") as HTMLElement;
    expect(
      within(table).queryByRole("button", { name: /cancel/i })
    ).not.toBeInTheDocument();
    // 3 em-dash cells in the actions column (one per non-PENDING row).
    expect(within(table).getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });

  it("renders 'No leaves taken yet' when every used-type count is zero", async () => {
    wireMy({
      leaves: [
        leaveFixture({
          id: "L1",
          status: "PENDING",
        }),
      ],
      summary: { pending: 1, approved: 0, used: { CASUAL: 0, SICK: 0 } },
    });

    render(<MyLeavesPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-leaves-loading")).not.toBeInTheDocument()
    );

    expect(screen.getByText(/no leaves taken yet/i)).toBeInTheDocument();
  });

  it("renders the empty-leaves placeholder when the list is empty", async () => {
    wireMy({
      leaves: [],
      summary: { pending: 0, approved: 0, used: {} },
    });

    render(<MyLeavesPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-leaves-loading")).not.toBeInTheDocument()
    );

    expect(
      screen.getByText(/no leave requests yet/i)
    ).toBeInTheDocument();
    // Table is NOT rendered when the list is empty.
    expect(document.querySelector("table")).toBeNull();
  });

  it("opens the Request Leave modal, submits, POSTs /leaves, and reloads", async () => {
    wireMy({ leaves: [], summary: { pending: 0, approved: 0, used: {} } });
    apiMock.post.mockResolvedValue({ data: { id: "new-leave" } });

    render(<MyLeavesPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-leaves-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /request leave/i }));

    // Modal opens.
    expect(
      await screen.findByRole("heading", { name: /request leave/i })
    ).toBeInTheDocument();

    // Fill the form.
    const fromInput = screen.getByLabelText(/^from$/i);
    const toInput = screen.getByLabelText(/^to$/i);
    const reasonInput = screen.getByLabelText(/^reason$/i);
    fireEvent.change(fromInput, { target: { value: "2026-06-01" } });
    fireEvent.change(toInput, { target: { value: "2026-06-03" } });
    fireEvent.change(reasonInput, { target: { value: "Quarterly break" } });

    // Submit.
    fireEvent.click(screen.getByRole("button", { name: /submit request/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith("/leaves", {
        type: "CASUAL",
        fromDate: "2026-06-01",
        toDate: "2026-06-03",
        reason: "Quarterly break",
      });
    });

    // After a successful submit, the modal closes and the list reloads.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /request leave/i })
      ).not.toBeInTheDocument()
    );
    // GET /leaves/my was called at least twice: initial + post-submit reload.
    const getCalls = apiMock.get.mock.calls.filter(
      ([url]) => url === "/leaves/my"
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("shows inline required-field errors when the modal is submitted empty", async () => {
    wireMy({ leaves: [], summary: { pending: 0, approved: 0, used: {} } });

    render(<MyLeavesPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-leaves-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /request leave/i }));
    await screen.findByRole("heading", { name: /request leave/i });

    fireEvent.click(screen.getByRole("button", { name: /submit request/i }));

    expect(
      await screen.findByText(/start date is required/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/end date is required/i)).toBeInTheDocument();
    expect(screen.getByText(/reason is required/i)).toBeInTheDocument();
    // POST was NOT issued — guarded by client validation.
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("shows inline toDate error when end < start (issue #32)", async () => {
    wireMy({ leaves: [], summary: { pending: 0, approved: 0, used: {} } });

    render(<MyLeavesPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-leaves-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /request leave/i }));
    await screen.findByRole("heading", { name: /request leave/i });

    fireEvent.change(screen.getByLabelText(/^from$/i), {
      target: { value: "2026-06-10" },
    });
    fireEvent.change(screen.getByLabelText(/^to$/i), {
      target: { value: "2026-06-05" },
    });
    fireEvent.change(screen.getByLabelText(/^reason$/i), {
      target: { value: "Whoops" },
    });

    // Reactive computed error shows even BEFORE submit.
    expect(
      screen.getByText(/end date must be on or after start date/i)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /submit request/i }));

    // POST was NOT issued — client-side guard rejected.
    await waitFor(() => {
      expect(apiMock.post).not.toHaveBeenCalled();
    });
  });

  it("surfaces server-side Zod field errors as inline messages", async () => {
    wireMy({ leaves: [], summary: { pending: 0, approved: 0, used: {} } });
    // Simulate the api throwing an Error with a payload.details array (the
    // app's wire-protocol for Zod field issues).
    const err = Object.assign(new Error("Validation"), {
      payload: {
        details: [
          { field: "reason", message: "Reason must be at least 10 chars" },
        ],
      },
    });
    apiMock.post.mockRejectedValue(err);

    render(<MyLeavesPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-leaves-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /request leave/i }));
    await screen.findByRole("heading", { name: /request leave/i });

    fireEvent.change(screen.getByLabelText(/^from$/i), {
      target: { value: "2026-06-01" },
    });
    fireEvent.change(screen.getByLabelText(/^to$/i), {
      target: { value: "2026-06-03" },
    });
    fireEvent.change(screen.getByLabelText(/^reason$/i), {
      target: { value: "short" },
    });

    fireEvent.click(screen.getByRole("button", { name: /submit request/i }));

    expect(
      await screen.findByText(/reason must be at least 10 chars/i)
    ).toBeInTheDocument();
    // Generic toast was NOT raised (the err had structured field details).
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("surfaces a generic toast when POST /leaves rejects without field details", async () => {
    wireMy({ leaves: [], summary: { pending: 0, approved: 0, used: {} } });
    apiMock.post.mockRejectedValue(new Error("Network down"));

    render(<MyLeavesPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-leaves-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /request leave/i }));
    await screen.findByRole("heading", { name: /request leave/i });

    fireEvent.change(screen.getByLabelText(/^from$/i), {
      target: { value: "2026-06-01" },
    });
    fireEvent.change(screen.getByLabelText(/^to$/i), {
      target: { value: "2026-06-03" },
    });
    fireEvent.change(screen.getByLabelText(/^reason$/i), {
      target: { value: "Long enough reason" },
    });

    fireEvent.click(screen.getByRole("button", { name: /submit request/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Network down");
    });
  });

  it("cancel-own-request — confirm true PATCHes /leaves/:id/cancel and reloads", async () => {
    wireMy({
      leaves: [leaveFixture({ id: "L-cancel-me", status: "PENDING" })],
    });
    apiMock.patch.mockResolvedValue({ data: {} });

    render(<MyLeavesPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-leaves-loading")).not.toBeInTheDocument()
    );

    const table = document.querySelector("table") as HTMLElement;
    fireEvent.click(within(table).getByRole("button", { name: /cancel/i }));

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(apiMock.patch).toHaveBeenCalledWith(
        "/leaves/L-cancel-me/cancel"
      );
    });
    // Reload after successful cancel.
    const getCalls = apiMock.get.mock.calls.filter(
      ([url]) => url === "/leaves/my"
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("cancel-own-request — confirm false does NOT PATCH", async () => {
    wireMy({
      leaves: [leaveFixture({ id: "L-keep", status: "PENDING" })],
    });
    confirmMock.mockResolvedValueOnce(false);

    render(<MyLeavesPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-leaves-loading")).not.toBeInTheDocument()
    );

    const table = document.querySelector("table") as HTMLElement;
    fireEvent.click(within(table).getByRole("button", { name: /cancel/i }));

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalled();
    });
    // Give the page a tick to NOT call patch.
    await new Promise((r) => setTimeout(r, 20));
    expect(apiMock.patch).not.toHaveBeenCalled();
  });

  it("cancel-own-request — PATCH rejection raises a toast", async () => {
    wireMy({
      leaves: [leaveFixture({ id: "L-fail", status: "PENDING" })],
    });
    apiMock.patch.mockRejectedValue(new Error("403 forbidden"));

    render(<MyLeavesPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-leaves-loading")).not.toBeInTheDocument()
    );

    const table = document.querySelector("table") as HTMLElement;
    fireEvent.click(within(table).getByRole("button", { name: /cancel/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("403 forbidden");
    });
  });

  it("GET /leaves/my rejection clears loading without crashing", async () => {
    wireMy({ error: new Error("500 db down") });

    render(<MyLeavesPage />);

    // Loading flips off; the empty-state copy renders since `leaves` stayed [].
    await waitFor(() =>
      expect(screen.queryByTestId("my-leaves-loading")).not.toBeInTheDocument()
    );
    expect(screen.getByText(/no leave requests yet/i)).toBeInTheDocument();
    // Summary block hidden — summary is still null after a failed fetch.
    expect(screen.queryByText(/approved \(ytd\)/i)).not.toBeInTheDocument();
  });

  it("Cancel button in the modal closes the modal without POSTing", async () => {
    wireMy({ leaves: [], summary: { pending: 0, approved: 0, used: {} } });

    render(<MyLeavesPage />);

    await waitFor(() =>
      expect(screen.queryByTestId("my-leaves-loading")).not.toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /request leave/i }));
    const modalHeading = await screen.findByRole("heading", {
      name: /request leave/i,
    });

    // The modal's Cancel button is INSIDE the form.
    const modalForm = modalHeading.closest("form") as HTMLElement;
    const cancelBtn = within(modalForm).getByRole("button", { name: /^cancel$/i });
    fireEvent.click(cancelBtn);

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /request leave/i })
      ).not.toBeInTheDocument()
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });
});
