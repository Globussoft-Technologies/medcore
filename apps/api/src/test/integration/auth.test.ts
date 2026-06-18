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
import { it, expect, beforeAll, afterAll, describe } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { describeIfDB, resetDB, getPrisma, getAuthToken, TEST_DB_AVAILABLE } from "../setup";
import { expectAntiEnumeration } from "../helpers/security-assertions";

let app: any;

// Issues #706 + #713 (May 2026): public PATIENT registration now requires
// address + emergencyContact, and the password floor is 6 characters.
// This helper packs the registration body with the demographic fields so the
// existing tests continue to focus on the behaviour-under-test (anti-enum,
// identity-binding, mass-assignment) rather than re-spelling the demographic
// boilerplate at every call site.
const PATIENT_REGISTRATION_DEMOGRAPHICS = {
  address: "12 Test Lane, Bengaluru 560001",
  emergencyContact: {
    name: "Test Kin",
    phone: "9000000099",
    relationship: "Sibling",
  },
};
function patientBody(overrides: Record<string, unknown>) {
  return { ...PATIENT_REGISTRATION_DEMOGRAPHICS, ...overrides };
}

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
      .send(patientBody({
        name: "New User",
        email: "newuser@test.local",
        phone: "9111111111",
        password: "MedCoreT3st-2026",
        // No role submitted: should default to PATIENT.
      }));
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
      .send(patientBody({
        name: "Attacker A",
        email: "attacker-admin@test.local",
        phone: "9222222222",
        password: "MedCoreT3st-2026",
        role: "ADMIN", // <-- the attack
      }));
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
      .send(patientBody({
        name: "Attacker D",
        email: "attacker-doctor@test.local",
        phone: "9333333333",
        password: "MedCoreT3st-2026",
        role: "DOCTOR", // <-- different role, same vector
      }));
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
    await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Identity A",
      email: userAEmail,
      phone: "9444444441",
      password,
    }));
    await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Identity B",
      email: userBEmail,
      phone: "9444444442",
      password,
    }));

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
    await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Antienum Real",
      email: "antienum.real@test.local",
      phone: "9555555555",
      password: sharedPassword,
    }));

    // Probe with the SAME email — duplicate path.
    const realRes = await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Antienum Real Again",
      email: "antienum.real@test.local",
      phone: "9555555555",
      password: sharedPassword,
    }));

    // Probe with a fresh email — new-email path.
    const fakeRes = await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Antienum Fake",
      email: "antienum.fake@test.local",
      phone: "9555555556",
      password: sharedPassword,
    }));

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

  // ─── Per-tenant patient uniqueness on /register (2026-06) ───────────────
  //
  // Rules for PATIENT self-registration, scoped to the chosen tenant:
  //   • email      → unique within the tenant (Patient.contactEmail)
  //   • phone      → NOT unique on its own
  //   • name+phone → unique together within the tenant
  // All "duplicate" outcomes share the anti-enumeration 201 envelope so the
  // endpoint never leaks which (email) / (name+phone) pairs exist.
  it("treats a same-email re-registration in the tenant as a duplicate (no second patient row)", async () => {
    const prisma = await getPrisma();
    const pw = "MedCoreT3st-2026";
    const email = `pt.email.dup.${Date.now()}@test.local`;

    const first = await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Email Dup One", email, phone: "9610000001", password: pw,
    }));
    expect(first.status).toBe(201);

    // Same email, DIFFERENT name + phone → still a duplicate (email rule).
    const dup = await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Email Dup Two", email, phone: "9610000002", password: pw,
    }));
    expect(dup.status).toBe(201);
    expect(dup.body?.success).toBe(true);

    // Only ONE patient carries that contactEmail (the duplicate made no row).
    const rows = await prisma.patient.findMany({
      where: { contactEmail: { equals: email.toLowerCase(), mode: "insensitive" } },
      select: { id: true },
    });
    expect(rows.length).toBe(1);
  });

  it("allows the SAME phone with a DIFFERENT name (phone is not unique on its own)", async () => {
    const prisma = await getPrisma();
    const pw = "MedCoreT3st-2026";
    const phone = "9620000001";

    const a = await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Phone Share Parent", email: `pt.psh.a.${Date.now()}@test.local`, phone, password: pw,
    }));
    expect(a.status).toBe(201);

    const b = await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Phone Share Child", email: `pt.psh.b.${Date.now()}@test.local`, phone, password: pw,
    }));
    expect(b.status).toBe(201);

    // BOTH patients exist — the shared phone did not block the second.
    const rows = await prisma.patient.findMany({
      where: { user: { phone } },
      select: { id: true },
    });
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("treats same name + same phone in the tenant as a duplicate (no second row)", async () => {
    const prisma = await getPrisma();
    const pw = "MedCoreT3st-2026";
    const name = "Name Phone Twin";
    const phone = "9630000001";

    const first = await request(app).post("/api/v1/auth/register").send(patientBody({
      name, email: `pt.np.a.${Date.now()}@test.local`, phone, password: pw,
    }));
    expect(first.status).toBe(201);

    // Same name + same phone, DIFFERENT email → duplicate (name+phone rule).
    const dup = await request(app).post("/api/v1/auth/register").send(patientBody({
      name, email: `pt.np.b.${Date.now()}@test.local`, phone, password: pw,
    }));
    expect(dup.status).toBe(201);

    const rows = await prisma.patient.findMany({
      where: { user: { name: { equals: name, mode: "insensitive" }, phone } },
      select: { id: true },
    });
    expect(rows.length).toBe(1);
  });

  // ─── Issue #489 (XSS in name + age bounds on /register) ─────────────────
  //
  // Pre-fix: name="<script>alert(1)</script>" and age=-5 sailed through
  // validation and persisted to the DB. Post-fix: the schema rejects HTML
  // markers via containsHtmlOrScript and bounds age to [1, 150].
  it("rejects XSS payload in name on /register (#489)", async () => {
    const res = await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "<script>alert(1)</script>",
      email: "xss.name@test.local",
      phone: "9666666661",
      password: "MedCoreT3st-2026",
    }));
    expect(res.status).toBe(400);
    // Field-shaped error — the schema or sanitizer surfaces a clear message.
    const errStr = JSON.stringify(res.body);
    expect(errStr.toLowerCase()).toMatch(/name|html|tag/);
    // Critical: no token issued; no `data.tokens` block on a rejection path.
    expect(res.body?.data?.tokens).toBeFalsy();
  });

  it("rejects negative age on /register (#489)", async () => {
    const res = await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Bounded Age",
      email: "age.negative@test.local",
      phone: "9666666662",
      password: "MedCoreT3st-2026",
      age: -5,
    }));
    expect(res.status).toBe(400);
    const errStr = JSON.stringify(res.body).toLowerCase();
    expect(errStr).toMatch(/age/);
  });

  it("rejects out-of-range age on /register (#489)", async () => {
    const res = await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Bounded Age Two",
      email: "age.toobig@test.local",
      phone: "9666666663",
      password: "MedCoreT3st-2026",
      age: 200,
    }));
    expect(res.status).toBe(400);
    const errStr = JSON.stringify(res.body).toLowerCase();
    expect(errStr).toMatch(/age/);
  });

  // ─── Issue #493 (forgot-password + reset-password hardening) ────────────
  //
  // Two adversarial vectors closed in this block:
  //
  //   1. Anti-enumeration on BOTH the request side (/forgot-password) and
  //      the submit side (/reset-password). The earlier auth-edges.test.ts
  //      coverage only checked status==200 for unknown email on the request
  //      side and never compared the response shapes to a known email. And
  //      the submit side had no anti-enumeration coverage at all — a junk
  //      code against a known email vs an unknown email could have leaked
  //      registration state.
  //   2. Strong-password rules on the reset-submit endpoint. Pre-#493 the
  //      reset flow could be used as a back-door to set a weak password
  //      (e.g. "password", "123456", or any 6-char string) because the
  //      coverage focused on /register and never pinned the rule on
  //      /reset-password. We now assert weak passwords return 400 with a
  //      field-shaped error and a strong password is accepted (and actually
  //      logs in afterwards).
  it("does not leak email registration state on /forgot-password (#493)", async () => {
    // Seed a real account.
    await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Forgot Real",
      email: "forgot.real@test.local",
      phone: "9777777771",
      password: "MedCoreT3st-2026",
    }));

    const realRes = await request(app).post("/api/v1/auth/forgot-password").send({
      email: "forgot.real@test.local",
    });
    const fakeRes = await request(app).post("/api/v1/auth/forgot-password").send({
      email: "forgot.absent@test.local",
    });

    // Status, success flag, and error string MUST be identical.
    expectAntiEnumeration(realRes, fakeRes, [
      "status",
      "body.success",
      "body.error",
    ]);
    expect(realRes.status).toBe(200);
    expect(fakeRes.status).toBe(200);
    expect(realRes.body?.success).toBe(true);
    expect(fakeRes.body?.success).toBe(true);
    // Even the message string should match, byte for byte — any divergence
    // here would let an attacker enumerate registered emails.
    expect(realRes.body?.data?.message).toBe(fakeRes.body?.data?.message);
  });

  it("does not leak email registration state on /reset-password bad-code path (#493)", async () => {
    // Seed an account so we have a known email to probe against. We do NOT
    // request a real reset code — we want to compare the bad-code-vs-known
    // and bad-code-vs-unknown-email paths.
    await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Reset Real",
      email: "reset.real@test.local",
      phone: "9777777772",
      password: "MedCoreT3st-2026",
    }));

    const realRes = await request(app).post("/api/v1/auth/reset-password").send({
      email: "reset.real@test.local",
      code: "000000",
      newPassword: "Br0nzeFalc0n",
    });
    const fakeRes = await request(app).post("/api/v1/auth/reset-password").send({
      email: "reset.absent@test.local",
      code: "000000",
      newPassword: "Br0nzeFalc0n",
    });

    expectAntiEnumeration(realRes, fakeRes, [
      "status",
      "body.success",
      "body.error",
    ]);
    expect(realRes.status).toBe(400);
    expect(fakeRes.status).toBe(400);
    expect(realRes.body?.error).toBe(fakeRes.body?.error);
  });

  it("rejects weak newPassword on /reset-password (6-char) (#493)", async () => {
    // 400 from the schema layer — the route handler never runs. Email here
    // is incidental; the schema fires first.
    const res = await request(app).post("/api/v1/auth/reset-password").send({
      email: "anyone@test.local",
      code: "123456",
      newPassword: "abc12", // 5 chars — under the 8-char floor
    });
    expect(res.status).toBe(400);
    const errStr = JSON.stringify(res.body).toLowerCase();
    expect(errStr).toMatch(/password|8 characters|too weak/);
  });

  it("rejects denylisted newPassword on /reset-password ('password') (#493)", async () => {
    const res = await request(app).post("/api/v1/auth/reset-password").send({
      email: "anyone@test.local",
      code: "123456",
      newPassword: "password",
    });
    expect(res.status).toBe(400);
    expect(res.body?.success).toBeFalsy();
  });

  it("rejects classic '123456' newPassword on /reset-password (#493)", async () => {
    const res = await request(app).post("/api/v1/auth/reset-password").send({
      email: "anyone@test.local",
      code: "123456",
      newPassword: "123456",
    });
    expect(res.status).toBe(400);
    expect(res.body?.success).toBeFalsy();
  });

  // ─── Registration password floor is 6 chars (relaxed from 12, 2026-06) ──
  //
  // The /register strict password still requires letter + digit + denylist,
  // but the length floor is now 6. A 5-char password (under the floor) must
  // still be rejected; 6+ with letter+digit is accepted (covered by the
  // happy-path register test above).
  it("rejects sub-6-char password on /register", async () => {
    const res = await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Short Pass",
      email: "shortpw@test.local",
      phone: "9123450001",
      password: "Ab12c", // 5 chars — under the 6-char floor
    }));
    expect(res.status).toBe(400);
    const errStr = JSON.stringify(res.body).toLowerCase();
    expect(errStr).toMatch(/password|6 characters/);
  });

  it("rejects denylisted 'password' on /register (#706 — denylist)", async () => {
    const res = await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Common Pass",
      email: "commonpw@test.local",
      phone: "9123450002",
      password: "password", // rejected by the common-password denylist
    }));
    expect(res.status).toBe(400);
    expect(res.body?.success).toBeFalsy();
  });

  // ─── Issues #688 + #668 (admin Add-Staff also enforces strict password) ─
  //
  // Admin staff creation hits the same /auth/register endpoint with a
  // Bearer admin token (so `resolveRegistrationRole` honours a non-PATIENT
  // role from the body). The strict register password schema is shared,
  // so a weak password must be rejected on the staff path too — otherwise
  // the Add-Staff form ships trivially weak credentials for clinical
  // accounts. These tests pin the rejection contract on the staff path
  // specifically so a future regression that splits the staff-create
  // surface off /register (or replaces the schema) is caught immediately.
  it("#688 admin staff-create on /register rejects a sub-6-char password", async () => {
    const adminLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password: "MedCoreT3st-2026" });
    expect(adminLogin.status).toBe(200);
    const adminBearer = adminLogin.body?.data?.tokens?.accessToken;
    expect(adminBearer).toBeTruthy();

    const res = await request(app)
      .post("/api/v1/auth/register")
      .set("Authorization", `Bearer ${adminBearer}`)
      .send(patientBody({
        name: "Weak Pass Nurse",
        email: "weakpw.nurse@test.local",
        phone: "9123456001",
        password: "Ab12c", // 5 chars — under the (now 6-char) floor
        role: "NURSE",
      }));
    expect(res.status).toBe(400);
    const errStr = JSON.stringify(res.body).toLowerCase();
    expect(errStr).toMatch(/password|6 characters/);
  });

  // ─── Issue #991 (admin staff-create via cookie-only auth) ──────────────
  //
  // Since #477 the web client stores the access token in an httpOnly
  // `medcore_at` cookie and never adds an Authorization: Bearer header.
  // resolveRegistrationRole previously only consulted the header, so
  // every staff-create POST from the web UI was demoted to PATIENT,
  // which then tripped the PATIENT-only address + emergencyContact gate
  // and returned 400 with messages for fields the staff form does not
  // collect. Pin the cookie-path behaviour here so the regression is
  // caught immediately.
  it("#991 admin staff-create on /register accepts cookie-only auth (no Bearer header)", async () => {
    const adminLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password: "MedCoreT3st-2026" });
    expect(adminLogin.status).toBe(200);
    // Extract the medcore_at Set-Cookie header — supertest returns it as
    // either a string or array depending on Node version.
    const rawCookies = adminLogin.headers["set-cookie"];
    const cookies = Array.isArray(rawCookies)
      ? rawCookies
      : rawCookies
        ? [rawCookies]
        : [];
    const at = cookies.find((c: string) => c.startsWith("medcore_at="));
    expect(at).toBeDefined();
    const cookieHeader = at!.split(";")[0];

    // Mirror the web form's payload exactly — only the 5 fields the
    // Create-Staff form exposes. NO address, NO emergencyContact.
    // NO Authorization header.
    const res = await request(app)
      .post("/api/v1/auth/register")
      .set("Cookie", cookieHeader)
      .send({
        name: "Cookie Auth Doctor",
        email: "cookie.doctor@test.local",
        phone: "9123461001",
        password: "MedCoreT3st-2026",
        role: "DOCTOR",
      });

    expect(res.status).toBe(201);
    expect(res.body?.data?.user?.role).toBe("DOCTOR");
  });

  it("SUPER_ADMIN staff-create on /register succeeds without patient-only fields", async () => {
    // A SUPER_ADMIN was being demoted to PATIENT (resolveRegistrationRole only
    // honoured "ADMIN"), tripping the PATIENT-only address + emergencyContact
    // gate → 400 "Address is required". SUPER_ADMIN must be able to create
    // staff with just the Create-Staff form fields (no address / emergency).
    const superToken = await getAuthToken("SUPER_ADMIN");
    const res = await request(app)
      .post("/api/v1/auth/register")
      .set("Authorization", `Bearer ${superToken}`)
      .send({
        name: "Super Created Doctor",
        email: "super.doctor@test.local",
        phone: "9123461777",
        password: "MedCoreT3st-2026",
        role: "DOCTOR",
      });

    expect(res.status).toBe(201);
    expect(res.body?.data?.user?.role).toBe("DOCTOR");
  });

  it("admin/super-admin staff-create on /register issues NO session (session-swap regression)", async () => {
    // Regression: /register used to set the NEWLY-created user's auth cookies
    // on the response, so a super-admin who created a doctor was silently
    // logged in AS that doctor on the next refresh (and the staff list then
    // reloaded under the wrong session → blank rows). An admin-initiated
    // create must return the user but NO tokens and NO medcore_at cookie, so
    // the admin's own session is left untouched.
    const superToken = await getAuthToken("SUPER_ADMIN");
    const res = await request(app)
      .post("/api/v1/auth/register")
      .set("Authorization", `Bearer ${superToken}`)
      .send({
        name: "No Session Doctor",
        email: "nosession.doctor@test.local",
        phone: "9123461888",
        password: "MedCoreT3st-2026",
        role: "DOCTOR",
      });
    expect(res.status).toBe(201);
    expect(res.body?.data?.user?.role).toBe("DOCTOR");
    // No tokens in the body…
    expect(res.body?.data?.tokens).toBeFalsy();
    // …and no auth cookie set on the response (it would clobber the admin's).
    const rawCookies = res.headers["set-cookie"];
    const cookies = Array.isArray(rawCookies)
      ? rawCookies
      : rawCookies
        ? [rawCookies]
        : [];
    expect(cookies.some((c: string) => c.startsWith("medcore_at="))).toBe(false);
  });

  it("rejects /register under a SUSPENDED tenant with a clear 400 (no silent default fallback)", async () => {
    // A suspended tenant must not silently absorb new users into the default
    // tenant — registration fails loudly so the admin reactivates it first.
    // Use a super-admin + role=DOCTOR so the PATIENT-only address gate is
    // skipped, and pass the tenant via the body so the handler's suspended
    // guard (which checks body tenantId OR X-Tenant-Id) fires.
    const prisma = await getPrisma();
    const suspended = await prisma.tenant.create({
      data: {
        name: "Suspended Hospital — register guard",
        subdomain: `suspended-reg-${Date.now()}`,
        plan: "BASIC",
        active: false,
      },
    });
    const superToken = await getAuthToken("SUPER_ADMIN");
    const res = await request(app)
      .post("/api/v1/auth/register")
      .set("Authorization", `Bearer ${superToken}`)
      .send({
        name: "Suspended Tenant Doctor",
        email: "suspended.doctor@test.local",
        phone: "9123461999",
        password: "MedCoreT3st-2026",
        role: "DOCTOR",
        tenantId: suspended.id,
      });
    expect(res.status).toBe(400);
    expect(res.body?.success).toBeFalsy();
    expect(JSON.stringify(res.body).toLowerCase()).toMatch(/suspend/);
  });

  it("#668 admin staff-create on /register rejects denylisted 'password123'", async () => {
    const adminLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password: "MedCoreT3st-2026" });
    const adminBearer = adminLogin.body?.data?.tokens?.accessToken;

    const res = await request(app)
      .post("/api/v1/auth/register")
      .set("Authorization", `Bearer ${adminBearer}`)
      .send(patientBody({
        name: "Denylisted Doctor",
        email: "denylist.doctor@test.local",
        phone: "9123456002",
        password: "password123", // denylist
        role: "DOCTOR",
      }));
    expect(res.status).toBe(400);
    expect(res.body?.success).toBeFalsy();
  });

  // ─── Issue #707 (registration age range tightened to [0, 130]) ──────────
  it("accepts age=0 on /register (#707 — newborn)", async () => {
    const res = await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Newborn Patient",
      email: "newborn.zero@test.local",
      phone: "9123450003",
      password: "MedCoreT3st-2026",
      age: 0,
    }));
    expect(res.status).toBe(201);
  });

  it("rejects age=200 on /register (#707 — over the 130 ceiling)", async () => {
    const res = await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Methuselah",
      email: "methuselah@test.local",
      phone: "9123450004",
      password: "MedCoreT3st-2026",
      age: 200,
    }));
    expect(res.status).toBe(400);
    const errStr = JSON.stringify(res.body).toLowerCase();
    expect(errStr).toMatch(/age|130/);
  });

  // ─── Issue #708 (strict email format on /register) ──────────────────────
  it.each([
    ["abc", "no-@-or-domain"],
    ["a@", "trailing-@"],
    ["a@b", "no-tld"],
    ["@b.com", "no-local-part"],
    ["a b@c.com", "embedded-whitespace"],
  ])("rejects malformed email %s (%s) on /register (#708)", async (email) => {
    const res = await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Email Edge",
      email,
      phone: "9123450005",
      password: "MedCoreT3st-2026",
    }));
    expect(res.status).toBe(400);
  });

  // ─── Issue #712 (strict email format on /forgot-password) ───────────────
  it("rejects malformed email on /forgot-password (#712)", async () => {
    const res = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email: "a@b" });
    expect(res.status).toBe(400);
  });

  it("rejects whitespace-tainted email on /forgot-password (#712)", async () => {
    const res = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email: "a b@c.com" });
    expect(res.status).toBe(400);
  });

  // ─── Issue #713 (PATIENT registration requires phone+address+emergency) ─
  it("rejects PATIENT /register missing address (#713)", async () => {
    const res = await request(app).post("/api/v1/auth/register").send({
      name: "No Address",
      email: "no-address@test.local",
      phone: "9123450006",
      password: "MedCoreT3st-2026",
      emergencyContact: {
        name: "Kin",
        phone: "9000000033",
        relationship: "Sibling",
      },
      // address omitted
    });
    expect(res.status).toBe(400);
    const errStr = JSON.stringify(res.body).toLowerCase();
    expect(errStr).toMatch(/address/);
  });

  it("rejects PATIENT /register missing emergencyContact (#713)", async () => {
    const res = await request(app).post("/api/v1/auth/register").send({
      name: "No Kin",
      email: "no-kin@test.local",
      phone: "9123450007",
      password: "MedCoreT3st-2026",
      address: "11 Test Lane, Test City",
      // emergencyContact omitted
    });
    expect(res.status).toBe(400);
    const errStr = JSON.stringify(res.body).toLowerCase();
    expect(errStr).toMatch(/emergency/);
  });

  it("persists phone, address, and emergencyContact on PATIENT /register (#713)", async () => {
    // Register with the full demographic block, then read back via /auth/me
    // and Patient row to verify the values are stored, not just accepted.
    const email = "demographics.persist@test.local";
    const res = await request(app).post("/api/v1/auth/register").send({
      name: "Demographics Persist",
      email,
      phone: "9123450008",
      password: "MedCoreT3st-2026",
      address: "99 Demographics Drive, Test City",
      emergencyContact: {
        name: "Demographics Kin",
        phone: "9000000022",
        relationship: "Parent",
      },
    });
    expect(res.status).toBe(201);

    const prisma = await getPrisma();
    const user = await prisma.user.findUnique({
      where: { email },
      include: { patient: true },
    });
    expect(user?.phone).toBe("9123450008");
    expect(user?.patient?.address).toBe("99 Demographics Drive, Test City");
    expect(user?.patient?.emergencyContactName).toBe("Demographics Kin");
    expect(user?.patient?.emergencyContactPhone).toBe("9000000022");
    expect(user?.patient?.emergencyContactRelationship).toBe("Parent");
  });

  // ─── Issue #714 (open-redirect via login `next=` parameter) ─────────────
  //
  // The login handler now sanitizes any `next` value supplied via body or
  // query and echoes the safe path back as `redirectUrl`. Off-origin
  // / protocol-relative / backslash variants collapse to "/dashboard".
  it("collapses absolute http(s) `next` to /dashboard on /login (#714)", async () => {
    // Seed a real user so the credential path succeeds — the sanitizer
    // runs only on the success branch (otherwise we'd be telling
    // un-authenticated callers where the dashboard lives).
    const email = "redirect.absolute@test.local";
    const password = "MedCoreT3st-2026";
    await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Redirect Absolute",
      email,
      phone: "9123450009",
      password,
    }));
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password, next: "https://evil.example.com/harvest" });
    expect(res.status).toBe(200);
    expect(res.body?.data?.redirectUrl).toBe("/dashboard");
  });

  it("collapses protocol-relative `next` to /dashboard on /login (#714)", async () => {
    const email = "redirect.protorel@test.local";
    const password = "MedCoreT3st-2026";
    await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Redirect ProtoRel",
      email,
      phone: "9123450010",
      password,
    }));
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password, next: "//evil.example.com/harvest" });
    expect(res.status).toBe(200);
    expect(res.body?.data?.redirectUrl).toBe("/dashboard");
  });

  it("preserves a same-origin relative `next` on /login (#714)", async () => {
    const email = "redirect.relative@test.local";
    const password = "MedCoreT3st-2026";
    await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Redirect Relative",
      email,
      phone: "9123450011",
      password,
    }));
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password, next: "/dashboard/billing" });
    expect(res.status).toBe(200);
    expect(res.body?.data?.redirectUrl).toBe("/dashboard/billing");
  });

  it("accepts a strong newPassword on /reset-password and rotates the password end-to-end (#493)", async () => {
    // Full flow: register → request reset code → look up code in DB →
    // submit reset with strong password → log in with the new password.
    const email = "reset.flow@test.local";
    const oldPassword = "MedCoreT3st-2026";
    const newPassword = "Sm0keSign4lDelta"; // letter+digit, 16 chars, not denylisted

    await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Reset Flow",
      email,
      phone: "9777777773",
      password: oldPassword,
    }));

    const fp = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email });
    expect(fp.status).toBe(200);

    // The reset code is persisted in the DB on the known-email branch. Pull
    // the latest unused code for this user so we can submit it.
    const prisma = await getPrisma();
    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).toBeTruthy();
    const codeRow = await prisma.passwordResetCode.findFirst({
      where: { userId: user.id, usedAt: null },
      orderBy: { createdAt: "desc" },
    });
    expect(codeRow?.code).toMatch(/^\d{6}$/);

    const reset = await request(app).post("/api/v1/auth/reset-password").send({
      email,
      code: codeRow!.code,
      newPassword,
    });
    expect(reset.status).toBe(200);
    expect(reset.body?.success).toBe(true);

    // The old password must no longer log in.
    const loginOld = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password: oldPassword });
    expect(loginOld.status).toBeGreaterThanOrEqual(400);

    // The new password must log in.
    const loginNew = await request(app)
      .post("/api/v1/auth/login")
      .send({ email, password: newPassword });
    expect(loginNew.status).toBe(200);
    expect(loginNew.body?.data?.tokens?.accessToken).toBeTruthy();
  });

  // ─── Issues #284, #666, #686 (Add Staff name — SQL-injection vector) ────
  //
  // The Add Staff form on /dashboard/users POSTs to /auth/register with a
  // Bearer admin token (so resolveRegistrationRole honours the non-PATIENT
  // role from the body). Pre-fix, the schema-level `name` field only
  // refined against `containsHtmlOrScript`, which catches `<script>` but
  // NOT SQL-style payloads like `Robert'); DROP TABLE--` or `1' OR '1'='1`.
  // Those strings persisted to the DB unchanged. The strict regex in
  // `strictRegisterSchema` now rejects any character outside the canonical
  // letters-spaces-".-'" set.
  it("#284 rejects SQL-injection payload `Robert'); DROP TABLE--` in name on /register", async () => {
    const adminLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password: "MedCoreT3st-2026" });
    const adminBearer = adminLogin.body?.data?.tokens?.accessToken;

    const res = await request(app)
      .post("/api/v1/auth/register")
      .set("Authorization", `Bearer ${adminBearer}`)
      .send(patientBody({
        name: "Robert'); DROP TABLE--",
        email: "sqli.bobby@test.local",
        phone: "9123460001",
        password: "MedCoreT3st-2026",
        role: "NURSE",
      }));
    expect(res.status).toBe(400);
    const errStr = JSON.stringify(res.body).toLowerCase();
    expect(errStr).toMatch(/name|invalid|character/);
    // Critical: no token issued; no user created.
    expect(res.body?.data?.tokens).toBeFalsy();
  });

  it("#666 rejects SQL-tautology payload `1' OR '1'='1` in name on /register", async () => {
    const adminLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password: "MedCoreT3st-2026" });
    const adminBearer = adminLogin.body?.data?.tokens?.accessToken;

    const res = await request(app)
      .post("/api/v1/auth/register")
      .set("Authorization", `Bearer ${adminBearer}`)
      .send(patientBody({
        name: "1' OR '1'='1",
        email: "sqli.tauto@test.local",
        phone: "9123460002",
        password: "MedCoreT3st-2026",
        role: "DOCTOR",
      }));
    expect(res.status).toBe(400);
    const errStr = JSON.stringify(res.body).toLowerCase();
    expect(errStr).toMatch(/name|invalid|character/);
    expect(res.body?.data?.tokens).toBeFalsy();
  });

  // ─── Issues #667, #687 (Add Staff name — XSS payload) ──────────────────
  //
  // `<script>alert(1)</script>` was previously caught by the
  // `containsHtmlOrScript` refine — but only because of the `<` / `>`. The
  // strict regex catches it via the same character-class check that catches
  // SQL injection. Defence in depth: BOTH rules reject it.
  it("#667 rejects `<script>alert(1)</script>` in staff name on /register", async () => {
    const adminLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password: "MedCoreT3st-2026" });
    const adminBearer = adminLogin.body?.data?.tokens?.accessToken;

    const res = await request(app)
      .post("/api/v1/auth/register")
      .set("Authorization", `Bearer ${adminBearer}`)
      .send(patientBody({
        name: "<script>alert(1)</script>",
        email: "xss.staff.script@test.local",
        phone: "9123460003",
        password: "MedCoreT3st-2026",
        role: "PHARMACIST",
      }));
    expect(res.status).toBe(400);
    const errStr = JSON.stringify(res.body).toLowerCase();
    expect(errStr).toMatch(/name|invalid|character|html|tag/);
    expect(res.body?.data?.tokens).toBeFalsy();
  });

  // ─── Issue #623 (change-password — validate new-password BEFORE current) ─
  //
  // Pharmacist (and every other authed role) reported that submitting a
  // weak new password with a wrong current password returned "Current
  // password is incorrect" — masking the more actionable "new password is
  // too weak" message. Fix: extend `changePasswordSchema` so the schema's
  // `strictRegisterPassword` rule (>=12 + letter + digit + denylist) runs
  // BEFORE the bcrypt-compare branch in the route handler. Zod's
  // `validate(...)` middleware runs first — so a weak new password is
  // rejected with a field-shaped 400 regardless of whether the current
  // password is right or wrong. The error message is about the NEW
  // password, not "Current password is incorrect".
  it("#623 rejects weak newPassword (6-char) on /auth/change-password BEFORE checking current", async () => {
    // Register a fresh user so we have a valid bearer + a known current
    // password to NOT match.
    const reg = await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Change Pwd Weak",
      email: "change.pwd.weak@test.local",
      phone: "9123460004",
      password: "MedCoreT3st-2026",
    }));
    expect(reg.status).toBe(201);
    const accessToken = reg.body?.data?.tokens?.accessToken;
    expect(accessToken).toBeTruthy();

    // Submit (deliberately wrong current, weak new). Pre-fix: the response
    // was "Current password is incorrect". Post-fix: the schema rejects
    // the weak newPassword first.
    const res = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        currentPassword: "definitely-not-the-real-one",
        newPassword: "abcdef", // 6 chars — under the 12-char floor
      });
    expect(res.status).toBe(400);
    const errStr = JSON.stringify(res.body).toLowerCase();
    // The message must reference the new password's weakness, NOT
    // "current password is incorrect".
    expect(errStr).toMatch(/password|12 characters|too weak|too common/);
    expect(errStr).not.toMatch(/current password is incorrect/);
  });

  it("#623 rejects denylisted newPassword on /auth/change-password BEFORE checking current", async () => {
    const reg = await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Change Pwd Common",
      email: "change.pwd.common@test.local",
      phone: "9123460005",
      password: "MedCoreT3st-2026",
    }));
    expect(reg.status).toBe(201);
    const accessToken = reg.body?.data?.tokens?.accessToken;

    const res = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        currentPassword: "definitely-not-the-real-one",
        newPassword: "password1234", // denylist + would-be-12-char
      });
    expect(res.status).toBe(400);
    const errStr = JSON.stringify(res.body).toLowerCase();
    expect(errStr).not.toMatch(/current password is incorrect/);
  });

  it("#623 still accepts a strong newPassword (with the correct current) on /auth/change-password", async () => {
    // Sanity: the strict schema doesn't break the happy path.
    const oldPassword = "MedCoreT3st-2026";
    const newPassword = "Cr0ssr0adsCipher!"; // 17 chars, letter+digit, not denylisted

    const reg = await request(app).post("/api/v1/auth/register").send(patientBody({
      name: "Change Pwd Happy",
      email: "change.pwd.happy@test.local",
      phone: "9123460006",
      password: oldPassword,
    }));
    expect(reg.status).toBe(201);
    const accessToken = reg.body?.data?.tokens?.accessToken;

    const res = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        currentPassword: oldPassword,
        newPassword,
      });
    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);

    // The new password must log in.
    const loginNew = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "change.pwd.happy@test.local", password: newPassword });
    expect(loginNew.status).toBe(200);
  });
});

// ─── Issue #478 (login rate-limit) ────────────────────────────────────────
//
// Mounted as a SEPARATE describe block because we need to flip
// ENABLE_LOGIN_RATELIMIT_IN_TESTS=true BEFORE the auth router constructs
// its loginLimiter. The main describe block constructs the router with
// the limiter as a no-op (test-suite-wide default), so we rebuild a fresh
// app instance here with the env flag set.
//
// Cleanup nuance (vitest singleFork): the auth router caches its login
// limiter at module scope. Once the real (non-no-op) limiter is
// constructed inside this describe's beforeAll, the cache persists for
// the whole worker — including subsequent integration test files that
// share this fork (auth-edges, auth-session-bleed, users, ...). Without
// the afterAll reset below, the real limiter's 127.0.0.1 quota
// accumulates and cascades 429s into those files. The
// `__resetLoginLimiterForTests` hook drops the cache so the next caller
// rebuilds the limiter with the (now-unset) env flag → no-op middleware,
// matching the test-suite-wide default.
const describeRateLimit = TEST_DB_AVAILABLE ? describe : describe.skip;
describeRateLimit("Auth API — /login rate-limit (#478)", () => {
  let rlApp: any;

  beforeAll(async () => {
    process.env.ENABLE_LOGIN_RATELIMIT_IN_TESTS = "true";
    // Drop any limiter the earlier main-describe blocks may have lazily
    // constructed (with the env flag unset → no-op). Forces the next
    // /login request inside this describe to rebuild against env=true.
    const auth = await import("../../routes/auth");
    auth.__resetLoginLimiterForTests();
    // Re-import the app builder fresh so the new env var is read by the
    // route module's loginLimiter construction. `await import()` returns
    // the module-cached value, but vitest's resetModules / dynamic
    // re-import via the buildApp() factory gives us a per-test instance.
    const mod = await import("../../app");
    rlApp = mod.buildApp().app;
  });

  afterAll(async () => {
    // Restore the test-suite-wide default for any subsequent file that
    // shares this fork. Order: drop the env flag first, then null the
    // cache — so the next /login call sees env=false and rebuilds a
    // no-op limiter.
    delete process.env.ENABLE_LOGIN_RATELIMIT_IN_TESTS;
    const auth = await import("../../routes/auth");
    auth.__resetLoginLimiterForTests();
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
