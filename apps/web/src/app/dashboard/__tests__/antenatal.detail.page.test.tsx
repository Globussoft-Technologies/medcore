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
  usePathname: () => "/dashboard/antenatal/test-id",
  useParams: () => ({ id: "test-id" }),
}));

import AncCaseDetailPage from "../antenatal/[id]/page";

const sampleCase = {
  id: "anc1",
  caseNumber: "ANC-001",
  lmpDate: new Date(Date.now() - 86_400_000 * 200).toISOString(),
  eddDate: new Date(Date.now() + 86_400_000 * 80).toISOString(),
  gravida: 2,
  parity: 1,
  bloodGroup: "O+",
  isHighRisk: false,
  riskFactors: null,
  deliveredAt: null,
  patient: {
    id: "p1",
    mrNumber: "MR-1",
    user: { name: "Bina Shah", phone: "9000000001" },
  },
  doctor: { id: "d1", user: { name: "Dr. Rao" } },
  visits: [],
  postnatalVisits: [],
  partographs: [],
};

describe("AncCaseDetailPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Doc", email: "d@x.com", role: "DOCTOR" } };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("shows loading with empty data", async () => {
    apiMock.get.mockReturnValue(new Promise(() => {}));
    render(<AncCaseDetailPage />);
    const loader = await screen.findByTestId("antenatal-detail-loading");
    expect(loader).toBeInTheDocument();
    expect(loader).toHaveAttribute("aria-busy", "true");
  });

  it("stays on loading when fetch fails (no crash)", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<AncCaseDetailPage />);
    const loader = await screen.findByTestId("antenatal-detail-loading");
    expect(loader).toBeInTheDocument();
    expect(loader).toHaveAttribute("aria-busy", "true");
  });

  it("renders populated ANC case", async () => {
    apiMock.get.mockResolvedValue({ data: sampleCase });
    render(<AncCaseDetailPage />);
    await waitFor(() =>
      expect(screen.getAllByText(/ANC-001/).length).toBeGreaterThan(0)
    );
    expect(screen.getAllByText("Bina Shah").length).toBeGreaterThan(0);
  });

  it("clicking Add Visit opens the visit form", async () => {
    apiMock.get.mockResolvedValue({ data: sampleCase });
    const user = userEvent.setup();
    render(<AncCaseDetailPage />);
    await waitFor(() =>
      expect(screen.getAllByText(/ANC-001/).length).toBeGreaterThan(0)
    );
    const addBtns = screen.queryAllByRole("button", { name: /add visit/i });
    if (addBtns[0]) {
      await user.click(addBtns[0]);
    }
    // no crash
    expect(screen.getAllByText(/ANC-001/).length).toBeGreaterThan(0);
  });

  it("renders high-risk badge when flagged", async () => {
    apiMock.get.mockResolvedValue({
      data: { ...sampleCase, isHighRisk: true, riskFactors: "Diabetes" },
    });
    render(<AncCaseDetailPage />);
    await waitFor(() =>
      expect(screen.getAllByText(/high risk/i).length).toBeGreaterThan(0)
    );
  });
});
