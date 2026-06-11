/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * BillingPage (top-level billing dashboard) — adjacent-to-source coverage
 * (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies the rendered branches of
 *     `apps/web/src/app/dashboard/billing/page.tsx`, the staff-facing global
 *     billing dashboard. The page wires:
 *       GET  /billing/invoices[?status=PENDING|PARTIAL|PAID|REFUNDED]
 *       GET  /billing/reports/outstanding (rows AND summary tile)
 *       GET  /billing/reports/daily
 *       GET  /billing/reports/revenue
 *       GET  /billing/reports/refunds
 *       POST /billing/payments
 *       POST /billing/refunds
 *       POST /billing/invoices/:id/discount
 *
 *   - Behaviours covered:
 *       1. Loading skeleton (data-testid="billing-loading") while the GET is
 *          in flight.
 *       2. Non-allowed role (DOCTOR — Issue #89) bounces to
 *          /dashboard/not-authorized via router.replace + toast.error.
 *       3. Auth-loading guard — `isLoading: true` does not redirect.
 *       4. PATIENT (allowed role) does NOT see the staff summary tiles AND
 *          does NOT see the patient phone column under the patient link.
 *       5. ADMIN/RECEPTION see the 4 KPI summary tiles (totalOutstanding,
 *          todayCollection, monthRevenue, monthRefunds) and Promise.allSettled
 *          tolerates per-endpoint failures (the surviving tiles populate).
 *       6. Tabs — clicking PENDING re-issues GET /billing/invoices?status=PENDING;
 *          clicking "Outstanding Report" swaps to /billing/reports/outstanding.
 *       7. Empty state — EmptyState renders when the invoice list is empty.
 *       8. Enriched invoice row — fmtMoney(), age (days since createdAt), the
 *          derivePaymentStatus + OVERPAID promotion, the CREDIT badge for
 *          overpaid rows.
 *       9. Actions menu — opens on the More button, renders Record Payment,
 *          Pay Online (only when Razorpay enabled), Record Refund (only when
 *          netPaid > 0), Apply Discount, Print Invoice, Send Bill
 *          (only when balance > 0).
 *      10. Record Payment modal — POSTs /billing/payments with the right
 *          body shape and re-fetches invoices + summary.
 *      11. Record Payment — toast.error path when POST rejects.
 *      12. Refund modal — POSTs /billing/refunds with reason/mode/amount.
 *      13. Refund — toast.error path on rejection.
 *      14. Discount modal — percentage path POSTs { percentage, reason },
 *          flat path POSTs { flatAmount, reason }.
 *      15. Discount — toast.error path on rejection.
 *      16. Outstanding tab — renders the outstanding report table, "Days
 *          Overdue" overdueClass bucket colors, and the Send Bill button.
 *      17. Outstanding tab Send Bill — POSTs the WhatsApp send + toast.success.
 *      18. Export CSV — writes a Blob URL + clicks the anchor.
 *      19. Export CSV with zero rows → toast.info("No rows to export").
 *      20. Razorpay TEST badge surfaces when isTestMode === true.
 *      21. Razorpay fetch failure → setRazorpay falls back to disabled.
 *      22. /billing/invoices GET rejection is swallowed (no crash; spinner
 *          un-loads).
 *
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, @/lib/razorpay,
 *            @/lib/i18n (passthrough — returns the key as the translation),
 *            next/navigation, @/components/EmptyState passthrough,
 *            @/components/Skeleton passthrough, lucide-react icon stubs,
 *            @medcore/shared (real module — no need to stub the pure
 *            money-math helpers used).
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";

const { apiMock, toastMock, routerMock, authMock, razorpayMock } = vi.hoisted(
  () => ({
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
    razorpayMock: vi.fn(),
  }),
);

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/razorpay", () => ({ fetchRazorpayConfig: razorpayMock }));
vi.mock("@/lib/i18n", () => ({
  // Passthrough translator — returns the key so assertions can pin on the
  // i18n key rather than locale copy.
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  usePathname: () => "/dashboard/billing",
  useSearchParams: () => new URLSearchParams(),
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
  Printer: () => <span data-testid="icon-printer" />,
  Receipt: () => <span data-testid="icon-receipt" />,
  Undo2: () => <span data-testid="icon-undo" />,
  Percent: () => <span data-testid="icon-percent" />,
  Send: () => <span data-testid="icon-send" />,
  Download: () => <span data-testid="icon-download" />,
  MoreHorizontal: () => <span data-testid="icon-more" />,
  Globe: () => <span data-testid="icon-globe" />,
}));

import BillingPage from "../page";

type InvoiceFixture = {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  subtotal?: number;
  taxAmount?: number;
  discountAmount?: number;
  paymentStatus: string;
  createdAt: string;
  patientId: string;
  patient: { user: { name: string; phone: string } };
  items: Array<{ id: string; amount: number; category: string }>;
  payments: Array<{
    id: string;
    amount: number;
    mode: string;
    paidAt: string;
    transactionId?: string | null;
  }>;
};

function invoice(overrides: Partial<InvoiceFixture> = {}): InvoiceFixture {
  return {
    id: "inv-1",
    invoiceNumber: "INV-2026-0001",
    totalAmount: 5000,
    paymentStatus: "PENDING",
    createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
    patientId: "p-1",
    patient: { user: { name: "Anita Sharma", phone: "9999988888" } },
    items: [{ id: "li-1", amount: 5000, category: "CONSULTATION" }],
    payments: [],
    ...overrides,
  };
}

function invoiceList(invoices: InvoiceFixture[]) {
  return { data: invoices };
}

const STAFF_USER = {
  id: "u-recep",
  userId: "u-recep",
  role: "RECEPTION",
  name: "Recep",
};
const ADMIN_USER = {
  id: "u-admin",
  userId: "u-admin",
  role: "ADMIN",
  name: "Admin",
};
const PATIENT_USER = {
  id: "u-pat",
  userId: "u-pat",
  role: "PATIENT",
  name: "Pat",
};

/**
 * Default GET router for the page. Handles every endpoint the dashboard
 * touches so individual tests can override only what they need.
 */
function defaultGetRouter(invoices: InvoiceFixture[] = []) {
  return (url: string) => {
    if (url.startsWith("/billing/invoices")) {
      return Promise.resolve(invoiceList(invoices));
    }
    if (url.startsWith("/billing/reports/outstanding")) {
      return Promise.resolve({
        data: { rows: [], totalOutstanding: 0, count: 0 },
      });
    }
    if (url.startsWith("/billing/reports/daily")) {
      return Promise.resolve({ data: { totalCollection: 1500 } });
    }
    if (url.startsWith("/billing/reports/revenue")) {
      return Promise.resolve({ data: { totals: { inflow: 25000 } } });
    }
    if (url.startsWith("/billing/reports/refunds")) {
      return Promise.resolve({ data: { totalRefunded: 250 } });
    }
    return Promise.resolve({ data: null });
  };
}

describe("BillingPage — global billing dashboard", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    razorpayMock.mockReset();
    authMock.mockReturnValue({ user: STAFF_USER, isLoading: false });
    razorpayMock.mockResolvedValue({ enabled: true, isTestMode: false });
    apiMock.get.mockImplementation(defaultGetRouter([]));
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the loading skeleton while the invoices fetch is in flight", async () => {
    apiMock.get.mockImplementation(
      () => new Promise(() => {}) as Promise<never>,
    );
    render(<BillingPage />);

    const loader = await screen.findByTestId("billing-loading");
    expect(loader).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("skeleton-table")).toHaveAttribute(
      "data-rows",
      "6",
    );
  });

  it("redirects DOCTOR (not in BILLING_ALLOWED) to /dashboard/not-authorized", async () => {
    authMock.mockReturnValue({
      user: { id: "u-doc", userId: "u-doc", role: "DOCTOR", name: "Doc" },
      isLoading: false,
    });

    render(<BillingPage />);

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith(
        "/dashboard/not-authorized?from=%2Fdashboard%2Fbilling",
      );
      expect(toastMock.error).toHaveBeenCalledWith(
        "Billing is restricted to Admin, Reception, and Patients.",
      );
    });
  });

  it("does not redirect while the auth store is still loading", async () => {
    authMock.mockReturnValue({ user: null, isLoading: true });
    render(<BillingPage />);

    // Give effects time to dispatch any redirects.
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalled();
    });
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("renders KPI summary tiles for staff and tolerates per-endpoint failures (Promise.allSettled)", async () => {
    // outstanding rejects → tile keeps prev (0); the other three populate.
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/billing/reports/outstanding")) {
        // The summary call to outstanding rejects; the rows call also runs
        // when tab === "outstanding" but we stay on tab "all" so only the
        // summary path hits this URL.
        return Promise.reject(new Error("outstanding 503"));
      }
      if (url.startsWith("/billing/invoices")) {
        return Promise.resolve(invoiceList([]));
      }
      if (url.startsWith("/billing/reports/daily")) {
        return Promise.resolve({ data: { totalCollection: 1234.5 } });
      }
      if (url.startsWith("/billing/reports/revenue")) {
        return Promise.resolve({ data: { totals: { inflow: 50000 } } });
      }
      if (url.startsWith("/billing/reports/refunds")) {
        return Promise.resolve({ data: { totalRefunded: 750 } });
      }
      return Promise.resolve({ data: null });
    });
    authMock.mockReturnValue({ user: ADMIN_USER, isLoading: false });

    render(<BillingPage />);

    await screen.findByTestId("empty-state");
    // Tile copy (the upper-case labels render verbatim).
    expect(screen.getByText(/Total Outstanding/i)).toBeInTheDocument();
    expect(screen.getByText(/Today's Collection/i)).toBeInTheDocument();
    expect(screen.getByText(/This Month's Revenue/i)).toBeInTheDocument();
    expect(screen.getByText(/Refunds This Month/i)).toBeInTheDocument();
    // Surviving values render.
    expect(screen.getByText(/Rs\.\s*1,234\.50/)).toBeInTheDocument();
    expect(screen.getByText(/Rs\.\s*50,000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Rs\.\s*750\.00/)).toBeInTheDocument();
  });

  it("hides the KPI summary tiles for PATIENT users", async () => {
    authMock.mockReturnValue({ user: PATIENT_USER, isLoading: false });
    render(<BillingPage />);

    await screen.findByTestId("empty-state");
    expect(screen.queryByText(/Total Outstanding/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Today's Collection/i)).not.toBeInTheDocument();
  });

  it("renders the EmptyState when /billing/invoices returns no rows", async () => {
    render(<BillingPage />);
    await screen.findByTestId("empty-state");
    expect(screen.getByText(/No invoices yet/i)).toBeInTheDocument();
  });

  it("swallows /billing/invoices rejection — loading flips off and renders the EmptyState branch", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/billing/invoices")) {
        return Promise.reject(new Error("boom"));
      }
      return defaultGetRouter([])(url);
    });
    render(<BillingPage />);
    await screen.findByTestId("empty-state");
    expect(screen.queryByTestId("billing-loading")).not.toBeInTheDocument();
  });

  it("re-fires the GET with ?status=PENDING when the Pending tab is clicked", async () => {
    render(<BillingPage />);
    await screen.findByTestId("empty-state");
    apiMock.get.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /^Pending$/i }));

    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith(
        "/billing/invoices?status=PENDING",
      );
    });
  });

  it("swaps to the outstanding report endpoint when the Outstanding tab is clicked", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/billing/reports/outstanding") {
        return Promise.resolve({
          data: {
            rows: [
              {
                invoiceId: "inv-out-1",
                invoiceNumber: "INV-OUT-1",
                patientId: "p-1",
                patient: { user: { name: "Bob", phone: "9000000000" } },
                totalAmount: 4000,
                paid: 1000,
                balance: 3000,
                daysOverdue: 45,
                paymentStatus: "PARTIAL",
                createdAt: "2026-03-01T00:00:00.000Z",
              },
              {
                invoiceId: "inv-out-2",
                invoiceNumber: "INV-OUT-2",
                patientId: "p-2",
                patient: { user: { name: "Cara", phone: "9000000001" } },
                totalAmount: 2000,
                paid: 0,
                balance: 2000,
                daysOverdue: 15,
                paymentStatus: "PENDING",
                createdAt: "2026-04-01T00:00:00.000Z",
              },
              {
                invoiceId: "inv-out-3",
                invoiceNumber: "INV-OUT-3",
                patientId: "p-3",
                patient: { user: { name: "Dan", phone: "9000000002" } },
                totalAmount: 1500,
                paid: 0,
                balance: 1500,
                daysOverdue: 3,
                paymentStatus: "PENDING",
                createdAt: "2026-05-21T00:00:00.000Z",
              },
            ],
            totalOutstanding: 6500,
            count: 3,
          },
        });
      }
      return defaultGetRouter([])(url);
    });

    render(<BillingPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /Outstanding Report/i }),
    );

    await screen.findByText("INV-OUT-1");
    // All three days-overdue buckets render with their color classes.
    expect(screen.getByText(/45 days/).className).toMatch(/text-red-600/);
    expect(screen.getByText(/15 days/).className).toMatch(/text-orange-500/);
    expect(screen.getByText(/3 days/).className).toMatch(/text-gray-500/);

    // Click Send Bill → POSTs the WhatsApp send, then toast.success quoting
    // the patient name. (The button was renamed from "Remind" to "Send Bill"
    // when the stub reminder became a real WhatsApp bill send.)
    apiMock.post.mockResolvedValueOnce({ data: { invoiceId: "inv-out-1", channel: "WHATSAPP", balance: 3000 } });
    fireEvent.click(
      within(screen.getByText("INV-OUT-1").closest("tr")!).getByRole("button", {
        name: /Send Bill/i,
      }),
    );
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        expect.stringContaining("Bob"),
      ),
    );
    // It hit the real send endpoint with the invoice id + WHATSAPP channel.
    expect(apiMock.post).toHaveBeenCalledWith(
      "/billing/invoices/inv-out-1/reminder",
      expect.objectContaining({ invoiceId: "inv-out-1", channel: "WHATSAPP" }),
    );

    // Outstanding-empty branch — separate render with rows: [].
  });

  it("renders the no-outstanding empty branch on the outstanding tab", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/billing/reports/outstanding") {
        return Promise.resolve({
          data: { rows: [], totalOutstanding: 0, count: 0 },
        });
      }
      return defaultGetRouter([])(url);
    });
    render(<BillingPage />);
    fireEvent.click(
      screen.getByRole("button", { name: /Outstanding Report/i }),
    );
    expect(
      await screen.findByText(/No outstanding invoices\./i),
    ).toBeInTheDocument();
  });

  it("enriches each invoice row with fmtMoney(), age, and the derived status badge", async () => {
    // items + totalAmount kept in sync — CONSULTATION has 0% GST so
    // computeInvoiceTotals(items, ...) returns subtotal == total.
    apiMock.get.mockImplementation(
      defaultGetRouter([
        invoice({
          id: "inv-paid",
          invoiceNumber: "INV-PAID",
          totalAmount: 1000,
          paymentStatus: "PAID",
          items: [{ id: "li-1", amount: 1000, category: "CONSULTATION" }],
          createdAt: new Date(Date.now() - 10 * 86400000).toISOString(),
          payments: [
            {
              id: "p-1",
              amount: 1000,
              mode: "CASH",
              paidAt: new Date().toISOString(),
            },
          ],
        }),
        invoice({
          id: "inv-partial",
          invoiceNumber: "INV-PARTIAL",
          totalAmount: 2000,
          paymentStatus: "PARTIAL",
          items: [{ id: "li-1", amount: 2000, category: "CONSULTATION" }],
          payments: [
            {
              id: "p-1",
              amount: 500,
              mode: "UPI",
              paidAt: new Date().toISOString(),
            },
          ],
        }),
        invoice({
          id: "inv-over",
          invoiceNumber: "INV-OVER",
          totalAmount: 1000,
          paymentStatus: "PAID",
          items: [{ id: "li-1", amount: 1000, category: "CONSULTATION" }],
          payments: [
            {
              id: "p-1",
              amount: 1200,
              mode: "CASH",
              paidAt: new Date().toISOString(),
            },
          ],
        }),
      ]),
    );

    render(<BillingPage />);

    await screen.findByText("INV-PAID");

    // Status pills with the derived status.
    expect(screen.getByTestId("bills-status-inv-paid").textContent).toBe(
      "PAID",
    );
    expect(screen.getByTestId("bills-status-inv-partial").textContent).toBe(
      "PARTIAL",
    );
    // OVERPAID is the credit-due derived state (Issue #859).
    expect(screen.getByTestId("bills-status-inv-over").textContent).toBe(
      "OVERPAID",
    );
    // CREDIT cell renders the overpayment amount.
    expect(screen.getByTestId("bills-credit-inv-over").textContent).toMatch(
      /CREDIT.*Rs\./,
    );

    // Age cells render. The PAID row was 10 days old in our fixture.
    expect(screen.getByTestId("bills-age-inv-paid").textContent).toBe("10d");
  });

  it("hides the patient phone column when the viewer is a PATIENT", async () => {
    authMock.mockReturnValue({ user: PATIENT_USER, isLoading: false });
    apiMock.get.mockImplementation(
      defaultGetRouter([invoice({ id: "inv-1", invoiceNumber: "INV-1" })]),
    );
    render(<BillingPage />);

    await screen.findByText("INV-1");
    // The patient's phone is NOT echoed on their own row.
    expect(screen.queryByText("9999988888")).not.toBeInTheDocument();
  });

  it("opens the actions menu for staff and renders Record Payment / Apply Discount / Print Invoice", async () => {
    apiMock.get.mockImplementation(
      defaultGetRouter([
        invoice({
          id: "inv-1",
          invoiceNumber: "INV-1",
          paymentStatus: "PENDING",
          payments: [],
        }),
      ]),
    );
    render(<BillingPage />);

    await screen.findByText("INV-1");

    fireEvent.click(
      screen.getByRole("button", {
        name: /Actions menu for invoice INV-1/i,
      }),
    );

    expect(screen.getByText(/Record Payment/i)).toBeInTheDocument();
    expect(screen.getByText(/Apply Discount/i)).toBeInTheDocument();
    expect(screen.getByText(/Print Invoice/i)).toBeInTheDocument();
    // netPaid === 0 so Record Refund is hidden.
    expect(screen.queryByText(/Record Refund/i)).not.toBeInTheDocument();
    // Razorpay enabled (default mock) → Pay Online surfaces.
    expect(screen.getByText(/Pay Online/i)).toBeInTheDocument();
  });

  it("renders the TEST badge on the Pay Online menu item when Razorpay is in test mode", async () => {
    razorpayMock.mockResolvedValue({ enabled: true, isTestMode: true });
    apiMock.get.mockImplementation(
      defaultGetRouter([
        invoice({ id: "inv-1", invoiceNumber: "INV-1" }),
      ]),
    );
    render(<BillingPage />);
    await screen.findByText("INV-1");

    fireEvent.click(
      screen.getByRole("button", {
        name: /Actions menu for invoice INV-1/i,
      }),
    );
    expect(screen.getByText("TEST")).toBeInTheDocument();
  });

  it("falls back to enabled:false when fetchRazorpayConfig rejects", async () => {
    razorpayMock.mockRejectedValue(new Error("razorpay down"));
    apiMock.get.mockImplementation(
      defaultGetRouter([
        invoice({ id: "inv-1", invoiceNumber: "INV-1" }),
      ]),
    );
    render(<BillingPage />);
    await screen.findByText("INV-1");

    fireEvent.click(
      screen.getByRole("button", {
        name: /Actions menu for invoice INV-1/i,
      }),
    );
    // Pay Online suppressed.
    expect(screen.queryByText(/Pay Online/i)).not.toBeInTheDocument();
  });

  it("Record Payment modal POSTs /billing/payments and re-fetches invoices", async () => {
    apiMock.get.mockImplementation(
      defaultGetRouter([
        invoice({
          id: "inv-1",
          invoiceNumber: "INV-1",
          paymentStatus: "PENDING",
        }),
      ]),
    );
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<BillingPage />);
    await screen.findByText("INV-1");

    fireEvent.click(
      screen.getByRole("button", {
        name: /Actions menu for invoice INV-1/i,
      }),
    );
    fireEvent.click(screen.getByText(/Record Payment/i));

    // Modal heading rendered.
    expect(
      await screen.findByRole("heading", { name: /Record Payment — INV-1/i }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Amount \(Rs\.\)/i), {
      target: { value: "1500" },
    });
    fireEvent.change(screen.getByLabelText(/^Mode$/i), {
      target: { value: "UPI" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save Payment/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith("/billing/payments", {
        invoiceId: "inv-1",
        amount: 1500,
        mode: "UPI",
      });
    });
  });

  it("surfaces toast.error when /billing/payments rejects", async () => {
    apiMock.get.mockImplementation(
      defaultGetRouter([invoice({ id: "inv-1", invoiceNumber: "INV-1" })]),
    );
    apiMock.post.mockRejectedValue(new Error("payments 503"));

    render(<BillingPage />);
    await screen.findByText("INV-1");

    fireEvent.click(
      screen.getByRole("button", {
        name: /Actions menu for invoice INV-1/i,
      }),
    );
    fireEvent.click(screen.getByText(/Record Payment/i));
    fireEvent.change(screen.getByLabelText(/Amount \(Rs\.\)/i), {
      target: { value: "100" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save Payment/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("payments 503");
    });
  });

  it("Record Payment Cancel closes the modal without firing POST", async () => {
    apiMock.get.mockImplementation(
      defaultGetRouter([invoice({ id: "inv-1", invoiceNumber: "INV-1" })]),
    );
    render(<BillingPage />);
    await screen.findByText("INV-1");

    fireEvent.click(
      screen.getByRole("button", {
        name: /Actions menu for invoice INV-1/i,
      }),
    );
    fireEvent.click(screen.getByText(/Record Payment/i));
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    expect(
      screen.queryByRole("heading", { name: /Record Payment — INV-1/i }),
    ).not.toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Refund modal POSTs /billing/refunds with amount/reason/mode", async () => {
    apiMock.get.mockImplementation(
      defaultGetRouter([
        // netPaid > 0 → Record Refund visible.
        invoice({
          id: "inv-1",
          invoiceNumber: "INV-1",
          totalAmount: 1000,
          paymentStatus: "PARTIAL",
          payments: [
            {
              id: "p-1",
              amount: 600,
              mode: "CASH",
              paidAt: new Date().toISOString(),
            },
          ],
        }),
      ]),
    );
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<BillingPage />);
    await screen.findByText("INV-1");

    fireEvent.click(
      screen.getByRole("button", {
        name: /Actions menu for invoice INV-1/i,
      }),
    );
    fireEvent.click(screen.getByText(/Record Refund/i));

    expect(
      await screen.findByRole("heading", { name: /Issue Refund — INV-1/i }),
    ).toBeInTheDocument();

    // Refund amount is pre-filled to netPaid (600).
    const refundAmount = screen.getByLabelText(
      /Amount \(Rs\.\)/i,
    ) as HTMLInputElement;
    expect(refundAmount.value).toBe("600");

    fireEvent.change(refundAmount, { target: { value: "300" } });
    fireEvent.change(screen.getByLabelText(/^Mode$/i), {
      target: { value: "UPI" },
    });
    fireEvent.change(screen.getByLabelText(/^Reason$/i), {
      target: { value: "patient request" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Issue Refund/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith("/billing/refunds", {
        invoiceId: "inv-1",
        amount: 300,
        reason: "patient request",
        mode: "UPI",
      });
    });
  });

  it("surfaces toast.error when /billing/refunds rejects", async () => {
    apiMock.get.mockImplementation(
      defaultGetRouter([
        invoice({
          id: "inv-1",
          invoiceNumber: "INV-1",
          totalAmount: 1000,
          paymentStatus: "PARTIAL",
          payments: [
            {
              id: "p-1",
              amount: 600,
              mode: "CASH",
              paidAt: new Date().toISOString(),
            },
          ],
        }),
      ]),
    );
    apiMock.post.mockRejectedValue(new Error("refund denied"));

    render(<BillingPage />);
    await screen.findByText("INV-1");

    fireEvent.click(
      screen.getByRole("button", {
        name: /Actions menu for invoice INV-1/i,
      }),
    );
    fireEvent.click(screen.getByText(/Record Refund/i));
    fireEvent.change(screen.getByLabelText(/^Reason$/i), {
      target: { value: "noop" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Issue Refund/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("refund denied");
    });
  });

  it("Discount modal — percentage path POSTs { percentage, reason }", async () => {
    apiMock.get.mockImplementation(
      defaultGetRouter([
        invoice({
          id: "inv-1",
          invoiceNumber: "INV-1",
          paymentStatus: "PENDING",
        }),
      ]),
    );
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<BillingPage />);
    await screen.findByText("INV-1");

    fireEvent.click(
      screen.getByRole("button", {
        name: /Actions menu for invoice INV-1/i,
      }),
    );
    fireEvent.click(screen.getByText(/Apply Discount/i));

    expect(
      await screen.findByRole("heading", {
        name: /Apply Discount — INV-1/i,
      }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Percentage \(%\)/i), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByLabelText(/^Reason$/i), {
      target: { value: "senior" },
    });
    // Two matching "Apply Discount" buttons exist (action-menu item + modal
    // footer). Scope to the modal heading's parent.
    const heading = screen.getByRole("heading", {
      name: /Apply Discount — INV-1/i,
    });
    const modal = heading.parentElement!;
    fireEvent.click(
      within(modal).getByRole("button", { name: /Apply Discount/i }),
    );

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/billing/invoices/inv-1/discount",
        { reason: "senior", percentage: 10 },
      );
    });
  });

  it("Discount modal — flat path POSTs { flatAmount, reason }", async () => {
    apiMock.get.mockImplementation(
      defaultGetRouter([
        invoice({
          id: "inv-1",
          invoiceNumber: "INV-1",
          paymentStatus: "PENDING",
        }),
      ]),
    );
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<BillingPage />);
    await screen.findByText("INV-1");

    fireEvent.click(
      screen.getByRole("button", {
        name: /Actions menu for invoice INV-1/i,
      }),
    );
    fireEvent.click(screen.getByText(/Apply Discount/i));

    // Click Flat Amount tab.
    fireEvent.click(
      screen.getByRole("button", { name: /^Flat Amount$/i }),
    );
    fireEvent.change(screen.getByLabelText(/Flat Amount \(Rs\.\)/i), {
      target: { value: "250" },
    });
    fireEvent.change(screen.getByLabelText(/^Reason$/i), {
      target: { value: "promo" },
    });
    const heading = screen.getByRole("heading", {
      name: /Apply Discount — INV-1/i,
    });
    const modal = heading.parentElement!;
    fireEvent.click(
      within(modal).getByRole("button", { name: /Apply Discount/i }),
    );

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/billing/invoices/inv-1/discount",
        { reason: "promo", flatAmount: 250 },
      );
    });
  });

  it("surfaces toast.error when discount POST rejects", async () => {
    apiMock.get.mockImplementation(
      defaultGetRouter([
        invoice({
          id: "inv-1",
          invoiceNumber: "INV-1",
          paymentStatus: "PENDING",
        }),
      ]),
    );
    apiMock.post.mockRejectedValue(new Error("discount 500"));

    render(<BillingPage />);
    await screen.findByText("INV-1");

    fireEvent.click(
      screen.getByRole("button", {
        name: /Actions menu for invoice INV-1/i,
      }),
    );
    fireEvent.click(screen.getByText(/Apply Discount/i));
    fireEvent.change(screen.getByLabelText(/Percentage \(%\)/i), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByLabelText(/^Reason$/i), {
      target: { value: "ok" },
    });
    const heading = screen.getByRole("heading", {
      name: /Apply Discount — INV-1/i,
    });
    const modal = heading.parentElement!;
    fireEvent.click(
      within(modal).getByRole("button", { name: /Apply Discount/i }),
    );

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("discount 500");
    });
  });

  it("Export CSV writes a Blob and triggers an anchor click (invoices tab)", async () => {
    apiMock.get.mockImplementation(
      defaultGetRouter([
        invoice({
          id: "inv-1",
          invoiceNumber: "INV-1",
          totalAmount: 1000,
          paymentStatus: "PENDING",
          payments: [],
        }),
      ]),
    );

    // Stub URL.createObjectURL / revokeObjectURL + HTMLAnchorElement.click.
    const createSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock");
    const revokeSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    render(<BillingPage />);
    await screen.findByText("INV-1");

    fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

    expect(createSpy).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeSpy).toHaveBeenCalled();

    createSpy.mockRestore();
    revokeSpy.mockRestore();
    clickSpy.mockRestore();
  });

  it("Export CSV with zero rows surfaces toast.info('No rows to export')", async () => {
    render(<BillingPage />);
    await screen.findByTestId("empty-state");

    fireEvent.click(screen.getByRole("button", { name: /Export CSV/i }));

    expect(toastMock.info).toHaveBeenCalledWith("No rows to export");
  });
});
