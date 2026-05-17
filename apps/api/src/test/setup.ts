// Test helpers for integration tests. Only imported by tests that explicitly
// need a live database — tests that are pure (validation, services) MUST NOT
// import this file because it imports Prisma.
import { execSync } from "child_process";
import path from "path";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

// Lazy import so non-DB tests do not pay the Prisma import cost.
let _prisma: any = null;
export async function getPrisma() {
  if (_prisma) return _prisma;
  const mod = await import("@medcore/db");
  _prisma = mod.prisma;
  return _prisma;
}

export const TEST_DB_AVAILABLE = !!process.env.DATABASE_URL_TEST;

/**
 * Hard reset the test DB by running `prisma db push --force-reset`. Only call
 * once per test file in `beforeAll`.
 */
export async function resetDB() {
  if (!TEST_DB_AVAILABLE) {
    throw new Error(
      "DATABASE_URL_TEST is not set — refusing to reset DB. " +
        "Set DATABASE_URL_TEST to run integration tests."
    );
  }
  const schemaPath = path.resolve(
    __dirname,
    "../../../../packages/db/prisma/schema.prisma"
  );
  execSync(
    `npx prisma db push --schema "${schemaPath}" --force-reset --skip-generate`,
    {
      stdio: "pipe",
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL_TEST,
        // Prisma requires explicit AI consent for --force-reset; this is always
        // the isolated test database (DATABASE_URL_TEST), never production.
        PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "Resetting test-only database for vitest integration suite",
      },
    }
  );

  // Seed minimal admin user
  const prisma = await getPrisma();
  await prisma.user.create({
    data: {
      email: "admin@test.local",
      name: "Test Admin",
      phone: "9999999999",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "ADMIN",
    },
  });
}

export type TestRole =
  | "ADMIN"
  | "DOCTOR"
  | "RECEPTION"
  | "NURSE"
  | "PATIENT"
  | "PHARMACIST"
  | "LAB_TECH";

/**
 * Creates a user with the requested role (if it doesn't already exist) and
 * returns a signed JWT. Tests can pass it as `Authorization: Bearer <token>`.
 */
/**
 * #895 (2026-05-17): default test tenant.
 *
 * The patients.ts front-door guard rejects POST /patients when
 * req.tenantId is missing, so test users MUST carry a tenantId in
 * their JWT for tenant-required write paths to work. Previously the
 * test seed left every User.tenantId NULL because pre-#895 routes
 * silently accepted null-tenant writes. We now seed a single
 * "Default Test Tenant" row once, stamp every test user with it,
 * and embed its id in the JWT — so tenantContextMiddleware resolves
 * req.tenantId on every authenticated test request without each
 * test having to set up its own tenant.
 */
const DEFAULT_TEST_TENANT_ID = "11111111-1111-4111-8111-111111111111";

async function ensureDefaultTestTenant(): Promise<string> {
  const prisma = await getPrisma();
  const existing = await prisma.tenant.findUnique({
    where: { id: DEFAULT_TEST_TENANT_ID },
  });
  if (existing) return existing.id;
  const created = await prisma.tenant.create({
    data: {
      id: DEFAULT_TEST_TENANT_ID,
      subdomain: "test-default",
      name: "Default Test Tenant",
      active: true,
    },
  });
  return created.id;
}

export async function getAuthToken(role: TestRole = "ADMIN"): Promise<string> {
  const prisma = await getPrisma();
  const tenantId = await ensureDefaultTestTenant();
  const email = `${role.toLowerCase()}@test.local`;
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        name: `Test ${role}`,
        phone: "9000000000",
        passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
        role: role as any,
        tenantId,
      },
    });
  } else if (!user.tenantId) {
    // Heal pre-#895 seeded users that don't carry a tenant yet.
    user = await prisma.user.update({
      where: { id: user.id },
      data: { tenantId },
    });
  }
  // For PATIENT role, ensure a linked Patient row exists. Several routes
  // (e.g. /ai/triage/start) call `prisma.patient.findFirst({ where: { userId } })`
  // and 400 "Please complete your patient profile" when no row matches.
  // Tests would otherwise need to scaffold this manually for every patient
  // case; centralising it here matches what `getAuthToken("ADMIN")` already
  // implies — that the returned token is *usable*.
  if (role === "PATIENT") {
    const existing = await prisma.patient.findFirst({ where: { userId: user.id } });
    if (!existing) {
      const count = await prisma.patient.count();
      await prisma.patient.create({
        data: {
          userId: user.id,
          mrNumber: `MR-TEST-${count + 1}`,
          dateOfBirth: new Date("1990-01-01"),
          gender: "MALE" as any,
        },
      });
    }
  }
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      // #895: must carry tenantId so tenantContextMiddleware resolves
      // req.tenantId and the patients.ts front-door guard passes.
      tenantId: user.tenantId ?? tenantId,
    },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" }
  );
}

/**
 * Vitest helper — describes a block that should only run when DATABASE_URL_TEST
 * is configured. Otherwise the suite is silently skipped so unit tests still
 * pass on a developer laptop without a Postgres instance.
 */
import { describe } from "vitest";
export const describeIfDB: typeof describe = TEST_DB_AVAILABLE ? describe : (describe.skip as any);
