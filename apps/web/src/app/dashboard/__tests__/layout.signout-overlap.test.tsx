/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Issue #486 — Sidebar "Sign Out" label must not wrap or visually overlap
 * the Quick Actions section in the main content.
 *
 * What this test guards
 * ---------------------
 * Before the fix the sidebar footer was a single horizontal `flex items-center
 * gap-2` row containing LanguageDropdown + ThemeToggle + Keyboard btn +
 * Settings link + Sign Out button. At 1350×803 (Chrome desktop default) the
 * remaining horizontal space for the Sign Out button was small enough that the
 * label "Sign Out" wrapped to two lines ("Sign / Out") inside a 256px-wide
 * aside. The wrapped label visually collided with the first Quick Action card
 * rendered just to the right of the sidebar.
 *
 * Which modules
 * -------------
 * - Source: apps/web/src/app/dashboard/layout.tsx (sidebar footer)
 * - Test:   this file
 *
 * Why these assertions
 * --------------------
 * We assert the LAYOUT CONTRACT that prevents the regression rather than
 * pixel positions (jsdom has no real layout engine, so getBoundingClientRect
 * returns zeroed boxes). Concretely:
 *
 *   1. The footer is a flex-COLUMN container with TWO children: a row of
 *      utility icons and a dedicated Sign Out button. This is the structural
 *      change that gives the label its own line.
 *
 *   2. The Sign Out button is rendered OUTSIDE the icon row, not as a sibling
 *      that has to share width with LanguageDropdown / ThemeToggle.
 *
 *   3. The Sign Out label has `whitespace-nowrap` applied so future i18n
 *      strings (or browser zoom) cannot re-introduce the wrap.
 *
 *   4. The Sign Out button takes the full width of the footer (`w-full`),
 *      which guarantees the label has the entire 256px sidebar width minus
 *      padding to lay out on a single line — far more than any plausible
 *      translation needs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { authMock, i18nMock, toastMock } = vi.hoisted(() => {
  // Translate the handful of keys the dashboard layout looks up directly
  // without passing a fallback string. The real i18n module returns the
  // resolved English copy; a bare `key ?? fallback` mock would surface the
  // raw key (e.g. "common.signOut") and break the aria-label assertion.
  const dict: Record<string, string> = {
    "common.signOut": "Sign Out",
    "common.settings": "Settings",
    "common.shortcuts": "Keyboard shortcuts",
    "common.lightMode": "Switch to light mode",
    "common.darkMode": "Switch to dark mode",
    "common.openMenu": "Open menu",
    "common.openSearch": "Open search",
    "common.loading": "Loading...",
    "common.profile": "Profile",
    "dashboard.nav.takeTour": "Take tour",
  };
  return {
    authMock: vi.fn(),
    i18nMock: {
      t: (key: string, fallback?: string) => dict[key] ?? fallback ?? key,
    },
    toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  };
});

vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/theme", () => ({
  useThemeStore: (selector: any) => {
    const state = { resolved: "light" as const, toggle: vi.fn() };
    return typeof selector === "function" ? selector(state) : state;
  },
}));
vi.mock("@/lib/i18n", () => ({
  useTranslation: () => i18nMock,
}));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/use-dialog", () => ({
  DialogProvider: ({ children }: any) => <>{children}</>,
  useDialog: () => ({}),
}));
vi.mock("@/components/KeyboardShortcutsModal", () => ({
  KeyboardShortcutsModal: () => null,
}));
vi.mock("@/components/Tooltip", () => ({ Tooltip: ({ children }: any) => <>{children}</> }));
vi.mock("@/components/HelpPanel", () => ({ HelpPanel: () => null }));
vi.mock("@/components/OnboardingTour", () => ({
  OnboardingTour: () => null,
  hasCompletedTour: () => true,
  resetTour: vi.fn(),
}));
vi.mock("@/components/LanguageDropdown", () => ({
  LanguageDropdown: () => (
    <div data-testid="lang-dropdown-stub" style={{ width: 70, height: 32 }} />
  ),
}));
vi.mock("@/components/ThemeToggle", () => ({
  ThemeToggle: () => (
    <button data-testid="theme-toggle-stub" type="button" aria-label="theme">
      T
    </button>
  ),
}));
vi.mock("./../_components/search-palette", () => ({
  SearchPalette: () => null,
}));

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import DashboardLayout from "../layout";

describe("Issue #486 — Sidebar Sign Out does not overlap Quick Actions", () => {
  beforeEach(() => {
    routerPush.mockReset();
    // ADMIN has the LONGEST sidebar nav (~70 items) — exactly the role that
    // exposed the wrap bug because the footer was already cramped after a
    // long scroll-down list rendered above it.
    authMock.mockReturnValue({
      user: { id: "u1", name: "Admin", email: "a@x.com", role: "ADMIN" },
      isLoading: false,
      loadSession: vi.fn(),
      logout: vi.fn(),
    });
  });

  it("footer uses a flex-column with utility-row + dedicated Sign Out row (not a single horizontal row)", () => {
    render(
      <DashboardLayout>
        <div>child</div>
      </DashboardLayout>
    );

    const footer = screen.getByTestId("sidebar-footer");
    // Pre-fix this was `flex items-center gap-2` (single horizontal row).
    // Post-fix it must be `flex flex-col` so Sign Out gets its own row.
    expect(footer.className).toMatch(/\bflex\b/);
    expect(footer.className).toMatch(/\bflex-col\b/);

    // Two direct children: utility-icons row + sign-out button.
    expect(footer.children.length).toBe(2);

    const actionsRow = screen.getByTestId("sidebar-footer-actions");
    expect(actionsRow).toBeInTheDocument();
    // Utility row stays horizontal — the LANGUAGE/THEME/SHORTCUTS/SETTINGS
    // icons are still meant to sit next to each other.
    expect(actionsRow.className).toMatch(/\bflex\b/);
    expect(actionsRow.className).not.toMatch(/\bflex-col\b/);

    const signOut = screen.getByTestId("sidebar-sign-out");
    expect(signOut).toBeInTheDocument();
    // Sign Out is NOT a child of the utility row — it's a sibling of it
    // inside the column footer.
    expect(actionsRow.contains(signOut)).toBe(false);
    expect(footer.contains(signOut)).toBe(true);
    expect(signOut.parentElement).toBe(footer);
  });

  it("Sign Out label has whitespace-nowrap to guard against translation/zoom wrap", () => {
    render(
      <DashboardLayout>
        <div>child</div>
      </DashboardLayout>
    );

    const signOut = screen.getByTestId("sidebar-sign-out");
    // Either the button itself or a child <span> carrying the text must
    // declare whitespace-nowrap so "Sign Out" cannot break to a second line
    // even if a longer i18n string ever lands here.
    const buttonHasNowrap = /\bwhitespace-nowrap\b/.test(signOut.className);
    const labelHasNowrap = Array.from(signOut.querySelectorAll("span")).some(
      (s) => /\bwhitespace-nowrap\b/.test(s.className)
    );
    expect(buttonHasNowrap || labelHasNowrap).toBe(true);
  });

  it("Sign Out spans the full footer width so the label always fits on one line", () => {
    render(
      <DashboardLayout>
        <div>child</div>
      </DashboardLayout>
    );

    const signOut = screen.getByTestId("sidebar-sign-out");
    // Pre-fix the button had `ml-auto px-3 py-2` and was squeezed beside 4
    // other icon buttons in a 256px aside. Post-fix it's `w-full` on its
    // own row, which gives the label the entire footer width minus padding.
    expect(signOut.className).toMatch(/\bw-full\b/);
  });

  it("Sign Out remains a real <button type='button'> with the correct aria-label", () => {
    render(
      <DashboardLayout>
        <div>child</div>
      </DashboardLayout>
    );

    const signOut = screen.getByTestId("sidebar-sign-out");
    expect(signOut.tagName).toBe("BUTTON");
    expect(signOut.getAttribute("type")).toBe("button");
    // i18nMock returns the fallback string, so aria-label is "Sign Out".
    expect(signOut.getAttribute("aria-label")).toBe("Sign Out");
  });

  it("ADMIN sidebar (longest nav) renders Sign Out exactly once and accessibly", () => {
    render(
      <DashboardLayout>
        <div>child</div>
      </DashboardLayout>
    );

    // Exactly one accessible "Sign Out" control — no duplicate in the
    // mobile bottom nav, no leftover from a partial refactor.
    const buttons = screen.getAllByRole("button", { name: /sign out/i });
    expect(buttons).toHaveLength(1);
  });
});
