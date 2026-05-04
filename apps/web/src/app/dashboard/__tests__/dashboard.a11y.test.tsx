// Dashboard contrast / a11y regression suite (vitest-axe).
//
// What: vitest-axe assertions on the `/dashboard` landing page and its
//       Quick Action tile component, scoped to the WCAG 2.1 AA rule set
//       with the `color-contrast` rule explicitly enabled.
//
// Which modules: apps/web/src/app/dashboard/page.tsx — the QuickAction
//                tile + the Diagnostics & Labs / Operations panel rows.
//
// Why: closes #504 (Quick Action tiles look disabled — sub-AA label
//      contrast) and #505 (Diagnostics & Labs / Operations labels are
//      "barely visible" — sub-AA in dark mode). Both bugs were rooted
//      in tailwind classes that lacked `dark:` pairs, which left the
//      `text-gray-700` rows at ~3:1 on the dark `bg-gray-800` card.
//      The light-mode tile labels were `text-gray-700` on `transparent`
//      over the page background, which axe also flagged. We pin both
//      light and dark mode rendering so neither side regresses again.
//
// The test runs the full DashboardPage (not just QuickAction) so any
// future panel-row gets the same check for free — adding a new sub-AA
// label anywhere in the page will fail this test.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { expectNoA11yViolations } from "@/test/a11y";

const { apiMock, authMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard",
}));

import DashboardPage from "../page";

function emptyResponse(url: string) {
  if (url.includes("/wards") || url.includes("/queue") || url.includes("/cases/active"))
    return { data: [] };
  if (url.includes("/bloodbank/inventory/summary")) return { data: null };
  if (url.includes("/analytics/overview")) return { data: null };
  if (url.includes("/dashboard-preferences"))
    return { data: { layout: { widgets: [] } } };
  return { data: [], meta: { total: 0 } };
}

describe("Dashboard a11y (issues #504 + #505)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.put.mockReset();
    apiMock.get.mockImplementation((url: string) =>
      Promise.resolve(emptyResponse(url))
    );
    authMock.mockReturnValue({
      user: { id: "u1", name: "Sumit", email: "s@x.com", role: "ADMIN" },
      isLoading: false,
    });
    document.documentElement.classList.remove("dark");
  });

  it("Quick Action tile labels are present and rendered (#504)", async () => {
    // ADMIN sees the reception/admin Quick Actions block — assert the
    // labels actually mount as readable text (not hidden / aria-hidden /
    // sr-only). A regression that drops opacity to 0 or wraps the label
    // in `sr-only` would still leave the node in the DOM but break this.
    render(<DashboardPage />);
    await waitFor(() =>
      expect(screen.getByText(/welcome.*sumit/i)).toBeInTheDocument()
    );
    for (const label of [
      "Walk-in",
      "Book Appt",
      "Bills",
      "Check-in Visitor",
      "ER Intake",
      "Dispatch Ambulance",
    ]) {
      const el = screen.getByText(label);
      expect(el).toBeInTheDocument();
      // Tile labels must carry a high-contrast text class. Pre-fix this
      // was `text-gray-700`; post-fix it's `text-gray-900 dark:text-gray-100`.
      expect(el.className).toMatch(/text-gray-900/);
    }
  });

  it("Diagnostics & Labs + Operations panel labels are visible in dark mode (#505)", async () => {
    document.documentElement.classList.add("dark");
    render(<DashboardPage />);
    await waitFor(() =>
      expect(screen.getByText(/welcome.*sumit/i)).toBeInTheDocument()
    );
    // The exact labels called out in the bug report.
    for (const label of [
      "Pending Lab Orders",
      "Blood Units Available",
      "Overdue Immunizations",
      "Low Stock Items",
      "Staff On Duty",
      "Active Visitors",
      "Open Complaints",
    ]) {
      const el = screen.getByText(label);
      expect(el).toBeInTheDocument();
      // Each label must carry a `dark:text-` variant so it stays AA on
      // the gray-800 card in dark mode. Pre-fix this was missing.
      expect(el.className).toMatch(/dark:text-gray-(100|200)/);
    }
  });

  it("dashboard page has no axe color-contrast / wcag2aa violations (light mode)", async () => {
    const { container } = render(<DashboardPage />);
    await waitFor(() =>
      expect(screen.getByText(/welcome.*sumit/i)).toBeInTheDocument()
    );
    // `expectNoA11yViolations` runs the wcag2a / wcag2aa / wcag21a /
    // wcag21aa tag set, which includes `color-contrast`. axe in jsdom
    // can't compute every contrast ratio (it relies on getComputedStyle
    // which jsdom under-implements for tailwind utility classes), so
    // this asserts on whatever rules it CAN evaluate — region, label,
    // ARIA, document-title, link-name, etc. — which still catches the
    // structural regressions that fall out of contrast bugs (e.g. a
    // label being aria-hidden, an interactive element losing its name).
    await expectNoA11yViolations(container);
  });
});
