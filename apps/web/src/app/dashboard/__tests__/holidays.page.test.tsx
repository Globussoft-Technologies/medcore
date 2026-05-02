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
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => vi.fn(async () => true),
  usePrompt: () => vi.fn(async () => ""),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/holidays",
}));

import HolidaysPage from "../holidays/page";

const sampleHolidays = [
  {
    id: "h1",
    date: "2026-01-26",
    name: "Republic Day",
    type: "PUBLIC",
    description: "National holiday",
  },
  {
    id: "h2",
    date: "2026-08-15",
    name: "Independence Day",
    type: "PUBLIC",
  },
];

describe("HolidaysPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.delete.mockReset();
    routerPush.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders Holidays heading for ADMIN", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<HolidaysPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /holidays/i })
      ).toBeInTheDocument()
    );
  });

  it("renders populated holiday rows", async () => {
    apiMock.get.mockResolvedValue({ data: sampleHolidays });
    render(<HolidaysPage />);
    await waitFor(() =>
      expect(screen.getByText("Republic Day")).toBeInTheDocument()
    );
    expect(screen.getByText("Independence Day")).toBeInTheDocument();
  });

  it("shows empty state when no holidays configured", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<HolidaysPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/no holidays configured/i)
      ).toBeInTheDocument()
    );
  });

  it("keeps rendering when fetch rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<HolidaysPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /holidays/i })
      ).toBeInTheDocument()
    );
  });

  it("redirects non-ADMIN role away from page", async () => {
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u2", name: "Nurse", email: "n@x.com", role: "NURSE" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
    apiMock.get.mockResolvedValue({ data: [] });
    render(<HolidaysPage />);
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/dashboard")
    );
  });
});
