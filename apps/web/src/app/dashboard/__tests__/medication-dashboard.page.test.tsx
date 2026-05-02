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
vi.mock("@/lib/use-dialog", () => ({
  usePrompt: () => vi.fn(async () => ""),
  useConfirm: () => vi.fn(async () => true),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/medication-dashboard",
}));

import MedicationDashboardPage from "../medication-dashboard/page";

const due = [
  {
    id: "due1",
    scheduledAt: new Date(Date.now() - 60_000).toISOString(),
    status: "PENDING",
    order: {
      id: "ord1",
      dosage: "500mg",
      route: "PO",
      medicine: { name: "Paracetamol", genericName: "Acetaminophen" },
      admission: {
        id: "adm1",
        patient: {
          user: { name: "Aarav Mehta" },
          mrNumber: "MR-1",
        },
        bed: { bedNumber: "B7", ward: { id: "w1", name: "Ward A" } },
      },
    },
  },
];

describe("MedicationDashboardPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.patch.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Nurse", email: "n@x.com", role: "NURSE" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders Medication Administration heading", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/medication/administrations/due"))
        return Promise.resolve({ data: [] });
      if (url.startsWith("/wards")) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    render(<MedicationDashboardPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /medication administration/i })
      ).toBeInTheDocument()
    );
  });

  it("renders due medication card with patient and medicine", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/medication/administrations/due"))
        return Promise.resolve({ data: due });
      if (url.startsWith("/wards")) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    render(<MedicationDashboardPage />);
    await waitFor(() =>
      expect(screen.getByText("Aarav Mehta")).toBeInTheDocument()
    );
    expect(screen.getByText(/paracetamol/i)).toBeInTheDocument();
  });

  it("shows 'No medications due' empty state", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/medication/administrations/due"))
        return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    render(<MedicationDashboardPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/no medications due/i)
      ).toBeInTheDocument()
    );
  });

  it("keeps rendering when API rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<MedicationDashboardPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /medication administration/i })
      ).toBeInTheDocument()
    );
  });
});
