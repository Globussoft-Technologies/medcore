/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/immunization-schedule",
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: any) => <a {...rest}>{children}</a>,
}));

import ImmunizationSchedulePage from "../immunization-schedule/page";

describe("ImmunizationSchedulePage (Issue #426)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.get.mockResolvedValue({ data: [] });
  });

  it("clicking a filter chip flips the active state and re-fetches with the new filter", async () => {
    const user = userEvent.setup();
    render(<ImmunizationSchedulePage />);

    // Initial mount: filter=week is the default.
    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringContaining("filter=week")
      );
    });
    expect(
      screen.getByTestId("immunization-filter-week").getAttribute("data-active")
    ).toBe("true");
    expect(
      screen
        .getByTestId("immunization-filter-month")
        .getAttribute("data-active")
    ).toBe("false");

    // Click Overdue — the active flag must move AND a new fetch must fire
    // with filter=overdue. Both conditions are what the user reported as
    // broken in #426.
    apiMock.get.mockClear();
    apiMock.get.mockResolvedValue({ data: [] });
    await user.click(screen.getByTestId("immunization-filter-overdue"));

    await waitFor(() => {
      expect(apiMock.get).toHaveBeenCalledWith(
        expect.stringContaining("filter=overdue")
      );
    });
    expect(
      screen
        .getByTestId("immunization-filter-overdue")
        .getAttribute("data-active")
    ).toBe("true");
    expect(
      screen.getByTestId("immunization-filter-week").getAttribute("data-active")
    ).toBe("false");
  });
});
