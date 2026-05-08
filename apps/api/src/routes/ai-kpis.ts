/**
 * AI KPIs dashboard endpoints (PRD §3.9 Feature 1 + §4.9 Feature 2).
 *
 * All endpoints are ADMIN-only because they expose aggregate quality metrics
 * that are commercially sensitive and not useful to ward staff.
 *
 * Query params on all endpoints:
 *   - from (YYYY-MM-DD) — default: today - 30d
 *   - to   (YYYY-MM-DD) — default: today
 *
 * Registered in `apps/api/src/app.ts` as:
 *   app.use("/api/v1/ai/kpis", aiKpisRouter);
 */

import { Router, Request, Response, NextFunction } from "express";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import {
  computeFeature1Bundle,
  computeFeature2Bundle,
  bundlesToCsv,
} from "../services/ai/kpi-metrics";

const router = Router();
router.use(authenticate);

// #511 audit (file-level, 2026-05-09): every handler applies
// `authorize(Role.ADMIN)` per the file header — KPIs are commercially
// sensitive aggregates. PATIENT is excluded. Verified-safe.

function parseRange(req: Request): { from: Date; to: Date } {
  const fromStr = req.query.from as string | undefined;
  const toStr = req.query.to as string | undefined;

  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);
  defaultFrom.setUTCHours(0, 0, 0, 0);

  const parseSafe = (s: string | undefined, fallback: Date) => {
    if (!s) return fallback;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? fallback : d;
  };

  // Normalise in UTC so the CSV filename + downstream slices match the
  // input YYYY-MM-DD regardless of the server's local timezone.
  const from = parseSafe(fromStr, defaultFrom);
  from.setUTCHours(0, 0, 0, 0);

  const to = parseSafe(toStr, now);
  to.setUTCHours(23, 59, 59, 999);

  return { from, to };
}

// ─── GET /api/v1/ai/kpis/feature1 ──────────────────────────
router.get(
  "/feature1",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from, to } = parseRange(req);
      const bundle = await computeFeature1Bundle({ from, to });
      res.json({
        success: true,
        data: { from: from.toISOString(), to: to.toISOString(), bundle },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/v1/ai/kpis/feature2 ──────────────────────────
router.get(
  "/feature2",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from, to } = parseRange(req);
      const bundle = await computeFeature2Bundle({ from, to });
      res.json({
        success: true,
        data: { from: from.toISOString(), to: to.toISOString(), bundle },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/v1/ai/kpis/export ────────────────────────────
router.get(
  "/export",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from, to } = parseRange(req);
      const [f1, f2] = await Promise.all([
        computeFeature1Bundle({ from, to }),
        computeFeature2Bundle({ from, to }),
      ]);
      const csv = bundlesToCsv(f1, f2);
      const fileName = `ai-kpis-${from.toISOString().slice(0, 10)}_to_${to
        .toISOString()
        .slice(0, 10)}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`,
      );
      res.send(csv);
    } catch (err) {
      next(err);
    }
  },
);

export { router as aiKpisRouter };
