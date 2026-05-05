/**
 * Internationalization (i18n) — language-switching + persistence + UI
 * re-translation contract for the authenticated dashboard layout.
 *
 * What this exercises:
 *   <LanguageDropdown /> in apps/web/src/components/LanguageDropdown.tsx
 *   useI18nStore + useTranslation in apps/web/src/lib/i18n.ts
 *   The dashboard layout's `mc-lang-sidebar` (desktop) and `mc-lang-mobile`
 *   instances injected at apps/web/src/app/dashboard/layout.tsx:866 and :931.
 *   Persistence path: localStorage["medcore_lang"] + <html lang="…"> +
 *   best-effort PATCH /api/v1/auth/me { preferredLanguage } (Issue #137).
 *
 * Surfaces touched:
 *   - PATIENT switches the sidebar dropdown to "hi" → the i18n store fires
 *     setLang(): localStorage updates, <html lang> reflects, sidebar nav
 *     labels re-render in Devanagari (the `hi` Dict in lib/i18n.ts has
 *     full coverage for `dashboard.nav.*`, `common.*`).
 *   - Persistence across reload: a fresh `page.reload()` re-hydrates the
 *     `hi` choice via the store's `init()` effect (LanguageDropdown.tsx:33).
 *   - Default language: a fresh PATIENT context (no medcore_lang in
 *     storage) lands on English.
 *
 * VERIFY-BEFORE-SCAFFOLD findings (E2E_COVERAGE_BACKLOG.md §4.13):
 *   The backlog framing names "Arabic" and "RTL" + "locale-specific
 *   date/time/number formatting" as gaps. Repo grep confirms NEITHER is
 *   shipped — `Lang = "en" | "hi"` is the entire union (lib/i18n.ts:5),
 *   zero matches for `documentElement.dir`, `dir="rtl"`, or `setAttribute
 *   ("dir"…)` anywhere under apps/web/src. Likewise every Intl.* /
 *   .toLocale*() call site is hard-coded to "en-IN" — see
 *   apps/web/src/lib/currency.ts:22, lib/appointments.ts:19,
 *   app/display/page.tsx:125, app/dashboard/admin-console/page.tsx:427 —
 *   none read from useTranslation().lang. So switching to Hindi does NOT
 *   change date or number formatting; only translation strings change.
 *   The cases below pin THAT real behaviour. RTL + locale-formatting
 *   coverage is deferred until those features actually ship; the deferral
 *   is also annotated against §4.13 in docs/E2E_COVERAGE_BACKLOG.md.
 *
 * Why these tests exist:
 *   §4.13 of the backlog called out "zero coverage" for i18n. Issue #137's
 *   in-dashboard language switcher is now load-bearing (every authed page
 *   carries it in the sidebar + mobile top bar) — a regression in the
 *   localStorage→store→DOM round-trip, the `hi` Dict, or the <html lang>
 *   side-effect would silently English-out every Hindi-speaking user
 *   without throwing. These tests pin the contract.
 */
import { test, expect } from "./fixtures";
import { gotoAuthed, expectNotForbidden } from "./helpers";

// CLAUDE.md gotcha #9: scope the LanguageDropdown via
// `select:has(option[value="<unique>"])` rather than `.first()` — the
// dashboard mounts TWO instances (sidebar + mobile top bar) AND the
// `<option value="hi">` pair (English/Hindi) is unique to this select.
const LANG_SELECT = 'select:has(option[value="hi"])';

test.describe("i18n — language switching + persistence + UI re-translation (PATIENT in /dashboard)", () => {
  test("PATIENT lands on /dashboard with default language en — <html lang='en'>, sidebar nav reads English, language-switcher select value='en'", async ({
    patientPage,
  }) => {
    const page = patientPage;
    // Defensive: ensure no stale medcore_lang from a previous test in the
    // shared context leaks into this assertion. The fixture pool reuses
    // contexts across tests so we can't rely on a "fresh" localStorage.
    await page.addInitScript(() => {
      try {
        localStorage.removeItem("medcore_lang");
      } catch {
        /* ignore */
      }
    });
    await gotoAuthed(page, "/dashboard");
    await expectNotForbidden(page);

    // <html lang> is the i18n store's primary side-effect (lib/i18n.ts:1407).
    // Default state of the store is "en"; init() only switches if a stored
    // value is present.
    await expect(page.locator("html")).toHaveAttribute("lang", "en", {
      timeout: 10_000,
    });

    // The visible select reflects the store value.
    const selector = page.locator(LANG_SELECT).first();
    await expect(selector).toBeVisible({ timeout: 10_000 });
    await expect(selector).toHaveValue("en");
  });

  test("PATIENT switches sidebar dropdown to hi — <html lang> flips to 'hi', localStorage['medcore_lang']='hi', sidebar nav re-renders in Devanagari", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await gotoAuthed(page, "/dashboard");
    await expectNotForbidden(page);

    // Stub the best-effort PATCH /auth/me so the test does not depend on
    // server availability for the local i18n store update (the component
    // explicitly tolerates a failed sync — LanguageDropdown.tsx:43-49).
    // We still want to assert the request was attempted.
    let preferredLanguageSent: string | null = null;
    await page.route("**/api/v1/auth/me", async (route) => {
      const req = route.request();
      if (req.method() === "PATCH") {
        try {
          const body = req.postDataJSON() as { preferredLanguage?: string };
          preferredLanguageSent = body?.preferredLanguage ?? null;
        } catch {
          /* tolerate non-JSON bodies — the assertion below is best-effort */
        }
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      }
      return route.fallback();
    });

    const selector = page.locator(LANG_SELECT).first();
    await expect(selector).toBeVisible({ timeout: 10_000 });
    await selector.selectOption("hi");

    // The i18n store synchronously updates <html lang> AND localStorage in
    // the same setLang() call (lib/i18n.ts:1402-1413). A short wait
    // accommodates React's commit phase before the DOM attribute mutates.
    await expect(page.locator("html")).toHaveAttribute("lang", "hi", {
      timeout: 5_000,
    });
    const stored = await page.evaluate(() =>
      localStorage.getItem("medcore_lang")
    );
    expect(stored).toBe("hi");

    // Sidebar nav text re-renders from the `hi` Dict (lib/i18n.ts:878 —
    // "dashboard.nav.dashboard" => "डैशबोर्ड"). Picking a high-frequency,
    // unambiguous Hindi string keeps the assertion stable even as more
    // nav items get added.
    const sidebar = page.locator('[data-testid="dashboard-sidebar"]');
    if (await sidebar.count()) {
      // Most accurate scope, when the sidebar wrapper exists.
      await expect(sidebar.first()).toContainText("डैशबोर्ड", {
        timeout: 10_000,
      });
    } else {
      // Fallback: anywhere on the page. The Devanagari nav strings only
      // exist if the `hi` Dict was actually pulled into the layout.
      await expect(page.locator("body")).toContainText("डैशबोर्ड", {
        timeout: 10_000,
      });
    }

    // Issue #137: persistToServer is set on the dashboard's mounted
    // instances, so the PATCH /auth/me { preferredLanguage } MUST fire.
    // We give the route handler a beat to record the request.
    await page.waitForTimeout(500);
    expect(preferredLanguageSent).toBe("hi");
  });

  test("Language choice survives a full page reload — i18n store init() reads localStorage and re-applies <html lang='hi'> + Hindi nav", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await gotoAuthed(page, "/dashboard");
    await expectNotForbidden(page);

    // Block the auth/me PATCH so the test isn't gated on it; the local
    // store update is what we're pinning.
    await page.route("**/api/v1/auth/me", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 200, body: '{"ok":true}' })
        : route.fallback()
    );

    const selector = page.locator(LANG_SELECT).first();
    await expect(selector).toBeVisible({ timeout: 10_000 });
    await selector.selectOption("hi");
    await expect(page.locator("html")).toHaveAttribute("lang", "hi", {
      timeout: 5_000,
    });

    // Reload — store init() should re-hydrate from localStorage.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expectNotForbidden(page);

    await expect(page.locator("html")).toHaveAttribute("lang", "hi", {
      timeout: 10_000,
    });
    const selectorAfter = page.locator(LANG_SELECT).first();
    await expect(selectorAfter).toBeVisible({ timeout: 10_000 });
    await expect(selectorAfter).toHaveValue("hi");

    // Reset for the next test in the suite (shared context — see
    // fixtures.ts patientPage). Switching back to en clears the leaked
    // state.
    await selectorAfter.selectOption("en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en", {
      timeout: 5_000,
    });
  });

  test("Switching back to English restores English nav text — round-trip integrity for the en/hi toggle", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await gotoAuthed(page, "/dashboard");
    await expectNotForbidden(page);
    await page.route("**/api/v1/auth/me", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 200, body: '{"ok":true}' })
        : route.fallback()
    );

    const selector = page.locator(LANG_SELECT).first();
    await expect(selector).toBeVisible({ timeout: 10_000 });

    // hi → en round-trip in one test so any leak between the two Dicts
    // (e.g., a missing key falling through `dict[key] ?? key`) is caught.
    await selector.selectOption("hi");
    await expect(page.locator("html")).toHaveAttribute("lang", "hi", {
      timeout: 5_000,
    });
    await expect(page.locator("body")).toContainText("डैशबोर्ड", {
      timeout: 10_000,
    });

    await selector.selectOption("en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en", {
      timeout: 5_000,
    });
    // English nav strings: "dashboard.nav.dashboard" => "Dashboard".
    // Use a regex to keep the assertion robust against surrounding
    // chrome (LanguageDropdown's own "English" option, etc.).
    await expect(page.locator("body")).toContainText(/Dashboard/i, {
      timeout: 10_000,
    });
  });

  test("LanguageDropdown does NOT toggle <html dir='rtl'> for hi — Hindi is LTR; RTL coverage is deferred until an RTL locale ships", async ({
    patientPage,
  }) => {
    const page = patientPage;
    await gotoAuthed(page, "/dashboard");
    await expectNotForbidden(page);
    await page.route("**/api/v1/auth/me", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 200, body: '{"ok":true}' })
        : route.fallback()
    );

    const selector = page.locator(LANG_SELECT).first();
    await expect(selector).toBeVisible({ timeout: 10_000 });
    await selector.selectOption("hi");
    await expect(page.locator("html")).toHaveAttribute("lang", "hi", {
      timeout: 5_000,
    });

    // <html dir> should remain unset OR "ltr" — the i18n store does NOT
    // touch dir (lib/i18n.ts:1402-1413 only writes lang). This pins the
    // current ship state so a future RTL toggle PR forces this test
    // updated alongside the source change.
    const dir = await page.evaluate(() =>
      document.documentElement.getAttribute("dir")
    );
    expect(dir === null || dir === "" || dir === "ltr").toBe(true);

    // Reset
    await selector.selectOption("en");
  });
});
