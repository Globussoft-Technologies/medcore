// Requisition module (2026-07) — store → department material-issuance API.
//
// What: REST endpoints for the controlled inventory workflow
//   create (DRAFT) → submit → approve/reject → issue → receive (COMPLETED).
// Which: reads/writes Requisition, RequisitionItem, InventoryItem (+ its
//   reservedStock), StockMovement (ISSUE ledger rows), Department. All via the
//   tenant-scoped Prisma client so rows auto-filter by tenant.
// Why: satisfies client requirement #15 — no department consumes central stock
//   directly; every movement is requested, approved, issued, received, audited.
//
// Stock model:
//   • approve  → reserve `approvedQty` on each item (reservedStock += qty).
//   • issue    → move reserved → out: quantity -= issuedQty,
//                reservedStock -= (the reservation being fulfilled), write an
//                ISSUE StockMovement (negative qty) per line.
//   • available-to-promise for a review = quantity - reservedStock.
//
// RBAC:
//   • create/submit/receive → department staff (NURSE, DOCTOR, RECEPTION) + ADMIN
//   • approve/reject/issue   → store manager (PHARMACIST) + ADMIN
//   • list/get               → any of the above + LAB_TECH (auditor-ish read)

import { Router, Request, Response, NextFunction } from "express";
import { tenantScopedPrisma as prisma } from "@medcore/db";
import {
  Role,
  createRequisitionSchema,
  approveRequisitionSchema,
  rejectRequisitionSchema,
  issueRequisitionSchema,
  receiveRequisitionSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// Role groups
const STORE_ROLES = [Role.ADMIN, Role.PHARMACIST] as const; // store manager / staff
const DEPT_ROLES = [Role.ADMIN, Role.NURSE, Role.DOCTOR, Role.RECEPTION] as const;
const READ_ROLES = [
  Role.ADMIN,
  Role.PHARMACIST,
  Role.NURSE,
  Role.DOCTOR,
  Role.RECEPTION,
  Role.LAB_TECH,
] as const;

const REQ_INCLUDE = {
  department: { select: { id: true, name: true, code: true } },
  requestedBy: { select: { id: true, name: true } },
  items: {
    include: {
      inventoryItem: {
        select: {
          id: true,
          batchNumber: true,
          quantity: true,
          reservedStock: true,
          medicine: { select: { name: true } },
        },
      },
      material: {
        select: {
          id: true,
          name: true,
          unit: true,
          category: true,
          quantity: true,
          reservedStock: true,
        },
      },
    },
  },
};

async function nextRequisitionNumber(): Promise<string> {
  // Sequence held in SystemConfig; fall back to counting existing rows so a
  // fresh tenant still produces monotonic numbers. Callers retry the insert on
  // a unique clash (concurrent creates) — mirrors mr-number / po-number.
  const key = "next_requisition_number";
  const cfg = await prisma.systemConfig.findUnique({ where: { key } });
  const fromCfg = cfg ? parseInt(cfg.value, 10) || 1 : 1;
  const count = await prisma.requisition.count();
  const seq = Math.max(fromCfg, count + 1);
  await prisma.systemConfig.upsert({
    where: { key },
    update: { value: String(seq + 1) },
    create: { key, value: String(seq + 1) },
  });
  return `REQ${String(seq).padStart(6, "0")}`;
}

// ── GET /departments — list departments (for the create form) ─────────────
// Each row carries `isMine` = the caller is a member of that department, so
// the create modal can pre-select the requester's own department (they may
// still change it — pre-fill, not lock).
router.get(
  "/departments",
  authorize(...READ_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId;
      const [departments, memberships] = await Promise.all([
        prisma.department.findMany({
          where: { active: true },
          orderBy: { name: "asc" },
          select: { id: true, name: true, code: true },
        }),
        userId
          ? prisma.departmentMember.findMany({
              where: { userId },
              select: { departmentId: true },
            })
          : Promise.resolve([] as { departmentId: string }[]),
      ]);
      const mine = new Set(memberships.map((m) => m.departmentId));
      const data = departments.map((d) => ({ ...d, isMine: mine.has(d.id) }));
      res.json({ success: true, data, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET / — list requisitions (filter by status / department) ─────────────
router.get(
  "/",
  authorize(...READ_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, departmentId, page = "1", limit = "20" } =
        req.query as Record<string, string | undefined>;
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (departmentId) where.departmentId = departmentId;

      const take = Math.min(parseInt(limit || "20", 10) || 20, 100);
      const skip = ((parseInt(page || "1", 10) || 1) - 1) * take;

      const [rows, total] = await Promise.all([
        prisma.requisition.findMany({
          where,
          include: REQ_INCLUDE,
          orderBy: { createdAt: "desc" },
          skip,
          take,
        }),
        prisma.requisition.count({ where }),
      ]);
      res.json({
        success: true,
        data: rows,
        meta: { page: parseInt(page || "1", 10), limit: take, total },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /:id — one requisition ─────────────────────────────────────────────
router.get(
  "/:id",
  authorize(...READ_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await prisma.requisition.findUnique({
        where: { id: req.params.id },
        include: REQ_INCLUDE,
      });
      if (!row) {
        res.status(404).json({ success: false, data: null, error: "Requisition not found" });
        return;
      }
      res.json({ success: true, data: row, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST / — create a requisition (department staff) ──────────────────────
// Created straight into SUBMITTED (there's no separate draft-save UI in phase
// 1; the body already carries the full item list).
router.post(
  "/",
  authorize(...DEPT_ROLES),
  validate(createRequisitionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { departmentId, notes, items } = req.body as {
        departmentId: string;
        notes?: string;
        items: Array<{
          inventoryItemId?: string;
          materialId?: string;
          requestedQty: number;
        }>;
      };

      const dept = await prisma.department.findUnique({ where: { id: departmentId } });
      if (!dept) {
        res.status(404).json({ success: false, data: null, error: "Department not found" });
        return;
      }
      // Validate referenced sources exist (in this tenant), per source type.
      const invIds = items.filter((i) => i.inventoryItemId).map((i) => i.inventoryItemId!);
      const matIds = items.filter((i) => i.materialId).map((i) => i.materialId!);
      const [invFound, matFound] = await Promise.all([
        invIds.length
          ? prisma.inventoryItem.findMany({ where: { id: { in: invIds } }, select: { id: true } })
          : Promise.resolve([] as { id: string }[]),
        matIds.length
          ? prisma.material.findMany({ where: { id: { in: matIds } }, select: { id: true } })
          : Promise.resolve([] as { id: string }[]),
      ]);
      if (
        invFound.length !== new Set(invIds).size ||
        matFound.length !== new Set(matIds).size
      ) {
        res.status(400).json({ success: false, data: null, error: "One or more items are invalid" });
        return;
      }

      const requisitionNumber = await nextRequisitionNumber();
      const created = await prisma.requisition.create({
        data: {
          requisitionNumber,
          departmentId,
          status: "SUBMITTED",
          notes: notes ?? null,
          requestedById: req.user!.userId,
          submittedAt: new Date(),
          tenantId: req.tenantId ?? null,
          items: {
            create: items.map((i) => ({
              inventoryItemId: i.inventoryItemId ?? null,
              materialId: i.materialId ?? null,
              requestedQty: i.requestedQty,
              tenantId: req.tenantId ?? null,
            })),
          },
        },
        include: REQ_INCLUDE,
      });

      await auditLog(req, "REQUISITION_CREATE", "Requisition", created.id, {
        requisitionNumber,
        departmentId,
        itemCount: items.length,
      });
      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /:id/approve — store manager approves (per-line quantities) ──────
// Reserves the approved quantity on each inventory item. APPROVED when every
// requested line is fully approved, PARTIALLY_APPROVED otherwise.
router.post(
  "/:id/approve",
  authorize(...STORE_ROLES),
  validate(approveRequisitionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { remarks, items } = req.body as {
        remarks?: string;
        items: Array<{ itemId: string; approvedQty: number }>;
      };
      const reqn = await prisma.requisition.findUnique({
        where: { id: req.params.id },
        include: { items: { include: { inventoryItem: true, material: true } } },
      });
      if (!reqn) {
        res.status(404).json({ success: false, data: null, error: "Requisition not found" });
        return;
      }
      if (reqn.status !== "SUBMITTED" && reqn.status !== "PENDING_APPROVAL") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot approve a requisition in state ${reqn.status}`,
        });
        return;
      }

      const approvalMap = new Map(items.map((i) => [i.itemId, i.approvedQty]));
      // Validate stock availability (available-to-promise) for each approval.
      // A line's stock lives on its source: pharmacy InventoryItem OR Material.
      for (const line of reqn.items) {
        const approvedQty = approvalMap.get(line.id) ?? 0;
        if (approvedQty <= 0) continue;
        if (approvedQty > line.requestedQty) {
          res.status(400).json({
            success: false,
            data: null,
            error: `Approved qty exceeds requested for one line`,
          });
          return;
        }
        const src = line.inventoryItem ?? line.material;
        const srcLabel = line.inventoryItem?.batchNumber ?? line.material?.name ?? "item";
        const available = (src?.quantity ?? 0) - (src?.reservedStock ?? 0);
        if (approvedQty > available) {
          res.status(409).json({
            success: false,
            data: null,
            error: `Insufficient stock for ${srcLabel}: available ${available}, approved ${approvedQty}`,
          });
          return;
        }
      }

      let anyApproved = false;
      let fullyApproved = true;
      await prisma.$transaction(async (tx) => {
        for (const line of reqn.items) {
          const approvedQty = approvalMap.get(line.id) ?? 0;
          if (approvedQty > 0) anyApproved = true;
          if (approvedQty < line.requestedQty) fullyApproved = false;
          await tx.requisitionItem.update({
            where: { id: line.id },
            data: { approvedQty },
          });
          if (approvedQty > 0) {
            // Reserve on whichever source the line points at.
            if (line.inventoryItemId) {
              await tx.inventoryItem.update({
                where: { id: line.inventoryItemId },
                data: { reservedStock: { increment: approvedQty } },
              });
            } else if (line.materialId) {
              await tx.material.update({
                where: { id: line.materialId },
                data: { reservedStock: { increment: approvedQty } },
              });
            }
          }
        }
        await tx.requisition.update({
          where: { id: reqn.id },
          data: {
            status: anyApproved
              ? fullyApproved
                ? "APPROVED"
                : "PARTIALLY_APPROVED"
              : "REJECTED",
            remarks: remarks ?? null,
            approvedById: req.user!.userId,
            approvedAt: new Date(),
          },
        });
      });

      const updated = await prisma.requisition.findUnique({
        where: { id: reqn.id },
        include: REQ_INCLUDE,
      });
      await auditLog(req, "REQUISITION_APPROVE", "Requisition", reqn.id, {
        requisitionNumber: reqn.requisitionNumber,
        status: updated?.status,
      });
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /:id/reject — store manager rejects the whole requisition ────────
router.post(
  "/:id/reject",
  authorize(...STORE_ROLES),
  validate(rejectRequisitionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { remarks } = req.body as { remarks: string };
      const reqn = await prisma.requisition.findUnique({ where: { id: req.params.id } });
      if (!reqn) {
        res.status(404).json({ success: false, data: null, error: "Requisition not found" });
        return;
      }
      if (reqn.status !== "SUBMITTED" && reqn.status !== "PENDING_APPROVAL") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot reject a requisition in state ${reqn.status}`,
        });
        return;
      }
      await prisma.requisition.update({
        where: { id: reqn.id },
        data: {
          status: "REJECTED",
          remarks,
          approvedById: req.user!.userId,
          approvedAt: new Date(),
        },
      });
      await auditLog(req, "REQUISITION_REJECT", "Requisition", reqn.id, {
        requisitionNumber: reqn.requisitionNumber,
        remarks,
      });
      const updated = await prisma.requisition.findUnique({
        where: { id: reqn.id },
        include: REQ_INCLUDE,
      });
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /:id/issue — store staff issues materials (full or partial) ──────
// Deducts on-hand + reserved stock and writes an ISSUE StockMovement per line.
router.post(
  "/:id/issue",
  authorize(...STORE_ROLES),
  validate(issueRequisitionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { remarks, items } = req.body as {
        remarks?: string;
        items: Array<{ itemId: string; issuedQty: number }>;
      };
      const reqn = await prisma.requisition.findUnique({
        where: { id: req.params.id },
        include: { items: { include: { inventoryItem: true, material: true } } },
      });
      if (!reqn) {
        res.status(404).json({ success: false, data: null, error: "Requisition not found" });
        return;
      }
      if (
        reqn.status !== "APPROVED" &&
        reqn.status !== "PARTIALLY_APPROVED" &&
        reqn.status !== "PARTIALLY_ISSUED"
      ) {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot issue a requisition in state ${reqn.status}`,
        });
        return;
      }

      const issueMap = new Map(items.map((i) => [i.itemId, i.issuedQty]));
      // Validate each issue against the remaining approved-but-unissued qty
      // and the on-hand stock of the line's source (inventory OR material).
      for (const line of reqn.items) {
        const issueNow = issueMap.get(line.id) ?? 0;
        if (issueNow <= 0) continue;
        const remainingApproved = line.approvedQty - line.issuedQty;
        if (issueNow > remainingApproved) {
          res.status(400).json({
            success: false,
            data: null,
            error: `Issue qty exceeds remaining approved qty for one line`,
          });
          return;
        }
        const onHand = line.inventoryItem?.quantity ?? line.material?.quantity ?? 0;
        const label = line.inventoryItem?.batchNumber ?? line.material?.name ?? "item";
        if (issueNow > onHand) {
          res.status(409).json({
            success: false,
            data: null,
            error: `Insufficient on-hand stock for ${label}`,
          });
          return;
        }
      }

      let fullyIssued = true;
      await prisma.$transaction(async (tx) => {
        for (const line of reqn.items) {
          const issueNow = issueMap.get(line.id) ?? 0;
          const newIssued = line.issuedQty + issueNow;
          if (newIssued < line.approvedQty) fullyIssued = false;
          if (issueNow > 0) {
            await tx.requisitionItem.update({
              where: { id: line.id },
              data: { issuedQty: newIssued },
            });
            const reason = `Issued to ${reqn.departmentId} via ${reqn.requisitionNumber}${
              remarks ? ` — ${remarks}` : ""
            }`;
            if (line.inventoryItemId) {
              await tx.inventoryItem.update({
                where: { id: line.inventoryItemId },
                data: {
                  quantity: { decrement: issueNow },
                  reservedStock: { decrement: issueNow },
                },
              });
              await tx.stockMovement.create({
                data: {
                  inventoryItemId: line.inventoryItemId,
                  type: "ISSUE",
                  quantity: -issueNow,
                  referenceId: reqn.id,
                  reason,
                  performedBy: req.user!.userId,
                  tenantId: req.tenantId ?? null,
                },
              });
            } else if (line.materialId) {
              await tx.material.update({
                where: { id: line.materialId },
                data: {
                  quantity: { decrement: issueNow },
                  reservedStock: { decrement: issueNow },
                },
              });
              await tx.materialMovement.create({
                data: {
                  materialId: line.materialId,
                  type: "ISSUE",
                  quantity: -issueNow,
                  referenceId: reqn.id,
                  reason,
                  performedBy: req.user!.userId,
                  tenantId: req.tenantId ?? null,
                },
              });
            }
          }
        }
        await tx.requisition.update({
          where: { id: reqn.id },
          data: {
            status: fullyIssued ? "ISSUED" : "PARTIALLY_ISSUED",
            issuedById: req.user!.userId,
            issuedAt: new Date(),
          },
        });
      });

      const updated = await prisma.requisition.findUnique({
        where: { id: reqn.id },
        include: REQ_INCLUDE,
      });
      await auditLog(req, "REQUISITION_ISSUE", "Requisition", reqn.id, {
        requisitionNumber: reqn.requisitionNumber,
        status: updated?.status,
      });
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /:id/receive — department confirms receipt → COMPLETED ───────────
router.post(
  "/:id/receive",
  authorize(...DEPT_ROLES),
  validate(receiveRequisitionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { items } = req.body as {
        items?: Array<{ itemId: string; receivedQty: number }>;
      };
      const reqn = await prisma.requisition.findUnique({
        where: { id: req.params.id },
        include: { items: true },
      });
      if (!reqn) {
        res.status(404).json({ success: false, data: null, error: "Requisition not found" });
        return;
      }
      if (reqn.status !== "ISSUED" && reqn.status !== "PARTIALLY_ISSUED") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot receive a requisition in state ${reqn.status}`,
        });
        return;
      }

      const recvMap = new Map((items ?? []).map((i) => [i.itemId, i.receivedQty]));
      await prisma.$transaction(async (tx) => {
        for (const line of reqn.items) {
          // Default: department confirms it received exactly what was issued.
          const received = recvMap.has(line.id)
            ? Math.min(recvMap.get(line.id)!, line.issuedQty)
            : line.issuedQty;
          if (received > 0) {
            await tx.requisitionItem.update({
              where: { id: line.id },
              data: { receivedQty: received },
            });
            const reason = `Received by department via ${reqn.requisitionNumber}`;
            // RECEIVE is a record-only movement (dept confirms receipt); write
            // it against whichever source the line points at.
            if (line.inventoryItemId) {
              await tx.stockMovement.create({
                data: {
                  inventoryItemId: line.inventoryItemId,
                  type: "RECEIVE",
                  quantity: received,
                  referenceId: reqn.id,
                  reason,
                  performedBy: req.user!.userId,
                  tenantId: req.tenantId ?? null,
                },
              });
            } else if (line.materialId) {
              await tx.materialMovement.create({
                data: {
                  materialId: line.materialId,
                  type: "RECEIVE",
                  quantity: received,
                  referenceId: reqn.id,
                  reason,
                  performedBy: req.user!.userId,
                  tenantId: req.tenantId ?? null,
                },
              });
            }
          }
        }
        await tx.requisition.update({
          where: { id: reqn.id },
          data: {
            status: "COMPLETED",
            receivedById: req.user!.userId,
            receivedAt: new Date(),
          },
        });
      });

      const updated = await prisma.requisition.findUnique({
        where: { id: reqn.id },
        include: REQ_INCLUDE,
      });
      await auditLog(req, "REQUISITION_RECEIVE", "Requisition", reqn.id, {
        requisitionNumber: reqn.requisitionNumber,
      });
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /:id/cancel — requester or admin cancels a not-yet-issued req ─────
router.post(
  "/:id/cancel",
  authorize(...DEPT_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const reqn = await prisma.requisition.findUnique({
        where: { id: req.params.id },
        include: { items: true },
      });
      if (!reqn) {
        res.status(404).json({ success: false, data: null, error: "Requisition not found" });
        return;
      }
      if (["ISSUED", "RECEIVED", "COMPLETED", "CANCELLED"].includes(reqn.status)) {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot cancel a requisition in state ${reqn.status}`,
        });
        return;
      }
      await prisma.$transaction(async (tx) => {
        // Release any reservations held by approved-but-unissued lines, on
        // whichever source the line points at.
        for (const line of reqn.items) {
          const heldReservation = line.approvedQty - line.issuedQty;
          if (heldReservation > 0) {
            if (line.inventoryItemId) {
              await tx.inventoryItem.update({
                where: { id: line.inventoryItemId },
                data: { reservedStock: { decrement: heldReservation } },
              });
            } else if (line.materialId) {
              await tx.material.update({
                where: { id: line.materialId },
                data: { reservedStock: { decrement: heldReservation } },
              });
            }
          }
        }
        await tx.requisition.update({
          where: { id: reqn.id },
          data: { status: "CANCELLED" },
        });
      });
      await auditLog(req, "REQUISITION_CANCEL", "Requisition", reqn.id, {
        requisitionNumber: reqn.requisitionNumber,
      });
      const updated = await prisma.requisition.findUnique({
        where: { id: reqn.id },
        include: REQ_INCLUDE,
      });
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  },
);

export { router as requisitionsRouter };
