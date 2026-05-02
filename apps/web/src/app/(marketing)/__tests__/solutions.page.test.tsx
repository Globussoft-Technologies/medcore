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

import SolutionsPage from "../solutions/page";

describe("Marketing SolutionsPage", () => {
  it("smoke renders without throwing", () => {
    render(<SolutionsPage />);
  });

  it("renders the three hospital-size variants", () => {
    render(<SolutionsPage />);
    expect(screen.getAllByText(/small clinic/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/mid-size hospital/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/multi-specialty/i).length).toBeGreaterThan(0);
  });

  it("renders representative bullet points", () => {
    render(<SolutionsPage />);
    expect(
      screen.getByText(/digital prescriptions with qr/i)
    ).toBeInTheDocument();
  });

  it("renders price-from copy with rupee symbol", () => {
    render(<SolutionsPage />);
    expect(screen.getByText(/₹9,999\/mo/)).toBeInTheDocument();
  });

  it("mounts the bottom CTA section", () => {
    render(<SolutionsPage />);
    expect(screen.getByTestId("cta-section")).toBeInTheDocument();
  });
});
