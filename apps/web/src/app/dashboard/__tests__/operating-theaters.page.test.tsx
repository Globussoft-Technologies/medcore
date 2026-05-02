/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { routerReplace } = vi.hoisted(() => ({
  routerReplace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/operating-theaters",
}));

import OperatingTheatersRedirect from "../operating-theaters/page";

describe("OperatingTheatersRedirect", () => {
  beforeEach(() => {
    routerReplace.mockReset();
  });

  it("renders the redirecting placeholder", () => {
    render(<OperatingTheatersRedirect />);
    expect(
      screen.getByTestId("operating-theaters-redirect")
    ).toBeInTheDocument();
  });

  it("shows the redirect message text", () => {
    render(<OperatingTheatersRedirect />);
    expect(screen.getByText(/redirecting to operating theatres/i)).toBeInTheDocument();
  });

  it("calls router.replace('/dashboard/ot') on mount", async () => {
    render(<OperatingTheatersRedirect />);
    await waitFor(() =>
      expect(routerReplace).toHaveBeenCalledWith("/dashboard/ot")
    );
  });

  it("does not throw when rendered repeatedly", () => {
    expect(() => {
      render(<OperatingTheatersRedirect />);
      render(<OperatingTheatersRedirect />);
    }).not.toThrow();
  });
});
