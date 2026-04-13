import { Request, Response, NextFunction } from "express";

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

export function rateLimit(maxRequests: number, windowMs: number) {
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
      next();
      return;
    }

    entry.count++;

    if (entry.count > maxRequests) {
      res.status(429).json({
        success: false,
        error: "Too many requests. Try again later.",
      });
      return;
    }

    next();
  };
}
