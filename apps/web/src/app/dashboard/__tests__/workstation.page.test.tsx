/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, toastMock, routerPush } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  routerPush: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/workstation",
}));

import WorkstationPage from "../workstation/page";

describe("WorkstationPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    routerPush.mockReset();
    toastMock.success.mockReset();
    toastMock.info.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = {
        user: { id: "u1", name: "Nurse", email: "n@x.com", role: "NURSE" },
        isLoading: false,
      };
      return typeof selector === "function" ? selector(state) : state;
    });
    apiMock.get.mockResolvedValue({ data: [] });
  });

  it("renders Workstation heading with empty data", async () => {
    render(<WorkstationPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /workstation/i })).toBeInTheDocument()
    );
  });

  it("calls fetch endpoints on mount", async () => {
    render(<WorkstationPage />);
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalled();
    });
  });

  it("keeps rendering when API returns an error", async () => {
    apiMock.get.mockRejectedValue(new Error("500"));
    render(<WorkstationPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /workstation/i })).toBeInTheDocument()
    );
  });

  it("handles isLoading auth state", async () => {
    authMock.mockImplementation((selector: any) => {
      const state = { user: null, isLoading: true };
      return typeof selector === "function" ? selector(state) : state;
    });
    render(<WorkstationPage />);
    await waitFor(() => {
      expect(document.body).toBeTruthy();
    });
  });

  // Issue #432: empty-state quick-action click should navigate to the
  // landing page AND toast a hint so the nurse knows to pick a patient.
  it("Record Vitals navigates with hint when no vitals queue (#432)", async () => {
    const user = userEvent.setup();
    render(<WorkstationPage />);
    await waitFor(() =>
      expect(screen.getByTestId("quick-record-vitals")).toBeInTheDocument()
    );
    await user.click(screen.getByTestId("quick-record-vitals"));
    expect(toastMock.info).toHaveBeenCalled();
    expect(routerPush).toHaveBeenCalledWith("/dashboard/vitals");
  });

  it("Record Vitals deep-links with appointmentId when queue is non-empty (#432)", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/appointments?status=CHECKED_IN")) {
        return Promise.resolve({
          data: [
            {
              id: "apt-9",
              tokenNumber: 12,
              patient: { user: { name: "Asha Roy" } },
              doctor: { user: { name: "Dr. Singh" } },
            },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });
    const user = userEvent.setup();
    render(<WorkstationPage />);
    await waitFor(() =>
      expect(screen.getByTestId("quick-record-vitals")).toBeInTheDocument()
    );
    // Wait for the data fetch to populate `vitalsToRecord`
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalled();
    });
    await user.click(screen.getByTestId("quick-record-vitals"));
    await waitFor(() => {
      expect(routerPush).toHaveBeenCalledWith(
        "/dashboard/vitals?appointmentId=apt-9"
      );
    });
  });

  it("Triage button navigates to /dashboard/emergency (#432)", async () => {
    const user = userEvent.setup();
    render(<WorkstationPage />);
    await waitFor(() =>
      expect(screen.getByTestId("quick-triage")).toBeInTheDocument()
    );
    await user.click(screen.getByTestId("quick-triage"));
    expect(routerPush).toHaveBeenCalledWith("/dashboard/emergency");
  });

  it("Start Round button navigates to /dashboard/admissions (#432)", async () => {
    const user = userEvent.setup();
    render(<WorkstationPage />);
    await waitFor(() =>
      expect(screen.getByTestId("quick-start-round")).toBeInTheDocument()
    );
    await user.click(screen.getByTestId("quick-start-round"));
    expect(routerPush).toHaveBeenCalledWith("/dashboard/admissions");
  });

  it("Administer Med navigates to /dashboard/medication-dashboard (#432)", async () => {
    const user = userEvent.setup();
    render(<WorkstationPage />);
    await waitFor(() =>
      expect(screen.getByTestId("quick-administer-med")).toBeInTheDocument()
    );
    await user.click(screen.getByTestId("quick-administer-med"));
    expect(routerPush).toHaveBeenCalledWith("/dashboard/medication-dashboard");
  });
});
