/* eslint-disable @typescript-eslint/no-explicit-any */
// Component tests for the nurse-facing "My Leaves" form.
//
// Covers the issue #19 / #32 regression: entering a reversed date range
// (To earlier than From) must now produce a FIELD-LEVEL error next to the
// To-date input — NOT a generic alert() blocking modal.
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

vi.mock("@/lib/api", () => ({ api: apiMock, openPrintEndpoint: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/my-leaves",
}));

import MyLeavesPage from "../my-leaves/page";

describe("MyLeavesPage — reversed date range (issues #19, #32)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    // /leaves/my response
    apiMock.get.mockResolvedValue({
      data: {
        leaves: [],
        summary: { pending: 0, approved: 0, used: {} },
      },
    });
  });

  async function openRequestModal() {
    const user = userEvent.setup();
    render(<MyLeavesPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /request leave/i })
      ).toBeInTheDocument()
    );
    await user.click(screen.getByRole("button", { name: /request leave/i }));
    await waitFor(() =>
      expect(screen.getByLabelText(/^from$/i)).toBeInTheDocument()
    );
    return user;
  }

  it("shows a field-level error below the To-date input when To < From", async () => {
    const user = await openRequestModal();

    const fromInput = screen.getByLabelText(/^from$/i);
    const toInput = screen.getByLabelText(/^to$/i);

    // Fill reversed dates: From = 2026-04-25, To = 2026-04-20.
    await user.type(fromInput, "2026-04-25");
    await user.type(toInput, "2026-04-20");

    // The error must appear reactively, without the user having to submit.
    await waitFor(() => {
      const err = screen.queryByRole("alert");
      expect(err).not.toBeNull();
      expect(err!.textContent).toMatch(/on or after/i);
    });

    // The To input must be marked invalid for assistive tech.
    expect(toInput).toHaveAttribute("aria-invalid", "true");
  });

  it("does NOT call alert() when submitting a reversed range — only shows inline error", async () => {
    const user = await openRequestModal();
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

    await user.type(screen.getByLabelText(/^from$/i), "2026-04-25");
    await user.type(screen.getByLabelText(/^to$/i), "2026-04-20");
    await user.type(screen.getByLabelText(/reason/i), "Testing");

    // Submit the form
    await user.click(screen.getByRole("button", { name: /submit request/i }));

    // The client-side guard must block the POST AND skip the alert.
    await waitFor(() => {
      expect(apiMock.post).not.toHaveBeenCalled();
      expect(screen.getByRole("alert").textContent).toMatch(/on or after/i);
    });
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it("clears the error once the user fixes the range", async () => {
    const user = await openRequestModal();
    const fromInput = screen.getByLabelText(/^from$/i);
    const toInput = screen.getByLabelText(/^to$/i);

    await user.type(fromInput, "2026-04-25");
    await user.type(toInput, "2026-04-20");
    // Error should be visible.
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());

    // Fix the To date so it's on-or-after the From date.
    await user.clear(toInput);
    await user.type(toInput, "2026-04-26");

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
    expect(toInput).not.toHaveAttribute("aria-invalid", "true");
  });

  it("surfaces a server-returned Zod fieldError as an inline message", async () => {
    const user = await openRequestModal();
    const err = Object.assign(new Error("Validation failed"), {
      status: 400,
      payload: {
        success: false,
        error: "Validation failed",
        details: [
          { field: "toDate", message: "toDate must be on or after fromDate" },
        ],
      },
    });
    apiMock.post.mockRejectedValueOnce(err);

    // Valid dates from the client's perspective (so the client-side guard
    // passes), but the server objects — simulates schema drift.
    await user.type(screen.getByLabelText(/^from$/i), "2026-04-24");
    await user.type(screen.getByLabelText(/^to$/i), "2026-04-25");
    await user.type(screen.getByLabelText(/reason/i), "Server-side rejection");
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    await user.click(screen.getByRole("button", { name: /submit request/i }));

    await waitFor(() => {
      const alertEl = screen.queryByRole("alert");
      expect(alertEl).not.toBeNull();
      expect(alertEl!.textContent).toMatch(/on or after/i);
    });
    // No generic alert — the error renders inline.
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});
