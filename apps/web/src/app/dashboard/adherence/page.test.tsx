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
  usePathname: () => "/dashboard/adherence",
}));

import AdherencePage from "./page";

const sampleSchedule = {
  id: "sch1",
  patientId: "p1",
  prescriptionId: "rx-001",
  medications: [
    {
      name: "Metformin",
      dosage: "500mg",
      frequency: "BD",
      duration: "30 days",
      reminderTimes: ["08:00", "20:00"],
    },
  ],
  startDate: new Date().toISOString(),
  endDate: new Date(Date.now() + 30 * 86400000).toISOString(),
  active: true,
  remindersSent: 3,
  lastReminderAt: null,
  createdAt: new Date().toISOString(),
};

describe("AdherencePage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.delete.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = { user: { id: "u1", name: "Pat", email: "p@x.com", role: "PATIENT" } };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders header with the Enroll Prescription button", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<AdherencePage />);
    expect(
      await screen.findByRole("heading", { name: /medication reminders/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /enroll prescription/i })
    ).toBeInTheDocument();
  });

  it("shows empty state when the patient has no schedules", async () => {
    // First call: /patients?userId -> returns one patient
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients")) return Promise.resolve({ data: [{ id: "p1" }] });
      if (url.startsWith("/ai/adherence/")) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    render(<AdherencePage />);
    await waitFor(() =>
      expect(screen.getByText(/no active medication reminders/i)).toBeInTheDocument()
    );
  });

  it("renders schedule cards when the API returns data", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients")) return Promise.resolve({ data: [{ id: "p1" }] });
      if (url.startsWith("/ai/adherence/")) return Promise.resolve({ data: [sampleSchedule] });
      return Promise.resolve({ data: [] });
    });
    render(<AdherencePage />);
    await waitFor(() => {
      expect(screen.getByText("Metformin")).toBeInTheDocument();
      expect(screen.getByText(/3 reminders sent/i)).toBeInTheDocument();
    });
  });

  it("shows an error banner when loading fails", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients")) return Promise.resolve({ data: [{ id: "p1" }] });
      if (url.startsWith("/ai/adherence/")) return Promise.reject(new Error("Boom"));
      return Promise.resolve({ data: [] });
    });
    render(<AdherencePage />);
    await waitFor(() => expect(screen.getByText(/boom/i)).toBeInTheDocument());
  });

  it("toggles the enroll form when the header button is clicked", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    const user = userEvent.setup();
    render(<AdherencePage />);
    await screen.findByRole("heading", { name: /medication reminders/i });
    await user.click(screen.getByRole("button", { name: /enroll prescription/i }));
    expect(
      screen.getByRole("heading", { name: /enroll a prescription/i })
    ).toBeInTheDocument();
  });

  it("shows a validation error when enrolling without a prescription ID", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    const user = userEvent.setup();
    render(<AdherencePage />);
    await screen.findByRole("heading", { name: /medication reminders/i });
    await user.click(screen.getByRole("button", { name: /enroll prescription/i }));
    // Click the submit button inside the form
    const submit = screen.getAllByRole("button", { name: /^enroll$/i })[0];
    await user.click(submit);
    expect(
      await screen.findByText(/prescription id is required/i)
    ).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });
});
