/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
  usePathname: () => "/dashboard",
}));

import DashboardPage from "../page";

function emptyResponse(url: string) {
  // Mirror shapes the page expects
  if (url.includes("/wards") || url.includes("/queue") || url.includes("/cases/active"))
    return { data: [] };
  if (url.includes("/bloodbank/inventory/summary")) return { data: null };
  if (url.includes("/analytics/overview")) return { data: null };
  if (url.includes("/dashboard-preferences"))
    return { data: { layout: { widgets: [] } } };
  return { data: [], meta: { total: 0 } };
}

describe("DashboardPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.put.mockReset();
    apiMock.get.mockImplementation((url: string) =>
      Promise.resolve(emptyResponse(url))
    );
    apiMock.put.mockResolvedValue({ success: true });
    authMock.mockReturnValue({
      user: { id: "u1", name: "Sumit", email: "s@x.com", role: "ADMIN" },
      isLoading: false,
    });
    document.documentElement.classList.remove("dark");
  });

  it("renders welcome header without crashing on empty API responses", async () => {
    render(<DashboardPage />);
    await waitFor(() =>
      expect(screen.getByText(/welcome, sumit/i)).toBeInTheDocument()
    );
  });

  it("shows Customize Dashboard button for non-patient role", async () => {
    render(<DashboardPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /customize dashboard/i })
      ).toBeInTheDocument()
    );
  });

  it("shows role badge for logged-in user", async () => {
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText("ADMIN")).toBeInTheDocument());
  });

  it("opens customize modal when button is clicked", async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await waitFor(() =>
      screen.getByRole("button", { name: /customize dashboard/i })
    );
    await user.click(
      screen.getByRole("button", { name: /customize dashboard/i })
    );
    expect(screen.getByText(/toggle sections on or off/i)).toBeInTheDocument();
  });

  it("renders KPI cards with populated totals", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients")) return Promise.resolve({ data: [], meta: { total: 42 } });
      return Promise.resolve(emptyResponse(url));
    });
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText("42")).toBeInTheDocument());
  });

  it("continues rendering when API rejects (safeGet fallback)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("dashboard-preferences"))
        return Promise.resolve({ data: { layout: { widgets: [] } } });
      return Promise.reject(new Error("boom"));
    });
    render(<DashboardPage />);
    await waitFor(() =>
      expect(screen.getByText(/welcome, sumit/i)).toBeInTheDocument()
    );
  });

  it("applies dark mode markup when html.dark is set", async () => {
    document.documentElement.classList.add("dark");
    const { container } = render(<DashboardPage />);
    await waitFor(() => screen.getByText(/welcome, sumit/i));
    // At least one element uses a dark: variant classname
    expect(container.querySelector('[class*="dark:"]')).not.toBeNull();
  });
});
