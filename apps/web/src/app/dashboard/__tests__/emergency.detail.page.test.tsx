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
  usePathname: () => "/dashboard/emergency/test-id",
  useParams: () => ({ id: "test-id" }),
}));

import EmergencyCaseDetailPage from "../emergency/[id]/page";

const sampleCase = {
  id: "ec1",
  caseNumber: "ER-001",
  chiefComplaint: "Chest pain",
  triageLevel: "URGENT",
  status: "IN_TREATMENT",
  arrivedAt: new Date().toISOString(),
  triagedAt: new Date().toISOString(),
  seenAt: null,
  closedAt: null,
  attendingDoctorId: null,
  attendingDoctor: null,
  patient: {
    id: "p1",
    mrNumber: "MR-1",
    user: { name: "Aarav Mehta", phone: "9000000001" },
  },
  unknownName: null,
  unknownAge: null,
  unknownGender: null,
  arrivalMode: "WALK_IN",
  vitalsBP: "120/80",
  vitalsPulse: 80,
  vitalsResp: 16,
  vitalsSpO2: 98,
  vitalsTemp: 37,
  glasgowComa: 15,
  mewsScore: 1,
  rtsScore: null,
};

describe("EmergencyCaseDetailPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Doc", email: "d@x.com", role: "DOCTOR" } };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("shows loading state initially", async () => {
    // Skeleton sweep wave 8 (2026-05-23): plain "Loading..." text was
    // replaced with `<SkeletonCard ×3 />` inside a wrapper carrying
    // `data-testid="emergency-case-detail-loading"` + `aria-busy="true"`.
    // Assert against the skeleton's testid + a11y attribute instead of
    // the removed text — both are stable, both are what assistive tech
    // actually consumes. Mirrors the wave-3 `users-loading` and wave-6
    // `ot-loading` patterns.
    apiMock.get.mockReturnValue(new Promise(() => {}));
    render(<EmergencyCaseDetailPage />);
    const loader = await screen.findByTestId("emergency-case-detail-loading");
    expect(loader).toBeInTheDocument();
    expect(loader).toHaveAttribute("aria-busy", "true");
  });

  it("shows case-not-found on fetch failure", async () => {
    apiMock.get.mockRejectedValue(new Error("404"));
    render(<EmergencyCaseDetailPage />);
    await waitFor(() =>
      expect(screen.getByText(/case not found/i)).toBeInTheDocument()
    );
  });

  it("renders populated case fields", async () => {
    apiMock.get.mockResolvedValue({ data: sampleCase });
    render(<EmergencyCaseDetailPage />);
    await waitFor(() =>
      expect(screen.getAllByText("Aarav Mehta").length).toBeGreaterThan(0)
    );
    expect(screen.getAllByText(/chest pain/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ER-001/).length).toBeGreaterThan(0);
  });

  it("renders the back-to-ER link", async () => {
    apiMock.get.mockResolvedValue({ data: sampleCase });
    render(<EmergencyCaseDetailPage />);
    await waitFor(() =>
      expect(screen.getByText(/back to er board/i)).toBeInTheDocument()
    );
  });

  it("renders URGENT triage badge", async () => {
    apiMock.get.mockResolvedValue({ data: sampleCase });
    render(<EmergencyCaseDetailPage />);
    await waitFor(() =>
      expect(screen.getAllByText(/urgent/i).length).toBeGreaterThan(0)
    );
  });
});
