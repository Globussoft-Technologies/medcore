// PM-JAY (Ayushman Bharat) router — beneficiary, packages, stats, webhook.
//
// Mounts at `/api/v1/pmjay`. PM-JAY claims/pre-auth themselves reuse the shared
// `/claims` + `/preauth` routes; this router adds the scheme-specific surfaces:
// beneficiary eligibility (BIS), the HBP package master, a dashboard stats
// aggregation, and the inbound TMS webhook (declared BEFORE the auth guard so
// the gateway can post without a user JWT).

import { Router, Request, Response, NextFunction } from "express";
import express from "express";
import { prisma, runWithTenant, tenantScopedPrisma } from "@medcore/db";
import {
  Role,
  searchBeneficiarySchema,
  verifyBeneficiarySchema,
  pmjayWebhookSchema,
  pmjayConfigSchema,
} from "@medcore/shared";
import { encryptSecret } from "../services/pmjay/crypto";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import {
  searchBeneficiary,
  verifyBeneficiary,
  getFamily,
} from "../services/pmjay/beneficiary.service";
import { listPackages, syncPackages } from "../services/pmjay/package.service";
import { updateStatus } from "../services/insurance-claims/store";
import { __internal as pmjayAdapterInternal } from "../services/insurance-claims/adapters/pmjay";
import { postInsurancePayment } from "../services/invoice-status";
import type { NormalisedClaimStatus } from "../services/insurance-claims/adapter";

const router = Router();
router.use(express.json({ limit: "2mb" }));

/**
 * Identify PM-JAY pre-auths: those carrying a PM-JAY id/package, or whose
 * free-text insuranceProvider names the scheme. Used by the queue + stats so a
 * pre-auth created on the generic Pre-Authorization page still surfaces here.
 */
const PMJAY_PREAUTH_WHERE = {
  OR: [
    { pmjayRequestId: { not: null } },
    { packageCode: { not: null } },
    { insuranceProvider: { contains: "PMJAY", mode: "insensitive" as const } },
    { insuranceProvider: { contains: "PM-JAY", mode: "insensitive" as const } },
    { insuranceProvider: { contains: "Ayushman", mode: "insensitive" as const } },
  ],
};

// ─── Inbound TMS webhook (PUBLIC — no user JWT) ─────────────────────────
// Declared before `router.use(authenticate)` so it is NOT gated. Auth is a
// shared secret compared against TPA_PMJAY_WEBHOOK_SECRET (skipped only when the
// secret is unset, e.g. local dev). Idempotent: `updateStatus` treats a repeat
// status as a no-op, and settlement is deduped by transactionId.
router.post(
  "/webhook",
  validate(pmjayWebhookSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const secret = process.env.TPA_PMJAY_WEBHOOK_SECRET;
      if (secret && req.headers["x-pmjay-signature"] !== secret) {
        res.status(401).json({ success: false, data: null, error: "Invalid webhook signature" });
        return;
      }
      const body = req.body as {
        claimRef: string;
        status: string;
        approvedAmount?: number;
        deniedReason?: string;
        timestamp?: string;
        note?: string;
      };

      const claim = await prisma.insuranceClaim2.findUnique({
        where: { providerClaimRef: body.claimRef },
      });
      if (!claim) {
        // 202: acknowledge so the gateway doesn't hammer retries for a ref we
        // don't (yet) know about.
        res.status(202).json({ success: true, data: { matched: false }, error: null });
        return;
      }

      const mapped = pmjayAdapterInternal.mapPmjayStatus(body.status) as NormalisedClaimStatus;
      const nowIso = body.timestamp || new Date().toISOString();

      const applyUpdate = async () => {
        await updateStatus(claim.id, {
          status: mapped,
          amountApproved: body.approvedAmount ?? null,
          deniedReason: body.deniedReason ?? null,
          lastSyncedAt: nowIso,
          approvedAt: mapped === "APPROVED" && !claim.approvedAt ? nowIso : undefined,
          settledAt: mapped === "SETTLED" && !claim.settledAt ? nowIso : undefined,
          note: body.note ?? `PM-JAY webhook: ${body.status}`,
          source: "WEBHOOK",
          eventTimestamp: nowIso,
        });
        if (mapped === "SETTLED" && claim.billId) {
          const amount = body.approvedAmount ?? (claim.amountApproved == null ? 0 : Number(claim.amountApproved));
          if (amount > 0) {
            await postInsurancePayment({
              invoiceId: claim.billId,
              amount,
              provider: String(claim.tpaProvider),
              claimId: claim.id,
              claimRef: claim.providerClaimRef,
              tenantId: claim.tenantId,
            });
          }
        }
      };

      try {
        // store.updateStatus reads tenant context from ALS; establish it so the
        // scoped write targets the right tenant. Null tenant → run directly.
        if (claim.tenantId) await runWithTenant(claim.tenantId, applyUpdate);
        else await applyUpdate();
      } catch (err) {
        // Invalid transition (e.g. re-notify of a terminal state) — acknowledge.
        res.status(202).json({
          success: true,
          data: { matched: true, applied: false, reason: (err as Error)?.message },
          error: null,
        });
        return;
      }

      res.json({ success: true, data: { matched: true, applied: true, status: mapped }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Everything below requires an authenticated staff user ──────────────
router.use(authenticate);

// ─── Per-tenant configuration (Settings → PM-JAY) — ADMIN only ──────────
const CONFIG_DEFAULTS = { enabled: true, simulationMode: true, timeout: 30000, retryCount: 3, batchSize: 200, logging: false };

/** Strip the secret from a config row and add a `clientSecretSet` flag. */
function redactConfig(row: Record<string, unknown> | null) {
  if (!row) {
    return { ...CONFIG_DEFAULTS, hospitalId: null, clientId: null, baseUrl: null, authUrl: null, bisUrl: null, tmsUrl: null, packageUrl: null, clientSecretSet: false };
  }
  const { clientSecret, tenantId, id, createdAt, updatedAt, ...rest } = row as Record<string, unknown>;
  void tenantId; void id; void createdAt; void updatedAt;
  return { ...rest, clientSecretSet: Boolean(clientSecret) };
}

/** GET /pmjay/config — the current tenant's PM-JAY configuration (secret redacted). */
router.get(
  "/config",
  authorize(Role.ADMIN),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await tenantScopedPrisma.tenantPmjayConfiguration.findFirst();
      res.json({ success: true, data: redactConfig(row as Record<string, unknown> | null), error: null });
    } catch (err) {
      next(err);
    }
  }
);

/** PUT /pmjay/config — upsert the current tenant's PM-JAY configuration. */
router.put(
  "/config",
  authorize(Role.ADMIN),
  validate(pmjayConfigSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Record<string, unknown>;
      // String fields: an explicit "" clears the value (→ null); undefined = leave as-is.
      const strField = (k: string) =>
        k in body ? { [k]: (body[k] as string) === "" ? null : (body[k] as string) } : {};
      const numField = (k: string) => (k in body ? { [k]: body[k] as number } : {});
      const boolField = (k: string) => (k in body ? { [k]: body[k] as boolean } : {});

      const data: Record<string, unknown> = {
        ...boolField("enabled"),
        ...boolField("simulationMode"),
        ...strField("hospitalId"),
        ...strField("clientId"),
        ...strField("baseUrl"),
        ...strField("authUrl"),
        ...strField("bisUrl"),
        ...strField("tmsUrl"),
        ...strField("packageUrl"),
        ...numField("timeout"),
        ...numField("retryCount"),
        ...numField("batchSize"),
        ...boolField("logging"),
      };
      // Secret: only overwrite when a non-empty value is supplied (encrypted at
      // rest). Omitting it keeps the stored secret; passing "" clears it.
      if (typeof body.clientSecret === "string") {
        data.clientSecret = body.clientSecret ? encryptSecret(body.clientSecret) : null;
      }

      const existing = await tenantScopedPrisma.tenantPmjayConfiguration.findFirst({ select: { id: true } });
      const saved = existing
        ? await tenantScopedPrisma.tenantPmjayConfiguration.update({ where: { id: existing.id }, data: data as never })
        : await tenantScopedPrisma.tenantPmjayConfiguration.create({ data: data as never });

      // Audit — never record the secret itself, only whether one was set.
      auditLog(req, "PMJAY_CONFIG_UPDATE", "tenant_pmjay_configuration", saved.id, {
        enabled: (saved as { enabled: boolean }).enabled,
        simulationMode: (saved as { simulationMode: boolean }).simulationMode,
        clientSecretChanged: typeof body.clientSecret === "string" && body.clientSecret !== "",
      }).catch((e) => console.warn("[audit] PMJAY_CONFIG_UPDATE", e?.message ?? e));

      res.json({ success: true, data: redactConfig(saved as unknown as Record<string, unknown>), error: null });
    } catch (err) {
      next(err);
    }
  }
);

/** POST /pmjay/search-beneficiary — look up candidates in the BIS. */
router.post(
  "/search-beneficiary",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(searchBeneficiarySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await searchBeneficiary(req.body);
      if (!result.ok) {
        res.status(502).json({ success: false, data: null, error: result.message });
        return;
      }
      auditLog(req, "PMJAY_BENEFICIARY_SEARCH", "pmjay_beneficiary", undefined, {
        count: result.candidates.length,
      }).catch((e) => console.warn("[audit] PMJAY_BENEFICIARY_SEARCH", e?.message ?? e));
      res.json({ success: true, data: result.candidates, error: null });
    } catch (err) {
      next(err);
    }
  }
);

/** POST /pmjay/verify — verify + persist eligibility (and history). */
router.post(
  "/verify",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(verifyBeneficiarySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await verifyBeneficiary({
        patientId: req.body.patientId,
        ayushmanCardNumber: req.body.ayushmanCardNumber,
        checkedBy: req.user?.userId ?? null,
      });
      auditLog(req, "PMJAY_BENEFICIARY_VERIFY", "pmjay_beneficiary", result.beneficiary.id, {
        patientId: req.body.patientId,
        eligibilityStatus: result.eligibilityStatus,
      }).catch((e) => console.warn("[audit] PMJAY_BENEFICIARY_VERIFY", e?.message ?? e));
      res.json({
        success: true,
        data: {
          eligibilityStatus: result.eligibilityStatus,
          beneficiaryId: result.beneficiaryId,
          familyId: result.familyId,
          name: result.name,
          ayushmanCardNumber: result.ayushmanCardNumber,
          verifiedAt: result.verifiedAt,
          eligible: result.eligibilityStatus === "ELIGIBLE",
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /pmjay/beneficiary?patientId= — the patient's current ELIGIBLE beneficiary
 * (read-only). Used by the claim form to auto-fill the verified beneficiary when
 * TPA=PMJAY. 200 with `data: null` when the patient has no eligible record.
 */
router.get(
  "/beneficiary",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patientId = typeof req.query.patientId === "string" ? req.query.patientId : null;
      if (!patientId) {
        res.status(400).json({ success: false, data: null, error: "patientId is required" });
        return;
      }
      const row = await tenantScopedPrisma.pmjayBeneficiary.findFirst({
        where: { patientId, eligibilityStatus: "ELIGIBLE" },
        orderBy: { verifiedAt: "desc" },
        select: {
          id: true,
          ayushmanCardNumber: true,
          beneficiaryId: true,
          familyId: true,
          eligibilityStatus: true,
          verifiedAt: true,
        },
      });
      res.json({ success: true, data: row, error: null });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /pmjay/family/:id — family members for a beneficiary. */
router.get(
  "/family/:id",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await getFamily(req.params.id);
      if (!result.ok) {
        res.status(502).json({ success: false, data: null, error: result.message });
        return;
      }
      res.json({ success: true, data: result.members, error: null });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /pmjay/preauth — PM-JAY pre-authorisation queue (optional ?status=). */
router.get(
  "/preauth",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : null;
      const rows = await tenantScopedPrisma.preAuthRequest.findMany({
        where: {
          ...PMJAY_PREAUTH_WHERE,
          ...(status && status !== "ALL" ? { status } : {}),
        },
        orderBy: { submittedAt: "desc" },
        take: 200,
        include: { patient: { include: { user: { select: { name: true } } } } },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /pmjay/packages — list the local HBP package mirror. */
router.get(
  "/packages",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const packages = await listPackages({
        specialty: typeof req.query.specialty === "string" ? req.query.specialty : undefined,
        search: typeof req.query.search === "string" ? req.query.search : undefined,
        activeOnly: req.query.all === "1" ? false : true,
      });
      res.json({ success: true, data: packages, error: null });
    } catch (err) {
      next(err);
    }
  }
);

/** POST /pmjay/packages/sync — refresh the package master (ADMIN only). */
router.post(
  "/packages/sync",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await syncPackages();
      if (!result.ok) {
        res.status(502).json({ success: false, data: null, error: result.message });
        return;
      }
      auditLog(req, "PMJAY_PACKAGE_SYNC", "pmjay_package", undefined, { ...result.result }).catch((e) =>
        console.warn("[audit] PMJAY_PACKAGE_SYNC", e?.message ?? e)
      );
      res.json({ success: true, data: result.result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /pmjay/stats — dashboard metrics for the PM-JAY module. */
router.get(
  "/stats",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const p = tenantScopedPrisma;
      const [
        beneficiariesEligible,
        beneficiariesPending,
        claimsByStatus,
        admissions,
        preAuthPending,
        preAuthApproved,
        packages,
        lastPackage,
        uploadPending,
        uploadFailed,
      ] = await Promise.all([
        p.pmjayBeneficiary.count({ where: { eligibilityStatus: "ELIGIBLE" } }),
        p.pmjayBeneficiary.count({ where: { eligibilityStatus: "PENDING" } }),
        p.insuranceClaim2.groupBy({
          by: ["status"],
          where: { tpaProvider: "PMJAY" },
          _count: { _all: true },
          _sum: { amountClaimed: true, amountApproved: true },
        }),
        p.admission.count({ where: { pmjayAdmissionId: { not: null } } }),
        p.preAuthRequest.count({ where: { ...PMJAY_PREAUTH_WHERE, status: "PENDING" } }),
        p.preAuthRequest.count({ where: { ...PMJAY_PREAUTH_WHERE, status: "APPROVED" } }),
        p.pmjayPackage.count({ where: { isActive: true } }),
        p.pmjayPackage.findFirst({ orderBy: { lastSyncedAt: "desc" }, select: { lastSyncedAt: true, packageVersion: true } }),
        p.pmjayDocumentUpload.count({ where: { status: "PENDING" } }),
        p.pmjayDocumentUpload.count({ where: { status: "FAILED" } }),
      ]);

      const byStatus: Record<string, number> = {};
      let totalClaimed = 0;
      let totalApproved = 0;
      let settlementAmount = 0;
      for (const g of claimsByStatus as Array<{ status: string; _count: { _all: number }; _sum: { amountClaimed: number | null; amountApproved: number | null } }>) {
        byStatus[g.status] = g._count._all;
        totalClaimed += Number(g._sum.amountClaimed ?? 0);
        totalApproved += Number(g._sum.amountApproved ?? 0);
        if (g.status === "SETTLED") settlementAmount += Number(g._sum.amountApproved ?? 0);
      }

      res.json({
        success: true,
        data: {
          beneficiaries: { eligible: beneficiariesEligible, pendingVerification: beneficiariesPending },
          preAuth: { pending: preAuthPending, approved: preAuthApproved },
          claims: {
            submitted: byStatus.SUBMITTED ?? 0,
            inReview: (byStatus.IN_REVIEW ?? 0) + (byStatus.QUERY_RAISED ?? 0),
            approved: (byStatus.APPROVED ?? 0) + (byStatus.PARTIALLY_APPROVED ?? 0),
            denied: byStatus.DENIED ?? 0,
            settled: byStatus.SETTLED ?? 0,
          },
          admissions,
          amounts: { totalClaimed, totalApproved, settlementAmount },
          packages: { active: packages, lastSyncedAt: lastPackage?.lastSyncedAt ?? null, version: lastPackage?.packageVersion ?? null },
          ops: { documentUploadsPending: uploadPending, documentUploadsFailed: uploadFailed },
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export const pmjayRouter = router;
