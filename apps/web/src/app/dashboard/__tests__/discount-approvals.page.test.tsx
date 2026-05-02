/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { apiMock, toastMock, confirmFn, promptFn } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  confirmFn: vi.fn(async () => true),
  promptFn: vi.fn(async () => "rejection reason"),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => confirmFn,
  usePrompt: () => promptFn,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/discount-approvals",
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));

import DiscountApprovalsPage from "../discount-approvals/page";

const sampleRow = {
  id: "appr-1",
  amount: 500,
  percentage: 10,
  reason: "Senior citizen",
  status: "PENDING",
  createdAt: new Date().toISOString(),
  rejectionReason: null,
  invoice: {
    id: "inv-1",
    invoiceNumber: "INV-001",
    totalAmount: 5000,
    patient: {
      mrNumber: "MR-1",
      user: { name: "Aarav Mehta", phone: "9000000001" },
    },
  },
};

describe("DiscountApprovalsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.get.mockResolvedValue({ data: [] });
  });

  it("smoke renders the page heading", async () => {
    render(<DiscountApprovalsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /discount approvals/i })
      ).toBeInTheDocument()
    );
  });

  it("renders the empty-state when no pending approvals", async () => {
    render(<DiscountApprovalsPage />);
    await waitFor(() =>
      expect(screen.getByText(/no pending approvals/i)).toBeInTheDocument()
    );
  });

  it("renders rows when approvals exist", async () => {
    apiMock.get.mockResolvedValue({ data: [sampleRow] });
    render(<DiscountApprovalsPage />);
    await waitFor(() =>
      expect(screen.getByText(/INV-001/)).toBeInTheDocument()
    );
    expect(screen.getByText(/aarav mehta/i)).toBeInTheDocument();
  });

  it("renders Pending/Approved/Rejected tab buttons", async () => {
    render(<DiscountApprovalsPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /pending/i })).toBeInTheDocument()
    );
    expect(screen.getByRole("button", { name: /approved/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /rejected/i })).toBeInTheDocument();
  });

  it("keeps rendering when the discount-approvals endpoint rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<DiscountApprovalsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /discount approvals/i })
      ).toBeInTheDocument()
    );
  });
});
