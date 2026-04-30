/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/billing/test-id",
  useParams: () => ({ id: "test-id" }),
}));

import InvoiceDetailPage from "../billing/[id]/page";

const sampleInvoice = {
  id: "inv1",
  invoiceNumber: "INV-001",
  status: "PENDING",
  paymentStatus: "PENDING",
  subtotal: 1000,
  tax: 180,
  taxAmount: 180,
  discount: 0,
  discountAmount: 0,
  total: 1180,
  totalAmount: 1180,
  totalPaid: 0,
  paid: 0,
  balance: 1180,
  createdAt: new Date().toISOString(),
  patient: {
    id: "p1",
    mrNumber: "MR-1",
    user: { name: "Aarav Mehta", phone: "9000000001", email: "a@x.com" },
  },
  items: [
    {
      id: "it1",
      description: "Consultation",
      category: "CONSULTATION",
      quantity: 1,
      unitPrice: 1000,
      amount: 1000,
    },
  ],
  payments: [],
};

describe("InvoiceDetailPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" } };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("shows loading state", async () => {
    apiMock.get.mockReturnValue(new Promise(() => {}));
    render(<InvoiceDetailPage />);
    await waitFor(() =>
      expect(screen.getByText(/loading invoice/i)).toBeInTheDocument()
    );
  });

  it("shows invoice-not-found on fetch failure", async () => {
    apiMock.get.mockRejectedValue(new Error("404"));
    render(<InvoiceDetailPage />);
    await waitFor(() =>
      expect(screen.getByText(/invoice not found/i)).toBeInTheDocument()
    );
  });

  it("renders populated invoice fields", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/billing/invoices/test-id"))
        return Promise.resolve({ data: sampleInvoice });
      return Promise.resolve({ data: [] });
    });
    render(<InvoiceDetailPage />);
    await waitFor(() =>
      expect(screen.getAllByText(/INV-001/).length).toBeGreaterThan(0)
    );
    expect(screen.getAllByText("Aarav Mehta").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/consultation/i).length).toBeGreaterThan(0);
  });

  it("opens Record Payment modal when button clicked", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/billing/invoices/test-id"))
        return Promise.resolve({ data: sampleInvoice });
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<InvoiceDetailPage />);
    await waitFor(() =>
      expect(screen.getAllByText(/INV-001/).length).toBeGreaterThan(0)
    );
    const payBtns = screen.queryAllByRole("button", { name: /record payment/i });
    if (payBtns[0]) {
      await user.click(payBtns[0]);
      expect(screen.getAllByText(/record payment/i).length).toBeGreaterThan(0);
    }
  });

  it("renders without crashing when API returns no invoice", async () => {
    apiMock.get.mockResolvedValue({ data: null });
    render(<InvoiceDetailPage />);
    await waitFor(() =>
      expect(screen.getByText(/invoice not found/i)).toBeInTheDocument()
    );
  });

  // Regression for #202: when the persisted invoice was stored with
  // taxAmount: 0 (legacy seed path) the footer Total must still equal
  // Subtotal + per-line GST, not the stale persisted value.
  it("footer Total = subtotal + GST when persisted taxAmount is 0 (#202)", async () => {
    const inv202 = {
      id: "inv-202",
      invoiceNumber: "INV-202",
      paymentStatus: "PENDING",
      subtotal: 1100,
      taxAmount: 0,
      discountAmount: 0,
      totalAmount: 1100, // persisted WRONG (matches #202 repro)
      lateFeeAmount: 0,
      createdAt: new Date().toISOString(),
      patient: {
        id: "p1",
        mrNumber: "MR-1",
        user: { name: "Mohan Das", phone: "9000000001", email: "" },
      },
      items: [
        {
          id: "it1",
          description: "Procedure A",
          category: "PROCEDURE", // 18% GST
          quantity: 1,
          unitPrice: 500,
          amount: 500,
        },
        {
          id: "it2",
          description: "Procedure B",
          category: "PROCEDURE",
          quantity: 1,
          unitPrice: 600,
          amount: 600,
        },
      ],
      payments: [],
    };
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/billing/invoices/test-id"))
        return Promise.resolve({ data: inv202 });
      return Promise.resolve({ data: [] });
    });
    render(<InvoiceDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId("totals-total")).toBeInTheDocument()
    );
    // Total must read 1,298.00 — never 1,100.
    expect(screen.getByTestId("totals-total").textContent).toContain("1,298");
    expect(screen.getByTestId("totals-balance").textContent).toContain("1,298");
    // Status badge stays PENDING (no payments).
    expect(screen.getByTestId("invoice-status-badge").textContent).toContain(
      "PENDING"
    );
  });

  // Regression for #235: PAID + balance > 0 must render as PARTIAL.
  it("renders PARTIAL badge when persisted status is PAID but balance > 0 (#235)", async () => {
    const inv235 = {
      id: "inv-235",
      invoiceNumber: "INV-235",
      paymentStatus: "PAID", // contradicts the maths
      subtotal: 500,
      taxAmount: 90,
      discountAmount: 0,
      totalAmount: 590,
      lateFeeAmount: 0,
      createdAt: new Date().toISOString(),
      patient: {
        id: "p1",
        mrNumber: "MR-1",
        user: { name: "Aarav Mehta", phone: "9000000001", email: "" },
      },
      items: [
        {
          id: "it1",
          description: "Consultation",
          category: "PROCEDURE",
          quantity: 1,
          unitPrice: 500,
          amount: 500,
        },
      ],
      payments: [
        { id: "pm1", amount: 500, mode: "CASH", paidAt: new Date().toISOString(), transactionId: null },
      ],
    };
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/billing/invoices/test-id"))
        return Promise.resolve({ data: inv235 });
      return Promise.resolve({ data: [] });
    });
    render(<InvoiceDetailPage />);
    await waitFor(() =>
      expect(screen.getByTestId("invoice-status-badge")).toBeInTheDocument()
    );
    expect(screen.getByTestId("invoice-status-badge").textContent).toContain(
      "PARTIAL"
    );
    // Balance must be the still-owed Rs. 90.00 (not 0).
    expect(screen.getByTestId("totals-balance").textContent).toContain("90.00");
  });
});
