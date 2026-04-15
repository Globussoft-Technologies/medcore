/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, socketMock } = vi.hoisted(() => {
  const socket = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    connected: true,
  };
  return {
    apiMock: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
    authMock: vi.fn(),
    socketMock: socket,
  };
});

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/socket", () => ({ getSocket: () => socketMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/emergency",
}));

import EmergencyPage from "../emergency/page";

const stats = {
  totalActive: 5,
  totalWaiting: 2,
  byTriage: {
    RESUSCITATION: 1,
    EMERGENT: 1,
    URGENT: 1,
    LESS_URGENT: 1,
    NON_URGENT: 1,
  },
  avgWaitMin: 14,
  availableBeds: 3,
};

const cases = [
  {
    id: "c1",
    caseNumber: "ER-001",
    arrivedAt: new Date().toISOString(),
    chiefComplaint: "Chest pain",
    status: "WAITING",
    triageLevel: "EMERGENT" as const,
    patient: {
      id: "p1",
      mrNumber: "MR-1",
      user: { name: "Aarav Mehta", phone: "9000000001" },
    },
  },
];

describe("EmergencyPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    authMock.mockReturnValue({
      user: { id: "u1", name: "Nurse", email: "n@x.com", role: "NURSE" },
    });
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/emergency/cases/active"))
        return Promise.resolve({ data: [] });
      if (url.includes("/emergency/stats"))
        return Promise.resolve({ data: null });
      if (url.includes("/doctors")) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    document.documentElement.classList.remove("dark");
  });

  it("renders the Emergency Department heading on empty data", async () => {
    render(<EmergencyPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /emergency department/i })
      ).toBeInTheDocument()
    );
  });

  it("renders triage colour bands when stats load", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/emergency/stats"))
        return Promise.resolve({ data: stats });
      if (url.includes("/emergency/cases/active"))
        return Promise.resolve({ data: [] });
      if (url.includes("/doctors")) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    render(<EmergencyPage />);
    await waitFor(() => {
      expect(screen.getByText(/RESUSCITATION/)).toBeInTheDocument();
      expect(screen.getByText(/EMERGENT/)).toBeInTheDocument();
    });
  });

  it("renders an active case when data is present", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/emergency/stats"))
        return Promise.resolve({ data: stats });
      if (url.includes("/emergency/cases/active"))
        return Promise.resolve({ data: cases });
      if (url.includes("/doctors")) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    render(<EmergencyPage />);
    await waitFor(() =>
      expect(screen.getByText(/Chest pain/i)).toBeInTheDocument()
    );
  });

  it("opens the intake modal when Register New Case is clicked", async () => {
    const user = userEvent.setup();
    render(<EmergencyPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /register new case/i })
    );
    await user.click(
      screen.getByRole("button", { name: /register new case/i })
    );
    // Chief complaint field appears in the intake modal
    await waitFor(() => {
      const chief = screen.queryByText(/chief complaint/i);
      expect(chief).not.toBeNull();
    });
  });

  it("keeps rendering when API returns an error", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<EmergencyPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /emergency department/i })
      ).toBeInTheDocument()
    );
  });
});
