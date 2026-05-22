-- ================================================================
-- 20260522000006_pearl_scheduled_task_run
--
-- Pearl ERP Stage 1 §8.4 (gap row 222 closure, 2026-05-22):
-- "Background-job queue view + retry" — observability table for the
-- in-process cron scheduler in apps/api/src/services/scheduled-tasks.ts.
--
-- Every invocation of a registered task creates a row (status=RUNNING
-- at start, updated to SUCCESS/FAILED on completion). Super-admins
-- can list/filter/retry from /super-admin/jobs via the new
-- /api/v1/scheduled-jobs router.
--
-- Strictly additive — no existing column altered, no constraint
-- dropped. Safe online migration.
-- ================================================================

-- ── enum ──
CREATE TYPE "TaskRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED');

-- ── table ──
CREATE TABLE "scheduled_task_runs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "taskName" TEXT NOT NULL,
    "status" "TaskRunStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "error" TEXT,
    "recordsProcessed" INTEGER,
    "retryOfRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_task_runs_pkey" PRIMARY KEY ("id")
);

-- ── indexes ──
CREATE INDEX "scheduled_task_runs_taskName_idx"
    ON "scheduled_task_runs"("taskName");

CREATE INDEX "scheduled_task_runs_startedAt_idx"
    ON "scheduled_task_runs"("startedAt");

CREATE INDEX "scheduled_task_runs_status_idx"
    ON "scheduled_task_runs"("status");

CREATE INDEX "scheduled_task_runs_tenantId_startedAt_idx"
    ON "scheduled_task_runs"("tenantId", "startedAt");
