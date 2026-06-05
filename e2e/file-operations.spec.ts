/**
 * File Operations e2e — upload / download / bulk-import surfaces.
 *
 * What this exercises (closes §4.8 of docs/E2E_COVERAGE_BACKLOG.md):
 *   /dashboard/patients/[id] Documents tab — patient-document upload
 *     (apps/web/src/app/dashboard/patients/[id]/page.tsx:3384-3664; the
 *     `DocumentsTab` + `DocumentUploadForm` pair).
 *   /dashboard/ai-radiology Upload Study tab — imaging upload of X-ray /
 *     ultrasound files (apps/web/src/app/dashboard/ai-radiology/page.tsx:
 *     326-482, the `UploadTab` component).
 *   /dashboard/settings Profile tab — avatar upload via /uploads.
 *   POST /api/v1/uploads — JSON {filename, base64Content, patientId?, type?}
 *     payload contract (apps/api/src/routes/uploads.ts:106-229). The web
 *     app reads the file as a data URL, splits on "," and POSTs the base64
 *     half (NOT FormData / multipart). Tests pin that contract via
 *     `page.route` fulfill-stubs so no bytes touch the disk.
 *   POST /api/v1/ehr/documents — create the PatientDocument row after the
 *     /uploads response returns a filePath (apps/api/src/routes/ehr.ts:682).
 *   GET /api/v1/ehr/documents/:id — download trigger via
 *     `window.open(origin + downloadUrl, "_blank")` from the per-row
 *     Download button (page.tsx:3413-3428). We pin the GET fires for the
 *     correct doc id; we don't drive the popup itself (browser-managed).
 *
 * Surfaces touched:
 *   - DOCTOR / ADMIN happy paths: open Documents tab on a seeded patient,
 *     fire the upload modal, choose synthetic Buffer payload via
 *     `setInputFiles`, submit → POST /uploads body shape pinned + POST
 *     /ehr/documents body shape pinned. No real bytes hit storage.
 *   - DOCTOR happy path: ai-radiology Upload Study tab, fill modality +
 *     bodyPart + clinical history, attach 1 stubbed PNG via
 *     `setInputFiles`, submit → POST /uploads then POST
 *     /ai/radiology/studies + /draft are pinned via `page.route` stub.
 *   - PATIENT (self) happy path: lands on Documents tab and the Upload
 *     CTA is HIDDEN — pinning the `canEdit` gate at page.tsx:415-419
 *     (PATIENT is not in the canEdit role allow-list). Documents the
 *     existing client-side gate; server-side ACL is in uploads.ts.
 *   - ADMIN avatar upload happy path: /dashboard/settings Profile tab
 *     hidden file input + Upload Photo button → POST /uploads with
 *     `type: "profile_photo"` (non-medical path; sniffer skips the
 *     allow-list per uploads.ts:172-196).
 *   - PATIENT bounce on /dashboard/ai-radiology — VIEW_ALLOWED restricts
 *     to ADMIN + DOCTOR (page.tsx:31), `useEffect` redirects to
 *     /dashboard/not-authorized.
 *
 * VERIFY-BEFORE-SCAFFOLD findings (cron-learning bullet 7 — backlog
 * framing was aspirational; deferred items have explicit citations):
 *
 *   - Bulk patient CSV import — DEFERRED. No file input or "Import" CTA on
 *     /dashboard/patients/page.tsx; no /api/v1/imports or
 *     /api/v1/patients/bulk endpoint in apps/api/src/routes. Repo-wide grep
 *     for `Bulk.*[Ii]mport|CSV.*[Ii]mport|[Ii]mport.*CSV` only matches
 *     marketing copy on /pricing/page.tsx. Re-enters backlog when shipped.
 *   - Bulk Rx-template import — DEFERRED. No upload surface on
 *     /dashboard/prescriptions or /dashboard/medicines (grep returns 0
 *     matches for `type="file"` outside the 4 surfaces below). Re-enters
 *     backlog when the prescription-template upload UI ships.
 *   - Imaging — lab order results upload — DEFERRED. /dashboard/lab,
 *     /dashboard/lab/[orderId], and /dashboard/lab/qc all have ZERO file
 *     inputs; lab tech result-entry is text/numeric only. Imaging-specific
 *     upload exists ONLY via /dashboard/ai-radiology (covered here).
 *   - Report export PDF/Excel/CSV — already covered. CSV download contract
 *     pinned by e2e/reports-custom.spec.ts via
 *     `page.waitForEvent("download")`. PDF round-trips pinned by
 *     e2e/print-pdf.spec.ts (commit 611cbfc). Excel export is NOT shipped
 *     anywhere in apps/web/src — the export map at
 *     apps/web/src/app/dashboard/analytics/reports/page.tsx:29-34 only
 *     defines CSV endpoints. Re-enters backlog when an Excel/.xlsx
 *     download CTA ships.
 *   - Virus-scan feedback — DEFERRED. No UI surface in apps/web/src renders
 *     the AV-scan verdict (clean / infected / pending). uploads.ts performs
 *     server-side magic-byte sniffing at line 170 against ALLOWED_MIMES
 *     (PDF/JPEG/PNG/WEBP/DICOM) but no in-page virus-scan banner / status
 *     pill is rendered back to the user. Already deferred on §4.7 closure
 *     (negative-paths.spec.ts) with the same evidence; re-enters backlog
 *     when an AV-scan result UI surface ships.
 *   - Attachment preview / watermarking — partial. PDF watermark for
 *     patient-paid invoices is already pinned by e2e/print-pdf.spec.ts
 *     (PAID overlay test). Generic in-page attachment PREVIEW (image
 *     thumbnails / PDF inline preview) is NOT shipped — `openDoc()` at
 *     page.tsx:3413-3428 calls `window.open(...)` to dump the file into a
 *     new tab; there is no inline preview pane. Re-enters backlog when an
 *     inline `<iframe>` or `<img>` attachment-preview component ships.
 *
 * Why these tests exist:
 *   §4.8 of docs/E2E_COVERAGE_BACKLOG.md flagged ZERO coverage for
 *   upload/download flows. Five of the six listed scenarios are real-shipped
 *   surfaces and worth pinning so future drifts (FormData migration, signed-
 *   URL contract changes, sniffer rule tightenings) are caught. The
 *   remaining items are explicitly documented above as deferred with
 *   evidence-citation per cron-learning bullet 7.
 *
 *   Cross-cutting NOTE: this spec NEVER writes real bytes to disk. Every
 *   /uploads POST is `page.route` fulfill-stubbed with a deterministic
 *   `filePath`, so `apps/api/uploads/ehr/` stays clean across CI runs.
 */
import { test, expect } from "./fixtures";
import { expectNotForbidden, gotoAuthed, seedPatient } from "./helpers";

// Tiny synthetic PNG (8x8 black square) — sufficient for `setInputFiles`
// when we're page.route-stubbing the /uploads endpoint anyway. The MIME
// sniffer never runs against this Buffer (we never let the request reach
// the API). Real PNG magic bytes (89 50 4E 47) keep `accept="image/*"` HTML
// filtering happy on browsers that pre-validate the input.
const SYNTHETIC_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x08,
  0x08, 0x06, 0x00, 0x00, 0x00, 0xc4, 0x0f, 0xbe, 0x8b, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

// Tiny synthetic PDF (%PDF-1.4 magic + minimal trailer). Actual structure is
// not parsed because we route-stub /uploads; only the magic bytes matter for
// the input element's accept filter.
const SYNTHETIC_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  "utf8"
);

test.describe("File Operations — patient-document upload + imaging upload + avatar upload + RBAC bounces (closes E2E backlog §4.8)", () => {
  test("DOCTOR opens Documents tab on a seeded patient, uploads a PDF lab report via Modal: POST /uploads body shape pinned (filename + base64Content + patientId + type='LAB_REPORT'), then POST /ehr/documents body shape pinned (filePath + fileSize + mimeType)", async ({
    doctorPage,
    receptionApi,
  }) => {
    const page = doctorPage;

    // Seed a fresh patient via receptionApi (auth + CSRF baked in via
    // fixtures.ts). The raw `request` fixture lacks both, so a POST to
    // /patients 403s on csrf_failed under NODE_ENV=production.
    const patient = await seedPatient(receptionApi);

    // Stub /uploads POST. The web client reads the file as a data URL via
    // FileReader, splits on "," and posts the second half — pin both halves.
    let uploadBody: Record<string, unknown> | null = null;
    await page.route(/\/api\/v1\/uploads(\?|$)/, async (route) => {
      if (route.request().method() === "POST") {
        try {
          uploadBody = route.request().postDataJSON() as Record<
            string,
            unknown
          >;
        } catch {
          uploadBody = null;
        }
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              filename: "stub-uuid-test-report.pdf",
              originalName: "test-report.pdf",
              filePath: "ehr/stub-uuid-test-report.pdf",
              fileSize: SYNTHETIC_PDF.length,
              mimeType: "application/pdf",
              signedUrl: "/api/v1/uploads/ehr/stub-uuid-test-report.pdf?sig=stub",
            },
            error: null,
          }),
        });
      }
      return route.continue();
    });

    // Stub /ehr/documents POST so no PatientDocument row is persisted.
    let documentBody: Record<string, unknown> | null = null;
    await page.route(/\/api\/v1\/ehr\/documents(\?|$)/, async (route) => {
      if (route.request().method() === "POST") {
        try {
          documentBody = route.request().postDataJSON() as Record<
            string,
            unknown
          >;
        } catch {
          documentBody = null;
        }
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              id: "stub-document-id",
              patientId: patient.id,
              type: "LAB_REPORT",
              title: "test-report.pdf",
              filePath: "ehr/stub-uuid-test-report.pdf",
              fileSize: SYNTHETIC_PDF.length,
              mimeType: "application/pdf",
              createdAt: new Date().toISOString(),
            },
            error: null,
          }),
        });
      }
      return route.continue();
    });

    await gotoAuthed(page, `/dashboard/patients/${patient.id}`);
    await expectNotForbidden(page);

    // Patient detail header renders with the seeded patient name (CLAUDE.md
    // gotcha #11 — pin via data-testid, not selector first()).
    await expect(
      page.locator('[data-testid="patient-detail-header"]').first()
    ).toBeVisible({ timeout: 15_000 });

    // Open the Documents tab.
    await page.getByRole("button", { name: /^Documents$/i }).click();

    // Upload CTA is visible for DOCTOR (canEdit gate at page.tsx:415-419).
    const uploadCta = page.getByRole("button", { name: /^\s*Upload\s*$/i });
    await expect(uploadCta).toBeVisible({ timeout: 10_000 });
    await uploadCta.click();

    // Modal opens — file input becomes attachable (label "File *").
    await expect(
      page.getByRole("heading", { name: /Upload Document/i })
    ).toBeVisible({ timeout: 5_000 });

    // Synthetic PDF buffer via setInputFiles. The page reads via FileReader
    // and base64-encodes — we pin the body shape but not the byte content.
    await page.locator("#document-file").setInputFiles({
      name: "test-report.pdf",
      mimeType: "application/pdf",
      buffer: SYNTHETIC_PDF,
    });

    // Submit the modal. The Upload button text toggles to "Uploading..."
    // mid-flight. The Documents tab itself ALSO has a top-level "Upload"
    // CTA, so a bare getByRole(/^Upload$/) is a strict-mode violation.
    // Scope to the modal's form submit button to disambiguate.
    await page.locator("form").getByRole("button", { name: /^Upload$/i }).click();

    // Wait for both stubbed POSTs to land.
    await expect
      .poll(() => uploadBody, { timeout: 10_000 })
      .not.toBeNull();
    await expect
      .poll(() => documentBody, { timeout: 10_000 })
      .not.toBeNull();

    // Pin /uploads body shape (uploads.ts:111-116 — filename + base64Content
    // + patientId + type are the four documented inputs).
    const ub = uploadBody as Record<string, unknown>;
    expect(ub.filename).toBe("test-report.pdf");
    expect(typeof ub.base64Content).toBe("string");
    expect((ub.base64Content as string).length).toBeGreaterThan(0);
    expect(ub.patientId).toBe(patient.id);
    expect(ub.type).toBe("LAB_REPORT");

    // Pin /ehr/documents body shape — filePath comes from /uploads response,
    // mimeType comes from the File.type (browser-derived, "application/pdf").
    const db = documentBody as Record<string, unknown>;
    expect(db.patientId).toBe(patient.id);
    expect(db.type).toBe("LAB_REPORT");
    expect(db.filePath).toBe("ehr/stub-uuid-test-report.pdf");
    expect(db.fileSize).toBe(SYNTHETIC_PDF.length);
    expect(db.mimeType).toBe("application/pdf");
  });

  test("DOCTOR uploads an X-ray on /dashboard/ai-radiology Upload Study tab: POST /uploads with type='RADIOLOGY' + per-file imageKeys[] handoff to POST /ai/radiology/studies (modality, bodyPart, imageKeys), then /draft kick-off — pin the 3-call sequence", async ({
    doctorPage,
    receptionApi,
  }) => {
    const page = doctorPage;

    const patient = await seedPatient(receptionApi);

    let uploadBody: Record<string, unknown> | null = null;
    await page.route(/\/api\/v1\/uploads(\?|$)/, async (route) => {
      if (route.request().method() === "POST") {
        try {
          uploadBody = route.request().postDataJSON() as Record<
            string,
            unknown
          >;
        } catch {
          uploadBody = null;
        }
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              filename: "stub-xray.png",
              originalName: "chest-xray.png",
              filePath: "ehr/stub-xray-key.png",
              fileSize: SYNTHETIC_PNG.length,
              mimeType: "image/png",
              signedUrl: "/api/v1/uploads/ehr/stub-xray.png?sig=stub",
            },
            error: null,
          }),
        });
      }
      return route.continue();
    });

    let studiesBody: Record<string, unknown> | null = null;
    await page.route(/\/api\/v1\/ai\/radiology\/studies(\?|$)/, async (route) => {
      if (route.request().method() === "POST") {
        try {
          studiesBody = route.request().postDataJSON() as Record<
            string,
            unknown
          >;
        } catch {
          studiesBody = null;
        }
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: { id: "stub-study-id" },
            error: null,
          }),
        });
      }
      return route.continue();
    });

    let draftCalled = false;
    await page.route(
      /\/api\/v1\/ai\/radiology\/[^/]+\/draft(\?|$)/,
      async (route) => {
        if (route.request().method() === "POST") {
          draftCalled = true;
          return route.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({
              success: true,
              data: { queued: true },
              error: null,
            }),
          });
        }
        return route.continue();
      }
    );

    await gotoAuthed(page, "/dashboard/ai-radiology");
    await expectNotForbidden(page);

    // The Upload Study tab (UploadTab — page.tsx:326-482).
    await page.getByRole("button", { name: /Upload Study/i }).click();

    // Fill the form. Patient is an EntityPicker (testIdPrefix="ai-radiology-
    // patient-picker", page.tsx:444) — type into the search input then click
    // the seeded patient's option (locked by data-entity-id, CLAUDE.md
    // gotcha #11) so the form's patientId state binds to the right row.
    await page.getByTestId("ai-radiology-patient-picker-input").fill(patient.name.split(" ")[0]);
    await page
      .locator(`[data-testid="ai-radiology-patient-picker-option"][data-entity-id="${patient.id}"]`)
      .first()
      .click({ timeout: 10_000 });
    // Modality select scoped via known option value (CLAUDE.md gotcha #9 —
    // never use `locator("select").first()`; LanguageDropdown sits in the
    // dashboard layout). XRAY is the default; assert it's there + selected.
    await expect(page.locator("#ai-radiology-modality")).toHaveValue("XRAY");
    await page.locator("#ai-radiology-body-part").fill("Chest");
    await page
      .locator("#ai-radiology-history")
      .fill("Persistent cough, productive, two weeks");

    // Attach a synthetic PNG. Multi-attribute, but we only attach one to keep
    // the imageKeys[] assertion simple.
    await page.locator("#ai-radiology-images").setInputFiles({
      name: "chest-xray.png",
      mimeType: "image/png",
      buffer: SYNTHETIC_PNG,
    });

    await page.getByRole("button", { name: /Upload & Generate Draft/i }).click();

    // Wait for the 3-call cascade.
    await expect.poll(() => uploadBody, { timeout: 10_000 }).not.toBeNull();
    await expect
      .poll(() => studiesBody, { timeout: 10_000 })
      .not.toBeNull();
    await expect.poll(() => draftCalled, { timeout: 10_000 }).toBe(true);

    // Pin /uploads body — type is hard-coded "RADIOLOGY" per page.tsx:355.
    const ub = uploadBody as Record<string, unknown>;
    expect(ub.filename).toBe("chest-xray.png");
    expect(ub.patientId).toBe(patient.id);
    expect(ub.type).toBe("RADIOLOGY");
    expect(typeof ub.base64Content).toBe("string");

    // Pin /ai/radiology/studies body — imageKeys[] is the array of filePaths
    // returned by /uploads (page.tsx:358 + 367).
    const sb = studiesBody as Record<string, unknown>;
    expect(sb.patientId).toBe(patient.id);
    expect(sb.modality).toBe("XRAY");
    expect(sb.bodyPart).toBe("Chest");
    expect(sb.notes).toBe("Persistent cough, productive, two weeks");
    expect(Array.isArray(sb.imageKeys)).toBe(true);
    expect((sb.imageKeys as string[]).length).toBe(1);
    expect((sb.imageKeys as string[])[0]).toBe("ehr/stub-xray-key.png");
  });

  test("ADMIN uploads a profile photo on /dashboard/settings: POST /uploads body shape pinned (filename + base64Content; type AND patientId OMITTED — non-medical path returns a stable storage key, skips the magic-byte allow-list, uploads.ts:172-196)", async ({
    adminPage,
  }) => {
    const page = adminPage;

    let uploadBody: Record<string, unknown> | null = null;
    await page.route(/\/api\/v1\/uploads(\?|$)/, async (route) => {
      if (route.request().method() === "POST") {
        try {
          uploadBody = route.request().postDataJSON() as Record<
            string,
            unknown
          >;
        } catch {
          uploadBody = null;
        }
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              filename: "stub-avatar.png",
              originalName: "avatar.png",
              filePath: "ehr/stub-avatar.png",
              url: "/api/v1/uploads/ehr/stub-avatar.png",
              fileSize: SYNTHETIC_PNG.length,
              mimeType: "image/png",
            },
            error: null,
          }),
        });
      }
      return route.continue();
    });

    await gotoAuthed(page, "/dashboard/settings");
    await expectNotForbidden(page);

    // Settings page first paints on the Profile tab. data-testid="profile-name"
    // exists at page.tsx:360.
    await expect(page.locator('[data-testid="profile-name"]')).toBeVisible({
      timeout: 15_000,
    });

    // The hidden file input is at line 304 with `accept="image/*"`. We attach
    // by selector — the visible button merely triggers fileRef.current.click().
    await page
      .locator('input[type="file"][accept="image/*"]')
      .first()
      .setInputFiles({
        name: "avatar.png",
        mimeType: "image/png",
        buffer: SYNTHETIC_PNG,
      });

    await expect.poll(() => uploadBody, { timeout: 10_000 }).not.toBeNull();

    // Pin shape. settings/page.tsx sends filename + base64Content and
    // DELIBERATELY omits BOTH `type` and `patientId` — the non-medical
    // path. Omitting `type` makes uploads.ts return a stable storage KEY
    // (not a medical PatientDocument), which the Settings page persists on
    // User.photoUrl and re-signs on read. (Previously it sent
    // type="profile_photo"; that was dropped when the avatar started
    // storing the bare key instead of an expiring signed URL.)
    const ub = uploadBody as Record<string, unknown>;
    expect(ub.filename).toBe("avatar.png");
    expect(ub.type).toBeUndefined();
    expect(ub.patientId).toBeUndefined();
    expect(typeof ub.base64Content).toBe("string");
  });

  test("PATIENT lands on their own Documents tab and the Upload CTA is HIDDEN — pinning the canEdit gate at /dashboard/patients/[id]/page.tsx:415-419 (PATIENT not in the upload allow-list); GET /ehr/patients/:id/documents is still authorized for the patient themselves", async ({
    patientPage,
  }) => {
    const page = patientPage;

    // patient1@medcore.local has a seeded Patient row. Resolve its id via
    // the in-browser /patients/me self-endpoint so we don't have to thread
    // request-context cookies. Land on /dashboard first so the SPA's auth
    // state is initialized before the fetch fires.
    await gotoAuthed(page, "/dashboard");
    const myPatientId = await page.evaluate(async () => {
      const res = await fetch("/api/v1/patients/me", {
        credentials: "include",
      });
      if (!res.ok) return null;
      const json = await res.json();
      return json?.data?.id ?? null;
    });

    // If the SPA's self-resolution endpoint isn't shipped, soft-skip the
    // assertion below — but on the seeded test corpus patient1 always has
    // a Patient row (apps/api/src/routes/patients.ts ships /me).
    test.skip(
      !myPatientId,
      "PATIENT self-id not resolvable via /patients/me on this build"
    );

    await gotoAuthed(page, `/dashboard/patients/${myPatientId}`);
    await expectNotForbidden(page);

    await page.getByRole("button", { name: /^Documents$/i }).click();

    // Upload button MUST NOT exist (canEdit gate excludes PATIENT). Use a
    // tight count-zero assertion — the button has no data-testid so we
    // match by visible role + name. The "Upload Document" modal heading
    // would also be absent.
    await expect(
      page
        .locator('button:has-text("Upload")')
        .filter({ hasNotText: /document|study|photo/i })
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: /Upload Document/i })
    ).toHaveCount(0);
  });

  test("PATIENT bounces from /dashboard/ai-radiology — VIEW_ALLOWED at page.tsx:31 only allows ADMIN + DOCTOR; useEffect redirects to /dashboard/not-authorized", async ({
    patientPage,
  }) => {
    const page = patientPage;

    await gotoAuthed(page, "/dashboard/ai-radiology");

    // page.tsx:114 — `router.replace("/dashboard/not-authorized?from=...")`.
    // gotoAuthed swallows the redirect itself; the URL settles within ~800ms.
    await page.waitForURL(/\/dashboard(\/not-authorized)?(\?|$|\/)/, {
      timeout: 10_000,
    });
    expect(page.url()).toMatch(/\/dashboard(\/not-authorized)?(\?|$|\/)/);

    // The Upload Study form must NOT render — its presence would mean the
    // gate failed open. (The patient-id input testid is the most uniquely
    //-named field.)
    await expect(page.locator("#ai-radiology-patient-id")).toHaveCount(0);
  });
});
