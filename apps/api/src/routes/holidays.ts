/**
 * Issue #749 — public read-only holidays endpoint for the calendar grid.
 *
 * Background: holidays are managed at /dashboard/holidays via
 * `/api/v1/hr-ops/holidays` which authorize(Role.ADMIN) gates ALL methods
 * (read + write). The calendar at /dashboard/calendar renders for every
 * authed staff role (and PATIENT in some flows) and needs to display
 * holidays as background-coloured cells with a tooltip — but it
 * cannot call the admin-only endpoint without 403'ing for non-admins.
 *
 * This route exposes a minimally-projected, READ-ONLY view of the same
 * Holiday rows the admin endpoint manages. Writes still go through
 * /api/v1/hr-ops/holidays. The projection drops the `description` field
 * (which may carry policy notes the front desk shouldn't see) and
 * returns just date + name + type — exactly what the calendar tile
 * needs to render a coloured cell + tooltip.
 *
 * Authentication is required (no anonymous access) but no authorize()
 * gate beyond that — the calendar surface is open to every authed role,
 * so the holiday overlay must be too.
 */

import { Router, Request, Response, NextFunction } from "express";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { authenticate } from "../middleware/auth";

const router = Router();
router.use(authenticate);

// GET /api/v1/holidays?year=YYYY (defaults to current year)
//   or /api/v1/holidays?from=YYYY-MM-DD&to=YYYY-MM-DD for a date window.
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to, year } = req.query as Record<string, string | undefined>;

    let start: Date;
    let end: Date;
    if (from && to) {
      start = new Date(`${from}T00:00:00.000Z`);
      end = new Date(`${to}T23:59:59.999Z`);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        res.status(400).json({
          success: false,
          data: null,
          error: "from and to must be YYYY-MM-DD",
        });
        return;
      }
    } else {
      const y = parseInt(year ?? String(new Date().getFullYear()), 10);
      if (!Number.isFinite(y) || y < 1970 || y > 3000) {
        res.status(400).json({
          success: false,
          data: null,
          error: "year must be a 4-digit year",
        });
        return;
      }
      start = new Date(`${y}-01-01T00:00:00.000Z`);
      end = new Date(`${y}-12-31T23:59:59.999Z`);
    }

    const holidays = await prisma.holiday.findMany({
      where: { date: { gte: start, lte: end } },
      orderBy: { date: "asc" },
      select: { id: true, date: true, name: true, type: true },
    });

    res.json({ success: true, data: holidays, error: null });
  } catch (err) {
    next(err);
  }
});

export { router as holidaysRouter };
