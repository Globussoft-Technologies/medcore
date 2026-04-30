// Issues #422 / #441 — session/role bleed regression tests.
//
// The production reports said: logging in as Doctor sometimes seated the
// user as Admin or Patient, and the wrong JWT was observed in localStorage
// after a fresh login. Most of the bleed lived on the frontend (covered in
// apps/web/src/lib/__tests__/store.test.ts), but we ALSO need a backend
// guarantee that:
//
//   1. Two concurrent /auth/login calls for different users always return
//      tokens that decode to the matching user-id + role pair (i.e. the
//      handler does not share state across requests).
//   2. /auth/me with token A returns user A — never user B — even when
//      token B was minted milliseconds later for a different user.
//   3. The role baked into the access token always matches the role in
//      the User row at the time of login (no leakage from a previous
//      caller's role variable).
//
// Skipped unless DATABASE_URL_TEST is set, like the other integration tests.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import bcrypt from "bcryptjs";

let app: any;

const DOCTOR_EMAIL = "bleed.doctor@test.local";
const PATIENT_EMAIL = "bleed.patient@test.local";
const ADMIN_EMAIL = "bleed.admin@test.local";
const PASSWORD = "MedCoreT3st-2026";

async function seedUser(email: string, role: string) {
  const prisma = await getPrisma();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      name: `Bleed ${role}`,
      phone: "9000000000",
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      role: role as any,
    },
  });
}

describeIfDB("Auth session-bleed (Issues #422/#441)", () => {
  beforeAll(async () => {
    await resetDB();
    await seedUser(DOCTOR_EMAIL, "DOCTOR");
    await seedUser(PATIENT_EMAIL, "PATIENT");
    await seedUser(ADMIN_EMAIL, "ADMIN");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("two concurrent logins for different users return correctly-scoped tokens", async () => {
    // Fire 6 logins in parallel — alternating Doctor and Patient — and
    // verify every returned access token decodes to the matching email
    // and role. If the handler shared a closure variable across requests
    // (the #441 hypothesis), this would surface as cross-talk.
    const reqs = [
      ["d", DOCTOR_EMAIL, "DOCTOR"],
      ["p", PATIENT_EMAIL, "PATIENT"],
      ["d", DOCTOR_EMAIL, "DOCTOR"],
      ["p", PATIENT_EMAIL, "PATIENT"],
      ["a", ADMIN_EMAIL, "ADMIN"],
      ["d", DOCTOR_EMAIL, "DOCTOR"],
    ] as const;

    const results = await Promise.all(
      reqs.map(([, email]) =>
        request(app)
          .post("/api/v1/auth/login")
          .send({ email, password: PASSWORD })
      )
    );

    for (let i = 0; i < reqs.length; i++) {
      const [, expectedEmail, expectedRole] = reqs[i];
      const res = results[i];
      expect(res.status, `login #${i} (${expectedEmail})`).toBe(200);
      const accessToken = res.body?.data?.tokens?.accessToken as string;
      expect(accessToken, `login #${i} returned no token`).toBeTruthy();
      const decoded = jwt.verify(
        accessToken,
        process.env.JWT_SECRET || "dev-secret"
      ) as { email: string; role: string; userId: string };
      expect(decoded.email).toBe(expectedEmail);
      expect(decoded.role).toBe(expectedRole);
      // The /auth/login response payload must also describe the correct
      // user (the frontend reads this directly into useAuthStore.user).
      expect(res.body.data.user.email).toBe(expectedEmail);
      expect(res.body.data.user.role).toBe(expectedRole);
    }
  });

  it("/auth/me with token-A returns user-A even after token-B was just minted", async () => {
    // Mint Doctor's token first, then immediately mint Patient's. Then call
    // /auth/me with the Doctor token — it must STILL return Doctor's record.
    // This guards against any req.user cache that might otherwise leak the
    // most-recently-authenticated user across requests.
    const doctorLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: DOCTOR_EMAIL, password: PASSWORD });
    const patientLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: PATIENT_EMAIL, password: PASSWORD });
    expect(doctorLogin.status).toBe(200);
    expect(patientLogin.status).toBe(200);

    const doctorToken = doctorLogin.body.data.tokens.accessToken;
    const patientToken = patientLogin.body.data.tokens.accessToken;
    expect(doctorToken).not.toBe(patientToken);

    // Fire BOTH /me calls in parallel with their respective tokens.
    const [meDoctor, mePatient] = await Promise.all([
      request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${doctorToken}`),
      request(app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${patientToken}`),
    ]);

    expect(meDoctor.status).toBe(200);
    expect(meDoctor.body.data.email).toBe(DOCTOR_EMAIL);
    expect(meDoctor.body.data.role).toBe("DOCTOR");

    expect(mePatient.status).toBe(200);
    expect(mePatient.body.data.email).toBe(PATIENT_EMAIL);
    expect(mePatient.body.data.role).toBe("PATIENT");
  });

  it("login response role always matches the User row's role", async () => {
    // Direct check: the role embedded in the access token and the role on
    // the response body's user object both come from the same DB row and
    // never from any other call's state.
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: DOCTOR_EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    const decoded = jwt.verify(
      res.body.data.tokens.accessToken,
      process.env.JWT_SECRET || "dev-secret"
    ) as { role: string; userId: string };
    expect(decoded.role).toBe("DOCTOR");
    expect(res.body.data.user.role).toBe("DOCTOR");

    const prisma = await getPrisma();
    const dbUser = await prisma.user.findUnique({
      where: { email: DOCTOR_EMAIL },
    });
    expect(decoded.userId).toBe(dbUser.id);
    expect(dbUser.role).toBe("DOCTOR");
  });
});
