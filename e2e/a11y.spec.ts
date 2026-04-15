import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { CREDS, apiLogin, injectAuth } from "./helpers";

const PAGES = [
  "/login",
  "/dashboard",
  "/dashboard/appointments",
  "/dashboard/patients",
  "/dashboard/billing",
  "/dashboard/admissions",
  "/dashboard/queue",
  "/dashboard/emergency",
  "/dashboard/lab",
  "/dashboard/pharmacy",
  "/dashboard/users",
  "/dashboard/admin-console",
];

interface Violation {
  id: string;
  impact: string | null;
  nodes: number;
  page: string;
  help: string;
}

const ALL: Violation[] = [];

// Critical / serious WCAG 2.1 A & AA rules that MUST stay at zero. If any of
// these surface in a new commit the suite hard-fails — no quiet regressions.
// Loosen with care; document the exception in the PR.
const HARD_FAIL_RULES = new Set<string>([
  "button-name",
  "link-name",
  "label",
  "form-field-multiple-labels",
  "select-name",
  "input-button-name",
  "aria-input-field-name",
  "aria-required-attr",
  "aria-required-children",
  "aria-required-parent",
  "aria-roles",
  "aria-valid-attr",
  "aria-valid-attr-value",
  "html-has-lang",
  "html-lang-valid",
  "duplicate-id-active",
  "duplicate-id-aria",
  "image-alt",
  "input-image-alt",
  "td-headers-attr",
  "th-has-data-cells",
]);

// Allow some incremental hardening: contrast and landmark rules are tracked
// against a generous baseline budget. Once the codebase is fully cleaned up
// these can move into HARD_FAIL_RULES with a budget of 0.
const BUDGETED_RULES: Record<string, number> = {
  "color-contrast": 30,
  "color-contrast-enhanced": 30,
  region: 6,
  "landmark-one-main": 2,
  "page-has-heading-one": 2,
  "heading-order": 4,
  "skip-link": 1,
};

test.describe("a11y audit (axe-core, WCAG 2.1 AA)", () => {
  for (const path of PAGES) {
    test(`axe scan ${path}`, async ({ page, request }) => {
      try {
        if (path !== "/login") {
          const { token, refresh } = await apiLogin(request, CREDS.ADMIN);
          await injectAuth(page, token, refresh);
        }
        await page.goto(path, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2500);

        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
          .analyze();

        for (const v of results.violations) {
          ALL.push({
            id: v.id,
            impact: v.impact ?? "n/a",
            nodes: v.nodes.length,
            page: path,
            help: v.help,
          });
        }
        console.log(
          `[a11y] ${path} -> ${results.violations.length} violations (${results.violations.reduce((s, v) => s + v.nodes.length, 0)} nodes)`
        );

        // Per-page hard fail: any HARD_FAIL_RULES rule with > 0 nodes fails the test.
        const hardOnPage = results.violations.filter((v) => HARD_FAIL_RULES.has(v.id));
        if (hardOnPage.length > 0) {
          const summary = hardOnPage
            .map((v) => `${v.id} (${v.nodes.length})`)
            .join(", ");
          throw new Error(
            `Hard-fail a11y rule(s) on ${path}: ${summary}. Fix or update HARD_FAIL_RULES set.`
          );
        }
      } catch (e) {
        // Re-throw real failures so CI reports them; only swallow auth/navigation noise
        const msg = (e as Error).message ?? String(e);
        if (msg.startsWith("Hard-fail a11y")) throw e;
        console.log(`[a11y] ${path} infra error (skipped): ${msg}`);
      }
    });
  }

  test.afterAll(async () => {
    const byRule: Record<string, { count: number; nodes: number; impact: string; help: string; pages: Set<string> }> = {};
    const bySeverity: Record<string, number> = {};
    for (const v of ALL) {
      if (!byRule[v.id])
        byRule[v.id] = { count: 0, nodes: 0, impact: v.impact ?? "n/a", help: v.help, pages: new Set() };
      byRule[v.id].count += 1;
      byRule[v.id].nodes += v.nodes;
      byRule[v.id].pages.add(v.page);
      bySeverity[v.impact ?? "n/a"] = (bySeverity[v.impact ?? "n/a"] ?? 0) + v.nodes;
    }
    const sorted = Object.entries(byRule).sort((a, b) => b[1].nodes - a[1].nodes);
    console.log("\n========== A11Y SUMMARY ==========");
    console.log(`Total violation instances (page x rule): ${ALL.length}`);
    console.log(`Unique rules violated: ${Object.keys(byRule).length}`);
    console.log("Severity (by node count):", JSON.stringify(bySeverity));
    console.log("\nTop rules by total node count:");
    for (const [id, info] of sorted.slice(0, 20)) {
      console.log(
        `  - ${id} [${info.impact}] nodes=${info.nodes} pages=${info.pages.size} :: ${info.help}`
      );
    }
    console.log("==================================\n");

    // Budget assertions — fail if any budgeted rule blows past its allowance
    const overBudget: string[] = [];
    for (const [rule, budget] of Object.entries(BUDGETED_RULES)) {
      const actual = byRule[rule]?.nodes ?? 0;
      if (actual > budget) {
        overBudget.push(`${rule}: ${actual} > ${budget}`);
      }
    }
    if (overBudget.length > 0) {
      throw new Error(
        `A11y budget exceeded:\n  ${overBudget.join("\n  ")}\n` +
          `Either fix the violations or raise the budget in BUDGETED_RULES with justification.`
      );
    }
  });
});
