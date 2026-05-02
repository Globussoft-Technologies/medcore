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
  usePathname: () => "/dashboard/leave-calendar",
}));

import LeaveCalendarPage from "../leave-calendar/page";

const today = new Date();
const sample = [
  {
    id: "l1",
    userId: "u9",
    type: "CASUAL",
    fromDate: new Date(today.getFullYear(), today.getMonth(), 1).toISOString(),
    toDate: new Date(today.getFullYear(), today.getMonth(), 3).toISOString(),
    totalDays: 3,
    reason: "Trip",
    status: "APPROVED",
    user: { id: "u9", name: "Anita Pawar", role: "NURSE" },
  },
];

describe("LeaveCalendarPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    routerPush.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders Leave Calendar heading", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<LeaveCalendarPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /leave calendar/i })
      ).toBeInTheDocument()
    );
  });

  it("renders leave entry name on calendar cell", async () => {
    apiMock.get.mockResolvedValue({ data: sample });
    render(<LeaveCalendarPage />);
    await waitFor(() =>
      expect(
        screen.getAllByText(/anita pawar/i).length
      ).toBeGreaterThan(0)
    );
  });

  it("renders empty calendar grid with no leaves", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<LeaveCalendarPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /leave calendar/i })
      ).toBeInTheDocument()
    );
    // Weekday headers live INSIDE the calendar grid which sits behind the
    // page's `loading` flag (line 184 of page.tsx) — the heading renders
    // immediately but "Mon" only appears after `apiMock.get` resolves and
    // setLoading(false) runs. Wrap in `waitFor` so we ride out the async
    // resolve, otherwise this is a CI-timing flake.
    await waitFor(() =>
      expect(screen.getByText("Mon")).toBeInTheDocument()
    );
  });

  it("keeps rendering when API rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<LeaveCalendarPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /leave calendar/i })
      ).toBeInTheDocument()
    );
  });

  it("redirects non-ADMIN role away from page", async () => {
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u2", name: "Doc", email: "d@x.com", role: "DOCTOR" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
    render(<LeaveCalendarPage />);
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/dashboard")
    );
  });
});
