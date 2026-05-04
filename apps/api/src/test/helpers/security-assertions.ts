/**
 * Adversarial-vector test assertions — reusable across integration tests.
 *
 * Built 2026-05-05 after a category of bugs slipped past tests that only
 * asserted HTTP status codes. The pattern was: tests asserted
 * `expect(res.status).toBeLessThan(400)` and called the contract done.
 * They didn't check response-body shape, identity-binding on tokens, PII
 * redaction, security headers, or cross-row access. So mass-assignment
 * (#473), cross-patient leaks (#474), missing security headers (#475),
 * Aadhaar exposure (#476), and login identity-swap (#483) all could
 * happen without the suite turning red.
 *
 * Each helper here pins one adversarial-vector category. Use them by
 * default in any new integration test for an authed/data-bearing
 * endpoint. Documented in `docs/TEST_PLAN.md` § "Adversarial-vector
 * test categories".
 */
import { expect } from "vitest";
import jwt from "jsonwebtoken";
import type { Response } from "supertest";

// ─── #475 Security headers ────────────────────────────────────────────────

/**
 * Assert the response carries the security headers set by helmet
 * middleware. Use on at least one endpoint per integration test file
 * to guard against middleware-ordering regressions.
 */
export function expectSecurityHeaders(res: Response | { headers: Record<string, string> }): void {
  expect(res.headers["x-frame-options"]).toBe("DENY");
  expect(res.headers["x-content-type-options"]).toBe("nosniff");
  expect(res.headers["content-security-policy"]).toBeDefined();
  expect(res.headers["strict-transport-security"]).toMatch(/max-age=\d+/);
  expect(res.headers["referrer-policy"]).toBeDefined();
  // Server-leak guard — should be removed by app.disable("x-powered-by").
  expect(res.headers["x-powered-by"]).toBeUndefined();
}

// ─── #476 PII redaction ───────────────────────────────────────────────────

/**
 * Assert no raw PII strings appear in the response body. Pass an array
 * of raw values (e.g., the Aadhaar number you seeded). Searches via
 * JSON.stringify so masked values like "********1234" pass.
 */
export function expectNoRawPII(body: unknown, rawValues: string[]): void {
  const serialized = JSON.stringify(body);
  for (const raw of rawValues) {
    expect(serialized).not.toContain(raw);
  }
}

/**
 * Assert a specific field on a response body is masked (not the full
 * raw value). Default mask shape from the visitors fix: 8 stars + last 4.
 */
export function expectMaskedField(
  obj: Record<string, unknown>,
  field: string,
  rawValue: string,
  maskShape: RegExp = /^[*]+\d{4}$/
): void {
  const value = obj[field];
  if (value === null || value === undefined) return;
  expect(value).not.toBe(rawValue);
  expect(value).toMatch(maskShape);
}

// ─── #483 Identity binding (login / token / user) ─────────────────────────

/**
 * Decode a JWT and assert its claims identify the requested user.
 * Use on every auth flow that returns a token — login, register,
 * refresh, magic-link, oauth callback, etc.
 *
 * Catches the "login returns wrong user's token" class of bug.
 */
export function expectTokenIdentifies(
  token: string,
  expectedUser: { id?: string; email?: string },
  jwtSecret: string = process.env.JWT_SECRET ?? ""
): void {
  expect(token).toBeTruthy();
  expect(jwtSecret).toBeTruthy(); // sanity — test misconfigured otherwise

  const decoded = jwt.verify(token, jwtSecret) as Record<string, unknown>;
  if (expectedUser.id !== undefined) {
    expect(decoded.sub).toBe(expectedUser.id);
  }
  if (expectedUser.email !== undefined) {
    expect(decoded.email).toBe(expectedUser.email);
  }
}

// ─── #473 Mass-assignment ─────────────────────────────────────────────────

/**
 * After a POST that should NOT honor a privileged field, fetch the
 * created/updated resource and assert the field landed at the safe
 * default — NOT the value the attacker submitted.
 *
 * Pattern: assert("role", "PATIENT") catches role: ADMIN injection.
 *
 * Caller is responsible for the actual fetch (resource shape varies).
 * This helper is just the assertion line.
 */
export function expectFieldNotMassAssigned<T extends Record<string, unknown>>(
  fetchedResource: T,
  field: keyof T,
  forbiddenValue: unknown,
  expectedSafeDefault?: unknown
): void {
  expect(fetchedResource[field]).not.toBe(forbiddenValue);
  if (expectedSafeDefault !== undefined) {
    expect(fetchedResource[field]).toBe(expectedSafeDefault);
  }
}

// ─── #480 Anti-enumeration ────────────────────────────────────────────────

/**
 * Assert that a response shape is identical regardless of whether the
 * input matches a real entity or not. Used on /auth/forgot-password,
 * /auth/register (duplicate-email), and any endpoint that should NOT
 * leak entity-existence.
 *
 * Caller passes the two responses (one for "real" input, one for "fake")
 * and the fields to compare. Status, errorCode, and shape-of-success
 * should match.
 */
export function expectAntiEnumeration(
  realResponse: Response | { status: number; body: unknown },
  fakeResponse: Response | { status: number; body: unknown },
  fieldsToCompare: string[] = ["status", "body.success", "body.error"]
): void {
  expect(realResponse.status).toBe(fakeResponse.status);
  for (const path of fieldsToCompare) {
    if (path === "status") continue; // handled above
    const realVal = getPath(realResponse, path);
    const fakeVal = getPath(fakeResponse, path);
    expect(realVal).toEqual(fakeVal);
  }
}

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object") {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

// ─── #474 Cross-row access ────────────────────────────────────────────────

/**
 * Pattern documenter — call this in a test to surface the
 * cross-resource access shape. Caller wires the actual request
 * (because routes differ).
 *
 * Recommended pattern per route:
 *
 *   const resourceA = await seedResource({ patientId: patientA.id });
 *   const resp = await request(app)
 *     .get(`/api/v1/<resource>/${resourceA.id}`)
 *     .set("Authorization", `Bearer ${patientB.token}`);
 *   expect(resp.status).toBe(403);
 *
 * The helper just centralizes the error shape — every cross-row 403
 * should look the same to clients.
 */
export function expectCrossRowDenied(res: Response): void {
  expect(res.status).toBe(403);
  // Every PATIENT cross-row 403 envelope should share these fields:
  expect(res.body).toMatchObject({
    success: false,
    data: null,
  });
  expect(res.body.error).toMatch(/forbidden|access denied|cannot access/i);
}
