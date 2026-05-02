/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { apiMock, authMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/ai-booking",
}));

import AIBookingPage from "../ai-booking/page";

describe("AIBookingPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    toastMock.error.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Patient", email: "p@x.com", role: "PATIENT" },
        token: "tok-1",
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("smoke renders the pre-chat selector when no session is active", async () => {
    render(<AIBookingPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/who is this appointment for/i)
      ).toBeInTheDocument()
    );
  });

  it("renders the booking-for option buttons", async () => {
    render(<AIBookingPage />);
    await waitFor(() =>
      expect(screen.getByText(/myself/i)).toBeInTheDocument()
    );
    expect(screen.getByText(/^Child$/)).toBeInTheDocument();
    expect(screen.getByText(/^Parent$/)).toBeInTheDocument();
  });

  it("renders the language picker with native-script labels", async () => {
    render(<AIBookingPage />);
    await waitFor(() =>
      expect(screen.getByLabelText(/language/i)).toBeInTheDocument()
    );
  });

  it("shows the Start AI Consultation button on the pre-chat panel", async () => {
    render(<AIBookingPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /start ai consultation/i })
      ).toBeInTheDocument()
    );
  });

  it("does not call the triage start endpoint until the user confirms", async () => {
    render(<AIBookingPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/who is this appointment for/i)
      ).toBeInTheDocument()
    );
    // Auto-start was explicitly removed (#GAP-T9); the POST must not
    // fire on mount.
    const calls = apiMock.post.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/ai/triage/start"))).toBe(false);
  });
});
