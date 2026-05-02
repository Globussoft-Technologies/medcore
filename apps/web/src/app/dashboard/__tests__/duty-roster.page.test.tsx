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
vi.mock("@/lib/use-dialog", () => ({
  useConfirm: () => vi.fn(async () => true),
  usePrompt: () => vi.fn(async () => ""),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/duty-roster",
}));

import DutyRosterPage from "../duty-roster/page";

function asAdmin() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

function asNurse() {
  authMock.mockImplementation((selector?: any) => {
    const state = {
      user: { id: "u2", name: "Nurse", email: "n@x.com", role: "NURSE" },
    };
    return typeof selector === "function" ? selector(state) : state;
  });
}

describe("DutyRosterPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/shifts/staff"))
        return Promise.resolve({
          data: [{ id: "u1", name: "Dr. Singh", email: "s@x.com", role: "DOCTOR" }],
        });
      if (url.startsWith("/shifts/roster"))
        return Promise.resolve({ data: { shifts: [], grouped: {} } });
      return Promise.resolve({ data: [] });
    });
  });

  it("smoke renders the heading for ADMIN", async () => {
    asAdmin();
    render(<DutyRosterPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /duty roster/i })
      ).toBeInTheDocument()
    );
  });

  it("renders the staff roster table when staff are returned", async () => {
    asAdmin();
    render(<DutyRosterPage />);
    await waitFor(() =>
      expect(screen.getByText(/dr\. singh/i)).toBeInTheDocument()
    );
  });

  it("shows the no-staff empty-state when staff endpoint returns nothing", async () => {
    asAdmin();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/shifts/staff")) return Promise.resolve({ data: [] });
      if (url.startsWith("/shifts/roster"))
        return Promise.resolve({ data: { shifts: [], grouped: {} } });
      return Promise.resolve({ data: [] });
    });
    render(<DutyRosterPage />);
    await waitFor(() =>
      expect(screen.getByText(/no staff found/i)).toBeInTheDocument()
    );
  });

  it("renders the access-restricted message for non-ADMIN roles", async () => {
    asNurse();
    render(<DutyRosterPage />);
    await waitFor(() =>
      expect(
        screen.getByText(/access restricted to administrators/i)
      ).toBeInTheDocument()
    );
  });

  it("keeps rendering when both shift endpoints reject", async () => {
    asAdmin();
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<DutyRosterPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /duty roster/i })
      ).toBeInTheDocument()
    );
  });
});
