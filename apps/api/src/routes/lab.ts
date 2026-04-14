import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createLabTestSchema,
  updateLabTestSchema,
  createLabOrderSchema,
  updateLabOrderStatusSchema,
  recordLabResultSchema,
  labReferenceRangeSchema,
  sampleRejectSchema,
  batchResultSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// ───────────────────────────────────────────────────────
// LAB TEST CATALOG
// ───────────────────────────────────────────────────────

// GET /api/v1/lab/tests
router.get("/tests", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { search, category } = req.query as Record<string, string | undefined>;
    const where: Record<string, unknown> = {};
    if (category) where.category = category;
    if (search) {
      where.OR = [
        { code: { contains: search, mode: "insensitive" } },
        { name: { contains: search, mode: "insensitive" } },
      ];
    }
    const tests = await prisma.labTest.findMany({
      where,
      orderBy: { name: "asc" },
    });
    res.json({ success: true, data: tests, error: null });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/lab/tests — admin only
router.post(
  "/tests",
  authorize(Role.ADMIN),
  validate(createLabTestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const test = await prisma.labTest.create({ data: req.body });
      auditLog(req, "CREATE_LAB_TEST", "lab_test", test.id, {
        code: test.code,
        name: test.name,
      }).catch(console.error);
      res.status(201).json({ success: true, data: test, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/lab/tests/:id
router.patch(
  "/tests/:id",
  authorize(Role.ADMIN),
  validate(updateLabTestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const test = await prisma.labTest.update({
        where: { id: req.params.id },
        data: req.body,
      });
      auditLog(req, "UPDATE_LAB_TEST", "lab_test", test.id, req.body).catch(
        console.error
      );
      res.json({ success: true, data: test, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// LAB ORDERS
// ───────────────────────────────────────────────────────

// GET /api/v1/lab/orders?patientId=&status=
router.get(
  "/orders",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        patientId,
        doctorId,
        status,
        priority,
        stat,
        page = "1",
        limit = "20",
      } = req.query as Record<string, string | undefined>;

      const skip = (parseInt(page || "1") - 1) * parseInt(limit || "20");
      const take = Math.min(parseInt(limit || "20"), 100);

      const where: Record<string, unknown> = {};
      if (patientId) where.patientId = patientId;
      if (doctorId) where.doctorId = doctorId;
      if (status) where.status = status;
      if (priority) where.priority = priority;
      if (stat === "true") where.stat = true;

      // Patients see only their own
      if (req.user!.role === "PATIENT") {
        const patient = await prisma.patient.findUnique({
          where: { userId: req.user!.userId },
        });
        if (patient) where.patientId = patient.id;
      }

      const [orders, total] = await Promise.all([
        prisma.labOrder.findMany({
          where,
          include: {
            items: { include: { test: true } },
            patient: {
              include: { user: { select: { name: true, phone: true } } },
            },
            doctor: { include: { user: { select: { name: true } } } },
          },
          skip,
          take,
          orderBy: [{ stat: "desc" }, { orderedAt: "desc" }],
        }),
        prisma.labOrder.count({ where }),
      ]);

      res.json({
        success: true,
        data: orders,
        error: null,
        meta: { page: parseInt(page || "1"), limit: take, total },
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/lab/orders/:id — full detail
router.get(
  "/orders/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await prisma.labOrder.findUnique({
        where: { id: req.params.id },
        include: {
          items: {
            include: {
              test: true,
              results: { orderBy: { reportedAt: "desc" } },
            },
          },
          patient: {
            include: {
              user: { select: { name: true, phone: true, email: true } },
            },
          },
          doctor: {
            include: { user: { select: { name: true, email: true } } },
          },
        },
      });

      if (!order) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Lab order not found" });
        return;
      }

      res.json({ success: true, data: order, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// Helper: generate LAB order number
async function generateOrderNumber(): Promise<string> {
  const last = await prisma.labOrder.findFirst({
    orderBy: { orderedAt: "desc" },
    select: { orderNumber: true },
  });
  let next = 1;
  if (last?.orderNumber) {
    const m = last.orderNumber.match(/LAB(\d+)/);
    if (m) next = parseInt(m[1]) + 1;
  }
  return "LAB" + String(next).padStart(6, "0");
}

// POST /api/v1/lab/orders — doctor creates order
router.post(
  "/orders",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(createLabOrderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, doctorId, admissionId, testIds, notes, priority } = req.body as {
        patientId: string;
        doctorId: string;
        admissionId?: string;
        testIds: string[];
        notes?: string;
        priority?: "ROUTINE" | "URGENT" | "STAT";
      };

      const orderNumber = await generateOrderNumber();
      const normalizedPriority = priority === "STAT" || priority === "URGENT" ? priority : "ROUTINE";
      const isStat = normalizedPriority === "STAT";

      const order = await prisma.labOrder.create({
        data: {
          orderNumber,
          patientId,
          doctorId,
          admissionId,
          notes,
          priority: normalizedPriority,
          stat: isStat,
          items: {
            create: testIds.map((testId: string) => ({ testId })),
          },
        },
        include: {
          items: { include: { test: true } },
          patient: { include: { user: { select: { name: true } } } },
          doctor: { include: { user: { select: { name: true, id: true } } } },
        },
      });

      // STAT: fire-and-forget notify lab techs + ordering doctor
      if (isStat) {
        (async () => {
          try {
            const labTechs = await prisma.user.findMany({
              where: { role: "NURSE", isActive: true },
              select: { id: true },
              take: 10,
            });
            const targets = [
              ...labTechs.map((u) => u.id),
              order.doctor.user.id,
            ];
            const { sendNotification } = await import(
              "../services/notification"
            );
            const { NotificationType } = await import("@medcore/shared");
            await Promise.all(
              targets.map((uid) =>
                sendNotification({
                  userId: uid,
                  type: NotificationType.APPOINTMENT_REMINDER, // reuse for now
                  title: "STAT Lab Order",
                  message: `STAT lab order ${orderNumber} created — immediate action required.`,
                  data: { orderId: order.id, orderNumber, priority: "STAT" },
                })
              )
            );
          } catch (e) {
            console.error("[lab-stat-notify]", e);
          }
        })();
      }

      auditLog(req, "CREATE_LAB_ORDER", "lab_order", order.id, {
        orderNumber,
        testCount: testIds.length,
        priority: normalizedPriority,
        stat: isStat,
      }).catch(console.error);

      res.status(201).json({ success: true, data: order, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/lab/orders/:id/status
router.patch(
  "/orders/:id/status",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(updateLabOrderStatusSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status } = req.body;
      const data: Record<string, unknown> = { status };

      if (status === "SAMPLE_COLLECTED") data.collectedAt = new Date();
      if (status === "COMPLETED") data.completedAt = new Date();

      const order = await prisma.labOrder.update({
        where: { id: req.params.id },
        data,
        include: { items: true },
      });

      // Also propagate status to items (if not already completed)
      if (status === "COMPLETED" || status === "CANCELLED") {
        await prisma.labOrderItem.updateMany({
          where: { orderId: order.id },
          data: { status },
        });
      }

      auditLog(req, "UPDATE_LAB_ORDER_STATUS", "lab_order", order.id, {
        status,
      }).catch(console.error);

      res.json({ success: true, data: order, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/lab/results — record a result
router.post(
  "/results",
  authorize(Role.NURSE, Role.DOCTOR, Role.ADMIN),
  validate(recordLabResultSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderItemId, parameter, value, unit, normalRange, flag, notes } =
        req.body;

      const orderItem = await prisma.labOrderItem.findUnique({
        where: { id: orderItemId },
      });
      if (!orderItem) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Lab order item not found",
        });
        return;
      }

      const result = await prisma.labResult.create({
        data: {
          orderItemId,
          parameter,
          value,
          unit,
          normalRange,
          flag: flag ?? "NORMAL",
          notes,
          enteredBy: req.user!.userId,
        },
      });

      // Mark this order item as completed
      await prisma.labOrderItem.update({
        where: { id: orderItemId },
        data: { status: "COMPLETED" },
      });

      // If all items of the order are completed, mark order COMPLETED
      const siblings = await prisma.labOrderItem.findMany({
        where: { orderId: orderItem.orderId },
        select: { status: true },
      });
      const allDone = siblings.every((s) => s.status === "COMPLETED");
      if (allDone) {
        await prisma.labOrder.update({
          where: { id: orderItem.orderId },
          data: { status: "COMPLETED", completedAt: new Date() },
        });
      } else {
        // If order is still ORDERED, bump to IN_PROGRESS
        await prisma.labOrder.updateMany({
          where: {
            id: orderItem.orderId,
            status: { in: ["ORDERED", "SAMPLE_COLLECTED"] },
          },
          data: { status: "IN_PROGRESS" },
        });
      }

      auditLog(req, "RECORD_LAB_RESULT", "lab_result", result.id, {
        orderItemId,
        parameter,
        flag: flag ?? "NORMAL",
      }).catch(console.error);

      res.status(201).json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/lab/results/:orderItemId
router.get(
  "/results/:orderItemId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const results = await prisma.labResult.findMany({
        where: { orderItemId: req.params.orderItemId },
        orderBy: { reportedAt: "desc" },
      });
      res.json({ success: true, data: results, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// REFERENCE RANGES (age/gender-specific)
// ───────────────────────────────────────────────────────

router.get(
  "/tests/:id/ranges",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ranges = await prisma.labTestReferenceRange.findMany({
        where: { testId: req.params.id },
        orderBy: [{ parameter: "asc" }, { ageMin: "asc" }],
      });
      res.json({ success: true, data: ranges, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/tests/:id/ranges",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = labReferenceRangeSchema.parse({
        ...req.body,
        testId: req.params.id,
      });
      const range = await prisma.labTestReferenceRange.create({ data: parsed });
      auditLog(req, "CREATE_LAB_REFERENCE_RANGE", "lab_test_reference_range", range.id, {
        testId: range.testId,
      }).catch(console.error);
      res.status(201).json({ success: true, data: range, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/ranges/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await prisma.labTestReferenceRange.delete({ where: { id: req.params.id } });
      auditLog(req, "DELETE_LAB_REFERENCE_RANGE", "lab_test_reference_range", req.params.id).catch(
        console.error
      );
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/lab/tests/:id/applicable-range?patientId=&parameter=
router.get(
  "/tests/:id/applicable-range",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, parameter } = req.query as Record<string, string | undefined>;
      if (!patientId) {
        res.status(400).json({ success: false, data: null, error: "patientId required" });
        return;
      }
      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        select: { dateOfBirth: true, gender: true },
      });
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      const ageYears = patient.dateOfBirth
        ? Math.floor((Date.now() - patient.dateOfBirth.getTime()) / (365.25 * 24 * 3600 * 1000))
        : null;

      const ranges = await prisma.labTestReferenceRange.findMany({
        where: {
          testId: req.params.id,
          ...(parameter ? { parameter } : {}),
        },
      });

      const genderStr =
        patient.gender === "MALE" ? "MALE" : patient.gender === "FEMALE" ? "FEMALE" : null;
      const match =
        ranges.find(
          (r) =>
            (r.gender === genderStr || r.gender === null) &&
            (ageYears === null ||
              ((r.ageMin === null || r.ageMin <= ageYears) &&
                (r.ageMax === null || r.ageMax >= ageYears)))
        ) || null;

      res.json({
        success: true,
        data: { range: match, ageYears, gender: genderStr },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// SAMPLE REJECTION WORKFLOW
// ───────────────────────────────────────────────────────

router.patch(
  "/orders/:id/reject-sample",
  authorize(Role.NURSE, Role.DOCTOR, Role.ADMIN),
  validate(sampleRejectSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { reason, notes } = req.body;
      const order = await prisma.labOrder.update({
        where: { id: req.params.id },
        data: {
          status: "SAMPLE_REJECTED",
          rejectedAt: new Date(),
          rejectionReason: reason,
          notes: notes ? `REJECTED: ${notes}` : undefined,
        },
      });
      auditLog(req, "REJECT_LAB_SAMPLE", "lab_order", order.id, { reason }).catch(
        console.error
      );
      res.json({ success: true, data: order, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// BATCH RESULT ENTRY + PANIC VALUE ALERT
// ───────────────────────────────────────────────────────

router.post(
  "/results/batch",
  authorize(Role.NURSE, Role.DOCTOR, Role.ADMIN),
  validate(batchResultSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderId, results } = req.body as {
        orderId: string;
        results: Array<{
          orderItemId: string;
          parameter: string;
          value: string;
          unit?: string;
          normalRange?: string;
          flag?: "NORMAL" | "LOW" | "HIGH" | "CRITICAL";
          notes?: string;
        }>;
      };

      const created = await prisma.$transaction(async (tx) => {
        const out = [];
        for (const r of results) {
          const created = await tx.labResult.create({
            data: {
              orderItemId: r.orderItemId,
              parameter: r.parameter,
              value: r.value,
              unit: r.unit,
              normalRange: r.normalRange,
              flag: r.flag ?? "NORMAL",
              notes: r.notes,
              enteredBy: req.user!.userId,
            },
          });
          out.push(created);
          await tx.labOrderItem.update({
            where: { id: r.orderItemId },
            data: { status: "COMPLETED" },
          });
        }

        const siblings = await tx.labOrderItem.findMany({
          where: { orderId },
          select: { status: true },
        });
        if (siblings.every((s) => s.status === "COMPLETED")) {
          await tx.labOrder.update({
            where: { id: orderId },
            data: { status: "COMPLETED", completedAt: new Date() },
          });
        } else {
          await tx.labOrder.updateMany({
            where: {
              id: orderId,
              status: { in: ["ORDERED", "SAMPLE_COLLECTED"] },
            },
            data: { status: "IN_PROGRESS" },
          });
        }
        return out;
      });

      const criticals = created.filter((r) => r.flag === "CRITICAL");
      if (criticals.length > 0) {
        const order = await prisma.labOrder.findUnique({
          where: { id: orderId },
          include: {
            doctor: { include: { user: true } },
            patient: { include: { user: true } },
          },
        });
        if (order?.doctor?.user) {
          await prisma.notification
            .create({
              data: {
                userId: order.doctor.user.id,
                type: "LAB_RESULT_READY",
                channel: "PUSH",
                title: `Critical lab result: ${order.patient?.user?.name ?? "patient"}`,
                message: `${criticals.length} critical value(s) in order ${order.orderNumber}. Review urgently.`,
              },
            })
            .catch(() => {});
        }
      }

      auditLog(req, "BATCH_LAB_RESULTS", "lab_order", orderId, {
        count: created.length,
        critical: criticals.length,
      }).catch(console.error);

      res.status(201).json({
        success: true,
        data: { results: created, criticalCount: criticals.length },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// TAT REPORT
// ───────────────────────────────────────────────────────

router.get(
  "/reports/tat",
  authorize(Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from, to } = req.query as Record<string, string | undefined>;
      const where: Record<string, unknown> = {
        status: "COMPLETED",
        completedAt: { not: null },
      };
      if (from || to) {
        const d: Record<string, Date> = {};
        if (from) d.gte = new Date(from);
        if (to) d.lte = new Date(to);
        where.orderedAt = d;
      }
      const orders = await prisma.labOrder.findMany({
        where,
        select: {
          id: true,
          orderNumber: true,
          orderedAt: true,
          completedAt: true,
          items: { select: { test: { select: { name: true, tatHours: true } } } },
        },
        take: 500,
      });

      const rows = orders.map((o) => {
        const diffMs = o.completedAt!.getTime() - o.orderedAt.getTime();
        const actualHours = diffMs / (1000 * 60 * 60);
        const expected = o.items
          .map((i) => i.test.tatHours)
          .filter((h): h is number => typeof h === "number");
        const expectedHours = expected.length > 0 ? Math.max(...expected) : null;
        return {
          id: o.id,
          orderNumber: o.orderNumber,
          actualHours: Math.round(actualHours * 10) / 10,
          expectedHours,
          breached: expectedHours !== null ? actualHours > expectedHours : null,
        };
      });

      const breached = rows.filter((r) => r.breached === true).length;
      const avg =
        rows.length > 0
          ? Math.round((rows.reduce((s, r) => s + r.actualHours, 0) / rows.length) * 10) / 10
          : 0;

      res.json({
        success: true,
        data: { count: rows.length, avgHours: avg, breached, rows },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// RESULT TRENDS
// ───────────────────────────────────────────────────────

router.get(
  "/results/trends",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, testId, parameter } = req.query as Record<
        string,
        string | undefined
      >;
      if (!patientId) {
        res.status(400).json({ success: false, data: null, error: "patientId required" });
        return;
      }

      const items = await prisma.labOrderItem.findMany({
        where: {
          order: { patientId },
          ...(testId ? { testId } : {}),
        },
        include: {
          test: { select: { name: true, unit: true } },
          order: { select: { orderedAt: true, orderNumber: true } },
          results: parameter ? { where: { parameter } } : true,
        },
        orderBy: { order: { orderedAt: "desc" } },
        take: 50,
      });

      const points = items.flatMap((it) =>
        it.results.map((r) => ({
          orderedAt: it.order.orderedAt,
          orderNumber: it.order.orderNumber,
          testName: it.test.name,
          parameter: r.parameter,
          value: r.value,
          unit: r.unit ?? it.test.unit,
          flag: r.flag,
        }))
      );

      res.json({ success: true, data: points, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// LAB REPORT PAYLOAD (client generates PDF)
// ───────────────────────────────────────────────────────

router.get(
  "/orders/:id/report",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await prisma.labOrder.findUnique({
        where: { id: req.params.id },
        include: {
          items: {
            include: {
              test: true,
              results: { orderBy: { reportedAt: "asc" } },
            },
          },
          patient: {
            include: {
              user: { select: { name: true, phone: true, email: true } },
            },
          },
          doctor: { include: { user: { select: { name: true } } } },
        },
      });
      if (!order) {
        res.status(404).json({ success: false, data: null, error: "Lab order not found" });
        return;
      }

      const tatHours = order.completedAt
        ? Math.round(
            ((order.completedAt.getTime() - order.orderedAt.getTime()) / 3600000) * 10
          ) / 10
        : null;

      const report = {
        orderNumber: order.orderNumber,
        orderedAt: order.orderedAt,
        collectedAt: order.collectedAt,
        completedAt: order.completedAt,
        status: order.status,
        turnaroundHours: tatHours,
        patient: {
          id: order.patient.id,
          mrNumber: (order.patient as any).mrNumber,
          name: order.patient.user.name,
          phone: order.patient.user.phone,
          dateOfBirth: (order.patient as any).dateOfBirth,
          gender: (order.patient as any).gender,
        },
        doctor: order.doctor?.user?.name,
        notes: order.notes,
        items: order.items.map((it) => ({
          testCode: it.test.code,
          testName: it.test.name,
          category: it.test.category,
          sampleType: it.test.sampleType,
          normalRange: it.test.normalRange,
          unit: it.test.unit,
          status: it.status,
          results: it.results,
        })),
      };

      res.json({ success: true, data: report, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as labRouter };
