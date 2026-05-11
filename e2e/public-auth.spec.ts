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
import { test, expect, type Page } from "@playwright/test";
import { API_BASE } from "./helpers";

// Generous timeout for public pages (they don't need auth but still need the
// Next.js dev server to render on first request).
const PAGE_TIMEOUT = 15_000;

// A strong password that satisfies the API's strongPassword rule:
//   >= 8 chars, >= 1 letter, >= 1 digit, not on the common-password denylist.
const STRONG_PASSWORD = "Medcore@E2e9!";

// A password that satisfies the page's own client-side floor (>= 12 chars,
// >= 1 letter, >= 1 digit) but is rejected by the API. We can't use a
// "no-digit" or "<12" password anymore — those trip the client guard so the
// submit never fires. Instead we pick a denylisted entry: `password1234` is
// 12 chars with letter+digit (passes client) but is on the curated top-100
// common-password denylist (fails server `strongPassword`).
const WEAK_FOR_API = "password1234";

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

/**
 * Fill all required register form fields with valid data so the client
 * validateClient() doesn't block the submit. Each test can override
 * specific fields by passing an `overrides` object, then fill its OWN bad
 * field over the top with `page.locator(...).fill(badValue)` afterwards.
 *
 * Required by the post-#713/#684/#706/#617 form: name, email, phone,
 * password (>=12), confirm-password (matching), gender (no default), DOB,
 * address (>=5 chars), emergency-contact triplet (name + phone + rel),
 * and the T&C / Privacy Policy checkbox.
 *
 * Note on a few specific fields:
 *  - `#reg-gender` has an empty `disabled` placeholder option, so we
 *    explicitly select "FEMALE" to land on a real value.
 *  - `#reg-ec-rel` is a free-text `<input>` (not a `<select>`), so we
 *    `.fill()` it.
 *  - `#reg-dob` is a `<input type="date">` — Playwright accepts an ISO
 *    YYYY-MM-DD string via `.fill()`.
 */
async function fillValidRegisterForm(
  page: Page,
  overrides: Partial<{
    name: string;
    email: string;
    phone: string;
    password: string;
    confirmPassword: string;
  }> = {}
): Promise<void> {
  const password = overrides.password ?? STRONG_PASSWORD;
  await page.locator("#reg-name").fill(overrides.name ?? "Priya Sharma");
  await page.locator("#reg-email").fill(overrides.email ?? uniqueEmail());
  await page.locator("#reg-phone").fill(overrides.phone ?? uniquePhone());
  await page.locator("#reg-password").fill(password);
  await page
    .locator("#reg-confirm-password")
    .fill(overrides.confirmPassword ?? password);
  await page.locator("#reg-gender").selectOption("FEMALE");
  await page.locator("#reg-dob").fill("1995-06-15");
  await page.locator("#reg-address").fill("12 MG Road, Bengaluru 560001");
  await page.locator("#reg-ec-name").fill("Test Contact");
  await page.locator("#reg-ec-phone").fill(uniquePhone());
  await page.locator("#reg-ec-rel").fill("Sibling");
  await page.locator("#reg-accept-terms").check();
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

    // Post-#617/#713/#684/#706: name + email + phone + strong-password +
    // confirm-password + gender + DOB + address + emergency contact triplet
    // + T&C consent are all required by validateClient(). The helper fills
    // every required field with a valid value so submit isn't blocked.
    await fillValidRegisterForm(page, { email });

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

    // Fill every required field validly, then override phone with the bad
    // value so phone is the ONLY field validateClient() complains about.
    await fillValidRegisterForm(page, { phone: "123" });

    await page.getByRole("button", { name: /register|create account|sign up/i }).click();

    await expect(page.getByTestId("error-phone")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("error-phone")).toContainText(
      /valid.*phone|10.digit|10.{0,3}15/i
    );
    await expect(page).toHaveURL(/\/register/);
  });

  test("validation: password shorter than 12 characters shows inline error", async ({
    page,
  }) => {
    await page.goto("/register");
    await expect(
      page.getByRole("form", { name: /registration form/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Issue #706 raised the floor from 6 → 12 chars. "abc" is short enough
    // to trip the new threshold; the helper fills every other required
    // field so password is the ONLY one validateClient() complains about.
    await fillValidRegisterForm(page, {
      password: "abc",
      confirmPassword: "abc",
    });

    await page.getByRole("button", { name: /register|create account|sign up/i }).click();

    await expect(page.getByTestId("error-password")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("error-password")).toContainText(
      /at least 12 characters/i
    );
    await expect(page).toHaveURL(/\/register/);
  });

  test("validation: out-of-range age shows inline error", async ({
    page,
  }) => {
    await page.goto("/register");
    await expect(
      page.getByRole("form", { name: /registration form/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    // Issue #707 widened the range to [0, 130] so the previous "0 is invalid"
    // pin is no longer true. Use 200 — comfortably above the new max — to
    // continue exercising the same validateClient() branch.
    await fillValidRegisterForm(page);
    await page.locator("#reg-age").fill("200");

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

    await fillValidRegisterForm(page, {
      name: "Duplicate User",
      email: SEEDED_PATIENT_EMAIL,
    });

    const [registerRes] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/auth/register") && r.request().method() === "POST",
        { timeout: 20_000 }
      ),
      page.getByRole("button", { name: /register|create account|sign up/i }).click(),
    ]);

    // Issue #480 (anti-enumeration): the duplicate-email path now returns
    // 201 with a generic "Registration received" body — byte-identical to
    // the new-email path's status + envelope shape, so an attacker cannot
    // iterate emails to learn which are registered. The CLIENT renders a
    // generic acknowledgement and stays on /register (no auto-login since
    // the response carries no tokens). See auth.ts:370-399 for the contract.
    expect(registerRes.status()).toBe(201);
    const body = await registerRes.json();
    expect(body.success).toBe(true);
    expect(body.error).toBeNull();
    // No tokens issued for duplicate — the body is a generic message.
    expect(body.data?.tokens).toBeUndefined();
    expect(body.data?.message).toMatch(/log in|registration received/i);

    // The page must NOT navigate away — duplicate-email is silent on the
    // anti-enumeration path, but the URL still anchors at /register.
    await expect(page).toHaveURL(/\/register/);
  });

  test("server-side weak-password rejection shows user-facing error", async ({
    page,
  }) => {
    // WEAK_FOR_API (`password1234`) passes the page's >=12-char + letter +
    // digit client guard so the submit fires, but is rejected by the API's
    // `strongPassword` rule because it's on the common-password denylist.
    await page.goto("/register");
    await expect(
      page.getByRole("form", { name: /registration form/i })
    ).toBeVisible({ timeout: PAGE_TIMEOUT });

    await fillValidRegisterForm(page, {
      name: "Weak Pass User",
      password: WEAK_FOR_API,
      confirmPassword: WEAK_FOR_API,
    });

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
      page.locator('[role="alert"]:not(#__next-route-announcer__)').first().waitFor({ state: "visible", timeout: 8_000 }).then(() => true),
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

    // Issue #711 (May 2026): the page now goes to an intermediate "sent"
    // step (green confirmation banner + "I have the code" CTA) before the
    // code-entry step. Click "I have the code" to advance to the reset
    // step where the 6-digit input lives.
    await expect(page.getByTestId("forgot-sent-confirmation")).toBeVisible({
      timeout: 8_000,
    });
    // The confirmation message embeds the submitted email address (UX hint —
    // this is not a security leak because it's the email the user just typed).
    await expect(page.getByText(SEEDED_PATIENT_EMAIL)).toBeVisible();
    await page.getByTestId("forgot-have-code-btn").click();

    // UI advances to the "reset" step showing the 6-digit code input
    await expect(page.locator('input[placeholder="000000"]')).toBeVisible({
      timeout: 8_000,
    });
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

    // Issue #711: page advances to the "sent" intermediate step first.
    // The confirmation banner + "I have the code" CTA must appear for
    // BOTH known and unknown emails (same UX, no enumeration leak).
    await expect(page.getByTestId("forgot-sent-confirmation")).toBeVisible({
      timeout: 8_000,
    });
    // The confirmation text embeds the email (expected UX — not a leak)
    await expect(page.getByText(unknownEmail)).toBeVisible();
    await page.getByTestId("forgot-have-code-btn").click();

    // UI must advance to the "enter your code" step — same as for a known email.
    await expect(page.locator('input[placeholder="000000"]')).toBeVisible({
      timeout: 8_000,
    });

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

    // Issue #711: intermediate "sent" step before "reset" step.
    await expect(page.getByTestId("forgot-sent-confirmation")).toBeVisible({
      timeout: 8_000,
    });
    await page.getByTestId("forgot-have-code-btn").click();

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

    // Issue #711: "Use a different email" lives on the intermediate "sent"
    // step (the green confirmation banner step), NOT on the code-entry
    // "reset" step. Pre-#711 the page jumped straight to "reset" so the
    // button was implicitly on the same view; now it's a navigational
    // affordance from the confirmation banner.
    await expect(page.getByTestId("forgot-sent-confirmation")).toBeVisible({
      timeout: 8_000,
    });

    // Click "Use a different email" button — should revert to email step
    await page.getByRole("button", { name: /use a different email/i }).click();

    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("forgot-sent-confirmation")).not.toBeVisible();
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
