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

  // Issue #945: the event-detail popup previously rendered only the start
  // time (e.g. "Monday, 12 May 2026 · 14:00"), which made back-to-back
  // appointments and shifts ambiguous. After the fix, the popup renders the
  // start AND end together with an en-dash ("14:00 – 14:30") whenever the
  // source has a known end. We seed a single appointment with slotStart +
  // slotEnd, open its detail popup, and assert both times render.
  it("shows Start AND End time on the appointment detail popup (#945)", async () => {
    asAdmin();
    const today = new Date();
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const appt = {
      id: "appt-1",
      date: ymd,
      slotStart: "14:00",
      slotEnd: "14:30",
      status: "BOOKED",
      patient: { user: { name: "Aarav Mehta" } },
      doctor: { user: { name: "Dr. Singh" } },
      type: "OPD",
    };
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments"))
        return Promise.resolve({ data: [appt] });
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<UnifiedCalendarPage />);
    // Wait for the chip to appear in the month grid (title prop carries
    // "14:00 — <viewer-specific title>"); pick by the leading time token
    // so we don't depend on the role-pivoted title formatting.
    const chip = await screen.findByTitle(/^14:00\s+—/);
    await user.click(chip);
    // The popup paragraph now reads ".. · 14:00 – 14:30". Find it via the
    // unambiguous start-end pair.
    await waitFor(() =>
      expect(screen.getByText(/14:00\s*–\s*14:30/)).toBeInTheDocument()
    );
  });
});
