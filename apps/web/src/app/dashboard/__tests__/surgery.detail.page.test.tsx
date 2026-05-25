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
  usePathname: () => "/dashboard/surgery/test-id",
  useParams: () => ({ id: "test-id" }),
}));

import SurgeryDetailPage from "../surgery/[id]/page";

const sampleSurgery = {
  id: "sg1",
  caseNumber: "SG-001",
  procedure: "Appendectomy",
  status: "SCHEDULED",
  scheduledAt: new Date().toISOString(),
  durationMin: 60,
  actualStartAt: null,
  actualEndAt: null,
  preOpNotes: "",
  postOpNotes: "",
  diagnosis: "",
  patient: {
    id: "p1",
    mrNumber: "MR-1",
    age: 30,
    gender: "MALE",
    bloodGroup: "O+",
    user: { name: "Aarav Mehta", phone: "9000000001" },
  },
  surgeon: { user: { name: "Dr. Singh" }, specialization: "GS" },
  ot: { name: "OT-1", floor: "2", equipment: "", dailyRate: 5000 },
  anaesthesiologist: "Dr. Ankur",
  assistants: "Dr. B",
};

describe("SurgeryDetailPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.patch.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Doc", email: "d@x.com", role: "DOCTOR" } };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("shows loading state", async () => {
    apiMock.get.mockReturnValue(new Promise(() => {}));
    render(<SurgeryDetailPage />);
    const loader = await screen.findByTestId("surgery-detail-loading");
    expect(loader).toBeInTheDocument();
    expect(loader).toHaveAttribute("aria-busy", "true");
  });

  it("shows surgery-not-found on failure", async () => {
    apiMock.get.mockRejectedValue(new Error("404"));
    render(<SurgeryDetailPage />);
    await waitFor(() =>
      expect(screen.getByText(/surgery not found/i)).toBeInTheDocument()
    );
  });

  // Dispatch GETs by URL so child cards (observations list, anesthesia record,
  // etc.) receive the shape they expect instead of the top-level surgery object.
  function mockSurgeryGets() {
    apiMock.get.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/observations")) {
        return Promise.resolve({ data: [] });
      }
      if (typeof url === "string" && url.includes("/anesthesia-record")) {
        return Promise.resolve({ data: null });
      }
      return Promise.resolve({ data: sampleSurgery });
    });
  }

  it("renders populated surgery details", async () => {
    mockSurgeryGets();
    render(<SurgeryDetailPage />);
    await waitFor(() =>
      expect(screen.getAllByText(/SG-001/).length).toBeGreaterThan(0)
    );
    expect(screen.getAllByText(/appendectomy/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Aarav Mehta").length).toBeGreaterThan(0);
  });

  it("renders back link", async () => {
    mockSurgeryGets();
    render(<SurgeryDetailPage />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /back to surgery/i })).toBeInTheDocument()
    );
  });

  it("renders patient and surgeon sections", async () => {
    mockSurgeryGets();
    render(<SurgeryDetailPage />);
    await waitFor(() =>
      expect(screen.getAllByText(/dr\. singh/i).length).toBeGreaterThan(0)
    );
  });
});
