/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

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
  socketMock: {
    connected: true,
    connect: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/socket", () => ({ getSocket: () => socketMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/telemedicine/waiting-room",
}));

import TelemedicineWaitingRoomPage from "../telemedicine/waiting-room/page";

const sessions = [
  {
    id: "s1",
    sessionNumber: "TC-001",
    scheduledAt: new Date().toISOString(),
    meetingUrl: null,
    status: "SCHEDULED",
    doctor: { user: { name: "Asha Gupta" }, specialization: "Cardiology" },
  },
];

describe("TelemedicineWaitingRoomPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Pat", email: "p@x.com", role: "PATIENT" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders Telemedicine Waiting Room heading (smoke)", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<TelemedicineWaitingRoomPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /telemedicine waiting room/i })
      ).toBeInTheDocument()
    );
  });

  it("populates session picker from API", async () => {
    apiMock.get.mockResolvedValue({ data: sessions });
    render(<TelemedicineWaitingRoomPage />);
    await waitFor(() =>
      expect(screen.getAllByText(/TC-001/).length).toBeGreaterThan(0)
    );
  });

  it("renders empty placeholder option when no sessions", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<TelemedicineWaitingRoomPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/pick an upcoming session/i)
      ).toBeInTheDocument()
    );
  });

  it("keeps rendering when API rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<TelemedicineWaitingRoomPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /telemedicine waiting room/i })
      ).toBeInTheDocument()
    );
  });

  it("renders Run Device Test button", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<TelemedicineWaitingRoomPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /run device test/i })
      ).toBeInTheDocument()
    );
  });
});
