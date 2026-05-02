/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { routerReplaceMock } = vi.hoisted(() => ({
  routerReplaceMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: routerReplaceMock,
    back: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/blood-bank",
}));

import BloodBankHyphenRedirect from "../blood-bank/page";

describe("BloodBankHyphenRedirect", () => {
  beforeEach(() => {
    routerReplaceMock.mockReset();
  });

  it("smoke renders the placeholder copy", () => {
    render(<BloodBankHyphenRedirect />);
    expect(screen.getByTestId("blood-bank-redirect")).toBeInTheDocument();
    expect(screen.getByText(/redirecting to blood bank/i)).toBeInTheDocument();
  });

  it("forwards to the canonical /dashboard/bloodbank URL on mount", async () => {
    render(<BloodBankHyphenRedirect />);
    await waitFor(() =>
      expect(routerReplaceMock).toHaveBeenCalledWith("/dashboard/bloodbank")
    );
  });

  it("only fires the replace once for a single mount", async () => {
    render(<BloodBankHyphenRedirect />);
    await waitFor(() =>
      expect(routerReplaceMock).toHaveBeenCalledTimes(1)
    );
  });

  it("re-renders without throwing when router is stable", async () => {
    // The page reads router from the hook; the mock above is stable. We
    // verify the page survives a re-render and still shows its placeholder
    // copy. We don't assert call count here because effects run per
    // double-invoked render in StrictMode-ish setups.
    const { rerender } = render(<BloodBankHyphenRedirect />);
    rerender(<BloodBankHyphenRedirect />);
    await waitFor(() =>
      expect(screen.getByTestId("blood-bank-redirect")).toBeInTheDocument()
    );
  });
});
