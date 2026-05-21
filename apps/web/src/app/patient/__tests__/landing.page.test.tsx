// Smoke tests for the patient PWA scaffold (gap #5 piece 1 of 4).
// Asserts the landing page renders, the Sign-in CTA points at /patient/login,
// no dashboard sidebar is mounted on the patient surface, and the segment-scoped
// manifest exposes the Pearl-required `start_url`/`scope` of `/patient`.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/PatientServiceWorkerRegistration", () => ({
  PatientServiceWorkerRegistration: () => null,
}));

import PatientLandingPage from "../page";
import PatientLayout from "../layout";
import patientManifest from "../manifest";

describe("Patient PWA scaffold — gap #5 piece 1 of 4", () => {
  it("renders the welcome landing page with a Sign-in link to /patient/login", () => {
    render(<PatientLandingPage />);
    expect(
      screen.getByRole("heading", { name: /welcome to your patient portal/i })
    ).toBeInTheDocument();
    const signIn = screen.getByTestId("patient-landing-signin");
    expect(signIn).toBeInTheDocument();
    expect(signIn).toHaveAttribute("href", "/patient/login");
  });

  it("renders the disabled Book-an-appointment CTA with the post-sign-in tooltip", () => {
    render(<PatientLandingPage />);
    const book = screen.getByTestId("patient-landing-book");
    expect(book).toBeInTheDocument();
    expect(book).toHaveAttribute("aria-disabled", "true");
    expect(book).toHaveAttribute("title", "Available after sign in");
  });

  it("does NOT mount the dashboard sidebar inside the patient route group", () => {
    render(
      <PatientLayout>
        <PatientLandingPage />
      </PatientLayout>
    );
    // The dashboard layout's sidebar carries data-testid="dashboard-sidebar".
    // The patient surface must have its own bare chrome.
    expect(screen.queryByTestId("dashboard-sidebar")).not.toBeInTheDocument();
    expect(screen.getByTestId("patient-shell")).toBeInTheDocument();
    expect(screen.getByTestId("patient-shell-login-link")).toHaveAttribute(
      "href",
      "/patient/login"
    );
  });

  it("exposes a segment-scoped manifest with /patient start_url + scope", () => {
    const m = patientManifest();
    expect(m.start_url).toBe("/patient");
    expect(m.scope).toBe("/patient");
    expect(m.display).toBe("standalone");
    expect(m.short_name).toBe("Patient Portal");
    // Must reuse the existing root-manifest icons — piece 1 ships no new icon files.
    expect(m.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/icon-192.png" }),
        expect.objectContaining({ src: "/icon-512.png" }),
      ])
    );
  });
});
