import { test, expect } from "./fixtures";
import { APIRequestContext } from "@playwright/test";
import {
  API_BASE,
  apiGet,
  apiPost,
  expectNotForbidden,
  seedPatient,
} from "./helpers";

/**
 * Pediatric module end-to-end coverage (Audit §7.1.C — coverage gap).
 *
 * Surfaces protected:
 *   1. /dashboard/pediatric (landing list of <18 y/o patients) renders and
 *      drills into a growth chart at /dashboard/pediatric/[patientId].
 *   2. The growth chart inline SVG renders points for recorded vitals
 *      (height / weight / head-circumference) and adding a measurement via
 *      the `growth-*` form testids plots a new point — i.e. the SVG circle
 *      count goes up after submit.
 *   3. The India UIP immunization schedule (growth.ts:325) lists at least
 *      one due/overdue dose for a freshly seeded ~2-year-old patient.
 *   4. POSTing a new immunization to /ehr/immunizations persists, the
 *      vaccine no longer surfaces as "OVERDUE" / "DUE_SOON" on the
 *      schedule, and the next-due-date is computable for the booster.
 *   5. The growth-record write path returns server-computed weight/height
 *      percentiles for a seeded measurement at age ~24 months.
 *
 * Why a custom seedPediatricPatient helper:
 *   The shared `seedPatient(adminApi)` from helpers.ts hard-codes adult
 *   age (30–60y) and never sets `dateOfBirth`. The pediatric page filters
 *   patients to age < 18 client-side using DOB, and the immunization
 *   compliance endpoint short-circuits with `note: "Date of birth required"`
 *   when DOB is missing. We therefore POST /patients directly with a DOB
 *   ~2 years in the past so percentile + UIP-due logic both have something
 *   to chew on.
 */

const PAGE_TIMEOUT = 15_000;

interface SeededPediatricPatient {
  id: string;
  mrNumber: string;
  name: string;
  dateOfBirth: string; // YYYY-MM-DD
}

const PEDIATRIC_FIRST_NAMES = [
  "Aarav",
  "Saanvi",
  "Vihaan",
  "Diya",
  "Reyansh",
  "Anaya",
  "Kabir",
  "Myra",
];
const PEDIATRIC_LAST_NAMES = [
  "Mehta",
  "Joshi",
  "Reddy",
  "Sharma",
  "Iyer",
  "Verma",
  "Patel",
  "Krishnan",
];

function pediatricName(): string {
  const f =
    PEDIATRIC_FIRST_NAMES[
      Math.floor(Math.random() * PEDIATRIC_FIRST_NAMES.length)
    ];
  const l =
    PEDIATRIC_LAST_NAMES[
      Math.floor(Math.random() * PEDIATRIC_LAST_NAMES.length)
    ];
  return `${f} ${l}`;
}

function dobYearsAgo(years: number): string {
  // Deterministic month/day so percentile lookup is stable in CI. We pick
  // 15th of the month to dodge end-of-month edge cases.
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  d.setMonth(d.getMonth());
  d.setDate(15);
  return d.toISOString().slice(0, 10);
}

async function seedPediatricPatient(
  api: APIRequestContext,
  opts: { ageYears?: number } = {}
): Promise<SeededPediatricPatient> {
  const ageYears = opts.ageYears ?? 2;
  const name = pediatricName();
  const dateOfBirth = dobYearsAgo(ageYears);
  const res = await api.post(`${API_BASE}/patients`, {
    data: {
      name,
      // age=0 is allowed when DOB is supplied (newborn flow per
      // packages/shared/src/validation/patient.ts:64). For toddlers we
      // pass the integer age too — the server stores both.
      age: ageYears > 0 ? ageYears : 0,
      dateOfBirth,
      gender: Math.random() > 0.5 ? "MALE" : "FEMALE",
      phone: `+9197${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
    },
  });
  if (!res.ok()) {
    throw new Error(
      `seedPediatricPatient failed: ${res.status()} ${(await res.text()).slice(0, 200)}`
    );
  }
  const json = await res.json();
  const data = json.data ?? json;
  return {
    id: data.id,
    mrNumber: data.mrNumber,
    name: data.user?.name ?? data.name ?? name,
    dateOfBirth,
  };
}

test.describe("Pediatric module — chart / vitals / immunizations", () => {
  test("DOCTOR opens the pediatric landing list and drills into a chart", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const child = await seedPediatricPatient(adminApi, { ageYears: 2 });

    await page.goto("/dashboard/pediatric", { waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);
    await expect(
      page.getByRole("heading", { name: /pediatric patients/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Wait for the loading state to clear before asserting the seeded row.
    // The list paginates at 200 and filters age<18 client-side, so a freshly
    // seeded 2-year-old is guaranteed to make the cut.
    await expect(page.locator("body")).not.toContainText(/^Loading\.\.\.$/i, {
      timeout: PAGE_TIMEOUT,
    });

    // The MR number is the most stable handle — the random Indian-sounding
    // name might collide with an existing seed row.
    await expect(page.getByText(child.mrNumber).first()).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });

    // Click into the chart via the seeded row's link. Using an href filter
    // avoids ambiguity when multiple rows share a first name.
    await page
      .locator(`a[href="/dashboard/pediatric/${child.id}"]`)
      .first()
      .click();

    await expect(page).toHaveURL(
      new RegExp(`/dashboard/pediatric/${child.id}`)
    );
    await expect(
      page.getByRole("heading", { name: child.name })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    // Three growth charts render side-by-side (Weight / Height / HC).
    await expect(page.getByText(/Weight vs Age/i)).toBeVisible();
    await expect(page.getByText(/Height vs Age/i)).toBeVisible();
    await expect(page.getByText(/Head Circumference/i).first()).toBeVisible();
    await expectNotForbidden(page);
  });

  test("Recording a height/weight via the form plots a new point on the growth chart", async ({
    doctorPage,
    adminApi,
  }) => {
    const page = doctorPage;
    const child = await seedPediatricPatient(adminApi, { ageYears: 2 });

    await page.goto(`/dashboard/pediatric/${child.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(
      page.getByRole("heading", { name: child.name })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });
    await expectNotForbidden(page);

    // Count the chart-point circles BEFORE adding a measurement. The page
    // also draws a few decorative circles (none today — buildChart only
    // emits <circle> for data points), so we treat the pre-count as the
    // baseline rather than asserting exactly 0.
    const circles = page.locator(".rounded-xl svg circle");
    const beforeCount = await circles.count();

    // Open the "Add Measurement" form — DOCTORs satisfy `canEdit`.
    await page.getByRole("button", { name: /add measurement/i }).click();

    // The form testids are anchored in
    // apps/web/src/app/dashboard/pediatric/[patientId]/page.tsx (added per
    // Issue #435). We populate weight + height; head circumference is
    // optional and the server only requires at least one of the three.
    await page.locator('[data-testid="growth-age-months"]').fill("24");
    await page.locator('[data-testid="growth-weight-kg"]').fill("12.5");
    await page.locator('[data-testid="growth-height-cm"]').fill("87");

    await page.getByRole("button", { name: /save measurement/i }).click();

    // The page calls load() after a successful submit and the new circle is
    // rendered into all three SVGs (weight + height; head-circumference is
    // skipped because we left it blank, but two new circles still surface).
    await expect
      .poll(async () => circles.count(), { timeout: PAGE_TIMEOUT })
      .toBeGreaterThan(beforeCount);

    // The Records table also shows the new row by ageMonths value (24).
    await expect(page.locator("body")).toContainText(/24/);
    // Server returned a percentile pill (P{n}) for both weight and height
    // because both values fall in the WHO median-anchored band. The page
    // renders the percentile as e.g. "P50" / "P67".
    await expect(page.locator("body")).toContainText(/P\d{1,2}/);
  });

  test("Immunization schedule lists at least one due/overdue dose for a 2yo seeded patient (UIP MMR/DPT booster)", async ({
    doctorToken,
    adminApi,
    request,
  }) => {
    const child = await seedPediatricPatient(adminApi, { ageYears: 2 });

    // The /growth/patient/:id/immunization-compliance endpoint returns the
    // simplified Indian UIP schedule (growth.ts:325) with status =
    // GIVEN | OVERDUE | UPCOMING per vaccine. A freshly created 2-year-old
    // has zero given doses, so every milestone vaccine before 24 months
    // (BCG / OPV / Pentavalent / MR-1 / DPT-Booster-1 etc.) must come back
    // as OVERDUE.
    const compliance = await apiGet(
      request,
      doctorToken,
      `/growth/patient/${child.id}/immunization-compliance`
    );
    expect(compliance.status).toBe(200);
    const schedule: Array<{
      vaccine: string;
      dueMonths: number;
      status: string;
      dueDateApprox: string | null;
    }> = compliance.body?.data?.schedule ?? [];
    expect(
      schedule.length,
      "UIP schedule should populate for a DOB-bearing patient"
    ).toBeGreaterThan(0);

    const overdue = schedule.filter((s) => s.status === "OVERDUE");
    expect(
      overdue.length,
      "a 2yo with no recorded doses should have OVERDUE rows for early-life vaccines"
    ).toBeGreaterThan(0);

    // Anchor on a vaccine whose UIP due-month is <24 so we know it's
    // unambiguously OVERDUE for a 24-month-old:
    //   MR-1 / Measles-Rubella-1 is due at 9 months in growth.ts:341.
    const mrRow = schedule.find(
      (s) => /measles|mr-1/i.test(s.vaccine) && s.dueMonths <= 24
    );
    expect(
      mrRow,
      "MR-1 (Measles-Rubella, dueMonths=9) should appear in the schedule"
    ).toBeTruthy();
    expect(mrRow!.status).toBe("OVERDUE");

    // The cross-router /ehr/patients/:id/immunizations/recommended uses the
    // IAP variant (DPT, MMR 2, Hep A, Typhoid). We assert it surfaces too —
    // the patient detail page uses this for the "recommended" panel.
    const recommended = await apiGet(
      request,
      doctorToken,
      `/ehr/patients/${child.id}/immunizations/recommended`
    );
    expect(recommended.status).toBe(200);
    const items: Array<{ vaccine: string; status: string; dueDate: string }> =
      recommended.body?.data?.items ?? [];
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.status === "OVERDUE")).toBe(true);
  });

  test("Marking a vaccine ADMINISTERED persists and the row no longer surfaces as OVERDUE", async ({
    doctorToken,
    adminApi,
    request,
  }) => {
    const child = await seedPediatricPatient(adminApi, { ageYears: 2 });

    // Sanity: MR-1 is OVERDUE before we record a dose.
    const before = await apiGet(
      request,
      doctorToken,
      `/growth/patient/${child.id}/immunization-compliance`
    );
    expect(before.status).toBe(200);
    const mrBefore: { vaccine: string; status: string } | undefined = (
      before.body?.data?.schedule ?? []
    ).find((s: { vaccine: string }) => /measles-rubella-1|mr-1/i.test(s.vaccine));
    expect(mrBefore).toBeTruthy();
    expect(mrBefore!.status).toBe("OVERDUE");

    // Record the dose. The compliance endpoint matches by lower-cased
    // whitespace-stripped vaccine name (growth.ts:425) so we pass the exact
    // schedule label. nextDueDate exercises the booster computation path —
    // 28 days hence is a realistic re-vaccination interval that the
    // /immunizations/schedule filters then surface as "DUE_SOON".
    const dateGiven = new Date().toISOString().slice(0, 10);
    const nextDueDate = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const created = await apiPost(request, doctorToken, "/ehr/immunizations", {
      patientId: child.id,
      vaccine: "Measles-Rubella-1",
      doseNumber: 1,
      dateGiven,
      nextDueDate,
      site: "Left thigh",
      manufacturer: "Serum Institute of India",
      batchNumber: `E2E-${Date.now()}`,
      notes: "E2E pediatric immunization flow",
    });
    expect(created.status, "POST /ehr/immunizations should succeed").toBe(201);
    expect(created.body?.data?.id).toBeTruthy();

    // After persistence the compliance schedule must flip MR-1 to GIVEN.
    const after = await apiGet(
      request,
      doctorToken,
      `/growth/patient/${child.id}/immunization-compliance`
    );
    expect(after.status).toBe(200);
    const mrAfter: { vaccine: string; status: string } | undefined = (
      after.body?.data?.schedule ?? []
    ).find((s: { vaccine: string }) => /measles-rubella-1|mr-1/i.test(s.vaccine));
    expect(mrAfter, "MR-1 row should still be in the schedule").toBeTruthy();
    expect(
      mrAfter!.status,
      "MR-1 status should flip OVERDUE → GIVEN after recording the dose"
    ).toBe("GIVEN");

    // The /ehr/patients/:id/immunizations list should now include the new
    // row with our nextDueDate populated (the next-due computation path).
    const list = await apiGet(
      request,
      doctorToken,
      `/ehr/patients/${child.id}/immunizations`
    );
    expect(list.status).toBe(200);
    const rows: Array<{
      vaccine: string;
      dateGiven: string;
      nextDueDate: string | null;
    }> = list.body?.data ?? [];
    const recorded = rows.find((r) => /measles-rubella-1/i.test(r.vaccine));
    expect(recorded).toBeTruthy();
    expect(recorded!.nextDueDate).toBeTruthy();
    // The persisted nextDueDate must round-trip as the same calendar day we
    // sent. Compare the YYYY-MM-DD prefix to dodge UTC-offset jitter.
    expect(recorded!.nextDueDate!.slice(0, 10)).toBe(nextDueDate);
  });

  test("Growth chart returns a percentile band for a 24-month height/weight pair", async ({
    doctorToken,
    adminApi,
    request,
  }) => {
    const child = await seedPediatricPatient(adminApi, { ageYears: 2 });

    // Post a measurement squarely on the WHO median for a 24-month-old:
    // weight 12.2 kg and height 87.1 cm (growth.ts:42, 67). The server's
    // estimatePercentile() helper anchors the median at P50, so this pair
    // should come back at or near the 50th percentile.
    const post = await apiPost(request, doctorToken, "/growth", {
      patientId: child.id,
      measurementDate: new Date().toISOString().slice(0, 10),
      ageMonths: 24,
      weightKg: 12.2,
      heightCm: 87.1,
    });
    expect(post.status).toBe(201);
    const record: {
      weightPercentile: number | null;
      heightPercentile: number | null;
      bmi: number | null;
    } = post.body?.data ?? {};

    // Percentiles are clamped to [1, 99] and rounded — 50 is the bullseye
    // for the median, so we accept a generous ±15 band to absorb the
    // rounding + interpolation drift.
    expect(record.weightPercentile).not.toBeNull();
    expect(record.heightPercentile).not.toBeNull();
    expect(record.weightPercentile!).toBeGreaterThanOrEqual(35);
    expect(record.weightPercentile!).toBeLessThanOrEqual(65);
    expect(record.heightPercentile!).toBeGreaterThanOrEqual(35);
    expect(record.heightPercentile!).toBeLessThanOrEqual(65);
    // BMI = weight / height_m^2 = 12.2 / 0.871^2 ≈ 16.1
    expect(record.bmi).not.toBeNull();
    expect(record.bmi!).toBeGreaterThan(14);
    expect(record.bmi!).toBeLessThan(18);

    // Sanity: GET /growth/patient/:id/chart includes the same record in
    // the weight + height series the page consumes.
    const chart = await apiGet(
      request,
      doctorToken,
      `/growth/patient/${child.id}/chart`
    );
    expect(chart.status).toBe(200);
    const weight: Array<{ ageMonths: number }> =
      chart.body?.data?.weight ?? [];
    expect(weight.some((w) => w.ageMonths === 24)).toBe(true);
  });
});
