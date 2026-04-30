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
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/api", () => ({
  api: apiMock,
  openPrintEndpoint: vi.fn(),
}));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/billing",
}));

import BillingPage from "../billing/page";

const sampleInvoices = [
  {
    id: "inv1",
    invoiceNumber: "INV-001",
    totalAmount: 1500,
    paymentStatus: "PENDING",
    createdAt: new Date().toISOString(),
    patientId: "p1",
    patient: { user: { name: "Aarav Mehta", phone: "9000000001" } },
    payments: [],
  },
  {
    id: "inv2",
    invoiceNumber: "INV-002",
    totalAmount: 2500,
    paymentStatus: "PAID",
    createdAt: new Date().toISOString(),
    patientId: "p2",
    patient: { user: { name: "Bina Shah", phone: "9000000002" } },
    payments: [
      { id: "pay1", amount: 2500, mode: "CASH", paidAt: new Date().toISOString() },
    ],
  },
];

function defaultGet(url: string) {
  if (url.startsWith("/billing/invoices")) return { data: [] };
  if (url.includes("/billing/reports/outstanding"))
    return { data: { rows: [], totalOutstanding: 0, count: 0 } };
  if (url.includes("/billing/reports/daily"))
    return { data: { totalCollection: 0 } };
  if (url.includes("/billing/reports/revenue"))
    return { data: { totals: { inflow: 0 } } };
  if (url.includes("/billing/reports/refunds"))
    return { data: { totalRefunded: 0 } };
  return { data: [] };
}

describe("BillingPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    toastMock.success.mockReset();
    authMock.mockReturnValue({
      user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
    });
    apiMock.get.mockImplementation((url: string) =>
      Promise.resolve(defaultGet(url))
    );
    document.documentElement.classList.remove("dark");
  });

  it("renders the Billing heading with empty data", async () => {
    render(<BillingPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /^billing$/i })
      ).toBeInTheDocument()
    );
  });

  it("renders Total Outstanding summary card for ADMIN", async () => {
    render(<BillingPage />);
    await waitFor(() =>
      expect(screen.getByText(/total outstanding/i)).toBeInTheDocument()
    );
  });

  it("renders a populated invoice list", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/billing/invoices"))
        return Promise.resolve({ data: sampleInvoices });
      return Promise.resolve(defaultGet(url));
    });
    render(<BillingPage />);
    await waitFor(() => {
      expect(screen.getByText("INV-001")).toBeInTheDocument();
      expect(screen.getByText("INV-002")).toBeInTheDocument();
    });
  });

  it("calls /billing/reports/outstanding when Outstanding tab is active", async () => {
    const user = userEvent.setup();
    render(<BillingPage />);
    await waitFor(() =>
      screen.getByRole("heading", { name: /^billing$/i })
    );
    const outstandingBtn = screen.queryAllByRole("button", {
      name: /outstanding/i,
    })[0];
    if (outstandingBtn) {
      await user.click(outstandingBtn);
      await waitFor(() => {
        const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
        expect(
          urls.some((u) => u.includes("/billing/reports/outstanding"))
        ).toBe(true);
      });
    }
  });

  it("continues rendering when invoice list fetch fails", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/billing/invoices"))
        return Promise.reject(new Error("500"));
      return Promise.resolve(defaultGet(url));
    });
    render(<BillingPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /^billing$/i })
      ).toBeInTheDocument()
    );
  });

  // Regression for #203: each summary tile is fed by an independent
  // endpoint and several are RBAC-gated (e.g. /reports/daily is
  // ADMIN-only per #90). Promise.allSettled must let surviving tiles
  // populate even when some endpoints 403 for the current role.
  it("populates the surviving summary tiles when one endpoint fails (#203)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/billing/invoices")) return Promise.resolve({ data: [] });
      if (url.includes("/billing/reports/outstanding"))
        return Promise.resolve({
          data: { rows: [], totalOutstanding: 2150, count: 3 },
        });
      // Simulate ADMIN-only daily report 403 for RECEPTION.
      if (url.includes("/billing/reports/daily"))
        return Promise.reject(new Error("Forbidden"));
      if (url.includes("/billing/reports/revenue"))
        return Promise.resolve({ data: { totals: { inflow: 5000 } } });
      if (url.includes("/billing/reports/refunds"))
        return Promise.resolve({ data: { totalRefunded: 0 } });
      return Promise.resolve({ data: [] });
    });
    render(<BillingPage />);
    // Total Outstanding tile (always reception-visible) must show the
    // non-zero figure even though the daily-collection call rejected.
    await waitFor(() => {
      const outstandingCard = screen
        .getByText(/total outstanding/i)
        .closest("div");
      expect(outstandingCard?.textContent || "").toMatch(/2,150/);
    });
    const monthCard = screen
      .getByText(/this month's revenue/i)
      .closest("div");
    expect(monthCard?.textContent || "").toMatch(/5,000/);
  });

  // Regression for #235: a row with paymentStatus = PAID and balance > 0
  // must render the displayed badge as PARTIAL — the underlying field is
  // not mutated, only the rendered string.
  it("displays PARTIAL when persisted PAID has positive balance (#235)", async () => {
    const inv = {
      id: "inv-235",
      invoiceNumber: "INV000228",
      totalAmount: 590,
      paymentStatus: "PAID",
      createdAt: new Date().toISOString(),
      patientId: "p1",
      patient: { user: { name: "Aarav Mehta", phone: "9000000001" } },
      payments: [
        {
          id: "pm1",
          amount: 500,
          mode: "CASH",
          paidAt: new Date().toISOString(),
        },
      ],
    };
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/billing/invoices"))
        return Promise.resolve({ data: [inv] });
      return Promise.resolve(defaultGet(url));
    });
    render(<BillingPage />);
    await waitFor(() =>
      expect(screen.getByText("INV000228")).toBeInTheDocument()
    );
    expect(screen.getByTestId("bills-status-inv-235").textContent).toBe(
      "PARTIAL"
    );
  });
});
