import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";

const router = Router();
router.use(authenticate);

// GET /api/v1/icd10?q=term — fuzzy lookup for ICD-10 codes
//
// Issue #195: multi-word queries like "essential hypertension" used to fall
// through with `contains` on the whole string and miss "Essential (primary)
// hypertension" because the literal substring contains punctuation in
// between. We now tokenise on whitespace and AND the tokens — every token
// must match either the code or the description (case-insensitive). For a
// single-word query this is equivalent to the old behaviour.
//
// Ranking: rows where the code starts with the (uppercased) query, or the
// description starts with the query, are surfaced first so an exact-prefix
// hit ("I10" → I10) stays at the top even after AND-tokenisation widens
// the candidate set. Within each tier we keep the original `code asc`
// secondary sort so results are stable.
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, category, limit = "20" } = req.query as Record<string, string | undefined>;
    const take = Math.min(parseInt(limit ?? "20", 10) || 20, 100);

    const where: Record<string, unknown> = {};
    if (category) where.category = category;
    const trimmed = (q ?? "").trim();
    const tokens = trimmed.length > 0 ? trimmed.split(/\s+/).filter(Boolean) : [];
    if (tokens.length > 0) {
      // AND-of-OR: every token must hit either `code` or `description`.
      where.AND = tokens.map((tok) => ({
        OR: [
          { code: { contains: tok.toUpperCase() } },
          { description: { contains: tok, mode: "insensitive" as const } },
        ],
      }));
    }

    // Fetch a wider candidate set than `take` so we can re-rank for prefix
    // matches before slicing. 5x the requested limit (capped at 200) is
    // plenty for the ~14k-row ICD-10 catalogue while staying cheap.
    const candidateLimit = Math.min(take * 5, 200);
    const candidates = await prisma.icd10Code.findMany({
      where,
      take: candidateLimit,
      orderBy: { code: "asc" },
    });

    // Re-rank: exact-prefix matches first.
    const upperQ = trimmed.toUpperCase();
    const lowerQ = trimmed.toLowerCase();
    const ranked = trimmed
      ? candidates
          .map((row: { code: string; description: string }) => {
            const codeStarts = row.code.toUpperCase().startsWith(upperQ);
            const descStarts = row.description.toLowerCase().startsWith(lowerQ);
            // Lower score = higher rank.
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
