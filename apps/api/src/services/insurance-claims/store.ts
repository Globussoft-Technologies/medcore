// Temporary in-process store for claims, documents, and status events.
//
// The task brief forbids editing `packages/db/prisma/schema.prisma` so we
// can't persist to Postgres yet. Once the models in `.prisma-models.md` are
// migrated, swap every reference here for the corresponding `prisma.*` call;
// the field names line up 1:1 on purpose.
//
// The store is process-local — fine for tests and the single-node dev server,
// unsuitable for prod (everyone shipping to prod must run the migration first).

import crypto from "crypto";
import {
  TpaProvider,
  NormalisedClaimStatus,
  ClaimDocumentType,
} from "./adapter";

export interface InsuranceClaimRow {
  id: string;
  billId: string; // Invoice.id
  patientId: string;
  tpaProvider: TpaProvider;
  providerClaimRef: string | null;
  insurerName: string;
  policyNumber: string;
  memberId: string | null;
  preAuthRequestId: string | null;
  diagnosis: string;
  icd10Codes: string[];
  procedureName: string | null;
  admissionDate: string | null;
  dischargeDate: string | null;
  amountClaimed: number;
  amountApproved: number | null;
  status: NormalisedClaimStatus;
  deniedReason: string | null;
  notes: string | null;
  submittedAt: string;
  approvedAt: string | null;
  settledAt: string | null;
  cancelledAt: string | null;
  lastSyncedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimDocumentRow {
  id: string;
  claimId: string;
  type: ClaimDocumentType;
  fileKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  providerDocId: string | null;
  uploadedBy: string;
  uploadedAt: string;
}

export interface ClaimStatusEventRow {
  id: string;
  claimId: string;
  status: NormalisedClaimStatus;
  timestamp: string;
  note: string | null;
  source: "API" | "WEBHOOK" | "MANUAL";
  createdBy: string | null;
}

const claims = new Map<string, InsuranceClaimRow>();
const documents = new Map<string, ClaimDocumentRow[]>(); // claimId → rows
const events = new Map<string, ClaimStatusEventRow[]>(); // claimId → rows

export function resetStore(): void {
  claims.clear();
  documents.clear();
  events.clear();
}

function uuid(): string {
  return crypto.randomUUID();
}

// ── Claims ──────────────────────────────────────────────────────────────────

export function createClaim(
  row: Omit<InsuranceClaimRow, "id" | "createdAt" | "updatedAt">
): InsuranceClaimRow {
  const now = new Date().toISOString();
  const full: InsuranceClaimRow = { ...row, id: uuid(), createdAt: now, updatedAt: now };
  claims.set(full.id, full);
  return full;
}

export function getClaim(id: string): InsuranceClaimRow | undefined {
  return claims.get(id);
}

export function updateClaim(
  id: string,
  patch: Partial<InsuranceClaimRow>
): InsuranceClaimRow | undefined {
  const existing = claims.get(id);
  if (!existing) return undefined;
  const updated: InsuranceClaimRow = {
    ...existing,
    ...patch,
    id: existing.id,
    updatedAt: new Date().toISOString(),
  };
  claims.set(id, updated);
  return updated;
}

export interface ClaimsQuery {
  status?: NormalisedClaimStatus;
  tpa?: TpaProvider;
  from?: Date;
  to?: Date;
  patientId?: string;
}

export function listClaims(q: ClaimsQuery = {}): InsuranceClaimRow[] {
  const all = Array.from(claims.values());
  return all
    .filter((c) => !q.status || c.status === q.status)
    .filter((c) => !q.tpa || c.tpaProvider === q.tpa)
    .filter((c) => !q.patientId || c.patientId === q.patientId)
    .filter((c) => !q.from || new Date(c.submittedAt) >= q.from)
    .filter((c) => !q.to || new Date(c.submittedAt) <= q.to)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

// ── Documents ───────────────────────────────────────────────────────────────

export function addDocument(
  row: Omit<ClaimDocumentRow, "id" | "uploadedAt">
): ClaimDocumentRow {
  const full: ClaimDocumentRow = {
    ...row,
    id: uuid(),
    uploadedAt: new Date().toISOString(),
  };
  const list = documents.get(row.claimId) ?? [];
  list.push(full);
  documents.set(row.claimId, list);
  return full;
}

export function getDocuments(claimId: string): ClaimDocumentRow[] {
  return [...(documents.get(claimId) ?? [])];
}

// ── Events ──────────────────────────────────────────────────────────────────

export function addEvent(
  row: Omit<ClaimStatusEventRow, "id" | "timestamp"> & { timestamp?: string }
): ClaimStatusEventRow {
  const full: ClaimStatusEventRow = {
    id: uuid(),
    timestamp: row.timestamp ?? new Date().toISOString(),
    claimId: row.claimId,
    status: row.status,
    note: row.note ?? null,
    source: row.source,
    createdBy: row.createdBy ?? null,
  };
  const list = events.get(row.claimId) ?? [];
  list.push(full);
  events.set(row.claimId, list);
  return full;
}

export function getEvents(claimId: string): ClaimStatusEventRow[] {
  return [...(events.get(claimId) ?? [])].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  );
}
