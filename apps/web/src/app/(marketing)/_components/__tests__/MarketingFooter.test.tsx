/**
 * MarketingFooter coverage suite.
 *
 * What: smoke render + structural assertions for the static marketing footer
 * (brand logos, four nav-column sections, link wiring, social-link aria-labels,
 * dynamic copyright year).
 * Which: apps/web/src/app/(marketing)/_components/MarketingFooter.tsx.
 * Why: the file shipped with no tests (per test-cron pick 2026-05-26). The
 * component is presentational, so we mock next/link + next/image + the
 * Container wrapper (mirroring the sibling about.page / contact.page suites)
 * and assert the wiring directly.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/image", () => ({
  default: ({ alt, src, ...rest }: any) => (
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    <img
      alt={alt}
      src={typeof src === "string" ? src : (src?.src ?? "")}
      {...rest}
    />
  ),
}));
vi.mock("../Container", () => ({
  Container: ({ children, className }: any) => (
    <div data-testid="container" className={className}>
      {children}
    </div>
  ),
}));

import { MarketingFooter } from "../MarketingFooter";

afterEach(() => cleanup());

describe("MarketingFooter", () => {
  it("smoke renders the <footer> landmark without throwing", () => {
    render(<MarketingFooter />);
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("wraps content in the marketing Container", () => {
    render(<MarketingFooter />);
    expect(screen.getByTestId("container")).toBeInTheDocument();
  });

  it("renders both brand logos (light + dark variants) with MedCore alt", () => {
    render(<MarketingFooter />);
    const logos = screen.getAllByAltText("MedCore");
    expect(logos.length).toBe(2);
    const homeLinks = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href") === "/");
    expect(homeLinks.length).toBeGreaterThanOrEqual(1);
  });

  it("renders the marketing pitch tagline", () => {
    render(<MarketingFooter />);
    expect(
      screen.getByText(/hospital management software engineered for indian/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/gst-aware billing/i)).toBeInTheDocument();
  });

  describe("nav columns", () => {
    it("renders all four section headings", () => {
      render(<MarketingFooter />);
      expect(
        screen.getByRole("heading", { name: /^product$/i, level: 4 })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: /^company$/i, level: 4 })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: /^resources$/i, level: 4 })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: /^legal$/i, level: 4 })
      ).toBeInTheDocument();
    });

    it("Product column has Features / Solutions / Pricing / Live demo with correct hrefs", () => {
      render(<MarketingFooter />);
      expect(
        screen.getByRole("link", { name: "Features" }).getAttribute("href")
      ).toBe("/features");
      expect(
        screen.getByRole("link", { name: "Solutions" }).getAttribute("href")
      ).toBe("/solutions");
      expect(
        screen.getByRole("link", { name: "Pricing" }).getAttribute("href")
      ).toBe("/pricing");
      expect(
        screen.getByRole("link", { name: "Live demo" }).getAttribute("href")
      ).toBe("https://medcore.globusdemos.com/login");
    });

    it("Company column has About / Contact / Careers with correct hrefs", () => {
      render(<MarketingFooter />);
      expect(
        screen.getByRole("link", { name: "About" }).getAttribute("href")
      ).toBe("/about");
      expect(
        screen.getByRole("link", { name: "Contact" }).getAttribute("href")
      ).toBe("/contact");
      expect(
        screen.getByRole("link", { name: "Careers" }).getAttribute("href")
      ).toBe("/about#careers");
    });

    it("Resources column has Clinical / Finance / Mobile app with anchor hrefs", () => {
      render(<MarketingFooter />);
      expect(
        screen.getByRole("link", { name: "Clinical" }).getAttribute("href")
      ).toBe("/features#clinical");
      expect(
        screen.getByRole("link", { name: "Finance" }).getAttribute("href")
      ).toBe("/features#finance");
      expect(
        screen.getByRole("link", { name: "Mobile app" }).getAttribute("href")
      ).toBe("/features#mobile");
    });

    it("Legal column has Privacy / Terms / Data processing all pointing at '#'", () => {
      render(<MarketingFooter />);
      const privacy = screen.getByRole("link", { name: "Privacy" });
      const terms = screen.getByRole("link", { name: "Terms" });
      const dp = screen.getByRole("link", { name: "Data processing" });
      expect(privacy.getAttribute("href")).toBe("#");
      expect(terms.getAttribute("href")).toBe("#");
      expect(dp.getAttribute("href")).toBe("#");
    });

    it("renders four <ul> link lists, each scoped to its column heading", () => {
      render(<MarketingFooter />);
      const lists = screen.getAllByRole("list");
      expect(lists.length).toBe(4);
      const itemCounts = lists.map(
        (l) => within(l).getAllByRole("listitem").length
      );
      expect(itemCounts.sort()).toEqual([3, 3, 3, 4]);
    });
  });

  describe("social links", () => {
    it("renders Twitter / LinkedIn / GitHub icon links with aria-labels", () => {
      render(<MarketingFooter />);
      expect(screen.getByRole("link", { name: "Twitter" })).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "LinkedIn" })
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "GitHub" })).toBeInTheDocument();
    });

    it("social links currently point to '#' placeholders", () => {
      render(<MarketingFooter />);
      expect(
        screen.getByRole("link", { name: "Twitter" }).getAttribute("href")
      ).toBe("#");
      expect(
        screen.getByRole("link", { name: "LinkedIn" }).getAttribute("href")
      ).toBe("#");
      expect(
        screen.getByRole("link", { name: "GitHub" }).getAttribute("href")
      ).toBe("#");
    });

    it("each social anchor contains a single <svg> brand mark", () => {
      const { container } = render(<MarketingFooter />);
      const svgs = container.querySelectorAll("a[aria-label] svg");
      expect(svgs.length).toBe(3);
      svgs.forEach((svg) => {
        expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
        expect(svg.hasAttribute("aria-hidden")).toBe(true);
      });
    });
  });

  describe("copyright line", () => {
    const realDate = Date;

    beforeEach(() => {
      const fixed = new realDate("2030-07-15T12:00:00Z");
      vi.spyOn(globalThis, "Date").mockImplementation(((..._args: any[]) =>
        fixed) as any);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("uses the current year via new Date().getFullYear()", () => {
      render(<MarketingFooter />);
      expect(screen.getByText(/2030 MedCore/)).toBeInTheDocument();
    });

    it("renders the 'Built in Bangalore, India.' suffix", () => {
      render(<MarketingFooter />);
      expect(
        screen.getByText(/built in bangalore, india/i)
      ).toBeInTheDocument();
    });
  });
});
