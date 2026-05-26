/**
 * Covers `apps/web/src/app/patient/not-found.tsx` — the patient PWA's
 * scoped 404 (gap #5 piece 1 of 4). Unlike the global `app/not-found.tsx`,
 * this page has NO auth-state branching and NO router interaction — it's
 * a static section with a single Back-to-home link that MUST point at
 * `/patient` so users don't bounce into the staff dashboard chrome.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import PatientNotFound from "../not-found";

describe("PatientNotFound — patient PWA 404 page", () => {
  it("renders the patient-scoped 404 section testid", () => {
    render(<PatientNotFound />);
    expect(screen.getByTestId("patient-not-found")).toBeInTheDocument();
  });

  it("renders the Page-not-found heading", () => {
    render(<PatientNotFound />);
    expect(
      screen.getByRole("heading", { name: /page not found/i, level: 1 }),
    ).toBeInTheDocument();
  });

  it("renders the helper copy explaining the missing page", () => {
    render(<PatientNotFound />);
    expect(
      screen.getByText(/doesn’t exist or has moved/i),
    ).toBeInTheDocument();
  });

  it("renders the Back-to-home CTA pointing at /patient (NOT /)", () => {
    render(<PatientNotFound />);
    const link = screen.getByTestId("patient-not-found-home-link");
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/patient");
    expect(link).toHaveTextContent(/back to home/i);
  });

  it("does NOT bounce into the staff-dashboard chrome (no '/' or '/dashboard' link)", () => {
    render(<PatientNotFound />);
    const link = screen.getByTestId("patient-not-found-home-link");
    expect(link.getAttribute("href")).not.toBe("/");
    expect(link.getAttribute("href")).not.toBe("/dashboard");
  });

  it("uses an accessible <a> element for the home CTA (min 44px tap target class present)", () => {
    render(<PatientNotFound />);
    const link = screen.getByTestId("patient-not-found-home-link");
    expect(link.tagName).toBe("A");
    // PWA tap-target hygiene: 44px min-width + 44px (h-11) min-height.
    expect(link.className).toMatch(/min-w-\[44px\]/);
    expect(link.className).toMatch(/h-11/);
  });
});
