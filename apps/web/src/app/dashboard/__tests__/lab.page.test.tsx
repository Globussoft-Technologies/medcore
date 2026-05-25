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
  usePathname: () => "/dashboard/lab",
}));

import LabPage from "../lab/page";

const sampleOrders = [
  {
    id: "o1",
    orderNumber: "LO-001",
    orderedAt: new Date().toISOString(),
    status: "PENDING",
    stat: false,
    patient: { id: "p1", mrNumber: "MR-1", user: { name: "Asha Roy" } },
    doctor: { user: { name: "Dr. Singh" } },
    items: [{ id: "it1", status: "PENDING", test: { id: "t1", name: "CBC" } }],
  },
  {
    id: "o2",
    orderNumber: "LO-002",
    orderedAt: new Date().toISOString(),
    status: "COMPLETED",
    stat: true,
    patient: { id: "p2", mrNumber: "MR-2", user: { name: "Bhuvan Das" } },
    doctor: { user: { name: "Dr. Singh" } },
    items: [{ id: "it2", status: "COMPLETED", test: { id: "t2", name: "LFT" } }],
  },
];

describe("LabPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Dr", email: "d@x.com", role: "DOCTOR" } };
      return typeof selector === "function" ? selector(state) : state;
    });
    apiMock.get.mockResolvedValue({ data: [] });
  });

  it("renders Lab heading with empty data", async () => {
    render(<LabPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /^lab$/i })).toBeInTheDocument()
    );
    await waitFor(() =>
      expect(screen.getByText(/no lab orders/i)).toBeInTheDocument()
    );
  });

  it("renders populated orders", async () => {
    apiMock.get.mockResolvedValue({ data: sampleOrders });
    render(<LabPage />);
    await waitFor(() => {
      expect(screen.getAllByText(/LO-001/).length).toBeGreaterThan(0);
      expect(screen.getAllByText("Asha Roy").length).toBeGreaterThan(0);
    });
  });

  it("shows loading state while fetching", async () => {
    // Issue (2026-05-23): commit 78f9cfb swapped the literal "Loading..."
    // text node for a `<SkeletonTable />` wrapped in
    // `data-testid="lab-orders-list-loading" aria-busy="true"`. Assert
    // against the skeleton's testid + aria-busy instead of the removed
    // text — both are stable contract elements rendered by lab/page.tsx.
    let resolve: (v: any) => void = () => {};
    apiMock.get.mockImplementation(() => new Promise((r) => { resolve = r; }));
    render(<LabPage />);
    const loadingRegion = await screen.findByTestId("lab-orders-list-loading");
    expect(loadingRegion).toBeInTheDocument();
    expect(loadingRegion).toHaveAttribute("aria-busy", "true");
    resolve({ data: [] });
  });

  it("keeps rendering when API returns an error", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<LabPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /^lab$/i })).toBeInTheDocument()
    );
  });

  it("switches to Test Catalog tab and fetches tests", async () => {
    const user = userEvent.setup();
    render(<LabPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /^lab$/i })).toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: /test catalog/i }));
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/lab/tests"))).toBe(true);
    });
  });
});
