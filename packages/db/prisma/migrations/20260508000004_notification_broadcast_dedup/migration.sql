-- Issue #750 — collapse broadcast fan-out duplicates at the DB level.
--
-- A single broadcast was producing 50+ duplicate notification rows when
-- the same user matched multiple audience filters (e.g. SPECIFIC_USERS
-- AND ROLE_DOCTOR), or when the broadcast targeted multiple channels —
-- each channel iteration created its own row, so the user saw the same
-- message N times in their inbox.
--
-- Migration steps:
--   1. Add `broadcastId` (nullable text) — back-reference to the
--      NotificationBroadcast that triggered this row (NULL for non-
--      broadcast notifications, which is the vast majority).
--   2. Add `dedupKey` (nullable text) — the de-duplication slot the
--      broadcast handler upserts on. Format is
--      `${broadcastId}:${userId}`; multiple channels for the same user
--      now collapse onto a single row.
--   3. Create a unique index on dedupKey. Postgres treats NULLs as
--      distinct in a UNIQUE constraint by default, so the millions of
--      non-broadcast rows (which have NULL dedupKey) don't collide. We
--      still scope the index with WHERE dedupKey IS NOT NULL so the
--      index size only tracks broadcast-originated rows.
--   4. Add a non-unique index on broadcastId for the operational
--      "show all rows triggered by this broadcast" query.
--
-- Backfill: not needed. Historical rows have NULL dedupKey and the
-- partial index ignores them. Going forward the broadcast handler
-- stamps dedupKey on every row it writes.

ALTER TABLE "notifications" ADD COLUMN "broadcastId" TEXT;
ALTER TABLE "notifications" ADD COLUMN "dedupKey" TEXT;

CREATE UNIQUE INDEX "notifications_dedupKey_key"
  ON "notifications" ("dedupKey")
  WHERE "dedupKey" IS NOT NULL;

CREATE INDEX "notifications_broadcastId_idx"
  ON "notifications" ("broadcastId");
