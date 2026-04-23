import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { indexChunk, seedFromExistingData } from "../services/ai/rag";

const router = Router();
router.use(authenticate, authorize(Role.ADMIN));

// GET /api/v1/ai/knowledge — list knowledge chunks (paginated, filterable by documentType)
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { documentType, page = "1", limit = "20" } = req.query as Record<string, string | undefined>;
    const take = Math.min(parseInt(limit ?? "20", 10) || 20, 100);
    const skip = (Math.max(parseInt(page ?? "1", 10) || 1, 1) - 1) * take;

    const where: Record<string, unknown> = { active: true };
    if (documentType) where.documentType = documentType;

    const [chunks, total] = await Promise.all([
      prisma.knowledgeChunk.findMany({ where, skip, take, orderBy: { createdAt: "desc" } }),
      prisma.knowledgeChunk.count({ where }),
    ]);

    res.json({ success: true, data: { chunks, total, page: parseInt(page ?? "1", 10), limit: take }, error: null });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/ai/knowledge — create or upsert a knowledge chunk
router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { documentType, title, content, tags, language, sourceId } = req.body as {
      documentType: string;
      title: string;
      content: string;
      tags?: string[];
      language?: string;
      sourceId?: string;
    };

    if (!documentType || !title || !content) {
      res.status(400).json({
        success: false,
        data: null,
        error: "documentType, title, and content are required",
      });
      return;
    }

    await indexChunk({ documentType, title, content, tags, language, sourceId });
    res.status(201).json({ success: true, data: null, error: null });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/ai/knowledge/:id — soft delete (set active = false)
router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const chunk = await prisma.knowledgeChunk.findUnique({ where: { id }, select: { id: true } });

    if (!chunk) {
      res.status(404).json({ success: false, data: null, error: "Knowledge chunk not found" });
      return;
    }

    await prisma.knowledgeChunk.update({ where: { id }, data: { active: false } });
    res.json({ success: true, data: null, error: null });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/ai/knowledge/seed — seed knowledge base from existing DB data
router.post("/seed", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const counts = await seedFromExistingData();
    res.json({ success: true, data: counts, error: null });
  } catch (err) {
    next(err);
  }
});

export { router as aiKnowledgeRouter };
