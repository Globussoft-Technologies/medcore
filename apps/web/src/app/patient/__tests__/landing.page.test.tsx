// Smoke tests for the patient PWA landing surface (gap #5 piece 1 + piece 3a).
// Piece 1 contract: the unauthed welcome page renders with the right CTAs +
// the patient route group doesn't mount the staff dashboard sidebar +
// manifest is segment-scoped to /patient.
// Piece 3a contract: when the /auth/me probe returns a PATIENT, the landing
// page redirects to /patient/dashboard instead of rendering the welcome.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { replaceMock, apiGetMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  apiGetMock: vi.fn(),
}));

vi.mock("@/components/PatientServiceWorkerRegistration", () => ({
  PatientServiceWorkerRegistration: () => null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  // PatientLayoutShell calls usePathname() to pick bare-vs-staff chrome.
  // Return "/patient" so the bare-shell branch is exercised in the
  // "does NOT mount the dashboard sidebar" assertion below.
  usePathname: () => "/patient",
}));

vi.mock("@/lib/api", () => ({
  api: { get: apiGetMock, post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import PatientLandingPage from "../page";
import PatientLayout from "../layout";
import patientManifest from "../manifest";

describe("Patient PWA scaffold — gap #5 piece 1 + 3a", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    apiGetMock.mockReset();
  });

  it("renders the welcome landing page with a Sign-in link when unauthed", async () => {
    apiGetMock.mockRejectedValueOnce(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );
    render(<PatientLandingPage />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /welcome to your/i }),
      ).toBeInTheDocument();
    });
    const signIn = screen.getByTestId("patient-landing-signin");
    expect(signIn).toBeInTheDocument();
    expect(signIn).toHaveAttribute("href", "/patient/login");
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("renders both Sign-in and Create-account CTAs in the unauthed hero", async () => {
    // 2026-05 redesign — the old "Book an appointment (disabled, available
    // after sign-in)" CTA was replaced by a sign-in primary + a create-
    // account secondary so the unauthed surface points at the two real
    // next steps instead of dangling a disabled button. This test pins
    // the new pair so a regression flips us back to a single disabled
    // CTA.
    apiGetMock.mockRejectedValueOnce(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );
    render(<PatientLandingPage />);
    const signIn = await screen.findByTestId("patient-landing-signin");
    expect(signIn).toHaveAttribute("href", "/patient/login");
    const register = screen.getByTestId("patient-landing-register");
    expect(register).toHaveAttribute("href", "/patient/register");
  });

  it("redirects to /patient/dashboard when /auth/me returns a PATIENT", async () => {
    apiGetMock.mockResolvedValueOnce({
      success: true,
      data: { user: { id: "u1", role: "PATIENT" } },
    });
    render(<PatientLandingPage />);
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/patient/dashboard");
    });
  });

  it("does NOT redirect to dashboard when /auth/me returns a non-PATIENT role", async () => {
    apiGetMock.mockResolvedValueOnce({
      success: true,
      data: { user: { id: "u2", role: "DOCTOR" } },
    });
    render(<PatientLandingPage />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /welcome to your/i }),
      ).toBeInTheDocument();
    });
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("does NOT mount the dashboard sidebar inside the patient route group", async () => {
    apiGetMock.mockRejectedValueOnce(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );
    render(
      <PatientLayout>
        <PatientLandingPage />
      </PatientLayout>,
    );
    // The dashboard layout's sidebar carries data-testid="dashboard-sidebar".
    // The patient surface must have its own bare chrome.
    expect(screen.queryByTestId("dashboard-sidebar")).not.toBeInTheDocument();
    expect(screen.getByTestId("patient-shell")).toBeInTheDocument();
    expect(screen.getByTestId("patient-shell-login-link")).toHaveAttribute(
      "href",
      "/patient/login",
    );
  });

  it("exposes a segment-scoped manifest with /patient start_url + scope", () => {
    const m = patientManifest();
    expect(m.start_url).toBe("/patient");
    expect(m.scope).toBe("/patient");
    expect(m.display).toBe("standalone");
    expect(m.short_name).toBe("Patient Portal");
    expect(m.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/icon-192.png" }),
        expect.objectContaining({ src: "/icon-512.png" }),
      ]),
    );
  });
});
