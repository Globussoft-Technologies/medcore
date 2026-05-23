-- ================================================================
-- 20260523000005_pearl_user_invites
--
-- Pearl ERP Stage 1 §8.2 (gap row 213 closure, 2026-05-23):
-- "Invite via email → set password → assign roles". Adds the
-- UserInvite table that captures the "pending acceptance" state
-- between an ADMIN issuing an invite and the recipient
-- materialising their User row by setting a password.
--
-- TOTP enrolment + first-login walkthrough (also mentioned in the
-- row description) are deferred to a separate piece — this
-- migration ships only the email-invite + password-set leg.
--
-- Token storage: the `token` column holds the SHA-256 hex hash
-- of a 32-byte CSPRNG nonce. The raw nonce only ever leaves the
-- server in the outbound email body; a DB compromise therefore
-- cannot be used to assume any unaccepted invite.
--
-- Strictly additive: one new table, three FKs, two indexes. No
-- existing column is altered, no constraint dropped. Safe online.
-- ================================================================

CREATE TABLE "user_invites" (
    "id"              TEXT NOT NULL,
    "tenantId"        TEXT NOT NULL,
    "email"           TEXT NOT NULL,
    "role"            "Role" NOT NULL,
    "branchIds"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "token"           TEXT NOT NULL,
    "invitedByUserId" TEXT NOT NULL,
    "expiresAt"       TIMESTAMP(3) NOT NULL,
    "acceptedAt"      TIMESTAMP(3),
    "acceptedUserId"  TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_invites_token_key" ON "user_invites"("token");

CREATE INDEX "user_invites_tenantId_email_idx"
    ON "user_invites"("tenantId", "email");

CREATE INDEX "user_invites_expiresAt_idx" ON "user_invites"("expiresAt");

ALTER TABLE "user_invites"
    ADD CONSTRAINT "user_invites_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_invites"
    ADD CONSTRAINT "user_invites_invitedByUserId_fkey"
    FOREIGN KEY ("invitedByUserId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_invites"
    ADD CONSTRAINT "user_invites_acceptedUserId_fkey"
    FOREIGN KEY ("acceptedUserId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
