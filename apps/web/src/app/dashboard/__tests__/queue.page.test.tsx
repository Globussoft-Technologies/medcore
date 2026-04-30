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
    connected: false,
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
  usePathname: () => "/dashboard/queue",
}));

import QueuePage from "../queue/page";

const doctorDisplay = [
  {
    doctorId: "d1",
    doctorName: "Dr. Singh",
    specialization: "GP",
    currentToken: 5,
    waitingCount: 3,
  },
  {
    doctorId: "d2",
    doctorName: "Dr. Gupta",
    specialization: "Pediatrics",
    currentToken: null,
    waitingCount: 0,
  },
];

const doctorQueue = {
  doctorId: "d1",
  date: new Date().toISOString(),
  currentToken: 5,
  totalInQueue: 2,
  queue: [
    {
      tokenNumber: 6,
      patientName: "Aarav Mehta",
      appointmentId: "apt1",
      type: "REGULAR",
      status: "BOOKED",
      priority: "NORMAL",
      slotTime: "10:00",
      hasVitals: false,
      estimatedWaitMinutes: 10,
    },
  ],
};

describe("QueuePage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = {
        user: { id: "u1", name: "Rec", email: "r@x.com", role: "RECEPTION" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
    apiMock.get.mockResolvedValue({ data: [] });
    document.documentElement.classList.remove("dark");
  });

  it("renders Live Queue heading on empty data", async () => {
    render(<QueuePage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /live queue/i })
      ).toBeInTheDocument()
    );
  });

  it("renders doctor token cards when data is loaded", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/queue") return Promise.resolve({ data: doctorDisplay });
      return Promise.resolve({ data: [] });
    });
    render(<QueuePage />);
    await waitFor(() => {
      expect(screen.getByText("Dr. Singh")).toBeInTheDocument();
      expect(screen.getByText("Dr. Gupta")).toBeInTheDocument();
    });
  });

  it("clicking a doctor card fetches queue detail", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/queue") return Promise.resolve({ data: doctorDisplay });
      if (/^\/queue\/[^?]/.test(url) && url !== "/queue")
        return Promise.resolve({ data: doctorQueue });
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<QueuePage />);
    await waitFor(() => screen.getAllByText("Dr. Singh")[0]);
    await user.click(screen.getAllByText("Dr. Singh")[0]);
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.startsWith("/queue/d1"))).toBe(true);
    });
  });

  it("renders without crashing when queue data is loaded", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/queue") return Promise.resolve({ data: doctorDisplay });
      if (/^\/queue\/[^?]/.test(url) && url !== "/queue")
        return Promise.resolve({ data: doctorQueue });
      return Promise.resolve({ data: [] });
    });
    const { container } = render(<QueuePage />);
    await waitFor(() => screen.getAllByText("Dr. Singh")[0]);
    expect(container).toBeTruthy();
  });

  it("keeps rendering when queue fetch rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<QueuePage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /live queue/i })
      ).toBeInTheDocument()
    );
  });

  // Issue #430: even if Socket.IO is silent (proxy / network policy / nurse
  // role not subscribed), a 30s fallback poll must keep `/queue` fresh.
  it("polls /queue every 30s as a fallback (#430)", async () => {
    vi.useFakeTimers();
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/queue") return Promise.resolve({ data: doctorDisplay });
      return Promise.resolve({ data: [] });
    });
    render(<QueuePage />);
    // Initial load
    await vi.waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.filter((u) => u === "/queue").length).toBe(1);
    });
    // Advance 30s — the fallback `setInterval` should fire one more
    // `/queue` request.
    apiMock.get.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u === "/queue")).toBe(true);
    vi.useRealTimers();
  });
});
