/**
 * Doctor Workspace dashboard e2e coverage.
 *
 * What this exercises:
 *   /dashboard/workspace (apps/web/src/app/dashboard/workspace/page.tsx)
 *   GET /api/v1/queue/me, /appointments?mine=true, /admissions?mine=true,
 *       /prescriptions?mine=true, /lab/orders?mine=true&unreviewed=true,
 *       /referrals?direction=incoming, /admissions?status=DISCHARGE_PENDING
 *
 * Surfaces touched:
 *   - DOCTOR happy path: lands on workspace, sees the 4 shortcut CTAs
 *     (Start Consultation / Write Rx / Order Labs / Add Note), the
 *     three-column "My Queue / Pending Tasks / Today's Appointments"
 *     grid, and the lower "Admitted Patients / Recent Prescriptions"
 *     panel — locks the page-chrome contract used by the
 *     doctor-personal-cockpit landing experience.
 *   - DOCTOR shortcut wiring: each shortcut href routes the doctor to
 *     the right tool — pinning at least one (Write Rx → /prescriptions
 *     with `?new=1`) so a regression in the shortcut-link contract
 *     surfaces here, not just in the downstream feature spec.
 *   - Pending-tasks card structural pin: 4 task rows (Prescriptions to
 *     write / Lab results to review / Discharge summaries pending /
 *     Referrals awaiting response) render labels and counts irrespective
 *     of seed fill, anchoring page.tsx:204-228.
 *   - Non-DOCTOR REDIRECT-BOUNCE archetype: ADMIN, NURSE, PATIENT all
 *     hit page.tsx:43-46 useEffect → router.replace("/dashboard"). This
 *     is the dominant 6:1 redirect-target shape (CLAUDE.md cron-learning
 *     bullet 6: redirect-bounce target is `/dashboard`, NOT
 *     `/dashboard/not-authorized`). The inline "Workspace is for doctors
 *     only" placeholder at page.tsx:91-97 only renders for the brief
 *     window before the useEffect fires; we assert the post-redirect
 *     URL pattern instead.
 *
 * Why these tests exist:
 *   /dashboard/workspace was previously listed under §2.9 of
 *   docs/E2E_COVERAGE_BACKLOG.md as "workspace config (smoke-visited)".
 *   Backlog phrasing turns out to be aspirational — the real surface is
 *   a DOCTOR-only personal cockpit (queue + tasks + appointments + recent
 *   prescriptions aggregator), not a configuration screen. This file pins
 *   the page-chrome contract + the redirect-bounce archetype + the
 *   shortcut-href wiring so a regression in any of the 7 backing API
 *   reads or the role gate is caught before the per-resource specs blame
 *   themselves.
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, expectNotForbidden, gotoAuthed } from "./helpers";

const PAGE_TIMEOUT = 15_000;

test.describe("Doctor Workspace — /dashboard/workspace (DOCTOR-only personal cockpit + non-DOCTOR redirect-bounce)", () => {
  test("DOCTOR lands on /dashboard/workspace, page chrome renders the heading + DOCTOR badge + 4 shortcut CTAs", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/workspace");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /^workspace$/i }).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Subtitle "Everything you need for today, <doctor name>" anchors the
    // doctor-greeting branch (page.tsx:104-106). Substring match is robust
    // to formatDoctorName() output variation.
    await expect(
      page.getByText(/everything you need for today/i).first()
    ).toBeVisible();

    // The DOCTOR role badge in the header (page.tsx:108-110) is a chrome
    // contract — its absence would mean either the role gate fired and
    // we're on the placeholder, or the layout shifted.
    await expect(page.getByText(/^DOCTOR$/).first()).toBeVisible();

    // The 4 shortcut buttons (page.tsx:113-139). Each is a plain
    // <Link> → role=link with the literal label text.
    await expect(
      page.getByRole("link", { name: /start consultation/i })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /write rx/i })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /order labs/i })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /add note/i })
    ).toBeVisible();
  });

  test("DOCTOR sees the three-column dashboard: My Queue / Pending Tasks / Today's Appointments", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/workspace");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    // Three column headings (page.tsx:145, 201, 235). Heading-by-text
    // pin is the cleanest surface contract — the page has zero
    // `data-testid` attributes (read of page.tsx confirmed).
    await expect(
      page.getByRole("heading", { name: /my queue/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    await expect(
      page.getByRole("heading", { name: /my pending tasks/i })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /today.?s appointments/i })
    ).toBeVisible();

    // Lower-row panels (page.tsx:272, 314).
    await expect(
      page.getByRole("heading", { name: /my admitted patients/i })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /recent prescriptions/i })
    ).toBeVisible();
  });

  test("DOCTOR Pending-Tasks card pins the 4 task rows (page.tsx:204-228) regardless of seed fill", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/workspace");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    // Each TaskRow renders the label as visible text + a count number.
    // Empty seed → counts are 0; we only care the label-row is mounted,
    // since each row's <Link> wires to the corresponding feature page.
    await expect(
      page.getByText(/prescriptions to write/i).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    await expect(
      page.getByText(/lab results to review/i).first()
    ).toBeVisible();
    await expect(
      page.getByText(/discharge summaries pending/i).first()
    ).toBeVisible();
    await expect(
      page.getByText(/referrals awaiting response/i).first()
    ).toBeVisible();
  });

  test("DOCTOR Write-Rx shortcut routes to /dashboard/prescriptions?new=1 — pins page.tsx:121-126 href contract", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await gotoAuthed(page, "/dashboard/workspace");
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    const writeRx = page.getByRole("link", { name: /write rx/i }).first();
    await expect(writeRx).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Anchor href is the source-of-truth contract (a regression that
    // breaks `?new=1` or points at the wrong feature page would silently
    // strand the doctor). Click+URL would be flakier with the
    // /prescriptions chrome's own load.
    await expect(writeRx).toHaveAttribute("href", /\/dashboard\/prescriptions\?new=1/);
  });

  test("ADMIN bounces back to /dashboard — non-DOCTOR roles hit page.tsx:43-46 router.replace (redirect-bounce archetype)", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/workspace", { waitUntil: "domcontentloaded" });
    // Allow the role-gate useEffect a tick to fire.
    await page.waitForTimeout(800);

    // 6:1 cron-learning split: redirect target is `/dashboard`, not
    // `/dashboard/not-authorized`. The regex below tolerates either to
    // stay aligned with sibling specs (workstation/tenants/agent-console)
    // but the dominant landing for this page is /dashboard exactly.
    expect(page.url()).toMatch(/\/dashboard(\/not-authorized)?(\?|$|\/)/);
    expect(page.url()).not.toMatch(/\/dashboard\/workspace/);

    // The DOCTOR badge from page.tsx:108-110 must NOT have rendered for
    // ADMIN — confirms the gate fired before the auth'd render branch.
    await expect(page.getByRole("heading", { name: /^workspace$/i })).toHaveCount(0);
  });

  test("PATIENT bounces back to /dashboard — PATIENT is outside the DOCTOR-only gate at page.tsx:43", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/workspace", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(/\/dashboard(\/not-authorized)?(\?|$|\/)/);
    expect(page.url()).not.toMatch(/\/dashboard\/workspace/);

    // Doctor shortcut buttons must NOT be visible to a PATIENT.
    await expect(
      page.getByRole("link", { name: /start consultation/i })
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: /write rx/i })
    ).toHaveCount(0);
  });

  test("NURSE bounces back to /dashboard — staff role outside the DOCTOR-only gate", async ({
    nursePage,
  }) => {
    const page = nursePage;
    await page.goto("/dashboard/workspace", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);

    expect(page.url()).toMatch(/\/dashboard(\/not-authorized)?(\?|$|\/)/);
    expect(page.url()).not.toMatch(/\/dashboard\/workspace/);

    await expect(
      page.getByRole("heading", { name: /my pending tasks/i })
    ).toHaveCount(0);
  });
});
