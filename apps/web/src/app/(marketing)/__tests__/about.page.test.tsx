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
vi.mock("next/image", () => ({
  default: ({ alt, src, ...rest }: any) => (
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    <img alt={alt} src={typeof src === "string" ? src : ""} {...rest} />
  ),
}));
vi.mock("../_components/Container", () => ({
  Container: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("../_components/CTASection", () => ({
  CTASection: () => <div data-testid="cta-section">CTA</div>,
}));

import AboutPage from "../about/page";

describe("Marketing AboutPage", () => {
  it("smoke renders without throwing", () => {
    render(<AboutPage />);
  });

  it("renders the hero headline", () => {
    render(<AboutPage />);
    expect(
      screen.getAllByText(/built with doctors, not for them/i).length
    ).toBeGreaterThan(0);
  });

  it("lists the founding team members", () => {
    render(<AboutPage />);
    expect(screen.getByText(/sumit ghosh/i)).toBeInTheDocument();
    expect(screen.getByText(/aishwarya m/i)).toBeInTheDocument();
  });

  it("renders the values section", () => {
    render(<AboutPage />);
    expect(screen.getByText(/what we believe/i)).toBeInTheDocument();
    expect(screen.getByText(/honest pricing/i)).toBeInTheDocument();
  });

  it("renders the timeline section", () => {
    render(<AboutPage />);
    expect(screen.getByText(/our journey/i)).toBeInTheDocument();
    expect(screen.getByText(/founded/i)).toBeInTheDocument();
  });

  it("mounts the CTA section", () => {
    render(<AboutPage />);
    expect(screen.getByTestId("cta-section")).toBeInTheDocument();
  });
});
