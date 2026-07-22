// Requisition module (2026-07) — validation for the store → department
// material-issuance workflow (create → approve → issue → receive).
//
// Shared between the API route (apps/api/src/routes/requisitions.ts) and the
// web client so both agree on the request shapes. The status machine + stock
// math live in the route; these schemas only gate the wire payloads.

import { z } from "zod";

const qty = z.number().int().positive("Quantity must be a positive whole number");
const uuid = z.string().uuid();

// ── Create / update a requisition (department staff) ──────────────────────
// Each line points at EXACTLY ONE source: a pharmacy inventory batch
// (inventoryItemId) OR a general material (materialId). The picker shows both.
export const createRequisitionSchema = z.object({
  departmentId: uuid,
  notes: z.string().trim().max(2000).optional(),
  items: z
    .array(
      z
        .object({
          inventoryItemId: z.never().optional(),
          materialId: uuid,
          requestedQty: qty,
        }),
    )
    .min(1, "A requisition needs at least one item")
    .max(100, "Too many line items"),
});
export type CreateRequisitionInput = z.infer<typeof createRequisitionSchema>;

// ── Approve (store manager) — per-line approved quantity ──────────────────
// A line approved for 0 is effectively rejected; the route derives
// APPROVED vs PARTIALLY_APPROVED from the line totals.
export const approveRequisitionSchema = z.object({
  remarks: z.string().trim().max(2000).optional(),
  items: z
    .array(
      z.object({
        itemId: uuid, // RequisitionItem id
        approvedQty: z.number().int().min(0, "Approved qty cannot be negative"),
      }),
    )
    .min(1),
});
export type ApproveRequisitionInput = z.infer<typeof approveRequisitionSchema>;

// ── Reject (store manager) ────────────────────────────────────────────────
export const rejectRequisitionSchema = z.object({
  remarks: z.string().trim().min(1, "A rejection reason is required").max(2000),
});
export type RejectRequisitionInput = z.infer<typeof rejectRequisitionSchema>;

// ── Issue materials (store staff) — per-line issued quantity ──────────────
// Supports full / partial issue; the route caps issuedQty at approvedQty and
// deducts on-hand + reserved stock, writing an ISSUE StockMovement per line.
export const issueRequisitionSchema = z.object({
  remarks: z.string().trim().max(2000).optional(),
  items: z
    .array(
      z.object({
        itemId: uuid,
        issuedQty: z.number().int().min(0),
      }),
    )
    .min(1),
});
export type IssueRequisitionInput = z.infer<typeof issueRequisitionSchema>;

// ── Receive (department staff confirms receipt) ───────────────────────────
// No body needed by default — receiving confirms the issued quantities. An
// optional per-line receivedQty lets the department flag a short receipt.
export const receiveRequisitionSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: uuid,
        receivedQty: z.number().int().min(0),
      }),
    )
    .optional(),
});
export type ReceiveRequisitionInput = z.infer<typeof receiveRequisitionSchema>;
