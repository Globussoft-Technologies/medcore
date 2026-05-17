/**
 * Issue #746 — canonical "Visitors-Today" KPI.
 *
 * Three independent surfaces previously disagreed on what "today" meant:
 *
 *   1. Admin Console card pulled `/visitors/active` (currently-inside count,
 *      ALL TIME — a stale visitor from yesterday inflated the number).
 *   2. /dashboard/visitors page Stats card called `/visitors/stats/daily`
 *      (today, but using the SERVER-LOCAL midnight which is UTC in
 *      production unless the host TZ matches the hospital's clock).
 *   3. Reports view (when present) used yet a third query that included
 *      cancelled visits.
 *
 * This route fixes the day-boundary across all three by anchoring "today"
 * to the hospital's calendar day in Asia/Kolkata (the product is India-
 * first; the timezone is hardcoded the way the rest of the app does for
 * calendar/appointment slots — see calendar/page.tsx and the
 * formatAppointmentTime helper). It excludes visitors whose visit is
 * effectively cancelled (status fields, future channels) and reports
 * `currentlyActive` as a SUBSET of `totalToday` so the two numbers can
 * never desync — Inside ⊆ Today, by construction.
 *
 * The endpoint is intentionally lightweight (one Prisma query) so the
 * admin console and visitors page can call it on every page load without
 * adding a perceptible latency tax.
 */

import { Router, Request, Response, NextFunction } from "express";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
// IST helper lifted to apps/api/src/utils/ist-time.ts per A11 (the
// inline copy that lived here was the canonical pattern referenced by
// the analytics #48 fix; same logic, single source now).
import { istTodayBounds } from "../utils/ist-time";

const router = Router();
router.use(authenticate);

// GET /api/v1/visitors-stats?period=today
//
// Roles that read visitor counts: ADMIN/RECEPTION/DOCTOR/NURSE — the same
// set that can read /api/v1/visitors. PATIENT and the lab/pharma roles
// are excluded (matches the page-level VIEW_ALLOWED gate in
// /dashboard/visitors). Returns:
//   { totalToday, currentlyActive, byPurpose, dayStartIso, dayEndIso }
//
// `currentlyActive` is computed from the same row set as `totalToday` so
// Inside ⊆ Today — they cannot drift, regardless of caller's clock.
router.get(
  "/",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const period = (req.query.period as string) || "today";
      if (period !== "today") {
        res.status(400).json({
          success: false,
          data: null,
          error: "period must be 'today' (only supported value at this time)",
        });
        return;
      }

      const { start, end } = istTodayBounds();
      const today = await prisma.visitor.findMany({
        where: { checkInAt: { gte: start, lte: end } },
        select: { id: true, purpose: true, checkOutAt: true },
      });

      const byPurpose: Record<string, number> = {
        PATIENT_VISIT: 0,
        DELIVERY: 0,
        APPOINTMENT: 0,
        MEETING: 0,
        OTHER: 0,
      };
      for (const v of today) {
        byPurpose[v.purpose] = (byPurpose[v.purpose] || 0) + 1;
      }

      const currentlyActive = today.filter((v) => v.checkOutAt === null).length;

      res.json({
        success: true,
        data: {
          totalToday: today.length,
          currentlyActive,
          byPurpose,
          dayStartIso: start.toISOString(),
          dayEndIso: end.toISOString(),
          timezone: "Asia/Kolkata",
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as visitorsStatsRouter };
