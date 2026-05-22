/**
 * Chronic-care auto-enrolment service — Pearl §5.2 (gap rows 142-145).
 *
 * What / which modules / why:
 *   - `evaluateCohortRule(rule, tenantId?)`: given a saved cohort-rule JSON
 *     blob, returns the list of patient IDs that currently match. Reuses
 *     `services/audience-compiler.ts:compileAudience` (shipped via
 *     f701b52 for the Pearl §5.1 Campaign domain) so the chronic-care
 *     DSL and the campaign DSL share one source of truth — same shape,
 *     same forward-compat rules, same unknown-field handling.
 *   - `autoEnrolAndRemove()`: cron entry point. Walks every ACTIVE
 *     ChronicCareCohort, evaluates its rule, then materialises /
 *     deactivates per-patient ChronicCarePlan rows so the cohort
 *     membership reflects current reality. Idempotent — safe to re-run.
 *   - Wired into `services/scheduled-tasks.ts` as
 *     `auto_enrol_chronic_care_cohorts` (hourly cadence, wrapped by
 *     `runTaskWithAudit` so ScheduledTaskRun captures the run — Pearl
 *     §8.4 row 222 / commit e9d6764).
 *
 * Design notes:
 *   - The cohort rule reuses the AudienceRules shape. Cohorts WITHOUT a
 *     `cohortRule` (or null) are manual-only — the cron skips them.
 *   - Auto-enrolled ChronicCarePlan rows carry `cohortId = cohort.id`.
 *     Manual plans (created via `POST /chronic-care/plans`) leave it
 *     null — they are NEVER auto-deactivated by this service.
 *   - "Auto-remove" = flip `active=false` on the ChronicCarePlan row.
 *     We deliberately do NOT delete: care history, check-ins, alerts
 *     remain queryable for audit.
 */
import { prisma } from "@medcore/db";
import type { Prisma } from "@prisma/client";
import { compileAudience } from "./audience-compiler";
import type { AudienceRules } from "@medcore/shared";

export interface AutoEnrolResult {
  cohortsEvaluated: number;
  enrolled: number;
  removed: number;
  errors: number;
}

/**
 * Evaluate a cohort rule and return the IDs of patients that currently
 * match. Pure read — no writes. Scoped to `tenantId` when supplied.
 */
export async function evaluateCohortRule(
  rule: AudienceRules | null | undefined,
  tenantId: string | null = null,
): Promise<string[]> {
  if (!rule) return [];
  const where: Prisma.PatientWhereInput = compileAudience(rule);
  const fullWhere: Prisma.PatientWhereInput = tenantId
    ? { AND: [{ tenantId }, where] }
    : where;
  const rows = await prisma.patient.findMany({
    where: fullWhere,
    select: { id: true },
    take: 5000, // safety cap — pearl-tier hospitals are well under this
  });
  return rows.map((r) => r.id);
}

/**
 * One pass of the auto-enrol / auto-remove loop.
 *
 * Per active cohort with a non-null `cohortRule`:
 *   1. Compile rule → matching patient IDs.
 *   2. Read existing ChronicCarePlan rows with this cohortId.
 *   3. For each match WITHOUT a plan → create a new ChronicCarePlan
 *      (cohortId = cohort.id, active = true, condition from cohort if
 *      set else default OTHER).
 *   4. For each existing plan whose patient is NO LONGER in the match
 *      set → flip `active = false` (auto-remove).
 *   5. Re-activate previously auto-removed rows if the patient matches
 *      again (cohorts re-pick-up after a transient mismatch).
 *
 * Idempotent: a second invocation with the same data finds zero deltas.
 */
export async function autoEnrolAndRemove(): Promise<AutoEnrolResult> {
  const result: AutoEnrolResult = {
    cohortsEvaluated: 0,
    enrolled: 0,
    removed: 0,
    errors: 0,
  };

  const cohorts = await prisma.chronicCareCohort.findMany({
    where: { active: true, NOT: { cohortRule: { equals: null as any } } },
    select: {
      id: true,
      condition: true,
      cohortRule: true,
      tenantId: true,
      createdBy: true,
    },
  });

  for (const cohort of cohorts) {
    result.cohortsEvaluated++;
    try {
      const matchedIds = await evaluateCohortRule(
        cohort.cohortRule as AudienceRules,
        cohort.tenantId ?? null,
      );
      const matchedSet = new Set(matchedIds);

      const existing = await prisma.chronicCarePlan.findMany({
        where: { cohortId: cohort.id },
        select: { id: true, patientId: true, active: true },
      });
      const existingByPatient = new Map(existing.map((p) => [p.patientId, p]));

      // 1. New enrolments
      for (const patientId of matchedIds) {
        const prior = existingByPatient.get(patientId);
        if (!prior) {
          try {
            await prisma.chronicCarePlan.create({
              data: {
                patientId,
                condition: (cohort.condition ?? "OTHER") as any,
                cohortId: cohort.id,
                createdBy: cohort.createdBy,
                tenantId: cohort.tenantId ?? null,
                active: true,
              },
            });
            result.enrolled++;
          } catch (err) {
            console.error(
              `[chronic-care-enrolment] enrol failed for cohort ${cohort.id} patient ${patientId}`,
              err,
            );
            result.errors++;
          }
        } else if (!prior.active) {
          // Re-activate previously auto-removed rows
          try {
            await prisma.chronicCarePlan.update({
              where: { id: prior.id },
              data: { active: true },
            });
            result.enrolled++;
          } catch (err) {
            console.error(
              `[chronic-care-enrolment] re-activate failed for plan ${prior.id}`,
              err,
            );
            result.errors++;
          }
        }
      }

      // 2. Auto-removes — active plan, patient no longer matches
      for (const plan of existing) {
        if (!plan.active) continue;
        if (matchedSet.has(plan.patientId)) continue;
        try {
          await prisma.chronicCarePlan.update({
            where: { id: plan.id },
            data: { active: false },
          });
          result.removed++;
        } catch (err) {
          console.error(
            `[chronic-care-enrolment] remove failed for plan ${plan.id}`,
            err,
          );
          result.errors++;
        }
      }
    } catch (err) {
      console.error(
        `[chronic-care-enrolment] cohort ${cohort.id} eval failed`,
        err,
      );
      result.errors++;
    }
  }

  return result;
}
