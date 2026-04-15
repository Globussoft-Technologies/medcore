import { test as base, Page, APIRequestContext } from "@playwright/test";
import { apiLogin, CREDS, loginAs, Role } from "./helpers";

type AuthedFixtures = {
  adminPage: Page;
  doctorPage: Page;
  nursePage: Page;
  receptionPage: Page;
  patientPage: Page;
  adminToken: string;
  doctorToken: string;
  nurseToken: string;
  receptionToken: string;
  patientToken: string;
};

async function freshPageFor(
  browser: import("@playwright/test").Browser,
  role: Role,
  request: APIRequestContext
) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const token = await loginAs(page, request, role);
  return { ctx, page, token };
}

/**
 * Extended test with per-role pre-authenticated pages.
 * Each role uses its own browser context so cookies / storage don't leak.
 */
export const test = base.extend<AuthedFixtures>({
  adminPage: async ({ browser, request }, use) => {
    const { ctx, page } = await freshPageFor(browser, "ADMIN", request);
    await use(page);
    await ctx.close();
  },
  doctorPage: async ({ browser, request }, use) => {
    const { ctx, page } = await freshPageFor(browser, "DOCTOR", request);
    await use(page);
    await ctx.close();
  },
  nursePage: async ({ browser, request }, use) => {
    const { ctx, page } = await freshPageFor(browser, "NURSE", request);
    await use(page);
    await ctx.close();
  },
  receptionPage: async ({ browser, request }, use) => {
    const { ctx, page } = await freshPageFor(browser, "RECEPTION", request);
    await use(page);
    await ctx.close();
  },
  patientPage: async ({ browser, request }, use) => {
    const { ctx, page } = await freshPageFor(browser, "PATIENT", request);
    await use(page);
    await ctx.close();
  },

  adminToken: async ({ request }, use) => {
    const { token } = await apiLogin(request, CREDS.ADMIN);
    await use(token);
  },
  doctorToken: async ({ request }, use) => {
    const { token } = await apiLogin(request, CREDS.DOCTOR);
    await use(token);
  },
  nurseToken: async ({ request }, use) => {
    const { token } = await apiLogin(request, CREDS.NURSE);
    await use(token);
  },
  receptionToken: async ({ request }, use) => {
    const { token } = await apiLogin(request, CREDS.RECEPTION);
    await use(token);
  },
  patientToken: async ({ request }, use) => {
    const { token } = await apiLogin(request, CREDS.PATIENT);
    await use(token);
  },
});

export { expect } from "@playwright/test";
