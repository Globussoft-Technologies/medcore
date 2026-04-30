import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createExpenseSchema,
  updateExpenseSchema,
  approveExpenseSchema,
  expenseBudgetSchema,
  EXPENSE_APPROVAL_THRESHOLD,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// GET /api/v1/expenses — list with filters
// RBAC (issue #89 + #98): DOCTOR + RECEPTION must NOT see expenses
// (₹9.29 lakh staff-salary leak). Until we add a dedicated ACCOUNTANT role,
// expenses are ADMIN-only.
router.get("/", authorize(Role.ADMIN), async (req: Request, res: Response, next: NextFunction) => {
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
// RBAC (issue #89): DOCTOR excluded.
router.get(
  "/summary",
  authorize(Role.ADMIN),
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

// POST /api/v1/expenses — creates; ADMIN-only per issue #98 RECEPTION
// over-access lockdown. The handler retains a non-admin auto-PENDING branch
// for a future expansion to DOCTOR/NURSE creators, but no non-admin role
// is currently authorized at this endpoint.
router.post(
  "/",
  authorize(Role.ADMIN),
  validate(createExpenseSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const isAdmin = req.user!.role === Role.ADMIN;
      const over = req.body.amount > EXPENSE_APPROVAL_THRESHOLD;
      const approvalStatus = over && !isAdmin ? "PENDING" : "APPROVED";
      const expense = await prisma.expense.create({
        data: {
          category: req.body.category,
          amount: req.body.amount,
          description: req.body.description,
          date: new Date(req.body.date),
          paidTo: req.body.paidTo,
          referenceNo: req.body.referenceNo,
          attachmentPath: req.body.attachmentPath,
          isRecurring: !!req.body.isRecurring,
          recurringFrequency: req.body.recurringFrequency,
          approvalStatus,
          approvedBy: approvalStatus === "APPROVED" ? req.user!.userId : null,
          approvedAt: approvalStatus === "APPROVED" ? new Date() : null,
          paidBy: req.user!.userId,
        },
        include: { user: { select: { id: true, name: true, role: true } } },
      });

      auditLog(req, "EXPENSE_CREATE", "expense", expense.id, {
        category: expense.category,
        amount: expense.amount,
        approvalStatus,
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

      auditLog(req, "EXPENSE_UPDATE", "expense", expense.id, req.body).catch(
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
      auditLog(req, "EXPENSE_DELETE", "expense", expense.id).catch(console.error);
      res.json({ success: true, data: expense, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════
// OPS ENHANCEMENTS: APPROVAL + BUDGETS + RECURRING
// ═══════════════════════════════════════════════════════

// GET /api/v1/expenses/pending — admin approval queue
router.get(
  "/pending",
  authorize(Role.ADMIN),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const pending = await prisma.expense.findMany({
        where: { approvalStatus: "PENDING" },
        include: { user: { select: { id: true, name: true, role: true } } },
        orderBy: { createdAt: "asc" },
      });
      const totalPending = pending.reduce((s, e) => s + e.amount, 0);
      res.json({
        success: true,
        data: { pending, totalPending, count: pending.length },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/expenses/:id/approve
router.patch(
  "/:id/approve",
  authorize(Role.ADMIN),
  validate(approveExpenseSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.expense.findUnique({ where: { id: req.params.id } });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Expense not found" });
        return;
      }
      if (existing.approvalStatus !== "PENDING") {
        res.status(400).json({
          success: false,
          data: null,
          error: `Expense is already ${existing.approvalStatus}`,
        });
        return;
      }
      const updated = await prisma.expense.update({
        where: { id: existing.id },
        data: {
          approvalStatus: req.body.approved ? "APPROVED" : "REJECTED",
          approvedBy: req.user!.userId,
          approvedAt: new Date(),
          rejectionReason: req.body.approved ? null : req.body.rejectionReason,
        },
      });
      auditLog(
        req,
        req.body.approved ? "EXPENSE_APPROVED" : "EXPENSE_REJECTED",
        "expense",
        existing.id,
        { amount: existing.amount }
      ).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/expenses/recurring — list recurring templates
// RBAC (issue #89): DOCTOR excluded.
router.get(
  "/recurring",
  authorize(Role.ADMIN),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await prisma.expense.findMany({
        where: { isRecurring: true, parentExpenseId: null },
        orderBy: { date: "desc" },
      });
      res.json({ success: true, data: items, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/expenses/:id/generate-recurring — clone as a new expense for next period
router.post(
  "/:id/generate-recurring",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parent = await prisma.expense.findUnique({ where: { id: req.params.id } });
      if (!parent) {
        res.status(404).json({ success: false, data: null, error: "Parent expense not found" });
        return;
      }
      if (!parent.isRecurring) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Parent expense is not marked as recurring",
        });
        return;
      }
      const nextDate = new Date(parent.date);
      switch (parent.recurringFrequency) {
        case "QUARTERLY":
          nextDate.setMonth(nextDate.getMonth() + 3);
          break;
        case "YEARLY":
          nextDate.setFullYear(nextDate.getFullYear() + 1);
          break;
        case "MONTHLY":
        default:
          nextDate.setMonth(nextDate.getMonth() + 1);
      }
      const newExp = await prisma.expense.create({
        data: {
          category: parent.category,
          amount: parent.amount,
          description: `${parent.description} (auto-generated)`,
          date: nextDate,
          paidTo: parent.paidTo,
          paidBy: req.user!.userId,
          referenceNo: parent.referenceNo,
          isRecurring: false, // instance, not template
          parentExpenseId: parent.id,
          approvalStatus: parent.amount > EXPENSE_APPROVAL_THRESHOLD ? "PENDING" : "APPROVED",
          approvedBy: parent.amount > EXPENSE_APPROVAL_THRESHOLD ? null : req.user!.userId,
          approvedAt: parent.amount > EXPENSE_APPROVAL_THRESHOLD ? null : new Date(),
        },
      });
      auditLog(req, "EXPENSE_RECURRING_GEN", "expense", newExp.id, {
        parentId: parent.id,
      }).catch(console.error);
      res.status(201).json({ success: true, data: newExp, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/expenses/budgets?year=&month=
// RBAC (issue #89): DOCTOR excluded.
router.get(
  "/budgets",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const now = new Date();
      const year = parseInt((req.query.year as string) || String(now.getFullYear()), 10);
      const month = parseInt((req.query.month as string) || String(now.getMonth() + 1), 10);
      const [budgets, expenses] = await Promise.all([
        prisma.expenseBudget.findMany({ where: { year, month } }),
        prisma.expense.findMany({
          where: {
            approvalStatus: { not: "REJECTED" },
            date: {
              gte: new Date(year, month - 1, 1),
              lt: new Date(year, month, 1),
            },
          },
        }),
      ]);

      const actualByCat: Record<string, number> = {};
      for (const e of expenses) {
        actualByCat[e.category] = (actualByCat[e.category] || 0) + e.amount;
      }
      const rows = budgets.map((b) => ({
        category: b.category,
        budget: b.amount,
        actual: +(actualByCat[b.category] || 0).toFixed(2),
        variance: +((actualByCat[b.category] || 0) - b.amount).toFixed(2),
        utilisation:
          b.amount > 0
            ? +(((actualByCat[b.category] || 0) / b.amount) * 100).toFixed(1)
            : 0,
      }));
      // Issue #76 (Apr 2026): the dashboard "Total Spent" KPI was previously
      // derived client-side as sum(rows.actual), which silently dropped any
      // category whose budget hadn't been set yet (e.g. ₹85k of Equipment
      // spending was invisible because no Equipment budget existed). Return
      // the full month's actual on the server so the KPI reflects ALL
      // approved expenses regardless of budget existence. Variance still
      // uses the budgeted-only roll-up — see /budgets/summary copy.
      const totalSpent = +Object.values(actualByCat)
        .reduce((s, v) => s + v, 0)
        .toFixed(2);
      const totalBudget = +budgets
        .reduce((s, b) => s + b.amount, 0)
        .toFixed(2);
      const totalBudgetedActual = +rows
        .reduce((s, r) => s + r.actual, 0)
        .toFixed(2);
      const totalVarianceBudgetedOnly = +(totalBudgetedActual - totalBudget).toFixed(2);
      res.json({
        success: true,
        data: {
          year,
          month,
          rows,
          // Full-picture totals (option 1 from issue #76).
          totalBudget,
          totalSpent,
          // Variance uses budgeted-only spend so a missing budget doesn't
          // poison the over/under signal. The frontend annotates this so
          // users know the two totals differ by uncategorized amounts.
          totalVarianceBudgetedOnly,
          uncategorizedActual: Object.entries(actualByCat)
            .filter(([c]) => !budgets.some((b) => b.category === c))
            .map(([category, actual]) => ({ category, actual })),
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/expenses/budgets
router.post(
  "/budgets",
  authorize(Role.ADMIN),
  validate(expenseBudgetSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { category, year, month, amount, notes } = req.body;
      const budget = await prisma.expenseBudget.upsert({
        where: { category_year_month: { category, year, month } },
        update: { amount, notes },
        create: { category, year, month, amount, notes },
      });
      auditLog(req, "BUDGET_UPSERT", "expense_budget", budget.id, {
        category,
        year,
        month,
        amount,
      }).catch(console.error);
      res.status(201).json({ success: true, data: budget, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as expenseRouter };
