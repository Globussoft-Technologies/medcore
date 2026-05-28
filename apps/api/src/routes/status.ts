// Public system-status endpoint — Pearl ERP Stage 1 §8.4 (gap row 221).
//
// GET /api/v1/status — UNAUTHENTICATED. Mounted in app.ts BEFORE any
// auth-bearing middleware so the public status page at /status (Next.js
// route) can render without any session. Also safe for external uptime
// monitors (UptimeRobot / StatusCake / Pingdom).
//
// Probes:
//   - API itself: tautologically "operational" if this handler ran.
//   - Database: `SELECT 1` round-trip with timing; "down" on throw.
//   - WhatsApp (Gupshup) / Razorpay / ABDM Gateway: configured-flag check
//     based on the presence of the env credentials. We do NOT externally
//     probe the upstream services (per request — avoids rate-limit risk
//     against third-party APIs from a public endpoint).
//
// Hardening:
//   - No internal hostnames, no version SHAs, no env keys exposed.
//   - `Cache-Control: public, max-age=15` so monitors / browsers don't
//     hammer the DB probe.
//   - `maintenanceWindows` is a deliberately empty array for Stage 1.
//     A future MaintenanceWindow CRUD surface will populate it.

import { Router, Request, Response } from "express";
import { prisma } from "@medcore/db";

const router = Router();

export type ComponentStatus = "operational" | "degraded" | "down";

export interface StatusComponent {
  name: string;
  status: ComponentStatus;
  responseTimeMs?: number;
}

export interface StatusPayload {
  service: "MedCore";
  status: ComponentStatus;
  checkedAt: string;
  components: StatusComponent[];
  maintenanceWindows: Array<{
    id: string;
    title: string;
    scheduledStart: string;
    scheduledEnd: string;
  }>;
}

function rollupStatus(components: StatusComponent[]): ComponentStatus {
  if (components.some((c) => c.status === "down")) return "down";
  if (components.some((c) => c.status === "degraded")) return "degraded";
  return "operational";
}

function thirdPartyConfigured(envKeys: string[]): ComponentStatus {
  // "operational" if every required env key is set with a non-empty value;
  // "degraded" otherwise. We can't actively probe these surfaces from a
  // public endpoint without risking rate-limit exhaustion against the
  // upstream provider, so "degraded" here means "not configured" rather
  // than "broken".
  return envKeys.every((k) => !!process.env[k] && process.env[k]!.length > 0)
    ? "operational"
    : "degraded";
}

router.get("/", async (_req: Request, res: Response) => {
  const checkedAt = new Date().toISOString();

  // ── API (tautology) ───────────────────────────────────────────────
  const apiComponent: StatusComponent = { name: "API", status: "operational" };

  // ── Database ─────────────────────────────────────────────────────
  let dbComponent: StatusComponent;
  try {
    const t0 = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    dbComponent = {
      name: "Database",
      status: "operational",
      responseTimeMs: Date.now() - t0,
    };
  } catch {
    dbComponent = { name: "Database", status: "down" };
  }

  // ── Third-party integrations (config-presence only) ──────────────
  const whatsappComponent: StatusComponent = {
    name: "WhatsApp (Gupshup)",
    status: thirdPartyConfigured(["WHATSAPP_API_URL", "WHATSAPP_API_KEY"]),
  };
  const razorpayComponent: StatusComponent = {
    name: "Razorpay",
    status: thirdPartyConfigured(["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"]),
  };
  const abdmComponent: StatusComponent = {
    name: "ABDM Gateway",
    status: thirdPartyConfigured(["ABDM_CLIENT_ID", "ABDM_CLIENT_SECRET"]),
  };

  const components: StatusComponent[] = [
    apiComponent,
    dbComponent,
    whatsappComponent,
    razorpayComponent,
    abdmComponent,
  ];

  // ── Maintenance windows (Pearl §8.4) ────────────────────────────
  // Surface currently-active + upcoming (next 7d) windows so visitors
  // see scheduled downtime instead of generic "operational" when the
  // platform is being intentionally taken down. Operator CRUD lives
  // at /api/v1/maintenance-windows.
  const now = new Date();
  const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  let windowsPayload: StatusPayload["maintenanceWindows"] = [];
  try {
    const rows = (await (
      prisma as unknown as {
        maintenanceWindow: {
          findMany: (args: unknown) => Promise<
            Array<{
              id: string;
              title: string;
              startsAt: Date;
              endsAt: Date;
            }>
          >;
        };
      }
    ).maintenanceWindow.findMany({
      where: {
        endsAt: { gte: now },
        startsAt: { lte: horizon },
        status: { in: ["scheduled", "in_progress"] },
      },
      orderBy: { startsAt: "asc" },
      take: 10,
      select: { id: true, title: true, startsAt: true, endsAt: true },
    })) as Array<{
      id: string;
      title: string;
      startsAt: Date;
      endsAt: Date;
    }>;
    windowsPayload = rows.map((w) => ({
      id: w.id,
      title: w.title,
      scheduledStart: w.startsAt.toISOString(),
      scheduledEnd: w.endsAt.toISOString(),
    }));
  } catch {
    // Table missing on a cold dev DB or migration lag — fall back to
    // empty array rather than 5xx the public status page.
    windowsPayload = [];
  }

  const payload: StatusPayload = {
    service: "MedCore",
    status: rollupStatus(components),
    checkedAt,
    components,
    maintenanceWindows: windowsPayload,
  };

  res.setHeader("Cache-Control", "public, max-age=15");
  res.json(payload);
});

export const statusRouter = router;
