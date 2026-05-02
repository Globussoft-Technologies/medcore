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
vi.mock("../_components/FeatureCard", () => ({
  FeatureCard: ({ title, description }: any) => (
    <div>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  ),
}));
vi.mock("../_components/CTASection", () => ({
  CTASection: () => <div data-testid="cta-section">CTA</div>,
}));

import HomePage from "../page";

describe("Marketing HomePage", () => {
  it("smoke renders without throwing", () => {
    render(<HomePage />);
  });

  it("renders the hero headline", () => {
    render(<HomePage />);
    expect(screen.getByText(/run your hospital/i)).toBeInTheDocument();
    expect(screen.getByText(/not spreadsheets/i)).toBeInTheDocument();
  });

  it("renders Request a demo and live demo CTAs", () => {
    render(<HomePage />);
    expect(screen.getByText(/request a demo/i)).toBeInTheDocument();
    expect(screen.getByText(/try the live demo/i)).toBeInTheDocument();
  });

  it("renders the trust logos band", () => {
    render(<HomePage />);
    expect(
      screen.getByText(/trusted by growing hospitals across india/i)
    ).toBeInTheDocument();
    expect(screen.getAllByText(/asha hospital/i).length).toBeGreaterThan(0);
  });

  it("renders feature card titles for clinical / operations / finance", () => {
    render(<HomePage />);
    expect(screen.getByText(/^Clinical$/)).toBeInTheDocument();
    expect(screen.getByText(/^Operations$/)).toBeInTheDocument();
    expect(screen.getByText(/^Finance$/)).toBeInTheDocument();
  });

  it("mounts the bottom CTA section", () => {
    render(<HomePage />);
    expect(screen.getByTestId("cta-section")).toBeInTheDocument();
  });
});
