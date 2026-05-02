/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { routerReplace } = vi.hoisted(() => ({
  routerReplace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/reports/scheduled",
}));

import ScheduledReportsRedirectPage from "../reports/scheduled/page";

describe("ScheduledReportsRedirectPage", () => {
  beforeEach(() => {
    routerReplace.mockReset();
  });

  it("renders the redirect placeholder", () => {
    render(<ScheduledReportsRedirectPage />);
    expect(
      screen.getByTestId("scheduled-reports-redirect")
    ).toBeInTheDocument();
  });

  it("shows the 'Redirecting to Scheduled Reports' message", () => {
    render(<ScheduledReportsRedirectPage />);
    expect(
      screen.getByText(/redirecting to scheduled reports/i)
    ).toBeInTheDocument();
  });

  it("calls router.replace('/dashboard/scheduled-reports')", async () => {
    render(<ScheduledReportsRedirectPage />);
    await waitFor(() =>
      expect(routerReplace).toHaveBeenCalledWith("/dashboard/scheduled-reports")
    );
  });

  it("does not throw when re-rendered", () => {
    expect(() => {
      render(<ScheduledReportsRedirectPage />);
      render(<ScheduledReportsRedirectPage />);
    }).not.toThrow();
  });
});
