/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/ai-followup",
}));

import AIFollowupPage from "../ai-followup/page";

const sampleConsult = {
  id: "consult-12345678",
  appointmentId: "appt-1",
  notes: "Visit notes",
  doctor: { user: { name: "Dr. Singh" } },
  appointment: {
    patient: {
      id: "p1",
      mrNumber: "MR-001",
      user: { name: "Aarav Mehta" },
    },
  },
};

describe("AIFollowupPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    toastMock.error.mockReset();
  });

  it("smoke renders the page heading", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<AIFollowupPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /smart follow-up suggestions/i })
      ).toBeInTheDocument()
    );
  });

  it("shows the empty-state message when no consultations are returned", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<AIFollowupPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/no recent consultations found/i)
      ).toBeInTheDocument()
    );
  });

  it("renders consultation rows on a happy path", async () => {
    apiMock.get.mockResolvedValue({ data: [sampleConsult] });
    render(<AIFollowupPage />);
    await waitFor(() =>
      expect(screen.getAllByTestId("followup-row").length).toBe(1)
    );
    expect(screen.getByText(/aarav mehta/i)).toBeInTheDocument();
  });

  it("falls through to the empty state when both endpoints reject", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<AIFollowupPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/no recent consultations found/i)
      ).toBeInTheDocument()
    );
  });

  it("renders the Refresh action that re-invokes the loader", async () => {
    apiMock.get.mockResolvedValue({ data: [sampleConsult] });
    render(<AIFollowupPage />);
    await waitFor(() =>
      expect(screen.getAllByTestId("followup-row").length).toBe(1)
    );
    expect(
      screen.getByRole("button", { name: /refresh/i })
    ).toBeInTheDocument();
  });
});
