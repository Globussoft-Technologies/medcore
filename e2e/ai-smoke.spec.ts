import { test, expect } from "./fixtures";
import { dismissTourIfPresent } from "./helpers";

/**
 * Smoke suite for the 14 newer AI-feature dashboard pages shipped Apr 2026.
 *
 * The first 7 AI pages (adherence, ai-analytics, er-triage, lab-explainer,
 * letters, pharmacy-forecast, predictions) already have dedicated specs in
 * this directory. This file covers everything that came after.
 *
 * Strategy per test:
 *   - Navigate as the role the backend gates on.
 *   - Stub `/api/v1/ai/**` (and any adjacent endpoints) so we don't burn
 *     Sarvam / LLM quota during E2E and so assertions are deterministic.
 *   - Assert heading + one interactive control + (for list views) a row
 *     from the stubbed fixture.
 */

// Tiny helper — we intentionally do NOT introduce a new helper file; keeping
// this inline respects the "no new npm deps, minimal churn" rule.
function jsonFulfill(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  } as const;
}

test.describe("AI smoke (14 newer AI routes)", () => {
  // ── 1. /dashboard/ai/chart-search ────────────────────────────────────────
  test("chart-search: doctor sees ambient chart search UI", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/ai/chart-search");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /ambient chart search/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Query input + Ask button anchor the primary interaction.
    await expect(page.getByPlaceholder(/e\.g\. when did/i).first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^ask$/i }).first()
    ).toBeVisible();
    // Both tabs render.
    await expect(
      page.getByRole("tab", { name: /this patient/i }).first()
    ).toBeVisible();
    await expect(
      page.getByRole("tab", { name: /cohort/i }).first()
    ).toBeVisible();
  });

  // ── 2. /dashboard/ai-differential ────────────────────────────────────────
  test("ai-differential: doctor sees complaint form + vitals inputs", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/ai-differential");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /ai differential diagnosis/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Chief complaint textarea + vitals inputs + submit button render.
    await expect(
      page.getByPlaceholder(/productive cough and fever/i).first()
    ).toBeVisible();
    await expect(page.getByPlaceholder(/BP \(e\.g/i).first()).toBeVisible();
    await expect(page.getByPlaceholder(/^pulse$/i).first()).toBeVisible();
    await expect(
      page.getByRole("button", { name: /suggest differentials/i }).first()
    ).toBeVisible();
  });

  // ── 3. /dashboard/ai-followup ────────────────────────────────────────────
  test("ai-followup: doctor sees follow-up list rendered from a stubbed row", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    // Stub the consultations list so the row is deterministic.
    const stubConsultations = {
      success: true,
      data: {
        consultations: [
          {
            id: "c-smoke-1",
            appointmentId: "a-1",
            notes: "follow-up review needed",
            doctor: { user: { name: "Dr. Sharma" } },
            appointment: {
              patient: {
                id: "p-1",
                mrNumber: "MRN-SMOKE-1",
                user: { name: "Smoke Patient One" },
              },
            },
          },
        ],
      },
    };
    await page.route("**/api/v1/ehr/consultations**", (r) =>
      r.fulfill(jsonFulfill(stubConsultations))
    );
    await page.route("**/api/v1/consultations**", (r) =>
      r.fulfill(jsonFulfill(stubConsultations))
    );

    await page.goto("/dashboard/ai-followup");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /smart follow-up/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    // Refresh button renders.
    await expect(
      page.getByRole("button", { name: /refresh/i }).first()
    ).toBeVisible();
    // Stubbed row surfaces with the patient's name.
    await expect(page.getByText(/smoke patient one/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  // ── 4. /dashboard/lab — AI Insights button visibility ────────────────────
  test("lab: doctor sees AI Insights action once a result is expanded", async ({
    doctorPage,
  }) => {
    const page = doctorPage;

    // One IN_PROGRESS order with a completed result so "AI Insights" button
    // can render for DOCTOR + ADMIN (canSeeAI gate in lab/page.tsx).
    await page.route("**/api/v1/lab/orders**", (r) =>
      r.fulfill(
        jsonFulfill({
          success: true,
          data: [
            {
              id: "ord-smoke-1",
              orderNumber: "LAB-0001",
              orderedAt: new Date().toISOString(),
              status: "IN_PROGRESS",
              priority: "ROUTINE",
              stat: false,
              patient: {
                id: "p-smoke",
                mrNumber: "MRN-LAB-1",
                user: { name: "Lab Smoke Patient" },
              },
              doctor: { user: { name: "Dr. Sharma" } },
              items: [
                {
                  id: "it-1",
                  status: "COMPLETED",
                  test: { id: "t-1", name: "CBC" },
                  results: [
                    {
                      id: "res-1",
                      parameter: "Hemoglobin",
                      value: "13.2",
                      unit: "g/dL",
                      normalRange: "12–16",
                      flag: "NORMAL",
                    },
                  ],
                },
              ],
            },
          ],
        })
      )
    );

    await page.goto("/dashboard/lab");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /lab/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Expand the stubbed order to reveal the per-result row + AI Insights btn.
    await page.getByText(/lab smoke patient/i).first().click();

    await expect(page.getByText(/hemoglobin/i).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole("button", { name: /ai insights/i }).first()
    ).toBeVisible();
  });

  // ── 5. /dashboard/bill-explainer ─────────────────────────────────────────
  test("bill-explainer: admin sees approval queue with a stubbed row", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/bill-explainer/pending**", (r) =>
      r.fulfill(
        jsonFulfill({
          success: true,
          data: [
            {
              id: "bx-1",
              invoiceId: "inv-smoke-1234567890",
              patientId: "p-smoke-1234567890",
              language: "en",
              content: "Your bill breakdown in plain English.",
              status: "DRAFT",
              flaggedItems: [],
              approvedBy: null,
              approvedAt: null,
              sentAt: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        })
      )
    );

    await page.goto("/dashboard/bill-explainer");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /ai bill.*explainer/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    // Approve button (primary interactive control on a DRAFT row).
    await expect(
      page.getByRole("button", { name: /approve.*send/i }).first()
    ).toBeVisible({ timeout: 10_000 });
    // Content snippet from the stubbed draft.
    await expect(
      page.getByText(/plain english/i).first()
    ).toBeVisible();
  });

  // ── 6. /dashboard/insurance-claims ───────────────────────────────────────
  test("insurance-claims: admin list + Submit new claim CTA render", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/claims**", (r) =>
      r.fulfill(
        jsonFulfill({
          success: true,
          data: [
            {
              id: "cl-smoke-1",
              billId: "b-1",
              patientId: "p-1",
              tpaProvider: "MOCK",
              providerClaimRef: "PROV-SMOKE-1",
              insurerName: "Acme Health",
              policyNumber: "POL-001",
              diagnosis: "Pneumonia",
              amountClaimed: 50_000,
              amountApproved: null,
              status: "SUBMITTED",
              submittedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            },
          ],
        })
      )
    );

    await page.goto("/dashboard/insurance-claims");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /insurance claims/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    // Primary CTA.
    await expect(
      page.getByRole("button", { name: /submit new claim/i }).first()
    ).toBeVisible();
    // AI Draft button — now surfaced via
    // `data-testid="insurance-claims-ai-draft"`. Previously this was flagged
    // as missing in the E2E report; the page now wires through
    // `POST /api/v1/ai/claims/draft/:consultationId`.
    await expect(page.getByTestId("insurance-claims-ai-draft")).toBeVisible();
    // Row from the stub (testid on each `<tr>`).
    await expect(page.getByTestId("claim-row").first()).toBeVisible();
    await expect(page.getByText(/acme health/i).first()).toBeVisible();
  });

  // ── 7. /dashboard/capacity-forecast ──────────────────────────────────────
  test("capacity-forecast: admin can toggle beds/icu/ot tabs", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/capacity/**", (r) =>
      r.fulfill(
        jsonFulfill({
          success: true,
          data: {
            horizonHours: 72,
            generatedAt: new Date().toISOString(),
            forecasts: [
              {
                resourceId: "w-1",
                resourceName: "Ward 1 Smoke",
                resourceType: "ward",
                capacityUnits: 10,
                currentlyInUse: 5,
                plannedReleases: 1,
                predictedInflow: 2,
                predictedInflowUpper: 3,
                expectedOccupancyPct: 60,
                expectedStockout: false,
                confidence: "high",
                method: "holt-winters",
                insufficientData: false,
              },
            ],
            summary: {
              totalCapacity: 10,
              totalCurrentlyInUse: 5,
              totalPredictedInflow: 2,
              totalPredictedInflowUpper: 3,
              aggregateOccupancyPct: 60,
              anyStockoutRisk: false,
              wardsAtRisk: 0,
            },
          },
          error: null,
        })
      )
    );

    await page.goto("/dashboard/capacity-forecast");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /capacity forecast/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    // Prefer the stable data-testid hooks on the tab buttons. The earlier
    // text-based `getByRole("button", { name: /^beds$/i })` was fragile
    // because the ICU/OT tabs render icons + text together, so the
    // accessible name wasn't a clean match. Now that each tab is a
    // `role="tab"` with `data-testid="capacity-tab-<key>"`, the lookup is
    // unambiguous.
    const bedsTab = page.getByTestId("capacity-tab-beds");
    const icuTab = page.getByTestId("capacity-tab-icu");
    const otTab = page.getByTestId("capacity-tab-ot");
    await expect(bedsTab).toBeVisible();
    await expect(icuTab).toBeVisible();
    await expect(otTab).toBeVisible();

    await icuTab.click();
    await expect(page.getByText(/ward 1 smoke/i).first()).toBeVisible({
      timeout: 10_000,
    });
    await otTab.click();
    await expect(page.getByText(/ward 1 smoke/i).first()).toBeVisible();
  });

  // ── 8. /dashboard/ai-roster ──────────────────────────────────────────────
  test("ai-roster: admin submits propose form and sees a proposal view", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // History is called on mount.
    await page.route("**/api/v1/ai/roster/history**", (r) =>
      r.fulfill(jsonFulfill({ success: true, data: [] }))
    );
    await page.route("**/api/v1/ai/roster/propose**", (r) =>
      r.fulfill(
        jsonFulfill({
          success: true,
          data: {
            id: "rp-smoke-1",
            status: "PROPOSED",
            startDate: new Date().toISOString().slice(0, 10),
            days: 7,
            department: "general",
            proposals: [
              {
                date: new Date().toISOString().slice(0, 10),
                shifts: [
                  {
                    shiftType: "MORNING",
                    requiredCount: 1,
                    assignedStaff: [
                      {
                        userId: "u-1",
                        name: "Nurse Alice Smoke",
                        role: "NURSE",
                      },
                    ],
                    understaffed: false,
                  },
                ],
              },
            ],
            warnings: [],
            violationsIfApplied: [],
          },
          error: null,
        })
      )
    );

    await page.goto("/dashboard/ai-roster");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /ai staff roster/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    // Propose form fields + Generate button render.
    await expect(page.locator('input[type="date"]').first()).toBeVisible();
    const generate = page
      .getByRole("button", { name: /^generate$/i })
      .first();
    await expect(generate).toBeVisible();

    // Submitting flips into a proposal view with an Apply button.
    await generate.click();
    await expect(
      page.getByRole("button", { name: /^apply$/i }).first()
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/nurse alice smoke/i).first()).toBeVisible();
  });

  // ── 9. /dashboard/ai-fraud ───────────────────────────────────────────────
  test("ai-fraud: admin sees alert queue (empty state is acceptable)", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/fraud/alerts**", (r) =>
      r.fulfill(jsonFulfill({ success: true, data: [] }))
    );

    await page.goto("/dashboard/ai-fraud");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /fraud.*anomaly/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    // Primary interactive — Run Scan Now button.
    await expect(
      page.getByRole("button", { name: /run scan now/i }).first()
    ).toBeVisible();
    // Empty-state container now carries `data-testid="fraud-empty-state"`.
    await expect(page.getByTestId("fraud-empty-state")).toBeVisible({
      timeout: 10_000,
    });
  });

  // ── 10. /dashboard/ai-doc-qa ─────────────────────────────────────────────
  test("ai-doc-qa: admin sees report list from stubbed data", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/ai/doc-qa/reports**", (r) =>
      r.fulfill(
        jsonFulfill({
          success: true,
          data: [
            {
              consultationId: "cons-smoke-abcdef12",
              score: 87,
              completenessScore: 90,
              icdAccuracyScore: 85,
              medicationScore: 88,
              clarityScore: 86,
              issues: [],
              recommendations: [],
              auditedAt: new Date().toISOString(),
            },
          ],
        })
      )
    );

    await page.goto("/dashboard/ai-doc-qa");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /clinical documentation qa/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: /run sample audit/i }).first()
    ).toBeVisible();
    // Row from the stubbed report — now tagged with `data-testid="docqa-report-row"`.
    await expect(page.getByTestId("docqa-report-row").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/cons-smo/i).first()).toBeVisible();
    await expect(page.getByText(/87/).first()).toBeVisible();
    // Detail panel container renders on the right.
    await expect(page.getByTestId("docqa-detail")).toBeVisible();
  });

  // ── 11. /dashboard/feedback ──────────────────────────────────────────────
  test("feedback: admin sees sentiment badges + NPS drivers widget", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/feedback?**", (r) =>
      r.fulfill(
        jsonFulfill({
          success: true,
          data: [
            {
              id: "fb-1",
              category: "DOCTOR",
              rating: 5,
              nps: 9,
              comment: "Great experience",
              submittedAt: new Date().toISOString(),
              patient: { user: { name: "Smoke Reviewer", phone: "+911111" } },
              aiSentiment: {
                sentiment: "positive",
                emotions: ["joy"],
                themes: ["doctor"],
              },
            },
          ],
        })
      )
    );
    await page.route("**/api/v1/feedback/summary**", (r) =>
      r.fulfill(
        jsonFulfill({
          success: true,
          data: {
            totalCount: 1,
            overallAvg: 5,
            avgRatingByCategory: { DOCTOR: 5 },
            npsScore: 100,
            npsSampleSize: 1,
            promoters: 1,
            detractors: 0,
            passives: 0,
            trend: [{ month: "2026-04", avgRating: 5, count: 1 }],
          },
        })
      )
    );
    await page.route("**/api/v1/ai/sentiment/nps-drivers**", (r) =>
      r.fulfill(
        jsonFulfill({
          success: true,
          data: {
            windowDays: 30,
            totalFeedback: 1,
            positiveThemes: [
              { theme: "doctor empathy", count: 1, sampleQuotes: [] },
            ],
            negativeThemes: [],
            actionableInsights: ["Keep investing in doctor empathy training"],
            generatedAt: new Date().toISOString(),
          },
        })
      )
    );

    await page.goto("/dashboard/feedback");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /patient feedback/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    // NPS drivers widget heading (AI).
    await expect(
      page.getByRole("heading", { name: /nps drivers/i }).first()
    ).toBeVisible({ timeout: 10_000 });
    // Sentiment badge from the stubbed row.
    await expect(page.getByText(/^positive$/i).first()).toBeVisible();
    // Actionable insight copy surfaces.
    await expect(
      page.getByText(/doctor empathy training/i).first()
    ).toBeVisible();
  });

  // ── 12. /dashboard/fhir-export ───────────────────────────────────────────
  test("fhir-export: admin sees patient picker + 3 export buttons", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/fhir-export");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /fhir export/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    // Patient picker input.
    await expect(page.locator("#fhir-patient")).toBeVisible();
    // Three export action buttons render (disabled until a patient is picked,
    // but the buttons themselves are mounted).
    await expect(
      page.getByRole("button", { name: /patient resource/i }).first()
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /\$everything bundle/i }).first()
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /abdm push bundle/i }).first()
    ).toBeVisible();
  });

  // ── 13. /dashboard/abdm ──────────────────────────────────────────────────
  test("abdm: admin sees Link ABHA / Consents / Care Contexts tabs", async ({
    adminPage,
  }) => {
    const page = adminPage;
    await page.goto("/dashboard/abdm");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /abdm.*abha/i }).first()
    ).toBeVisible({ timeout: 15_000 });

    const linkTab = page.getByRole("tab", { name: /link abha/i }).first();
    const consentTab = page.getByRole("tab", { name: /consents/i }).first();
    const careTab = page
      .getByRole("tab", { name: /care contexts/i })
      .first();
    await expect(linkTab).toBeVisible();
    await expect(consentTab).toBeVisible();
    await expect(careTab).toBeVisible();

    // Default tab shows Link ABHA form.
    await expect(
      page.getByRole("heading", { name: /link abha to patient/i }).first()
    ).toBeVisible();

    // Consents tab renders the new-request form.
    await consentTab.click();
    await expect(
      page.getByRole("heading", { name: /request new consent/i }).first()
    ).toBeVisible({ timeout: 10_000 });

    // Care Contexts tab renders the push form.
    await careTab.click();
    await expect(
      page.getByRole("heading", { name: /push care context/i }).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  // ── 14. Doctor cross-role check on abdm (sanity — 3 roles share the route)
  test("abdm: doctor can also load the page (shared RBAC with admin+reception)", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/abdm");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /abdm.*abha/i }).first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("tab", { name: /link abha/i }).first()
    ).toBeVisible();
  });
});
