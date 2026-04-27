#!/usr/bin/env tsx
/**
 * Capture marketing screenshots from the MedCore live demo.
 *
 * One-off marketing tooling — NOT a regression test. Lives in scripts/ so it
 * doesn't get picked up by the CI playwright runner under e2e/.
 *
 * Captures above-the-fold screenshots (1440×900) of ~40 dashboard pages as
 * ADMIN, plus a couple of doctor-specific screens as DOCTOR. Output goes to
 * apps/web/public/screenshots/ using the existing NN-slug.png convention so
 * the marketing landing page (apps/web/src/app/(marketing)/page.tsx) can
 * reference them directly.
 *
 * Usage:
 *   npx tsx scripts/capture-screenshots.ts
 *   npx tsx scripts/capture-screenshots.ts --base http://localhost:3200
 *
 * Defaults to https://medcore.globusdemos.com so the user doesn't need env
 * vars. Login happens ONCE per persona (admin, doctor) via /api/v1/auth/login
 * because prod has 20/min rate limiting on the login endpoint — the resulting
 * tokens are then injected into localStorage and reused across all
 * navigations.
 */

import { chromium, devices, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

// ─── CLI ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const baseFlagIdx = argv.indexOf("--base");
const BASE_URL =
  baseFlagIdx >= 0 && argv[baseFlagIdx + 1]
    ? argv[baseFlagIdx + 1]
    : process.env.E2E_BASE_URL ?? "https://medcore.globusdemos.com";
const API_BASE =
  process.env.E2E_API_URL ??
  `${BASE_URL.replace(/\/$/, "")}/api/v1`;

const OUT_DIR = path.resolve(__dirname, "..", "apps", "web", "public", "screenshots");
const VIEWPORT = { width: 1440, height: 900 };

// ─── Credentials ──────────────────────────────────────────────────────────────

const CREDS = {
  ADMIN: { email: "admin@medcore.local", password: "admin123" },
  DOCTOR: { email: "dr.sharma@medcore.local", password: "doctor123" },
} as const;

type Role = keyof typeof CREDS;

// ─── Page list ────────────────────────────────────────────────────────────────
//
// `selector` is an optional locator to wait for after networkidle — useful
// when a page has skeleton loaders that only resolve once data arrives. When
// omitted, we just rely on networkidle + a 500ms buffer.
//
// `id` is the patient placeholder — resolved at runtime so we can pick a
// patient with rich history.

interface Shot {
  file: string;
  pathTpl: string;
  role: Role;
  selector?: string;
}

const SHOTS: Shot[] = [
  { file: "03-dashboard-admin.png", pathTpl: "/dashboard", role: "ADMIN" },
  { file: "04-dashboard-doctor.png", pathTpl: "/dashboard", role: "DOCTOR" },
  { file: "10-appointments.png", pathTpl: "/dashboard/appointments", role: "ADMIN" },
  { file: "12-queue.png", pathTpl: "/dashboard/queue", role: "ADMIN" },
  { file: "13-walk-in.png", pathTpl: "/dashboard/walk-in", role: "ADMIN" },
  { file: "15-patients.png", pathTpl: "/dashboard/patients", role: "ADMIN" },
  { file: "16-patient-detail.png", pathTpl: "/dashboard/patients/__PATIENT_ID__", role: "ADMIN" },
  { file: "17-prescriptions.png", pathTpl: "/dashboard/prescriptions", role: "DOCTOR" },
  { file: "18-medicines.png", pathTpl: "/dashboard/medicines", role: "ADMIN" },
  { file: "20-admissions.png", pathTpl: "/dashboard/admissions", role: "ADMIN" },
  { file: "21-wards.png", pathTpl: "/dashboard/wards", role: "ADMIN" },
  { file: "25-emergency.png", pathTpl: "/dashboard/emergency", role: "ADMIN" },
  { file: "26-surgery.png", pathTpl: "/dashboard/surgery", role: "ADMIN" },
  { file: "27-ot.png", pathTpl: "/dashboard/ot", role: "ADMIN" },
  { file: "28-ambulance.png", pathTpl: "/dashboard/ambulance", role: "ADMIN" },
  { file: "30-bloodbank.png", pathTpl: "/dashboard/bloodbank", role: "ADMIN" },
  { file: "32-lab.png", pathTpl: "/dashboard/lab", role: "ADMIN" },
  { file: "33-lab-qc.png", pathTpl: "/dashboard/lab/qc", role: "ADMIN" },
  { file: "34-pharmacy.png", pathTpl: "/dashboard/pharmacy", role: "ADMIN" },
  { file: "37-billing.png", pathTpl: "/dashboard/billing", role: "ADMIN" },
  { file: "38-insurance-claims.png", pathTpl: "/dashboard/insurance-claims", role: "ADMIN" },
  { file: "40-ai-booking.png", pathTpl: "/dashboard/ai-booking", role: "ADMIN" },
  { file: "41-scribe.png", pathTpl: "/dashboard/scribe", role: "DOCTOR" },
  { file: "42-ai-radiology.png", pathTpl: "/dashboard/ai-radiology", role: "ADMIN" },
  { file: "43-ai-kpis.png", pathTpl: "/dashboard/ai-kpis", role: "ADMIN" },
  { file: "44-agent-console.png", pathTpl: "/dashboard/agent-console", role: "ADMIN" },
  { file: "45-ai-analytics.png", pathTpl: "/dashboard/ai-analytics", role: "ADMIN" },
  { file: "46-er-triage.png", pathTpl: "/dashboard/er-triage", role: "ADMIN" },
  { file: "47-pharmacy-forecast.png", pathTpl: "/dashboard/pharmacy-forecast", role: "ADMIN" },
  { file: "48-predictions.png", pathTpl: "/dashboard/predictions", role: "ADMIN" },
  { file: "50-analytics.png", pathTpl: "/dashboard/analytics", role: "ADMIN" },
  { file: "51-reports.png", pathTpl: "/dashboard/reports", role: "ADMIN" },
  { file: "52-audit.png", pathTpl: "/dashboard/audit", role: "ADMIN" },
  { file: "53-tenants.png", pathTpl: "/dashboard/tenants", role: "ADMIN" },
  { file: "60-feedback.png", pathTpl: "/dashboard/feedback", role: "ADMIN" },
  { file: "61-complaints.png", pathTpl: "/dashboard/complaints", role: "ADMIN" },
  { file: "66-chat.png", pathTpl: "/dashboard/chat", role: "ADMIN" },
  { file: "70-payroll.png", pathTpl: "/dashboard/payroll", role: "ADMIN" },
  { file: "71-leaves.png", pathTpl: "/dashboard/my-leaves", role: "ADMIN" },
  { file: "72-duty-roster.png", pathTpl: "/dashboard/duty-roster", role: "ADMIN" },
  { file: "73-doctors.png", pathTpl: "/dashboard/doctors", role: "ADMIN" },
  { file: "80-settings.png", pathTpl: "/dashboard/settings", role: "ADMIN" },
];

// ─── API helpers ──────────────────────────────────────────────────────────────

interface Tokens {
  token: string;
  refresh: string;
  user: any;
}

async function apiLogin(request: APIRequestContext, role: Role): Promise<Tokens> {
  const creds = CREDS[role];
  // Modest retry on 429 / 5xx so a transient hiccup doesn't sink the whole run.
  const delays = [2000, 5000, 10_000, 20_000];
  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const res = await request.post(`${API_BASE}/auth/login`, {
      data: { email: creds.email, password: creds.password },
    });
    if (res.ok()) {
      const json = await res.json();
      const data = json.data;
      if (!data?.tokens) {
        throw new Error(`Login response missing tokens: ${JSON.stringify(json).slice(0, 200)}`);
      }
      return {
        token: data.tokens.accessToken,
        refresh: data.tokens.refreshToken,
        user: data.user,
      };
    }
    lastStatus = res.status();
    lastBody = await res.text();
    if (lastStatus !== 429 && lastStatus < 500) break;
    if (attempt < delays.length) {
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  throw new Error(`Login failed for ${creds.email}: ${lastStatus} ${lastBody.slice(0, 200)}`);
}

async function pickRichPatientId(request: APIRequestContext, token: string): Promise<string | null> {
  // Try a few endpoints — different deployments paginate differently.
  try {
    const res = await request.get(`${API_BASE}/patients?limit=20`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok()) return null;
    const json = await res.json();
    const items = json.data?.items ?? json.data ?? [];
    if (!Array.isArray(items) || items.length === 0) return null;
    // Prefer one with a non-empty MRN and a real name (richest profile).
    const ranked = items
      .filter((p: any) => p?.id)
      .sort((a: any, b: any) => {
        const score = (p: any) =>
          (p.mrn ? 1 : 0) +
          (p.dateOfBirth ? 1 : 0) +
          (p.bloodType ? 1 : 0) +
          (p.allergies?.length ? 2 : 0) +
          (p.chronicConditions?.length ? 2 : 0);
        return score(b) - score(a);
      });
    return ranked[0]?.id ?? items[0].id;
  } catch {
    return null;
  }
}

// ─── Browser helpers ──────────────────────────────────────────────────────────

async function newAuthedContext(
  browser: import("@playwright/test").Browser,
  tokens: Tokens
): Promise<BrowserContext> {
  const context = await browser.newContext({
    ...devices["Desktop Chrome"],
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    // Match the prod login flow's localStorage layout (see e2e/helpers.ts injectAuth).
    // We seed via addInitScript so it's set before ANY origin script runs on
    // every navigation in this context.
  });
  await context.addInitScript((args: { token: string; refresh: string }) => {
    localStorage.setItem("medcore_token", args.token);
    localStorage.setItem("medcore_refresh", args.refresh);
    for (const role of ["ADMIN", "DOCTOR", "NURSE", "RECEPTION", "PATIENT"]) {
      localStorage.setItem(`mc_tour_${role}`, "1");
    }
  }, { token: tokens.token, refresh: tokens.refresh });

  // Best-effort transparent re-auth on 429s so a long capture run doesn't
  // self-DoS into the rate limiter and end up redirected to /login.
  await context.route("**/api/v1/**", async (route) => {
    try {
      const headers = route.request().headers();
      if (!headers["authorization"]) {
        headers["authorization"] = `Bearer ${tokens.token}`;
      }
      let resp = await route.fetch({ headers });
      for (let i = 0; i < 3 && resp.status() === 429; i++) {
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        resp = await route.fetch({ headers });
      }
      if (resp.status() === 429 && /\/auth\/me$/.test(route.request().url())) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: tokens.user }),
        });
        return;
      }
      await route.fulfill({ response: resp });
    } catch {
      try { await route.abort(); } catch {}
    }
  });
  return context;
}

async function waitForReady(page: Page): Promise<void> {
  // Wait for the dashboard layout's <main id="main-content"> to render.
  // That's the most stable "we're past the auth gate" signal.
  await page.locator("main#main-content").first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(900); // let charts/animations settle
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`[capture] base=${BASE_URL}`);
  console.log(`[capture] api =${API_BASE}`);
  console.log(`[capture] out =${OUT_DIR}`);

  const browser = await chromium.launch({ headless: true });
  const apiCtx = await browser.newContext({ baseURL: API_BASE });
  const request = apiCtx.request;

  // 1) Login once per persona.
  console.log("[capture] logging in as ADMIN…");
  const adminTokens = await apiLogin(request, "ADMIN");
  console.log("[capture] logging in as DOCTOR…");
  const doctorTokens = await apiLogin(request, "DOCTOR");

  // 2) Pick a patient with rich history for the patient detail screen.
  const patientId = await pickRichPatientId(request, adminTokens.token);
  if (patientId) {
    console.log(`[capture] patient detail uses id=${patientId}`);
  } else {
    console.warn("[capture] WARN: could not resolve a patient id; skipping 16-patient-detail.png");
  }

  // 3) One BrowserContext per persona — preserves the auth init script and
  //    the 429-retry route across all navigations.
  const adminCtx = await newAuthedContext(browser, adminTokens);
  const doctorCtx = await newAuthedContext(browser, doctorTokens);

  // Pre-warm: visit /dashboard once per context so the auth store hydrates.
  for (const [label, ctx] of [["ADMIN", adminCtx], ["DOCTOR", doctorCtx]] as const) {
    const p = await ctx.newPage();
    try {
      await p.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitForReady(p);
    } catch (err) {
      console.warn(`[capture] WARN: ${label} pre-warm failed: ${(err as Error).message}`);
    } finally {
      await p.close();
    }
  }

  const results: { file: string; ok: boolean; bytes?: number; reason?: string }[] = [];

  for (const shot of SHOTS) {
    let url = shot.pathTpl;
    if (url.includes("__PATIENT_ID__")) {
      if (!patientId) {
        console.warn(`[capture] SKIP ${shot.file} — no patient id available`);
        results.push({ file: shot.file, ok: false, reason: "no patient id" });
        continue;
      }
      url = url.replace("__PATIENT_ID__", patientId);
    }
    const fullUrl = `${BASE_URL}${url}`;
    const ctx = shot.role === "DOCTOR" ? doctorCtx : adminCtx;
    const page = await ctx.newPage();
    const outFile = path.join(OUT_DIR, shot.file);
    try {
      const resp = await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const status = resp?.status() ?? 0;
      if (status >= 400) {
        console.warn(`[capture] WARN ${shot.file} — HTTP ${status}, skipping`);
        results.push({ file: shot.file, ok: false, reason: `HTTP ${status}` });
        await page.close();
        continue;
      }
      // If the page bounced us back to /login, the auth store was wiped —
      // log and skip rather than capture a login screen.
      if (page.url().includes("/login")) {
        console.warn(`[capture] WARN ${shot.file} — redirected to /login (auth lost), skipping`);
        results.push({ file: shot.file, ok: false, reason: "auth lost (redirected to /login)" });
        await page.close();
        continue;
      }
      await waitForReady(page);
      if (shot.selector) {
        await page.locator(shot.selector).first().waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
      }
      await page.screenshot({ path: outFile, fullPage: false });
      const bytes = fs.statSync(outFile).size;
      if (bytes < 50 * 1024) {
        console.warn(`[capture] WARN ${shot.file} saved but only ${(bytes / 1024).toFixed(1)} KB (< 50 KB) — page may be blank`);
        results.push({ file: shot.file, ok: false, bytes, reason: `too small (${(bytes / 1024).toFixed(1)} KB)` });
      } else {
        console.log(`[capture] ${shot.file} saved (${(bytes / 1024).toFixed(0)} KB)`);
        results.push({ file: shot.file, ok: true, bytes });
      }
    } catch (err) {
      console.warn(`[capture] WARN ${shot.file} — ${(err as Error).message}`);
      results.push({ file: shot.file, ok: false, reason: (err as Error).message });
    } finally {
      await page.close();
    }
  }

  await adminCtx.close();
  await doctorCtx.close();
  await apiCtx.close();
  await browser.close();

  // Summary
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const totalBytes = ok.reduce((s, r) => s + (r.bytes ?? 0), 0);
  console.log("");
  console.log(`[capture] DONE: ${ok.length} succeeded, ${failed.length} failed, total ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  if (failed.length) {
    console.log("[capture] failures:");
    for (const f of failed) console.log(`           ${f.file} — ${f.reason ?? "unknown"}`);
  }
}

main().catch((err) => {
  console.error("[capture] FATAL:", err);
  process.exit(1);
});
