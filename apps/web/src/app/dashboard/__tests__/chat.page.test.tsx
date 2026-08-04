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
    connect: vi.fn(),
    disconnect: vi.fn(),
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    connected: false,
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/socket", () => ({ getSocket: () => socketMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/chat",
}));

import ChatPage from "../chat/page";

describe("ChatPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Dr", email: "d@x.com", role: "DOCTOR" } };
      return typeof selector === "function" ? selector(state) : state;
    });
    apiMock.get.mockResolvedValue({ data: [] });
  });

  it("renders chat page without crashing", async () => {
    render(<ChatPage />);
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalled();
    });
  });

  it("fetches rooms and users on mount", async () => {
    render(<ChatPage />);
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/chat/"))).toBe(true);
    });
  });

  it("renders populated rooms", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/chat/rooms"))
        return Promise.resolve({
          data: [
            {
              id: "r1",
              name: "General",
              isGroup: true,
              unreadCount: 0,
              participants: [],
              lastMessage: null,
              lastMessageAt: null,
            },
          ],
        });
      return Promise.resolve({ data: [] });
    });
    render(<ChatPage />);
    await waitFor(() => {
      expect(screen.getAllByText(/General/).length).toBeGreaterThan(0);
    });
  });

  it("keeps rendering when API returns an error", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<ChatPage />);
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalled();
    });
  });

  it("connects socket on mount", async () => {
    socketMock.connect.mockClear();
    render(<ChatPage />);
    await waitFor(() => {
      expect(socketMock.connect).toHaveBeenCalled();
    });
  });
});
