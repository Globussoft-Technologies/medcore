/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * BillsPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every rendered branch of
 *     `apps/web/src/app/dashboard/bills/page.tsx`, the patient-portal bills
 *     list view shipped for Issue #715. The page hits
 *       GET  /billing/invoices?page=1&limit=50      (API self-scopes to
 *                                                    req.user.patientId when
 *                                                    role === PATIENT)
 *       POST /billing/pay-online { invoiceId }      (creates a Razorpay
 *                                                    order; the page then
 *                                                    opens checkout.razorpay
 *                                                    in a new tab)
 *   - Behaviours covered:
 *       1. Loading branch — `data-testid="bills-loading"` with `aria-busy`
 *          renders while the first fetch is in flight; the "Bills" header is
 *          still visible.
 *       2. Non-allowed role (DOCTOR) — toast.error + router.replace to
 *          `/dashboard/not-authorized?from=...` and no /billing/invoices
 *          fetch is dispatched.
 *       3. Auth-loading guard — when `isLoading: true`, no redirect and no
 *          fetch fires (the page just renders the loading shell).
 *       4. RECEPTION (other allowed role) — page loads without bouncing.
 *       5. Happy fetch — multiple invoices render with formatted date,
 *          fmtMoney() output for amount + balance, status pill, and the Pay
 *          button only on payable rows (PENDING/PARTIAL with balance > 0).
 *       6. Empty fetch — EmptyState ("No bills yet") renders.
 *       7. Error fetch — `data-testid="bills-error"` panel renders with the
 *          thrown message and `role="alert"`.
 *       8. Error fallback for non-Error throws — generic "Failed to load
 *          invoices" copy renders.
 *       9. PAID / REFUNDED rows — no Pay button, em-dash placeholder renders.
 *      10. balanceFor() — Math.max(0, ...) clamps over-payment to zero;
 *          balance also drops payable rows out of the "canPay" branch.
 *      11. Invalid `createdAt` — formatDate() returns the em-dash placeholder.
 *      12. Pay click — fires api.post("/billing/pay-online", { invoiceId }),
 *          opens window.open with the Razorpay checkout URL (key_id, order_id,
 *          amount, currency querystring), and fires the success toast with
 *          the invoice number.
 *      13. Pay error — api.post rejection routes through toast.error and
 *          restores the button label.
 *      14. Pay button disabled + "Starting..." label while payingId === inv.id.
 *
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, next/navigation,
 *            @/components/EmptyState passthrough, @/components/Skeleton
 *            passthrough, lucide-react icon stub, and window.open.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

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
  usePathname: () => "/dashboard/bills",
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
    <div data-testid="skeleton-table" data-rows={rows} data-columns={columns} />
  ),
}));
vi.mock("lucide-react", () => ({
  Receipt: () => <span data-testid="icon-receipt" />,
}));

import BillsPage from "../page";

type InvoiceRow = {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  paymentStatus: string;
  createdAt: string;
  dueDate?: string | null;
  payments?: Array<{ amount: number }>;
};

function invoiceFixture(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "inv-1",
    invoiceNumber: "INV-2026-0001",
    totalAmount: 5000,
    paymentStatus: "PENDING",
    createdAt: "2026-04-15T08:30:00.000Z",
    dueDate: null,
    payments: [],
    ...overrides,
  };
}

function ok(invoices: InvoiceRow[]) {
  return { data: invoices };
}

describe("Bills dashboard page", () => {
  // `vi.spyOn(window, "open")` produces a narrower overloaded MockInstance
  // shape than the bare `ReturnType<typeof vi.spyOn>` generic; using the
  // inferred type via ReturnType<typeof vi.spyOn<Window, "open">> would also
  // work but is more brittle to vitest@2 type-shape churn. `any` here is
  // load-bearing for the lifecycle assignment in beforeEach.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let openSpy: any;

  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    authMock.mockReturnValue({
      user: {
        id: "u-patient",
        userId: "u-patient",
        role: "PATIENT",
        name: "Pat",
      },
      isLoading: false,
    });
    // Stub window.open so the Razorpay redirect doesn't try to navigate jsdom.
    openSpy = vi.spyOn(window, "open").mockReturnValue(null);
  });

  afterEach(() => {
    openSpy.mockRestore();
    cleanup();
  });

  it("renders the loading skeleton with aria-busy while the fetch is in flight", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    render(<BillsPage />);

    await waitFor(() =>
      expect(screen.getByTestId("bills-loading")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("bills-loading")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    // Header chrome renders regardless of fetch state.
    expect(screen.getByRole("heading", { name: /Bills/i })).toBeInTheDocument();
    // Skeleton stub passed through with row/column knobs from the source.
    expect(screen.getByTestId("skeleton-table")).toHaveAttribute(
      "data-rows",
      "5",
    );
    expect(screen.getByTestId("skeleton-table")).toHaveAttribute(
      "data-columns",
      "5",
    );
  });

  it("hits GET /billing/invoices?page=1&limit=50 and renders one row per invoice", async () => {
    apiMock.get.mockResolvedValue(
      ok([
        invoiceFixture({ id: "inv-1", invoiceNumber: "INV-2026-0001" }),
        invoiceFixture({
          id: "inv-2",
          invoiceNumber: "INV-2026-0002",
          totalAmount: 1500,
          paymentStatus: "PAID",
          payments: [{ amount: 1500 }],
        }),
      ]),
    );

    render(<BillsPage />);

    // Wait for the table wrap to settle.
    await screen.findByTestId("bills-table-wrap");

    // Endpoint contract.
    expect(apiMock.get).toHaveBeenCalledWith(
      "/billing/invoices?page=1&limit=50",
    );

    // Both invoice numbers rendered.
    expect(screen.getByText("INV-2026-0001")).toBeInTheDocument();
    expect(screen.getByText("INV-2026-0002")).toBeInTheDocument();

    // Row containers carry the testid.
    expect(screen.getByTestId("bills-row-inv-1")).toBeInTheDocument();
    expect(screen.getByTestId("bills-row-inv-2")).toBeInTheDocument();

    // fmtMoney() — Rs. 5,000.00 renders twice on the PENDING row (amount AND
    // balance, since payments[] is empty); Rs. 1,500.00 renders once on the
    // PAID row's amount column and Rs. 0.00 in its balance column.
    expect(screen.getAllByText(/Rs\.\s*5,000\.00/).length).toBe(2);
    expect(screen.getByText(/Rs\.\s*1,500\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Rs\.\s*0\.00/)).toBeInTheDocument();

    // Status pills render the literal status text.
    expect(screen.getByText("PENDING")).toBeInTheDocument();
    expect(screen.getByText("PAID")).toBeInTheDocument();

    // The PENDING row gets a Pay button; the PAID row does not.
    expect(screen.getByTestId("bills-pay-inv-1")).toBeInTheDocument();
    expect(screen.queryByTestId("bills-pay-inv-2")).not.toBeInTheDocument();
  });

  it("renders the EmptyState when the API returns zero invoices", async () => {
    apiMock.get.mockResolvedValue(ok([]));
    render(<BillsPage />);

    await screen.findByTestId("empty-state");
    expect(screen.getByText("No bills yet")).toBeInTheDocument();
    expect(
      screen.getByText(/Invoices for your visits and procedures/i),
    ).toBeInTheDocument();
    // No table.
    expect(screen.queryByTestId("bills-table-wrap")).not.toBeInTheDocument();
  });

  it("renders the error panel with the thrown message when the fetch rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("backend down"));
    render(<BillsPage />);

    const panel = await screen.findByTestId("bills-error");
    expect(panel).toHaveAttribute("role", "alert");
    expect(screen.getByText(/Could not load bills\./i)).toBeInTheDocument();
    expect(screen.getByText("backend down")).toBeInTheDocument();
    // Skeleton is gone.
    expect(screen.queryByTestId("bills-loading")).not.toBeInTheDocument();
  });

  it("falls back to a generic error message when the rejection is not an Error instance", async () => {
    apiMock.get.mockRejectedValue("string-rejection");
    render(<BillsPage />);

    await screen.findByTestId("bills-error");
    expect(screen.getByText("Failed to load invoices")).toBeInTheDocument();
  });

  it("redirects non-allowed roles (DOCTOR) to /dashboard/not-authorized and skips the fetch", async () => {
    authMock.mockReturnValue({
      user: { id: "u-doc", userId: "u-doc", role: "DOCTOR", name: "Doc" },
      isLoading: false,
    });

    render(<BillsPage />);

    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith(
        "/dashboard/not-authorized?from=%2Fdashboard%2Fbills",
      ),
    );
    expect(toastMock.error).toHaveBeenCalledWith("Bills are restricted.");
    // The fetch guard `if (user && ALLOWED.has(user.role))` blocks the GET.
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("permits RECEPTION (the staff allow-listed role) without bouncing", async () => {
    authMock.mockReturnValue({
      user: { id: "u-r", userId: "u-r", role: "RECEPTION", name: "Recep" },
      isLoading: false,
    });
    apiMock.get.mockResolvedValue(ok([]));

    render(<BillsPage />);
    await screen.findByTestId("empty-state");
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(apiMock.get).toHaveBeenCalledTimes(1);
  });

  it("does not redirect or fetch while the auth store is still loading", async () => {
    authMock.mockReturnValue({ user: null, isLoading: true });

    render(<BillsPage />);

    // Loading shell renders because `loading` defaults to true and no fetch
    // is dispatched (user is null).
    expect(screen.getByTestId("bills-loading")).toBeInTheDocument();
    // No redirect: gate requires user to be defined.
    expect(routerMock.replace).not.toHaveBeenCalled();
    // No fetch: gate requires ALLOWED.has(user.role).
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it("renders the em-dash placeholder when createdAt is an invalid date", async () => {
    apiMock.get.mockResolvedValue(
      ok([invoiceFixture({ createdAt: "not-a-real-date" })]),
    );
    render(<BillsPage />);

    await screen.findByTestId("bills-row-inv-1");
    // The Action cell also renders an em-dash for non-payable rows, but this
    // PENDING row IS payable so its Action cell holds the Pay button. The
    // only em-dash in this DOM should be the date cell.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  it("hides the Pay button on REFUNDED rows and on PENDING rows whose balance reached zero", async () => {
    apiMock.get.mockResolvedValue(
      ok([
        invoiceFixture({
          id: "inv-refund",
          invoiceNumber: "INV-REF",
          paymentStatus: "REFUNDED",
        }),
        // PENDING row that was actually overpaid — balanceFor clamps to 0,
        // so canPay flips false despite the PENDING status.
        invoiceFixture({
          id: "inv-overpaid",
          invoiceNumber: "INV-OVR",
          totalAmount: 1000,
          paymentStatus: "PENDING",
          payments: [{ amount: 1500 }],
        }),
      ]),
    );

    render(<BillsPage />);
    await screen.findByTestId("bills-row-inv-refund");

    expect(screen.queryByTestId("bills-pay-inv-refund")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bills-pay-inv-overpaid")).not.toBeInTheDocument();
  });

  it("renders the Pay button on PARTIAL rows with a remaining balance", async () => {
    apiMock.get.mockResolvedValue(
      ok([
        invoiceFixture({
          id: "inv-partial",
          invoiceNumber: "INV-PAR",
          totalAmount: 5000,
          paymentStatus: "PARTIAL",
          payments: [{ amount: 2000 }],
        }),
      ]),
    );

    render(<BillsPage />);
    await screen.findByTestId("bills-row-inv-partial");

    // Pay button surfaces.
    const payBtn = screen.getByTestId("bills-pay-inv-partial");
    expect(payBtn).toBeInTheDocument();
    // Balance cell renders Rs. 3,000.00.
    expect(screen.getByText(/Rs\.\s*3,000\.00/)).toBeInTheDocument();
  });

  it("posts to /billing/pay-online, opens the Razorpay checkout URL, and surfaces a success toast on Pay click", async () => {
    apiMock.get.mockResolvedValue(
      ok([invoiceFixture({ id: "inv-1", invoiceNumber: "INV-2026-0001" })]),
    );
    apiMock.post.mockResolvedValue({
      data: {
        orderId: "order_xyz",
        amount: 500000,
        currency: "INR",
        keyId: "rzp_test_123",
        invoiceId: "inv-1",
        invoiceNumber: "INV-2026-0001",
      },
    });

    render(<BillsPage />);
    await screen.findByTestId("bills-row-inv-1");

    fireEvent.click(screen.getByTestId("bills-pay-inv-1"));

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith("/billing/pay-online", {
        invoiceId: "inv-1",
      }),
    );

    // window.open fired with the Razorpay hosted checkout URL.
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
    const [url, target, features] = openSpy.mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(url).toContain(
      "https://checkout.razorpay.com/v1/checkout.html",
    );
    expect(url).toContain("key_id=rzp_test_123");
    expect(url).toContain("order_id=order_xyz");
    expect(url).toContain("amount=500000");
    expect(url).toContain("currency=INR");
    expect(target).toBe("_blank");
    expect(features).toBe("noopener,noreferrer");

    // Success toast quotes the invoice number.
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringContaining("INV-2026-0001"),
    );
  });

  it("surfaces toast.error and restores the Pay label when /billing/pay-online rejects", async () => {
    apiMock.get.mockResolvedValue(
      ok([invoiceFixture({ id: "inv-1", invoiceNumber: "INV-2026-0001" })]),
    );
    apiMock.post.mockRejectedValue(new Error("razorpay 503"));

    render(<BillsPage />);
    await screen.findByTestId("bills-row-inv-1");

    fireEvent.click(screen.getByTestId("bills-pay-inv-1"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("razorpay 503"),
    );
    // window.open was not invoked because the order never resolved.
    expect(openSpy).not.toHaveBeenCalled();
    // Pay button label restored from "Starting..." back to "Pay".
    await waitFor(() => {
      const btn = screen.getByTestId("bills-pay-inv-1");
      expect(btn).toHaveTextContent("Pay");
      expect(btn).not.toBeDisabled();
    });
  });

  it("falls back to a generic 'Failed to start payment' toast when the pay rejection is not an Error", async () => {
    apiMock.get.mockResolvedValue(
      ok([invoiceFixture({ id: "inv-1", invoiceNumber: "INV-2026-0001" })]),
    );
    apiMock.post.mockRejectedValue("nope");

    render(<BillsPage />);
    await screen.findByTestId("bills-row-inv-1");
    fireEvent.click(screen.getByTestId("bills-pay-inv-1"));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Failed to start payment"),
    );
  });

  it("disables the Pay button and swaps the label to 'Starting...' while the POST is pending", async () => {
    apiMock.get.mockResolvedValue(
      ok([invoiceFixture({ id: "inv-1", invoiceNumber: "INV-2026-0001" })]),
    );
    // Hang the post so payingId stays === inv.id.
    apiMock.post.mockImplementation(() => new Promise(() => {}));

    render(<BillsPage />);
    await screen.findByTestId("bills-row-inv-1");

    fireEvent.click(screen.getByTestId("bills-pay-inv-1"));

    await waitFor(() => {
      const btn = screen.getByTestId("bills-pay-inv-1");
      expect(btn).toBeDisabled();
      expect(btn).toHaveTextContent("Starting...");
    });
  });
});
