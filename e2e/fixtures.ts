import { test as base, Page, APIRequestContext, request as playwrightRequest } from "@playwright/test";
import { apiLogin, CREDS, injectAuth, loginAs, Role, waitForAuthReady } from "./helpers";

type AuthedFixtures = {
  adminPage: Page;
  doctorPage: Page;
  nursePage: Page;
  receptionPage: Page;
  patientPage: Page;
  labTechPage: Page;
  pharmacistPage: Page;
  adminToken: string;
  doctorToken: string;
  nurseToken: string;
  receptionToken: string;
  patientToken: string;
  labTechToken: string;
  pharmacistToken: string;
  /**
   * Pre-authenticated `APIRequestContext` for each role. Shape mirrors
   * Playwright's built-in `request` fixture but already carries the
   * Authorization header + cached token, so seeding helpers
   * (`seedPatient`, `seedAppointment`, …) don't have to take a token
   * argument.
   */
  adminApi: APIRequestContext;
  receptionApi: APIRequestContext;
};

type WorkerFixtures = {
  /**
   * Worker-scoped cache of `{ role -> tokens }`. Populated lazily on
   * first access for each role and reused for the rest of the worker's
   * lifetime. This dodges the 30/min auth rate limit for heavy specs
   * because each role authenticates AT MOST ONCE per worker — not once
   * per test.
   *
   * Pattern: the {role}Page fixture creates a fresh BrowserContext,
   * navigates to /login (origin-scoped), and writes the cached
   * accessToken + refreshToken into localStorage. No /auth/login call
   * is made beyond the first.
   */
  roleTokens: Record<Role, { token: string; refresh: string; user: any }>;
};

async function freshPageWithCachedAuth(
  browser: import("@playwright/test").Browser,
  role: Role,
  request: APIRequestContext,
  cached: { token: string; refresh: string; user: any } | undefined
) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (cached) {
    // Hot path: re-use the cached tokens for this worker.
    await injectAuth(page, cached.token, cached.refresh);
    // Mirror the route-level rate-limit shielding that loginAs() set up
    // so /auth/me 429s never bounce the user back to /login mid-test.
    const tokenForClosure = cached.token;
    const userForClosure = cached.user;
    await page.route("**/api/v1/**", async (route) => {
      try {
        const headers = route.request().headers();
        if (!headers["authorization"]) {
          headers["authorization"] = `Bearer ${tokenForClosure}`;
        }
        let resp = await route.fetch({ headers });
        for (let attempt = 0; attempt < 3 && resp.status() === 429; attempt++) {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          resp = await route.fetch({ headers });
        }
        if (resp.status() === 429 && /\/auth\/me$/.test(route.request().url())) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ success: true, data: userForClosure }),
          });
          return;
        }
        await route.fulfill({ response: resp });
      } catch {
        try {
          await route.abort();
        } catch {}
      }
    });
    await page.goto("/dashboard");
    // WebKit auth-race v2: confirm the token is observably readable from
    // the page context before handing the page back to the test. Without
    // this, the test's next page.goto can race the dashboard layout's
    // redirect-to-login effect on WebKit (release run 25256962182).
    await waitForAuthReady(page, cached.token);
    return { ctx, page, token: cached.token };
  }
  // Cold path (first access for this role on this worker): full login.
  // loginAs already calls waitForAuthReady internally.
  const token = await loginAs(page, request, role);
  return { ctx, page, token };
}

/**
 * Extended test with per-role pre-authenticated pages.
 * Each role uses its own browser context so cookies / storage don't leak.
 */
export const test = base.extend<AuthedFixtures, WorkerFixtures>({
  // ─── Worker-scoped role-token cache ─────────────────────────────────────
  // `scope: "worker"` keeps the same object alive across every test in the
  // worker. We populate lazily — only the roles that any test actually
  // uses pay the auth round-trip.
  roleTokens: [
    async ({}, use) => {
      const cache = {} as Record<Role, { token: string; refresh: string; user: any }>;
      await use(cache);
    },
    { scope: "worker" },
  ],

  adminPage: async ({ browser, request, roleTokens }, use) => {
    if (!roleTokens.ADMIN) {
      const r = await apiLogin(request, CREDS.ADMIN);
      roleTokens.ADMIN = r;
    }
    const { ctx, page } = await freshPageWithCachedAuth(
      browser,
      "ADMIN",
      request,
      roleTokens.ADMIN
    );
    await use(page);
    await ctx.close();
  },
  doctorPage: async ({ browser, request, roleTokens }, use) => {
    if (!roleTokens.DOCTOR) {
      roleTokens.DOCTOR = await apiLogin(request, CREDS.DOCTOR);
    }
    const { ctx, page } = await freshPageWithCachedAuth(
      browser,
      "DOCTOR",
      request,
      roleTokens.DOCTOR
    );
    await use(page);
    await ctx.close();
  },
  nursePage: async ({ browser, request, roleTokens }, use) => {
    if (!roleTokens.NURSE) {
      roleTokens.NURSE = await apiLogin(request, CREDS.NURSE);
    }
    const { ctx, page } = await freshPageWithCachedAuth(
      browser,
      "NURSE",
      request,
      roleTokens.NURSE
    );
    await use(page);
    await ctx.close();
  },
  receptionPage: async ({ browser, request, roleTokens }, use) => {
    if (!roleTokens.RECEPTION) {
      roleTokens.RECEPTION = await apiLogin(request, CREDS.RECEPTION);
    }
    const { ctx, page } = await freshPageWithCachedAuth(
      browser,
      "RECEPTION",
      request,
      roleTokens.RECEPTION
    );
    await use(page);
    await ctx.close();
  },
  patientPage: async ({ browser, request, roleTokens }, use) => {
    if (!roleTokens.PATIENT) {
      roleTokens.PATIENT = await apiLogin(request, CREDS.PATIENT);
    }
    const { ctx, page } = await freshPageWithCachedAuth(
      browser,
      "PATIENT",
      request,
      roleTokens.PATIENT
    );
    await use(page);
    await ctx.close();
  },
  labTechPage: async ({ browser, request, roleTokens }, use) => {
    if (!roleTokens.LAB_TECH) {
      roleTokens.LAB_TECH = await apiLogin(request, CREDS.LAB_TECH);
    }
    const { ctx, page } = await freshPageWithCachedAuth(
      browser,
      "LAB_TECH",
      request,
      roleTokens.LAB_TECH
    );
    await use(page);
    await ctx.close();
  },
  pharmacistPage: async ({ browser, request, roleTokens }, use) => {
    if (!roleTokens.PHARMACIST) {
      roleTokens.PHARMACIST = await apiLogin(request, CREDS.PHARMACIST);
    }
    const { ctx, page } = await freshPageWithCachedAuth(
      browser,
      "PHARMACIST",
      request,
      roleTokens.PHARMACIST
    );
    await use(page);
    await ctx.close();
  },

  // ─── Token-only fixtures (also cached) ──────────────────────────────────
  adminToken: async ({ request, roleTokens }, use) => {
    if (!roleTokens.ADMIN) {
      roleTokens.ADMIN = await apiLogin(request, CREDS.ADMIN);
    }
    await use(roleTokens.ADMIN.token);
  },
  doctorToken: async ({ request, roleTokens }, use) => {
    if (!roleTokens.DOCTOR) {
      roleTokens.DOCTOR = await apiLogin(request, CREDS.DOCTOR);
    }
    await use(roleTokens.DOCTOR.token);
  },
  nurseToken: async ({ request, roleTokens }, use) => {
    if (!roleTokens.NURSE) {
      roleTokens.NURSE = await apiLogin(request, CREDS.NURSE);
    }
    await use(roleTokens.NURSE.token);
  },
  receptionToken: async ({ request, roleTokens }, use) => {
    if (!roleTokens.RECEPTION) {
      roleTokens.RECEPTION = await apiLogin(request, CREDS.RECEPTION);
    }
    await use(roleTokens.RECEPTION.token);
  },
  patientToken: async ({ request, roleTokens }, use) => {
    if (!roleTokens.PATIENT) {
      roleTokens.PATIENT = await apiLogin(request, CREDS.PATIENT);
    }
    await use(roleTokens.PATIENT.token);
  },
  labTechToken: async ({ request, roleTokens }, use) => {
    if (!roleTokens.LAB_TECH) {
      roleTokens.LAB_TECH = await apiLogin(request, CREDS.LAB_TECH);
    }
    await use(roleTokens.LAB_TECH.token);
  },
  pharmacistToken: async ({ request, roleTokens }, use) => {
    if (!roleTokens.PHARMACIST) {
      roleTokens.PHARMACIST = await apiLogin(request, CREDS.PHARMACIST);
    }
    await use(roleTokens.PHARMACIST.token);
  },

  // ─── Pre-authed APIRequestContext fixtures for seeding ──────────────────
  adminApi: async ({ adminToken }, use) => {
    const ctx = await playwrightRequest.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${adminToken}` },
    });
    await use(ctx);
    await ctx.dispose();
  },
  receptionApi: async ({ receptionToken }, use) => {
    const ctx = await playwrightRequest.newContext({
      extraHTTPHeaders: { Authorization: `Bearer ${receptionToken}` },
    });
    await use(ctx);
    await ctx.dispose();
  },
});

export { expect } from "@playwright/test";
