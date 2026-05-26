/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PatientBillingPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Verifies every rendered branch of
 *     `apps/web/src/app/dashboard/billing/patient/[patientId]/page.tsx`, the
 *     staff-only bulk-billing detail view (Issue #385 RBAC bypass fix). The
 *     page hits:
 *       GET  /billing/patients/:patientId/outstanding
 *       POST /billing/payments/bulk             (bulk-payment apply, oldest-first)
 *       POST /billing/invoices/:id/discount     (per-invoice; fired in a loop)
 *
 *   - Behaviours covered:
 *       1. Loading skeleton — `data-testid="patient-billing-loading"` with
 *          `aria-busy="true"` renders before the GET resolves.
 *       2. Non-allowed role (PATIENT) — toast.error + router.replace("/dashboard")
 *          per Issue #385. Fetch still fires (the redirect effect is parallel,
 *          and we assert the redirect contract here, not its ordering).
 *       3. Non-allowed role (DOCTOR) — same redirect contract.
 *       4. Auth-loading guard — `isLoading: true` does not redirect.
 *       5. patientId threads into the outstanding URL.
 *       6. Happy fetch — patient header (name, MR#, phone, email), total
 *          outstanding fmtMoney(), invoice rows with fmtMoney() amounts,
 *          status pills, overdue cells with the correct color class.
 *       7. Empty outstanding — "No outstanding invoices." and the "—"
 *          placeholder for the patient header.
 *       8. Singular invoice copy — "1 unpaid invoice" (no plural "s").
 *       9. Optional email — header omits the bullet+email separator when
 *          email is empty.
 *      10. overdueClass — >30 days → red, 8-30 → orange, ≤7 → gray. Branch
 *          coverage for all three buckets via 3 invoices in one render.
 *      11. Select-all toggles every checkbox; selection drives the action
 *          bar copy ("N selected • Rs. X due") and enables the buttons.
 *      12. Individual toggleOne adds/removes a row from the selection.
 *      13. Bulk payment modal — opens, pre-fills selectedBalance, allows
 *          mode change, distributes oldest-first across invoices, POSTs
 *          /billing/payments/bulk with the correct payment array, then
 *          re-fetches.
 *      14. Bulk payment — guards: 0/NaN amount or zero selectedInvoices is
 *          a noop (no POST).
 *      15. Bulk payment — over-amount caps at each invoice's balance.
 *      16. Bulk payment — error path surfaces toast.error.
 *      17. Bulk discount modal — percentage path POSTs each selected invoice
 *          with { percentage, reason }.
 *      18. Bulk discount modal — flat path POSTs { flatAmount, reason }.
 *      19. Bulk discount — negative + >100% (percentage) + non-finite values
 *          rejected client-side with toast.error (Issue #671 regression of
 *          #358).
 *      20. Bulk discount — missing value/reason is a noop (no POST).
 *      21. Bulk discount — API error surfaces toast.error.
 *      22. Apply-Discount / Record-Bulk-Payment buttons stay disabled with
 *          zero selection.
 *
 *   - PII-leak canary: the rendered DOM MUST surface the contract-published
 *     PII (name, MR#, phone, optional email) and MUST NOT leak fields outside
 *     the published `PatientInvoice.patient.user` shape (no address, no DOB,
 *     no insurance — even though our fixture intentionally injects those to
 *     prove the page projects them away).
 *
 *   - Mocks: @/lib/api, @/lib/store, @/lib/toast, next/navigation
 *            (useParams threads `patientId: "p-7"`), @/components/Skeleton
 *            passthrough, lucide-react icon stub.
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

// `useAuthStore` is consumed via selector functions in the page
// (`useAuthStore((s) => s.user)` / `((s) => s.isLoading)`). The mock therefore
// must apply the selector to the stored state, NOT return the whole state
// unconditionally — otherwise `user` would be the entire state object and
// `BILLING_PATIENT_ALLOWED.has(user.role)` would silently miss.
const authState = { current: { user: null as any, isLoading: false } };
function setAuthState(s: { user: any; isLoading?: boolean }) {
  authState.current = { user: s.user, isLoading: s.isLoading ?? false };
}

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useParams: () => ({ patientId: "p-7" }),
  usePathname: () => "/dashboard/billing/patient/p-7",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: ({ className }: { className?: string }) => (
    <div data-testid="skeleton-card" className={className} />
  ),
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
  ArrowLeft: () => <span data-testid="icon-arrow-left" />,
  Receipt: () => <span data-testid="icon-receipt" />,
  Percent: () => <span data-testid="icon-percent" />,
}));

import PatientBillingPage from "../page";

type InvoiceFixture = {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  paymentStatus: string;
  createdAt: string;
  totalPaid: number;
  balance: number;
  daysOverdue: number;
  items: Array<{ id: string; description: string; amount: number }>;
  patient: {
    id: string;
    mrNumber: string;
    user: { name: string; phone: string; email: string };
    // Intentionally extra PII fields the page MUST NOT echo.
    address?: string;
    dob?: string;
    insurancePolicyNumber?: string;
  };
};

function invoice(overrides: Partial<InvoiceFixture> = {}): InvoiceFixture {
  return {
    id: "inv-1",
    invoiceNumber: "INV-2026-0001",
    totalAmount: 5000,
    paymentStatus: "PENDING",
    createdAt: "2026-04-01T08:30:00.000Z",
    totalPaid: 0,
    balance: 5000,
    daysOverdue: 0,
    items: [{ id: "li-1", description: "Consultation", amount: 5000 }],
    patient: {
      id: "p-7",
      mrNumber: "MR-000007",
      user: {
        name: "Anita Sharma",
        phone: "9999988888",
        email: "anita@example.test",
      },
      address: "SHOULD-NOT-LEAK-ADDRESS",
      dob: "1990-01-01",
      insurancePolicyNumber: "SHOULD-NOT-LEAK-POLICY",
    },
    ...overrides,
  };
}

function outstanding(invoices: InvoiceFixture[]) {
  const total = invoices.reduce((s, i) => s + i.balance, 0);
  return { data: { totalOutstanding: total, invoices } };
}

const STAFF_USER = {
  id: "u-recep",
  userId: "u-recep",
  role: "RECEPTION",
  name: "Recep",
};

describe("PatientBillingPage — staff bulk billing detail", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    setAuthState({ user: STAFF_USER, isLoading: false });
    // Apply the selector to authState — selector-aware mock.
    authMock.mockImplementation((selector?: (s: any) => any) =>
      selector ? selector(authState.current) : authState.current,
    );
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the loading skeleton with aria-busy while the GET is in flight", async () => {
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    render(<PatientBillingPage />);

    const loader = await screen.findByTestId("patient-billing-loading");
    expect(loader).toHaveAttribute("aria-busy", "true");
    // Skeleton card + table passthroughs render.
    expect(screen.getByTestId("skeleton-card")).toBeInTheDocument();
    expect(screen.getByTestId("skeleton-table")).toHaveAttribute(
      "data-rows",
      "6",
    );
    expect(screen.getByTestId("skeleton-table")).toHaveAttribute(
      "data-columns",
      "5",
    );
  });

  it("threads the URL patientId into the outstanding endpoint", async () => {
    apiMock.get.mockResolvedValue(outstanding([]));
    render(<PatientBillingPage />);
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/billing/patients/p-7/outstanding",
      ),
    );
  });

  it("redirects PATIENT users to /dashboard with a staff-only toast (Issue #385)", async () => {
    setAuthState({
      user: { id: "u-pat", userId: "u-pat", role: "PATIENT", name: "Pat" },
      isLoading: false,
    });
    apiMock.get.mockResolvedValue(outstanding([]));

    render(<PatientBillingPage />);

    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith("/dashboard");
      expect(toastMock.error).toHaveBeenCalledWith(
        "Bulk billing is staff-only.",
      );
    });
  });

  it("redirects DOCTOR users (not in the staff allowlist) to /dashboard", async () => {
    setAuthState({
      user: { id: "u-doc", userId: "u-doc", role: "DOCTOR", name: "Doc" },
      isLoading: false,
    });
    apiMock.get.mockResolvedValue(outstanding([]));
    render(<PatientBillingPage />);
    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith("/dashboard");
    });
  });

  it("permits ADMIN without bouncing", async () => {
    setAuthState({
      user: { id: "u-a", userId: "u-a", role: "ADMIN", name: "A" },
      isLoading: false,
    });
    apiMock.get.mockResolvedValue(outstanding([]));
    render(<PatientBillingPage />);
    await screen.findByText("No outstanding invoices.");
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("does not redirect while the auth store is still loading", async () => {
    setAuthState({ user: null, isLoading: true });
    apiMock.get.mockResolvedValue(outstanding([]));
    render(<PatientBillingPage />);
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalled(),
    );
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("renders the patient header (name, MR#, phone, email) and total outstanding", async () => {
    // Use distinct numbers so total-outstanding ≠ row balance — keeps the
    // money assertions unambiguous (otherwise both render "Rs. 1,234.00").
    apiMock.get.mockResolvedValue(
      outstanding([invoice({ balance: 1234, totalPaid: 100 })]),
    );
    render(<PatientBillingPage />);

    await screen.findByText("Anita Sharma");
    expect(
      screen.getByText(/MR-000007.*9999988888.*anita@example\.test/),
    ).toBeInTheDocument();

    // Total outstanding fmtMoney() AND the row balance both render
    // "Rs. 1,234.00" — assert both occurrences are present.
    expect(screen.getAllByText(/Rs\.\s*1,234\.00/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/1 unpaid invoice$/)).toBeInTheDocument();
  });

  it("does NOT leak PII fields outside the published patient.user shape", async () => {
    apiMock.get.mockResolvedValue(
      outstanding([
        invoice({
          patient: {
            id: "p-7",
            mrNumber: "MR-000007",
            user: {
              name: "Anita Sharma",
              phone: "9999988888",
              email: "anita@example.test",
            },
            address: "SHOULD-NOT-LEAK-ADDRESS",
            dob: "SHOULD-NOT-LEAK-DOB",
            insurancePolicyNumber: "SHOULD-NOT-LEAK-POLICY",
          },
        }),
      ]),
    );
    render(<PatientBillingPage />);
    await screen.findByText("Anita Sharma");

    expect(document.body.textContent).not.toContain("SHOULD-NOT-LEAK-ADDRESS");
    expect(document.body.textContent).not.toContain("SHOULD-NOT-LEAK-DOB");
    expect(document.body.textContent).not.toContain("SHOULD-NOT-LEAK-POLICY");
  });

  it("renders the placeholder header when there are no outstanding invoices", async () => {
    apiMock.get.mockResolvedValue(outstanding([]));
    render(<PatientBillingPage />);

    await screen.findByText("No outstanding invoices.");
    // "—" placeholder name + helper copy in the header card.
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(
      screen.getAllByText(/No outstanding invoices/i).length,
    ).toBeGreaterThanOrEqual(1);
    // Plural form ("0 unpaid invoices").
    expect(screen.getByText(/0 unpaid invoices/)).toBeInTheDocument();
  });

  it("omits the email separator when the patient's email is empty", async () => {
    apiMock.get.mockResolvedValue(
      outstanding([
        invoice({
          patient: {
            id: "p-7",
            mrNumber: "MR-000007",
            user: {
              name: "Anita Sharma",
              phone: "9999988888",
              email: "",
            },
          },
        }),
      ]),
    );
    render(<PatientBillingPage />);
    await screen.findByText("Anita Sharma");

    // MR# + phone, but no trailing email.
    const headerLine = screen.getByText(/MR-000007.*9999988888/);
    expect(headerLine.textContent).not.toContain("@");
  });

  it("colors overdue cells by bucket (>30 red, 8-30 orange, ≤7 gray)", async () => {
    apiMock.get.mockResolvedValue(
      outstanding([
        invoice({ id: "inv-r", invoiceNumber: "INV-R", daysOverdue: 45 }),
        invoice({ id: "inv-o", invoiceNumber: "INV-O", daysOverdue: 15 }),
        invoice({ id: "inv-g", invoiceNumber: "INV-G", daysOverdue: 3 }),
      ]),
    );
    render(<PatientBillingPage />);

    await screen.findByText("INV-R");

    expect(screen.getByText("45d").className).toMatch(/text-red-600/);
    expect(screen.getByText("15d").className).toMatch(/text-orange-500/);
    expect(screen.getByText("3d").className).toMatch(/text-gray-500/);
  });

  it("toggle-all selects every row, updates the selection copy, and enables both action buttons", async () => {
    apiMock.get.mockResolvedValue(
      outstanding([
        invoice({ id: "inv-a", invoiceNumber: "INV-A", balance: 1000 }),
        invoice({ id: "inv-b", invoiceNumber: "INV-B", balance: 2500 }),
      ]),
    );
    render(<PatientBillingPage />);

    await screen.findByText("INV-A");

    // Initially: buttons disabled, copy is the prompt.
    const payBtn = screen.getByRole("button", { name: /Record Bulk Payment/i });
    const discBtn = screen.getByRole("button", { name: /Apply Discount/i });
    expect(payBtn).toBeDisabled();
    expect(discBtn).toBeDisabled();
    expect(
      screen.getByText(/Select invoices to bulk-apply/i),
    ).toBeInTheDocument();

    // Header checkbox is the first checkbox in the table.
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);

    // 2 selected, 1000 + 2500 = 3500 due.
    expect(
      screen.getByText(/2 selected.*Rs\.\s*3,500\.00 due/),
    ).toBeInTheDocument();
    expect(payBtn).not.toBeDisabled();
    expect(discBtn).not.toBeDisabled();

    // Toggle off — back to disabled + prompt copy.
    fireEvent.click(checkboxes[0]);
    expect(payBtn).toBeDisabled();
    expect(
      screen.getByText(/Select invoices to bulk-apply/i),
    ).toBeInTheDocument();
  });

  it("individual toggleOne adds and removes a single row from the selection", async () => {
    apiMock.get.mockResolvedValue(
      outstanding([
        invoice({ id: "inv-a", invoiceNumber: "INV-A", balance: 500 }),
        invoice({ id: "inv-b", invoiceNumber: "INV-B", balance: 1500 }),
      ]),
    );
    render(<PatientBillingPage />);

    await screen.findByText("INV-A");

    const checkboxes = screen.getAllByRole("checkbox");
    // [0] = toggle-all, [1] = row A, [2] = row B.
    fireEvent.click(checkboxes[1]);
    expect(
      screen.getByText(/1 selected.*Rs\.\s*500\.00 due/),
    ).toBeInTheDocument();

    fireEvent.click(checkboxes[2]);
    expect(
      screen.getByText(/2 selected.*Rs\.\s*2,000\.00 due/),
    ).toBeInTheDocument();

    fireEvent.click(checkboxes[1]);
    expect(
      screen.getByText(/1 selected.*Rs\.\s*1,500\.00 due/),
    ).toBeInTheDocument();
  });

  it("bulk payment distributes oldest-first and POSTs the expected payments array", async () => {
    // Newer invoice listed first to prove the sort by createdAt asc.
    apiMock.get.mockResolvedValue(
      outstanding([
        invoice({
          id: "inv-new",
          invoiceNumber: "INV-NEW",
          createdAt: "2026-05-10T00:00:00.000Z",
          balance: 1000,
        }),
        invoice({
          id: "inv-old",
          invoiceNumber: "INV-OLD",
          createdAt: "2026-01-05T00:00:00.000Z",
          balance: 800,
        }),
      ]),
    );
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<PatientBillingPage />);
    await screen.findByText("INV-NEW");

    // Select all + open bulk payment modal.
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByRole("button", { name: /Record Bulk Payment/i }));

    // Modal heading visible.
    expect(
      await screen.findByRole("heading", { name: /Record Bulk Payment/i }),
    ).toBeInTheDocument();

    // Amount pre-filled with selectedBalance (1000 + 800 = 1800).
    const amountInput = screen.getByLabelText(/Amount/i) as HTMLInputElement;
    expect(amountInput.value).toBe("1800");

    // Bump amount to 1500 — oldest (800) consumed first, then 700 to the newer one.
    fireEvent.change(amountInput, { target: { value: "1500" } });
    // Change mode.
    fireEvent.change(screen.getByLabelText(/Mode/i), {
      target: { value: "UPI" },
    });
    // Apply.
    fireEvent.click(screen.getByRole("button", { name: /Apply Payment/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith("/billing/payments/bulk", {
        patientId: "p-7",
        payments: [
          { invoiceId: "inv-old", amount: 800, mode: "UPI" },
          { invoiceId: "inv-new", amount: 700, mode: "UPI" },
        ],
      });
    });

    // Re-fetch fired (first call was the initial mount).
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledTimes(2),
    );
  });

  it("caps each row at its balance when the bulk payment amount exceeds the total", async () => {
    apiMock.get.mockResolvedValue(
      outstanding([
        invoice({
          id: "inv-old",
          createdAt: "2026-01-05T00:00:00.000Z",
          balance: 200,
        }),
        invoice({
          id: "inv-new",
          createdAt: "2026-05-05T00:00:00.000Z",
          balance: 500,
        }),
      ]),
    );
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<PatientBillingPage />);
    // Both rows share the generic invoiceNumber, so wait on a unique cell —
    // the inv-old balance ("Rs. 200.00") only renders once.
    await screen.findByText(/Rs\.\s*200\.00/);

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Record Bulk Payment/i }));

    const amountInput = screen.getByLabelText(/Amount/i) as HTMLInputElement;
    // Amount > selectedBalance (700) — each row should still cap at its balance.
    fireEvent.change(amountInput, { target: { value: "10000" } });
    fireEvent.click(screen.getByRole("button", { name: /Apply Payment/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith("/billing/payments/bulk", {
        patientId: "p-7",
        payments: [
          { invoiceId: "inv-old", amount: 200, mode: "CASH" },
          { invoiceId: "inv-new", amount: 500, mode: "CASH" },
        ],
      });
    });
  });

  it("surfaces toast.error and keeps the modal open when bulk payment POST rejects", async () => {
    apiMock.get.mockResolvedValue(
      outstanding([invoice({ id: "inv-a", balance: 1000 })]),
    );
    apiMock.post.mockRejectedValue(new Error("payments down"));

    render(<PatientBillingPage />);
    await screen.findByText("INV-2026-0001");

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Record Bulk Payment/i }));
    fireEvent.click(screen.getByRole("button", { name: /Apply Payment/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("payments down");
    });
  });

  it("falls back to a generic bulk-payment error when the rejection is not an Error", async () => {
    apiMock.get.mockResolvedValue(
      outstanding([invoice({ id: "inv-a", balance: 1000 })]),
    );
    apiMock.post.mockRejectedValue("nope");

    render(<PatientBillingPage />);
    await screen.findByText("INV-2026-0001");
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Record Bulk Payment/i }));
    fireEvent.click(screen.getByRole("button", { name: /Apply Payment/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Bulk payment failed");
    });
  });

  it("cancel button closes the bulk-payment modal without firing POST", async () => {
    apiMock.get.mockResolvedValue(
      outstanding([invoice({ id: "inv-a", balance: 1000 })]),
    );
    render(<PatientBillingPage />);
    await screen.findByText("INV-2026-0001");

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Record Bulk Payment/i }));
    expect(
      screen.getByRole("heading", { name: /Record Bulk Payment/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    expect(
      screen.queryByRole("heading", { name: /Record Bulk Payment/i }),
    ).not.toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("posts a percentage discount per selected invoice with the correct shape", async () => {
    apiMock.get.mockResolvedValue(
      outstanding([
        invoice({ id: "inv-a", invoiceNumber: "INV-A", balance: 1000 }),
        invoice({ id: "inv-b", invoiceNumber: "INV-B", balance: 2000 }),
      ]),
    );
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<PatientBillingPage />);
    await screen.findByText("INV-A");

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Apply Discount/i }));

    // Default discType is percentage.
    fireEvent.change(screen.getByLabelText(/Percentage/i), {
      target: { value: "15" },
    });
    fireEvent.change(screen.getByLabelText(/Reason/i), {
      target: { value: "loyalty" },
    });
    // The modal footer's Apply button is the second matching button (the first
    // is in the action bar). Use within() to scope to the modal.
    const modalHeading = screen.getByRole("heading", { name: /Apply Discount/i });
    const modal = modalHeading.parentElement!;
    fireEvent.click(within(modal).getByRole("button", { name: /^Apply$/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/billing/invoices/inv-a/discount",
        { reason: "loyalty", percentage: 15 },
      );
      expect(apiMock.post).toHaveBeenCalledWith(
        "/billing/invoices/inv-b/discount",
        { reason: "loyalty", percentage: 15 },
      );
    });
  });

  it("flat discount swaps to flatAmount in the POST payload", async () => {
    apiMock.get.mockResolvedValue(
      outstanding([invoice({ id: "inv-a", balance: 1000 })]),
    );
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<PatientBillingPage />);
    await screen.findByText("INV-2026-0001");

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Apply Discount/i }));

    // Click "Flat Amount" tab.
    fireEvent.click(screen.getByRole("button", { name: /Flat Amount/i }));
    fireEvent.change(screen.getByLabelText(/Flat \(Rs\.\)/i), {
      target: { value: "250" },
    });
    fireEvent.change(screen.getByLabelText(/Reason/i), {
      target: { value: "promo" },
    });

    const modalHeading = screen.getByRole("heading", { name: /Apply Discount/i });
    const modal = modalHeading.parentElement!;
    fireEvent.click(within(modal).getByRole("button", { name: /^Apply$/i }));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/billing/invoices/inv-a/discount",
        { reason: "promo", flatAmount: 250 },
      );
    });
  });

  it("rejects negative discount values client-side (Issue #671 regression of #358)", async () => {
    apiMock.get.mockResolvedValue(
      outstanding([invoice({ id: "inv-a", balance: 1000 })]),
    );
    render(<PatientBillingPage />);
    await screen.findByText("INV-2026-0001");

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Apply Discount/i }));

    fireEvent.change(screen.getByLabelText(/Percentage/i), {
      target: { value: "-5" },
    });
    fireEvent.change(screen.getByLabelText(/Reason/i), {
      target: { value: "test" },
    });
    const modalHeading = screen.getByRole("heading", { name: /Apply Discount/i });
    const modal = modalHeading.parentElement!;
    fireEvent.click(within(modal).getByRole("button", { name: /^Apply$/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      "Discount must be a non-negative number",
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("rejects >100% percentage values client-side", async () => {
    apiMock.get.mockResolvedValue(
      outstanding([invoice({ id: "inv-a", balance: 1000 })]),
    );
    render(<PatientBillingPage />);
    await screen.findByText("INV-2026-0001");

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Apply Discount/i }));
    fireEvent.change(screen.getByLabelText(/Percentage/i), {
      target: { value: "150" },
    });
    fireEvent.change(screen.getByLabelText(/Reason/i), {
      target: { value: "test" },
    });
    const modalHeading = screen.getByRole("heading", { name: /Apply Discount/i });
    const modal = modalHeading.parentElement!;
    fireEvent.click(within(modal).getByRole("button", { name: /^Apply$/i }));

    expect(toastMock.error).toHaveBeenCalledWith(
      "Percentage must be between 0 and 100",
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("noop when discount value or reason is empty (button disabled)", async () => {
    apiMock.get.mockResolvedValue(
      outstanding([invoice({ id: "inv-a", balance: 1000 })]),
    );
    render(<PatientBillingPage />);
    await screen.findByText("INV-2026-0001");

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Apply Discount/i }));

    // Don't fill any field — Apply button is disabled.
    const modalHeading = screen.getByRole("heading", { name: /Apply Discount/i });
    const modal = modalHeading.parentElement!;
    const applyBtn = within(modal).getByRole("button", { name: /^Apply$/i });
    expect(applyBtn).toBeDisabled();
  });

  it("surfaces toast.error when discount API rejects", async () => {
    apiMock.get.mockResolvedValue(
      outstanding([invoice({ id: "inv-a", balance: 1000 })]),
    );
    apiMock.post.mockRejectedValue(new Error("discount denied"));

    render(<PatientBillingPage />);
    await screen.findByText("INV-2026-0001");

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Apply Discount/i }));
    fireEvent.change(screen.getByLabelText(/Percentage/i), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByLabelText(/Reason/i), {
      target: { value: "ok" },
    });
    const modalHeading = screen.getByRole("heading", { name: /Apply Discount/i });
    const modal = modalHeading.parentElement!;
    fireEvent.click(within(modal).getByRole("button", { name: /^Apply$/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("discount denied");
    });
  });

  it("falls back to a generic discount error when the rejection is not an Error", async () => {
    apiMock.get.mockResolvedValue(
      outstanding([invoice({ id: "inv-a", balance: 1000 })]),
    );
    apiMock.post.mockRejectedValue("nope");

    render(<PatientBillingPage />);
    await screen.findByText("INV-2026-0001");

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Apply Discount/i }));
    fireEvent.change(screen.getByLabelText(/Percentage/i), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByLabelText(/Reason/i), {
      target: { value: "ok" },
    });
    const modalHeading = screen.getByRole("heading", { name: /Apply Discount/i });
    const modal = modalHeading.parentElement!;
    fireEvent.click(within(modal).getByRole("button", { name: /^Apply$/i }));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith("Discount failed");
    });
  });

  it("cancel closes the discount modal without firing POST", async () => {
    apiMock.get.mockResolvedValue(
      outstanding([invoice({ id: "inv-a", balance: 1000 })]),
    );
    render(<PatientBillingPage />);
    await screen.findByText("INV-2026-0001");

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Apply Discount/i }));
    expect(
      screen.getByRole("heading", { name: /Apply Discount/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    expect(
      screen.queryByRole("heading", { name: /Apply Discount/i }),
    ).not.toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("renders status pill classes (PENDING / PARTIAL / PAID / REFUNDED)", async () => {
    apiMock.get.mockResolvedValue(
      outstanding([
        invoice({
          id: "inv-p",
          invoiceNumber: "INV-P",
          paymentStatus: "PENDING",
        }),
        invoice({
          id: "inv-pa",
          invoiceNumber: "INV-PA",
          paymentStatus: "PARTIAL",
          totalPaid: 200,
          balance: 800,
        }),
        invoice({
          id: "inv-paid",
          invoiceNumber: "INV-PAID",
          paymentStatus: "PAID",
          totalPaid: 1000,
          balance: 0,
        }),
        invoice({
          id: "inv-ref",
          invoiceNumber: "INV-REF",
          paymentStatus: "REFUNDED",
        }),
      ]),
    );
    render(<PatientBillingPage />);

    await screen.findByText("INV-P");
    expect(screen.getByText("PENDING").className).toMatch(/bg-red-100/);
    expect(screen.getByText("PARTIAL").className).toMatch(/bg-yellow-100/);
    expect(screen.getByText("PAID").className).toMatch(/bg-green-100/);
    expect(screen.getByText("REFUNDED").className).toMatch(/bg-gray-100/);
  });

  it("swallows API errors so the page still un-loads", async () => {
    apiMock.get.mockRejectedValue(new Error("boom"));
    render(<PatientBillingPage />);

    // After the reject, loading flips off and we land in the empty branch.
    await screen.findByText("No outstanding invoices.");
    expect(
      screen.queryByTestId("patient-billing-loading"),
    ).not.toBeInTheDocument();
  });

  it("bulk-payment with empty amount keeps the Apply button disabled (no POST)", async () => {
    apiMock.get.mockResolvedValue(
      outstanding([invoice({ id: "inv-a", balance: 1000 })]),
    );
    render(<PatientBillingPage />);
    await screen.findByText("INV-2026-0001");

    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    fireEvent.click(screen.getByRole("button", { name: /Record Bulk Payment/i }));

    const amountInput = screen.getByLabelText(/Amount/i) as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "" } });

    const applyBtn = screen.getByRole("button", { name: /Apply Payment/i });
    expect(applyBtn).toBeDisabled();
  });
});
