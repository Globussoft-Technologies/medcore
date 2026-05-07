/**
 * Antenatal case chart drilldown — /dashboard/antenatal/[id] structural skeleton + RBAC.
 *
 * What this exercises:
 *   /dashboard/antenatal/[id]
 *     (apps/web/src/app/dashboard/antenatal/[id]/page.tsx — 1672 LOC chart)
 *   GET   /api/v1/antenatal/cases/:id
 *     (no authorize() — every authed user, but row-level BOLA via
 *     `assertPatientOwnsResource` in antenatal.ts:355.)
 *   GET   /api/v1/antenatal/cases/:id/postnatal-visits
 *     (no authorize(), antenatal.ts:1054.)
 *   POST  /api/v1/antenatal/visits
 *     (DOCTOR / ADMIN / NURSE, antenatal.ts:462.)
 *   PATCH /api/v1/antenatal/cases/:id/delivery
 *     (DOCTOR / ADMIN, antenatal.ts:407 — the "delivery recorder" RBAC
 *     asymmetry vs. NURSE.)
 *   POST  /api/v1/antenatal/cases/:id/acog-risk-score
 *     (DOCTOR / ADMIN / NURSE, antenatal.ts:898.)
 *
 * Surfaces touched (structural-skeleton pinning, NOT full panel exercise —
 * the page is 1672 LOC across 5 tabs; we lock the section testids/headings
 * + 2 happy paths for the primary role; deep panel coverage of the partograph
 * SVG, ACOG-form-and-result, and postnatal table lives in API tests):
 *   - DOCTOR happy path 1: opens the chart for a stubbed-via-page.route ANC
 *     case. Header chrome (case number h1 + High-Risk pill + patient name +
 *     MR number) renders. The 4-tab cluster (Visits / Delivery / Partograph
 *     / ACOG Risk) renders — Postnatal-Visits 5th tab only renders when the
 *     case has `deliveredAt`, so we use a non-delivered fixture for the
 *     base chart and delivered fixture for the postnatal pin.
 *   - DOCTOR happy path 2: clicks into "ACOG Risk" tab and the score-form
 *     surface mounts (heading + Calculate-Risk-Score button + checkbox
 *     options like "Hypertension" / "Diabetes" — at least the sentinel
 *     ones, not exhaustive).
 *   - DOCTOR delivered-fixture: a case with `deliveredAt` populated mounts
 *     the 5th "Postnatal Visits" tab AND the "Print Birth Certificate" CTA
 *     (page.tsx:268-277 — only rendered when delivered).
 *   - PATIENT BOLA-403: server returns 403 for /antenatal/cases/:id when
 *     the PATIENT doesn't own the case (assertPatientOwnsResource gate). We
 *     stub the endpoint to 403 and assert the page shows the loading/empty
 *     state without crashing — this pins the BOLA-pass-through contract.
 *   - Bad UUID 404: stubbing the GET to 404 leaves the page in its
 *     "Loading..." state (page.tsx:222-224 — `loading || !caseData` short-
 *     circuits). We pin the no-crash contract.
 *
 * Why these tests exist:
 *   docs/E2E_COVERAGE_BACKLOG.md §2.12 line 174 + §6 line 522 list
 *   "/dashboard/antenatal/[id] — antenatal care / prenatal visit cadence"
 *   as a zero-coverage entry. The page is the central maternity workflow
 *   surface — a regression in the tab-cluster mount logic, the
 *   `deliveredAt`-conditional rendering of the Postnatal-Visits tab + Birth-
 *   Certificate CTA, or the BOLA pass-through behaviour would silently
 *   break a high-volume clinical surface. We pin the structural skeleton
 *   (testids/headings) without exercising every panel deeply — that level
 *   of coverage requires API + DB seed of a delivered+postnatal+partograph
 *   case which would pollute shared seed across runs.
 *
 *   Page-shape archetype: CLAUDE.md gotcha #7 archetype 3 (UNIVERSAL-ACCESS).
 *   No `VIEW_ALLOWED`, no `router.push`/`router.replace` — confirmed via
 *   grep. The page assumes the GET succeeds; if the server 403s (BOLA),
 *   the page just sits in `loading` state. We pin THAT real behaviour.
 */
import { test, expect } from "./fixtures";
import { Page } from "@playwright/test";
import { dismissTourIfPresent, expectNotForbidden, gotoAuthed } from "./helpers";

const PAGE_TIMEOUT = 15_000;

// Synthetic UUIDs we use for stubbed routes. The page reads `params.id`
// directly into the API call URL, so we can pick any UUID-shaped string.
const STUB_CASE_ID = "11111111-1111-4111-8111-111111111111";
const STUB_DELIVERED_ID = "22222222-2222-4222-8222-222222222222";
const STUB_BAD_ID = "00000000-0000-4000-8000-000000000000";

interface AncCaseStub {
  id: string;
  caseNumber: string;
  lmpDate: string;
  eddDate: string;
  gravida: number;
  parity: number;
  bloodGroup?: string | null;
  isHighRisk: boolean;
  riskFactors?: string | null;
  deliveredAt?: string | null;
  deliveryType?: string | null;
  babyGender?: string | null;
  babyWeight?: number | null;
  outcomeNotes?: string | null;
  patient: {
    id: string;
    mrNumber: string;
    user: { name: string; phone?: string; email?: string };
  };
  doctor: { id: string; user: { name: string } };
  visits: Array<{
    id: string;
    type: string;
    visitDate: string;
    weeksOfGestation?: number | null;
    weight?: number | null;
    bloodPressure?: string | null;
  }>;
}

function buildAncCase(opts: { id: string; delivered: boolean }): AncCaseStub {
  // Build a deterministic ANC-case payload that matches the shape the page
  // consumes (page.tsx:40-62 + visit shape page.tsx:22-38).
  const lmp = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
  const edd = new Date(Date.now() + 80 * 24 * 60 * 60 * 1000).toISOString();
  const base: AncCaseStub = {
    id: opts.id,
    caseNumber: opts.delivered ? "ANC900002" : "ANC900001",
    lmpDate: lmp,
    eddDate: edd,
    gravida: 2,
    parity: 1,
    bloodGroup: "O_POSITIVE",
    isHighRisk: !opts.delivered, // first fixture is high-risk, delivered one is not
    riskFactors: opts.delivered ? null : "Previous C-section, Hypertension",
    deliveredAt: opts.delivered ? new Date().toISOString() : null,
    deliveryType: opts.delivered ? "NORMAL" : null,
    babyGender: opts.delivered ? "FEMALE" : null,
    babyWeight: opts.delivered ? 3.2 : null,
    outcomeNotes: opts.delivered ? "Healthy delivery, no complications" : null,
    patient: {
      id: "ptpt0000-0000-4000-8000-000000000001",
      mrNumber: "MR-ANC-E2E",
      user: {
        name: opts.delivered ? "Priya Sharma" : "Anaya Mehta",
        phone: "+919812345678",
      },
    },
    doctor: {
      id: "drdr0000-0000-4000-8000-000000000001",
      user: { name: "Dr. R. Iyer" },
    },
    visits: [
      {
        id: "vsvs0000-0000-4000-8000-000000000001",
        type: "ROUTINE",
        visitDate: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
        weeksOfGestation: 28,
        weight: 65.4,
        bloodPressure: "120/80",
      },
    ],
  };
  return base;
}

async function stubAncCase(
  page: Page,
  caseStub: AncCaseStub,
  postnatal: unknown[] = []
): Promise<void> {
  // Stub the case-detail GET that the page mounts on first load.
  await page.route(
    new RegExp(`/api/v1/antenatal/cases/${caseStub.id}(\\?|$)`),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: caseStub, error: null }),
      })
  );
  // Postnatal-visits GET fires when the postnatal tab mounts.
  await page.route(
    new RegExp(
      `/api/v1/antenatal/cases/${caseStub.id}/postnatal-visits(\\?|$)`
    ),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: postnatal, error: null }),
      })
  );
}

test.describe("Antenatal chart [id] — /dashboard/antenatal/[id] (DOCTOR primary chrome + tab-cluster skeleton + delivered-conditional surfaces + BOLA pass-through)", () => {
  test("DOCTOR opens the chart and the header chrome (case number + High-Risk pill + patient name + tab cluster Visits/Delivery/Partograph/ACOG-Risk) all render", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    const caseStub = buildAncCase({ id: STUB_CASE_ID, delivered: false });
    await stubAncCase(page, caseStub);

    await gotoAuthed(page, `/dashboard/antenatal/${STUB_CASE_ID}`);
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    // Page heading = the caseNumber (page.tsx:251-252).
    await expect(
      page.getByRole("heading", { name: /ANC900001/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // High-Risk pill (page.tsx:253-257).
    await expect(page.getByText(/^high risk$/i).first()).toBeVisible();

    // Patient name + MR (page.tsx:264-266). The page renders the name
    // in two places (header card "<Name>" + summary "<Name> · <MR>"), so
    // strict-mode resolves to 2 elements. .first() picks the first match.
    await expect(page.getByText(caseStub.patient.user.name).first()).toBeVisible();
    // MR also renders in two places (header summary + Patient-Info card),
    // same pattern as patient name. Use .first().
    await expect(page.getByText(/MR-ANC-E2E/i).first()).toBeVisible();

    // Patient-Info card heading (page.tsx:282).
    await expect(
      page.getByRole("heading", { name: /patient info/i })
    ).toBeVisible();
    // ANC-Summary card heading (page.tsx:296).
    await expect(
      page.getByRole("heading", { name: /anc summary/i })
    ).toBeVisible();

    // Tab cluster — page.tsx:381-433. The 4 always-on tabs:
    await expect(
      page.getByRole("button", { name: /^visits \(\d+\)$/i })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^delivery$/i })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^partograph$/i })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^acog risk$/i })
    ).toBeVisible();

    // Non-delivered case: Postnatal-Visits 5th tab is conditionally hidden.
    await expect(
      page.getByRole("button", { name: /^postnatal visits$/i })
    ).toHaveCount(0);

    // Birth-Certificate CTA also hidden when not delivered (page.tsx:268-277).
    await expect(
      page.getByRole("button", { name: /print birth certificate/i })
    ).toHaveCount(0);
  });

  test("DOCTOR clicks the ACOG Risk tab — score form surface mounts (heading + Calculate-Score button + at least one risk-factor checkbox)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    const caseStub = buildAncCase({ id: STUB_CASE_ID, delivered: false });
    await stubAncCase(page, caseStub);

    await gotoAuthed(page, `/dashboard/antenatal/${STUB_CASE_ID}`);
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("button", { name: /^acog risk$/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    await page.getByRole("button", { name: /^acog risk$/i }).click();

    // ACOG tab heading (page.tsx:1371) — "ACOG-Based Risk Score".
    await expect(
      page.getByRole("heading", { name: /acog-based risk score/i })
    ).toBeVisible({ timeout: 10_000 });

    // Calculate-Score button (page.tsx:1418-1424).
    await expect(
      page.getByRole("button", { name: /calculate acog risk score/i })
    ).toBeVisible();

    // Risk-factor checkboxes (page.tsx:1390-1399). Anchor on a sentinel
    // labelled checkbox — "Hypertension" is unique to this tab.
    await expect(page.getByLabel(/^hypertension$/i)).toBeVisible();
    await expect(page.getByLabel(/^diabetes \/ gdm$/i)).toBeVisible();
  });

  test("DOCTOR opens a DELIVERED case — Postnatal-Visits 5th tab + Print-Birth-Certificate CTA + delivery details surface all render (page.tsx:268-277, 422-433 conditional render)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    const caseStub = buildAncCase({ id: STUB_DELIVERED_ID, delivered: true });
    await stubAncCase(page, caseStub);

    await gotoAuthed(page, `/dashboard/antenatal/${STUB_DELIVERED_ID}`);
    await dismissTourIfPresent(page);
    await expectNotForbidden(page);

    await expect(
      page.getByRole("heading", { name: /ANC900002/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // The "Delivered" pill (page.tsx:258-262).
    await expect(page.getByText(/^delivered$/i).first()).toBeVisible();

    // Print-Birth-Certificate CTA (page.tsx:268-277, only rendered when
    // deliveredAt is non-null).
    await expect(
      page.getByRole("button", { name: /print birth certificate/i })
    ).toBeVisible();

    // 5th tab now rendered (page.tsx:422-433 deliveredAt gate).
    await expect(
      page.getByRole("button", { name: /^postnatal visits$/i })
    ).toBeVisible();

    // Click Delivery tab and the delivery details surface for an already-
    // delivered case (page.tsx:744-777).
    await page.getByRole("button", { name: /^delivery$/i }).click();
    await expect(
      page.getByRole("heading", { name: /delivery details/i })
    ).toBeVisible({ timeout: 10_000 });

    // Click Postnatal Visits → tab mounts the (empty) postnatal panel.
    await page.getByRole("button", { name: /^postnatal visits$/i }).click();
    await expect(
      page.getByRole("heading", { name: /^postnatal visits$/i })
    ).toBeVisible({ timeout: 10_000 });
    // With our empty stub array, the empty-state copy renders (page.tsx:1642).
    await expect(
      page.getByText(/no postnatal visits recorded/i)
    ).toBeVisible();
  });

  test("PATIENT visits a case they don't own — server returns 403 (assertPatientOwnsResource BOLA gate at antenatal.ts:355) and the page sits in 'Loading...' without crashing or bouncing", async ({
    patientPage,
  }) => {
    const page = patientPage;
    // Stub /api/v1/antenatal/cases/:id to 403 — exactly what the server
    // would do via assertPatientOwnsResource if the PATIENT doesn't own
    // the case row.
    await page.route(
      new RegExp(`/api/v1/antenatal/cases/${STUB_CASE_ID}(\\?|$)`),
      (route) =>
        route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            data: null,
            error: "Forbidden",
          }),
        })
    );

    await gotoAuthed(page, `/dashboard/antenatal/${STUB_CASE_ID}`);
    await page.waitForTimeout(800);

    // No client-side gate redirect — the page stays mounted on the URL.
    expect(page.url()).toContain(`/dashboard/antenatal/${STUB_CASE_ID}`);

    // page.tsx:222-224 short-circuits to "Loading..." while caseData is null.
    // After the catch-and-swallow at page.tsx:123-125, caseData stays null,
    // setLoading(false) fires, but `!caseData` keeps the loading branch.
    // We anchor on the literal copy.
    await expect(
      page.getByText(/^loading\.\.\.$/i).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // No header heading (the caseNumber h1) ever rendered. We do NOT use
    // expectNotForbidden because the server's 403 body is intentionally
    // swallowed — the page never paints "Forbidden" anywhere.
  });

  test("Bad UUID — server 404 leaves the page in 'Loading...' (page.tsx:222 short-circuit), no crash and no /not-authorized bounce", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.route(
      new RegExp(`/api/v1/antenatal/cases/${STUB_BAD_ID}(\\?|$)`),
      (route) =>
        route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            data: null,
            error: "ANC case not found",
          }),
        })
    );

    await gotoAuthed(page, `/dashboard/antenatal/${STUB_BAD_ID}`);
    await page.waitForTimeout(800);

    expect(page.url()).toContain(`/dashboard/antenatal/${STUB_BAD_ID}`);
    expect(page.url()).not.toContain("/dashboard/not-authorized");

    // Loading state holds because caseData stayed null (page.tsx:122-126
    // catches and swallows the 404, but loading flips off — the !caseData
    // guard at line 222 keeps the Loading copy).
    await expect(
      page.getByText(/^loading\.\.\.$/i).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
  });
});
