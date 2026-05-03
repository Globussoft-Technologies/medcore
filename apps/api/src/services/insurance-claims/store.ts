// Prisma-backed store for insurance claims, documents, and status events.
//
// This module was previously a Map-based in-process store (see git history)
// while `packages/db/prisma/schema.prisma` was missing the relevant models.
// The schema merge adding `InsuranceClaim2`, `ClaimDocument`, `ClaimStatusEvent`
// plus the `TpaProvider` / `NormalisedClaimStatus` enums has landed and the
// Prisma client has been regenerated, so delegates are used directly.
//
// Exported *Row shapes use ISO strings for dates/JSON-array icd10Codes so
// existing callers (see `routes/insurance-claims.ts`) don't have to change.
// Prisma returns `Date` objects and stores `icd10Codes` as JSON — we convert
// at the persistence boundary.
//
// Test-only hooks (`forceStatus`, `resetMockState`) that used to live here or
// in the mock adapter are now in `./test-helpers.ts`. They are gated to
// `NODE_ENV === "test"` so they cannot be misused in production code paths.

import { prisma } from "@medcore/db";
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

export interface ClaimsQuery {
  status?: NormalisedClaimStatus;
  tpa?: TpaProvider;
  from?: Date;
  to?: Date;
  patientId?: string;
}

// ── Mapping helpers ─────────────────────────────────────────────────────────

function toISO(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

/** Prisma stores `icd10Codes` as `Json?`; normalise to `string[]`. */
function toStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  return [];
}

function mapClaim(row: any): InsuranceClaimRow {
  return {
    id: row.id,
    billId: row.billId,
    patientId: row.patientId,
    tpaProvider: row.tpaProvider as TpaProvider,
    providerClaimRef: row.providerClaimRef ?? null,
    insurerName: row.insurerName,
    policyNumber: row.policyNumber,
    memberId: row.memberId ?? null,
    preAuthRequestId: row.preAuthRequestId ?? null,
    diagnosis: row.diagnosis,
    icd10Codes: toStringArray(row.icd10Codes),
    procedureName: row.procedureName ?? null,
    admissionDate: toISO(row.admissionDate),
    dischargeDate: toISO(row.dischargeDate),
    amountClaimed: Number(row.amountClaimed),
    amountApproved:
      row.amountApproved === null || row.amountApproved === undefined
        ? null
        : Number(row.amountApproved),
    status: row.status as NormalisedClaimStatus,
    deniedReason: row.deniedReason ?? null,
    notes: row.notes ?? null,
    submittedAt: toISO(row.submittedAt) ?? new Date().toISOString(),
    approvedAt: toISO(row.approvedAt),
    settledAt: toISO(row.settledAt),
    cancelledAt: toISO(row.cancelledAt),
    lastSyncedAt: toISO(row.lastSyncedAt),
    createdBy: row.createdBy,
    createdAt: toISO(row.createdAt) ?? new Date().toISOString(),
    updatedAt: toISO(row.updatedAt) ?? new Date().toISOString(),
  };
}

function mapDocument(row: any): ClaimDocumentRow {
  return {
    id: row.id,
    claimId: row.claimId,
    type: row.type as ClaimDocumentType,
    fileKey: row.fileKey,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    providerDocId: row.providerDocId ?? null,
    uploadedBy: row.uploadedBy,
    uploadedAt: toISO(row.uploadedAt) ?? new Date().toISOString(),
  };
}

function mapEvent(row: any): ClaimStatusEventRow {
  return {
    id: row.id,
    claimId: row.claimId,
    status: row.status as NormalisedClaimStatus,
    timestamp: toISO(row.timestamp) ?? new Date().toISOString(),
    note: row.note ?? null,
    source: (row.source ?? "API") as "API" | "WEBHOOK" | "MANUAL",
    createdBy: row.createdBy ?? null,
  };
}

// ── State-machine guard ─────────────────────────────────────────────────────

/**
 * Allowed transitions on `NormalisedClaimStatus`. Anything not listed here is
 * rejected by `updateStatus` with a domain error so we never silently persist
 * impossible lifecycle moves (e.g. SETTLED -> APPROVED, CANCELLED -> *).
 *
 * Note: `NormalisedClaimStatus` has no `DRAFT` value — the lifecycle starts at
 * `SUBMITTED`. `DENIED -> SUBMITTED` is intentionally excluded: there is no
 * appeal/auto-resubmit code path in the codebase today (see
 * `reconciliation.ts` — the late-revision sweep covers TPA-side flips, not
 * client-initiated resubmission). If/when an appeal flow lands, add it here.
 */
const ALLOWED_TRANSITIONS: Readonly<
  Record<NormalisedClaimStatus, ReadonlyArray<NormalisedClaimStatus>>
> = {
  SUBMITTED: [
    "IN_REVIEW",
    "QUERY_RAISED",
    "APPROVED",
    "PARTIALLY_APPROVED",
    "DENIED",
    "CANCELLED",
  ],
  IN_REVIEW: ["QUERY_RAISED", "APPROVED", "PARTIALLY_APPROVED", "DENIED"],
  QUERY_RAISED: ["IN_REVIEW", "APPROVED", "DENIED"],
  APPROVED: ["SETTLED", "PARTIALLY_APPROVED"],
  PARTIALLY_APPROVED: ["SETTLED"],
  DENIED: [],
  SETTLED: [],
  CANCELLED: [],
};

function assertValidTransition(
  from: NormalisedClaimStatus,
  to: NormalisedClaimStatus
): void {
  if (from === to) return; // idempotent re-write of the same status is a no-op
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(
      `invalid claim transition: ${from} -> ${to} is not permitted`
    );
  }
}

// ── Reset (used by tests) ───────────────────────────────────────────────────

/**
 * Wipe every claim + its dependents. Only usable in the test harness — guards
 * against accidental calls in dev/prod where it would nuke real data.
 * Documents and events cascade via the FK definitions but we still delete
 * explicitly so the call works even if the relation metadata is missing.
 */
export async function resetStore(): Promise<void> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("resetStore() is only callable when NODE_ENV === 'test'");
  }
  await prisma.claimStatusEvent.deleteMany({});
  await prisma.claimDocument.deleteMany({});
  await prisma.insuranceClaim2.deleteMany({});
}

// ── Claims ──────────────────────────────────────────────────────────────────

export async function createClaim(
  row: Omit<InsuranceClaimRow, "id" | "createdAt" | "updatedAt">
): Promise<InsuranceClaimRow> {
  const created = await prisma.insuranceClaim2.create({
    data: {
      billId: row.billId,
      patientId: row.patientId,
      tpaProvider: row.tpaProvider,
      providerClaimRef: row.providerClaimRef,
      insurerName: row.insurerName,
      policyNumber: row.policyNumber,
      memberId: row.memberId,
      preAuthRequestId: row.preAuthRequestId,
      diagnosis: row.diagnosis,
      icd10Codes: row.icd10Codes ?? [],
      procedureName: row.procedureName,
      admissionDate: row.admissionDate ? new Date(row.admissionDate) : null,
      dischargeDate: row.dischargeDate ? new Date(row.dischargeDate) : null,
      amountClaimed: row.amountClaimed,
      amountApproved: row.amountApproved,
      status: row.status,
      deniedReason: row.deniedReason,
      notes: row.notes,
      submittedAt: row.submittedAt ? new Date(row.submittedAt) : new Date(),
      approvedAt: row.approvedAt ? new Date(row.approvedAt) : null,
      settledAt: row.settledAt ? new Date(row.settledAt) : null,
      cancelledAt: row.cancelledAt ? new Date(row.cancelledAt) : null,
      lastSyncedAt: row.lastSyncedAt ? new Date(row.lastSyncedAt) : null,
      createdBy: row.createdBy,
    },
  });
  return mapClaim(created);
}

export async function getClaim(id: string): Promise<InsuranceClaimRow | undefined> {
  const row = await prisma.insuranceClaim2.findUnique({ where: { id } });
  return row ? mapClaim(row) : undefined;
}

/** Alias matching the task-brief operation name. */
export const findById = getClaim;

/** Find a claim by the underlying Invoice/Bill id (many-to-one). */
export async function findByBill(
  billId: string
): Promise<InsuranceClaimRow[]> {
  const rows = await prisma.insuranceClaim2.findMany({
    where: { billId },
    orderBy: { submittedAt: "desc" },
  });
  return rows.map(mapClaim);
}

export async function updateClaim(
  id: string,
  patch: Partial<InsuranceClaimRow>
): Promise<InsuranceClaimRow | undefined> {
  const existing = await prisma.insuranceClaim2.findUnique({ where: { id } });
  if (!existing) return undefined;

  const data: Record<string, unknown> = {};
  if (patch.billId !== undefined) data.billId = patch.billId;
  if (patch.patientId !== undefined) data.patientId = patch.patientId;
  if (patch.tpaProvider !== undefined) data.tpaProvider = patch.tpaProvider;
  if (patch.providerClaimRef !== undefined)
    data.providerClaimRef = patch.providerClaimRef;
  if (patch.insurerName !== undefined) data.insurerName = patch.insurerName;
  if (patch.policyNumber !== undefined) data.policyNumber = patch.policyNumber;
  if (patch.memberId !== undefined) data.memberId = patch.memberId;
  if (patch.preAuthRequestId !== undefined)
    data.preAuthRequestId = patch.preAuthRequestId;
  if (patch.diagnosis !== undefined) data.diagnosis = patch.diagnosis;
  if (patch.icd10Codes !== undefined) data.icd10Codes = patch.icd10Codes;
  if (patch.procedureName !== undefined) data.procedureName = patch.procedureName;
  if (patch.admissionDate !== undefined)
    data.admissionDate = patch.admissionDate ? new Date(patch.admissionDate) : null;
  if (patch.dischargeDate !== undefined)
    data.dischargeDate = patch.dischargeDate ? new Date(patch.dischargeDate) : null;
  if (patch.amountClaimed !== undefined) data.amountClaimed = patch.amountClaimed;
  if (patch.amountApproved !== undefined) data.amountApproved = patch.amountApproved;
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.deniedReason !== undefined) data.deniedReason = patch.deniedReason;
  if (patch.notes !== undefined) data.notes = patch.notes;
  if (patch.submittedAt !== undefined)
    data.submittedAt = patch.submittedAt ? new Date(patch.submittedAt) : null;
  if (patch.approvedAt !== undefined)
    data.approvedAt = patch.approvedAt ? new Date(patch.approvedAt) : null;
  if (patch.settledAt !== undefined)
    data.settledAt = patch.settledAt ? new Date(patch.settledAt) : null;
  if (patch.cancelledAt !== undefined)
    data.cancelledAt = patch.cancelledAt ? new Date(patch.cancelledAt) : null;
  if (patch.lastSyncedAt !== undefined)
    data.lastSyncedAt = patch.lastSyncedAt ? new Date(patch.lastSyncedAt) : null;
  if (patch.createdBy !== undefined) data.createdBy = patch.createdBy;

  const updated = await prisma.insuranceClaim2.update({ where: { id }, data });
  return mapClaim(updated);
}

export async function listClaims(
  q: ClaimsQuery = {}
): Promise<InsuranceClaimRow[]> {
  const where: Record<string, unknown> = {};
  if (q.status) where.status = q.status;
  if (q.tpa) where.tpaProvider = q.tpa;
  if (q.patientId) where.patientId = q.patientId;
  if (q.from || q.to) {
    const submittedAt: Record<string, Date> = {};
    if (q.from) submittedAt.gte = q.from;
    if (q.to) submittedAt.lte = q.to;
    where.submittedAt = submittedAt;
  }
  const rows = await prisma.insuranceClaim2.findMany({
    where,
    orderBy: { submittedAt: "desc" },
  });
  return rows.map(mapClaim);
}

/** Alias matching the task-brief operation name. */
export const list = listClaims;

/**
 * Atomically flip a claim's status AND record a `ClaimStatusEvent` row. Used
 * by the new transactional callers (`updateStatus`, `cancelClaim`). Callers
 * that still want two independent writes can use `updateClaim` +
 * `addEvent` — kept for backwards compat with the existing route.
 */
export interface UpdateStatusInput {
  status: NormalisedClaimStatus;
  providerClaimRef?: string | null;
  amountApproved?: number | null;
  deniedReason?: string | null;
  lastSyncedAt?: string | null;
  approvedAt?: string | null;
  settledAt?: string | null;
  cancelledAt?: string | null;
  note?: string | null;
  source?: "API" | "WEBHOOK" | "MANUAL";
  createdBy?: string | null;
  eventTimestamp?: string;
}

export async function updateStatus(
  id: string,
  input: UpdateStatusInput
): Promise<InsuranceClaimRow | undefined> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.insuranceClaim2.findUnique({ where: { id } });
    if (!existing) return undefined;

    assertValidTransition(
      existing.status as NormalisedClaimStatus,
      input.status
    );

    const data: Record<string, unknown> = { status: input.status };
    if (input.providerClaimRef !== undefined)
      data.providerClaimRef = input.providerClaimRef;
    if (input.amountApproved !== undefined)
      data.amountApproved = input.amountApproved;
    if (input.deniedReason !== undefined) data.deniedReason = input.deniedReason;
    if (input.lastSyncedAt !== undefined)
      data.lastSyncedAt = input.lastSyncedAt
        ? new Date(input.lastSyncedAt)
        : null;
    if (input.approvedAt !== undefined)
      data.approvedAt = input.approvedAt ? new Date(input.approvedAt) : null;
    if (input.settledAt !== undefined)
      data.settledAt = input.settledAt ? new Date(input.settledAt) : null;
    if (input.cancelledAt !== undefined)
      data.cancelledAt = input.cancelledAt ? new Date(input.cancelledAt) : null;

    const updated = await tx.insuranceClaim2.update({ where: { id }, data });
    await tx.claimStatusEvent.create({
      data: {
        claimId: id,
        status: input.status,
        note: input.note ?? null,
        source: input.source ?? "API",
        createdBy: input.createdBy ?? null,
        timestamp: input.eventTimestamp
          ? new Date(input.eventTimestamp)
          : new Date(),
      },
    });
    return mapClaim(updated);
  });
}

/**
 * Transactional provider sync — apply a metadata patch (status, amount,
 * approvedAt, ...) to the claim and append any not-yet-seen timeline events
 * from the TPA in a single transaction. Used by `GET /claims/:id?sync=1`
 * which needs to mirror many events at once (not a single status transition
 * like `updateStatus`).
 *
 * Timeline events are de-duplicated by `(status, timestamp)` against the
 * rows already in `claim_status_events`. Returns the patched claim row.
 */
export interface SyncFromProviderInput {
  patch: Partial<InsuranceClaimRow>;
  timeline: Array<{
    status: NormalisedClaimStatus;
    timestamp: string;
    note?: string | null;
  }>;
}

export async function syncFromProvider(
  id: string,
  input: SyncFromProviderInput
): Promise<InsuranceClaimRow | undefined> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.insuranceClaim2.findUnique({ where: { id } });
    if (!existing) return undefined;

    const patch = input.patch;
    const data: Record<string, unknown> = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.amountApproved !== undefined)
      data.amountApproved = patch.amountApproved;
    if (patch.deniedReason !== undefined) data.deniedReason = patch.deniedReason;
    if (patch.providerClaimRef !== undefined)
      data.providerClaimRef = patch.providerClaimRef;
    if (patch.lastSyncedAt !== undefined)
      data.lastSyncedAt = patch.lastSyncedAt ? new Date(patch.lastSyncedAt) : null;
    if (patch.approvedAt !== undefined)
      data.approvedAt = patch.approvedAt ? new Date(patch.approvedAt) : null;
    if (patch.settledAt !== undefined)
      data.settledAt = patch.settledAt ? new Date(patch.settledAt) : null;
    if (patch.cancelledAt !== undefined)
      data.cancelledAt = patch.cancelledAt ? new Date(patch.cancelledAt) : null;

    const updated = await tx.insuranceClaim2.update({ where: { id }, data });

    // Dedup against existing events before inserting.
    const existingEvents = await tx.claimStatusEvent.findMany({
      where: { claimId: id },
      select: { status: true, timestamp: true },
    });
    const seen = new Set(
      existingEvents.map(
        (e: { status: string; timestamp: Date }) =>
          e.status + "|" + e.timestamp.toISOString()
      )
    );

    for (const ev of input.timeline) {
      const k = ev.status + "|" + ev.timestamp;
      if (seen.has(k)) continue;
      await tx.claimStatusEvent.create({
        data: {
          claimId: id,
          status: ev.status,
          note: ev.note ?? null,
          source: "API",
          createdBy: null,
          timestamp: new Date(ev.timestamp),
        },
      });
    }

    return mapClaim(updated);
  });
}

/**
 * Transactional cancel — marks a claim as CANCELLED and writes the event row.
 */
export async function cancelClaim(
  id: string,
  reason: string,
  opts: {
    source?: "API" | "WEBHOOK" | "MANUAL";
    createdBy?: string | null;
    cancelledAt?: string;
  } = {}
): Promise<InsuranceClaimRow | undefined> {
  const ts = opts.cancelledAt ?? new Date().toISOString();
  return updateStatus(id, {
    status: "CANCELLED",
    cancelledAt: ts,
    note: reason,
    source: opts.source ?? "MANUAL",
    createdBy: opts.createdBy ?? null,
    eventTimestamp: ts,
  });
}

// ── Documents ───────────────────────────────────────────────────────────────

export async function addDocument(
  row: Omit<ClaimDocumentRow, "id" | "uploadedAt">
): Promise<ClaimDocumentRow> {
  const created = await prisma.claimDocument.create({
    data: {
      claimId: row.claimId,
      type: row.type,
      fileKey: row.fileKey,
      filename: row.filename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      providerDocId: row.providerDocId,
      uploadedBy: row.uploadedBy,
    },
  });
  return mapDocument(created);
}

export async function getDocuments(
  claimId: string
): Promise<ClaimDocumentRow[]> {
  const rows = await prisma.claimDocument.findMany({
    where: { claimId },
    orderBy: { uploadedAt: "asc" },
  });
  return rows.map(mapDocument);
}

/** Alias matching the task-brief operation name. */
export const listDocuments = getDocuments;

// ── Events ──────────────────────────────────────────────────────────────────

export async function addEvent(
  row: Omit<ClaimStatusEventRow, "id" | "timestamp"> & { timestamp?: string }
): Promise<ClaimStatusEventRow> {
  const created = await prisma.claimStatusEvent.create({
    data: {
      claimId: row.claimId,
      status: row.status,
      note: row.note ?? null,
      source: row.source,
      createdBy: row.createdBy ?? null,
      timestamp: row.timestamp ? new Date(row.timestamp) : new Date(),
    },
  });
  return mapEvent(created);
}

export async function getEvents(
  claimId: string
): Promise<ClaimStatusEventRow[]> {
  const rows = await prisma.claimStatusEvent.findMany({
    where: { claimId },
    orderBy: { timestamp: "asc" },
  });
  return rows.map(mapEvent);
}
