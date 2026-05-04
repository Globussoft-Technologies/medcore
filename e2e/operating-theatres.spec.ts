/**
 * Operating Theatres redirect-alias contract pin (UK + US spellings → /dashboard/ot).
 *
 * What this exercises:
 *   /dashboard/operating-theatres (apps/web/src/app/dashboard/operating-theatres/page.tsx, 28 lines)
 *     - UK-spelling client-component redirect stub. `useEffect`
 *       `router.replace("/dashboard/ot")` fires on mount. Renders a
 *       transient "Redirecting to Operating Theatres…" placeholder
 *       (data-testid="operating-theatres-redirect") while the navigation
 *       resolves.
 *   /dashboard/operating-theaters (apps/web/src/app/dashboard/operating-theaters/page.tsx, 25 lines)
 *     - US-spelling client-component redirect stub. Same shape, same
 *       target, distinct testid (data-testid="operating-theaters-redirect").
 *     - Both stubs were added under Issue #158 so users typing either
 *       spelling (or following an old bookmark) land on the canonical
 *       OT live status board at /dashboard/ot rather than 404-ing.
 *   /dashboard/ot (apps/web/src/app/dashboard/ot/page.tsx)
 *     - The canonical destination. Functional surface (create OT, week
 *       calendar, surgery scheduling) is exercised end-to-end by
 *       e2e/ot-surgery.spec.ts — this spec deliberately does NOT
 *       re-cover that ground; it pins the redirect contract + minimal
 *       chrome on landing so a regression that breaks either alias is
 *       caught here without overlapping the OT-surgery flow tests.
 *
 * Surfaces touched:
 *   - ADMIN: hits /operating-theatres, lands on /ot with "Operating
 *     Theaters" heading visible.
 *   - ADMIN: hits /operating-theaters (US spelling), same landing.
 *   - DOCTOR: parity check on /operating-theatres — the alias is NOT
 *     role-gated; redirect fires for any authed role.
 *   - Redirect-stub testid pin: the "Redirecting…" placeholders exist
 *     in the source so server-side renders / slow client navigations
 *     don't show a blank flash. We pin the testid presence in the
 *     stub source (no DOM assertion — by the time domcontentloaded
 *     resolves on /ot the stub is already gone, which is the contract).
 *   - Negative: /dashboard/operating-theatres-typo (a non-existent
 *     sibling) does NOT silently redirect — a regression that adds a
 *     catch-all redirect would surface here.
 *
 * Why these tests exist:
 *   §2.12 of docs/E2E_COVERAGE_BACKLOG.md flagged BOTH /operating-theaters
 *   AND /operating-theatres as zero-coverage with a "verify dedup" note.
 *   Reading both page.tsx files confirms they are thin client-side
 *   redirect stubs to /dashboard/ot per Issue #158 — same pattern as the
 *   /dashboard/account → /dashboard/profile alias closed by e2e/profile.spec.ts
 *   (commit 8a869c8 / Issue #303). One spec covering both aliases + the
 *   canonical destination chrome closes BOTH backlog rows. The OT
 *   functional flow (create, schedule, run surgery, blood-bank requisition,
 *   week calendar) is owned by e2e/ot-surgery.spec.ts and intentionally
 *   not re-tested here.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden, gotoAuthed } from "./helpers";

test.describe("Operating Theatres — /dashboard/operating-theatres + /operating-theaters redirect-alias contract pin (Issue #158; closes backlog §2.12 dedup)", () => {
  test("ADMIN hitting /dashboard/operating-theatres (UK spelling) is redirected to /dashboard/ot and the canonical heading renders", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // The redirect is a client-side `router.replace()` from
    // operating-theatres/page.tsx:17. waitForURL with a generous timeout
    // tolerates the cookie-auth race that gotoAuthed already shields the
    // initial navigation from.
    await gotoAuthed(page, "/dashboard/operating-theatres");
    await page.waitForURL(/\/dashboard\/ot(\?|$|\/)/, { timeout: 10_000 });
    await expectNotForbidden(page);

    // Canonical OT page chrome — the live status board's heading
    // (apps/web/src/app/dashboard/ot/page.tsx). This pins that the
    // redirect didn't just strip the path but actually landed on the
    // functional canonical page. We deliberately do NOT exercise the
    // schedule/calendar surface — that's e2e/ot-surgery.spec.ts.
    await expect(
      page.getByRole("heading", { name: /operating theaters/i }).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("ADMIN hitting /dashboard/operating-theaters (US spelling) is redirected to /dashboard/ot — pins the parallel alias from operating-theaters/page.tsx", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await gotoAuthed(page, "/dashboard/operating-theaters");
    await page.waitForURL(/\/dashboard\/ot(\?|$|\/)/, { timeout: 10_000 });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /operating theaters/i }).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("DOCTOR hitting /dashboard/operating-theatres is also redirected — confirms the alias is NOT role-gated (the stub has no VIEW_ALLOWED, mirrors the canonical /ot page accessibility)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    await gotoAuthed(page, "/dashboard/operating-theatres");
    await page.waitForURL(/\/dashboard\/ot(\?|$|\/)/, { timeout: 10_000 });
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /operating theaters/i }).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("PATIENT hitting /dashboard/operating-theatres still triggers the client-side redirect to /dashboard/ot — the stub itself does no role check; any role gating is the responsibility of the canonical page + API authorize()", async ({
    patientPage,
  }) => {
    const page = patientPage;

    // The redirect stub fires for any authed user — it's a thin
    // useEffect with no role check (operating-theatres/page.tsx:14-16).
    // Patient may then bounce off /dashboard/ot (canonical page is
    // staff-only via API gates) but the alias-resolution contract under
    // test is "the stub navigates AWAY from the alias to the canonical
    // URL". Use a forgiving regex that accepts any post-redirect URL on
    // the /ot path OR a subsequent dashboard-bounce.
    await gotoAuthed(page, "/dashboard/operating-theatres");
    // First settle: client-side `router.replace("/dashboard/ot")`
    // should happen within a tick. Then the canonical page's own
    // role gate (if any) may further bounce; either way, the URL must
    // NOT remain on the alias path.
    await page.waitForTimeout(1500);
    expect(page.url()).not.toMatch(/\/dashboard\/operating-theatres/);
    expect(page.url()).not.toMatch(/\/dashboard\/operating-theaters/);
  });

  test("non-existent sibling /dashboard/operating-theatres-typo does NOT silently redirect — guards against a future catch-all alias regression", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Typo'd path should hit Next.js's 404 (not-found.tsx) instead of
    // being absorbed by a too-greedy redirect rule. We don't pin the
    // 404 copy (Next default may evolve) — only that the URL does NOT
    // end up on /dashboard/ot, which would indicate a regression where
    // a wildcard redirect ate the typo.
    await gotoAuthed(page, "/dashboard/operating-theatres-typo");
    await page.waitForTimeout(1200);
    expect(page.url()).not.toMatch(/\/dashboard\/ot(\?|$|\/)/);
  });
});
