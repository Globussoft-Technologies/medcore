// Test-only axe helper — vitest-axe wrapper that returns a structured
// assertion target.
//
// Why: Playwright's @axe-core/playwright covers full pages at the e2e tier,
// but unit-level a11y for individual components (DataTable, modals, forms)
// runs much faster and catches regressions BEFORE the e2e suite does. This
// closes P3 from `docs/TEST_COVERAGE_AUDIT.md` (jest-axe / vitest-axe in
// the unit suite).
//
// Usage:
//   import { expectNoA11yViolations } from "@/test/a11y";
//   it("DataTable has no a11y violations", async () => {
//     const { container } = render(<DataTable .../>);
//     await expectNoA11yViolations(container);
//   });
//
// Pinned ruleset: `wcag2a` + `wcag2aa` + `wcag21a` + `wcag21aa` mirrors the
// Playwright a11y spec at e2e/a11y.spec.ts so violations surface
// consistently across tiers. `best-practice` is intentionally OFF at the
// unit tier — it's noisier and the e2e suite is the right level for those
// surface-area checks.

import { axe } from "vitest-axe";
import type { AxeResults } from "axe-core";

export const A11Y_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
] as const;

export interface A11yOptions {
  /**
   * Override the default axe ruleset. Most callers should leave this alone;
   * use the dedicated parameter to skip a single rule that is genuinely
   * irrelevant for the component under test (e.g. `region` doesn't apply to
   * a sub-tree rendered without a landmark).
   */
  rules?: Record<string, { enabled: boolean }>;
  /**
   * Filter out specific impact levels — by default everything `serious` or
   * `critical` is asserted on. Drop to `["critical"]` to triage incrementally.
   */
  failOnImpact?: Array<"minor" | "moderate" | "serious" | "critical">;
}

const DEFAULT_FAIL_ON_IMPACT: A11yOptions["failOnImpact"] = [
  "moderate",
  "serious",
  "critical",
];

function formatViolations(results: AxeResults): string {
  return results.violations
    .map((v) => {
      const nodes = v.nodes
        .slice(0, 3)
        .map((n) => `    - ${n.html.slice(0, 120)}\n      ${n.failureSummary?.replace(/\n/g, "\n      ")}`)
        .join("\n");
      return `[${v.impact ?? "n/a"}] ${v.id} (${v.help})\n${nodes}\n  More: ${v.helpUrl}`;
    })
    .join("\n\n");
}

/**
 * Asserts the given DOM node has zero axe violations at the configured
 * impact levels. Throws a structured error listing every violation when
 * any are found. Pass `Document` to test portal-rendered content (modals,
 * tooltips) — we forward `document.body` to axe, since the underlying
 * `vitest-axe` runner only accepts `Element | string`.
 */
export async function expectNoA11yViolations(
  node: Element | Document,
  opts: A11yOptions = {},
): Promise<void> {
  const target: Element =
    node instanceof Document ? node.body : node;
  const results = (await axe(target, {
    runOnly: { type: "tag", values: [...A11Y_TAGS] },
    rules: opts.rules,
  })) as unknown as AxeResults;

  const failOnImpact: Array<"minor" | "moderate" | "serious" | "critical"> =
    opts.failOnImpact ?? DEFAULT_FAIL_ON_IMPACT ?? [
      "moderate",
      "serious",
      "critical",
    ];
  const blocking = results.violations.filter((v) =>
    failOnImpact.includes((v.impact as never) ?? "moderate"),
  );

  if (blocking.length > 0) {
    throw new Error(
      `Expected no a11y violations at impact levels [${failOnImpact.join(
        ", ",
      )}], found ${blocking.length}:\n\n${formatViolations({
        ...results,
        violations: blocking,
      } as AxeResults)}`,
    );
  }
}
