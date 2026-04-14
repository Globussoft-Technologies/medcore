import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createSupplierSchema,
  updateSupplierSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// GET /api/v1/suppliers
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { active = "true", search } = req.query as Record<string, string | undefined>;

    const where: Record<string, unknown> = {};
    if (active === "true") where.isActive = true;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { contactPerson: { contains: search, mode: "insensitive" } },
        { gstNumber: { contains: search, mode: "insensitive" } },
      ];
    }

    const suppliers = await prisma.supplier.findMany({
      where,
      orderBy: { name: "asc" },
      include: { _count: { select: { purchaseOrders: true } } },
    });

    res.json({ success: true, data: suppliers, error: null });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/suppliers/:id
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const supplier = await prisma.supplier.findUnique({
      where: { id: req.params.id },
      include: {
        purchaseOrders: {
          take: 10,
          orderBy: { createdAt: "desc" },
          include: { items: true },
        },
      },
    });
    if (!supplier) {
      res.status(404).json({ success: false, data: null, error: "Supplier not found" });
      return;
    }
    res.json({ success: true, data: supplier, error: null });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/suppliers
router.post(
  "/",
  authorize(Role.ADMIN),
  validate(createSupplierSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = { ...req.body };
      if (data.email === "") delete data.email;
      const supplier = await prisma.supplier.create({ data });
      auditLog(req, "CREATE_SUPPLIER", "supplier", supplier.id, data).catch(
        console.error
      );
      res.status(201).json({ success: true, data: supplier, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/suppliers/:id
router.patch(
  "/:id",
  authorize(Role.ADMIN),
  validate(updateSupplierSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = { ...req.body };
      if (data.email === "") delete data.email;
      const supplier = await prisma.supplier.update({
        where: { id: req.params.id },
        data,
      });
      auditLog(req, "UPDATE_SUPPLIER", "supplier", supplier.id, data).catch(
        console.error
      );
      res.json({ success: true, data: supplier, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as supplierRouter };
