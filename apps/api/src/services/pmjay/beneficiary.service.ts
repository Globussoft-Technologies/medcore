// PM-JAY beneficiary (BIS) service.
//
// Owns eligibility: search a beneficiary by Ayushman card, verify + PERSIST the
// result (latest state in PmjayBeneficiary, full audit trail in
// PmjayVerificationHistory), fetch family members, and answer "is this patient
// PM-JAY-eligible?" — the gate the claim route enforces before a PM-JAY claim
// can be created. In simulation mode (no live creds) it returns deterministic
// synthetic data so the whole flow works offline.

import crypto from "crypto";
import { tenantScopedPrisma as prisma } from "@medcore/db";
import { loadPmjayConfig } from "./config";
import { pmjayFetch } from "./gateway";

export type Eligibility = "PENDING" | "ELIGIBLE" | "NOT_ELIGIBLE";

export interface BeneficiaryCandidate {
  beneficiaryId: string;
  name: string;
  ayushmanCardNumber: string;
  familyId: string;
  gender?: string;
  age?: number;
}

function synthId(prefix: string, seed: string): string {
  return prefix + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 10).toUpperCase();
}

/**
 * Simulation eligibility rule: a card whose number contains "INELIG" or "DENY"
 * is NOT_ELIGIBLE; everything else is ELIGIBLE. Deterministic + easy to drive
 * from tests / demos.
 */
function simEligibility(cardNumber: string): Eligibility {
  return /INELIG|DENY/i.test(cardNumber) ? "NOT_ELIGIBLE" : "ELIGIBLE";
}

export interface SearchInput {
  ayushmanCardNumber?: string;
  beneficiaryId?: string;
  familyId?: string;
  mobile?: string;
  abhaNumber?: string;
  name?: string;
}

/** The identifier a search was keyed on — used to seed the sim candidate. */
function primaryIdentifier(input: SearchInput): string {
  return (
    input.ayushmanCardNumber ||
    input.beneficiaryId ||
    input.familyId ||
    input.mobile ||
    input.abhaNumber ||
    input.name ||
    "unknown"
  );
}

/** Search the BIS for candidate beneficiaries by any supported identifier. */
export async function searchBeneficiary(
  input: SearchInput
): Promise<{ ok: true; candidates: BeneficiaryCandidate[] } | { ok: false; message: string }> {
  const cfg = await loadPmjayConfig();
  if (!cfg.enabled) return { ok: false, message: "PM-JAY integration disabled" };

  if (cfg.simulation) {
    const seed = primaryIdentifier(input);
    const card = input.ayushmanCardNumber ?? synthId("PMJAY", seed);
    return {
      ok: true,
      candidates: [
        {
          beneficiaryId: input.beneficiaryId ?? synthId("BEN", seed),
          name: input.name ?? "Ayushman Beneficiary",
          ayushmanCardNumber: card,
          familyId: input.familyId ?? synthId("FAM", seed),
          gender: "OTHER",
        },
      ],
    };
  }

  const res = await pmjayFetch(cfg, `${cfg.urls.bis}/search`, { method: "POST", body: input });
  if (!res.ok) return { ok: false, message: res.error.message };
  const body = res.data as { beneficiaries?: BeneficiaryCandidate[] };
  return { ok: true, candidates: body.beneficiaries ?? [] };
}

export interface VerifyInput {
  patientId: string;
  ayushmanCardNumber: string;
  checkedBy?: string | null;
}

export interface VerifyResult {
  eligibilityStatus: Eligibility;
  beneficiaryId: string | null;
  familyId: string | null;
  name: string | null;
  ayushmanCardNumber: string;
  verifiedAt: string;
  beneficiary: { id: string };
}

/**
 * Verify a patient's Ayushman card against the BIS and persist the outcome:
 * upsert the PmjayBeneficiary latest-state row AND append a
 * PmjayVerificationHistory audit row. The claim route reads the beneficiary row
 * to gate claim creation.
 */
export async function verifyBeneficiary(input: VerifyInput): Promise<VerifyResult> {
  const cfg = await loadPmjayConfig();

  let status: Eligibility;
  let beneficiaryId: string | null;
  let familyId: string | null;
  let name: string | null = null;
  let raw: unknown;

  if (cfg.simulation || !cfg.enabled) {
    status = cfg.enabled ? simEligibility(input.ayushmanCardNumber) : "PENDING";
    beneficiaryId = status === "ELIGIBLE" ? synthId("BEN", input.ayushmanCardNumber) : null;
    familyId = status === "ELIGIBLE" ? synthId("FAM", input.ayushmanCardNumber) : null;
    raw = { simulated: true, status };
  } else {
    const res = await pmjayFetch(cfg, `${cfg.urls.bis}/verify`, {
      method: "POST",
      body: { cardNumber: input.ayushmanCardNumber },
    });
    if (!res.ok) {
      status = "PENDING";
      beneficiaryId = null;
      familyId = null;
      raw = { error: res.error.message };
    } else {
      const body = res.data as {
        eligible?: boolean;
        beneficiaryId?: string;
        familyId?: string;
        name?: string;
      };
      status = body.eligible ? "ELIGIBLE" : "NOT_ELIGIBLE";
      beneficiaryId = body.beneficiaryId ?? null;
      familyId = body.familyId ?? null;
      name = body.name ?? null;
      raw = body;
    }
  }

  const verifiedAt = new Date();

  // Latest-state upsert (find-then-write; the tenant wrapper auto-injects
  // tenantId on create and filters the read).
  const existing = await prisma.pmjayBeneficiary.findFirst({
    where: { patientId: input.patientId, ayushmanCardNumber: input.ayushmanCardNumber },
    select: { id: true },
  });
  let beneficiary: { id: string };
  if (existing) {
    beneficiary = await prisma.pmjayBeneficiary.update({
      where: { id: existing.id },
      data: { eligibilityStatus: status, beneficiaryId, familyId, verifiedAt, rawResponse: raw as never },
      select: { id: true },
    });
  } else {
    beneficiary = await prisma.pmjayBeneficiary.create({
      data: {
        patientId: input.patientId,
        ayushmanCardNumber: input.ayushmanCardNumber,
        beneficiaryId,
        familyId,
        eligibilityStatus: status,
        verifiedAt,
        rawResponse: raw as never,
      },
      select: { id: true },
    });
  }

  await prisma.pmjayVerificationHistory.create({
    data: {
      patientId: input.patientId,
      ayushmanCardNumber: input.ayushmanCardNumber,
      beneficiaryId,
      eligibilityStatus: status,
      checkedBy: input.checkedBy ?? null,
      rawResponse: raw as never,
    },
  });

  return {
    eligibilityStatus: status,
    beneficiaryId,
    familyId,
    name,
    ayushmanCardNumber: input.ayushmanCardNumber,
    verifiedAt: verifiedAt.toISOString(),
    beneficiary,
  };
}

/** Fetch family members for a beneficiary (BIS family API). */
export async function getFamily(
  familyId: string
): Promise<{ ok: true; members: BeneficiaryCandidate[] } | { ok: false; message: string }> {
  const cfg = await loadPmjayConfig();
  if (!cfg.enabled) return { ok: false, message: "PM-JAY integration disabled" };
  if (cfg.simulation) {
    return {
      ok: true,
      members: [
        { beneficiaryId: synthId("BEN", familyId + "1"), name: "Head of Family", ayushmanCardNumber: synthId("PMJAY", familyId + "1"), familyId },
        { beneficiaryId: synthId("BEN", familyId + "2"), name: "Spouse", ayushmanCardNumber: synthId("PMJAY", familyId + "2"), familyId },
      ],
    };
  }
  const res = await pmjayFetch(cfg, `${cfg.urls.bis}/family/${encodeURIComponent(familyId)}`, { method: "GET" });
  if (!res.ok) return { ok: false, message: res.error.message };
  const body = res.data as { members?: BeneficiaryCandidate[] };
  return { ok: true, members: body.members ?? [] };
}

/**
 * The claim gate: returns the patient's current ELIGIBLE beneficiary row, or
 * null. A PM-JAY claim MUST NOT be created when this is null.
 */
export async function getEligibleBeneficiary(
  patientId: string
): Promise<{ id: string; ayushmanCardNumber: string; beneficiaryId: string | null } | null> {
  return prisma.pmjayBeneficiary.findFirst({
    where: { patientId, eligibilityStatus: "ELIGIBLE" },
    orderBy: { verifiedAt: "desc" },
    select: { id: true, ayushmanCardNumber: true, beneficiaryId: true },
  });
}
