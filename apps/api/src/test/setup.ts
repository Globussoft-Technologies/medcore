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

  // Seed minimal admin user under a default test tenant.
  // Issue #895: integration tests need a real tenant so JWTs minted by
  // getAuthToken() carry a non-null tenantId — the patient-create guard
  // (and the broader pattern documented in patients.ts) refuses 400
  // when the caller's JWT has no tenant context.
  const prisma = await getPrisma();
  const tenant = await ensureDefaultTestTenant(prisma);
  await prisma.user.create({
    data: {
      email: "admin@test.local",
      name: "Test Admin",
      phone: "9999999999",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "ADMIN",
      tenantId: tenant.id,
    },
  });
}

/**
 * Find-or-create the default test tenant. Idempotent so it's safe to call
 * from resetDB() AND from getAuthToken() (the latter for tests that skip
 * resetDB and just need a tenanted user).
 */
async function ensureDefaultTestTenant(prisma: any): Promise<{ id: string }> {
  const slug = "test-tenant";
  const existing = await prisma.tenant.findFirst({ where: { slug } });
  if (existing) return existing;
  return prisma.tenant.create({
    data: {
      name: "Test Tenant",
      slug,
      active: true,
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
export async function getAuthToken(role: TestRole = "ADMIN"): Promise<string> {
  const prisma = await getPrisma();
  const email = `${role.toLowerCase()}@test.local`;
  // Issue #895: every test User must be tenant-bound so the JWT carries a
  // real tenantId and the patient-create / future write-guards don't 400.
  const tenant = await ensureDefaultTestTenant(prisma);
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        name: `Test ${role}`,
        phone: "9000000000",
        passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
        role: role as any,
        tenantId: tenant.id,
      },
    });
  } else if (!(user as { tenantId?: string | null }).tenantId) {
    // Pre-#895 test user — backfill the tenant link so subsequent
    // getAuthToken() calls mint tenant-bearing JWTs.
    user = await prisma.user.update({
      where: { id: user.id },
      data: { tenantId: tenant.id },
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
  // Issue #895 (May 2026): patient-create (and a growing set of write
  // endpoints) now refuses 400 when the caller's JWT has no `tenantId`,
  // as a defence-in-depth against legacy tokens producing tenantId:null
  // rows. The find-or-create above guarantees user.tenantId is populated.
  const tenantId =
    (user as { tenantId?: string | null }).tenantId ?? tenant.id;
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      tenantId,
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
