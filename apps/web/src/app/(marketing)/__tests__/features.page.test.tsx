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

import FeaturesPage from "../features/page";

describe("Marketing FeaturesPage", () => {
  it("smoke renders without throwing", () => {
    render(<FeaturesPage />);
  });

  it("renders all top-level section headings", () => {
    render(<FeaturesPage />);
    expect(screen.getAllByText(/clinical/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/operations/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/finance/i).length).toBeGreaterThan(0);
  });

  it("renders representative bullet points", () => {
    render(<FeaturesPage />);
    expect(
      screen.getByText(/digital prescriptions with scannable qr/i)
    ).toBeInTheDocument();
  });

  it("renders the bottom CTA section", () => {
    render(<FeaturesPage />);
    expect(screen.getByTestId("cta-section")).toBeInTheDocument();
  });

  it("renders the page in a way that does not crash on missing screenshots", () => {
    // Image src is mocked to a plain <img>; this would throw if FeaturesPage
    // referenced a non-string src. Just assert SOME image rendered.
    render(<FeaturesPage />);
    expect(document.querySelectorAll("img").length).toBeGreaterThan(0);
  });
});
