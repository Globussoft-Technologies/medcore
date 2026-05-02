/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("../_components/Container", () => ({
  Container: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("../_components/CTASection", () => ({
  CTASection: () => <div data-testid="cta-section">CTA</div>,
}));

import PricingPage from "../pricing/page";

describe("Marketing PricingPage", () => {
  it("smoke renders without throwing", () => {
    render(<PricingPage />);
  });

  it("renders the three pricing tiers", () => {
    render(<PricingPage />);
    expect(screen.getAllByText(/^Starter$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^Professional$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^Enterprise$/).length).toBeGreaterThan(0);
  });

  it("renders Indian-rupee price points", () => {
    render(<PricingPage />);
    // Use partial matches because the prices may be split across nodes.
    expect(screen.getByText(/₹9,999/)).toBeInTheDocument();
    expect(screen.getByText(/₹24,999/)).toBeInTheDocument();
  });

  it("includes a 'Contact us' CTA for the enterprise tier", () => {
    render(<PricingPage />);
    expect(screen.getAllByText(/contact us/i).length).toBeGreaterThan(0);
  });

  it("mounts the bottom CTA section", () => {
    render(<PricingPage />);
    expect(screen.getByTestId("cta-section")).toBeInTheDocument();
  });
});
