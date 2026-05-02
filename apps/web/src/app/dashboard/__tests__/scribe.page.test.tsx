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
  usePathname: () => "/dashboard/scribe",
}));

import ScribePage from "../scribe/page";

describe("ScribePage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    authMock.mockImplementation((selector?: any) => {
      const state = {
        token: "tok",
        user: { id: "u1", name: "Doc", email: "d@x.com", role: "DOCTOR" },
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("renders the Today's Patients picker label (smoke render)", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<ScribePage />);
    await waitFor(() =>
      expect(screen.getByText(/today.s patients/i)).toBeInTheDocument()
    );
  });

  it("shows 'No appointments today' when API returns empty list", async () => {
    apiMock.get.mockResolvedValue({ data: [] });
    render(<ScribePage />);
    await waitFor(() =>
      expect(screen.getByText(/no appointments today/i)).toBeInTheDocument()
    );
  });

  it("renders today's appointments from API", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        {
          id: "a1",
          patientId: "p1",
          patient: { user: { name: "Aarav Mehta" } },
        },
      ],
    });
    render(<ScribePage />);
    await waitFor(() =>
      expect(screen.getByText("Aarav Mehta")).toBeInTheDocument()
    );
  });

  it("shows the appointments error banner when API rejects", async () => {
    apiMock.get.mockRejectedValue(new Error("Boom"));
    render(<ScribePage />);
    await waitFor(() =>
      expect(
        screen.getByTestId("scribe-appts-error-banner")
      ).toBeInTheDocument()
    );
  });
});
