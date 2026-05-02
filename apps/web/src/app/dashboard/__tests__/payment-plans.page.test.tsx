/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

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
vi.mock("@/components/EntityPicker", () => ({
  EntityPicker: () => <div data-testid="entity-picker-mock" />,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/payment-plans",
}));

import PaymentPlansPage from "../payment-plans/page";

const plans = [
  {
    id: "p1",
    planNumber: "PP-001",
    totalAmount: 10000,
    downPayment: 1000,
    installments: 6,
    installmentAmount: 1500,
    frequency: "MONTHLY",
    startDate: new Date().toISOString(),
    status: "ACTIVE",
    paidCount: 2,
    nextDue: new Date().toISOString(),
    invoice: { id: "inv1", invoiceNumber: "INV-1", totalAmount: 10000 },
    patient: {
      id: "pat1",
      mrNumber: "MR-1",
      user: { name: "Aarav Mehta", phone: "9000000001" },
    },
    installmentRecords: [],
  },
];

describe("PaymentPlansPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders Payment Plans heading", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<PaymentPlansPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /payment plans/i })
      ).toBeInTheDocument()
    );
  });

  it("renders populated plan list", async () => {
    apiMock.get.mockResolvedValue({ data: plans });
    render(<PaymentPlansPage />);
    await waitFor(() => expect(screen.getByText("PP-001")).toBeInTheDocument());
    expect(screen.getByText("Aarav Mehta")).toBeInTheDocument();
  });

  it("shows 'No plans in this category' empty state", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<PaymentPlansPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/no plans in this category/i)
      ).toBeInTheDocument()
    );
  });

  it("keeps rendering when API rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<PaymentPlansPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /payment plans/i })
      ).toBeInTheDocument()
    );
  });

  it("hides New Plan button for unauthorized role (NURSE)", async () => {
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u9", name: "Nurse", email: "n@x.com", role: "NURSE" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
    apiMock.get.mockResolvedValue({ data: [] });
    render(<PaymentPlansPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /payment plans/i })
      ).toBeInTheDocument()
    );
    expect(screen.queryByTestId("open-new-plan")).not.toBeInTheDocument();
  });
});
