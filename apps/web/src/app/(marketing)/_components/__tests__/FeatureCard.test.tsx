/**
 * FeatureCard coverage suite.
 *
 * What: smoke render + structural assertions for the marketing FeatureCard
 * tile (icon slot, title, description, optional href wrapper). Covers both
 * branches of the ternary at the bottom (href present -> <Link>, href absent
 * -> bare <div>) so the conditional renders both ways.
 * Which: apps/web/src/app/(marketing)/_components/FeatureCard.tsx.
 * Why: the file shipped with no tests (per test-cron pick 2026-05-26). The
 * component is purely presentational, so we mock next/link (mirroring the
 * sibling CTASection.test.tsx convention) and pass a stub lucide icon as
 * the required `icon` prop.
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

import { FeatureCard } from "../FeatureCard";

// Stub lucide icon — the component just passes className through and renders it.
const StubIcon = (props: any) => <svg data-testid="stub-icon" {...props} />;

afterEach(() => cleanup());

describe("FeatureCard", () => {
  describe("required slots", () => {
    it("smoke renders without throwing", () => {
      const { container } = render(
        <FeatureCard icon={StubIcon as any} title="T" description="D" />
      );
      expect(container.firstChild).toBeTruthy();
    });

    it("renders the title as an <h3>", () => {
      render(
        <FeatureCard
          icon={StubIcon as any}
          title="Smart scheduling"
          description="anything"
        />
      );
      const heading = screen.getByRole("heading", {
        name: "Smart scheduling",
        level: 3,
      });
      expect(heading).toBeInTheDocument();
    });

    it("renders the description copy", () => {
      render(
        <FeatureCard
          icon={StubIcon as any}
          title="t"
          description="Reduce no-shows by 40% with AI reminders."
        />
      );
      expect(
        screen.getByText(/reduce no-shows by 40% with ai reminders\./i)
      ).toBeInTheDocument();
    });

    it("renders the supplied icon component inside the icon chip", () => {
      render(
        <FeatureCard icon={StubIcon as any} title="t" description="d" />
      );
      const icon = screen.getByTestId("stub-icon");
      expect(icon).toBeInTheDocument();
      // The component pins h-6 w-6 sizing on the rendered icon.
      expect(icon.getAttribute("class") ?? "").toMatch(/h-6/);
      expect(icon.getAttribute("class") ?? "").toMatch(/w-6/);
    });
  });

  describe("href branch", () => {
    it("wraps the tile in a <Link> when `href` is provided", () => {
      render(
        <FeatureCard
          icon={StubIcon as any}
          title="Patients"
          description="Manage patients."
          href="/features/patients"
        />
      );
      const link = screen.getByRole("link");
      expect(link.getAttribute("href")).toBe("/features/patients");
      // The heading must be nested inside the link.
      expect(
        link.querySelector("h3")?.textContent
      ).toBe("Patients");
    });

    it("does NOT render an <a> when `href` is omitted", () => {
      render(
        <FeatureCard icon={StubIcon as any} title="t" description="d" />
      );
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });

    it("does NOT render an <a> when `href` is explicitly undefined", () => {
      render(
        <FeatureCard
          icon={StubIcon as any}
          title="t"
          description="d"
          href={undefined}
        />
      );
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });
  });

  describe("structure", () => {
    it("renders title and description in the same tile", () => {
      const { container } = render(
        <FeatureCard
          icon={StubIcon as any}
          title="Inventory"
          description="Track stock in realtime."
        />
      );
      const h3 = container.querySelector("h3");
      const p = container.querySelector("p");
      expect(h3?.textContent).toBe("Inventory");
      expect(p?.textContent).toBe("Track stock in realtime.");
    });

    it("renders exactly one icon, one heading, one paragraph per card", () => {
      const { container } = render(
        <FeatureCard icon={StubIcon as any} title="t" description="d" />
      );
      expect(container.querySelectorAll("svg").length).toBe(1);
      expect(container.querySelectorAll("h3").length).toBe(1);
      expect(container.querySelectorAll("p").length).toBe(1);
    });

    it("links the entire tile (heading + description both inside the <a>) when href is set", () => {
      render(
        <FeatureCard
          icon={StubIcon as any}
          title="Billing"
          description="Send invoices in one click."
          href="/features/billing"
        />
      );
      const link = screen.getByRole("link");
      expect(link.querySelector("h3")?.textContent).toBe("Billing");
      expect(link.querySelector("p")?.textContent).toBe(
        "Send invoices in one click."
      );
    });
  });
});
