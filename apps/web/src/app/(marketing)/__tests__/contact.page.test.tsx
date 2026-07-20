/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../_components/Container", () => ({
  Container: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("../contact/EnquiryForm", () => ({
  EnquiryForm: () => <form data-testid="enquiry-form">Mocked Form</form>,
}));

import ContactPage from "../contact/page";

describe("Marketing ContactPage", () => {
  it("smoke renders without throwing", () => {
    render(<ContactPage />);
  });

  it("renders the hero headline", () => {
    render(<ContactPage />);
    expect(screen.getByText(/let.s talk\./i)).toBeInTheDocument();
  });

  it("mounts the EnquiryForm client component", () => {
    render(<ContactPage />);
    expect(screen.getByTestId("enquiry-form")).toBeInTheDocument();
  });

  it("renders the get in touch panel with email/phone/office", () => {
    render(<ContactPage />);
    expect(screen.getByText(/get in touch/i)).toBeInTheDocument();
    expect(screen.getByText(/support@medcore\.software/i)).toBeInTheDocument();
    expect(screen.getAllByText(/bangalore, india/i).length).toBeGreaterThan(0);
  });

  it("renders a phone link with tel: scheme", () => {
    render(<ContactPage />);
    const link = screen.getByRole("link", { name: /\+91/ });
    expect(link.getAttribute("href")).toMatch(/^tel:/);
  });

  it("embeds a Google map pointed at the Koramangala office", () => {
    render(<ContactPage />);
    // The map is an <iframe> with an accessible title.
    const map = screen.getByTitle(/koramangala|udaya mansion/i);
    expect(map.tagName).toBe("IFRAME");
    const src = map.getAttribute("src") || "";
    expect(src).toContain("google.com/maps");
    expect(src).toMatch(/koramangala/i);
    expect(src).toContain("output=embed");
    // Lazy-loaded so it never blocks first paint.
    expect(map.getAttribute("loading")).toBe("lazy");
  });

  it("map carries the theme-aware .map-embed class (dark/light styling hook)", () => {
    render(<ContactPage />);
    const map = screen.getByTitle(/koramangala|udaya mansion/i);
    expect(map.className).toContain("map-embed");
  });
});
