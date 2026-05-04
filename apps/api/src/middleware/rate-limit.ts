import { Request, Response, NextFunction } from "express";

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

/**
 * Rate limiter. Returns a pass-through middleware when either
 * `NODE_ENV === "test"` (to keep the test suite deterministic) or
 * `DISABLE_RATE_LIMITS === "true"` (ops escape hatch: set on the prod
 * server while running load/E2E campaigns, unset to re-enable).
 *
 * Covers every caller including the global 600/min gate and every
 * per-route limiter across the API.
 *
 * Issues #124/#125/#128: the 429 response body now surfaces
 * `retryAfterSeconds` (seconds until the bucket resets) and the friendly
 * `error` string so the web client can render an actionable toast instead
 * of a generic "Too many requests". Headers `RateLimit-*` and
 * `Retry-After` are also set per RFC 9239 / draft-ietf-httpapi-ratelimit.
 */
export interface RateLimitOptions {
  /**
   * Issue #478 (May 2026): individual integration tests can opt-in to the
   * real limiter when they specifically want to assert that 429s fire after
   * N+1 attempts. Default false → preserves the test-suite-wide bypass that
   * keeps every other test deterministic. Used only by /auth/login's
   * regression test, where the env var ENABLE_LOGIN_RATELIMIT_IN_TESTS=true
   * is set before constructing the middleware.
   */
  enableInTests?: boolean;
}

export function rateLimit(
  maxRequests: number,
  windowMs: number,
  opts: RateLimitOptions = {}
) {
  const skipForTests =
    process.env.NODE_ENV === "test" && !opts.enableInTests;
  if (skipForTests || process.env.DISABLE_RATE_LIMITS === "true") {
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
  const store = new Map<string, RateLimitEntry>();

  // Clean up expired entries every 60 seconds
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetTime <= now) {
        store.delete(key);
      }
    }
  }, 60_000);

  // Allow the timer to not prevent process exit
  if (cleanup.unref) {
    cleanup.unref();
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const forwarded = req.headers["x-forwarded-for"];
    const ip =
      (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.ip) ??
      "unknown";

    const now = Date.now();
    const entry = store.get(ip);

    if (!entry || entry.resetTime <= now) {
      store.set(ip, { count: 1, resetTime: now + windowMs });
      // Issue #125: expose remaining-quota headers so the client can
      // proactively show "X attempts left" if it wants to.
      res.setHeader("RateLimit-Limit", String(maxRequests));
      res.setHeader("RateLimit-Remaining", String(maxRequests - 1));
      res.setHeader(
        "RateLimit-Reset",
        String(Math.ceil(windowMs / 1000))
      );
      next();
      return;
    }

    entry.count++;
    const remaining = Math.max(0, maxRequests - entry.count);
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((entry.resetTime - now) / 1000)
    );
    res.setHeader("RateLimit-Limit", String(maxRequests));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(retryAfterSeconds));

    if (entry.count > maxRequests) {
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        success: false,
        data: null,
        error: `Too many requests. Try again in ${retryAfterSeconds} seconds.`,
        retryAfterSeconds,
        remaining: 0,
        limit: maxRequests,
      });
      return;
    }

    next();
  };
}
