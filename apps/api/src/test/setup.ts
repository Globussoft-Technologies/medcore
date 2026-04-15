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
    `npx prisma db push --schema ${schemaPath} --force-reset --skip-generate`,
    {
      stdio: "ignore",
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL_TEST },
    }
  );

  // Seed minimal admin user
  const prisma = await getPrisma();
  await prisma.user.create({
    data: {
      email: "admin@test.local",
      name: "Test Admin",
      phone: "9999999999",
      passwordHash: await bcrypt.hash("password123", 4),
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
export async function getAuthToken(role: TestRole = "ADMIN"): Promise<string> {
  const prisma = await getPrisma();
  const email = `${role.toLowerCase()}@test.local`;
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        name: `Test ${role}`,
        phone: "9000000000",
        passwordHash: await bcrypt.hash("password123", 4),
        role: role as any,
      },
    });
  }
  return jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
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
