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
  usePathname: () => "/dashboard/calendar",
}));

import UnifiedCalendarPage from "../calendar/page";

function asAdmin() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

describe("UnifiedCalendarPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.get.mockResolvedValue({ data: [] });
  });

  it("smoke renders the Calendar heading for ADMIN", async () => {
    asAdmin();
    render(<UnifiedCalendarPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /^calendar$/i })
      ).toBeInTheDocument()
    );
  });

  it("renders the Day/Week/Month view-mode toggle", async () => {
    asAdmin();
    render(<UnifiedCalendarPage />);
    await waitFor(() =>
      expect(screen.getByTestId("cal-view-day")).toBeInTheDocument()
    );
    expect(screen.getByTestId("cal-view-week")).toBeInTheDocument();
    expect(screen.getByTestId("cal-view-month")).toBeInTheDocument();
  });

  it("renders the month-grid view by default", async () => {
    asAdmin();
    render(<UnifiedCalendarPage />);
    await waitFor(() =>
      expect(screen.getByTestId("cal-month-view")).toBeInTheDocument()
    );
  });

  it("calls the appointments endpoint on mount", async () => {
    asAdmin();
    render(<UnifiedCalendarPage />);
    await waitFor(() => {
      const urls = apiMock.get.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes("/appointments"))).toBe(true);
    });
  });

  it("keeps rendering when every endpoint rejects", async () => {
    asAdmin();
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<UnifiedCalendarPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /^calendar$/i })
      ).toBeInTheDocument()
    );
  });
});
