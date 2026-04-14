import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";

const router = Router();
router.use(authenticate);

// GET /api/v1/icd10?q=term — fuzzy lookup for ICD-10 codes
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, category, limit = "20" } = req.query as Record<string, string | undefined>;
    const take = Math.min(parseInt(limit ?? "20", 10) || 20, 100);

    const where: Record<string, unknown> = {};
    if (category) where.category = category;
    if (q && q.length > 0) {
      where.OR = [
        { code: { contains: q.toUpperCase() } },
        { description: { contains: q, mode: "insensitive" } },
      ];
    }

    const codes = await prisma.icd10Code.findMany({
      where,
      take,
      orderBy: { code: "asc" },
    });

    res.json({ success: true, data: codes, error: null });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/icd10 — seed a single code (admin helper)
router.post(
  "/",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { code, description, category } = req.body as {
        code: string;
        description: string;
        category?: string;
      };
      if (!code || !description) {
        res.status(400).json({
          success: false,
          data: null,
          error: "code and description are required",
        });
        return;
      }
      const created = await prisma.icd10Code.upsert({
        where: { code: code.toUpperCase() },
        update: { description, category: category ?? null },
        create: {
          code: code.toUpperCase(),
          description,
          category: category ?? null,
        },
      });
      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as icd10Router };
