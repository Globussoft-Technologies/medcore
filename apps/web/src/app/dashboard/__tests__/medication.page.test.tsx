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
  usePathname: () => "/dashboard/medication-dashboard",
}));

// NOTE: the requested "medication" page does not exist — the real page lives at
// dashboard/medication-dashboard/page.tsx, so this file tests that page.
import MedicationDashboardPage from "../medication-dashboard/page";

const sampleDue = [
  {
    id: "a1",
    scheduledAt: new Date(Date.now() + 15 * 60000).toISOString(),
    status: "PENDING",
    order: {
      id: "o1",
      dosage: "500mg",
      route: "PO",
      medicine: { name: "Paracetamol" },
      admission: {
        id: "adm1",
        patient: { user: { name: "Asha Roy" }, mrNumber: "MR-1" },
        bed: { bedNumber: "B-101", ward: { id: "w1", name: "General" } },
      },
    },
  },
];

describe("MedicationDashboardPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.patch.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Nurse", email: "n@x.com", role: "NURSE" } };
      return typeof selector === "function" ? selector(state) : state;
    });
    apiMock.get.mockResolvedValue({ data: [] });
  });

  it("renders heading with empty data", async () => {
    render(<MedicationDashboardPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /medication administration/i })).toBeInTheDocument()
    );
    await waitFor(() =>
      expect(screen.getByText(/no medications due/i)).toBeInTheDocument()
    );
  });

  it("renders populated due administrations", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/medication/administrations/due"))
        return Promise.resolve({ data: sampleDue });
      return Promise.resolve({ data: [] });
    });
    render(<MedicationDashboardPage />);
    await waitFor(() => {
      expect(screen.getByText(/Asha Roy/)).toBeInTheDocument();
      expect(screen.getByText(/Paracetamol/)).toBeInTheDocument();
    });
  });

  it("shows loading state while fetching", async () => {
    let resolve: (v: any) => void = () => {};
    apiMock.get.mockImplementation(() => new Promise((r) => { resolve = r; }));
    render(<MedicationDashboardPage />);
    const loader = await screen.findByTestId("medication-dashboard-loading");
    expect(loader).toBeInTheDocument();
    expect(loader).toHaveAttribute("aria-busy", "true");
    resolve({ data: [] });
  });

  it("keeps rendering when API returns an error", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<MedicationDashboardPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /medication administration/i })).toBeInTheDocument()
    );
  });

  it("refreshes when Refresh button is clicked", async () => {
    const user = userEvent.setup();
    render(<MedicationDashboardPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /refresh/i })
    );
    const before = apiMock.get.mock.calls.length;
    await user.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => {
      expect(apiMock.get.mock.calls.length).toBeGreaterThan(before);
    });
  });
});
