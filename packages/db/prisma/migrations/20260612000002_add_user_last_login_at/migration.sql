-- Add a first-class `lastLoginAt` column on users, stamped on every successful
-- login. The super-admin Tenants list reads MAX(lastLoginAt) per tenant for its
-- "Last login" column — reliable, unlike the prior audit-log derivation (audit
-- rows get archived and are tenant-scoped).

-- IF NOT EXISTS so a retried deploy after a P3009 recovery never errors on an
-- already-added column.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP(3);

-- Backfill from existing AUTH_LOGIN audit history so prior logins show up
-- immediately instead of "Never" until the next sign-in.
UPDATE "users" u
SET "lastLoginAt" = sub.max_login
FROM (
  SELECT "userId", MAX("createdAt") AS max_login
  FROM "audit_logs"
  WHERE "action" = 'AUTH_LOGIN' AND "userId" IS NOT NULL
  GROUP BY "userId"
) sub
WHERE u."id" = sub."userId";
