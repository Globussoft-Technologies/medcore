/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { apiMock, authMock, toastMock, routerPush } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  routerPush: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/broadcasts",
}));

import BroadcastsPage from "../broadcasts/page";

function asAdmin() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

function asNurse() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u2", name: "Nurse", email: "n@x.com", role: "NURSE" },
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

describe("BroadcastsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    routerPush.mockReset();
    apiMock.get.mockResolvedValue({ data: [] });
  });

  it("smoke renders the page heading for ADMIN", async () => {
    asAdmin();
    render(<BroadcastsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /^broadcasts$/i })
      ).toBeInTheDocument()
    );
  });

  it("renders the empty broadcast history message", async () => {
    asAdmin();
    render(<BroadcastsPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/no broadcasts sent yet/i)
      ).toBeInTheDocument()
    );
  });

  it("renders a populated broadcast history table", async () => {
    asAdmin();
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/notifications/broadcasts"))
        return Promise.resolve({
          data: [
            {
              id: "b1",
              title: "System maintenance",
              message: "Scheduled downtime tonight",
              audience: JSON.stringify({ roles: ["DOCTOR"] }),
              sentCount: 12,
              failedCount: 0,
              createdBy: "admin",
              createdAt: new Date().toISOString(),
            },
          ],
        });
      return Promise.resolve({ data: [] });
    });
    render(<BroadcastsPage />);
    await waitFor(() =>
      expect(screen.getByText(/system maintenance/i)).toBeInTheDocument()
    );
  });

  it("redirects NURSE to /dashboard (admin-only)", async () => {
    asNurse();
    render(<BroadcastsPage />);
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/dashboard")
    );
  });

  it("keeps rendering when broadcast list fetch fails", async () => {
    asAdmin();
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<BroadcastsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /^broadcasts$/i })
      ).toBeInTheDocument()
    );
  });
});
