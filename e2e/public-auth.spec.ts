/**
 * Public / unauthenticated routes: /register + /forgot-password
 *
 * What this exercises:
 *   apps/web/src/app/register/page.tsx
 *   apps/web/src/app/forgot-password/page.tsx
 *   POST /api/v1/auth/register
 *   POST /api/v1/auth/forgot-password
 *
 * These routes are entirely unauthenticated (public attack surface). Every
 * test uses Playwright's default `page` fixture — no `adminPage`, no
 * `injectAuth`. No shared state between tests; each gets a fresh browser
 * context.
 *
 * Key findings captured here:
 *
 * 1. ANTI-ENUMERATION (forgot-password): The API returns an identical
 *    success response regardless of whether the email exists.
 *    The UI advances to the "reset" step in both cases, showing the same
 *    "A 6-digit code has been sent to <email>" message. This is CORRECT
 *    behaviour — no user-enumeration leak.
 *
 * 2. AUTH BOUNCE (/register, /forgot-password): Neither page redirects an
 *    already-authenticated user. A logged-in user who manually navigates to
 *    /register or /forgot-password sees the form, not a bounce to /dashboard.
 *    This is the current behaviour and is pinned here. If the product decides
 *    to add a redirect for authenticated users in the future, this test will
 *    surface the change.
 *
 * 3. STRONG-PASSWORD policy: The API enforces >= 8 chars + letter + digit +
 *    not-denylist via registerSchema/strongPassword in
 *    packages/shared/src/validation/auth.ts. The register page does its own
 *    lighter client-side check (>= 6 chars). A password that passes the
 *    client check but fails the server check (e.g. "abcdefgh" — 8 chars, no
 *    digit) will be caught server-side. The duplicate-email test uses the
 *    seeded `patient1@medcore.local` address so it requires no extra setup.
 *
 * Architecture note:
 *   The forgot-password flow is a multi-step form (email -> reset-code ->
 *   done). The E2E for the full "enter valid code + new password" happy path
 *   would require out-of-band code retrieval (email or DB query). That
 *   integration test is intentionally omitted here — the API route has unit
 *   coverage in the auth route tests. We test the UI behaviour up to the
 *   "code sent" confirmation, which is the observable surface.
 */
import { test, expect } from "@playwright/test";
import { API_BASE } from "./helpers";

// Generous timeout for public pages (they don't need auth but still need the
// Next.js dev server to render on first request).
const PAGE_TIMEOUT = 15_000;

// A strong password that satisfies the API's strongPassword rule:
//   >= 8 chars, >= 1 letter, >= 1 digit, not on the common-password denylist.
const STRONG_PASSWORD = "Medcore@E2e9!";

// A password that satisfies the page's own client-side minimum (>= 6 chars)
// but is rejected by the API (8 chars, all letters — no digit).
const WEAK_FOR_API = "abcdefgH";

// The seeded patient email — guaranteed to exist in a freshly seeded DB.
const SEEDED_PATIENT_EMAIL = "patient1@medcore.local";

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Generate a unique email unlikely to collide with any existing DB row.
 * Uses Date.now() + a random suffix so parallel runs don't collide.
 */
function uniqueEmail(): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `e2e-reg-${Date.now()}-${suffix}@medcore.local`;
}

function uniquePhone(): string {
  // 10-digit Indian-style number. Vary the last 7 digits.
  const tail = String(Math.floor(1_000_000 + Math.random() * 8_999_999));
  return `987${tail}`;
}

// ─── /register ────────────────────────────────────────────────────────────────

test.describe("/register — public registration", () => {
  test("page loads with the registration form for anonymous users", async ({
    page,
  }) => {
    await page.goto("/register");

    await expect(
      page.getByRole("form", { name: /registration form/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Required fields are present
    await expect(page.locator("#reg-name")).toBeVisible();
    await expect(page.locator("#reg-email")).toBeVisible();
    await expect(page.locator("#reg-phone")).toBeVisible();
    await expect(page.locator("#reg-password")).toBeVisible();
    await expect(page.locator("#reg-gender")).toBeVisible();

    // Optional fields
    await expect(page.locator("#reg-age")).toBeVisible();
    await expect(page.locator("#reg-address")).toBeVisible();

    // Link back to /login
    await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible();
  });

  test("happy path: valid registration redirects to /dashboard", async ({
    page,
  }) => {
    const email = uniqueEmail();

    await page.goto("/register");
    await expect(
      page.getByRole("form", { name: /registration form/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await page.locator("#reg-name").fill("Priya Sharma");
    await page.locator("#reg-email").fill(email);
    await page.locator("#reg-phone").fill(uniquePhone());
    await page.locator("#reg-password").fill(STRONG_PASSWORD);
    // Gender defaults to MALE; leave it. Age and address are optional.

    // Wait for the register API call + subsequent login + redirect.
    const [registerRes] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/auth/register") && r.request().method() === "POST",
        { timeout: 20_000 }
      ),
      page.getByRole("button", { name: /register|create account|sign up/i }).click(),
    ]);

    expect(registerRes.status()).toBe(201);

    // After auto-login the app pushes to /dashboard.
    await page.waitForURL(/\/dashboard/, { timeout: 20_000 });
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("validation: submitting all-empty required fields shows inline errors", async ({
    page,
  }) => {
    await page.goto("/register");
    await expect(
      page.getByRole("form", { name: /registration form/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Clear all fields and submit (they start empty on page load)
    await page.getByRole("button", { name: /register|create account|sign up/i }).click();

    // Inline error spans should appear (data-testid="error-{field}")
    await expect(page.getByTestId("error-name")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("error-email")).toBeVisible();
    await expect(page.getByTestId("error-phone")).toBeVisible();
    await expect(page.getByTestId("error-password")).toBeVisible();

    // Page must NOT navigate away
    await expect(page).toHaveURL(/\/register/);
  });

  test("validation: invalid email format shows inline error", async ({
    page,
  }) => {
    await page.goto("/register");
    await expect(
      page.getByRole("form", { name: /registration form/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await page.locator("#reg-name").fill("Test User");
    await page.locator("#reg-email").fill("not-an-email");
    await page.locator("#reg-phone").fill(uniquePhone());
    await page.locator("#reg-password").fill(STRONG_PASSWORD);

    await page.getByRole("button", { name: /register|create account|sign up/i }).click();

    await expect(page.getByTestId("error-email")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("error-email")).toContainText(
      /valid email/i
    );
    await expect(page).toHaveURL(/\/register/);
  });

  test("validation: short phone number shows inline error", async ({
    page,
  }) => {
    await page.goto("/register");
    await expect(
      page.getByRole("form", { name: /registration form/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await page.locator("#reg-name").fill("Test User");
    await page.locator("#reg-email").fill(uniqueEmail());
    await page.locator("#reg-phone").fill("123"); // too short
    await page.locator("#reg-password").fill(STRONG_PASSWORD);

    await page.getByRole("button", { name: /register|create account|sign up/i }).click();

    await expect(page.getByTestId("error-phone")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("error-phone")).toContainText(
      /valid.*phone|10.digit/i
    );
    await expect(page).toHaveURL(/\/register/);
  });

  test("validation: password shorter than 6 characters shows inline error", async ({
    page,
  }) => {
    await page.goto("/register");
    await expect(
      page.getByRole("form", { name: /registration form/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await page.locator("#reg-name").fill("Test User");
    await page.locator("#reg-email").fill(uniqueEmail());
    await page.locator("#reg-phone").fill(uniquePhone());
    await page.locator("#reg-password").fill("abc"); // < 6 chars — trips client guard

    await page.getByRole("button", { name: /register|create account|sign up/i }).click();

    await expect(page.getByTestId("error-password")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("error-password")).toContainText(
      /at least 6 characters/i
    );
    await expect(page).toHaveURL(/\/register/);
  });

  test("validation: invalid age (zero) shows inline error", async ({
    page,
  }) => {
    await page.goto("/register");
    await expect(
      page.getByRole("form", { name: /registration form/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await page.locator("#reg-name").fill("Test User");
    await page.locator("#reg-email").fill(uniqueEmail());
    await page.locator("#reg-phone").fill(uniquePhone());
    await page.locator("#reg-password").fill(STRONG_PASSWORD);
    await page.locator("#reg-age").fill("0"); // below the 1-150 range

    await page.getByRole("button", { name: /register|create account|sign up/i }).click();

    await expect(page.getByTestId("error-age")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("error-age")).toContainText(
      /valid age/i
    );
    await expect(page).toHaveURL(/\/register/);
  });

  test("duplicate email: server rejects with user-facing error and stays on /register", async ({
    page,
  }) => {
    // Uses the seeded patient account which always exists after `pnpm db:seed`.
    await page.goto("/register");
    await expect(
      page.getByRole("form", { name: /registration form/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await page.locator("#reg-name").fill("Duplicate User");
    await page.locator("#reg-email").fill(SEEDED_PATIENT_EMAIL);
    await page.locator("#reg-phone").fill(uniquePhone());
    await page.locator("#reg-password").fill(STRONG_PASSWORD);

    const [registerRes] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/auth/register") && r.request().method() === "POST",
        { timeout: 20_000 }
      ),
      page.getByRole("button", { name: /register|create account|sign up/i }).click(),
    ]);

    // API must return 409 Conflict for an already-registered email.
    expect(registerRes.status()).toBe(409);

    // The page renders an error alert (role="alert") — it must NOT navigate.
    const alert = page.getByRole("alert").first();
    await expect(alert).toBeVisible({ timeout: 8_000 });
    await expect(alert).toContainText(/already registered|already exist|email.*taken/i);
    await expect(page).toHaveURL(/\/register/);
  });

  test("server-side weak-password rejection shows user-facing error", async ({
    page,
  }) => {
    // WEAK_FOR_API passes the page's own >=6-char client guard but is rejected
    // by the API's strongPassword rule (>= 1 digit required, "abcdefgH" has none).
    await page.goto("/register");
    await expect(
      page.getByRole("form", { name: /registration form/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await page.locator("#reg-name").fill("Weak Pass User");
    await page.locator("#reg-email").fill(uniqueEmail());
    await page.locator("#reg-phone").fill(uniquePhone());
    await page.locator("#reg-password").fill(WEAK_FOR_API);

    const [registerRes] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/auth/register") && r.request().method() === "POST",
        { timeout: 20_000 }
      ),
      page.getByRole("button", { name: /register|create account|sign up/i }).click(),
    ]);

    // API returns 422 (validation error from strongPassword zod schema).
    expect([400, 422]).toContain(registerRes.status());

    // Either a field-level inline error or the global alert must appear.
    const errorVisible = await Promise.race([
      page.getByTestId("error-password").waitFor({ state: "visible", timeout: 8_000 }).then(() => true),
      page.getByRole("alert").first().waitFor({ state: "visible", timeout: 8_000 }).then(() => true),
    ]).catch(() => false);

    expect(errorVisible).toBe(true);
    await expect(page).toHaveURL(/\/register/);
  });

  test("auth bounce: authenticated user visiting /register sees the form (no redirect)", async ({
    browser,
  }) => {
    // SECURITY FINDING (pinned): /register does NOT redirect an already-
    // authenticated user to /dashboard. The page has no useEffect that checks
    // auth state. This test documents the current behaviour — it is a minor
    // UX issue (a logged-in user could accidentally re-register) but is not
    // a security vulnerability because the form would try to register a new
    // account, not expose any existing one. If a future PR adds an auth-bounce
    // redirect, this test will need updating.

    // Set up an authenticated context by injecting a known token into storage.
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();

    // Inject a plausible-looking token into localStorage. The register page
    // does not call /auth/me so even a dummy token is sufficient to confirm
    // there's no server-round-trip-based redirect. We use an empty string to
    // keep it clearly fake — if the page ever starts calling /auth/me and
    // redirecting on success, this test will still observe the behaviour.
    await pg.addInitScript(() => {
      localStorage.setItem("medcore_token", "fake-token-for-bounce-test");
      localStorage.setItem("medcore_refresh", "fake-refresh");
    });

    await pg.goto("/register");

    // The page must render the registration form, not redirect away.
    await expect(
      pg.getByRole("form", { name: /registration form/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Must still be on /register.
    await expect(pg).toHaveURL(/\/register/);

    await ctx.close();
  });
});

// ─── /forgot-password ─────────────────────────────────────────────────────────

test.describe("/forgot-password — password reset flow", () => {
  test("page loads the email-entry step for anonymous users", async ({
    page,
  }) => {
    await page.goto("/forgot-password");

    await expect(page.getByText(/reset your password/i).first()).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });

    // Email input and submit button present
    const emailInput = page.locator('input[type="email"]');
    await expect(emailInput).toBeVisible();
    await expect(
      page.getByRole("button", { name: /send reset code/i })
    ).toBeVisible();

    // Link back to /login
    await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible();
  });

  test("happy path (known email): form advances to code-entry step", async ({
    page,
  }) => {
    await page.goto("/forgot-password");
    await expect(page.locator('input[type="email"]')).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });

    await page.locator('input[type="email"]').fill(SEEDED_PATIENT_EMAIL);

    const [forgotRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/auth/forgot-password") &&
          r.request().method() === "POST",
        { timeout: 20_000 }
      ),
      page.getByRole("button", { name: /send reset code/i }).click(),
    ]);

    // API returns 200 (success — it never reveals whether the email exists)
    expect(forgotRes.status()).toBe(200);

    // UI advances to the "reset" step showing the 6-digit code input
    await expect(page.locator('input[placeholder="000000"]')).toBeVisible({
      timeout: 8_000,
    });

    // The confirmation message embeds the submitted email address (UX hint —
    // this is not a security leak because it's the email the user just typed).
    await expect(page.getByText(SEEDED_PATIENT_EMAIL)).toBeVisible();
    await expect(page.getByRole("button", { name: /reset password/i })).toBeVisible();
  });

  test("anti-enumeration: unknown email returns same success + advances to code step", async ({
    page,
  }) => {
    // SECURITY FINDING (anti-enumeration HOLDS): The API returns HTTP 200 with
    // the same "If that email exists, a reset code has been sent." message
    // regardless of whether the email is registered. The UI advances to the
    // code-entry step in both cases. An attacker cannot distinguish a known
    // from an unknown email by observing the HTTP response or the UI state.
    const unknownEmail = `nonexistent-${Date.now()}@nowhere.invalid`;

    await page.goto("/forgot-password");
    await expect(page.locator('input[type="email"]')).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });

    await page.locator('input[type="email"]').fill(unknownEmail);

    const [forgotRes] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes("/auth/forgot-password") &&
          r.request().method() === "POST",
        { timeout: 20_000 }
      ),
      page.getByRole("button", { name: /send reset code/i }).click(),
    ]);

    // Must return HTTP 200 — NOT a 404 or 400 that would reveal the email
    // does not exist. This is the anti-enumeration pin.
    expect(forgotRes.status()).toBe(200);

    // UI must advance to the "enter your code" step — same as for a known email.
    await expect(page.locator('input[placeholder="000000"]')).toBeVisible({
      timeout: 8_000,
    });

    // The confirmation text embeds the email (expected UX — not a leak)
    await expect(page.getByText(unknownEmail)).toBeVisible();

    // Must NOT show any error message that reveals the email doesn't exist.
    // We can't assert `getByRole("alert")` is invisible — Next.js injects a
    // hidden empty `<div role="alert" id="__next-route-announcer__">` on every
    // page for screen-reader route changes, so that selector always matches.
    // Instead, assert that none of the enumeration-revealing strings appear
    // anywhere on the page (the page's own error renderer is unstyled
    // text-in-a-div with no role="alert", so a content scan covers it).
    const enumerationLeakPatterns = [
      /no such (user|email|account)/i,
      /user not found/i,
      /account.*not.*(exist|found)/i,
      /email.*not.*(registered|exist|found)/i,
      /unknown email/i,
    ];
    for (const re of enumerationLeakPatterns) {
      await expect(page.locator("body")).not.toContainText(re);
    }
  });

  test("rate-limit: 429 from API renders user-friendly error, not raw message", async ({
    page,
  }) => {
    // Mock the API to simulate a 429 so this test doesn't depend on actually
    // triggering the rate limiter (which would pollute the test-run IP bucket).
    await page.route("**/auth/forgot-password", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ success: false, error: "Too Many Requests" }),
      })
    );

    await page.goto("/forgot-password");
    await expect(page.locator('input[type="email"]')).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });

    await page.locator('input[type="email"]').fill("anyone@example.com");
    await page.getByRole("button", { name: /send reset code/i }).click();

    // The page maps 429 to a user-friendly message (Issue #15 / authErrorMessage).
    // It must NOT render the raw backend "Too Many Requests" text directly.
    const errorDiv = page.locator(".text-danger, [class*='text-red']").first();
    await expect(errorDiv).toBeVisible({ timeout: 8_000 });
    await expect(errorDiv).toContainText(/too many attempts/i);

    // Page stays on the email step
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });

  test("code-entry step: reset button is disabled when code is shorter than 6 digits", async ({
    page,
  }) => {
    // Advance to the reset-code step by mocking the forgot-password API.
    await page.route("**/auth/forgot-password", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { message: "If that email exists, a reset code has been sent." },
        }),
      })
    );

    await page.goto("/forgot-password");
    await expect(page.locator('input[type="email"]')).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });

    await page.locator('input[type="email"]').fill("anyone@example.com");
    await page.getByRole("button", { name: /send reset code/i }).click();

    // Should advance to code-entry step
    await expect(page.locator('input[placeholder="000000"]')).toBeVisible({
      timeout: 8_000,
    });

    // Reset button must be disabled when code is empty
    const resetBtn = page.getByRole("button", { name: /reset password/i });
    await expect(resetBtn).toBeDisabled();

    // Fill 5 digits — still disabled
    await page.locator('input[placeholder="000000"]').fill("12345");
    await expect(resetBtn).toBeDisabled();

    // Fill all 6 digits — now enabled
    await page.locator('input[placeholder="000000"]').fill("123456");
    await expect(resetBtn).toBeEnabled();
  });

  test("code-entry step: 'Use a different email' returns to email-entry step", async ({
    page,
  }) => {
    await page.route("**/auth/forgot-password", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { message: "If that email exists, a reset code has been sent." },
        }),
      })
    );

    await page.goto("/forgot-password");
    await expect(page.locator('input[type="email"]')).toBeVisible({
      timeout: PAGE_TIMEOUT,
    });

    await page.locator('input[type="email"]').fill("anyone@example.com");
    await page.getByRole("button", { name: /send reset code/i }).click();

    await expect(page.locator('input[placeholder="000000"]')).toBeVisible({
      timeout: 8_000,
    });

    // Click "Use a different email" button — should revert to email step
    await page.getByRole("button", { name: /use a different email/i }).click();

    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('input[placeholder="000000"]')).not.toBeVisible();
  });

  test("auth bounce: authenticated user visiting /forgot-password sees the form (no redirect)", async ({
    browser,
  }) => {
    // Same pinned-behaviour finding as /register: the page has no auth-guard
    // redirect. A logged-in user sees the form uninterrupted. Documenting
    // this so future auth-bounce changes are visible in tests.
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();

    await pg.addInitScript(() => {
      localStorage.setItem("medcore_token", "fake-token-for-bounce-test");
      localStorage.setItem("medcore_refresh", "fake-refresh");
    });

    await pg.goto("/forgot-password");

    await expect(
      pg.getByText(/reset your password/i).first()
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await expect(pg.locator('input[type="email"]')).toBeVisible();
    await expect(pg).toHaveURL(/\/forgot-password/);

    await ctx.close();
  });
});
