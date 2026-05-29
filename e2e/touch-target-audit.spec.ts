/**
 * 44px touch-target audit for the Pearl PWA patient route group.
 *
 * What this exercises:
 *   - apps/web/src/app/patient/layout.tsx — bare PWA chrome (Sign in CTA,
 *     Patient Portal brand link, Install-PWA button) at mobile viewport.
 *   - apps/web/src/app/patient/page.tsx — unauthed landing surface (the
 *     /auth/me probe at line 36-57 falls through to `unauthed` for an
 *     anonymous browser context, exposing the Sign-in + Book CTAs).
 *   - apps/web/src/app/patient/login/page.tsx — phone-OTP step 1 (phone
 *     input + Send code button + brand/Install/Sign-in chrome).
 *
 * Surfaces touched:
 *   - Every visible interactive element (button:not([disabled]), a[href],
 *     input:not([type="hidden"]), select, [role="button"]) on each route is
 *     evaluated for getBoundingClientRect() width AND height >= 44 at the
 *     Pearl §6.2 mobile viewport (390×844 — iPhone 13/14/15, matching
 *     mobile-responsive.spec.ts:40). Elements with aria-hidden="true",
 *     computed display:none, or a 0×0 box are skipped (offscreen / not
 *     laid out / decorative).
 *   - Per CLAUDE.md gotcha 10, the global #__next-route-announcer__ live
 *     region is excluded; per gotcha 9, no `.first()` selector hops are
 *     used — every match is collected explicitly.
 *
 * Why these tests exist:
 *   Closes Pearl gap-doc §7 row 368 ("Touch-friendly 44px minimum targets
 *   — Convention-only"). Previously the 44px rule was enforced only via
 *   per-component Tailwind classes (h-11 min-w-[44px]) on the login + a
 *   handful of patient pieces, with no runtime gate. This spec walks every
 *   patient PWA route reachable without authenticated state and asserts
 *   getBoundingClientRect() ≥ 44×44 on every interactive element. Failures
 *   name the offending selector + computed dimensions so the fix is
 *   one-grep away.
 *
 * Scope-cut: the authed patient surfaces (/patient/dashboard,
 * /patient/appointments, /patient/bills, /patient/prescriptions,
 * /patient/profile, /patient/records) require a valid patient JWT cookie
 * set by POST /api/v1/patient-auth/otp-verify — the existing test fixtures
 * authenticate via /auth/login (staff bearer-token flow), which does NOT
 * mint the patient-auth cookies these pages probe. Adding those routes
 * needs a patient-OTP fixture (TODO when piece 3j+ ships an e2e patient
 * login helper). All currently shipped patient-PWA routes that render
 * without that fixture are covered here.
 */
import { test, expect, type Page } from "@playwright/test";

const MOBILE_VIEWPORT = { width: 390, height: 844 } as const; // iPhone 13/14/15

/**
 * Routes that render without patient-OTP cookies. Anything in /patient/*
 * gated by patient JWT cookies (dashboard, appointments, bills, etc.) is
 * deferred to a follow-up tick that ships an OTP-fixture helper — see the
 * header scope-cut.
 */
const UNAUTHED_PATIENT_ROUTES = ["/patient", "/patient/login"] as const;

interface InteractiveViolation {
  selector: string;
  tag: string;
  width: number;
  height: number;
  text: string;
}

interface AuditResult {
  scanned: number;
  violations: InteractiveViolation[];
}

/**
 * Evaluate every visible interactive element on the page against the 44×44
 * touch-target invariant. Returns scanned-count + list of violations so
 * the spec can surface a structured assertion failure.
 */
async function auditInteractiveTouchTargets(page: Page): Promise<AuditResult> {
  return page.evaluate(() => {
    // Build a deterministic CSS-path-ish selector for any element so the
    // failure message points the fix straight at the offending node.
    function describe(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const cls =
        el.classList.length > 0
          ? "." +
            Array.from(el.classList)
              .slice(0, 3)
              .join(".")
              .replace(/[^a-zA-Z0-9._-]/g, "_")
          : "";
      const testid = el.getAttribute("data-testid");
      const testidPart = testid ? `[data-testid="${testid}"]` : "";
      const role = el.getAttribute("role");
      const rolePart = role ? `[role="${role}"]` : "";
      const type = el.getAttribute("type");
      const typePart = type ? `[type="${type}"]` : "";
      return `${tag}${id}${testidPart}${rolePart}${typePart}${cls}`;
    }

    const SELECTORS = [
      'button:not([disabled])',
      'a[href]',
      'input:not([type="hidden"])',
      "select",
      '[role="button"]',
    ];

    // Exclude the Next.js global route-announcer live region (CLAUDE.md
    // gotcha 10) — it is `role="alert"` not interactive, but a future
    // selector expansion shouldn't pick it up either.
    const EXCLUDE_IDS = new Set(["__next-route-announcer__"]);

    const seen = new Set<Element>();
    const nodes: Element[] = [];
    for (const sel of SELECTORS) {
      const matches = Array.from(document.querySelectorAll(sel));
      for (const el of matches) {
        if (seen.has(el)) continue;
        if (EXCLUDE_IDS.has(el.id)) continue;
        seen.add(el);
        nodes.push(el);
      }
    }

    /**
     * Carve-outs from the 44×44 rule that follow recognised a11y/UX patterns:
     *
     *  1. `.skip-link` — standard "Skip to main content" anchor. Hidden
     *     offscreen until keyboard focus per WAI-ARIA Skip Navigation
     *     pattern. Mouse/touch users never see it; keyboard users have
     *     focus indicators, not finger targets. Conventionally below 44px
     *     and excluded from touch-target audits everywhere it appears.
     *
     *  2. Inline anchors in body prose (e.g. "Don't have an account?
     *     Create an account.") — WCAG 2.2 SC 2.5.8 explicitly carves out
     *     "in-line links in prose" because forcing them to 44px would
     *     distort line-height and break reading flow. Detection heuristic:
     *     the anchor's direct parent is a `<p>` or `<span>` AND the anchor
     *     has neither `inline-flex`/`flex` nor any explicit height class
     *     — i.e. it inherits the surrounding line-height.
     */
    function isExemptInlineProseAnchor(el: Element): boolean {
      if (el.tagName.toLowerCase() !== "a") return false;
      const parent = el.parentElement;
      if (!parent) return false;
      const parentTag = parent.tagName.toLowerCase();
      if (parentTag !== "p" && parentTag !== "span") return false;
      // An anchor that's wrapped in a flex/grid container OR that has its
      // own `inline-flex` / `flex` class is a styled CTA, not inline prose.
      const cls = el.className.toString();
      if (/\b(inline-flex|flex|grid|inline-grid)\b/.test(cls)) return false;
      if (/\bh-\d/.test(cls) || /\bmin-h-/.test(cls)) return false;
      return true;
    }

    const violations: InteractiveViolation[] = [];
    let scanned = 0;

    for (const el of nodes) {
      // Skip aria-hidden — element is intentionally invisible to AT/touch.
      if (el.getAttribute("aria-hidden") === "true") continue;

      // a11y skip-link carve-out (see comment block above).
      if (el.classList.contains("skip-link")) continue;
      // Inline-anchor-in-prose carve-out per WCAG 2.2 SC 2.5.8.
      if (isExemptInlineProseAnchor(el)) continue;

      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;

      const rect = el.getBoundingClientRect();
      // 0×0 box = element exists in DOM but is not laid out (e.g. detached
      // portal, off-screen tab content). Skipping is the convention used
      // by axe-core for the same reason.
      if (rect.width === 0 && rect.height === 0) continue;

      scanned += 1;

      if (rect.width < 44 || rect.height < 44) {
        violations.push({
          selector: describe(el),
          tag: el.tagName.toLowerCase(),
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
          text: (el.textContent || "").trim().slice(0, 60),
        });
      }
    }

    return { scanned, violations };
  });
}

test.describe("Patient PWA 44px touch-target audit (Pearl §7 row 368 closure: every interactive element on patient routes meets getBoundingClientRect() >= 44x44 at the iPhone 390x844 viewport)", () => {
  for (const route of UNAUTHED_PATIENT_ROUTES) {
    test(`route ${route} — every visible interactive element (button / link / input / select / role=button) has bounding rect width AND height >= 44 px at the mobile viewport, with offscreen + aria-hidden + 0x0 + display:none nodes skipped`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        viewport: { ...MOBILE_VIEWPORT },
        hasTouch: true,
      });
      const page = await ctx.newPage();
      try {
        await page.goto(route, { waitUntil: "domcontentloaded" });

        // Both routes do a small client-side probe before settling:
        //   /patient runs a /auth/me fetch then either redirects to
        //     /patient/dashboard OR sets phase=unauthed and renders.
        //   /patient/login renders synchronously but the InstallPWAButton
        //     in the layout hydrates on the next tick.
        // Wait for either the landing's unauthed-state CTA OR the login
        // form input — whichever the URL implies — before auditing so we
        // don't measure a layout that's still hydrating.
        if (route === "/patient/login") {
          await page
            .getByTestId("patient-login-phone-input")
            .waitFor({ state: "visible", timeout: 10_000 });
        } else {
          // /patient may bounce to /patient/dashboard for an authed PATIENT.
          // In an anonymous browser context the /auth/me probe returns 401
          // and phase flips to "unauthed", exposing patient-landing-signin.
          await page
            .getByTestId("patient-landing-signin")
            .waitFor({ state: "visible", timeout: 10_000 });
        }

        const result = await auditInteractiveTouchTargets(page);

        // We need SOME interactive surface on every route or the audit is
        // a no-op (would mask a future regression where the page renders
        // empty). Both audited routes today have a brand link + at least
        // one CTA, so scanned should be >= 2.
        expect(
          result.scanned,
          `route ${route} should have at least one auditable interactive element (got ${result.scanned}); a 0-count probably means the page failed to hydrate, not that the design has zero CTAs`,
        ).toBeGreaterThanOrEqual(2);

        const formatted = result.violations
          .map(
            (v) =>
              `  - ${v.selector} (${v.tag}, ${v.width}x${v.height}px${
                v.text ? `, text="${v.text}"` : ""
              })`,
          )
          .join("\n");

        expect(
          result.violations,
          `route ${route} — Pearl §6.2 requires every interactive element to be at least 44x44 px (h-11 min-w-[44px] convention). ${result.violations.length} of ${result.scanned} elements failed the audit at viewport ${MOBILE_VIEWPORT.width}x${MOBILE_VIEWPORT.height}:\n${formatted}`,
        ).toEqual([]);
      } finally {
        await ctx.close();
      }
    });
  }
});
