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
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/ai-roster",
}));

import AIRosterPage from "../ai-roster/page";

describe("AIRosterPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
        token: "tok-1",
      };
      return typeof selector === "function" ? selector(state) : state;
    });
    apiMock.get.mockResolvedValue({ success: true, data: [] });
  });

  it("smoke renders the page heading and form", async () => {
    render(<AIRosterPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /ai staff roster/i })
      ).toBeInTheDocument()
    );
    expect(screen.getByText(/start date/i)).toBeInTheDocument();
  });

  it("renders the empty history table message", async () => {
    render(<AIRosterPage />);
    await waitFor(() =>
      expect(screen.getByText(/no past proposals yet/i)).toBeInTheDocument()
    );
  });

  it("renders a populated history list", async () => {
    apiMock.get.mockResolvedValue({
      success: true,
      data: [
        {
          id: "prop-1",
          status: "APPLIED",
          startDate: "2026-05-01",
          days: 7,
          department: "general",
          createdAt: new Date().toISOString(),
          warnings: 0,
          violationsIfApplied: 0,
        },
      ],
    });
    render(<AIRosterPage />);
    await waitFor(() =>
      expect(screen.getByText(/general/i)).toBeInTheDocument()
    );
    expect(screen.getAllByText(/applied/i).length).toBeGreaterThan(0);
  });

  it("surfaces an error when the propose endpoint rejects", async () => {
    apiMock.post.mockRejectedValue(new Error("LLM 500"));
    const user = userEvent.setup();
    render(<AIRosterPage />);
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() =>
      expect(screen.getByText(/llm 500/i)).toBeInTheDocument()
    );
  });

  it("renders the proposal review block when propose succeeds", async () => {
    apiMock.post.mockResolvedValue({
      success: true,
      data: {
        id: "prop-1",
        status: "PROPOSED",
        startDate: "2026-05-01",
        days: 7,
        department: "general",
        proposals: [
          {
            date: "2026-05-01",
            shifts: [
              {
                shiftType: "MORNING",
                requiredCount: 2,
                assignedStaff: [
                  { userId: "u1", name: "Dr. Singh", role: "DOCTOR" },
                ],
                understaffed: false,
              },
            ],
          },
        ],
        warnings: [],
        violationsIfApplied: [],
      },
      error: null,
    });
    const user = userEvent.setup();
    render(<AIRosterPage />);
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() =>
      expect(screen.getByText(/dr\. singh/i)).toBeInTheDocument()
    );
  });
});
