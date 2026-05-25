/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, toastMock, socketMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  socketMock: { connect: vi.fn(), disconnect: vi.fn(), emit: vi.fn(), on: vi.fn(), off: vi.fn(), connected: false },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/socket", () => ({ getSocket: () => socketMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/ot",
}));

import OTPage from "../ot/page";

const sampleOts = [
  { id: "ot1", name: "OT-1", floor: "2", equipment: "Laminar", dailyRate: 5000, isActive: true },
  { id: "ot2", name: "OT-2", floor: "2", equipment: null, dailyRate: 4000, isActive: false },
];

describe("OTPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" } };
      return typeof selector === "function" ? selector(state) : state;
    });
    apiMock.get.mockResolvedValue({ data: [] });
  });

  it("renders OT heading with empty data", async () => {
    render(<OTPage />);
    await waitFor(() => {
      expect(screen.getAllByRole("heading").length).toBeGreaterThan(0);
    });
  });

  it("renders populated OTs", async () => {
    apiMock.get.mockResolvedValue({ data: sampleOts });
    render(<OTPage />);
    await waitFor(() => {
      expect(screen.getAllByText(/OT-1/).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/OT-2/).length).toBeGreaterThan(0);
    });
  });

  it("shows loading state while fetching", async () => {
    // Issue (2026-05-23, Pearl §7.2 wave 6): the literal "Loading..." text
    // node was replaced with a <SkeletonTable /> wrapped in
    // `data-testid="ot-loading" aria-busy="true"`. Assert against the
    // skeleton's testid + aria-busy instead of the removed text — both are
    // stable contract elements rendered by ot/page.tsx.
    let resolve: (v: any) => void = () => {};
    apiMock.get.mockImplementation(() => new Promise((r) => { resolve = r; }));
    render(<OTPage />);
    const loadingRegion = await screen.findByTestId("ot-loading");
    expect(loadingRegion).toBeInTheDocument();
    expect(loadingRegion).toHaveAttribute("aria-busy", "true");
    resolve({ data: [] });
  });

  it("keeps rendering when API returns an error", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<OTPage />);
    // Page still mounts
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalled();
    });
  });

  it("fetches /surgery/ots on mount", async () => {
    render(<OTPage />);
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/surgery/ots"))).toBe(true);
    });
  });
});
