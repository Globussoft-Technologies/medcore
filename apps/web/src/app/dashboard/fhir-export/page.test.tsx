/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, routerMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  routerMock: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/fhir-export",
}));

import FhirExportPage from "./page";

describe("FhirExportPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    routerMock.push.mockReset();
    authMock.mockReturnValue({
      user: { id: "u1", name: "Admin", role: "ADMIN" },
      isLoading: false,
    });
  });

  it("renders the heading and the three export buttons (disabled by default)", () => {
    render(<FhirExportPage />);
    expect(
      screen.getByRole("heading", { name: /fhir export/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /patient resource/i })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /everything bundle/i })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /abdm push bundle/i })
    ).toBeDisabled();
  });

  it("shows a loading spinner while auth is loading", () => {
    authMock.mockReturnValue({ user: null, isLoading: true });
    const { container } = render(<FhirExportPage />);
    expect(container.querySelector("svg.animate-spin")).toBeInTheDocument();
  });

  it("redirects non-admin users to the dashboard", async () => {
    authMock.mockReturnValue({
      user: { id: "u1", name: "Dr Asha", role: "DOCTOR" },
      isLoading: false,
    });
    render(<FhirExportPage />);
    await waitFor(() =>
      expect(routerMock.push).toHaveBeenCalledWith("/dashboard")
    );
  });

  it("surfaces an error banner when an export call fails", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?search")) {
        return Promise.resolve({ data: [{ id: "p1", user: { name: "Ravi" } }] });
      }
      return Promise.reject(new Error("FHIR server exploded"));
    });
    const user = userEvent.setup();
    render(<FhirExportPage />);
    const search = screen.getByPlaceholderText(/search patient/i);
    await user.type(search, "Ra");
    const option = await screen.findByRole("button", { name: /ravi/i });
    await user.click(option);
    await user.click(screen.getByRole("button", { name: /patient resource/i }));
    await waitFor(() =>
      expect(screen.getByText(/fhir server exploded/i)).toBeInTheDocument()
    );
  });
});
