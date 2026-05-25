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
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/purchase-orders/test-id",
  useParams: () => ({ id: "test-id" }),
}));

import PurchaseOrderDetailPage from "../purchase-orders/[id]/page";

const samplePO = {
  id: "po1",
  poNumber: "PO-0001",
  status: "PENDING",
  orderedAt: new Date().toISOString(),
  expectedAt: new Date(Date.now() + 86_400_000 * 7).toISOString(),
  receivedAt: null,
  createdAt: new Date().toISOString(),
  subtotal: 5000,
  tax: 900,
  taxAmount: 900,
  total: 5900,
  totalAmount: 5900,
  supplier: {
    id: "s1",
    name: "MediCorp",
    contactPerson: "Raj",
    phone: "9000000001",
    email: "raj@x.com",
    address: "Mumbai",
    gstNumber: "GST123",
  },
  items: [
    {
      id: "it1",
      description: "Syringes",
      quantity: 100,
      unitPrice: 50,
      total: 5000,
      amount: 5000,
      receivedQty: 0,
    },
  ],
};

describe("PurchaseOrderDetailPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" } };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("shows loading state", async () => {
    // Skeleton sweep wave 8 (2026-05-23): plain "Loading..." text was
    // replaced with `<SkeletonCard ×3 />` inside a wrapper carrying
    // `data-testid="purchase-order-detail-loading"` + `aria-busy="true"`.
    // Assert against the skeleton's testid + a11y attribute instead of
    // the removed text — both are stable, both are what assistive tech
    // actually consumes. Mirrors the wave-3 `users-loading` and wave-6
    // `ot-loading` patterns.
    apiMock.get.mockReturnValue(new Promise(() => {}));
    render(<PurchaseOrderDetailPage />);
    const loader = await screen.findByTestId("purchase-order-detail-loading");
    expect(loader).toBeInTheDocument();
    expect(loader).toHaveAttribute("aria-busy", "true");
  });

  it("shows PO-not-found on fetch failure", async () => {
    apiMock.get.mockRejectedValue(new Error("404"));
    render(<PurchaseOrderDetailPage />);
    await waitFor(() =>
      expect(screen.getByText(/purchase order not found/i)).toBeInTheDocument()
    );
  });

  it("renders populated PO", async () => {
    apiMock.get.mockResolvedValue({ data: samplePO });
    render(<PurchaseOrderDetailPage />);
    await waitFor(() =>
      expect(screen.getAllByText(/PO-0001/).length).toBeGreaterThan(0)
    );
    expect(screen.getAllByText(/MediCorp/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/syringes/i).length).toBeGreaterThan(0);
  });

  it("renders Print button for populated PO", async () => {
    apiMock.get.mockResolvedValue({ data: samplePO });
    render(<PurchaseOrderDetailPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /print/i })).toBeInTheDocument()
    );
  });

  it("renders Approve button when status is PENDING", async () => {
    apiMock.get.mockResolvedValue({ data: samplePO });
    render(<PurchaseOrderDetailPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument()
    );
  });
});
