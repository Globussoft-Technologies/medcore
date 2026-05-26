/**
 * OnboardingTour navigation + dismissal coverage.
 *
 * What / which modules / why:
 *   - Source under test: apps/web/src/components/OnboardingTour.tsx
 *   - Companion to `OnboardingTour.skip.test.tsx`, which already covers
 *     Issue #122 (per-user skip flag) and Issue #502 (global v1 flag).
 *     This file picks up the remaining behaviour surfaces of the dialog:
 *       1. Step-by-step navigation (Next / Back) including the step pip
 *          indicator state and the "Step N of M" header.
 *       2. Router push side-effect — clicking Next on a step whose `next`
 *          has an `href` must call `router.push(href)`.
 *       3. Issue #561 dismissal hatches:
 *          - Escape-to-skip keydown handler (uncovered lines 189-193).
 *          - Click-outside-to-skip on the backdrop (vs. stopPropagation
 *            on the inner card so internal clicks don't dismiss).
 *       4. Open/close lifecycle:
 *          - `open=false` renders nothing.
 *          - Re-opening the dialog resets the step counter back to 0.
 *       5. Role fallback — an unknown role string falls back to the
 *          PATIENT tour rather than crashing.
 *       6. The Back button only appears once `step > 0`.
 *
 *   - Mocks `next/navigation`'s `useRouter` to spy on `push` calls.
 *   - All other helpers (markTourCompleted, etc.) are real localStorage
 *     interactions in jsdom.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { routerMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), replace: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

import { OnboardingTour, TOUR_COMPLETED_V1_KEY, tourStorageKey } from "../OnboardingTour";

describe("OnboardingTour — navigation, lifecycle and dismissal hatches", () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    routerMock.push.mockReset();
    routerMock.replace.mockReset();
  });

  it("renders nothing when open=false", () => {
    const { container } = render(
      <OnboardingTour role="DOCTOR" open={false} onClose={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders the dialog with step 1 of 5 and the first step title for DOCTOR", () => {
    render(<OnboardingTour role="DOCTOR" open={true} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: /product tour/i });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText(/Step 1 of 5/i)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Workspace/i }),
    ).toBeInTheDocument();
    // Back button must NOT appear on the first step.
    expect(
      screen.queryByRole("button", { name: /^Back$/ }),
    ).not.toBeInTheDocument();
  });

  it("clicking Next advances the step, calls router.push for the next step's href, and reveals Back", async () => {
    const user = userEvent.setup();
    render(<OnboardingTour role="DOCTOR" open={true} onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /^Next$/ }));

    expect(screen.getByText(/Step 2 of 5/i)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Queue/i }),
    ).toBeInTheDocument();
    // DOCTOR step 2's href is /dashboard/queue — must be pushed.
    expect(routerMock.push).toHaveBeenCalledWith("/dashboard/queue");
    // Back is now available.
    expect(screen.getByRole("button", { name: /^Back$/ })).toBeInTheDocument();
  });

  it("clicking Back returns to the previous step without calling router.push", async () => {
    const user = userEvent.setup();
    render(<OnboardingTour role="DOCTOR" open={true} onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /^Next$/ }));
    routerMock.push.mockClear();
    await user.click(screen.getByRole("button", { name: /^Back$/ }));

    expect(screen.getByText(/Step 1 of 5/i)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Workspace/i }),
    ).toBeInTheDocument();
    // Back is a pure local-state move — must NOT navigate.
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("clicking Next on the final step calls Finish: writes role + v1 completion flags and onClose()", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<OnboardingTour role="ADMIN" open={true} onClose={onClose} />);

    // ADMIN has 5 steps; click Next 4 times then Finish on the 5th.
    for (let i = 0; i < 4; i++) {
      await user.click(screen.getByRole("button", { name: /^Next$/ }));
    }
    expect(screen.getByText(/Step 5 of 5/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Finish$/ }));

    expect(window.localStorage.getItem(tourStorageKey("ADMIN"))).toBe("1");
    expect(window.localStorage.getItem(TOUR_COMPLETED_V1_KEY)).toBe("true");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pressing Escape dismisses the tour as a Skip (writes v1 flag, fires onClose) — Issue #561", () => {
    const onClose = vi.fn();
    render(
      <OnboardingTour
        role="NURSE"
        userId="u_esc"
        open={true}
        onClose={onClose}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: /product tour/i }),
    ).toBeInTheDocument();

    act(() => {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(event);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    // Skip path persists the global v1 flag.
    expect(window.localStorage.getItem(TOUR_COMPLETED_V1_KEY)).toBe("true");
  });

  it("non-Escape keys do NOT dismiss the tour", () => {
    const onClose = vi.fn();
    render(
      <OnboardingTour role="NURSE" open={true} onClose={onClose} />,
    );

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: /product tour/i }),
    ).toBeInTheDocument();
  });

  it("clicking the backdrop dismisses as a Skip, but clicking inside the card does NOT — Issue #561", () => {
    const onClose = vi.fn();
    render(
      <OnboardingTour role="RECEPTION" open={true} onClose={onClose} />,
    );

    const dialog = screen.getByRole("dialog", { name: /product tour/i });
    // Click inside the card first (the heading) — onClick stopPropagation must
    // prevent the backdrop's skip handler from firing.
    fireEvent.click(screen.getByRole("heading", { name: /Dashboard/i }));
    expect(onClose).not.toHaveBeenCalled();

    // Now click the dialog wrapper itself (= the backdrop).
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("unmounting the dialog removes the Escape listener (no late-fire after close)", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <OnboardingTour role="DOCTOR" open={true} onClose={onClose} />,
    );
    // Toggle the dialog closed — the cleanup return from the keydown effect
    // should detach the listener so a stray Escape doesn't call skip again.
    rerender(
      <OnboardingTour role="DOCTOR" open={false} onClose={onClose} />,
    );
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("re-opening the dialog after a close resets the step counter back to 0", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <OnboardingTour role="ADMIN" open={true} onClose={onClose} />,
    );

    await user.click(screen.getByRole("button", { name: /^Next$/ }));
    expect(screen.getByText(/Step 2 of 5/i)).toBeInTheDocument();

    // Caller closes the dialog without clicking Skip/Finish — the next open
    // must restart at step 1 (Issue: layout re-mounts mustn't strand the
    // user mid-tour on an obsolete step).
    rerender(<OnboardingTour role="ADMIN" open={false} onClose={onClose} />);
    rerender(<OnboardingTour role="ADMIN" open={true} onClose={onClose} />);

    expect(screen.getByText(/Step 1 of 5/i)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Dashboard/i }),
    ).toBeInTheDocument();
  });

  it("falls back to the PATIENT tour when role is an unknown string (no crash)", () => {
    render(
      <OnboardingTour
        role="MARTIAN_OVERLORD"
        open={true}
        onClose={vi.fn()}
      />,
    );

    // PATIENT step 1 is "Home" — proves we landed on the fallback tour.
    expect(screen.getByText(/Step 1 of 5/i)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /^Home$/i }),
    ).toBeInTheDocument();
  });

  it("renders one step-pip per step in the indicator row", () => {
    const { container } = render(
      <OnboardingTour role="PATIENT" open={true} onClose={vi.fn()} />,
    );
    // The pip row is the only flex row of identical <span> children — 5 for PATIENT.
    const pips = container.querySelectorAll("span.h-1\\.5");
    expect(pips.length).toBe(5);
  });

  it("Skip button (header X-style) fires Skip path with the userId persisted under the per-user key", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <OnboardingTour
        role="ADMIN"
        userId="u_header_skip"
        open={true}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Skip tour/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
    // Both per-user and global flags set on the Skip path.
    expect(
      window.localStorage.getItem(`medcore_onboarding_skipped:u_header_skip`),
    ).toBe("1");
    expect(window.localStorage.getItem(TOUR_COMPLETED_V1_KEY)).toBe("true");
  });
});
