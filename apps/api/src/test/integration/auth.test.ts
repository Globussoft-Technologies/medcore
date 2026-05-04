// Integration test for the auth router. Skipped unless DATABASE_URL_TEST is set.
//
// Login identity-binding tests (Issue #483, May 2026):
//   The original /login regression coverage only checked that an access token
//   was returned, but never that the token actually identified the requesting
//   user. A reported (alleged) bug had the production endpoint returning a
//   token whose `email` claim did NOT match the submitted credentials — i.e.
//   login as user-A would silently seat the caller as user-B. The investigation
//   for #483 found the source handler is correct (it does
//   `findUnique({ where: { email } })`, verifies bcrypt against THAT user's
//   hash, then signs a JWT with THAT user's id/email/role), but the previous
//   tests would have passed even if it WERE broken — so we add explicit
//   identity-binding assertions below as defence in depth.
//
// Auth-hardening sweep (Issues #480, #478, #489, May 2026):
//   - #480 (anti-enumeration on /register): ensure duplicate-email and
//     new-email responses share the same status/success/error envelope so
//     attackers can't enumerate registered emails.
//   - #478 (login rate-limit): a fresh app instance with the real limiter
//     enabled (ENABLE_LOGIN_RATELIMIT_IN_TESTS=true) must 429 the 6th
//     attempt within the window with a Retry-After header.
//   - #489 (XSS in name + age bounds on /register): payloads like
//     `<script>` and age=-1 / age=151 must be rejected with 400 + a
//     field-shaped error rather than persisted to the DB.
import { it, expect, beforeAll, describe } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { describeIfDB, resetDB, TEST_DB_AVAILABLE } from "../setup";
import { expectAntiEnumeration } from "../helpers/security-assertions";

let app: any;

describeIfDB("Auth API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;
  });

  // Issue #473 (CRITICAL, May 2026): mass-assignment privilege escalation.
  //
  // The previous version of this test sent `role: "RECEPTION"` and only
  // asserted `res.status < 400`. It NEVER verified what role was actually
  // stored on the user — so a regression where the handler accepted any
  // role from the body would pass silently. The bug shipped because of
  // exactly that: an attacker could POST `{ ..., role: "ADMIN" }` to the
  // unauthenticated /auth/register and walk away with an admin account.
  //
  // The replacement tests below verify the STORED role (via /auth/me with
  // the returned access token), not just the HTTP status, and exercise the
  // attack vector with both ADMIN and DOCTOR to prove the handler never
  // honours a non-PATIENT role from an unauthenticated caller.
  it("registers a new user as PATIENT regardless of submitted role (#473)", async () => {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({
        name: "New User",
        email: "newuser@test.local",
        phone: "9111111111",
        password: "MedCoreT3st-2026",
        // No role submitted: should default to PATIENT.
      });
    expect(res.status).toBeLessThan(400);
    const accessToken = res.body?.data?.tokens?.accessToken;
    expect(accessToken).toBeTruthy();
    const me = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body?.data?.role).toBe("PATIENT");
  });

  it("blocks role mass-assignment to ADMIN on /register (#473)", async () => {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({
        name: "Attacker A",
        email: "attacker-admin@test.local",
        phone: "9222222222",
        password: "MedCoreT3st-2026",
        role: "ADMIN", // <-- the attack
      });
    // We accept either: (a) request succeeds but role is silently coerced
    // to PATIENT, or (b) request is rejected with 400. Either is safe; we
    // MUST NOT end up with role === "ADMIN" stored in the DB.
    if (res.status < 400) {
      const accessToken = res.body?.data?.tokens?.accessToken;
      expect(accessToken).toBeTruthy();
      const me = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${accessToken}`);
      expect(me.status).toBe(200);
      expect(me.body?.data?.role).toBe("PATIENT");
      expect(me.body?.data?.role).not.toBe("ADMIN");
    } else {
      expect(res.status).toBe(400);
    }
  });

  it("blocks role mass-assignment to DOCTOR on /register (#473)", async () => {
    const res = await request(app)
      .post("/api/v1/auth/register")
      .send({
        name: "Attacker D",
        email: "attacker-doctor@test.local",
        phone: "9333333333",
        password: "MedCoreT3st-2026",
        role: "DOCTOR", // <-- different role, same vector
      });
    if (res.status < 400) {
      const accessToken = res.body?.data?.tokens?.accessToken;
      expect(accessToken).toBeTruthy();
      const me = await request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${accessToken}`);
      expect(me.status).toBe(200);
      expect(me.body?.data?.role).toBe("PATIENT");
      expect(me.body?.data?.role).not.toBe("DOCTOR");
    } else {
      expect(res.status).toBe(400);
    }
  });

  it("logs in the seeded admin", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password: "MedCoreT3st-2026" });
    expect(res.status).toBe(200);
    expect(res.body?.data?.tokens?.accessToken).toBeTruthy();
  });

  it("rejects bad credentials", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password: "wrong-password" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects malformed payload with 400", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  // Issue #483 (CRITICAL, May 2026): identity-binding regression coverage.
  //
  // The bug report claimed /login was returning a token whose email/role
  // claims belonged to a DIFFERENT user than the credentials submitted. The
  // existing login tests above would have all passed even if that were true:
  // they only check that SOME access token is returned. These tests pin the
  // contract that the access token's payload identifies the user whose
  // credentials were validated, in BOTH directions, so a future regression
  // (cache key collision, off-by-one in a lookup, hard-coded fallback user,
  // etc.) cannot ship without a red test.
  it("login(A) returns a token whose payload identifies user A — never user B (#483)", async () => {
    const userAEmail = "identity.a@test.local";
    const userBEmail = "identity.b@test.local";
    const password = "MedCoreT3st-2026";

    // Register two distinct users back-to-back so there is a realistic chance
    // of state from one bleeding into the other (#441-style closure leak).
    await request(app).post("/api/v1/auth/register").send({
      name: "Identity A",
      email: userAEmail,
      phone: "9444444441",
      password,
    });
    await request(app).post("/api/v1/auth/register").send({
      name: "Identity B",
      email: userBEmail,
      phone: "9444444442",
      password,
    });

    // Login as A.
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: userAEmail, password });
    expect(res.status).toBe(200);

    // Decode the access token — claim MUST be userA, NOT userB.
    const accessToken = res.body?.data?.tokens?.accessToken as string;
    expect(accessToken).toBeTruthy();
    const decoded = jwt.verify(
      accessToken,
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod"
    ) as { userId: string; email: string; role: string };
    expect(decoded.email).toBe(userAEmail);
    expect(decoded.email).not.toBe(userBEmail);

    // Response body's `user` block must agree with the token claims —
    // any mismatch here would be a critical session-bleed bug.
    expect(res.body?.data?.user?.email).toBe(userAEmail);
    expect(res.body?.data?.user?.email).not.toBe(userBEmail);
    expect(decoded.userId).toBe(res.body.data.user.id);

    // Sanity check via /auth/me — using the token MUST resolve back to userA.
    const me = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body?.data?.email).toBe(userAEmail);
    expect(me.body?.data?.email).not.toBe(userBEmail);
  });

  it("login(B) returns a token whose payload identifies user B — never user A (#483)", async () => {
    // Inverse direction — guards against a bug that always returns the FIRST
    // registered user's token (e.g. a hard-coded shortcut, or `findFirst`
    // with no orderBy returning the oldest row).
    const userAEmail = "identity.a@test.local";
    const userBEmail = "identity.b@test.local";
    const password = "MedCoreT3st-2026";

    // Both users were registered in the previous test; resetDB() runs only
    // in beforeAll, so the rows persist across `it` blocks in this suite.

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: userBEmail, password });
    expect(res.status).toBe(200);

    const accessToken = res.body?.data?.tokens?.accessToken as string;
    expect(accessToken).toBeTruthy();
    const decoded = jwt.verify(
      accessToken,
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod"
    ) as { userId: string; email: string; role: string };
    expect(decoded.email).toBe(userBEmail);
    expect(decoded.email).not.toBe(userAEmail);

    expect(res.body?.data?.user?.email).toBe(userBEmail);
    expect(res.body?.data?.user?.email).not.toBe(userAEmail);
    expect(decoded.userId).toBe(res.body.data.user.id);

    const me = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body?.data?.email).toBe(userBEmail);
    expect(me.body?.data?.email).not.toBe(userAEmail);
  });

  // ─── Issue #480 (anti-enumeration on /register) ─────────────────────────
  //
  // Pre-fix: duplicate-email path returned 409 with a "Email already
  // registered" error string while new-email path returned 201 with tokens.
  // An attacker could iterate a list of emails and learn which were
  // registered. Post-fix: both paths share the same status/success/error
  // envelope (status 201, success true, error null). The duplicate path
  // returns no token but the comparison fields match.
  it("does not leak email registration state on /register (#480)", async () => {
    const sharedPassword = "MedCoreT3st-2026";
    // Seed an account so we have a real-existing email to probe against.
    await request(app).post("/api/v1/auth/register").send({
      name: "Antienum Real",
      email: "antienum.real@test.local",
      phone: "9555555555",
      password: sharedPassword,
    });

    // Probe with the SAME email — duplicate path.
    const realRes = await request(app).post("/api/v1/auth/register").send({
      name: "Antienum Real Again",
      email: "antienum.real@test.local",
      phone: "9555555555",
      password: sharedPassword,
    });

    // Probe with a fresh email — new-email path.
    const fakeRes = await request(app).post("/api/v1/auth/register").send({
      name: "Antienum Fake",
      email: "antienum.fake@test.local",
      phone: "9555555556",
      password: sharedPassword,
    });

    // Status, success flag, and error string MUST be identical so an
    // attacker cannot distinguish the two paths.
    expectAntiEnumeration(realRes, fakeRes, [
      "status",
      "body.success",
      "body.error",
    ]);
    // Sanity: both paths use 201 envelope (not 409 anymore).
    expect(realRes.status).toBe(201);
    expect(fakeRes.status).toBe(201);
    expect(realRes.body?.success).toBe(true);
    expect(fakeRes.body?.success).toBe(true);
  });

  // ─── Issue #489 (XSS in name + age bounds on /register) ─────────────────
  //
  // Pre-fix: name="<script>alert(1)</script>" and age=-5 sailed through
  // validation and persisted to the DB. Post-fix: the schema rejects HTML
  // markers via containsHtmlOrScript and bounds age to [1, 150].
  it("rejects XSS payload in name on /register (#489)", async () => {
    const res = await request(app).post("/api/v1/auth/register").send({
      name: "<script>alert(1)</script>",
      email: "xss.name@test.local",
      phone: "9666666661",
      password: "MedCoreT3st-2026",
    });
    expect(res.status).toBe(400);
    // Field-shaped error — the schema or sanitizer surfaces a clear message.
    const errStr = JSON.stringify(res.body);
    expect(errStr.toLowerCase()).toMatch(/name|html|tag/);
    // Critical: no token issued; no `data.tokens` block on a rejection path.
    expect(res.body?.data?.tokens).toBeFalsy();
  });

  it("rejects negative age on /register (#489)", async () => {
    const res = await request(app).post("/api/v1/auth/register").send({
      name: "Bounded Age",
      email: "age.negative@test.local",
      phone: "9666666662",
      password: "MedCoreT3st-2026",
      age: -5,
    });
    expect(res.status).toBe(400);
    const errStr = JSON.stringify(res.body).toLowerCase();
    expect(errStr).toMatch(/age/);
  });

  it("rejects out-of-range age on /register (#489)", async () => {
    const res = await request(app).post("/api/v1/auth/register").send({
      name: "Bounded Age 2",
      email: "age.toobig@test.local",
      phone: "9666666663",
      password: "MedCoreT3st-2026",
      age: 200,
    });
    expect(res.status).toBe(400);
    const errStr = JSON.stringify(res.body).toLowerCase();
    expect(errStr).toMatch(/age/);
  });
});

// ─── Issue #478 (login rate-limit) ────────────────────────────────────────
//
// Mounted as a SEPARATE describe block because we need to flip
// ENABLE_LOGIN_RATELIMIT_IN_TESTS=true BEFORE the auth router constructs
// its loginLimiter. The main describe block constructs the router with
// the limiter as a no-op (test-suite-wide default), so we rebuild a fresh
// app instance here with the env flag set.
const describeRateLimit = TEST_DB_AVAILABLE ? describe : describe.skip;
describeRateLimit("Auth API — /login rate-limit (#478)", () => {
  let rlApp: any;

  beforeAll(async () => {
    process.env.ENABLE_LOGIN_RATELIMIT_IN_TESTS = "true";
    // Re-import the app builder fresh so the new env var is read by the
    // route module's loginLimiter construction. `await import()` returns
    // the module-cached value, but vitest's resetModules / dynamic
    // re-import via the buildApp() factory gives us a per-test instance.
    const mod = await import("../../app");
    rlApp = mod.buildApp().app;
  });

  it("returns 429 with Retry-After after 5 attempts in the same window", async () => {
    // Drive 6 login requests at the same IP (supertest defaults to
    // 127.0.0.1). The limiter is configured at 5/min/IP → the 6th must
    // 429. Use intentionally-wrong credentials so we exercise the
    // failure path (the limiter fires regardless of credential
    // correctness — it's per-IP, pre-handler).
    const reqs = [];
    for (let i = 0; i < 6; i++) {
      reqs.push(
        await request(rlApp)
          .post("/api/v1/auth/login")
          .send({
            email: `ratelimit.${i}@test.local`,
            password: "WrongPasswordButLongEnough1",
          })
      );
    }
    // First 5 are NOT rate-limited (could be 401/400, anything ≠ 429).
    for (let i = 0; i < 5; i++) {
      expect(reqs[i].status, `request ${i + 1} should not be 429`).not.toBe(
        429
      );
    }
    // The 6th MUST be a 429 with a Retry-After header per RFC 9239.
    expect(reqs[5].status).toBe(429);
    expect(reqs[5].headers["retry-after"]).toBeDefined();
    expect(Number(reqs[5].headers["retry-after"])).toBeGreaterThan(0);
    expect(reqs[5].body?.success).toBe(false);
  });
});
