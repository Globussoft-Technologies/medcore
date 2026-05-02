/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { routerReplace } = vi.hoisted(() => ({
  routerReplace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/patients/register",
}));

import PatientsRegisterRedirect from "../patients/register/page";

describe("PatientsRegisterRedirect", () => {
  beforeEach(() => {
    routerReplace.mockReset();
  });

  it("renders the redirect placeholder", () => {
    render(<PatientsRegisterRedirect />);
    expect(
      screen.getByTestId("patients-register-redirect")
    ).toBeInTheDocument();
  });

  it("shows the 'Opening patient registration' message", () => {
    render(<PatientsRegisterRedirect />);
    expect(
      screen.getByText(/opening patient registration/i)
    ).toBeInTheDocument();
  });

  it("calls router.replace with /dashboard/patients?register=1", async () => {
    render(<PatientsRegisterRedirect />);
    await waitFor(() =>
      expect(routerReplace).toHaveBeenCalledWith(
        "/dashboard/patients?register=1"
      )
    );
  });

  it("does not throw when re-rendered", () => {
    expect(() => {
      render(<PatientsRegisterRedirect />);
      render(<PatientsRegisterRedirect />);
    }).not.toThrow();
  });
});
