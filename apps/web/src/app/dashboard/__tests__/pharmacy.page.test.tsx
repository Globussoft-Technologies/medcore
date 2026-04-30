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

vi.mock("@/lib/api", () => ({ api: apiMock, openPrintEndpoint: vi.fn() }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/pharmacy",
}));

import PharmacyPage from "../pharmacy/page";

const sampleItems = [
  {
    id: "i1",
    batchNumber: "B-001",
    quantity: 50,
    sellingPrice: 12.5,
    expiryDate: new Date(Date.now() + 86400000 * 180).toISOString(),
    reorderLevel: 10,
    medicine: { id: "m1", name: "Paracetamol", genericName: "Acetaminophen" },
  },
  {
    id: "i2",
    batchNumber: "B-002",
    quantity: 5,
    sellingPrice: 45,
    expiryDate: new Date(Date.now() + 86400000 * 20).toISOString(),
    reorderLevel: 10,
    medicine: { id: "m2", name: "Amoxicillin" },
  },
];

describe("PharmacyPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" } };
      return typeof selector === "function" ? selector(state) : state;
    });
    apiMock.get.mockResolvedValue({ data: [] });
  });

  it("renders Pharmacy heading with empty inventory", async () => {
    render(<PharmacyPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /pharmacy/i })).toBeInTheDocument()
    );
    await waitFor(() =>
      expect(screen.getByText(/no inventory items/i)).toBeInTheDocument()
    );
  });

  it("renders populated inventory rows", async () => {
    apiMock.get.mockResolvedValue({ data: sampleItems });
    render(<PharmacyPage />);
    await waitFor(() => {
      expect(screen.getAllByText("Paracetamol").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Amoxicillin").length).toBeGreaterThan(0);
    });
  });

  it("shows loading state while fetching", async () => {
    // #367 (commit 34e8e79) replaced the "Loading..." text on Returns/
    // Transfers tabs with skeleton rows. The Pharmacy heading is what
    // mounts immediately while the inventory promise is in flight —
    // assert that, then release the mock.
    let resolve: (v: any) => void = () => {};
    apiMock.get.mockImplementation(() => new Promise((r) => { resolve = r; }));
    render(<PharmacyPage />);
    expect(
      await screen.findByRole("heading", { name: /pharmacy/i })
    ).toBeInTheDocument();
    resolve({ data: [] });
  });

  it("keeps rendering when API returns an error", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<PharmacyPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /pharmacy/i })).toBeInTheDocument()
    );
  });

  it("switches to Low Stock tab and refetches with lowStock filter", async () => {
    const user = userEvent.setup();
    render(<PharmacyPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /pharmacy/i })).toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: /low stock/i }));
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("lowStock=true"))).toBe(true);
    });
  });

  it("opens the Add Stock modal for ADMIN role", async () => {
    const user = userEvent.setup();
    render(<PharmacyPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /add stock/i })
    );
    await user.click(screen.getByRole("button", { name: /add stock/i }));
    expect(
      screen.getAllByRole("heading", { name: /add stock/i }).length
    ).toBeGreaterThan(0);
  });
});
