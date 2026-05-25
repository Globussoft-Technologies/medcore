/**
 * DPDP §17 right-to-erasure receipt generator — Pearl ERP Stage 1 §12
 * (gap row 382 closure, 2026-05-23).
 *
 * What / which modules / why:
 *   - Builds the auditable RECEIPT a tenant operator can hand to a
 *     patient (or a regulator) after an erasure request has been
 *     EXECUTED via /api/v1/dpdp-workbench/requests/:id/execute. Source
 *     of truth is the persisted DPDPErasureRequest row + its
 *     `executionReceipt` JSON (produced by services/dpdp-purge.ts) +
 *     the AuditLog rows tagged DPDP_ERASURE_{REQUESTED,EXECUTED,REJECTED}.
 *     No new schema fields — pure derivation.
 *   - `generateErasureReceipt(requestId, prisma)` returns the structured
 *     JSON document. `renderErasureReceiptPdf(receipt)` returns a PDF
 *     buffer via pdfkit (the same library used by services/pdf-generator.ts).
 *   - `receiptHash` is SHA-256 over the canonical JSON serialization
 *     (keys sorted alphabetically + receiptHash field itself excluded).
 *     Tenant operator can publish the hash so the receipt is
 *     tamper-evident — re-deriving the hash MUST match.
 *   - Scope-cut: this surface only READS; the underlying purge already
 *     ran. The receipt is durable per executionReceipt + AuditLog rows,
 *     so re-running this function on the same request id is idempotent
 *     and deterministic (same hash).
 */

import { createHash } from "crypto";
import type { PrismaClient } from "@prisma/client";
import PDFDocument from "pdfkit";

export interface ErasureReceiptTableEntry {
  table: string;
  rowsDeleted: number;
  anonymizedFields: string[];
}

export interface ErasureReceiptAuditEntry {
  action: string;
  timestamp: string; // ISO
  userId: string | null;
}

export interface ErasureReceipt {
  requestId: string;
  patientId: string;
  tenantId: string;
  requestedAt: string;
  requestedByUserId: string;
  requestedByRole: string;
  executedAt: string | null;
  executedByUserId: string | null;
  status: string;
  tablesAffected: ErasureReceiptTableEntry[];
  auditTrail: ErasureReceiptAuditEntry[];
  notes: string;
  receiptVersion: 1;
  receiptHash: string; // SHA-256 of the canonical serialization
}

export class ErasureReceiptNotFoundError extends Error {
  constructor(public readonly requestId: string) {
    super(`DPDP erasure request ${requestId} not found`);
    this.name = "ErasureReceiptNotFoundError";
  }
}

// ─── Receipt assembly ────────────────────────────────────────────────

interface ExecutionReceiptShape {
  purgedTables?: string[];
  purgedRows?: Record<string, number>;
  anonymizedTables?: string[];
  retainedTables?: string[];
  notes?: string;
  executedAt?: string;
}

// Per-table list of fields that get NULLed / scrambled on the Patient
// + User rows during anonymization. Mirrors the literal updates in
// services/dpdp-purge.ts so the receipt accurately reflects what was
// done. If the purge service is extended to anonymize more fields,
// this table must be updated to match.
const ANONYMIZED_FIELDS_BY_TABLE: Record<string, string[]> = {
  Patient: [
    "mrNumber",
    "address",
    "bloodGroup",
    "emergencyContactName",
    "emergencyContactPhone",
    "emergencyContactRelationship",
    "insuranceProvider",
    "insurancePolicyNumber",
    "maritalStatus",
    "occupation",
    "religion",
    "preferredLanguage",
    "abhaId",
    "aadhaarMasked",
    "photoUrl",
  ],
  User: [
    "email",
    "phone",
    "name",
    "photoUrl",
    "isActive",
    "twoFactorEnabled",
    "twoFactorSecret",
    "twoFactorBackupCodes",
    "pushToken",
  ],
};

/**
 * Deterministic JSON serialization for hashing: keys sorted
 * alphabetically at every level, arrays preserved in order. The
 * `receiptHash` field is excluded from the input before hashing
 * (it's the OUTPUT of the hash).
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJsonStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`,
  );
  return `{${parts.join(",")}}`;
}

function computeReceiptHash(receipt: Omit<ErasureReceipt, "receiptHash">): string {
  const canonical = canonicalJsonStringify(receipt);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export async function generateErasureReceipt(
  requestId: string,
  prisma: PrismaClient,
): Promise<ErasureReceipt> {
  const row = await prisma.dPDPErasureRequest.findUnique({
    where: { id: requestId },
  });
  if (!row) {
    throw new ErasureReceiptNotFoundError(requestId);
  }

  const exec = (row.executionReceipt ?? null) as ExecutionReceiptShape | null;
  const purgedRows = exec?.purgedRows ?? {};
  const purgedTables = exec?.purgedTables ?? [];
  const anonymizedTables = exec?.anonymizedTables ?? [];

  const tablesAffected: ErasureReceiptTableEntry[] = [];
  for (const table of purgedTables) {
    tablesAffected.push({
      table,
      rowsDeleted: purgedRows[table] ?? 0,
      anonymizedFields: [],
    });
  }
  for (const table of anonymizedTables) {
    tablesAffected.push({
      table,
      rowsDeleted: 0,
      anonymizedFields: ANONYMIZED_FIELDS_BY_TABLE[table] ?? [],
    });
  }

  // Pull the full audit trail for this request id. Both REQUESTED and
  // EXECUTED/REJECTED rows live under entity = "dpdp_erasure_request"
  // and entityId = row.id (see dpdp-workbench.ts).
  const auditRows = await prisma.auditLog.findMany({
    where: {
      entity: "dpdp_erasure_request",
      entityId: row.id,
      action: {
        in: [
          "DPDP_ERASURE_REQUESTED",
          "DPDP_ERASURE_EXECUTED",
          "DPDP_ERASURE_REJECTED",
        ],
      },
    },
    orderBy: { createdAt: "asc" },
    select: { action: true, createdAt: true, userId: true },
  });
  const auditTrail: ErasureReceiptAuditEntry[] = auditRows.map((a) => ({
    action: a.action,
    timestamp: a.createdAt.toISOString(),
    userId: a.userId ?? null,
  }));

  const withoutHash: Omit<ErasureReceipt, "receiptHash"> = {
    requestId: row.id,
    patientId: row.patientId,
    tenantId: row.tenantId,
    requestedAt: row.requestedAt.toISOString(),
    requestedByUserId: row.requestedBy,
    requestedByRole: row.requestedByRole,
    executedAt: row.executedAt ? row.executedAt.toISOString() : null,
    executedByUserId: row.executedBy ?? null,
    status: row.status,
    tablesAffected,
    auditTrail,
    notes:
      exec?.notes ??
      "DPDP Act 2023 §17 right-to-erasure. Receipt derived from persisted DPDPErasureRequest + AuditLog rows; SHA-256 receiptHash makes it tamper-evident.",
    receiptVersion: 1,
  };

  return {
    ...withoutHash,
    receiptHash: computeReceiptHash(withoutHash),
  };
}

// ─── PDF renderer ────────────────────────────────────────────────────

function collectPdf(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

export async function renderErasureReceiptPdf(
  receipt: ErasureReceipt,
): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 48 });
  const collector = collectPdf(doc);

  // Header
  doc
    .fillColor("#0f172a")
    .fontSize(18)
    .font("Helvetica-Bold")
    .text("DPDP §17 Erasure Receipt", { align: "left" });
  doc.moveDown(0.2);
  doc
    .fontSize(9)
    .fillColor("#64748b")
    .font("Helvetica")
    .text(
      "Digital Personal Data Protection Act 2023 — Right to Erasure. This document confirms that the listed personal data was purged or anonymized on the executed-at date below. The SHA-256 receiptHash is computed over the canonical serialization of this receipt; any tampering will invalidate the hash.",
      { width: 499 },
    );
  doc.moveDown(0.6);

  // Identifiers block
  doc.fontSize(11).fillColor("#0f172a").font("Helvetica-Bold").text("Request");
  doc.moveDown(0.2);
  doc.fontSize(10).font("Helvetica").fillColor("#0f172a");
  doc.text(`Request ID:        ${receipt.requestId}`);
  doc.text(`Patient ID:        ${receipt.patientId}`);
  doc.text(`Tenant ID:         ${receipt.tenantId || "—"}`);
  doc.text(`Status:            ${receipt.status}`);
  doc.text(`Requested by:      ${receipt.requestedByUserId} (${receipt.requestedByRole})`);
  doc.text(`Requested at:      ${fmtDateTime(receipt.requestedAt)}`);
  doc.text(`Executed by:       ${receipt.executedByUserId ?? "—"}`);
  doc.text(`Executed at:       ${fmtDateTime(receipt.executedAt)}`);
  doc.moveDown(0.6);

  // Tables affected
  doc.fontSize(11).font("Helvetica-Bold").text("Tables affected");
  doc.moveDown(0.2);
  doc.fontSize(10).font("Helvetica");
  if (receipt.tablesAffected.length === 0) {
    doc.fillColor("#64748b").text("(none — purge produced no per-table changes)");
    doc.fillColor("#0f172a");
  } else {
    for (const t of receipt.tablesAffected) {
      const action =
        t.anonymizedFields.length > 0
          ? `ANONYMIZED — fields nulled / scrambled: ${t.anonymizedFields.join(", ")}`
          : `PURGED — ${t.rowsDeleted} row${t.rowsDeleted === 1 ? "" : "s"} deleted`;
      doc.font("Helvetica-Bold").text(t.table, { continued: true });
      doc.font("Helvetica").text(`  ${action}`, { width: 499 });
      doc.moveDown(0.15);
    }
  }
  doc.moveDown(0.4);

  // Audit trail
  doc.fontSize(11).font("Helvetica-Bold").text("Audit trail");
  doc.moveDown(0.2);
  doc.fontSize(10).font("Helvetica");
  if (receipt.auditTrail.length === 0) {
    doc.fillColor("#64748b").text("(no audit rows found)");
    doc.fillColor("#0f172a");
  } else {
    for (const a of receipt.auditTrail) {
      doc.text(
        `${fmtDateTime(a.timestamp)}   ${a.action}   userId=${a.userId ?? "—"}`,
      );
    }
  }
  doc.moveDown(0.6);

  // Notes
  doc.fontSize(11).font("Helvetica-Bold").text("Notes");
  doc.moveDown(0.2);
  doc.fontSize(9).font("Helvetica").fillColor("#334155").text(receipt.notes, {
    width: 499,
  });
  doc.moveDown(0.6);

  // Tamper-evident hash footer
  doc.fontSize(11).font("Helvetica-Bold").fillColor("#0f172a").text("Receipt hash (SHA-256)");
  doc.moveDown(0.2);
  doc
    .fontSize(9)
    .font("Courier")
    .fillColor("#0f172a")
    .text(receipt.receiptHash, { width: 499 });
  doc.moveDown(0.2);
  doc
    .fontSize(8)
    .font("Helvetica")
    .fillColor("#64748b")
    .text(
      `Receipt version ${receipt.receiptVersion}. Hash is computed over the canonical JSON serialization (alphabetically-sorted keys, hash field excluded). To verify: GET /api/v1/dpdp-workbench/requests/${receipt.requestId}/receipt.json and re-derive the hash client-side.`,
      { width: 499 },
    );

  doc.end();
  return collector;
}
