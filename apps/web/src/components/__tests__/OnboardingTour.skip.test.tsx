// Issue #122: hitting "Skip tour" on one page must persist a per-user flag
// so the tour does not reappear on sibling pages. The flag is keyed by user
// id (`medcore_onboarding_skipped:<userId>`) so multi-user kiosks behave
// correctly.
//
// Issue #502: the per-user-id flag relied on `userId` being defined at the
// moment Skip was clicked. The user reported the tour reappearing on every
// /dashboard visit despite `mc_tour_<role>` being set — exactly the symptom
// of `markOnboardingSkipped(undefined)` being a no-op. This file now also
// asserts that a single global `medcore_tour_completed_v1` flag is written
// by Skip and Finish, regardless of role / userId, and that subsequent
// auto-launch checks correctly suppress the tour.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import {
  OnboardingTour,
  hasCompletedTour,
  hasSkippedOnboarding,
  onboardingSkipKey,
  resetTour,
  clearOnboardingSkipped,
  TOUR_COMPLETED_V1_KEY,
} from "../OnboardingTour";

describe("OnboardingTour — Issue #122 skip persistence", () => {
  const USER_ID = "u_test_42";
  const ROLE = "DOCTOR";

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists the skip flag to localStorage under the user-id-keyed key", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <OnboardingTour
        role={ROLE}
        userId={USER_ID}
        open={true}
        onClose={onClose}
      />
    );
    await user.click(screen.getByRole("button", { name: /skip tour/i }));
    expect(
      window.localStorage.getItem(onboardingSkipKey(USER_ID))
    ).toBe("1");
    expect(onClose).toHaveBeenCalled();
  });

  it("hasSkippedOnboarding reads back the persisted flag", () => {
    expect(hasSkippedOnboarding(USER_ID)).toBe(false);
    window.localStorage.setItem(onboardingSkipKey(USER_ID), "1");
    expect(hasSkippedOnboarding(USER_ID)).toBe(true);
  });

  it("hasCompletedTour returns true when the per-user skip flag is set, regardless of role", () => {
    // Different role-specific completion key is empty …
    expect(hasCompletedTour("ADMIN", USER_ID)).toBe(false);
    // … but once the per-user skip flag is set, ANY role check is suppressed.
    window.localStorage.setItem(onboardingSkipKey(USER_ID), "1");
    expect(hasCompletedTour("ADMIN", USER_ID)).toBe(true);
    expect(hasCompletedTour("RECEPTION", USER_ID)).toBe(true);
  });

  it("resetTour clears both the role completion AND the per-user skip flag", () => {
    window.localStorage.setItem("mc_tour_DOCTOR", "1");
    window.localStorage.setItem(onboardingSkipKey(USER_ID), "1");
    act(() => resetTour(ROLE, USER_ID));
    expect(window.localStorage.getItem("mc_tour_DOCTOR")).toBeNull();
    expect(window.localStorage.getItem(onboardingSkipKey(USER_ID))).toBeNull();
  });

  it("clearOnboardingSkipped is a no-op when no userId is supplied", () => {
    window.localStorage.setItem(onboardingSkipKey(USER_ID), "1");
    clearOnboardingSkipped(null);
    expect(
      window.localStorage.getItem(onboardingSkipKey(USER_ID))
    ).toBe("1");
  });
});

// Issue #502: regression-block. Skip + Finish must persist a single global
// flag (`medcore_tour_completed_v1` = "true") that suppresses the auto-launch
// on every subsequent dashboard mount, EVEN when `userId` is undefined at the
// moment of click. This is the actual root cause of #502: the existing per-
// user-id key was a no-op when the auth store hadn't yet hydrated `user.id`,
// so the tour reopened despite the role-keyed completion flag also being set.
describe("OnboardingTour — Issue #502 v1 global skip flag", () => {
  const ROLE = "NURSE";

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("Skip click writes medcore_tour_completed_v1='true' even with no userId", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <OnboardingTour
        role={ROLE}
        userId={undefined}
        open={true}
        onClose={onClose}
      />
    );
    await user.click(screen.getByRole("button", { name: /skip tour/i }));
    expect(
      window.localStorage.getItem(TOUR_COMPLETED_V1_KEY)
    ).toBe("true");
    expect(onClose).toHaveBeenCalled();
  });

  it("Finish click (last step) writes medcore_tour_completed_v1='true'", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    // NURSE has 5 steps — click Next 4 times then Finish on the 5th button
    // press, exercising the full markTourCompleted -> v1 path.
    const { rerender } = render(
      <OnboardingTour
        role={ROLE}
        userId={undefined}
        open={true}
        onClose={onClose}
      />
    );
    for (let i = 0; i < 5; i++) {
      await user.click(
        screen.getByRole("button", { name: i === 4 ? /finish/i : /next/i })
      );
    }
    expect(
      window.localStorage.getItem(TOUR_COMPLETED_V1_KEY)
    ).toBe("true");
    expect(onClose).toHaveBeenCalled();
    // After dismissal, hasCompletedTour must report true regardless of role.
    expect(hasCompletedTour("ADMIN", null)).toBe(true);
    expect(hasCompletedTour("NURSE", null)).toBe(true);
    // …and a fresh render with open=false-by-default (the layout's auto-launch
    // gate would short-circuit before passing open=true) keeps the dialog hidden.
    rerender(
      <OnboardingTour
        role={ROLE}
        userId={undefined}
        open={false}
        onClose={onClose}
      />
    );
    expect(screen.queryByRole("dialog", { name: /product tour/i })).toBeNull();
  });

  it("after Skip with no userId, hasCompletedTour() returns true on next visit", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <OnboardingTour
        role={ROLE}
        userId={undefined}
        open={true}
        onClose={onClose}
      />
    );
    // Confirm the tour is initially visible (the auto-launch gate would have
    // opened it on the first visit).
    expect(
      screen.getByRole("dialog", { name: /product tour/i })
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /skip tour/i }));
    // Simulate the next dashboard mount — the layout would call
    // `hasCompletedTour(user.role, user.id)`. With userId still undefined
    // (the v1 fix), this MUST return true so `setTourOpen(true)` never fires.
    expect(hasCompletedTour(ROLE, undefined)).toBe(true);
    expect(hasCompletedTour(ROLE, null)).toBe(true);
  });

  it("hasCompletedTour reads back the v1 flag for any role", () => {
    expect(hasCompletedTour("DOCTOR", null)).toBe(false);
    window.localStorage.setItem(TOUR_COMPLETED_V1_KEY, "true");
    expect(hasCompletedTour("ADMIN", null)).toBe(true);
    expect(hasCompletedTour("NURSE", null)).toBe(true);
    expect(hasCompletedTour("PATIENT", null)).toBe(true);
  });

  it("resetTour clears the v1 flag so 'Take the tour' can re-launch", () => {
    window.localStorage.setItem(TOUR_COMPLETED_V1_KEY, "true");
    act(() => resetTour(ROLE, null));
    expect(window.localStorage.getItem(TOUR_COMPLETED_V1_KEY)).toBeNull();
    expect(hasCompletedTour(ROLE, null)).toBe(false);
  });
});
