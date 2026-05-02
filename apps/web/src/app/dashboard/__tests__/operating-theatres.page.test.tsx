/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { routerReplace } = vi.hoisted(() => ({
  routerReplace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/operating-theatres",
}));

import OperatingTheatresRedirect from "../operating-theatres/page";

describe("OperatingTheatresRedirect", () => {
  beforeEach(() => {
    routerReplace.mockReset();
  });

  it("renders the redirecting placeholder", () => {
    render(<OperatingTheatresRedirect />);
    expect(
      screen.getByTestId("operating-theatres-redirect")
    ).toBeInTheDocument();
  });

  it("shows the redirect message text", () => {
    render(<OperatingTheatresRedirect />);
    expect(screen.getByText(/redirecting to operating theatres/i)).toBeInTheDocument();
  });

  it("calls router.replace('/dashboard/ot') on mount", async () => {
    render(<OperatingTheatresRedirect />);
    await waitFor(() =>
      expect(routerReplace).toHaveBeenCalledWith("/dashboard/ot")
    );
  });

  it("does not throw when rendered twice", () => {
    expect(() => {
      render(<OperatingTheatresRedirect />);
      render(<OperatingTheatresRedirect />);
    }).not.toThrow();
  });
});
