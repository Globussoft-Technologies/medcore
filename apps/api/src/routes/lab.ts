import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site in the authenticated router keeps
// working without edits. The `publicLabRouter` at the bottom of the file
// is unauthenticated (signed-URL verification for shared lab reports), so
// it uses the raw, un-scoped `prisma` via `rawPrisma`.
import { prisma as rawPrisma } from "@medcore/db";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import crypto from "crypto";
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
  labQCSchema,
  verifyResultSchema,
  shareLinkSchema,
  validateNumericLabResult,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { assertPatientOwnsResource } from "../middleware/patient-self-only";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { generateLabReportHTML } from "../services/pdf";
import { sendNotification } from "../services/notification";
import { ingestLabResult, fireAndForgetIngest } from "../services/ai/rag-ingest";

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
      auditLog(req, "LAB_TEST_CREATE", "lab_test", test.id, {
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
      auditLog(req, "LAB_TEST_UPDATE", "lab_test", test.id, req.body).catch(
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
// RBAC (issue #90): RECEPTION must NOT see lab orders / clinical data.
// PATIENT path enforced inline below.
router.get(
  "/orders",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.LAB_TECH, Role.PATIENT),
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

      // Issue #183 (Apr 2026): Doctors default to seeing only orders THEY
      // ordered. Previously the lab order list leaked across all doctors —
      // a Doctor in OPD-3 could see another Doctor's STAT panels in OPD-1,
      // including the patient name. NURSE / LAB_TECH still see all so the
      // lab can process; ADMIN sees all for support.
      if (req.user!.role === "DOCTOR") {
        const doctor = await prisma.doctor.findUnique({
          where: { userId: req.user!.userId },
        });
        if (doctor) where.doctorId = doctor.id;
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
// RBAC (issue #90): RECEPTION excluded.
router.get(
  "/orders/:id",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.LAB_TECH, Role.PATIENT),
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

      // Issue #474 (BOLA): PATIENT must only see own lab orders.
      if (!(await assertPatientOwnsResource(req, res, order.patientId))) return;

      res.json({ success: true, data: order, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// Helper: generate LAB order number
async function generateOrderNumber(): Promise<string> {
  const last = await prisma.labOrder.findFirst({
    where: { orderNumber: { startsWith: "LAB" } },
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

      auditLog(req, "LAB_ORDER_CREATE", "lab_order", order.id, {
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

      auditLog(req, "LAB_ORDER_STATUS_UPDATE", "lab_order", order.id, {
        status,
      }).catch(console.error);

      res.json({ success: true, data: order, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/lab/results — record a result
// Only lab technicians and admins may enter results. Doctors/nurses used to be
// allowed here, but that violates separation of duties (the ordering doctor
// must not be the one entering the value they ordered). See GitHub issue #14.
router.post(
  "/results",
  authorize(Role.LAB_TECH, Role.ADMIN),
  validate(recordLabResultSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orderItemId, parameter, value, unit, normalRange, flag, notes } =
        req.body;

      const orderItem = await prisma.labOrderItem.findUnique({
        where: { id: orderItemId },
        include: { test: true },
      });
      if (!orderItem) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Lab order item not found",
        });
        return;
      }

      // Issue #95 (clinical safety): block free-text values for numeric tests.
      // The recordLabResultSchema only enforces "non-empty string"; the test's
      // unit / panic thresholds tell us whether the value column must be a
      // parseable number. Saving "abc" silently bypasses delta-check and panic
      // alerts, so we reject with a 400 + field-level detail (same shape the
      // zod middleware emits, so the UI's extractFieldErrors helper renders it).
      const numericIssue = validateNumericLabResult({
        value,
        test: {
          unit: orderItem.test.unit,
          panicLow: orderItem.test.panicLow,
          panicHigh: orderItem.test.panicHigh,
        },
      });
      if (numericIssue) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Validation failed",
          details: [numericIssue],
        });
        return;
      }

      // Delta-check: compare against previous result for same patient + same parameter + same test
      const orderContext = await prisma.labOrderItem.findUnique({
        where: { id: orderItemId },
        include: { order: { select: { id: true, patientId: true, doctorId: true, orderNumber: true } } },
      });
      let deltaFlag = false;
      if (orderContext) {
        const prev = await prisma.labResult.findFirst({
          where: {
            parameter,
            orderItemId: { not: orderItemId },
            orderItem: {
              testId: orderContext.testId,
              order: { patientId: orderContext.order.patientId },
            },
          },
          orderBy: { reportedAt: "desc" },
        });
        if (prev) {
          const curN = parseFloat(value);
          const prevN = parseFloat(prev.value);
          if (!isNaN(curN) && !isNaN(prevN) && prevN !== 0) {
            const pct = Math.abs((curN - prevN) / prevN) * 100;
            if (pct > 25) deltaFlag = true;
          } else if (
            isNaN(curN) &&
            isNaN(prevN) &&
            prev.value.trim().toLowerCase() !== value.trim().toLowerCase()
          ) {
            deltaFlag = true;
          }
        }
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
          deltaFlag,
        },
      });

      // Index abnormal/delta results into the RAG knowledge base. Normal
      // values are skipped inside ingestLabResult to avoid index flooding.
      fireAndForgetIngest("ingestLabResult", () => ingestLabResult(result.id));

      // Fire-and-forget notify doctor when delta is significant
      if (deltaFlag && orderContext) {
        (async () => {
          try {
            const doc = await prisma.doctor.findUnique({
              where: { id: orderContext.order.doctorId },
              select: { userId: true },
            });
            if (doc?.userId) {
              const { sendNotification } = await import("../services/notification");
              const { NotificationType } = await import("@medcore/shared");
              await sendNotification({
                userId: doc.userId,
                type: NotificationType.PRESCRIPTION_READY, // closest available; reused for clinical alert
                title: "Significant lab delta",
                message: `Order ${orderContext.order.orderNumber}: ${parameter} changed >25% vs prior result. Review.`,
                data: { orderItemId, parameter, value },
              });
            }
          } catch (e) {
            console.error("[lab-delta-notify]", e);
          }
        })();
      }

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

      auditLog(req, "LAB_RESULT_CREATE", "lab_result", result.id, {
        orderItemId,
        parameter,
        flag: flag ?? "NORMAL",
      }).catch(console.error);

      // Realtime: notify ordering doctor
      const io = req.app.get("io");
      if (io) {
        io.emit("lab:result", {
          orderId: orderContext?.order?.id ?? null,
          orderItemId,
          resultId: result.id,
          criticalFlag: (flag ?? "NORMAL") === "CRITICAL",
        });
      }

      res.status(201).json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/lab/results/:orderItemId
// RBAC (issue #90): RECEPTION excluded — clinical lab results.
router.get(
  "/results/:orderItemId",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.LAB_TECH, Role.PATIENT),
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
      auditLog(req, "LAB_REFERENCE_RANGE_CREATE", "lab_test_reference_range", range.id, {
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
      auditLog(req, "LAB_REFERENCE_RANGE_DELETE", "lab_test_reference_range", req.params.id).catch(
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
      auditLog(req, "LAB_SAMPLE_REJECT", "lab_order", order.id, { reason }).catch(
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
  // Same RBAC as POST /results (see issue #14). Lab techs and admins only.
  authorize(Role.LAB_TECH, Role.ADMIN),
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

      // Issue #95: pre-validate every row's value against its test's numeric
      // expectation BEFORE opening the transaction. Failing fast prevents a
      // partial-batch insert that would have to be rolled back.
      const itemIds = Array.from(new Set(results.map((r) => r.orderItemId)));
      const itemsForBatch = await prisma.labOrderItem.findMany({
        where: { id: { in: itemIds } },
        include: { test: true },
      });
      const itemById = new Map(itemsForBatch.map((it) => [it.id, it]));
      const issues: Array<{ field: string; message: string }> = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const it = itemById.get(r.orderItemId);
        if (!it) continue;
        const issue = validateNumericLabResult({
          value: r.value,
          test: {
            unit: it.test.unit,
            panicLow: it.test.panicLow,
            panicHigh: it.test.panicHigh,
          },
        });
        if (issue) {
          issues.push({
            field: `results.${i}.value`,
            message: issue.message,
          });
        }
      }
      if (issues.length > 0) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Validation failed",
          details: issues,
        });
        return;
      }

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

        // Also notify patient via SMS/WhatsApp (fire-and-forget) for critical values
        if (order?.patient?.user) {
          const paramList = criticals
            .map(
              (c) =>
                `${c.parameter}: ${c.value}${c.unit ? " " + c.unit : ""}`
            )
            .join(", ");
          sendNotification({
            userId: order.patient.user.id,
            type: "LAB_RESULT_READY" as never,
            title: "URGENT: Critical lab result",
            message: `Hi ${order.patient.user.name}, your lab order ${order.orderNumber} has critical value(s): ${paramList}. Please contact Dr. ${order.doctor?.user?.name ?? "your doctor"} immediately.`,
            data: {
              orderId: order.id,
              orderNumber: order.orderNumber,
              criticalCount: criticals.length,
            },
          }).catch((e) => console.error("[lab critical SMS]", e));
        }
      }

      auditLog(req, "LAB_RESULT_BATCH", "lab_order", orderId, {
        count: created.length,
        critical: criticals.length,
      }).catch(console.error);

      const io = req.app.get("io");
      if (io) {
        io.emit("lab:result", {
          orderId,
          resultsCount: created.length,
          criticalFlag: criticals.length > 0,
        });
      }

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

// RBAC (issue #90): RECEPTION excluded — clinical lab trends.
router.get(
  "/results/trends",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.LAB_TECH, Role.PATIENT),
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

// RBAC (issue #90): RECEPTION excluded — clinical lab report payload.
router.get(
  "/orders/:id/report",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.LAB_TECH, Role.PATIENT),
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

// ───────────────────────────────────────────────────────
// DELTA CHECK
// GET /api/v1/lab/results/:orderItemId/delta-check
// ───────────────────────────────────────────────────────
// RBAC (issue #90): RECEPTION excluded — clinical delta-check exposes values.
router.get(
  "/results/:orderItemId/delta-check",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.LAB_TECH),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orderItem = await prisma.labOrderItem.findUnique({
        where: { id: req.params.orderItemId },
        include: {
          order: { select: { patientId: true } },
          results: { orderBy: { reportedAt: "desc" } },
          test: true,
        },
      });
      if (!orderItem) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Order item not found" });
        return;
      }

      const out: Array<{
        parameter: string;
        currentValue: string;
        previousValue: string | null;
        previousDate: Date | null;
        deltaPercent: number | null;
        isSignificant: boolean;
      }> = [];

      for (const current of orderItem.results) {
        const prev = await prisma.labResult.findFirst({
          where: {
            parameter: current.parameter,
            orderItemId: { not: orderItem.id },
            orderItem: {
              testId: orderItem.testId,
              order: { patientId: orderItem.order.patientId },
            },
            reportedAt: { lt: current.reportedAt },
          },
          orderBy: { reportedAt: "desc" },
        });
        let deltaPercent: number | null = null;
        let isSignificant = false;
        if (prev) {
          const curN = parseFloat(current.value);
          const prevN = parseFloat(prev.value);
          if (!isNaN(curN) && !isNaN(prevN) && prevN !== 0) {
            deltaPercent = Math.round(((curN - prevN) / prevN) * 1000) / 10;
            isSignificant = Math.abs(deltaPercent) > 25;
          } else if (isNaN(curN) && isNaN(prevN)) {
            isSignificant =
              prev.value.trim().toLowerCase() !==
              current.value.trim().toLowerCase();
          }
        }
        out.push({
          parameter: current.parameter,
          currentValue: current.value,
          previousValue: prev?.value ?? null,
          previousDate: prev?.reportedAt ?? null,
          deltaPercent,
          isSignificant,
        });
      }

      res.json({ success: true, data: out, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// RESULT VERIFICATION WORKFLOW
// ───────────────────────────────────────────────────────
router.patch(
  "/results/:id/verify",
  authorize(Role.DOCTOR),
  validate(verifyResultSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await prisma.labResult.update({
        where: { id: req.params.id },
        data: {
          verifiedBy: req.user!.userId,
          verifiedAt: new Date(),
          notes: req.body.notes
            ? `${req.body.notes}`
            : undefined,
        },
      });
      auditLog(req, "LAB_RESULT_VERIFY", "lab_result", result.id, {}).catch(
        console.error
      );
      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// RBAC (issue #90): RECEPTION excluded — pending lab results worklist.
router.get(
  "/results/pending-verification",
  authorize(Role.ADMIN, Role.DOCTOR, Role.LAB_TECH),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const results = await prisma.labResult.findMany({
        where: { verifiedAt: null },
        orderBy: { reportedAt: "desc" },
        take: 200,
        include: {
          orderItem: {
            include: {
              test: { select: { code: true, name: true } },
              order: {
                select: {
                  id: true,
                  orderNumber: true,
                  patient: {
                    select: {
                      id: true,
                      mrNumber: true,
                      user: { select: { name: true } },
                    },
                  },
                },
              },
            },
          },
        },
      });
      res.json({ success: true, data: results, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// LAB QC TRACKING
// ───────────────────────────────────────────────────────
router.post(
  "/qc",
  authorize(Role.ADMIN, Role.NURSE, Role.DOCTOR),
  validate(labQCSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const entry = await prisma.labQCEntry.create({
        data: {
          testId: req.body.testId,
          qcLevel: req.body.qcLevel,
          instrument: req.body.instrument,
          meanValue: req.body.meanValue,
          recordedValue: req.body.recordedValue,
          cv: req.body.cv,
          withinRange: req.body.withinRange,
          performedBy: req.user!.userId,
          notes: req.body.notes,
        },
        include: { test: { select: { code: true, name: true } } },
      });
      auditLog(req, "LAB_QC_CREATE", "lab_qc_entry", entry.id, {
        testId: entry.testId,
        qcLevel: entry.qcLevel,
        withinRange: entry.withinRange,
      }).catch(console.error);
      res.status(201).json({ success: true, data: entry, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/qc",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { testId, from, to } = req.query as Record<string, string | undefined>;
      const where: Record<string, unknown> = {};
      if (testId) where.testId = testId;
      if (from || to) {
        const d: Record<string, Date> = {};
        if (from) d.gte = new Date(from);
        if (to) d.lte = new Date(to);
        where.runDate = d;
      }
      const entries = await prisma.labQCEntry.findMany({
        where,
        orderBy: { runDate: "desc" },
        include: {
          test: { select: { code: true, name: true } },
          user: { select: { id: true, name: true, role: true } },
        },
        take: 500,
      });
      res.json({ success: true, data: entries, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/qc/summary",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const entries = await prisma.labQCEntry.findMany({
        where: { runDate: { gte: since } },
        select: {
          testId: true,
          withinRange: true,
          test: { select: { code: true, name: true } },
        },
      });
      const grouped: Record<
        string,
        { testId: string; code: string; name: string; total: number; pass: number }
      > = {};
      for (const e of entries) {
        const k = e.testId;
        if (!grouped[k]) {
          grouped[k] = {
            testId: e.testId,
            code: e.test.code,
            name: e.test.name,
            total: 0,
            pass: 0,
          };
        }
        grouped[k].total += 1;
        if (e.withinRange) grouped[k].pass += 1;
      }
      const rows = Object.values(grouped)
        .map((r) => ({
          ...r,
          passRate:
            r.total > 0 ? Math.round((r.pass / r.total) * 1000) / 10 : 100,
        }))
        .sort((a, b) => a.passRate - b.passRate);
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// SHARE LINK (patient-facing)
// POST /api/v1/lab/orders/:id/share-link
// ───────────────────────────────────────────────────────
router.post(
  "/orders/:id/share-link",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION),
  validate(shareLinkSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await prisma.labOrder.findUnique({
        where: { id: req.params.id },
      });
      if (!order) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Lab order not found" });
        return;
      }
      const days = (req.body.days as number | undefined) ?? 7;
      const token = crypto.randomBytes(24).toString("hex");
      const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000);
      const link = await prisma.sharedLink.create({
        data: {
          token,
          resource: "lab_order",
          resourceId: order.id,
          expiresAt,
          createdBy: req.user!.userId,
        },
      });
      auditLog(req, "SHARE_LINK_CREATE", "shared_link", link.id, {
        resource: "lab_order",
        resourceId: order.id,
        days,
      }).catch(console.error);
      res.status(201).json({
        success: true,
        data: {
          token,
          url: `/public/lab/${token}`,
          expiresAt,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// TAT BREACHES — ongoing orders past expected TAT
// GET /api/v1/lab/tat-breaches
// ───────────────────────────────────────────────────────
router.get(
  "/tat-breaches",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const openOrders = await prisma.labOrder.findMany({
        where: { status: { notIn: ["COMPLETED", "CANCELLED"] } },
        include: {
          items: { include: { test: { select: { name: true, tatHours: true } } } },
          patient: { select: { user: { select: { name: true } }, mrNumber: true } },
          doctor: { select: { user: { select: { name: true } } } },
        },
        take: 500,
      });
      const now = Date.now();
      const rows = openOrders
        .map((o) => {
          const elapsedH = (now - o.orderedAt.getTime()) / 3600000;
          const expected = o.items
            .map((i) => i.test.tatHours)
            .filter((x): x is number => typeof x === "number");
          const maxExpected = expected.length > 0 ? Math.max(...expected) : null;
          return {
            id: o.id,
            orderNumber: o.orderNumber,
            status: o.status,
            patientName: o.patient?.user?.name,
            mrNumber: o.patient?.mrNumber,
            doctorName: o.doctor?.user?.name,
            orderedAt: o.orderedAt,
            elapsedHours: Math.round(elapsedH * 10) / 10,
            expectedHours: maxExpected,
            breached: maxExpected !== null ? elapsedH > maxExpected : false,
            overdueBy:
              maxExpected !== null
                ? Math.round((elapsedH - maxExpected) * 10) / 10
                : null,
          };
        })
        .filter((r) => r.breached === true)
        .sort((a, b) => (b.overdueBy ?? 0) - (a.overdueBy ?? 0));
      res.json({
        success: true,
        data: { count: rows.length, rows },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/lab/orders/:id/pdf
// RBAC (issue #90): RECEPTION excluded — lab report PDF.
router.get(
  "/orders/:id/pdf",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.LAB_TECH, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const html = await generateLabReportHTML(req.params.id);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      if (err instanceof Error && err.message === "Lab order not found") {
        res.status(404).json({ success: false, data: null, error: err.message });
        return;
      }
      next(err);
    }
  }
);

export { router as labRouter };

// ───────────────────────────────────────────────────────
// PUBLIC (no-auth) ROUTER — register BEFORE auth middleware in index.ts
// ───────────────────────────────────────────────────────
export const publicLabRouter = Router();

publicLabRouter.get(
  "/lab/:token",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const link = await rawPrisma.sharedLink.findUnique({
        where: { token: req.params.token },
      });
      if (!link || link.resource !== "lab_order") {
        res
          .status(404)
          .json({ success: false, data: null, error: "Link not found" });
        return;
      }
      if (link.expiresAt < new Date()) {
        res
          .status(410)
          .json({ success: false, data: null, error: "Link expired" });
        return;
      }

      const order = await rawPrisma.labOrder.findUnique({
        where: { id: link.resourceId },
        include: {
          items: {
            include: {
              test: { select: { code: true, name: true, unit: true, normalRange: true, category: true } },
              results: { orderBy: { reportedAt: "asc" } },
            },
          },
          patient: {
            select: {
              mrNumber: true,
              gender: true,
              dateOfBirth: true,
              user: { select: { name: true } },
            },
          },
          doctor: { select: { user: { select: { name: true } } } },
        },
      });
      if (!order) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Order not found" });
        return;
      }

      // Increment view counter (fire-and-forget)
      rawPrisma.sharedLink
        .update({
          where: { id: link.id },
          data: {
            viewCount: { increment: 1 },
            lastViewedAt: new Date(),
          },
        })
        .catch(() => {});

      res.json({
        success: true,
        data: {
          expiresAt: link.expiresAt,
          orderNumber: order.orderNumber,
          orderedAt: order.orderedAt,
          completedAt: order.completedAt,
          status: order.status,
          patient: {
            name: order.patient.user.name,
            mrNumber: order.patient.mrNumber,
            gender: order.patient.gender,
            dateOfBirth: order.patient.dateOfBirth,
          },
          doctor: order.doctor?.user?.name,
          items: order.items,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);
