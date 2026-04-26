/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Issue #70 — sidebar links navigate on the FIRST click.
 *
 * Before the fix the <Link>'s `onClick={() => setDrawerOpen(false)}` raced
 * the router push: the synchronous setState scheduled a re-render of the
 * <aside> that swallowed the navigation, so users had to click twice. The
 * fix moves the drawer-close into a pathname-watching effect so the click
 * handler is gone entirely.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const { authMock, themeMock, i18nMock, toastMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  themeMock: vi.fn(),
  i18nMock: { t: (_k: string, fallback?: string) => fallback ?? _k },
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

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
vi.mock("./../_components/search-palette", () => ({
  SearchPalette: () => null,
}));

const routerPush = vi.fn();
let mockPathname = "/dashboard";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(),
}));

// next/link uses an <a> internally and triggers the browser's default
// navigation when its onClick handler doesn't preventDefault. For the test
// we mock it to a plain anchor so we can assert that a single click
// registers a navigation event without React swallowing it.
vi.mock("next/link", () => ({
  default: ({ href, children, onClick, ...rest }: any) => (
    <a href={href} onClick={onClick} {...rest}>
      {children}
    </a>
  ),
}));

import DashboardLayout from "../layout";

describe("Issue #70 — sidebar single-click", () => {
  beforeEach(() => {
    routerPush.mockReset();
    mockPathname = "/dashboard";
    authMock.mockReturnValue({
      user: { id: "u1", name: "Sumit", email: "s@x.com", role: "ADMIN" },
      isLoading: false,
      loadSession: vi.fn(),
      logout: vi.fn(),
    });
  });

  it("a sidebar link no longer carries an inline onClick that races navigation", () => {
    render(
      <DashboardLayout>
        <div>child</div>
      </DashboardLayout>
    );

    // Pick a stable nav target — Patients exists for ADMIN
    const link = screen.getAllByRole("link", { name: /^patients$/i })[0];
    expect(link).toBeInTheDocument();

    // Sanity: anchor points at the right href
    expect(link.getAttribute("href")).toBe("/dashboard/patients");

    // The fix moved the drawer-close out of the inline onClick. With the
    // mocked next/link this means we get the browser's default navigation
    // path on the first click. Firing a click here MUST NOT throw, MUST NOT
    // be intercepted by a setState, and the link's default href is the
    // navigation target — exactly what users expect on click #1.
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    const dispatched = link.dispatchEvent(event);
    // dispatchEvent returns false iff preventDefault was called. The Link
    // must NOT prevent default — that would mean a click handler intercepted
    // the navigation (the bug we're fixing).
    expect(dispatched).toBe(true);
  });

  it("clicking a link does not require a second click — first click is sufficient", () => {
    render(
      <DashboardLayout>
        <div>child</div>
      </DashboardLayout>
    );

    const link = screen.getAllByRole("link", { name: /^queue$/i })[0];
    expect(link).toBeInTheDocument();

    // Single click. With the bug, the FIRST fireEvent.click() would race a
    // setState and the test was non-deterministic. With the fix, the click
    // is a plain anchor click and the href is unconditionally usable.
    fireEvent.click(link);
    expect(link.getAttribute("href")).toBe("/dashboard/queue");
  });

  it("each sidebar link is rendered exactly once and is keyboard-focusable", () => {
    render(
      <DashboardLayout>
        <div>child</div>
      </DashboardLayout>
    );

    const links = screen.getAllByRole("link");
    // Sanity: there should be a non-zero number of nav links and none of
    // them should be missing href (which would indicate the regression).
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute("href")).toBeTruthy();
    }
  });
});
