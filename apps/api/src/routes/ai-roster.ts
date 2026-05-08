// AI staff roster proposer routes (PRD §7.3 — AI Staff Scheduling).
//
// Multi-tenant wiring: `tenantScopedPrisma` auto-injects tenantId on create
// and auto-filters on read for tenant-scoped models (StaffShift,
// LeaveRequest, StaffCertification).  The scheduler service uses the alias
// internally.
//
// NOTE on persistence: the companion `StaffRosterProposal` Prisma model is
// described in `services/.prisma-models-ops-forecast.md` and is not yet
// materialized in `schema.prisma`.  Until it lands, proposals are persisted
// to `apps/api/data/ai-roster/proposals.json` via the file store helper
// below.  When the Prisma model is added, swap the three `store.*` calls for
// `prisma.staffRosterProposal.*` — the rest of the route stays identical.
//
// All endpoints require ADMIN.  Apply explicitly requires `confirm: true`.
import { Router, Request, Response, NextFunction } from "express";
import { Role } from "@medcore/shared";
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import {
  generateRosterProposal,
  materializeRoster,
  type RosterProposalResult,
} from "../services/ai/staff-scheduler";

function safeAudit(
  req: Request,
  action: string,
  entity: string,
  entityId: string | undefined,
  details?: Record<string, unknown>
): void {
  auditLog(req, action, entity, entityId, details).catch((err) => {
    console.warn(`[audit] ${action} failed (non-fatal):`, (err as Error)?.message ?? err);
  });
}

// ── Temporary file-backed proposal store ─────────────────────────────────────
// (see note above — will be replaced by the StaffRosterProposal Prisma model).

type ProposalStatus = "PROPOSED" | "APPLIED" | "REJECTED";

interface StoredProposal {
  id: string;
  status: ProposalStatus;
  startDate: string;
  days: number;
  department: string;
  proposal: RosterProposalResult;
  warnings: string[];
  createdBy: string;
  createdAt: string;
  appliedAt?: string;
  appliedBy?: string;
  tenantId?: string | null;
}

function storePath(): string {
  return (
    process.env.AI_ROSTER_STORE_PATH ||
    path.resolve(__dirname, "..", "..", "data", "ai-roster", "proposals.json")
  );
}

async function readStore(): Promise<StoredProposal[]> {
  try {
    const buf = await fs.readFile(storePath(), "utf8");
    return JSON.parse(buf) as StoredProposal[];
  } catch {
    return [];
  }
}

async function writeStore(rows: StoredProposal[]): Promise<void> {
  const p = storePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(rows, null, 2), "utf8");
}

const store = {
  async create(row: Omit<StoredProposal, "id">): Promise<StoredProposal> {
    const rows = await readStore();
    const next: StoredProposal = { ...row, id: crypto.randomUUID() };
    rows.push(next);
    await writeStore(rows);
    return next;
  },
  async findById(id: string): Promise<StoredProposal | null> {
    const rows = await readStore();
    return rows.find((r) => r.id === id) ?? null;
  },
  async update(id: string, patch: Partial<StoredProposal>): Promise<StoredProposal | null> {
    const rows = await readStore();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) return null;
    rows[idx] = { ...rows[idx], ...patch };
    await writeStore(rows);
    return rows[idx];
  },
  async list(): Promise<StoredProposal[]> {
    const rows = await readStore();
    return [...rows].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  },
};

// ── Router ────────────────────────────────────────────────────────────────────

export const aiRosterRouter = Router();

aiRosterRouter.use(authenticate);
// #511 audit (file-level, 2026-05-09): router-level `authorize(Role.ADMIN)`
// excludes PATIENT (and every non-admin role) from every handler in this
// file. Verified-safe.
aiRosterRouter.use(authorize(Role.ADMIN));

/** Basic input validator — keeps route pure without pulling zod for one schema. */
function validateProposeBody(body: any): string | null {
  if (!body || typeof body !== "object") return "body must be an object";
  if (typeof body.startDate !== "string") return "startDate is required (YYYY-MM-DD)";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.startDate)) {
    return "startDate must be YYYY-MM-DD";
  }
  if (body.days !== 7 && body.days !== 14) {
    return "days must be 7 or 14";
  }
  if (typeof body.department !== "string" || body.department.length < 2) {
    return "department is required";
  }
  return null;
}

// POST /api/v1/ai/roster/propose
aiRosterRouter.post(
  "/propose",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const err = validateProposeBody(req.body);
      if (err) {
        res.status(400).json({ success: false, data: null, error: err });
        return;
      }
      const { startDate, days, department, coverage } = req.body as {
        startDate: string;
        days: 7 | 14;
        department: string;
        coverage?: Record<string, number>;
      };

      const proposal = await generateRosterProposal({
        startDate,
        days,
        department,
        coverage: coverage as any,
      });

      const userId = (req as any).user?.userId ?? "unknown";
      const saved = await store.create({
        status: "PROPOSED",
        startDate: proposal.startDate,
        days: proposal.days,
        department: proposal.department,
        proposal,
        warnings: proposal.warnings,
        createdBy: userId,
        createdAt: new Date().toISOString(),
      });

      safeAudit(req, "AI_ROSTER_PROPOSE", "StaffRosterProposal", saved.id, {
        startDate: proposal.startDate,
        days,
        department,
        warnings: proposal.warnings.length,
        violationsIfApplied: proposal.violationsIfApplied.length,
      });

      res.json({
        success: true,
        data: { id: saved.id, ...proposal, status: saved.status },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/ai/roster/apply
// Body: { id: string, confirm: true }
aiRosterRouter.post(
  "/apply",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, confirm } = (req.body ?? {}) as { id?: string; confirm?: boolean };
      if (!id || typeof id !== "string") {
        res.status(400).json({ success: false, data: null, error: "id is required" });
        return;
      }
      if (confirm !== true) {
        res.status(400).json({
          success: false,
          data: null,
          error: "confirm: true is required to apply a roster proposal",
        });
        return;
      }

      const saved = await store.findById(id);
      if (!saved) {
        res.status(404).json({ success: false, data: null, error: "Proposal not found" });
        return;
      }
      if (saved.status !== "PROPOSED") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Proposal is ${saved.status} and cannot be applied`,
        });
        return;
      }

      const { created } = await materializeRoster(saved.proposal);
      const userId = (req as any).user?.userId ?? "unknown";
      const updated = await store.update(id, {
        status: "APPLIED",
        appliedAt: new Date().toISOString(),
        appliedBy: userId,
      });

      safeAudit(req, "AI_ROSTER_APPLY", "StaffRosterProposal", id, {
        createdShifts: created,
      });

      res.json({
        success: true,
        data: { id, status: updated?.status ?? "APPLIED", createdShifts: created },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/ai/roster/history
aiRosterRouter.get(
  "/history",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await store.list();
      const summary = rows.map((r) => ({
        id: r.id,
        status: r.status,
        startDate: r.startDate,
        days: r.days,
        department: r.department,
        createdAt: r.createdAt,
        appliedAt: r.appliedAt,
        warnings: r.warnings.length,
        violationsIfApplied: r.proposal.violationsIfApplied.length,
      }));

      safeAudit(req, "AI_ROSTER_HISTORY_READ", "StaffRosterProposal", undefined, {
        count: summary.length,
      });

      res.json({ success: true, data: summary, error: null });
    } catch (err) {
      next(err);
    }
  }
);
