/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PaymentPlansPage — colocated coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/payment-plans/page.tsx, the
 *     RECEPTION/ADMIN-facing installment plans list with two embedded
 *     dialogs: a "New Payment Plan" modal (Issue #60) and a plan-detail
 *     modal that records installment payments. API endpoints:
 *       GET   /payment-plans?status=...                (list per tab)
 *       GET   /payment-plans/overdue                    (overdue tab)
 *       GET   /payment-plans/:id                        (detail modal)
 *       GET   /billing/invoices?patientId=...&limit=50  (new-plan invoice picker)
 *       POST  /payment-plans                            (create plan)
 *       PATCH /payment-plans/:id/pay-installment        (record payment)
 *
 *   - Behaviours covered:
 *       1. Initial render — heading, tab chrome, and the ACTIVE-tab GET fire
 *          on mount with the right querystring (`?status=ACTIVE`).
 *       2. Loading branch — `payment-plans-loading` skeleton renders while
 *          the initial list GET is pending.
 *       3. Happy fetch — one <tr> per plan with planNumber, patient name,
 *          MR number, invoice link, total amount, progress fraction, status
 *          pill, and the COMPLETED + DEFAULTED + unknown status pills all
 *          render with the right class branch.
 *       4. Tab switching — ACTIVE → COMPLETED hits `?status=COMPLETED`;
 *          ALL hits `?` (no status param); OVERDUE switches to the dedicated
 *          /overdue endpoint and renders the overdue-shape rows.
 *       5. Empty states — non-overdue tab empty renders "No plans in this
 *          category."; overdue tab empty renders "No overdue installments.".
 *       6. Role-gating — non-ADMIN/non-RECEPTION (DOCTOR) does NOT see the
 *          "New Plan" button; ADMIN does; RECEPTION does.
 *       7. New-plan modal opens, closes via the X button, and the patient
 *          picker triggers the secondary /billing/invoices fetch when a
 *          patient is selected.
 *       8. Invoice picker UX — pre-patient placeholder shows "Select a
 *          patient first."; while invoices load the skeleton
 *          `payment-plans-invoices-loading` renders; an empty result shows
 *          the "no outstanding invoice" warning; a single-invoice result
 *          auto-selects it; PAID invoices are filtered out.
 *       9. New-plan validation — missing patient / missing invoice /
 *          invalid installment count (<2, >60, NaN) / negative down payment
 *          / down payment > total — all surface inline error and skip POST.
 *      10. New-plan happy path — POSTs the canonical body, toasts success,
 *          and triggers a list refresh.
 *      11. New-plan POST error — surfaces inline error message; modal stays
 *          open so the user can retry.
 *      12. Plan-detail modal — opens with `payment-plan-detail-loading`,
 *          renders the patient/invoice/installments/down-payment grid, the
 *          pay-mode select, the installments table (sorted by dueDate),
 *          the status pills (PAID/PENDING/OVERDUE/WAIVED), and per-row Pay
 *          buttons ONLY for PENDING + OVERDUE rows.
 *      13. Pay action — PATCH fires with the right body; detail + list both
 *          refresh; PATCH rejection surfaces toast.error.
 *      14. Error-path resilience — list GET rejection flips loading off and
 *          renders the empty branch (catch swallows). Detail GET rejection
 *          renders "Not found.".
 *
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore), @/lib/toast,
 *            next/navigation, @/components/EntityPicker (stubbed to a
 *            <select> that calls onChange), @/components/Skeleton.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";

const { apiMock, toastMock, authMock } = vi.hoisted(() => ({
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
  authMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/payment-plans",
}));

// EntityPicker stub: rendered as a <select> so tests can simulate a patient
// pick via fireEvent.change. The real picker is exercised in its own unit
// test; here we only care that the parent reacts to onChange.
vi.mock("@/components/EntityPicker", () => ({
  EntityPicker: ({ onChange, testIdPrefix, value }: any) => (
    <select
      data-testid={`${testIdPrefix ?? "picker"}-stub`}
      value={value || ""}
      onChange={(e) => onChange(e.target.value, null)}
    >
      <option value="">(none)</option>
      <option value="pat-1">Patient One</option>
      <option value="pat-empty">Patient Empty</option>
      <option value="pat-single">Patient Single</option>
      <option value="pat-only-paid">Patient Only Paid</option>
      <option value="pat-broken">Patient Broken</option>
    </select>
  ),
}));

vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-table-stub" data-rows={rows} data-columns={columns} />
  ),
  SkeletonText: ({ lines }: { lines: number }) => (
    <div data-testid="skeleton-text-stub" data-lines={lines} />
  ),
}));

import PaymentPlansPage from "../page";

// ─── Fixtures ─────────────────────────────────────────────────────────────

type InstallmentRec = {
  id: string;
  dueDate: string;
  amount: number;
  status: string;
  paidAt?: string | null;
};

type PlanRow = {
  id: string;
  planNumber: string;
  totalAmount: number;
  downPayment: number;
  installments: number;
  installmentAmount: number;
  frequency: string;
  startDate: string;
  status: string;
  paidCount?: number;
  nextDue?: string | null;
  invoice: { id: string; invoiceNumber: string; totalAmount: number };
  patient: {
    id: string;
    mrNumber: string;
    user: { name: string; phone: string };
  };
  installmentRecords: InstallmentRec[];
};

function planFixture(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    id: "p-1",
    planNumber: "PP-001",
    totalAmount: 10000,
    downPayment: 1000,
    installments: 6,
    installmentAmount: 1500,
    frequency: "MONTHLY",
    startDate: "2026-05-01T00:00:00.000Z",
    status: "ACTIVE",
    paidCount: 2,
    nextDue: "2026-07-01T00:00:00.000Z",
    invoice: { id: "inv-1", invoiceNumber: "INV-001", totalAmount: 10000 },
    patient: {
      id: "pat-1",
      mrNumber: "MR-001",
      user: { name: "Aarav Mehta", phone: "9000000001" },
    },
    installmentRecords: [],
    ...overrides,
  };
}

function asAdmin() {
  authMock.mockReturnValue({
    user: {
      id: "u-admin",
      userId: "u-admin",
      role: "ADMIN",
      name: "Admin",
      email: "admin@test.local",
    },
    isLoading: false,
  });
}

function asReception() {
  authMock.mockReturnValue({
    user: {
      id: "u-rec",
      userId: "u-rec",
      role: "RECEPTION",
      name: "Reception",
      email: "rec@test.local",
    },
    isLoading: false,
  });
}

function asDoctor() {
  authMock.mockReturnValue({
    user: {
      id: "u-doc",
      userId: "u-doc",
      role: "DOCTOR",
      name: "Doc",
      email: "doc@test.local",
    },
    isLoading: false,
  });
}

// Drains microtasks + a couple of macrotasks so chained .then() callbacks in
// the New-plan modal's invoice-load effect can settle without fake timers.
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("PaymentPlansPage colocated coverage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    asAdmin();
  });

  afterEach(() => {
    cleanup();
  });

  // ─── Initial render + role gating ──────────────────────────────────────

  it("renders the heading, tab chrome, and fires the ACTIVE-tab GET on mount", async () => {
    apiMock.get.mockResolvedValue({ data: [planFixture()] });
    render(<PaymentPlansPage />);

    await screen.findByText("PP-001");
    expect(
      screen.getByRole("heading", { name: /Payment Plans/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Installment \/ EMI plans for outstanding invoices/i),
    ).toBeInTheDocument();
    expect(apiMock.get).toHaveBeenCalledWith("/payment-plans?status=ACTIVE");
  });

  it("renders the SkeletonTable loading branch while the initial GET is pending", () => {
    apiMock.get.mockReturnValue(new Promise(() => {}));
    render(<PaymentPlansPage />);
    expect(screen.getByTestId("payment-plans-loading")).toBeInTheDocument();
    expect(screen.getByTestId("skeleton-table-stub")).toBeInTheDocument();
  });

  it("renders one row per plan with the canonical columns + progress fraction", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        planFixture({ id: "p-a", planNumber: "PP-A", paidCount: 3 }),
        planFixture({
          id: "p-b",
          planNumber: "PP-B",
          installments: 0, // exercise the pct=0 branch (no divide-by-zero)
          paidCount: 0,
          patient: {
            id: "pat-2",
            mrNumber: "MR-002",
            user: { name: "Neha Singh", phone: "9000000002" },
          },
          invoice: { id: "inv-2", invoiceNumber: "INV-002", totalAmount: 5000 },
        }),
      ],
    });
    render(<PaymentPlansPage />);

    await screen.findByText("PP-A");
    expect(screen.getByText("PP-B")).toBeInTheDocument();
    expect(screen.getByText("Aarav Mehta")).toBeInTheDocument();
    expect(screen.getByText("Neha Singh")).toBeInTheDocument();
    expect(screen.getByText("MR-001")).toBeInTheDocument();
    // Progress fraction text "3/6" for the first row.
    expect(screen.getByText("3/6")).toBeInTheDocument();
    // Divide-by-zero protection: pct=0 branch renders "0/0".
    expect(screen.getByText("0/0")).toBeInTheDocument();
    // Invoice links.
    const link1 = screen.getByRole("link", { name: "INV-001" });
    expect(link1).toHaveAttribute("href", "/dashboard/billing/inv-1");
  });

  it("renders all four status pill branches (ACTIVE / COMPLETED / DEFAULTED / other)", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        planFixture({ id: "a", planNumber: "PP-A", status: "ACTIVE" }),
        planFixture({ id: "b", planNumber: "PP-B", status: "COMPLETED" }),
        planFixture({ id: "c", planNumber: "PP-C", status: "DEFAULTED" }),
        planFixture({ id: "d", planNumber: "PP-D", status: "PAUSED" }),
      ],
    });
    render(<PaymentPlansPage />);

    await screen.findByText("PP-A");
    // One pill per status — text content matches.
    expect(screen.getByText("ACTIVE")).toBeInTheDocument();
    expect(screen.getByText("COMPLETED")).toBeInTheDocument();
    expect(screen.getByText("DEFAULTED")).toBeInTheDocument();
    expect(screen.getByText("PAUSED")).toBeInTheDocument();
  });

  it("renders the nextDue em-dash fallback when the field is null", async () => {
    apiMock.get.mockResolvedValue({
      data: [planFixture({ nextDue: null })],
    });
    render(<PaymentPlansPage />);
    await screen.findByText("PP-001");
    // Em-dash placeholder for missing nextDue.
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it('renders the "No plans in this category" empty branch', async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<PaymentPlansPage />);
    expect(
      await screen.findByText(/No plans in this category/i),
    ).toBeInTheDocument();
  });

  it("hides the New Plan button for DOCTOR (not ADMIN / not RECEPTION)", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    asDoctor();
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);
    expect(screen.queryByTestId("open-new-plan")).not.toBeInTheDocument();
  });

  it("shows the New Plan button for RECEPTION", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    asReception();
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);
    expect(screen.getByTestId("open-new-plan")).toBeInTheDocument();
  });

  // ─── Tabs ──────────────────────────────────────────────────────────────

  it("switching to COMPLETED tab fires GET with ?status=COMPLETED", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);
    apiMock.get.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /^Completed$/i }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/payment-plans?status=COMPLETED"),
    );
  });

  it("switching to ALL tab fires GET with no status param", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);
    apiMock.get.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /^All$/i }));

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/payment-plans?"),
    );
  });

  it("OVERDUE tab hits /payment-plans/overdue and renders overdue rows", async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url === "/payment-plans/overdue") {
        return {
          data: [
            {
              id: "ov-1",
              dueDate: "2026-04-15T00:00:00.000Z",
              amount: 1500,
              status: "OVERDUE",
              plan: {
                id: "p-1",
                planNumber: "PP-001",
                patient: {
                  mrNumber: "MR-001",
                  user: { name: "Aarav Mehta", phone: "9000000001" },
                },
                invoice: { id: "inv-1", invoiceNumber: "INV-001" },
              },
            },
          ],
        };
      }
      return { data: [] };
    });
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);

    fireEvent.click(screen.getByRole("button", { name: /^Overdue$/i }));

    await screen.findByText("INV-001");
    // OVERDUE pill renders.
    expect(screen.getByText("OVERDUE")).toBeInTheDocument();
    // Amount formatted via fmtMoney.
    expect(screen.getByText("Rs. 1,500.00")).toBeInTheDocument();
  });

  it('OVERDUE tab empty state renders "No overdue installments."', async () => {
    apiMock.get.mockImplementation(async () => ({ data: [] }));
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);

    fireEvent.click(screen.getByRole("button", { name: /^Overdue$/i }));

    expect(
      await screen.findByText(/No overdue installments/i),
    ).toBeInTheDocument();
  });

  it("clicking an overdue row opens the detail modal for the underlying plan", async () => {
    let detailCalled = false;
    apiMock.get.mockImplementation(async (url: string) => {
      if (url === "/payment-plans/overdue") {
        return {
          data: [
            {
              id: "ov-1",
              dueDate: "2026-04-15T00:00:00.000Z",
              amount: 1500,
              status: "OVERDUE",
              plan: {
                id: "p-from-overdue",
                planNumber: "PP-OVD",
                patient: {
                  mrNumber: "MR-001",
                  user: { name: "Aarav Mehta", phone: "9000000001" },
                },
                invoice: { id: "inv-1", invoiceNumber: "INV-001" },
              },
            },
          ],
        };
      }
      if (url === "/payment-plans/p-from-overdue") {
        detailCalled = true;
        return { data: planFixture({ id: "p-from-overdue", planNumber: "PP-OVD" }) };
      }
      return { data: [] };
    });
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);
    fireEvent.click(screen.getByRole("button", { name: /^Overdue$/i }));
    await screen.findByText("INV-001");

    // Click the row (the cell that's not the link).
    fireEvent.click(screen.getByText("PP-OVD"));

    await waitFor(() => expect(detailCalled).toBe(true));
  });

  // ─── New-plan modal ────────────────────────────────────────────────────

  it("opens and closes the New Plan modal", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);

    fireEvent.click(screen.getByTestId("open-new-plan"));
    expect(screen.getByTestId("new-plan-modal")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /New Payment Plan/i }),
    ).toBeInTheDocument();
    // Pre-patient placeholder.
    expect(screen.getByText(/Select a patient first/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Close/i }));
    await waitFor(() =>
      expect(screen.queryByTestId("new-plan-modal")).not.toBeInTheDocument(),
    );
  });

  it("picking a patient fires /billing/invoices and renders the invoice select with auto-pick for single-result", async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url.startsWith("/billing/invoices")) {
        return {
          data: [
            {
              id: "inv-99",
              invoiceNumber: "INV-099",
              totalAmount: 8000,
              paymentStatus: "PARTIAL",
            },
          ],
        };
      }
      return { data: [] };
    });
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);

    fireEvent.click(screen.getByTestId("open-new-plan"));
    fireEvent.change(screen.getByTestId("new-plan-patient-stub"), {
      target: { value: "pat-single" },
    });

    // The /billing/invoices fetch fires with the encoded patient id.
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        "/billing/invoices?patientId=pat-single&limit=50",
      ),
    );

    // Single-result auto-pick wires the select + reveals the totalAmount summary.
    await screen.findByTestId("new-plan-total");
    const select = screen.getByTestId("new-plan-invoice") as HTMLSelectElement;
    expect(select.value).toBe("inv-99");
    expect(screen.getByTestId("new-plan-total")).toHaveTextContent("Rs. 8,000.00");
  });

  it("renders the loading skeleton while invoices fetch is in flight", async () => {
    let resolveInvoices!: (v: any) => void;
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/billing/invoices")) {
        return new Promise((r) => {
          resolveInvoices = r;
        });
      }
      return Promise.resolve({ data: [] });
    });
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);

    fireEvent.click(screen.getByTestId("open-new-plan"));
    fireEvent.change(screen.getByTestId("new-plan-patient-stub"), {
      target: { value: "pat-1" },
    });

    expect(
      await screen.findByTestId("payment-plans-invoices-loading"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("skeleton-text-stub")).toBeInTheDocument();

    // Drain so the pending promise doesn't leak between tests.
    resolveInvoices({ data: [] });
    await flush();
  });

  it('renders "no outstanding invoice" warning when the patient has none', async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url.startsWith("/billing/invoices")) return { data: [] };
      return { data: [] };
    });
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);

    fireEvent.click(screen.getByTestId("open-new-plan"));
    fireEvent.change(screen.getByTestId("new-plan-patient-stub"), {
      target: { value: "pat-empty" },
    });

    expect(await screen.findByTestId("new-plan-no-invoices")).toBeInTheDocument();
  });

  it("filters out PAID invoices from the picker", async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url.startsWith("/billing/invoices")) {
        return {
          data: [
            {
              id: "inv-paid",
              invoiceNumber: "INV-PAID",
              totalAmount: 1000,
              paymentStatus: "PAID",
            },
          ],
        };
      }
      return { data: [] };
    });
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);

    fireEvent.click(screen.getByTestId("open-new-plan"));
    fireEvent.change(screen.getByTestId("new-plan-patient-stub"), {
      target: { value: "pat-only-paid" },
    });

    expect(await screen.findByTestId("new-plan-no-invoices")).toBeInTheDocument();
    expect(screen.queryByText("INV-PAID")).not.toBeInTheDocument();
  });

  it("recovers from a /billing/invoices rejection by rendering the no-invoices branch", async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url.startsWith("/billing/invoices")) throw new Error("boom");
      return { data: [] };
    });
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);

    fireEvent.click(screen.getByTestId("open-new-plan"));
    fireEvent.change(screen.getByTestId("new-plan-patient-stub"), {
      target: { value: "pat-broken" },
    });

    expect(await screen.findByTestId("new-plan-no-invoices")).toBeInTheDocument();
  });

  it("clearing the patient resets the invoice list back to the placeholder", async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url.startsWith("/billing/invoices")) {
        return {
          data: [
            {
              id: "inv-9",
              invoiceNumber: "INV-009",
              totalAmount: 5000,
              paymentStatus: "PARTIAL",
            },
          ],
        };
      }
      return { data: [] };
    });
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);

    fireEvent.click(screen.getByTestId("open-new-plan"));
    fireEvent.change(screen.getByTestId("new-plan-patient-stub"), {
      target: { value: "pat-1" },
    });
    await screen.findByTestId("new-plan-invoice");

    // Now clear the patient — the picker re-emits with "".
    fireEvent.change(screen.getByTestId("new-plan-patient-stub"), {
      target: { value: "" },
    });

    await waitFor(() =>
      expect(screen.getByText(/Select a patient first/i)).toBeInTheDocument(),
    );
  });

  // ─── New-plan validation ───────────────────────────────────────────────

  it("blocks submit + surfaces inline error when no patient is selected", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);

    fireEvent.click(screen.getByTestId("open-new-plan"));
    // The submit button is disabled when invoiceId is empty, so we exercise
    // the validation path by submitting the form directly.
    const form = screen.getByTestId("new-plan-modal") as HTMLFormElement;
    fireEvent.submit(form);

    expect(await screen.findByTestId("new-plan-error")).toHaveTextContent(
      /Select a patient/i,
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("blocks submit + surfaces inline error when patient is set but invoice is missing", async () => {
    // Patient selected → invoice list returns multiple → no auto-pick → submit
    // without choosing an invoice surfaces the "Select an outstanding invoice"
    // error.
    apiMock.get.mockImplementation(async (url: string) => {
      if (url.startsWith("/billing/invoices")) {
        return {
          data: [
            { id: "i1", invoiceNumber: "I-1", totalAmount: 500, paymentStatus: "PARTIAL" },
            { id: "i2", invoiceNumber: "I-2", totalAmount: 700, paymentStatus: "PENDING" },
          ],
        };
      }
      return { data: [] };
    });
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);

    fireEvent.click(screen.getByTestId("open-new-plan"));
    fireEvent.change(screen.getByTestId("new-plan-patient-stub"), {
      target: { value: "pat-1" },
    });
    await screen.findByTestId("new-plan-invoice");

    fireEvent.submit(screen.getByTestId("new-plan-modal"));

    expect(await screen.findByTestId("new-plan-error")).toHaveTextContent(
      /Select an outstanding invoice/i,
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("validates installment count is between 2 and 60", async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url.startsWith("/billing/invoices")) {
        return {
          data: [
            { id: "i1", invoiceNumber: "I-1", totalAmount: 1000, paymentStatus: "PARTIAL" },
          ],
        };
      }
      return { data: [] };
    });
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);

    fireEvent.click(screen.getByTestId("open-new-plan"));
    fireEvent.change(screen.getByTestId("new-plan-patient-stub"), {
      target: { value: "pat-1" },
    });
    await screen.findByTestId("new-plan-invoice");

    // n=1 (below floor)
    fireEvent.change(screen.getByTestId("new-plan-installments"), {
      target: { value: "1" },
    });
    fireEvent.submit(screen.getByTestId("new-plan-modal"));
    expect(await screen.findByTestId("new-plan-error")).toHaveTextContent(
      /Installments must be between 2 and 60/i,
    );
    expect(apiMock.post).not.toHaveBeenCalled();

    // n=99 (above ceiling)
    fireEvent.change(screen.getByTestId("new-plan-installments"), {
      target: { value: "99" },
    });
    fireEvent.submit(screen.getByTestId("new-plan-modal"));
    await waitFor(() =>
      expect(screen.getByTestId("new-plan-error")).toHaveTextContent(
        /Installments must be between 2 and 60/i,
      ),
    );

    // n=NaN (non-numeric — parseInt("abc") → NaN, not finite)
    fireEvent.change(screen.getByTestId("new-plan-installments"), {
      target: { value: "abc" },
    });
    fireEvent.submit(screen.getByTestId("new-plan-modal"));
    await waitFor(() =>
      expect(screen.getByTestId("new-plan-error")).toHaveTextContent(
        /Installments must be between 2 and 60/i,
      ),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("validates that down payment is non-negative and not greater than invoice total", async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url.startsWith("/billing/invoices")) {
        return {
          data: [
            { id: "i1", invoiceNumber: "I-1", totalAmount: 1000, paymentStatus: "PARTIAL" },
          ],
        };
      }
      return { data: [] };
    });
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);

    fireEvent.click(screen.getByTestId("open-new-plan"));
    fireEvent.change(screen.getByTestId("new-plan-patient-stub"), {
      target: { value: "pat-1" },
    });
    await screen.findByTestId("new-plan-invoice");

    // Negative.
    fireEvent.change(screen.getByTestId("new-plan-down-payment"), {
      target: { value: "-50" },
    });
    fireEvent.submit(screen.getByTestId("new-plan-modal"));
    expect(await screen.findByTestId("new-plan-error")).toHaveTextContent(
      /Down payment cannot be negative/i,
    );

    // Over-the-top (dp > totalAmount).
    fireEvent.change(screen.getByTestId("new-plan-down-payment"), {
      target: { value: "9999" },
    });
    fireEvent.submit(screen.getByTestId("new-plan-modal"));
    await waitFor(() =>
      expect(screen.getByTestId("new-plan-error")).toHaveTextContent(
        /Down payment cannot exceed invoice total/i,
      ),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("blocks submit when startDate is cleared", async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url.startsWith("/billing/invoices")) {
        return {
          data: [
            { id: "i1", invoiceNumber: "I-1", totalAmount: 1000, paymentStatus: "PARTIAL" },
          ],
        };
      }
      return { data: [] };
    });
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);

    fireEvent.click(screen.getByTestId("open-new-plan"));
    fireEvent.change(screen.getByTestId("new-plan-patient-stub"), {
      target: { value: "pat-1" },
    });
    await screen.findByTestId("new-plan-invoice");
    fireEvent.change(screen.getByTestId("new-plan-start"), {
      target: { value: "" },
    });
    fireEvent.submit(screen.getByTestId("new-plan-modal"));

    expect(await screen.findByTestId("new-plan-error")).toHaveTextContent(
      /Start date is required/i,
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  // ─── New-plan happy path + error path ──────────────────────────────────

  it("POSTs the canonical body, toasts success, and triggers a list refresh", async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url.startsWith("/billing/invoices")) {
        return {
          data: [
            { id: "inv-99", invoiceNumber: "INV-099", totalAmount: 8000, paymentStatus: "PARTIAL" },
          ],
        };
      }
      return { data: [] };
    });
    apiMock.post.mockResolvedValue({ data: { id: "p-new" } });
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);

    fireEvent.click(screen.getByTestId("open-new-plan"));
    fireEvent.change(screen.getByTestId("new-plan-patient-stub"), {
      target: { value: "pat-single" },
    });
    await screen.findByTestId("new-plan-invoice");

    fireEvent.change(screen.getByTestId("new-plan-frequency"), {
      target: { value: "WEEKLY" },
    });
    fireEvent.change(screen.getByTestId("new-plan-installments"), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByTestId("new-plan-down-payment"), {
      target: { value: "500" },
    });
    fireEvent.change(screen.getByTestId("new-plan-start"), {
      target: { value: "2026-06-01" },
    });

    apiMock.get.mockClear();
    fireEvent.click(screen.getByTestId("new-plan-submit"));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [url, body] = apiMock.post.mock.calls[0];
    expect(url).toBe("/payment-plans");
    expect(body).toEqual({
      invoiceId: "inv-99",
      downPayment: 500,
      installments: 4,
      frequency: "WEEKLY",
      startDate: "2026-06-01",
    });
    expect(toastMock.success).toHaveBeenCalledWith("Payment plan created");

    // Modal closes + list reload fires.
    await waitFor(() =>
      expect(screen.queryByTestId("new-plan-modal")).not.toBeInTheDocument(),
    );
    expect(apiMock.get).toHaveBeenCalledWith(
      expect.stringMatching(/^\/payment-plans\?/),
    );
  });

  it("surfaces a POST rejection via inline error and keeps the modal open", async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url.startsWith("/billing/invoices")) {
        return {
          data: [
            { id: "inv-99", invoiceNumber: "INV-099", totalAmount: 8000, paymentStatus: "PARTIAL" },
          ],
        };
      }
      return { data: [] };
    });
    apiMock.post.mockRejectedValue(new Error("server boom"));
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);

    fireEvent.click(screen.getByTestId("open-new-plan"));
    fireEvent.change(screen.getByTestId("new-plan-patient-stub"), {
      target: { value: "pat-single" },
    });
    await screen.findByTestId("new-plan-invoice");
    fireEvent.click(screen.getByTestId("new-plan-submit"));

    expect(await screen.findByTestId("new-plan-error")).toHaveTextContent(
      /server boom/i,
    );
    // Modal still mounted.
    expect(screen.getByTestId("new-plan-modal")).toBeInTheDocument();
  });

  it("surfaces a non-Error rejection via the generic fallback copy", async () => {
    apiMock.get.mockImplementation(async (url: string) => {
      if (url.startsWith("/billing/invoices")) {
        return {
          data: [
            { id: "inv-99", invoiceNumber: "INV-099", totalAmount: 8000, paymentStatus: "PARTIAL" },
          ],
        };
      }
      return { data: [] };
    });
    apiMock.post.mockRejectedValue("plain string"); // not an Error instance
    render(<PaymentPlansPage />);
    await screen.findByText(/No plans in this category/i);

    fireEvent.click(screen.getByTestId("open-new-plan"));
    fireEvent.change(screen.getByTestId("new-plan-patient-stub"), {
      target: { value: "pat-single" },
    });
    await screen.findByTestId("new-plan-invoice");
    fireEvent.click(screen.getByTestId("new-plan-submit"));

    expect(await screen.findByTestId("new-plan-error")).toHaveTextContent(
      /Failed to create plan/i,
    );
  });

  // ─── Plan-detail modal ─────────────────────────────────────────────────

  it("opens the plan-detail modal and shows the loading skeleton, then the populated grid", async () => {
    let resolveDetail!: (v: any) => void;
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/payment-plans/p-1") {
        return new Promise((r) => {
          resolveDetail = r;
        });
      }
      return Promise.resolve({ data: [planFixture()] });
    });

    render(<PaymentPlansPage />);
    await screen.findByText("PP-001");

    fireEvent.click(screen.getByText("PP-001"));
    // Loading branch.
    expect(
      await screen.findByTestId("payment-plan-detail-loading"),
    ).toBeInTheDocument();

    // Resolve with installment data — sorted by dueDate ascending, with
    // every status branch represented.
    resolveDetail({
      data: planFixture({
        id: "p-1",
        installmentRecords: [
          {
            id: "i-late",
            dueDate: "2026-08-01T00:00:00.000Z",
            amount: 1500,
            status: "PENDING",
          },
          {
            id: "i-early",
            dueDate: "2026-06-01T00:00:00.000Z",
            amount: 1500,
            status: "PAID",
            paidAt: "2026-06-02T00:00:00.000Z",
          },
          {
            id: "i-overdue",
            dueDate: "2026-07-01T00:00:00.000Z",
            amount: 1500,
            status: "OVERDUE",
          },
          {
            id: "i-waived",
            dueDate: "2026-09-01T00:00:00.000Z",
            amount: 1500,
            status: "WAIVED",
          },
        ],
      }),
    });

    await screen.findByText(/Payment Plan PP-001/i);
    // All four status pills render (one per row).
    expect(screen.getByText("PENDING")).toBeInTheDocument();
    expect(screen.getByText("PAID")).toBeInTheDocument();
    expect(screen.getByText("OVERDUE")).toBeInTheDocument();
    expect(screen.getByText("WAIVED")).toBeInTheDocument();

    // Pay buttons render ONLY for PENDING + OVERDUE rows (2 total).
    expect(screen.getAllByRole("button", { name: /^Pay$/i })).toHaveLength(2);

    // Pay-mode select is wired.
    const payMode = document.getElementById("plan-pay-mode") as HTMLSelectElement;
    expect(payMode.value).toBe("CASH");
    fireEvent.change(payMode, { target: { value: "UPI" } });
    expect(payMode.value).toBe("UPI");
  });

  it("PATCHes the right body when the Pay button is clicked + refreshes detail + list", async () => {
    let detailCalls = 0;
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/payment-plans/p-1") {
        detailCalls++;
        return Promise.resolve({
          data: planFixture({
            id: "p-1",
            installmentRecords: [
              {
                id: "inst-1",
                dueDate: "2026-06-01T00:00:00.000Z",
                amount: 1500,
                status: "PENDING",
              },
            ],
          }),
        });
      }
      return Promise.resolve({ data: [planFixture()] });
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<PaymentPlansPage />);
    await screen.findByText("PP-001");
    fireEvent.click(screen.getByText("PP-001"));
    await screen.findByText(/Payment Plan PP-001/i);

    // Switch mode so the PATCH body picks up the change.
    fireEvent.change(document.getElementById("plan-pay-mode") as HTMLSelectElement, {
      target: { value: "CARD" },
    });

    const callsBefore = apiMock.get.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /^Pay$/i }));

    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    const [url, body] = apiMock.patch.mock.calls[0];
    expect(url).toBe("/payment-plans/p-1/pay-installment");
    expect(body).toEqual({
      installmentId: "inst-1",
      amount: 1500,
      mode: "CARD",
    });
    // Detail reload + list reload both happen.
    await waitFor(() =>
      expect(apiMock.get.mock.calls.length).toBeGreaterThan(callsBefore),
    );
    expect(detailCalls).toBeGreaterThanOrEqual(2);
  });

  it("surfaces toast.error when the pay PATCH rejects", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/payment-plans/p-1") {
        return Promise.resolve({
          data: planFixture({
            id: "p-1",
            installmentRecords: [
              {
                id: "inst-1",
                dueDate: "2026-06-01T00:00:00.000Z",
                amount: 1500,
                status: "PENDING",
              },
            ],
          }),
        });
      }
      return Promise.resolve({ data: [planFixture()] });
    });
    apiMock.patch.mockRejectedValue(new Error("payment failed"));

    render(<PaymentPlansPage />);
    await screen.findByText("PP-001");
    fireEvent.click(screen.getByText("PP-001"));
    await screen.findByText(/Payment Plan PP-001/i);

    fireEvent.click(screen.getByRole("button", { name: /^Pay$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("payment failed"),
    );
  });

  it('detail modal renders "Not found." when the GET rejects', async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/payment-plans/p-1") {
        return Promise.reject(new Error("nope"));
      }
      return Promise.resolve({ data: [planFixture()] });
    });

    render(<PaymentPlansPage />);
    await screen.findByText("PP-001");
    fireEvent.click(screen.getByText("PP-001"));

    expect(await screen.findByText(/Not found/i)).toBeInTheDocument();
  });

  it("closes the detail modal via the X button", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/payment-plans/p-1") {
        return Promise.resolve({ data: planFixture() });
      }
      return Promise.resolve({ data: [planFixture()] });
    });

    render(<PaymentPlansPage />);
    await screen.findByText("PP-001");
    fireEvent.click(screen.getByText("PP-001"));
    const heading = await screen.findByText(/Payment Plan PP-001/i);
    const modal = heading.closest("div.fixed") as HTMLElement;
    expect(modal).toBeTruthy();

    // The detail modal's close button is the only unnamed button in its header.
    // Use within(modal) to scope and pick the first <button>.
    const closeBtn = within(modal).getAllByRole("button")[0];
    fireEvent.click(closeBtn);

    await waitFor(() =>
      expect(screen.queryByText(/Payment Plan PP-001/i)).not.toBeInTheDocument(),
    );
  });

  // ─── Error-path resilience ─────────────────────────────────────────────

  it("silently swallows a list GET rejection and renders the empty branch", async () => {
    apiMock.get.mockRejectedValue(new Error("server down"));
    render(<PaymentPlansPage />);

    expect(
      await screen.findByText(/No plans in this category/i),
    ).toBeInTheDocument();
    expect(toastMock.error).not.toHaveBeenCalled();
  });
});
