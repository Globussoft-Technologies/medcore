#!/usr/bin/env tsx
/**
 * Production smoke test — verifies the 7 new AI-feature dashboard pages
 * load against the live demo. Run AFTER `scripts/deploy.sh` and
 * `scripts/verify-deploy.sh`.
 *
 * Usage:
 *   npx tsx scripts/prod-smoke-test.ts
 *   DEMO_URL=https://staging.medcore.globusdemos.com npx tsx scripts/prod-smoke-test.ts
 *
 * Exits non-zero on the first unacceptable status.
 *
 * Accepted responses per page:
 *   - 200  — page rendered (publicly accessible or SSR without auth).
 *   - 302  — redirected to /login (auth-gated, which is the expected
 *            behavior for every /dashboard/* route when not authenticated).
 *   - 307  — Next.js temporary redirect variant of the above.
 *
 * Anything else (4xx/5xx/timeout) is a failure.
 *
 * No new dependencies: uses the global `fetch` available in Node 18+.
 */

const DEMO_URL = process.env.DEMO_URL ?? "https://medcore.globusdemos.com";
const TIMEOUT_MS = 15_000;

const PAGES = [
  "/dashboard/adherence",
  "/dashboard/ai-analytics",
  "/dashboard/er-triage",
  "/dashboard/lab-explainer",
  "/dashboard/letters",
  "/dashboard/pharmacy-forecast",
  "/dashboard/predictions",
] as const;

const ACCEPTABLE_STATUSES = new Set([200, 302, 307]);

interface CheckResult {
  path: string;
  status: number | "error";
  url: string;
  redirectedTo?: string;
  error?: string;
  ok: boolean;
}

async function check(path: string): Promise<CheckResult> {
  const url = `${DEMO_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // redirect: "manual" so we can observe 302/307 instead of following them
    // through to the login page (which would return 200 and mask problems).
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": "medcore-smoke-test/1.0",
        Accept: "text/html",
      },
    });

    const status = res.status;
    const redirectedTo = res.headers.get("location") ?? undefined;

    return {
      path,
      status,
      url,
      redirectedTo,
      ok: ACCEPTABLE_STATUSES.has(status),
    };
  } catch (err) {
    return {
      path,
      status: "error",
      url,
      error: err instanceof Error ? err.message : String(err),
      ok: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  console.log(`Running production smoke test against: ${DEMO_URL}`);
  console.log(`Timeout: ${TIMEOUT_MS}ms per request`);
  console.log("");

  const results = await Promise.all(PAGES.map((p) => check(p)));

  let failures = 0;
  for (const r of results) {
    const mark = r.ok ? "PASS" : "FAIL";
    const extra =
      r.status === "error"
        ? `error=${r.error}`
        : r.redirectedTo
          ? `-> ${r.redirectedTo}`
          : "";
    console.log(`  [${mark}] ${r.path.padEnd(30)} ${String(r.status).padEnd(5)} ${extra}`);
    if (!r.ok) failures++;
  }

  console.log("");
  console.log(`Results: ${results.length - failures}/${results.length} passing`);

  if (failures > 0) {
    console.error(`SMOKE TEST FAILED — ${failures} page(s) returned an unexpected status.`);
    process.exit(1);
  }

  console.log("SMOKE TEST OK");
  process.exit(0);
}

main().catch((err) => {
  console.error("Unhandled error in smoke test:", err);
  process.exit(2);
});
