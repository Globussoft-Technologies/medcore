import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createExpenseSchema,
  updateExpenseSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// GET /api/v1/expenses — list with filters
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      category,
      from,
      to,
      paidBy,
      page = "1",
      limit = "20",
    } = req.query as Record<string, string | undefined>;

    const where: Record<string, unknown> = {};
    if (category) where.category = category;
    if (paidBy) where.paidBy = paidBy;
    if (from || to) {
      where.date = {};
      if (from) (where.date as Record<string, unknown>).gte = new Date(from);
      if (to) (where.date as Record<string, unknown>).lte = new Date(to);
    }

    const skip = (parseInt(page || "1") - 1) * parseInt(limit || "20");
    const take = Math.min(parseInt(limit || "20"), 100);

    const [expenses, total] = await Promise.all([
      prisma.expense.findMany({
        where,
        skip,
        take,
        orderBy: { date: "desc" },
        include: {
          user: { select: { id: true, name: true, role: true } },
        },
      }),
      prisma.expense.count({ where }),
    ]);

    res.json({
      success: true,
      data: expenses,
      error: null,
      meta: { page: parseInt(page || "1"), limit: take, total },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/expenses/summary?from=&to=
router.get(
  "/summary",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from, to } = req.query as Record<string, string | undefined>;

      const where: Record<string, unknown> = {};
      if (from || to) {
        where.date = {};
        if (from) (where.date as Record<string, unknown>).gte = new Date(from);
        if (to) (where.date as Record<string, unknown>).lte = new Date(to);
      }

      const expenses = await prisma.expense.findMany({ where });

      const byCategory: Record<string, { count: number; total: number }> = {};
      let grandTotal = 0;

      for (const e of expenses) {
        grandTotal += e.amount;
        if (!byCategory[e.category]) {
          byCategory[e.category] = { count: 0, total: 0 };
        }
        byCategory[e.category].count += 1;
        byCategory[e.category].total += e.amount;
      }

      const summary = Object.entries(byCategory)
        .map(([category, v]) => ({
          category,
          count: v.count,
          total: Math.round(v.total * 100) / 100,
        }))
        .sort((a, b) => b.total - a.total);

      res.json({
        success: true,
        data: {
          grandTotal: Math.round(grandTotal * 100) / 100,
          transactionCount: expenses.length,
          byCategory: summary,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/expenses
router.post(
  "/",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(createExpenseSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const expense = await prisma.expense.create({
        data: {
          category: req.body.category,
          amount: req.body.amount,
          description: req.body.description,
          date: new Date(req.body.date),
          paidTo: req.body.paidTo,
          referenceNo: req.body.referenceNo,
          paidBy: req.user!.userId,
        },
        include: { user: { select: { id: true, name: true, role: true } } },
      });

      auditLog(req, "CREATE_EXPENSE", "expense", expense.id, {
        category: expense.category,
        amount: expense.amount,
      }).catch(console.error);

      res.status(201).json({ success: true, data: expense, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/expenses/:id
router.patch(
  "/:id",
  authorize(Role.ADMIN),
  validate(updateExpenseSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data: Record<string, unknown> = { ...req.body };
      if (data.date) data.date = new Date(data.date as string);

      const expense = await prisma.expense.update({
        where: { id: req.params.id },
        data,
        include: { user: { select: { id: true, name: true, role: true } } },
      });

      auditLog(req, "UPDATE_EXPENSE", "expense", expense.id, req.body).catch(
        console.error
      );

      res.json({ success: true, data: expense, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/expenses/:id — hard delete (no soft-delete column available)
router.delete(
  "/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const expense = await prisma.expense.delete({
        where: { id: req.params.id },
      });
      auditLog(req, "DELETE_EXPENSE", "expense", expense.id).catch(console.error);
      res.json({ success: true, data: expense, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as expenseRouter };
