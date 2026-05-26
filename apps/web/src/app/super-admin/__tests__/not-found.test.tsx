/**
 * Covers `apps/web/src/app/super-admin/not-found.tsx` — the route-group-scoped
 * 404 page for the super-admin surface (gap #6 piece 1 of 4).
 *
 * Contract: render the super-admin 404 chrome (testid wrapper + heading +
 * helper copy + "Back to console" CTA pointing at /super-admin) instead of
 * bouncing the operator into the staff dashboard's 404. Pure render — no
 * router, no auth store, no effects — so the suite is intentionally compact
 * and exercises every line of the 28-line source.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import NotFound from "../not-found";

describe("SuperAdminNotFound — page chrome and 404 messaging", () => {
  it("renders the super-admin-scoped 404 wrapper section by testid", () => {
    render(<NotFound />);
    const wrapper = screen.getByTestId("super-admin-not-found");
    expect(wrapper).toBeInTheDocument();
    expect(wrapper.tagName).toBe("SECTION");
  });

  it("renders the 'Page not found' heading as an h1", () => {
    render(<NotFound />);
    const heading = screen.getByRole("heading", { name: /page not found/i });
    expect(heading).toBeInTheDocument();
    expect(heading.tagName).toBe("H1");
  });

  it("renders the super-admin-specific helper copy explaining the 404", () => {
    render(<NotFound />);
    // Helper copy is the only paragraph that explains the situation and
    // uses the super-admin framing — guards against a generic-copy regression
    // that would re-route operators to the staff 404 chrome.
    expect(
      screen.getByText(
        /the super-admin page you[’']re looking for doesn[’']t exist or has moved/i,
      ),
    ).toBeInTheDocument();
  });
});

describe("SuperAdminNotFound — Back to console CTA", () => {
  it("renders the home link with the expected testid and copy", () => {
    render(<NotFound />);
    const link = screen.getByTestId("super-admin-not-found-home-link");
    expect(link).toBeInTheDocument();
    expect(link).toHaveTextContent(/back to console/i);
  });

  it("points the home link at /super-admin (NOT the staff /dashboard)", () => {
    render(<NotFound />);
    const link = screen.getByTestId("super-admin-not-found-home-link");
    expect(link).toHaveAttribute("href", "/super-admin");
    // Regression guard for the route-group-bounce bug the scoped 404 exists
    // to prevent — link must never resolve to the staff dashboard.
    expect(link).not.toHaveAttribute("href", "/dashboard");
  });

  it("renders the home CTA as an accessible link role", () => {
    render(<NotFound />);
    const link = screen.getByRole("link", { name: /back to console/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/super-admin");
  });
});
