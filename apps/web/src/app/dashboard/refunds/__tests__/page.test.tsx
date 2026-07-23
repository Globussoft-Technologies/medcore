// Coverage tests for the refunds dashboard page
// (apps/web/src/app/dashboard/refunds/page.tsx). The page is read-only —
// it lists refunds in a date range fetched from
//   GET /billing/reports/refunds?from=<iso>&to=<iso>
// — gated to ADMIN / RECEPTION by VIEW_ALLOWED (Issue #509), with a
// loading skeleton, an empty state, a happy-list state, an inline
// reversed-range validator (From > To disables Apply), and a totals card.
// Why: page was at 0% coverage; these assertions lock in the rendered
// surface so future refactors can't silently regress the RBAC redirect,
// the date-range URL contract, the empty state, or the row rendering.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { apiMock, authMock, routerReplace, toastErrorMock } = vi.hoisted(
  () => ({
    apiMock: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
    authMock: vi.fn(),
    routerReplace: vi.fn(),
    toastErrorMock: vi.fn(),
  }),
);

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({
  toast: {
    error: toastErrorMock,
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace, back: vi.fn() }),
  usePathname: () => "/dashboard/refunds",
  useSearchParams: () => new URLSearchParams(),
}));

import RefundsPage from "../page";

// Row fixture — keeps tests terse, returns the minimum shape the page reads.
function refundRow(overrides: Partial<any> = {}) {
  return {
    id: "ref-1",
    paidAt: "2026-05-10T09:30:00.000Z",
    amount: 1250,
    mode: "CASH",
    reason: "Service cancelled",
    invoice: {
      id: "inv-1",
      invoiceNumber: "INV-2026-0001",
      totalAmount: 5000,
      patient: {
        user: { name: "Asha Patel", phone: "+91-9990001111" },
      },
    },
    ...overrides,
  };
}

function ok(refunds: any[], totalRefunded = 0) {
  return {
    data: {
      refunds,
      totalRefunded,
      count: refunds.length,
    },
  };
}

describe("Refunds dashboard page", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    routerReplace.mockReset();
    toastErrorMock.mockReset();
    authMock.mockReturnValue({
      user: { role: "ADMIN", id: "u1", userId: "u1", name: "Admin" },
      isLoading: false,
    });
  });

  it("shows the skeleton loading state while the fetch is pending", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    render(<RefundsPage />);

    // Loading container is identified by data-testid and aria-busy.
    await waitFor(() =>
      expect(screen.getByTestId("refunds-loading")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("refunds-loading")).toHaveAttribute(
      "aria-busy",
      "true",
    );

    // Header chrome renders regardless of fetch state.
    expect(
      screen.getByRole("heading", { name: /Refunds/i }),
    ).toBeInTheDocument();
  });

  it("fetches /billing/reports/refunds with the default 30-day range on mount and renders one row per refund", async () => {
    apiMock.get.mockResolvedValue(
      ok(
        [
          refundRow({ id: "ref-1" }),
          refundRow({
            id: "ref-2",
            amount: 800,
            mode: "UPI",
            reason: "",
            invoice: {
              id: "inv-2",
              invoiceNumber: "INV-2026-0002",
              totalAmount: 2000,
              patient: {
                user: { name: "Vikram Singh", phone: "+91-9990002222" },
              },
            },
          }),
        ],
        2050,
      ),
    );

    render(<RefundsPage />);

    // Wait for the first row to settle.
    await screen.findByText("Asha Patel");

    // Endpoint contract — page passes ISO strings derived from the default
    // 30-day window. Assert the path prefix + that both `from=` and `to=`
    // querystring params are present and ISO-shaped (the exact instants
    // depend on the wall clock at test time, so don't pin them).
    const call = apiMock.get.mock.calls[0]?.[0] as string;
    expect(call).toMatch(/^\/billing\/reports\/refunds\?from=.+&to=.+/);
    const url = new URL(call, "http://x");
    expect(url.searchParams.get("from")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(url.searchParams.get("to")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );

    // Both patient names render.
    expect(screen.getByText("Asha Patel")).toBeInTheDocument();
    expect(screen.getByText("Vikram Singh")).toBeInTheDocument();

    // Invoice numbers render as links pointing at /dashboard/billing/<id>.
    const invLink = screen.getByRole("link", { name: "INV-2026-0001" });
    expect(invLink).toHaveAttribute("href", "/dashboard/billing/inv-1");
    expect(
      screen.getByRole("link", { name: "INV-2026-0002" }),
    ).toHaveAttribute("href", "/dashboard/billing/inv-2");

    // Amounts formatted via fmtMoney().
    expect(screen.getByText(/Rs\.\s*1,250\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Rs\.\s*800\.00/)).toBeInTheDocument();

    // Modes render.
    expect(screen.getByText("CASH")).toBeInTheDocument();
    expect(screen.getByText("UPI")).toBeInTheDocument();

    // Reason falls back to em-dash when empty (row 2).
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText("Service cancelled")).toBeInTheDocument();

    // Totals card — formatted total + plural row count.
    expect(screen.getByText(/Rs\.\s*2,050\.00/)).toBeInTheDocument();
    expect(screen.getByText(/2 refunds/)).toBeInTheDocument();
  });

  it("keeps very long refund reasons inside the reason column", async () => {
    const longReason = "refund".repeat(80);
    apiMock.get.mockResolvedValue(ok([refundRow({ reason: longReason })], 500));

    render(<RefundsPage />);

    const reason = await screen.findByText(longReason);
    expect(reason.closest("table")).toHaveClass("table-fixed");
    expect(reason.closest("td")).toHaveClass("break-words");
    expect(reason.closest("td")).toHaveClass("whitespace-normal");
  });

  it("renders the empty state when the API returns zero refunds", async () => {
    apiMock.get.mockResolvedValue(ok([], 0));
    render(<RefundsPage />);

    expect(
      await screen.findByText(/No refunds in this period\./i),
    ).toBeInTheDocument();
    // Singular row count when 0 (page renders "0 refunds" since rows.length !== 1).
    expect(screen.getByText(/0 refunds/)).toBeInTheDocument();
  });

  it("uses the singular row label when there is exactly one refund", async () => {
    apiMock.get.mockResolvedValue(ok([refundRow()], 1250));
    render(<RefundsPage />);
    await screen.findByText("Asha Patel");
    // Pluralisation: 1 → "1 refund" (no trailing s).
    expect(screen.getByText(/^1 refund$/)).toBeInTheDocument();
  });

  it("falls through to the empty state when the fetch rejects (error is swallowed)", async () => {
    apiMock.get.mockRejectedValue(
      Object.assign(new Error("boom"), { status: 500 }),
    );
    render(<RefundsPage />);

    // Page's catch-block ignores the error and renders the empty branch
    // because rows stays []; loading flips to false.
    expect(
      await screen.findByText(/No refunds in this period\./i),
    ).toBeInTheDocument();
    // Skeleton is gone.
    expect(screen.queryByTestId("refunds-loading")).not.toBeInTheDocument();
  });

  it("redirects non-allowed roles to /dashboard/not-authorized and surfaces a toast", async () => {
    authMock.mockReturnValue({
      user: { role: "PATIENT", id: "u2", userId: "u2", name: "Pat" },
      isLoading: false,
    });
    // The fetch may still fire from the load effect; return empty so the
    // page renders without hanging.
    apiMock.get.mockResolvedValue(ok([], 0));

    render(<RefundsPage />);

    await waitFor(() =>
      expect(routerReplace).toHaveBeenCalledWith(
        "/dashboard/not-authorized?from=%2Fdashboard%2Frefunds",
      ),
    );
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Refunds are restricted to Admin and Reception.",
    );
  });

  it("permits RECEPTION (the other allow-listed role) without bouncing", async () => {
    authMock.mockReturnValue({
      user: { role: "RECEPTION", id: "u3", userId: "u3", name: "Recep" },
      isLoading: false,
    });
    apiMock.get.mockResolvedValue(ok([], 0));

    render(<RefundsPage />);
    await screen.findByText(/No refunds in this period\./i);
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("does not redirect while the auth store is still loading", async () => {
    authMock.mockReturnValue({ user: null, isLoading: true });
    apiMock.get.mockResolvedValue(ok([], 0));

    render(<RefundsPage />);
    // Give the effect a tick.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Refunds/i })).toBeInTheDocument(),
    );
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("shows the reversed-range error and disables Apply when From > To", async () => {
    apiMock.get.mockResolvedValue(ok([], 0));
    render(<RefundsPage />);
    await screen.findByText(/No refunds in this period\./i);
    const callsBefore = apiMock.get.mock.calls.length;

    const fromInput = screen.getByLabelText("From") as HTMLInputElement;
    const toInput = screen.getByLabelText("To") as HTMLInputElement;

    // Force a reversed range: To earlier than From. Set To FIRST to a date
    // well before the (recent) default From, so the range is reversed from the
    // very first change. Otherwise — when this test runs on the 1st of the
    // month, where the default To is also today — setting From=today first
    // leaves a briefly-VALID intermediate range (From===To) that triggers the
    // page's auto-refetch, inflating the call count and failing the assertion
    // below.
    fireEvent.change(toInput, { target: { value: "2000-01-01" } });
    fireEvent.change(fromInput, { target: { value: "2026-06-01" } });

    // Error message surfaces, aria-invalid flips true, Apply is disabled.
    expect(
      screen.getByText(/End date must be on or after start date/i),
    ).toBeInTheDocument();
    expect(toInput).toHaveAttribute("aria-invalid", "true");
    const applyBtn = screen.getByRole("button", { name: /Apply/i });
    expect(applyBtn).toBeDisabled();

    // Clicking Apply on a reversed range is a no-op — no new fetch.
    fireEvent.click(applyBtn);
    // Pure-DOM click on a disabled button doesn't reach the handler, but
    // even if it did, load() returns early. Either way, no new GET.
    await waitFor(() => {
      expect(apiMock.get.mock.calls.length).toBe(callsBefore);
    });
  });

  it("refetches with the new range when Apply is clicked after a valid date change", async () => {
    apiMock.get.mockResolvedValue(ok([], 0));
    render(<RefundsPage />);
    await screen.findByText(/No refunds in this period\./i);

    const callsBefore = apiMock.get.mock.calls.length;
    const fromInput = screen.getByLabelText("From") as HTMLInputElement;
    const toInput = screen.getByLabelText("To") as HTMLInputElement;

    fireEvent.change(fromInput, { target: { value: "2026-01-01" } });
    fireEvent.change(toInput, { target: { value: "2026-01-31" } });

    fireEvent.click(screen.getByRole("button", { name: /Apply/i }));

    // The load callback's dep-array already triggered a refetch on the
    // state change; clicking Apply guarantees at least one further call.
    // We just assert that more fetches have been issued and that the
    // most-recent URL carries the new dates.
    await waitFor(() => {
      expect(apiMock.get.mock.calls.length).toBeGreaterThan(callsBefore);
    });
    const lastCall =
      apiMock.get.mock.calls[apiMock.get.mock.calls.length - 1][0] as string;
    const url = new URL(lastCall, "http://x");
    expect(url.searchParams.get("from")).toContain("2026-01-01");
    expect(url.searchParams.get("to")).toContain("2026-01-31");
  });
});
