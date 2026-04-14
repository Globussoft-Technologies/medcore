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

// ABO/Rh compatibility (recipient -> list of donor blood groups for RBC)
const RBC_COMPATIBILITY: Record<string, string[]> = {
  A_POS: ["A_POS", "A_NEG", "O_POS", "O_NEG"],
  A_NEG: ["A_NEG", "O_NEG"],
  B_POS: ["B_POS", "B_NEG", "O_POS", "O_NEG"],
  B_NEG: ["B_NEG", "O_NEG"],
  AB_POS: ["A_POS", "A_NEG", "B_POS", "B_NEG", "AB_POS", "AB_NEG", "O_POS", "O_NEG"],
  AB_NEG: ["A_NEG", "B_NEG", "AB_NEG", "O_NEG"],
  O_POS: ["O_POS", "O_NEG"],
  O_NEG: ["O_NEG"],
};

// ───────────────────────────────────────────────────────
// DONORS
// ───────────────────────────────────────────────────────

router.get("/donors", async (req: Request, res: Response, next: NextFunction) => {
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

      auditLog(req, "CREATE_BLOOD_DONOR", "blood_donor", donor.id, {
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

      auditLog(req, "UPDATE_BLOOD_DONOR", "blood_donor", donor.id, req.body).catch(
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

      auditLog(req, "CREATE_BLOOD_DONATION", "blood_donation", donation.id, {
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

router.get(
  "/inventory",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        bloodGroup,
        component,
        status,
        page = "1",
        limit = "50",
      } = req.query as Record<string, string | undefined>;

      const skip = (parseInt(page || "1") - 1) * parseInt(limit || "50");
      const take = Math.min(parseInt(limit || "50"), 200);

      const where: Record<string, unknown> = {};
      if (bloodGroup) where.bloodGroup = bloodGroup;
      if (component) where.component = component;
      if (status) where.status = status;

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

      res.json({
        success: true,
        data: units,
        error: null,
        meta: { page: parseInt(page || "1"), limit: take, total },
      });
    } catch (err) {
      next(err);
    }
  }
);

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
      let expiringSoon = 0;
      const now = new Date();
      const soon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

      for (const u of units) {
        if (!byGroup[u.bloodGroup]) byGroup[u.bloodGroup] = {};
        byGroup[u.bloodGroup][u.component] =
          (byGroup[u.bloodGroup][u.component] || 0) + 1;
        byComponent[u.component] = (byComponent[u.component] || 0) + 1;
        if (u.expiresAt <= soon && u.expiresAt >= now) expiringSoon += 1;
      }

      res.json({
        success: true,
        data: {
          totalAvailable: units.length,
          byBloodGroup: byGroup,
          byComponent,
          expiringSoon,
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

      auditLog(req, "CREATE_BLOOD_UNIT", "blood_unit", unit.id, {
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

      auditLog(req, "CREATE_BLOOD_REQUEST", "blood_request", request.id, {
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
      const { unitIds } = req.body;

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
          res.status(400).json({
            success: false,
            data: null,
            error: `Unit ${u.unitNumber} incompatible blood group`,
          });
          return;
        }
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

      auditLog(req, "ISSUE_BLOOD_UNITS", "blood_request", request.id, {
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

      auditLog(req, "RECORD_BLOOD_SCREENING", "blood_screening", screening.id, {
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

      res.json({
        success: true,
        data: {
          eligible: reasons.length === 0,
          reasons,
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

const PLASMA_COMPATIBILITY: Record<string, string[]> = {
  A_POS: ["A_POS", "A_NEG", "AB_POS", "AB_NEG"],
  A_NEG: ["A_POS", "A_NEG", "AB_POS", "AB_NEG"],
  B_POS: ["B_POS", "B_NEG", "AB_POS", "AB_NEG"],
  B_NEG: ["B_POS", "B_NEG", "AB_POS", "AB_NEG"],
  AB_POS: ["AB_POS", "AB_NEG"],
  AB_NEG: ["AB_POS", "AB_NEG"],
  O_POS: ["O_POS", "O_NEG", "A_POS", "A_NEG", "B_POS", "B_NEG", "AB_POS", "AB_NEG"],
  O_NEG: ["O_POS", "O_NEG", "A_POS", "A_NEG", "B_POS", "B_NEG", "AB_POS", "AB_NEG"],
};

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

      auditLog(req, "RECORD_CROSS_MATCH", "blood_cross_match", record.id, {
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

export { router as bloodbankRouter };
