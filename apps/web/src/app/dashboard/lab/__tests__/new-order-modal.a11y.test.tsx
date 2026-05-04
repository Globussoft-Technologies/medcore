// Lab Order modal contrast / a11y regression suite (vitest-axe).
//
// What: vitest-axe assertions on the New Lab Order modal triggered from
//       /dashboard/lab. Renders the full LabPage as a DOCTOR, opens the
//       modal, and runs the WCAG 2.1 AA rule set (wcag2a / wcag2aa /
//       wcag21a / wcag21aa) through the shared `expectNoA11yViolations`
//       helper. Also asserts the specific text classes the bug report
//       called out (test labels + Cancel button) so a future regression
//       on either fails this test instead of the e2e tier.
//
// Which modules: apps/web/src/app/dashboard/lab/page.tsx — the
//                NewOrderModal subcomponent.
//
// Why: closes #492. Pre-fix, every test checkbox label and the Cancel
//      button rendered without an explicit foreground color, so the
//      browser's default ButtonText cascade landed at ~3:1 against the
//      white modal surface and ~2:1 in dark mode. Bumping every label
//      to `text-gray-900 dark:text-gray-100` and pinning Cancel to
//      `text-gray-900 dark:text-gray-100` clears WCAG 2.1 AA in both
//      modes (~16:1 / ~14:1 contrast).

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  within,
} from "@testing-library/react";
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

vi.mock("@/lib/api", () => ({ api: apiMock, openPrintEndpoint: vi.fn() }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));
vi.mock("@/lib/i18n", () => ({
  useTranslation: () => ({
    t: (k: string) => k,
  }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/lab",
}));

import LabPage from "../page";

const SAMPLE_TESTS = [
  { id: "t1", name: "2D Echocardiogram", category: "CARDIOLOGY" },
  { id: "t2", name: "Electrocardiogram", category: "CARDIOLOGY" },
  { id: "t3", name: "ANA (Anti-Nuclear Antibody)", category: "IMMUNOLOGY" },
  { id: "t4", name: "Procalcitonin", category: "IMMUNOLOGY" },
  { id: "t5", name: "Thyroid Stimulating Hormone", category: "ENDOCRINOLOGY" },
  { id: "t6", name: "Blood Culture", category: "MICROBIOLOGY" },
];

function mockApi() {
  apiMock.get.mockImplementation((url: string) => {
    if (url.startsWith("/lab/orders")) return Promise.resolve({ data: [] });
    if (url.startsWith("/lab/tests"))
      return Promise.resolve({ data: SAMPLE_TESTS });
    return Promise.resolve({ data: [] });
  });
}

describe("Lab New Order modal a11y (issue #492)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    mockApi();
    authMock.mockReturnValue({
      user: { id: "u1", name: "Dr Mehta", email: "m@x.com", role: "DOCTOR" },
      isLoading: false,
    });
    document.documentElement.classList.remove("dark");
  });

  async function openModal() {
    render(<LabPage />);
    // Trigger CTA — "+ New Order" button uses the i18n key
    // `dashboard.lab.newOrder` which the mock returns verbatim.
    const trigger = await screen.findByRole("button", {
      name: /dashboard\.lab\.newOrder/i,
    });
    fireEvent.click(trigger);
    return await screen.findByTestId("lab-new-order-modal");
  }

  it("test labels carry AA-passing foreground classes (#492)", async () => {
    const modal = await openModal();
    const labels = within(modal).getAllByTestId("lab-order-test-label");
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      // Pre-fix labels had NO explicit color class — they inherited the
      // browser default and rendered ~3:1 on white. Post-fix every label
      // must carry `text-gray-900` (and a `dark:text-gray-100` pair).
      expect(label.className).toMatch(/text-gray-900/);
      expect(label.className).toMatch(/dark:text-gray-100/);
    }
  });

  it("category headers carry AA-passing foreground classes (#492)", async () => {
    const modal = await openModal();
    const headers = within(modal).getAllByTestId("lab-order-category-header");
    expect(headers.length).toBeGreaterThan(0);
    for (const h of headers) {
      // Headers were `text-gray-500` (~4.6:1 light, ~3:1 dark). Post-fix
      // they're `text-gray-700 dark:text-gray-200` for AA in both modes.
      expect(h.className).toMatch(/text-gray-700/);
      expect(h.className).toMatch(/dark:text-gray-200/);
    }
  });

  it("Cancel button has explicit AA-passing text color (#492)", async () => {
    const modal = await openModal();
    const cancel = within(modal).getByTestId("lab-order-cancel-btn");
    // Pre-fix Cancel had `border` only — text inherited browser default
    // ButtonText (~9:1 in some themes, ~2.5:1 in others — unreliable).
    // Post-fix it pins `text-gray-900 dark:text-gray-100`.
    expect(cancel.className).toMatch(/text-gray-900/);
    expect(cancel.className).toMatch(/dark:text-gray-100/);
  });

  it("modal subtree has no axe wcag2aa / color-contrast violations", async () => {
    await openModal();
    // Run axe over document.body so any portal / fixed-position content
    // is covered. The shared helper pins the wcag2a / wcag2aa / wcag21a
    // / wcag21aa rule tags (matches Playwright a11y spec) and filters to
    // moderate+ impact. axe in jsdom can't compute every contrast ratio
    // (jsdom under-implements getComputedStyle for tailwind utilities),
    // so this guards the structural rules — region, label, ARIA, link-
    // name, document-title — that fall out of contrast bugs. The class-
    // assertion tests above cover the contrast invariant directly.
    await expectNoA11yViolations(document);
  });
});
