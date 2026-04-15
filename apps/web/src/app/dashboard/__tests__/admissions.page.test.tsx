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
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/admissions",
}));

import AdmissionsPage from "../admissions/page";

const sampleAdmissions = [
  {
    id: "adm1",
    admissionNumber: "ADM-001",
    admittedAt: new Date(Date.now() - 86_400_000 * 2).toISOString(),
    status: "ADMITTED",
    reason: "Observation",
    diagnosis: "Dengue",
    patient: {
      id: "p1",
      mrNumber: "MR-1",
      user: { name: "Aarav Mehta", phone: "9000000001" },
    },
    doctor: { id: "d1", user: { name: "Dr. Singh" } },
    bed: { id: "b1", bedNumber: "B-101", ward: { id: "w1", name: "General" } },
  },
  {
    id: "adm2",
    admissionNumber: "ADM-002",
    admittedAt: new Date(Date.now() - 86_400_000).toISOString(),
    status: "ADMITTED",
    reason: "Surgery",
    patient: {
      id: "p2",
      mrNumber: "MR-2",
      user: { name: "Bina Shah", phone: "9000000002" },
    },
    doctor: { id: "d1", user: { name: "Dr. Singh" } },
    bed: { id: "b2", bedNumber: "B-102", ward: { id: "w1", name: "General" } },
  },
];

describe("AdmissionsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    authMock.mockReturnValue({
      user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
    });
    apiMock.get.mockResolvedValue({ data: [] });
    document.documentElement.classList.remove("dark");
  });

  it("renders heading with empty data", async () => {
    render(<AdmissionsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /^admissions$/i })
      ).toBeInTheDocument()
    );
  });

  it("renders DataTable rows for populated admissions", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/admissions"))
        return Promise.resolve({ data: sampleAdmissions });
      return Promise.resolve({ data: [] });
    });
    render(<AdmissionsPage />);
    await waitFor(() => {
      expect(screen.getAllByText("ADM-001").length).toBeGreaterThan(0);
      expect(screen.getAllByText("ADM-002").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Aarav Mehta").length).toBeGreaterThan(0);
    });
  });

  it("shows Admit Patient action for ADMIN role", async () => {
    render(<AdmissionsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /admit patient/i })
      ).toBeInTheDocument()
    );
  });

  it("opens the admit modal when button is clicked", async () => {
    const user = userEvent.setup();
    render(<AdmissionsPage />);
    await waitFor(() => screen.getAllByRole("button", { name: /admit patient/i })[0]);
    await user.click(screen.getAllByRole("button", { name: /admit patient/i })[0]);
    // Modal fetches doctors + wards lazily; still ok if page stays mounted.
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      const hasDoctors = urls.some((u) => u.includes("/doctors"));
      const hasWards = urls.some((u) => u.includes("/wards"));
      expect(hasDoctors || hasWards).toBe(true);
    });
  });

  it("switches tabs and refetches with status filter", async () => {
    const user = userEvent.setup();
    render(<AdmissionsPage />);
    await waitFor(() =>
      screen.getByRole("heading", { name: /^admissions$/i })
    );
    await user.click(screen.getByRole("button", { name: /discharged/i }));
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("status=DISCHARGED"))).toBe(true);
    });
  });

  it("keeps rendering when API returns an error", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<AdmissionsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /^admissions$/i })
      ).toBeInTheDocument()
    );
  });
});
