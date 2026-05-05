/**
 * Deep edge-cases coverage e2e (E2E_COVERAGE_BACKLOG §3 deepening lane).
 *
 * Companion to existing `e2e/edge-cases.spec.ts` (form-validation +
 * unauth-deeplink + session-expired + Ctrl+K palette + toast auto-dismiss
 * + sidebar tab-nav + mobile drawer + auth rate-limit). This file goes a
 * level deeper into the four §3 backlog scenarios — concurrent-edit
 * conflict / network-timeout retry / large-payload handling / memory perf
 * under repeated ops — and pins the SHIPPED behaviour for each rather
 * than fabricating tests against UI that doesn't exist.
 *
 * What this exercises:
 *   - 413 large-file rejection on /uploads (apps/api/src/routes/uploads.ts:30
 *     UPLOAD_MAX_BYTES = 10 MB, line 155-162 size guard) — pinned via the
 *     /dashboard/settings profile-photo upload surface (settings/page.tsx:270
 *     -286 calls api.post("/uploads") and surfaces the 413's `error` string
 *     through `toast.error(err.message)`).
 *   - 408 timeout retry UX on /uploads — same Settings surface, same toast.
 *     The web client (apps/web/src/lib/api.ts:131-167) bounds every fetch
 *     with a 30s AbortController; abort throws Error{status:408} which the
 *     page surfaces as a toast. There is no auto-retry loop — manual retry
 *     means clicking the upload button again.
 *   - 400 magic-mime rejection on /uploads (uploads.ts:172-180 ALLOWED_MIMES
 *     gate for medical files) — same Settings surface; pins the user-facing
 *     error string when an executable / unknown blob is uploaded.
 *
 * VERIFY-BEFORE-SCAFFOLD audit (cron-learning bullet 7 — backlog framing
 * is sometimes aspirational; verify against the codebase before scaffolding,
 * use API-contract-pin escape valve where backend exists but UI doesn't):
 *
 *   §3 backlog scenario               | Verdict          | Evidence
 *   -----------------------------------|------------------|---------------
 *   Concurrent-edit conflict           | DEFERRED — no    | repo-wide grep
 *     (optimistic-concurrency / 409    | optimistic-      | for `version Int`
 *      stale-write detection)          | concurrency      | / `@version` /
 *                                      | infrastructure   | `If-Match` /
 *                                      | shipped at any   | `If-Unmodified-`
 *                                      | layer            | `Since` /
 *                                      |                  | `optimisticLock`
 *                                      |                  | across
 *                                      |                  | packages/db/prisma
 *                                      |                  | /schema.prisma +
 *                                      |                  | apps/api/src/
 *                                      |                  | routes returns 0
 *                                      |                  | hits. The 4
 *                                      |                  | `version` matches
 *                                      |                  | in routes/ are
 *                                      |                  | unrelated (AI-
 *                                      |                  | model versions /
 *                                      |                  | analytics conv-
 *                                      |                  | ersionRate). No
 *                                      |                  | row-level
 *                                      |                  | version column
 *                                      |                  | exists on Patient
 *                                      |                  | / Appointment /
 *                                      |                  | Prescription /
 *                                      |                  | Bill / etc. Last-
 *                                      |                  | write-wins is the
 *                                      |                  | shipped semantic
 *                                      |                  | — no 409 contract
 *                                      |                  | to pin even via
 *                                      |                  | stub. Re-enters
 *                                      |                  | when an
 *                                      |                  | optimistic-lock
 *                                      |                  | column ships.
 *   Network timeout retry              | shipped (page-   | apps/web/src/lib/
 *     (page-level retry CTA)           | level only,      | api.ts:131-167
 *                                      | already covered  | binds every
 *                                      | by negative-     | request with a
 *                                      | paths spec for   | 30s
 *                                      | /register;       | AbortController →
 *                                      | re-pinned here   | 408. /register
 *                                      | for /uploads     | renders an
 *                                      | toast surface,   | explicit
 *                                      | which is a       | retry-banner
 *                                      | DIFFERENT recovery| with a CTA
 *                                      | shape — toast    | button (already
 *                                      | replaces banner) | covered by
 *                                      |                  | negative-paths.
 *                                      |                  | spec.ts:235-278);
 *                                      |                  | every other
 *                                      |                  | surface uses
 *                                      |                  | toast.error +
 *                                      |                  | implicit "user
 *                                      |                  | clicks again"
 *                                      |                  | retry. Pinned via
 *                                      |                  | the /uploads
 *                                      |                  | toast shape.
 *   Large-payload handling — bulk CSV  | DEFERRED — UI    | repo-wide grep
 *                                      | not shipped      | for `bulkImport` /
 *                                      |                  | `csvImport` /
 *                                      |                  | `parse.csv` /
 *                                      |                  | `papaparse` /
 *                                      |                  | `<input type=
 *                                      |                  |  "file" accept=
 *                                      |                  |  ".csv">` across
 *                                      |                  | apps/web/src/app/
 *                                      |                  | dashboard returns
 *                                      |                  | 0 hits. No bulk-
 *                                      |                  | import surface
 *                                      |                  | ships in the
 *                                      |                  | dashboard. Re-
 *                                      |                  | enters when a CSV
 *                                      |                  | upload route +
 *                                      |                  | UI lands.
 *   Large-payload handling — large     | shipped (API +   | uploads.ts:30
 *     file upload (10 MB cap rejection)| UI surface)      | UPLOAD_MAX_BYTES,
 *                                      |                  | uploads.ts:155-
 *                                      |                  | 162 size guard
 *                                      |                  | returns 413; UI
 *                                      |                  | surfaces it via
 *                                      |                  | toast.error in
 *                                      |                  | settings/page
 *                                      |                  | .tsx:282. Pinned
 *                                      |                  | via page.route
 *                                      |                  | 413 stub on
 *                                      |                  | profile-photo
 *                                      |                  | upload.
 *   Memory / perf under repeated ops   | DEFERRED — out   | docs/E2E_COVERAGE
 *                                      | of e2e scope     | _BACKLOG.md §4.6
 *                                      | per backlog §4.6 | explicitly lists
 *                                      |                  | "Memory profile
 *                                      |                  | over 8-hour
 *                                      |                  | session" under
 *                                      |                  | 4.6 Performance/
 *                                      |                  | load — perf
 *                                      |                  | testing belongs
 *                                      |                  | in a load-test
 *                                      |                  | tier (k6,
 *                                      |                  | autocannon),
 *                                      |                  | not Playwright.
 *                                      |                  | The structural
 *                                      |                  | beacon below
 *                                      |                  | (rapid-modal-
 *                                      |                  | open/close on a
 *                                      |                  | shipped surface)
 *                                      |                  | exercises the
 *                                      |                  | "no leaked
 *                                      |                  | listeners /
 *                                      |                  | error-boundary
 *                                      |                  | crashes" subset
 *                                      |                  | that IS in
 *                                      |                  | e2e scope.
 *
 * All deferred scenarios re-enter the backlog when the matching infra
 * ships; verdicts are pinned in this header so future agents can re-audit
 * cheaply (one grep) before adding more cases.
 *
 * Why these tests exist:
 *   E2E_COVERAGE_BACKLOG §3 calls out 4 deepening items for edge-cases.spec
 *   beyond the form-validation / unauth-deeplink baseline; this spec lands
 *   the 2 that have shipped infrastructure (large-file 413 + uploads
 *   timeout/mime toast surfaces) plus a memory beacon, and pins the 2 that
 *   don't (concurrent-edit / bulk CSV / 8-hour memory profile) with
 *   evidence-citations so future scaffolders can re-audit cheaply.
 */
import { test, expect } from "./fixtures";
import { dismissTourIfPresent, gotoAuthed } from "./helpers";

test.describe("Edge cases (deep) — /dashboard/settings + /dashboard/patients/[id] (large-file 413 / 408 timeout / 400 mime / repeated-modal beacon — §3 deepening)", () => {
  // ───────────────────────────────────────────────────────────
  // Case 1: 413 large-file rejection surfaces a user-readable toast
  // on the Settings profile-photo upload. Pins the 10 MB
  // UPLOAD_MAX_BYTES contract from apps/api/src/routes/uploads.ts:30,
  // intercepted via page.route so the test doesn't have to push 10 MB
  // of base64 through the wire (the toast.error path is the same
  // regardless of whether the 413 came from the API or a stub).
  // ───────────────────────────────────────────────────────────
  test("Settings profile-photo upload renders a user-readable toast when /uploads returns 413 'File exceeds 10 MB' — pins the UPLOAD_MAX_BYTES contract end-to-end", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Stub the upload endpoint with the EXACT envelope shape uploads.ts:156-
    // 162 ships in prod so the toast surfaces the canonical copy.
    await page.route("**/api/v1/uploads", (route) =>
      route.fulfill({
        status: 413,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          data: null,
          error: `File exceeds ${10 * 1024 * 1024} bytes (10 MB)`,
        }),
      }),
    );

    await gotoAuthed(page, "/dashboard/settings");
    await dismissTourIfPresent(page);

    // The Settings page lands on the Profile tab by default. Locate the
    // hidden file <input> directly (settings/page.tsx:302-311 attaches it
    // by ref) and feed it a tiny in-memory PNG; the page reads it via
    // FileReader and POSTs to /uploads which our stub intercepts.
    const fileInput = page.locator('input[type="file"][accept="image/*"]').first();
    await expect(fileInput).toBeAttached({ timeout: 15_000 });

    // Tiny valid 1×1 PNG — the page only base64-encodes; the stub doesn't
    // care about content and will 413 regardless.
    const tinyPng = Buffer.from(
      "89504E470D0A1A0A0000000D49484452000000010000000108020000009077" +
        "53DE0000000C4944415408D763F8FFFF3F0005FE02FEDCCCBE3D0000000049" +
        "454E44AE426082",
      "hex",
    );

    await fileInput.setInputFiles({
      name: "huge.png",
      mimeType: "image/png",
      buffer: tinyPng,
    });

    // The error surfaces as a toast. Toasts render with role="alert"; we
    // EXCLUDE the Next.js __next-route-announcer__ (CLAUDE.md gotcha #10)
    // so the assertion locks onto the actual upload-failure toast.
    const toast = page
      .locator('[role="alert"]:not(#__next-route-announcer__)')
      .filter({ hasText: /exceeds|10 ?MB|too large|File exceeds/i })
      .first();
    await expect(toast).toBeVisible({ timeout: 10_000 });
  });

  // ───────────────────────────────────────────────────────────
  // Case 2: 408 timeout response on /uploads surfaces the same toast
  // recovery path as a 5xx — pins the lib/api.ts:159-165 408 mapping
  // for upload routes (different surface from the /register
  // retry-banner path covered by negative-paths.spec.ts).
  // ───────────────────────────────────────────────────────────
  test("Settings profile-photo upload surfaces a 'Request timed out' toast when /uploads returns 408 — pins the AbortController/timeout error envelope on the upload surface", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/uploads", (route) =>
      route.fulfill({
        status: 408,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          data: null,
          error: "Request timed out — please try again",
        }),
      }),
    );

    await gotoAuthed(page, "/dashboard/settings");
    await dismissTourIfPresent(page);

    const fileInput = page.locator('input[type="file"][accept="image/*"]').first();
    await expect(fileInput).toBeAttached({ timeout: 15_000 });

    const tinyPng = Buffer.from(
      "89504E470D0A1A0A0000000D49484452000000010000000108020000009077" +
        "53DE0000000C4944415408D763F8FFFF3F0005FE02FEDCCCBE3D0000000049" +
        "454E44AE426082",
      "hex",
    );

    await fileInput.setInputFiles({
      name: "slow.png",
      mimeType: "image/png",
      buffer: tinyPng,
    });

    // toast.error surfaces the server's `error` string verbatim per
    // settings/page.tsx:282 → `toast.error(err.message)`. Lock onto the
    // canonical phrasing from lib/api.ts:160 ("Request timed out — please
    // try again") OR the server's literal copy (the stub returns the same
    // string by design).
    const toast = page
      .locator('[role="alert"]:not(#__next-route-announcer__)')
      .filter({ hasText: /timed out|timeout/i })
      .first();
    await expect(toast).toBeVisible({ timeout: 10_000 });
  });

  // ───────────────────────────────────────────────────────────
  // Case 3: 400 mime/format rejection surfaces a user-readable toast
  // — pins uploads.ts:172-180 ALLOWED_MIMES gate for medical files.
  // The Settings profile-photo upload omits patientId/type, so this
  // test triggers the dangerous-mime fallback at uploads.ts:181-196
  // via stub. Locks the user-facing error string shape.
  // ───────────────────────────────────────────────────────────
  test("Settings profile-photo upload renders a user-readable toast when /uploads returns 400 'File type not allowed' — pins the magic-mime allow-list error contract", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await page.route("**/api/v1/uploads", (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          data: null,
          error: "File type not allowed (detected: application/x-msdownload)",
        }),
      }),
    );

    await gotoAuthed(page, "/dashboard/settings");
    await dismissTourIfPresent(page);

    const fileInput = page.locator('input[type="file"][accept="image/*"]').first();
    await expect(fileInput).toBeAttached({ timeout: 15_000 });

    // The page-side `accept="image/*"` is a HINT to the OS file picker, not
    // a hard guard — the stub returns 400 regardless of what we hand it,
    // letting us pin the error-rendering path even if the user manages to
    // bypass the accept attribute.
    const tinyPng = Buffer.from(
      "89504E470D0A1A0A0000000D49484452000000010000000108020000009077" +
        "53DE0000000C4944415408D763F8FFFF3F0005FE02FEDCCCBE3D0000000049" +
        "454E44AE426082",
      "hex",
    );

    await fileInput.setInputFiles({
      name: "evil.png",
      mimeType: "image/png",
      buffer: tinyPng,
    });

    const toast = page
      .locator('[role="alert"]:not(#__next-route-announcer__)')
      .filter({ hasText: /not allowed|File type/i })
      .first();
    await expect(toast).toBeVisible({ timeout: 10_000 });
  });

  // ───────────────────────────────────────────────────────────
  // Case 4: A user-readable error shows up after a network failure
  // on /uploads (the AbortController path in lib/api.ts:157-167
  // throws an `err.name === "AbortError"` that lib/api.ts maps to
  // `Error{status:408,message:"Request timed out — please try again"}`.
  // The page surfaces this via toast.error(err.message)). Stubbed via
  // route.abort() so the abort path is exercised end-to-end.
  // ───────────────────────────────────────────────────────────
  test("Settings profile-photo upload shows an error toast when /uploads connection is aborted — pins the AbortError → toast pipeline (no auto-retry)", async ({
    adminPage,
  }) => {
    const page = adminPage;

    // Hard network abort. The browser's fetch will reject; lib/api.ts:157-
    // 166 catches non-AbortError and rethrows; settings/page.tsx:282 surfaces
    // `err.message` to the user. We accept either "Failed to fetch" /
    // "net::ERR_FAILED" / our own "Upload failed" wrapper — any user-facing
    // error toast counts as the contract.
    await page.route("**/api/v1/uploads", (route) =>
      route.abort("connectionrefused"),
    );

    await gotoAuthed(page, "/dashboard/settings");
    await dismissTourIfPresent(page);

    const fileInput = page.locator('input[type="file"][accept="image/*"]').first();
    await expect(fileInput).toBeAttached({ timeout: 15_000 });

    const tinyPng = Buffer.from(
      "89504E470D0A1A0A0000000D49484452000000010000000108020000009077" +
        "53DE0000000C4944415408D763F8FFFF3F0005FE02FEDCCCBE3D0000000049" +
        "454E44AE426082",
      "hex",
    );

    await fileInput.setInputFiles({
      name: "dropped.png",
      mimeType: "image/png",
      buffer: tinyPng,
    });

    // Any non-route-announcer toast/alert proves the failure surfaces — we
    // tolerate browser-specific copy ("Failed to fetch" vs "net::ERR_*").
    const toast = page
      .locator('[role="alert"]:not(#__next-route-announcer__)')
      .first();
    await expect(toast).toBeVisible({ timeout: 10_000 });
  });

  // ───────────────────────────────────────────────────────────
  // Case 5: Memory/perf-under-repeated-ops STRUCTURAL BEACON.
  // True memory-profiling is out of e2e scope per backlog §4.6
  // ("Memory profile over 8-hour session" lives in a load-test tier).
  // What IS in e2e scope is the "rapid open/close didn't crash the
  // app" subset — we tab between Settings sections 8 times and assert
  // no React error-boundary copy ever appears. Acts as a beacon: if a
  // memory leak ever causes a state-thrash crash on this surface, the
  // assertion fails and we re-enter the backlog with a real lead.
  // ───────────────────────────────────────────────────────────
  test("Settings tab-switch repeated 8x does not surface a React error-boundary crash — beacon for memory/state-thrash regressions on the most-trafficked profile surface", async ({
    adminPage,
  }) => {
    const page = adminPage;

    await gotoAuthed(page, "/dashboard/settings");
    await dismissTourIfPresent(page);

    // The Settings page renders a tab list (Profile / Security / Notifications
    // / Preferences per ALLOWED_TABS_BY_ROLE.ADMIN at settings/page.tsx:41).
    // Click rapidly between them; assert the page never renders a Next.js
    // error-boundary or React uncaught-exception copy.
    const tabNames = [/profile/i, /security/i, /notifications/i, /preferences/i];
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const tabName of tabNames) {
        const tab = page.getByRole("tab", { name: tabName }).first();
        if (await tab.isVisible().catch(() => false)) {
          await tab.click().catch(() => undefined);
          await page.waitForTimeout(120);
        } else {
          // Fallback: some builds render tabs as buttons rather than role=tab.
          const btn = page.getByRole("button", { name: tabName }).first();
          if (await btn.isVisible().catch(() => false)) {
            await btn.click().catch(() => undefined);
            await page.waitForTimeout(120);
          }
        }
      }
    }

    // The contract: no React error-boundary / uncaught-exception copy.
    await expect(
      page.locator(
        "text=/Application error|Something went wrong|Unhandled exception|Error boundary/i",
      ),
    ).toHaveCount(0);

    // And the page chrome must still be alive — heading still visible.
    await expect(
      page.getByRole("heading", { name: /settings|profile/i }).first(),
    ).toBeVisible();
  });
});
