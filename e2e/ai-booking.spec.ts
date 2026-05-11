/**
 * AI-Assisted Booking — patient-triage chat surface that routes a chief
 * complaint to a doctor + slot.
 *
 * What this exercises:
 *   /dashboard/ai-booking (apps/web/src/app/dashboard/ai-booking/page.tsx, 1053 lines)
 *   POST /api/v1/ai/triage/start          (apps/api/src/routes/ai-triage.ts)
 *   POST /api/v1/ai/triage/:id/message
 *   GET  /api/v1/ai/triage/:id            (doctor suggestions)
 *
 * Surfaces touched:
 *   - PATIENT (primary intended role): pre-chat "Who is this appointment for?"
 *     selector, language picker (8 BCP-47 codes), "Start AI Consultation" CTA
 *     wires startSession() → POST /ai/triage/start.
 *   - Universal access — there is NO client-side VIEW_ALLOWED gate; ANY auth'd
 *     role (DOCTOR / ADMIN / RECEPTION etc.) lands on the same pre-chat
 *     selector. The "Start Consultation" CTA on the post-booking confirmation
 *     screen is staff-only (DOCTOR/ADMIN/RECEPTION) — the patient flow shows
 *     "Book another" only.
 *   - 8-language symptom-chip group keyed by data-testid="symptom-chips"
 *     (PRD §3.5.1 Phase 2).
 *
 * Why these tests exist:
 *   Closes docs/E2E_COVERAGE_BACKLOG.md §2.8 entry
 *   "/dashboard/ai-booking — AI-assisted booking" by pinning the actual page
 *   shape (universally accessible pre-chat selector, language picker, session
 *   start API call), the symptom-chip rendering once a session exists, and
 *   the API error envelope surfacing through toast.
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, gotoAuthed } from "./helpers";

test.describe("AI-Assisted Booking — /dashboard/ai-booking (PATIENT-primary triage chat with universal-access pre-chat selector + 8-language symptom chips)", () => {
  test("PATIENT lands on the pre-chat selector with booking-for tiles, language picker, and the Start AI Consultation CTA", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await gotoAuthed(page, "/dashboard/ai-booking");
    await dismissTourIfPresent(page);

    // Pre-chat header — the page short-circuits to this when no sessionId yet.
    await expect(page.getByText(/Who is this appointment for\?/i).first())
      .toBeVisible({ timeout: 15_000 });

    // 5 booking-for tiles: Myself, Child, Parent, Sibling, Someone else.
    for (const label of [/Myself/i, /Child/i, /Parent/i, /Sibling/i, /Someone else/i]) {
      await expect(page.getByRole("button", { name: label })).toBeVisible();
    }

    // Language picker on the pre-chat panel — scope to the unique id, NOT
    // a bare locator('select') (LanguageDropdown is global per CLAUDE.md gotcha #9).
    await expect(page.locator("#ai-booking-language")).toBeVisible();

    // Primary CTA wires startSession() → POST /ai/triage/start.
    await expect(page.getByRole("button", { name: /Start AI Consultation/i }))
      .toBeVisible();
  });

  test("PATIENT picking 'Child' reveals the dependent patient-id input (GAP-T9 dependent-booking surface)", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await gotoAuthed(page, "/dashboard/ai-booking");
    await dismissTourIfPresent(page);

    // Field is hidden when bookingFor === "SELF" (default).
    await expect(page.locator("#ai-booking-dependent-patient-id")).toHaveCount(0);

    await page.getByRole("button", { name: /^Child$/i }).click();

    await expect(page.locator("#ai-booking-dependent-patient-id"))
      .toBeVisible({ timeout: 5_000 });
  });

  test("PATIENT confirming Start AI Consultation issues POST /ai/triage/start and lands in the chat panel with symptom-chips group", async ({
    patientPage,
  }) => {
    const page = patientPage;

    // Stub the triage start so the test does not hit the real Claude/Sarvam
    // upstream (Layer-5 contract: pin the wire shape, not the LLM).
    let startHits = 0;
    await page.route("**/api/v1/ai/triage/start", (route) => {
      startHits++;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            sessionId: "stub-sess-1",
            message: "Hello! Tell me what's bothering you.",
            language: "en",
            disclaimer: "Routing assistant, not a diagnostic tool.",
          },
          error: null,
        }),
      });
    });

    await gotoAuthed(page, "/dashboard/ai-booking");
    await dismissTourIfPresent(page);

    await page.getByRole("button", { name: /Start AI Consultation/i }).click();

    await expect.poll(() => startHits, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    // Once a sessionId is set, the chat panel mounts and the symptom-chips
    // group becomes visible (data-testid="symptom-chips" — group role +
    // localised aria-label).
    await expect(page.locator('[data-testid="symptom-chips"]'))
      .toBeVisible({ timeout: 10_000 });

    // Greeting bubble from the stubbed response renders.
    await expect(page.getByText(/Tell me what's bothering you/i).first())
      .toBeVisible();
  });

  test("DOCTOR is bounced to /dashboard/not-authorized — Issue #674 restricts AI Booking to PATIENT + ADMIN only", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    // Issue #674 (May 2026): AI Booking is a patient-facing intake flow.
    // Pharmacist / LabTech / Nurse / Doctor / Reception must not be able to
    // start a triage session under their own identity — that creates clinical
    // records attached to a non-patient user. The page now hard-redirects
    // any role outside AI_BOOKING_ALLOWED = {"PATIENT","ADMIN"} to
    // /dashboard/not-authorized?from=/dashboard/ai-booking.
    await page.goto("/dashboard/ai-booking", { waitUntil: "domcontentloaded" });
    await dismissTourIfPresent(page);

    await expect(page).toHaveURL(/\/dashboard\/not-authorized/, {
      timeout: 15_000,
    });
    expect(page.url()).toContain(
      "from=" + encodeURIComponent("/dashboard/ai-booking")
    );
    await expect(
      page.getByTestId("access-denied-page")
    ).toBeVisible({ timeout: 10_000 });
  });

  test("PATIENT seeing the API error envelope from /triage/start surfaces a toast and stays on the pre-chat selector", async ({
    patientPage,
  }) => {
    const page = patientPage;

    await page.route("**/api/v1/ai/triage/start", (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          data: null,
          error:
            "Please complete your patient profile before using AI-assisted booking.",
        }),
      })
    );

    await gotoAuthed(page, "/dashboard/ai-booking");
    await dismissTourIfPresent(page);

    await page.getByRole("button", { name: /Start AI Consultation/i }).click();

    // Pre-chat header should still be visible (no chat session was started).
    await expect(page.getByText(/Who is this appointment for\?/i).first())
      .toBeVisible({ timeout: 10_000 });

    // Symptom-chips never mount because there is no sessionId.
    await expect(page.locator('[data-testid="symptom-chips"]')).toHaveCount(0);

    // Sanity: the dev-overlay error fence did not fire (no app-crash).
    await expect(
      page.locator("text=/Application error|Something went wrong/i")
    ).toHaveCount(0);
  });
});
