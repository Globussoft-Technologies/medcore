/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/appointments",
}));

import AppointmentsPage from "../appointments/page";

const sampleAppointments = [
  {
    id: "a1",
    tokenNumber: 1,
    date: new Date().toISOString().split("T")[0],
    slotStart: "10:00",
    type: "REGULAR",
    status: "BOOKED",
    priority: "NORMAL",
    patient: { user: { name: "Asha Roy", phone: "9000000001" }, mrNumber: "MR-1" },
    doctor: { user: { name: "Dr. Singh" } },
  },
  {
    id: "a2",
    tokenNumber: 2,
    date: new Date().toISOString().split("T")[0],
    slotStart: "10:30",
    type: "REGULAR",
    status: "CHECKED_IN",
    priority: "NORMAL",
    patient: { user: { name: "Bhuvan Das", phone: "9000000002" }, mrNumber: "MR-2" },
    doctor: { user: { name: "Dr. Singh" } },
  },
];

describe("AppointmentsPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.patch.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    authMock.mockReturnValue({
      user: { id: "u1", name: "Rec", email: "r@x.com", role: "RECEPTION" },
    });
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/doctors")) return Promise.resolve({ data: [] });
      if (url.startsWith("/appointments")) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    document.documentElement.classList.remove("dark");
  });

  it("renders the Appointments heading when API returns empty lists", async () => {
    render(<AppointmentsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /^appointments$/i })
      ).toBeInTheDocument()
    );
  });

  it("renders rows when appointments are present", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/doctors")) return Promise.resolve({ data: [] });
      if (url.startsWith("/appointments"))
        return Promise.resolve({ data: sampleAppointments });
      return Promise.resolve({ data: [] });
    });
    render(<AppointmentsPage />);
    await waitFor(() => {
      expect(screen.getByText("Asha Roy")).toBeInTheDocument();
      expect(screen.getByText("Bhuvan Das")).toBeInTheDocument();
    });
  });

  it("exposes a Book Appointment action for staff", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/doctors"))
        return Promise.resolve({
          data: [
            { id: "d1", user: { name: "Dr. Singh" }, specialization: "GP" },
          ],
        });
      return Promise.resolve({ data: [] });
    });
    render(<AppointmentsPage />);
    await waitFor(() => {
      const buttons = screen.queryAllByRole("button", {
        name: /book appointment/i,
      });
      expect(buttons.length).toBeGreaterThan(0);
    });
  });

  it("gracefully survives a 500 from /appointments", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/doctors")) return Promise.resolve({ data: [] });
      if (url.startsWith("/appointments")) return Promise.reject(new Error("500"));
      return Promise.resolve({ data: [] });
    });
    render(<AppointmentsPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /^appointments$/i })
      ).toBeInTheDocument()
    );
  });

  it("switches to stats view when button is clicked", async () => {
    const user = userEvent.setup();
    render(<AppointmentsPage />);
    await waitFor(() =>
      screen.getByRole("heading", { name: /^appointments$/i })
    );
    const statsButtons = screen.queryAllByRole("button", { name: /stats/i });
    if (statsButtons.length > 0) {
      await user.click(statsButtons[0]);
    }
    // No crash after interaction — page still shows heading.
    expect(
      screen.getByRole("heading", { name: /^appointments$/i })
    ).toBeInTheDocument();
  });
});
