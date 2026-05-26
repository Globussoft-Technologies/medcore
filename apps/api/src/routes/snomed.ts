// Pearl ERP Stage 1 §2.1.3 — SNOMED CT diagnosis-coding lookup.
//
// Mirrors /icd10 in shape and ranking strategy:
//   - AND-of-OR token search across `code` + `description`
//   - re-rank exact-prefix matches first
//   - identical response envelope so the client autocomplete is reused
//
// Catalogue is sourced from the `snomed_codes` table (migration
// 20260526000002_add_snomed_codes). The seed currently inserts a
// starter set of ~30 high-frequency primary-care concepts; intended
// to be re-seeded from the licensed C-DAC SNOMED CT distribution once
// the ETL lands. The route doesn't care about the row count — pure
// SQL lookup against whatever's in the table today.
import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";

const router = Router();
router.use(authenticate);

// GET /api/v1/snomed?q=term — fuzzy lookup. Identical contract to /icd10.
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, category, limit = "20" } = req.query as Record<
      string,
      string | undefined
    >;
    const take = Math.min(parseInt(limit ?? "20", 10) || 20, 100);

    const where: Record<string, unknown> = {};
    if (category) where.category = category;
    const trimmed = (q ?? "").trim();
    const tokens =
      trimmed.length > 0 ? trimmed.split(/\s+/).filter(Boolean) : [];
    if (tokens.length > 0) {
      where.AND = tokens.map((tok) => ({
        OR: [
          { code: { contains: tok } },
          { description: { contains: tok, mode: "insensitive" as const } },
        ],
      }));
    }

    const candidateLimit = Math.min(take * 5, 200);
    const candidates = await prisma.snomedCode.findMany({
      where,
      take: candidateLimit,
      orderBy: { code: "asc" },
    });

    // Re-rank: exact-prefix matches (code OR description) win.
    const lowerQ = trimmed.toLowerCase();
    const ranked = trimmed
      ? candidates
          .map((row: { code: string; description: string }) => {
            const codeStarts = row.code.toLowerCase().startsWith(lowerQ);
            const descStarts = row.description
              .toLowerCase()
              .startsWith(lowerQ);
            const score = codeStarts ? 0 : descStarts ? 1 : 2;
            return { row, score };
          })
          .sort((a, b) => a.score - b.score)
          .map((x) => x.row)
      : candidates;

    res.json({ success: true, data: ranked.slice(0, take), error: null });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/snomed — seed/upsert a single concept (admin helper,
// mirroring /icd10 POST). Useful while the C-DAC ETL is pending — an
// admin can hand-add a missing concept via curl without a redeploy.
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
      const created = await prisma.snomedCode.upsert({
        where: { code },
        update: { description, category: category ?? null },
        create: { code, description, category: category ?? null },
      });
      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  },
);

export { router as snomedRouter };
