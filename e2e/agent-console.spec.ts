/**
 * Agent Console — RECEPTION/ADMIN three-pane workstation for AI-Triage handoffs.
 *
 * What this exercises:
 *   /dashboard/agent-console (apps/web/src/app/dashboard/agent-console/page.tsx, 735 lines)
 *   GET   /api/v1/agent-console/handoffs            (list pending handoffs)
 *   GET   /api/v1/agent-console/handoffs/:id/context (transcript + SOAP + topDoctors)
 *   GET   /api/v1/chat/rooms/:id/messages           (middle pane)
 *   POST  /api/v1/agent-console/handoffs/:id/suggest-doctor
 *
 * Surfaces touched:
 *   - ADMIN/RECEPTION: lands on the page, sees title + Active-Handoffs list
 *     pane + middle "select a handoff" empty hint + AI Triage co-pilot pane.
 *   - ADMIN with a stubbed handoff in the list: clicks the handoff button →
 *     middle pane mounts the composer (data-testid="agent-console-composer")
 *     and right pane mounts the transcript section
 *     (data-testid="agent-console-transcript") with the SOAP block + the
 *     "Suggest this doctor" CTA (data-testid="suggest-doctor-<doctorId>").
 *   - PATIENT/DOCTOR/NURSE: page.tsx:144-155 fires `router.replace("/dashboard")`
 *     via useEffect AND page.tsx:378-387 renders an inline yellow "Agent
 *     Console is only available to reception and admin staff" placeholder
 *     before the redirect lands. This is the REDIRECT-BOUNCE archetype with
 *     an inline brief-flash placeholder — NOT the pure admin-gate-placeholder
 *     archetype that ai-kpis + ai-fraud use (those have NO router.replace,
 *     so the placeholder stays mounted indefinitely). We assert the URL has
 *     bounced to /dashboard rather than the placeholder text — the URL is
 *     the deterministic signal here.
 *
 * Why these tests exist:
 *   Closes docs/E2E_COVERAGE_BACKLOG.md §2.8 entry
 *   "/dashboard/agent-console — AI agent monitoring" by pinning the actual
 *   page shape: three-pane workstation (left handoff list / middle thread /
 *   right co-pilot), the empty "Pick a handoff" prompt when nothing is
 *   selected, the composer + transcript mount on selection, the suggest-
 *   doctor CTA wiring, and the REDIRECT-BOUNCE for non-RECEPTION/ADMIN.
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, gotoAuthed } from "./helpers";

function handoffFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    chatRoomId: "room-handoff-1",
    sessionId: "sess-handoff-1",
    roomName: "Triage handoff — Aarav",
    patient: { id: "pat-1", name: "Aarav Iyer", mrNumber: "MR-00042" },
    presentingComplaint: "Chest tightness for 2 days",
    language: "en",
    confidence: 0.78,
    handoffAt: "2026-05-05T09:00:00.000Z",
    lastActivityAt: "2026-05-05T09:05:00.000Z",
    unreadCount: 2,
    lastMessage: {
      id: "msg-last-1",
      content: "I would like to talk to a person, please.",
      createdAt: "2026-05-05T09:05:00.000Z",
      senderName: "Aarav Iyer",
    },
    ...overrides,
  };
}

function contextFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionId: "sess-handoff-1",
    chatRoomId: "room-handoff-1",
    language: "en",
    status: "HANDOFF_PENDING",
    redFlagDetected: false,
    redFlagReason: null,
    patient: {
      id: "pat-1",
      mrNumber: "MR-00042",
      name: "Aarav Iyer",
      phone: "+91 9000000000",
      dateOfBirth: "1990-01-01",
      gender: "MALE",
    },
    transcript: [
      { role: "user", content: "I have chest tightness." },
      { role: "assistant", content: "How long has this been going on?" },
      { role: "user", content: "About two days." },
    ],
    soap: {
      subjective: {
        chiefComplaint: "Chest tightness",
        onset: "2 days ago",
        duration: "2 days",
        severity: 6,
        associatedSymptoms: ["mild shortness of breath"],
        relevantHistory: null,
      },
      assessment: {
        suggestedSpecialties: [
          { specialty: "Cardiology", reasoning: "chest symptoms", confidence: 0.7 },
        ],
        confidence: 0.7,
      },
    },
    topDoctors: [
      {
        doctorId: "doc-1",
        name: "Dr. Priya Sharma",
        specialty: "Cardiology",
        subSpecialty: "Interventional",
        qualification: "MD, DM",
        experienceYears: 12,
        consultationFee: 800,
        reasoning: "Best match for chest tightness presentation.",
      },
    ],
    ...overrides,
  };
}

test.describe("Agent Console — /dashboard/agent-console (RECEPTION/ADMIN three-pane handoff workstation + REDIRECT-BOUNCE for non-allowed roles)", () => {
  test("ADMIN lands on the page chrome with header, Active-Handoffs list pane, empty middle 'pick a handoff' prompt and the AI co-pilot pane", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/agent-console/handoffs**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );

    await gotoAuthed(page, "/dashboard/agent-console");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /Agent Console/i })
    ).toBeVisible({ timeout: 15_000 });

    // Three-pane chrome — left list + middle thread + right co-pilot all
    // mount; the aria-labels are the most stable selector here since the
    // page does not stamp data-testids on the pane wrappers.
    await expect(
      page.getByRole("complementary", { name: /Active handoffs/i })
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: /Chat thread/i })
    ).toBeVisible();
    await expect(
      page.getByRole("complementary", { name: /AI Triage co-pilot/i })
    ).toBeVisible();

    // Middle + right both show the "Pick a handoff on the left to start"
    // empty hint when no row is selected — the same i18n string renders in
    // both panes, so the count is 2.
    await expect(
      page.getByText(/Pick a handoff on the left to start/i)
    ).toHaveCount(2);
  });

  test("ADMIN with a stubbed handoff sees the row in the list, clicking it mounts the composer + transcript + Suggest-this-doctor CTA", async ({
    adminPage,
  }) => {
    const page = adminPage;

    const handoff = handoffFixture();
    const ctx = contextFixture();

    await page.route("**/api/v1/agent-console/handoffs**", (route) => {
      const url = route.request().url();
      if (/\/handoffs\/[^/]+\/context/.test(url)) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: ctx, error: null }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [handoff], error: null }),
      });
    });
    await page.route("**/api/v1/chat/rooms/*/messages**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    await page.route("**/api/v1/chat/rooms/*/read", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: null, error: null }),
      })
    );

    await gotoAuthed(page, "/dashboard/agent-console");
    await dismissTourIfPresent(page);

    // Row in the left list — the patient name renders in a button truncate.
    const row = page.getByRole("button", { name: /Aarav Iyer/i });
    await expect(row).toBeVisible({ timeout: 15_000 });

    await row.click();

    // Middle pane: composer mounts (data-testid is real on page.tsx:550).
    await expect(
      page.locator('[data-testid="agent-console-composer"]')
    ).toBeVisible({ timeout: 10_000 });

    // Right pane: transcript section mounts (data-testid on page.tsx:598)
    // along with the per-doctor Suggest CTA (page.tsx:715).
    await expect(
      page.locator('[data-testid="agent-console-transcript"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="suggest-doctor-doc-1"]')
    ).toBeVisible();
  });

  test("ADMIN clicking 'Suggest this doctor' fires POST /agent-console/handoffs/:id/suggest-doctor and pre-fills the composer with the templated text", async ({
    adminPage,
  }) => {
    const page = adminPage;

    const handoff = handoffFixture();
    const ctx = contextFixture();

    await page.route("**/api/v1/agent-console/handoffs**", (route) => {
      const url = route.request().url();
      if (/\/handoffs\/[^/]+\/context/.test(url)) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: ctx, error: null }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [handoff], error: null }),
      });
    });
    await page.route("**/api/v1/chat/rooms/*/messages**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );
    await page.route("**/api/v1/chat/rooms/*/read", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: null, error: null }),
      })
    );

    let suggestHits = 0;
    await page.route(
      "**/api/v1/agent-console/handoffs/*/suggest-doctor",
      (route) => {
        suggestHits++;
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: null, error: null }),
        });
      }
    );

    await gotoAuthed(page, "/dashboard/agent-console");
    await dismissTourIfPresent(page);

    await page.getByRole("button", { name: /Aarav Iyer/i }).click();

    const suggestBtn = page.locator('[data-testid="suggest-doctor-doc-1"]');
    await expect(suggestBtn).toBeVisible({ timeout: 10_000 });
    await suggestBtn.click();

    // Templated text lands in the composer (page.tsx:270-278). The doctor's
    // name renders WITH a "Dr." prefix per formatDoctorName().
    const composer = page.locator('[data-testid="agent-console-composer"]');
    await expect(composer).toHaveValue(/Suggested doctor:.*Priya Sharma/i, {
      timeout: 5_000,
    });
    await expect(composer).toHaveValue(/Specialty: Cardiology/i);

    await expect
      .poll(() => suggestHits, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
  });

  test("RECEPTION reaches the same chrome — confirms the page is allowed for both RECEPTION and ADMIN (router.use(authorize(RECEPTION,ADMIN)) at agent-console.ts:29)", async ({
    receptionPage,
  }) => {
    const page = receptionPage;

    await page.route("**/api/v1/agent-console/handoffs**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );

    await gotoAuthed(page, "/dashboard/agent-console");
    await dismissTourIfPresent(page);

    await expect(
      page.getByRole("heading", { name: /Agent Console/i })
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(/No active handoffs right now/i)
    ).toBeVisible();
  });

  test("PATIENT visiting /dashboard/agent-console gets bounced via router.replace('/dashboard') — REDIRECT-BOUNCE archetype, page.tsx:144-155 useEffect", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await page.goto("/dashboard/agent-console", { waitUntil: "domcontentloaded" });

    // Allow the role-guard useEffect to fire (line 144 → router.replace).
    await page.waitForTimeout(1500);

    // The URL settles on /dashboard (not /dashboard/agent-console). Accept a
    // trailing slash or an empty hash; the matcher rejects the original URL.
    await expect(page).toHaveURL(/\/dashboard(\/?$|\?|\/(?!agent-console))/, {
      timeout: 10_000,
    });

    // The Active-Handoffs pane never mounts on this branch.
    await expect(
      page.getByRole("complementary", { name: /Active handoffs/i })
    ).toHaveCount(0);
  });

  test("DOCTOR is also outside the RECEPTION/ADMIN allow-set and hits the same redirect-bounce", async ({
    doctorPage,
  }) => {
    const page = doctorPage;
    await page.goto("/dashboard/agent-console", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    await expect(page).toHaveURL(/\/dashboard(\/?$|\?|\/(?!agent-console))/, {
      timeout: 10_000,
    });
    await expect(
      page.getByRole("complementary", { name: /AI Triage co-pilot/i })
    ).toHaveCount(0);
  });

  test("ADMIN with empty handoffs list sees 'No active handoffs right now' empty-state copy in the left pane", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/agent-console/handoffs**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [], error: null }),
      })
    );

    await gotoAuthed(page, "/dashboard/agent-console");
    await dismissTourIfPresent(page);

    await expect(
      page.getByText(/No active handoffs right now/i)
    ).toBeVisible({ timeout: 15_000 });
    // The 0-count badge renders in the header — "(0)" appears next to the
    // "Active handoffs" label per page.tsx:428-430.
    await expect(page.getByText(/Active handoffs.*\(0\)/i)).toBeVisible();
  });
});
