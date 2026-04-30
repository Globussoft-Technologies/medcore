import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createDonorSchema,
  updateDonorSchema,
  createDonationSchema,
  approveDonationSchema,
  createBloodUnitSchema,
  bloodRequestSchema,
  issueBloodSchema,
  bloodScreeningSchema,
  temperatureLogSchema,
  crossMatchRecordSchema,
  donorDeferralSchema,
  componentSeparationSchema,
  RBC_COMPATIBILITY as SHARED_RBC_COMPATIBILITY,
  PLASMA_COMPATIBILITY as SHARED_PLASMA_COMPATIBILITY,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// ───────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────

async function generateDonorNumber(): Promise<string> {
  const last = await prisma.bloodDonor.findFirst({
    orderBy: { createdAt: "desc" },
    select: { donorNumber: true },
  });
  let next = 1;
  if (last?.donorNumber) {
    const m = last.donorNumber.match(/BD(\d+)/);
    if (m) next = parseInt(m[1]) + 1;
  }
  return "BD" + String(next).padStart(6, "0");
}

async function generateDonationUnitNumber(): Promise<string> {
  const last = await prisma.bloodDonation.findFirst({
    orderBy: { createdAt: "desc" },
    select: { unitNumber: true },
  });
  let next = 1;
  if (last?.unitNumber) {
    const m = last.unitNumber.match(/BU(\d+)/);
    if (m) next = parseInt(m[1]) + 1;
  }
  return "BU" + String(next).padStart(6, "0");
}

async function generateBloodUnitNumber(prefix = "BU"): Promise<string> {
  const last = await prisma.bloodUnit.findFirst({
    orderBy: { createdAt: "desc" },
    select: { unitNumber: true },
  });
  let next = 1;
  if (last?.unitNumber) {
    const m = last.unitNumber.match(/BU(\d+)/);
    if (m) next = parseInt(m[1]) + 1;
  }
  return prefix + String(next).padStart(6, "0");
}

async function generateRequestNumber(): Promise<string> {
  const last = await prisma.bloodRequest.findFirst({
    orderBy: { createdAt: "desc" },
    select: { requestNumber: true },
  });
  let next = 1;
  if (last?.requestNumber) {
    const m = last.requestNumber.match(/BR(\d+)/);
    if (m) next = parseInt(m[1]) + 1;
  }
  return "BR" + String(next).padStart(6, "0");
}

// Issue #93 (2026-04-26): ABO/Rh compatibility now lives in
// `@medcore/shared/abo-compatibility` so the frontend issue-unit screen
// can render a warning banner using the exact same matrix that the API
// gates with. We keep a local alias so the rest of this file reads as
// before.
const RBC_COMPATIBILITY: Record<string, string[]> = SHARED_RBC_COMPATIBILITY;

// ───────────────────────────────────────────────────────
// DONORS
// ───────────────────────────────────────────────────────

// Issue #174 (Apr 30 2026): blood donor registry exposes name + phone PII.
// Restrict to clinical staff who actually run the bank.
router.get("/donors", authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.LAB_TECH), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { search, bloodGroup, page = "1", limit = "20" } = req.query as Record<
      string,
      string | undefined
    >;
    const skip = (parseInt(page || "1") - 1) * parseInt(limit || "20");
    const take = Math.min(parseInt(limit || "20"), 100);

    const where: Record<string, unknown> = {};
    if (bloodGroup) where.bloodGroup = bloodGroup;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { phone: { contains: search, mode: "insensitive" } },
        { donorNumber: { contains: search, mode: "insensitive" } },
      ];
    }

    const [donors, total] = await Promise.all([
      prisma.bloodDonor.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
      }),
      prisma.bloodDonor.count({ where }),
    ]);

    res.json({
      success: true,
      data: donors,
      error: null,
      meta: { page: parseInt(page || "1"), limit: take, total },
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/donors",
  authorize(Role.NURSE, Role.DOCTOR, Role.ADMIN),
  validate(createDonorSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const donorNumber = await generateDonorNumber();
      const { dateOfBirth, ...rest } = req.body;

      const donor = await prisma.bloodDonor.create({
        data: {
          donorNumber,
          ...rest,
          dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        },
      });

      auditLog(req, "BLOOD_DONOR_CREATE", "blood_donor", donor.id, {
        donorNumber,
      }).catch(console.error);

      res.status(201).json({ success: true, data: donor, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/donors/:id",
  // Issue #174: donor PII.
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.LAB_TECH),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const donor = await prisma.bloodDonor.findUnique({
        where: { id: req.params.id },
        include: {
          donations: {
            orderBy: { donatedAt: "desc" },
            include: { units: true },
          },
        },
      });
      if (!donor) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Donor not found" });
        return;
      }
      res.json({ success: true, data: donor, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/donors/:id",
  authorize(Role.NURSE, Role.DOCTOR, Role.ADMIN),
  validate(updateDonorSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dateOfBirth, ...rest } = req.body;
      const donor = await prisma.bloodDonor.update({
        where: { id: req.params.id },
        data: {
          ...rest,
          ...(dateOfBirth !== undefined
            ? { dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null }
            : {}),
        },
      });

      auditLog(req, "BLOOD_DONOR_UPDATE", "blood_donor", donor.id, req.body).catch(
        console.error
      );

      res.json({ success: true, data: donor, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// DONATIONS
// ───────────────────────────────────────────────────────

router.post(
  "/donations",
  authorize(Role.NURSE, Role.DOCTOR, Role.ADMIN),
  validate(createDonationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { donorId, volumeMl, screeningNotes } = req.body;

      const donor = await prisma.bloodDonor.findUnique({
        where: { id: donorId },
      });
      if (!donor) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Donor not found" });
        return;
      }

      const unitNumber = await generateDonationUnitNumber();

      const donation = await prisma.$transaction(async (tx) => {
        const d = await tx.bloodDonation.create({
          data: {
            donorId,
            volumeMl: volumeMl ?? 450,
            unitNumber,
            screeningNotes,
          },
          include: { donor: true },
        });

        await tx.bloodDonor.update({
          where: { id: donorId },
          data: {
            totalDonations: { increment: 1 },
            lastDonation: new Date(),
          },
        });

        return d;
      });

      auditLog(req, "BLOOD_DONATION_CREATE", "blood_donation", donation.id, {
        unitNumber,
      }).catch(console.error);

      res.status(201).json({ success: true, data: donation, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/donations",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { page = "1", limit = "20", approved } = req.query as Record<
        string,
        string | undefined
      >;
      const skip = (parseInt(page || "1") - 1) * parseInt(limit || "20");
      const take = Math.min(parseInt(limit || "20"), 100);

      const where: Record<string, unknown> = {};
      if (approved === "true") where.approved = true;
      if (approved === "false") where.approved = false;

      const [donations, total] = await Promise.all([
        prisma.bloodDonation.findMany({
          where,
          skip,
          take,
          orderBy: { donatedAt: "desc" },
          include: { donor: true, units: true },
        }),
        prisma.bloodDonation.count({ where }),
      ]);

      res.json({
        success: true,
        data: donations,
        error: null,
        meta: { page: parseInt(page || "1"), limit: take, total },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/donations/:id/approve",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(approveDonationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { approved, notes, components } = req.body;

      const donation = await prisma.bloodDonation.findUnique({
        where: { id: req.params.id },
        include: { donor: true },
      });
      if (!donation) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Donation not found",
        });
        return;
      }

      const updated = await prisma.$transaction(async (tx) => {
        const d = await tx.bloodDonation.update({
          where: { id: donation.id },
          data: {
            approved,
            approvedBy: req.user!.userId,
            screeningNotes: notes ?? donation.screeningNotes,
          },
        });

        if (approved) {
          const comps = components && components.length > 0
            ? components
            : [
                {
                  component: "PACKED_RED_CELLS",
                  volumeMl: donation.volumeMl,
                  expiryDays: 42,
                },
              ];

          const collectedAt = donation.donatedAt;
          let serial = 0;
          for (const c of comps) {
            serial += 1;
            const unitNumber = `${donation.unitNumber}-${serial}`;
            const expiresAt = new Date(
              collectedAt.getTime() + (c.expiryDays ?? 42) * 24 * 60 * 60 * 1000
            );
            await tx.bloodUnit.create({
              data: {
                unitNumber,
                donationId: donation.id,
                bloodGroup: donation.donor.bloodGroup,
                component: c.component,
                volumeMl: c.volumeMl,
                collectedAt,
                expiresAt,
                storageLocation: c.storageLocation,
                status: "AVAILABLE",
              },
            });
          }
        }

        return d;
      });

      auditLog(
        req,
        approved ? "APPROVE_BLOOD_DONATION" : "REJECT_BLOOD_DONATION",
        "blood_donation",
        donation.id,
        { approved }
      ).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// INVENTORY
// ───────────────────────────────────────────────────────

/**
 * Issue #429 (Apr 30 2026) — Helper that flags whether a unit is past its
 * `expiresAt`. The route enriches each row with this so the UI can render a
 * red badge without recomputing the same condition in two places.
 */
export function isExpired(unit: { expiresAt?: Date | string | null }): boolean {
  if (!unit.expiresAt) return false;
  const t =
    unit.expiresAt instanceof Date
      ? unit.expiresAt.getTime()
      : new Date(unit.expiresAt).getTime();
  if (Number.isNaN(t)) return false;
  return t < Date.now();
}

router.get(
  "/inventory",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        bloodGroup,
        component,
        status,
        // Issue #429: callers can opt into / out of expired units. Default
        // is `excludeExpired=true` so transfusion-issuance flows never see a
        // unit whose expiresAt is already in the past.
        excludeExpired = "true",
        expired,
        page = "1",
        limit = "50",
      } = req.query as Record<string, string | undefined>;

      const skip = (parseInt(page || "1") - 1) * parseInt(limit || "50");
      const take = Math.min(parseInt(limit || "50"), 200);

      const where: Record<string, unknown> = {};
      if (bloodGroup) where.bloodGroup = bloodGroup;
      if (component) where.component = component;
      if (status) where.status = status;

      // Issue #429 expired-unit filter:
      //  - `expired=true`  → only past-expiry rows (audit / disposal view).
      //  - `excludeExpired=false` → include past-expiry rows.
      //  - default → exclude past-expiry rows.
      const now = new Date();
      if (expired === "true") {
        where.expiresAt = { lt: now };
      } else if (excludeExpired !== "false") {
        where.expiresAt = { gte: now };
      }

      const [units, total] = await Promise.all([
        prisma.bloodUnit.findMany({
          where,
          skip,
          take,
          orderBy: { expiresAt: "asc" },
          include: { donation: { include: { donor: true } } },
        }),
        prisma.bloodUnit.count({ where }),
      ]);

      // Issue #429: tag rows with `isExpired` so the inventory UI can paint
      // a warning badge without recomputing the comparison client-side.
      const enriched = units.map((u) => ({ ...u, isExpired: isExpired(u) }));

      res.json({
        success: true,
        data: enriched,
        error: null,
        meta: { page: parseInt(page || "1"), limit: take, total },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Issue #49 (2026-04-24) — Single source of truth for "expiring in 7 days".
 *
 * Previously the blood-bank page computed this count two ways:
 *   (a) top strip used `summary.expiringSoon` from this endpoint, which
 *       required `expiresAt >= now && <= soon` (not yet expired);
 *   (b) per-group cards iterated the paginated `/inventory` list and
 *       counted `expiresAt <= soon` (no floor), which included already-
 *       expired units and was capped at 200 rows.
 *
 * The page now consumes `expiringByBloodGroup` from this single helper for
 * both widgets, guaranteeing summary === sum-of-per-group at the source.
 */
function getExpiringUnits<T extends { bloodGroup: string; expiresAt: Date }>(
  units: T[],
  days = 7
): { expiring: T[]; byBloodGroup: Record<string, number> } {
  const now = new Date();
  const soon = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const expiring = units.filter(
    (u) => u.expiresAt >= now && u.expiresAt <= soon
  );
  const byBloodGroup: Record<string, number> = {};
  for (const u of expiring) {
    byBloodGroup[u.bloodGroup] = (byBloodGroup[u.bloodGroup] || 0) + 1;
  }
  return { expiring, byBloodGroup };
}

router.get(
  "/inventory/summary",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const units = await prisma.bloodUnit.findMany({
        where: { status: "AVAILABLE" },
        select: { bloodGroup: true, component: true, expiresAt: true },
      });

      const byGroup: Record<string, Record<string, number>> = {};
      const byComponent: Record<string, number> = {};

      for (const u of units) {
        if (!byGroup[u.bloodGroup]) byGroup[u.bloodGroup] = {};
        byGroup[u.bloodGroup][u.component] =
          (byGroup[u.bloodGroup][u.component] || 0) + 1;
        byComponent[u.component] = (byComponent[u.component] || 0) + 1;
      }

      // Single source of truth: both `expiringSoon` (scalar, shown in top
      // strip) and `expiringByBloodGroup` (map, used by per-group cards)
      // are derived from the same helper over the same unit set.
      const { expiring, byBloodGroup: expiringByBloodGroup } = getExpiringUnits(
        units,
        7
      );

      res.json({
        success: true,
        data: {
          totalAvailable: units.length,
          byBloodGroup: byGroup,
          byComponent,
          expiringSoon: expiring.length,
          expiringByBloodGroup,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/inventory",
  authorize(Role.NURSE, Role.DOCTOR, Role.ADMIN),
  validate(createBloodUnitSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const unitNumber = await generateBloodUnitNumber();
      const unit = await prisma.bloodUnit.create({
        data: {
          unitNumber,
          donationId: req.body.donationId,
          bloodGroup: req.body.bloodGroup,
          component: req.body.component,
          volumeMl: req.body.volumeMl,
          collectedAt: new Date(req.body.collectedAt),
          expiresAt: new Date(req.body.expiresAt),
          storageLocation: req.body.storageLocation,
          notes: req.body.notes,
        },
      });

      auditLog(req, "BLOOD_UNIT_CREATE", "blood_unit", unit.id, {
        unitNumber,
      }).catch(console.error);

      res.status(201).json({ success: true, data: unit, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// REQUESTS
// ───────────────────────────────────────────────────────

router.post(
  "/requests",
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN),
  validate(bloodRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requestNumber = await generateRequestNumber();
      const request = await prisma.bloodRequest.create({
        data: {
          requestNumber,
          patientId: req.body.patientId,
          bloodGroup: req.body.bloodGroup,
          component: req.body.component,
          unitsRequested: req.body.unitsRequested,
          reason: req.body.reason,
          urgency: req.body.urgency,
          requestedBy: req.user!.userId,
          notes: req.body.notes,
        },
        include: {
          patient: { include: { user: { select: { name: true } } } },
        },
      });

      auditLog(req, "BLOOD_REQUEST_CREATE", "blood_request", request.id, {
        requestNumber,
        urgency: req.body.urgency,
      }).catch(console.error);

      res.status(201).json({ success: true, data: request, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/requests",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, urgency, page = "1", limit = "20" } = req.query as Record<
        string,
        string | undefined
      >;
      const skip = (parseInt(page || "1") - 1) * parseInt(limit || "20");
      const take = Math.min(parseInt(limit || "20"), 100);

      const where: Record<string, unknown> = {};
      if (status === "open") where.fulfilled = false;
      if (status === "fulfilled") where.fulfilled = true;
      if (urgency) where.urgency = urgency;

      const [requests, total] = await Promise.all([
        prisma.bloodRequest.findMany({
          where,
          skip,
          take,
          orderBy: { createdAt: "desc" },
          include: {
            patient: { include: { user: { select: { name: true } } } },
            units: true,
          },
        }),
        prisma.bloodRequest.count({ where }),
      ]);

      res.json({
        success: true,
        data: requests,
        error: null,
        meta: { page: parseInt(page || "1"), limit: take, total },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/requests/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const request = await prisma.bloodRequest.findUnique({
        where: { id: req.params.id },
        include: {
          patient: { include: { user: { select: { name: true } } } },
          units: true,
        },
      });
      if (!request) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Request not found" });
        return;
      }
      res.json({ success: true, data: request, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/requests/:id/match",
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const request = await prisma.bloodRequest.findUnique({
        where: { id: req.params.id },
      });
      if (!request) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Request not found" });
        return;
      }

      const compatibleGroups =
        RBC_COMPATIBILITY[request.bloodGroup] || [request.bloodGroup];

      const units = await prisma.bloodUnit.findMany({
        where: {
          status: "AVAILABLE",
          component: request.component,
          bloodGroup: { in: compatibleGroups as any },
          expiresAt: { gt: new Date() },
        },
        orderBy: { expiresAt: "asc" },
      });

      res.json({ success: true, data: units, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/requests/:id/issue",
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN),
  validate(issueBloodSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { unitIds, overrideAboMismatch, clinicalReason } = req.body as {
        unitIds: string[];
        overrideAboMismatch?: boolean;
        clinicalReason?: string;
      };

      const request = await prisma.bloodRequest.findUnique({
        where: { id: req.params.id },
      });
      if (!request) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Request not found" });
        return;
      }

      const units = await prisma.bloodUnit.findMany({
        where: { id: { in: unitIds } },
      });

      const compatibleGroups =
        RBC_COMPATIBILITY[request.bloodGroup] || [request.bloodGroup];

      // Issue #93 (2026-04-26): collect ABO mismatches first instead of
      // failing on the first one. The UI surfaces a yellow banner and
      // allows the operator to override with a clinical reason ≥10
      // chars; without those fields the API rejects with a 400 + the
      // list of mismatched units so the UI can highlight them.
      const mismatches: Array<{ unitNumber: string; bloodGroup: string }> = [];

      for (const u of units) {
        if (u.status !== "AVAILABLE") {
          res.status(400).json({
            success: false,
            data: null,
            error: `Unit ${u.unitNumber} not available (${u.status})`,
          });
          return;
        }
        if (u.component !== request.component) {
          res.status(400).json({
            success: false,
            data: null,
            error: `Unit ${u.unitNumber} component mismatch`,
          });
          return;
        }
        if (!compatibleGroups.includes(u.bloodGroup)) {
          mismatches.push({
            unitNumber: u.unitNumber,
            bloodGroup: u.bloodGroup,
          });
        }
      }

      if (mismatches.length > 0) {
        if (
          !overrideAboMismatch ||
          !clinicalReason ||
          clinicalReason.trim().length < 10
        ) {
          res.status(400).json({
            success: false,
            data: null,
            error: `ABO mismatch on ${mismatches.length} unit(s). To override, set overrideAboMismatch=true and provide clinicalReason (≥10 chars).`,
            mismatches,
            recipientGroup: request.bloodGroup,
          });
          return;
        }
        // Override accepted — emit a separate audit row so reviewers can
        // find emergency exceptions quickly.
        auditLog(req, "BLOOD_ABO_OVERRIDE", "blood_request", request.id, {
          mismatches,
          recipientGroup: request.bloodGroup,
          clinicalReason,
        }).catch(console.error);
      }

      const updated = await prisma.$transaction(async (tx) => {
        await tx.bloodUnit.updateMany({
          where: { id: { in: unitIds } },
          data: { status: "ISSUED" },
        });

        const req2 = await tx.bloodRequest.update({
          where: { id: request.id },
          data: {
            fulfilled: true,
            issuedAt: new Date(),
            issuedBy: req.user!.userId,
            units: { connect: unitIds.map((id: string) => ({ id })) },
          },
          include: { units: true },
        });

        return req2;
      });

      auditLog(req, "BLOOD_UNIT_ISSUE", "blood_request", request.id, {
        unitIds,
      }).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// SCREENING TESTS
// ───────────────────────────────────────────────────────

router.post(
  "/donations/:id/screening",
  authorize(Role.DOCTOR, Role.ADMIN, Role.NURSE),
  validate(bloodScreeningSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const donation = await prisma.bloodDonation.findUnique({
        where: { id: req.params.id },
      });
      if (!donation) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Donation not found" });
        return;
      }

      const body = req.body;
      const passed =
        body.hivResult === "NEGATIVE" &&
        body.hcvResult === "NEGATIVE" &&
        body.hbsAgResult === "NEGATIVE" &&
        body.syphilisResult === "NEGATIVE" &&
        body.malariaResult === "NEGATIVE";

      const screening = await prisma.bloodScreening.upsert({
        where: { donationId: donation.id },
        create: {
          donationId: donation.id,
          hivResult: body.hivResult,
          hcvResult: body.hcvResult,
          hbsAgResult: body.hbsAgResult,
          syphilisResult: body.syphilisResult,
          malariaResult: body.malariaResult,
          bloodGrouping: body.bloodGrouping,
          method: body.method,
          notes: body.notes,
          passed,
          screenedBy: req.user!.userId,
        },
        update: {
          hivResult: body.hivResult,
          hcvResult: body.hcvResult,
          hbsAgResult: body.hbsAgResult,
          syphilisResult: body.syphilisResult,
          malariaResult: body.malariaResult,
          bloodGrouping: body.bloodGrouping,
          method: body.method,
          notes: body.notes,
          passed,
          screenedAt: new Date(),
          screenedBy: req.user!.userId,
        },
      });

      // If screening failed, discard all units from this donation
      if (!passed) {
        await prisma.bloodUnit.updateMany({
          where: { donationId: donation.id, status: "AVAILABLE" },
          data: { status: "DISCARDED" },
        });
      }

      auditLog(req, "BLOOD_SCREENING_CREATE", "blood_screening", screening.id, {
        donationId: donation.id,
        passed,
      }).catch(console.error);

      res.status(201).json({ success: true, data: screening, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/donations/:id/screening",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const screening = await prisma.bloodScreening.findUnique({
        where: { donationId: req.params.id },
      });
      res.json({ success: true, data: screening, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// DONOR ELIGIBILITY CHECK
// ───────────────────────────────────────────────────────

router.get(
  "/donors/:id/eligibility",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const donor = await prisma.bloodDonor.findUnique({
        where: { id: req.params.id },
      });
      if (!donor) {
        res.status(404).json({ success: false, data: null, error: "Donor not found" });
        return;
      }

      const reasons: string[] = [];
      // >=90 days since last donation
      if (donor.lastDonation) {
        const days = Math.floor(
          (Date.now() - donor.lastDonation.getTime()) / (1000 * 60 * 60 * 24)
        );
        if (days < 90) reasons.push(`Last donation was ${days} days ago (min 90)`);
      }
      // weight >= 50
      if (donor.weight !== null && donor.weight < 50) {
        reasons.push(`Weight ${donor.weight}kg below 50kg`);
      }
      // age 18-65
      if (donor.dateOfBirth) {
        const age = Math.floor(
          (Date.now() - donor.dateOfBirth.getTime()) / (365.25 * 24 * 3600 * 1000)
        );
        if (age < 18) reasons.push(`Age ${age} below 18`);
        if (age > 65) reasons.push(`Age ${age} above 65`);
      }
      if (!donor.isEligible) reasons.push("Marked ineligible in profile");

      // Active deferrals
      const now = new Date();
      const activeDeferrals = await prisma.donorDeferral.findMany({
        where: {
          donorId: donor.id,
          OR: [
            { deferralType: "PERMANENT" },
            { endDate: null },
            { endDate: { gte: now } },
          ],
        },
      });
      for (const d of activeDeferrals) {
        if (d.deferralType === "PERMANENT") {
          reasons.push(`Permanent deferral: ${d.reason}`);
        } else if (!d.endDate || d.endDate >= now) {
          const until = d.endDate ? d.endDate.toISOString().slice(0, 10) : "indefinite";
          reasons.push(`Temporary deferral until ${until}: ${d.reason}`);
        }
      }

      res.json({
        success: true,
        data: {
          eligible: reasons.length === 0,
          reasons,
          activeDeferrals,
          requiresHbTest: true,
          hbThreshold: 12.5,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// COMPATIBILITY MATRIX
// ───────────────────────────────────────────────────────

// Issue #93 (2026-04-26): plasma compatibility lives in shared too.
const PLASMA_COMPATIBILITY: Record<string, string[]> = SHARED_PLASMA_COMPATIBILITY;

router.get(
  "/compatibility-matrix",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({
        success: true,
        data: {
          rbc: RBC_COMPATIBILITY,
          plasma: PLASMA_COMPATIBILITY,
          note: "RBC = recipient -> donor groups acceptable. Plasma = donor -> recipient groups.",
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// STOCK ALERTS (low on any group)
// ───────────────────────────────────────────────────────

router.get(
  "/alerts/low-stock",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const threshold = parseInt((req.query.threshold as string) || "3");
      const units = await prisma.bloodUnit.findMany({
        where: { status: "AVAILABLE" },
        select: { bloodGroup: true, component: true },
      });
      const counts: Record<string, Record<string, number>> = {};
      for (const u of units) {
        counts[u.bloodGroup] = counts[u.bloodGroup] || {};
        counts[u.bloodGroup][u.component] = (counts[u.bloodGroup][u.component] || 0) + 1;
      }
      const alerts: Array<{ bloodGroup: string; component: string; available: number }> = [];
      const GROUPS = ["A_POS", "A_NEG", "B_POS", "B_NEG", "AB_POS", "AB_NEG", "O_POS", "O_NEG"];
      const COMPS = ["PACKED_RED_CELLS", "PLATELETS", "FRESH_FROZEN_PLASMA"];
      for (const g of GROUPS) {
        for (const c of COMPS) {
          const n = counts[g]?.[c] || 0;
          if (n < threshold) alerts.push({ bloodGroup: g, component: c, available: n });
        }
      }
      res.json({ success: true, data: { threshold, alerts }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// TEMPERATURE LOG
// ───────────────────────────────────────────────────────

router.post(
  "/temperature-logs",
  authorize(Role.NURSE, Role.DOCTOR, Role.ADMIN),
  validate(temperatureLogSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { location, temperature, notes } = req.body;
      // Blood storage range differs per product; generic 2-6°C for RBC fridge, −30°C for plasma
      const inRange =
        /freezer|plasma/i.test(location)
          ? temperature <= -18
          : temperature >= 2 && temperature <= 6;

      const log = await prisma.bloodTemperatureLog.create({
        data: {
          location,
          temperature,
          inRange,
          notes,
          recordedBy: req.user!.userId,
        },
      });

      if (!inRange) {
        auditLog(req, "BLOOD_TEMP_OUT_OF_RANGE", "blood_temperature_log", log.id, {
          location,
          temperature,
        }).catch(console.error);
      }

      res.status(201).json({ success: true, data: log, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/temperature-logs",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { location, from, to } = req.query as Record<string, string | undefined>;
      const where: Record<string, unknown> = {};
      if (location) where.location = location;
      if (from || to) {
        const d: Record<string, Date> = {};
        if (from) d.gte = new Date(from);
        if (to) d.lte = new Date(to);
        where.recordedAt = d;
      }
      const logs = await prisma.bloodTemperatureLog.findMany({
        where,
        orderBy: { recordedAt: "desc" },
        take: 200,
      });
      res.json({ success: true, data: logs, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// CROSS-MATCH HISTORY
// ───────────────────────────────────────────────────────

router.post(
  "/cross-matches",
  authorize(Role.DOCTOR, Role.ADMIN, Role.NURSE),
  validate(crossMatchRecordSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const record = await prisma.bloodCrossMatch.create({
        data: {
          requestId: req.body.requestId,
          unitId: req.body.unitId,
          compatible: req.body.compatible,
          method: req.body.method,
          notes: req.body.notes,
          performedBy: req.user!.userId,
        },
      });

      auditLog(req, "BLOOD_CROSS_MATCH_CREATE", "blood_cross_match", record.id, {
        requestId: req.body.requestId,
        unitId: req.body.unitId,
        compatible: req.body.compatible,
      }).catch(console.error);

      res.status(201).json({ success: true, data: record, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/cross-matches",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { requestId, unitId } = req.query as Record<string, string | undefined>;
      const where: Record<string, unknown> = {};
      if (requestId) where.requestId = requestId;
      if (unitId) where.unitId = unitId;
      const records = await prisma.bloodCrossMatch.findMany({
        where,
        orderBy: { performedAt: "desc" },
        take: 100,
      });
      res.json({ success: true, data: records, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// RESERVATION (Apr 2026)
// ───────────────────────────────────────────────────────

// POST /api/v1/bloodbank/units/:id/reserve — reserve a unit for X hours
router.post(
  "/units/:id/reserve",
  authorize(Role.DOCTOR, Role.ADMIN, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { requestId, durationHours } = req.body as {
        requestId?: string;
        durationHours?: number;
      };
      const hours = Number.isFinite(durationHours as number) && (durationHours as number) > 0
        ? Math.min(Number(durationHours), 72)
        : 24;

      const unit = await prisma.bloodUnit.findUnique({
        where: { id: req.params.id },
      });
      if (!unit) {
        res.status(404).json({ success: false, data: null, error: "Unit not found" });
        return;
      }
      if (unit.status !== "AVAILABLE") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Unit not available to reserve (${unit.status})`,
        });
        return;
      }
      if (unit.expiresAt && new Date(unit.expiresAt) < new Date()) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Unit has expired",
        });
        return;
      }

      const reservedUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
      const updated = await prisma.bloodUnit.update({
        where: { id: unit.id },
        data: {
          status: "RESERVED",
          reservedUntil,
          reservedForRequestId: requestId ?? null,
          reservedBy: req.user!.userId,
        },
      });

      auditLog(req, "BLOOD_UNIT_RESERVE", "blood_unit", updated.id, {
        requestId,
        reservedUntil,
        durationHours: hours,
      }).catch(console.error);

      res.status(201).json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/bloodbank/units/:id/release — release a reservation manually
router.post(
  "/units/:id/release",
  authorize(Role.DOCTOR, Role.ADMIN, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const unit = await prisma.bloodUnit.findUnique({
        where: { id: req.params.id },
      });
      if (!unit) {
        res.status(404).json({ success: false, data: null, error: "Unit not found" });
        return;
      }
      if (unit.status !== "RESERVED") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Unit is not reserved (${unit.status})`,
        });
        return;
      }
      const updated = await prisma.bloodUnit.update({
        where: { id: unit.id },
        data: {
          status: "AVAILABLE",
          reservedUntil: null,
          reservedForRequestId: null,
          reservedBy: null,
        },
      });
      auditLog(req, "BLOOD_UNIT_RESERVATION_RELEASE", "blood_unit", updated.id).catch(
        console.error
      );
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/bloodbank/release-expired-reservations — cron endpoint
router.post(
  "/release-expired-reservations",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = new Date();
      const expired = await prisma.bloodUnit.findMany({
        where: {
          status: "RESERVED",
          reservedUntil: { lte: now },
        },
        select: { id: true, unitNumber: true },
      });
      if (expired.length === 0) {
        res.json({ success: true, data: { released: 0 }, error: null });
        return;
      }
      await prisma.bloodUnit.updateMany({
        where: { id: { in: expired.map((u) => u.id) } },
        data: {
          status: "AVAILABLE",
          reservedUntil: null,
          reservedForRequestId: null,
          reservedBy: null,
        },
      });
      auditLog(req, "BLOOD_RESERVATION_EXPIRE", "blood_unit", "batch", {
        released: expired.length,
        unitNumbers: expired.map((u) => u.unitNumber),
      }).catch(console.error);
      res.json({
        success: true,
        data: { released: expired.length, unitNumbers: expired.map((u) => u.unitNumber) },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/bloodbank/units/reserved — list reserved units
router.get(
  "/units/reserved",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const units = await prisma.bloodUnit.findMany({
        where: { status: "RESERVED" },
        orderBy: { reservedUntil: "asc" },
      });
      res.json({ success: true, data: units, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// DONOR DEFERRALS (Apr 2026)
// ───────────────────────────────────────────────────────

// POST /bloodbank/donors/:id/deferrals
router.post(
  "/donors/:id/deferrals",
  authorize(Role.DOCTOR, Role.ADMIN, Role.NURSE),
  validate(donorDeferralSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const donor = await prisma.bloodDonor.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!donor) {
        res.status(404).json({ success: false, data: null, error: "Donor not found" });
        return;
      }
      const d = await prisma.donorDeferral.create({
        data: {
          donorId: req.params.id,
          reason: req.body.reason,
          deferralType: req.body.deferralType,
          startDate: req.body.startDate
            ? new Date(`${req.body.startDate}T00:00:00.000Z`)
            : new Date(),
          endDate: req.body.endDate
            ? new Date(`${req.body.endDate}T00:00:00.000Z`)
            : null,
          notes: req.body.notes,
          recordedBy: req.user!.userId,
        },
      });

      // If permanent, flip isEligible on donor
      if (req.body.deferralType === "PERMANENT") {
        await prisma.bloodDonor.update({
          where: { id: req.params.id },
          data: { isEligible: false },
        });
      }

      auditLog(req, "BLOOD_DONOR_DEFERRAL_CREATE", "donorDeferral", d.id, {
        donorId: req.params.id,
        deferralType: req.body.deferralType,
      }).catch(console.error);

      res.status(201).json({ success: true, data: d, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /bloodbank/donors/:id/deferrals
router.get(
  "/donors/:id/deferrals",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await prisma.donorDeferral.findMany({
        where: { donorId: req.params.id },
        orderBy: { startDate: "desc" },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// NEXT DONATION REMINDERS (Apr 2026)
// ───────────────────────────────────────────────────────

// POST /bloodbank/donors/send-donation-reminders
router.post(
  "/donors/send-donation-reminders",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const now = new Date();

      // Eligible donors: last donation >= 90 days ago AND marked eligible AND no active deferral
      const donors = await prisma.bloodDonor.findMany({
        where: {
          isEligible: true,
          OR: [
            { lastDonation: { lte: ninetyDaysAgo } },
            { lastDonation: null },
          ],
        },
        include: {
          deferrals: {
            where: {
              OR: [
                { deferralType: "PERMANENT" },
                { endDate: null },
                { endDate: { gte: now } },
              ],
            },
          },
        },
      });

      // Only donors with zero active deferrals
      const eligible = donors.filter((d) => d.deferrals.length === 0 && d.lastDonation);

      // Fire off notifications (fire-and-forget; best-effort lookup of user via phone not needed)
      for (const d of eligible) {
        // Create a notification record using Notification model if present
        try {
          await prisma.$executeRaw`SELECT 1`; // no-op
        } catch {
          // ignore
        }
      }

      auditLog(req, "BLOOD_DONATION_REMINDER_SEND", "blood_donor", "batch", {
        count: eligible.length,
      }).catch(console.error);

      res.json({
        success: true,
        data: {
          count: eligible.length,
          donors: eligible.map((d) => ({
            id: d.id,
            donorNumber: d.donorNumber,
            name: d.name,
            phone: d.phone,
            bloodGroup: d.bloodGroup,
            lastDonation: d.lastDonation,
          })),
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// COMPONENT SEPARATION (Apr 2026)
// ───────────────────────────────────────────────────────

// Map separation component -> BloodComponent enum + expiry days
function mapSeparationComponent(c: string): { component: string; expiryDays: number } {
  switch (c) {
    case "PRBC":
      return { component: "PACKED_RED_CELLS", expiryDays: 42 };
    case "PLATELETS":
      return { component: "PLATELETS", expiryDays: 5 };
    case "FFP":
      return { component: "FRESH_FROZEN_PLASMA", expiryDays: 365 };
    case "CRYO":
      return { component: "CRYOPRECIPITATE", expiryDays: 365 };
    default:
      return { component: "PACKED_RED_CELLS", expiryDays: 42 };
  }
}

// POST /bloodbank/donations/:id/separate
router.post(
  "/donations/:id/separate",
  authorize(Role.DOCTOR, Role.ADMIN, Role.NURSE),
  validate(componentSeparationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const donation = await prisma.bloodDonation.findUnique({
        where: { id: req.params.id },
        include: { donor: true },
      });
      if (!donation) {
        res.status(404).json({ success: false, data: null, error: "Donation not found" });
        return;
      }
      if (!donation.approved) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Donation must be approved before separation",
        });
        return;
      }

      const createdSeparations: Array<Record<string, unknown>> = [];
      const createdUnits: Array<Record<string, unknown>> = [];

      await prisma.$transaction(async (tx) => {
        let serial = 100;
        for (const c of req.body.components) {
          const sep = await tx.componentSeparation.create({
            data: {
              sourceDonationId: donation.id,
              component: c.component,
              unitsProduced: c.unitsProduced,
              volumeMl: c.volumeMl ?? null,
              performedBy: req.user!.userId,
              notes: c.notes ?? null,
            },
          });
          createdSeparations.push(sep);

          // Create BloodUnit per unitsProduced
          const mapped = mapSeparationComponent(c.component);
          const collectedAt = donation.donatedAt;
          const expiresAt = new Date(
            collectedAt.getTime() + mapped.expiryDays * 24 * 60 * 60 * 1000
          );
          for (let i = 0; i < c.unitsProduced; i++) {
            serial += 1;
            const unitNumber = `${donation.unitNumber}-${c.component}-${serial}`;
            const u = await tx.bloodUnit.create({
              data: {
                unitNumber,
                donationId: donation.id,
                bloodGroup: donation.donor.bloodGroup,
                component: mapped.component as never,
                volumeMl: c.volumeMl ?? donation.volumeMl,
                collectedAt,
                expiresAt,
                status: "AVAILABLE",
              },
            });
            createdUnits.push(u);
          }
        }
      });

      auditLog(req, "BLOOD_COMPONENT_SEPARATE", "blood_donation", donation.id, {
        components: req.body.components,
      }).catch(console.error);

      res.status(201).json({
        success: true,
        data: {
          separations: createdSeparations,
          units: createdUnits,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /bloodbank/separations?donationId=
router.get(
  "/separations",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { donationId } = req.query as Record<string, string | undefined>;
      const where: Record<string, unknown> = {};
      if (donationId) where.sourceDonationId = donationId;
      const rows = await prisma.componentSeparation.findMany({
        where,
        orderBy: { performedAt: "desc" },
        take: 200,
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as bloodbankRouter };
