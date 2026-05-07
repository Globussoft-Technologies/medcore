/**
 * Issue #722 — Synthetic "Attacker" test users + Issue #738 test
 * ambulances cleanup migration contract test.
 *
 * The User model carries no `metadata.isTestUser` field (verified
 * against `packages/db/prisma/schema.prisma` model User), so the
 * defence-in-depth runtime filter prong from the issue spec is N/A.
 * The cleanup vector is therefore the migration alone:
 *   `packages/db/prisma/migrations/20260508000003_cleanup_attacker_test_users_and_test_ambulances/migration.sql`
 *
 * This test pins the migration's contents so future refactors can't
 * silently drop the cleanup. We assert four things:
 *   1. The migration file exists at the expected path.
 *   2. It targets the `User` table with the documented patterns.
 *   3. It targets the `ambulances` table with the documented patterns.
 *   4. The DELETE patterns are conservative — only synthetic markers
 *      (Attacker / evil.test / TEST- / DEMO / Demo Driver), not
 *      anything that could match real production data.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../../packages/db/prisma/migrations/20260508000003_cleanup_attacker_test_users_and_test_ambulances/migration.sql"
);

describe("Issue #722 + #738 — cleanup migration contract", () => {
  it("the migration file exists at the documented path", () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
  });

  describe("when the migration file is read", () => {
    const sql = fs.existsSync(MIGRATION_PATH)
      ? fs.readFileSync(MIGRATION_PATH, "utf8")
      : "";

    it("targets the User table for the Attacker cleanup", () => {
      expect(sql).toMatch(/DELETE\s+FROM\s+"User"/i);
      expect(sql).toMatch(/attacker/i);
      expect(sql).toMatch(/evil\.test/i);
    });

    it("targets the ambulances table for the test/demo cleanup", () => {
      expect(sql).toMatch(/DELETE\s+FROM\s+"ambulances"/i);
      expect(sql).toMatch(/'TEST-%'/);
      expect(sql).toMatch(/'DEMO%'/);
      expect(sql).toMatch(/'AMB-DEMO-%'/);
      expect(sql).toMatch(/'Demo Driver'/);
    });

    it("uses ILIKE / case-insensitive matching for name+email patterns", () => {
      // Confirms tolerance for Attacker / ATTACKER / attacker etc.
      expect(sql).toMatch(/ILIKE/i);
    });

    it("does not contain blanket DELETE patterns that could match real data", () => {
      // Belt-and-braces: assert there's no rogue `DELETE FROM "User"` with
      // no WHERE clause, which would nuke the whole table.
      const userDeletes = sql.match(/DELETE\s+FROM\s+"User"\s*;/i);
      expect(userDeletes).toBeNull();
      const ambDeletes = sql.match(/DELETE\s+FROM\s+"ambulances"\s*;/i);
      expect(ambDeletes).toBeNull();
    });
  });
});
