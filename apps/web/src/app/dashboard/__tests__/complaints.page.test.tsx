/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => vi.fn(async () => true),
  usePrompt: () => vi.fn(async () => "test"),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/complaints",
}));

import ComplaintsPage from "../complaints/page";

const sampleComplaint = {
  id: "c1",
  ticketNumber: "TKT-001",
  patientId: "p1",
  name: null,
  phone: null,
  category: "Service",
  description: "Long wait at OPD",
  status: "OPEN",
  priority: "HIGH",
  assignedTo: null,
  resolution: null,
  resolvedAt: null,
  createdAt: new Date().toISOString(),
  patient: { user: { name: "Aarav Mehta", phone: "9000000001" } },
};

const sampleStats = {
  total: 5,
  byStatus: { OPEN: 3, RESOLVED: 2 },
  byPriority: { HIGH: 1 },
  avgResolutionHours: 24,
  overdueCount: 1,
  totalOpen: 3,
  overdueUnassignedCount: 0,
  criticalOpen: 0,
};

describe("ComplaintsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/complaints?")) return Promise.resolve({ data: [] });
      if (url.startsWith("/complaints/stats"))
        return Promise.resolve({ data: sampleStats });
      if (url.startsWith("/chat/users")) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
  });

  it("smoke renders the page heading", async () => {
    render(<ComplaintsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /complaints/i })
      ).toBeInTheDocument()
    );
  });

  it("renders the empty-state when no complaints in the active tab", async () => {
    render(<ComplaintsPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/no complaints in this category/i)
      ).toBeInTheDocument()
    );
  });

  it("renders rows when complaints exist", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/complaints?"))
        return Promise.resolve({ data: [sampleComplaint] });
      if (url.startsWith("/complaints/stats"))
        return Promise.resolve({ data: sampleStats });
      if (url.startsWith("/chat/users")) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    render(<ComplaintsPage />);
    await waitFor(() =>
      expect(screen.getByText(/TKT-001/)).toBeInTheDocument()
    );
    expect(screen.getByText(/aarav mehta/i)).toBeInTheDocument();
  });

  it("renders the KPI cards with stat totals", async () => {
    render(<ComplaintsPage />);
    await waitFor(() =>
      expect(screen.getByTestId("complaints-total-open")).toBeInTheDocument()
    );
    expect(screen.getByTestId("complaints-total-open").textContent).toBe("3");
  });

  it("keeps rendering when the complaints/stats endpoints reject", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<ComplaintsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /complaints/i })
      ).toBeInTheDocument()
    );
  });
});
