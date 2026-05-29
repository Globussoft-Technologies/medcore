/**
 * Pearl ERP Stage 1 §8.4 (2026-05-28) — per-request health metrics.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: an Express middleware that times every request and writes a
 *   `RequestMetric` row when the request is "interesting" — either slow
 *   (≥ `SLOW_THRESHOLD_MS`) or an error (statusCode ≥ 500). Routine fast
 *   2xx/4xx requests are NOT logged, which keeps the table at a
 *   sustainable insertion rate (we'd otherwise burn ~M rows/day per
 *   tenant just on /health probes).
 * - MODULES: writes `RequestMetric` (schema piece 8.4 — packages/db).
 *   Reads `req.user?.tenantId` + `req.user?.userId` (populated by
 *   `authenticate` middleware) when available; both nullable on
 *   public routes.
 * - WHY: §8.4 calls for "error rates, slow endpoints (p95 > 1s),
 *   failed background jobs" surfaced per-tenant. Background jobs
 *   already have `ScheduledTaskRun`; this closes the per-request half.
 *
 * Path-template normalisation
 * ───────────────────────────
 * Express resolves `req.route?.path` AFTER the matcher fires —
 * meaning by the time `res.on("finish")` runs we have the template
 * (`/patients/:id`), not the realised URL. When `req.route` is
 * missing (matcher rejection, 404), we fall back to a best-effort
 * normaliser that collapses UUID-shaped + numeric path segments to
 * `:id` so the index doesn't explode on cardinality.
 *
 * Fire-and-forget
 * ───────────────
 * The metric write is `.catch(console.error)` — a DB hiccup must
 * never poison the response. We also short-circuit when `prisma` is
 * unavailable (rare; happens during cold-start tests).
 */
import type { Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";

export const SLOW_THRESHOLD_MS = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;
const PARAM_PLACEHOLDER = ":id";

/** Collapse high-cardinality path segments so we don't index every UUID. */
export function normalisePath(url: string): string {
  // Strip query string and trailing slash.
  const pathOnly = url.split("?")[0].replace(/\/+$/, "") || "/";
  return pathOnly
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (UUID_RE.test(seg)) return PARAM_PLACEHOLDER;
      if (NUMERIC_RE.test(seg) && seg.length >= 3) return PARAM_PLACEHOLDER;
      return seg;
    })
    .join("/");
}

export function apiMetricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // High-resolution start time (ns); fall back to ms on legacy node.
  const startNs =
    typeof process.hrtime?.bigint === "function"
      ? process.hrtime.bigint()
      : null;
  const startMs = Date.now();

  res.on("finish", () => {
    try {
      const durationMs = startNs
        ? Number((process.hrtime.bigint() - startNs) / 1_000_000n)
        : Date.now() - startMs;
      const statusCode = res.statusCode;
      const isError = statusCode >= 500;
      const isSlow = durationMs >= SLOW_THRESHOLD_MS;
      // Only log "interesting" requests — saves ~99% of the rows.
      if (!isError && !isSlow) return;

      // Resolve route template from Express's matcher; fall back to
      // the originalUrl normaliser when no route matched (e.g. 404).
      const routePath: string | undefined =
        // baseUrl + route.path gives us the full template
        // (router-mounted sub-routers strip the prefix from route.path).
        ((req as Request & { route?: { path?: string } }).route?.path &&
          `${req.baseUrl ?? ""}${(req as Request & { route?: { path?: string } }).route?.path}`) ||
        undefined;
      const pathTemplate = routePath ?? normalisePath(req.originalUrl);

      const tenantId = req.user?.tenantId ?? null;
      const userId = req.user?.userId ?? null;
      const errorMessage = isError
        ? // Express attaches the thrown error via `res.locals.error` in
          // the global error handler; if that hook missed, capture the
          // statusMessage so the row still carries SOMETHING.
          (res.locals?.error as Error | undefined)?.message ||
          res.statusMessage ||
          null
        : null;

      // Use a cast — the Prisma client may not yet carry the
      // RequestMetric typing on a dev box where the dev server held the
      // DLL lock during `prisma generate`. Runtime is fine because
      // `db push` already created the table.
      void (prisma as unknown as {
        requestMetric: {
          create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
        };
      }).requestMetric
        .create({
          data: {
            tenantId,
            method: req.method,
            pathTemplate,
            statusCode,
            durationMs,
            userId,
            errorMessage,
          },
        })
        .catch((err) => {
          console.error("[api_metrics] failed to record", err);
        });
    } catch (err) {
      console.error("[api_metrics] internal", err);
    }
  });

  next();
}
