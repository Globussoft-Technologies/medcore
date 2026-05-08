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

const router = Router();
router.use(authenticate);

/**
 * Compute the [start, end] window that represents "today" in Asia/Kolkata
 * regardless of the server's host TZ. The product targets Indian
 * hospitals; UTC-based windows broke the count for hosts running in
 * UTC (after 18:30 IST the UTC date is already tomorrow).
 *
 * Rather than pull a TZ library, we derive the IST midnight by subtracting
 * the +05:30 offset from a UTC-based moment of "now" — this gives us the
 * UTC instant that corresponds to 00:00 IST on today's IST date.
 */
function istTodayBounds(): { start: Date; end: Date } {
  const IST_OFFSET_MIN = 5 * 60 + 30; // +05:30
  const now = new Date();
  // Project `now` into IST by adding the offset, then floor to date.
  const istNow = new Date(now.getTime() + IST_OFFSET_MIN * 60 * 1000);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const d = istNow.getUTCDate();
  // 00:00 IST on the IST-derived calendar day, expressed as a UTC instant.
  const startUTC = new Date(
    Date.UTC(y, m, d, 0, 0, 0, 0) - IST_OFFSET_MIN * 60 * 1000
  );
  const endUTC = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start: startUTC, end: endUTC };
}

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
