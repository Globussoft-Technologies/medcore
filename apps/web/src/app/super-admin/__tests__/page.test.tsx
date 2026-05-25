// Complementary tile-coverage tests for /super-admin landing page.
// `landing.page.test.tsx` (gap #6 piece 1 of 4) covers the RBAC gate, the
// Pearl Billing disabled button, and the Tenants tile. Since then 7 more
// tiles have shipped (onboard, jobs, dpdp, support, users, metrics,
// compliance — Pearl §8.2/§8.4/§8.5/§8.6). This file fills the gap:
// every tile's href + visible label + testid, the roadmap note, and a
// total-tile sanity assertion so future tile additions don't silently
// regress the surface.

import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import SuperAdminLandingPage from "../page";

describe("/super-admin landing — tile coverage (complement to landing.page.test.tsx)", () => {
  it("renders the page heading and roadmap note", () => {
    render(<SuperAdminLandingPage />);
    expect(
      screen.getByRole("heading", { name: /super-admin console/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("super-admin-roadmap-note")).toBeInTheDocument();
    expect(
      screen.getByTestId("super-admin-roadmap-note").textContent,
    ).toMatch(/pearl/i);
  });

  it("renders the tiles grid container with both link tiles and the disabled billing button", () => {
    render(<SuperAdminLandingPage />);
    const grid = screen.getByTestId("super-admin-tiles");
    expect(grid).toBeInTheDocument();
    // 8 link tiles + 1 disabled <button> = 9 direct children today. We assert
    // >=9 rather than ===9 so a future tile addition surfaces as a "tile
    // coverage gap" rather than a hard fail of an unrelated assertion.
    expect(grid.children.length).toBeGreaterThanOrEqual(9);
  });

  it.each([
    ["super-admin-tile-onboard", "/super-admin/onboard", /onboard new tenant/i],
    ["super-admin-tile-tenants", "/super-admin/tenants", /tenants/i],
    ["super-admin-tile-jobs", "/super-admin/jobs", /background jobs/i],
    ["super-admin-tile-dpdp", "/super-admin/dpdp", /dpdp workbench/i],
    ["super-admin-tile-support", "/super-admin/support", /pearl support inbox/i],
    ["super-admin-tile-users", "/super-admin/users", /super-admin roster/i],
    ["super-admin-tile-metrics", "/super-admin/metrics", /cross-tenant metrics/i],
    [
      "super-admin-tile-compliance",
      "/super-admin/compliance",
      /compliance posture/i,
    ],
  ])(
    "tile %s links to %s and shows its label",
    (testid, href, labelRe) => {
      render(<SuperAdminLandingPage />);
      const tile = screen.getByTestId(testid);
      expect(tile).toBeInTheDocument();
      expect(tile.tagName.toLowerCase()).toBe("a");
      expect(tile).toHaveAttribute("href", href);
      expect(
        within(tile).getByRole("heading", { name: labelRe }),
      ).toBeInTheDocument();
    },
  );

  it("Pearl Billing tile is a disabled <button>, not a link (piece 3 future)", () => {
    render(<SuperAdminLandingPage />);
    const billing = screen.getByTestId("super-admin-tile-pearl-billing");
    expect(billing.tagName.toLowerCase()).toBe("button");
    expect(billing).toBeDisabled();
    expect(billing).toHaveAttribute("aria-disabled", "true");
    expect(billing).toHaveAttribute(
      "title",
      "Pearl Billing ships in piece 3",
    );
    // Critically — should NOT carry an href (it's a button).
    expect(billing).not.toHaveAttribute("href");
  });

  it("every active tile is a Next Link with focus-ring + hover-shadow classes (keyboard a11y)", () => {
    render(<SuperAdminLandingPage />);
    const linkTiles = [
      "super-admin-tile-onboard",
      "super-admin-tile-tenants",
      "super-admin-tile-jobs",
      "super-admin-tile-dpdp",
      "super-admin-tile-support",
      "super-admin-tile-users",
      "super-admin-tile-metrics",
      "super-admin-tile-compliance",
    ];
    for (const testid of linkTiles) {
      const tile = screen.getByTestId(testid);
      // The shared tile className includes focus:ring-2 + hover:shadow-md.
      // Asserting the class strings keeps the keyboard / hover affordance
      // from silently regressing.
      expect(tile.className).toMatch(/focus:ring-2/);
      expect(tile.className).toMatch(/hover:shadow-md/);
    }
  });

  it("disabled Pearl Billing tile carries the cursor-not-allowed + dashed-border affordance", () => {
    render(<SuperAdminLandingPage />);
    const billing = screen.getByTestId("super-admin-tile-pearl-billing");
    expect(billing.className).toMatch(/cursor-not-allowed/);
    expect(billing.className).toMatch(/border-dashed/);
  });

  it("landing surface root carries the super-admin-landing testid (selector contract for layout gate)", () => {
    render(<SuperAdminLandingPage />);
    const landing = screen.getByTestId("super-admin-landing");
    expect(landing).toBeInTheDocument();
    expect(landing.tagName.toLowerCase()).toBe("section");
  });
});
