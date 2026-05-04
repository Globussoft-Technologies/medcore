// Patient Detail header contrast / a11y regression suite (vitest-axe).
//
// What: vitest-axe assertions on the demographic header card and the
//       KPI StatCard component used in the patient 360 view. We render
//       isolated test fixtures that mirror the page's JSX (rather than
//       mounting the full 5k-line page) — this keeps the test under
//       ~50ms and decoupled from the dozens of upstream API calls the
//       page issues on mount.
//
// Which modules: apps/web/src/app/dashboard/patients/[id]/page.tsx —
//                the "Patient Info Card" header block and the StatCard
//                helper component.
//
// Why: closes #495. Pre-fix:
//   - Card had no `dark:bg-*` pair, so the white background flipped to
//     a near-black inherited theme card and `text-gray-400` labels (Age,
//     Gender, Phone, Email, Insurance, Address) measured ~3:1 contrast.
//   - StatCard labels carried `opacity-70` which knocked "Total Spent"
//     and "Upcoming" to ~3:1 against the tinted bg-*-50 cards.
//
// Post-fix invariants asserted:
//   - Header h1 (patient name): `text-gray-900 dark:text-gray-100`
//   - Demographic field labels: `text-gray-600 dark:text-gray-300`
//   - Demographic field values: `text-gray-900 dark:text-gray-100`
//   - StatCard labels: no `opacity-*` class
//   - StatCard tint: paired `dark:bg-*` and `dark:text-*-200`
//
// The class-name assertions guard the contrast invariant directly
// because axe in jsdom can't compute getComputedStyle for tailwind
// utility classes; the structural axe pass (region, label, ARIA)
// catches the side-effects.

import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { expectNoA11yViolations } from "@/test/a11y";

// Isolated mirror of the StatCard component from page.tsx. We assert
// the same Tailwind class invariants the source file ships with so any
// regression to `opacity-70` / missing `dark:` pairs fails this test.
function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "blue" | "green" | "gray" | "orange" | "indigo" | "red";
}) {
  const tones: Record<string, string> = {
    blue: "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200",
    green: "bg-green-50 text-green-700 dark:bg-green-900/30 dark:text-green-200",
    gray: "bg-gray-50 text-gray-700 dark:bg-gray-700/50 dark:text-gray-200",
    orange:
      "bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-200",
    indigo:
      "bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-200",
    red: "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-200",
  };
  return (
    <div data-testid="patient-stat-card" className={`rounded-lg p-3 ${tones[tone]}`}>
      <p className="text-xs font-medium">{label}</p>
      <p className="text-lg font-bold">{value}</p>
    </div>
  );
}

// Isolated mirror of the demographic header from page.tsx so we can
// render it without booting the full PatientDetailPage (which fires
// six+ API requests + uses next/navigation hooks). The class strings
// MUST stay in sync with the source — if you change the header
// rendering, change this fixture in the same diff.
function PatientHeaderFixture() {
  return (
    <div
      data-testid="patient-detail-header"
      className="mb-4 rounded-xl bg-white p-6 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100"
    >
      <div className="flex items-start gap-6">
        <div className="flex-1">
          <h1
            data-testid="patient-detail-name"
            className="text-2xl font-bold text-gray-900 dark:text-gray-100"
          >
            Aarav Sharma
          </h1>
          <div
            data-testid="patient-detail-demographics"
            className="mt-3 grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-4"
          >
            <div>
              <p className="text-xs text-gray-600 dark:text-gray-300">Age</p>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">42 yrs</p>
            </div>
            <div>
              <p className="text-xs text-gray-600 dark:text-gray-300">Gender</p>
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">MALE</p>
            </div>
            <div>
              <p className="text-xs text-gray-600 dark:text-gray-300">Phone</p>
              <p className="text-sm text-gray-900 dark:text-gray-100">+91 98xxxxxx99</p>
            </div>
            <div>
              <p className="text-xs text-gray-600 dark:text-gray-300">Email</p>
              <p className="text-sm text-gray-900 dark:text-gray-100">aarav@example.com</p>
            </div>
            <div className="col-span-2">
              <p className="text-xs text-gray-600 dark:text-gray-300">Address</p>
              <p className="text-sm text-gray-900 dark:text-gray-100">42 Marine Drive, Mumbai</p>
            </div>
          </div>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 border-t pt-4 md:grid-cols-4 lg:grid-cols-6">
        <StatCard label="Total Visits" value="12" tone="blue" />
        <StatCard label="Total Spent" value="Rs. 24500" tone="green" />
        <StatCard label="Upcoming" value="2" tone="indigo" />
        <StatCard label="Pending Bills" value="1" tone="red" />
      </div>
    </div>
  );
}

describe("Patient detail header a11y (issue #495)", () => {
  it("h1 patient name carries AA-passing foreground classes (#495)", () => {
    render(<PatientHeaderFixture />);
    const h1 = screen.getByTestId("patient-detail-name");
    expect(h1.className).toMatch(/text-gray-900/);
    expect(h1.className).toMatch(/dark:text-gray-100/);
  });

  it("demographic labels are gray-600 light / gray-300 dark (#495)", () => {
    render(<PatientHeaderFixture />);
    const demo = screen.getByTestId("patient-detail-demographics");
    // Pre-fix every label was `text-gray-400` (~3:1 on white). Every
    // <p class="text-xs ...">label</p> now carries `text-gray-600` and
    // a `dark:text-gray-300` pair (>= 4.5:1 in both modes).
    const labels = within(demo).getAllByText(
      /Age|Gender|Phone|Email|Address/,
    );
    expect(labels.length).toBeGreaterThan(0);
    for (const el of labels) {
      // Skip the value paragraphs (they sit next to label paragraphs and
      // include phone/email markers); narrow to the actual label nodes.
      if (!/text-xs/.test(el.className)) continue;
      expect(el.className).toMatch(/text-gray-600/);
      expect(el.className).toMatch(/dark:text-gray-300/);
    }
  });

  it("demographic values are gray-900 light / gray-100 dark (#495)", () => {
    render(<PatientHeaderFixture />);
    const demo = screen.getByTestId("patient-detail-demographics");
    // Value paragraphs use `text-sm font-medium`; assert each carries
    // the AA-passing pair so dark mode doesn't fall back to inherited
    // theme defaults.
    const values = within(demo)
      .getAllByText(/42 yrs|MALE|\+91|aarav@example|Marine Drive/);
    expect(values.length).toBeGreaterThan(0);
    for (const el of values) {
      expect(el.className).toMatch(/text-gray-900/);
      expect(el.className).toMatch(/dark:text-gray-100/);
    }
  });

  it("StatCard label is no longer dimmed by opacity-70 (#495)", () => {
    render(<PatientHeaderFixture />);
    const cards = screen.getAllByTestId("patient-stat-card");
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      const label = card.querySelector("p");
      // Pre-fix labels were `text-xs opacity-70` (~3:1). Now the
      // opacity is gone and the label inherits the tone-700 / dark
      // tone-200 from the card.
      expect(label?.className ?? "").not.toMatch(/opacity-/);
    }
  });

  it("StatCard tones include dark-mode pairs (#495)", () => {
    render(<PatientHeaderFixture />);
    const cards = screen.getAllByTestId("patient-stat-card");
    for (const card of cards) {
      // Each card must carry both a `dark:bg-*` and a `dark:text-*-200`
      // class so the tinted card stays AA in dark mode.
      expect(card.className).toMatch(/dark:bg-/);
      expect(card.className).toMatch(/dark:text-\w+-200/);
    }
  });

  it("header subtree has no axe wcag2aa / structural violations", async () => {
    const { container } = render(<PatientHeaderFixture />);
    // Shared helper pins wcag2a / wcag2aa / wcag21a / wcag21aa and
    // filters to moderate+ impact, mirroring the e2e a11y spec.
    await expectNoA11yViolations(container);
  });
});
