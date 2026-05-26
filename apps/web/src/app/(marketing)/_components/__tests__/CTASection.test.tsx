/**
 * CTASection coverage suite.
 *
 * What: smoke render + structural assertions for the marketing CTA band
 * (default heading + subtitle copy, default primary/secondary CTA labels +
 * hrefs, custom prop overrides for all six fields, wrapping <section> +
 * Container chrome).
 * Which: apps/web/src/app/(marketing)/_components/CTASection.tsx.
 * Why: the file shipped with no tests (per test-cron pick 2026-05-26). The
 * component is purely presentational with default-prop fallbacks, so we
 * mock next/link + the Container wrapper (mirroring the sibling
 * MarketingFooter.test.tsx / MarketingNav.test.tsx convention) and assert
 * the wiring + override paths directly.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("../Container", () => ({
  Container: ({ children, className }: any) => (
    <div data-testid="container" className={className}>
      {children}
    </div>
  ),
}));

import { CTASection } from "../CTASection";

afterEach(() => cleanup());

describe("CTASection", () => {
  it("smoke renders without throwing", () => {
    const { container } = render(<CTASection />);
    expect(container.querySelector("section")).toBeInTheDocument();
  });

  it("wraps content in the marketing Container", () => {
    render(<CTASection />);
    expect(screen.getByTestId("container")).toBeInTheDocument();
  });

  describe("default props", () => {
    it("renders the default headline copy as an <h2>", () => {
      render(<CTASection />);
      const heading = screen.getByRole("heading", {
        name: /ready to streamline your hospital\?/i,
        level: 2,
      });
      expect(heading).toBeInTheDocument();
    });

    it("renders the default subtitle/marketing pitch", () => {
      render(<CTASection />);
      expect(
        screen.getByText(
          /book a 30-minute demo with our team\. we'll tailor it to your workflow\./i
        )
      ).toBeInTheDocument();
    });

    it("renders the default primary CTA 'Book a demo' pointing at /contact", () => {
      render(<CTASection />);
      const primary = screen.getByRole("link", { name: /book a demo/i });
      expect(primary.getAttribute("href")).toBe("/contact");
    });

    it("renders the default secondary CTA 'Try the live demo' pointing at the live demo URL", () => {
      render(<CTASection />);
      const secondary = screen.getByRole("link", { name: /try the live demo/i });
      expect(secondary.getAttribute("href")).toBe(
        "https://medcore.globusdemos.com/login"
      );
    });

    it("renders exactly two CTA links by default (primary + secondary)", () => {
      render(<CTASection />);
      expect(screen.getAllByRole("link").length).toBe(2);
    });
  });

  describe("prop overrides", () => {
    it("overrides the title prop", () => {
      render(<CTASection title="Custom headline" />);
      expect(
        screen.getByRole("heading", { name: "Custom headline", level: 2 })
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/ready to streamline your hospital/i)
      ).not.toBeInTheDocument();
    });

    it("overrides the subtitle prop", () => {
      render(<CTASection subtitle="Custom subtitle copy" />);
      expect(screen.getByText("Custom subtitle copy")).toBeInTheDocument();
      expect(
        screen.queryByText(/book a 30-minute demo/i)
      ).not.toBeInTheDocument();
    });

    it("overrides the primaryLabel + primaryHref props", () => {
      render(
        <CTASection primaryLabel="Get started" primaryHref="/signup" />
      );
      const primary = screen.getByRole("link", { name: "Get started" });
      expect(primary.getAttribute("href")).toBe("/signup");
    });

    it("overrides the secondaryLabel + secondaryHref props", () => {
      render(
        <CTASection
          secondaryLabel="Talk to sales"
          secondaryHref="/sales"
        />
      );
      const secondary = screen.getByRole("link", { name: "Talk to sales" });
      expect(secondary.getAttribute("href")).toBe("/sales");
    });

    it("accepts all six props simultaneously", () => {
      render(
        <CTASection
          title="Title A"
          subtitle="Subtitle B"
          primaryLabel="Primary C"
          primaryHref="/c"
          secondaryLabel="Secondary D"
          secondaryHref="/d"
        />
      );
      expect(
        screen.getByRole("heading", { name: "Title A", level: 2 })
      ).toBeInTheDocument();
      expect(screen.getByText("Subtitle B")).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: "Primary C" }).getAttribute("href")
      ).toBe("/c");
      expect(
        screen.getByRole("link", { name: "Secondary D" }).getAttribute("href")
      ).toBe("/d");
    });
  });

  describe("structure + ordering", () => {
    it("renders the primary CTA before the secondary CTA in DOM order", () => {
      render(<CTASection />);
      const links = screen.getAllByRole("link");
      expect(links[0].textContent).toMatch(/book a demo/i);
      expect(links[1].textContent).toMatch(/try the live demo/i);
    });

    it("renders inside a single <section> wrapper", () => {
      const { container } = render(<CTASection />);
      expect(container.querySelectorAll("section").length).toBe(1);
    });

    it("renders the heading + paragraph + CTA group nested inside the Container", () => {
      render(<CTASection />);
      const container = screen.getByTestId("container");
      expect(
        container.querySelector("h2")?.textContent
      ).toMatch(/ready to streamline your hospital/i);
      expect(container.querySelectorAll("a").length).toBe(2);
    });
  });
});
