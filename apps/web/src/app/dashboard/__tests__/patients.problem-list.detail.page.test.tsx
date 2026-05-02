/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { apiMock, authMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/patients/test-id/problem-list",
  useParams: () => ({ id: "test-id" }),
}));

import PatientProblemListPage from "../patients/[id]/problem-list/page";

const sample = [
  {
    id: "c1",
    type: "condition",
    title: "Hypertension",
    severity: "ACTIVE",
    status: "ACTIVE",
    lastUpdated: new Date().toISOString(),
    source: "Diagnosed 2024-05-12",
    icd10Code: "I10",
  },
  {
    id: "a1",
    type: "allergy",
    title: "Penicillin",
    severity: "SEVERE",
    status: "ACTIVE",
    lastUpdated: new Date().toISOString(),
    source: "Self-reported",
  },
];

describe("PatientProblemListPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Doc", email: "d@x.com", role: "DOCTOR" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders Consolidated Problem List heading", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<PatientProblemListPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /consolidated problem list/i })
      ).toBeInTheDocument()
    );
  });

  it("renders populated problem rows", async () => {
    apiMock.get.mockResolvedValue({ data: sample });
    render(<PatientProblemListPage />);
    await waitFor(() =>
      expect(screen.getByText("Hypertension")).toBeInTheDocument()
    );
    expect(screen.getByText("Penicillin")).toBeInTheDocument();
    expect(screen.getByText("I10")).toBeInTheDocument();
  });

  it("shows 'No problems found' empty state", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<PatientProblemListPage />);
    await waitFor(() =>
      expect(screen.getByText(/no problems found/i)).toBeInTheDocument()
    );
  });

  it("keeps rendering when API rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<PatientProblemListPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /consolidated problem list/i })
      ).toBeInTheDocument()
    );
  });

  it("renders Back-to-patient link", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<PatientProblemListPage />);
    await waitFor(() =>
      expect(screen.getByText(/back to patient/i)).toBeInTheDocument()
    );
  });
});
