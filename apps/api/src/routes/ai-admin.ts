import { Router, Request, Response, NextFunction } from "express";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import {
  listPromptVersions,
  createPromptVersion,
  activatePromptVersion,
  rollbackPromptKey,
} from "../services/ai/prompt-registry";

const router = Router();

// All routes below require an authenticated ADMIN. Prompt templates steer
// every LLM call, so mutation access is strictly super-user only — exposing
// this to DOCTOR / RECEPTION would let any clinic user rewrite the triage
// system prompt.
router.use(authenticate);
router.use(authorize(Role.ADMIN));
// #511 audit (2026-05-05, cron-tick): all handlers verified safe via
// router-level authorize(Role.ADMIN) above — PATIENT (and every non-ADMIN
// role) is excluded for this entire file. No per-handler override widens
// access; grep confirms no Role.PATIENT references in this file.

/**
 * GET /api/v1/ai/admin/prompts/:key/versions
 *
 * Paginated list of versions for a prompt key, newest first. Useful for the
 * admin UI's "history" pane. Page + pageSize are query params (defaults: 1, 20).
 */
router.get(
  "/prompts/:key/versions",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { key } = req.params;
      const page = req.query.page ? Number(req.query.page) : 1;
      const pageSize = req.query.pageSize ? Number(req.query.pageSize) : 20;
      if (Number.isNaN(page) || Number.isNaN(pageSize)) {
        res.status(400).json({
          success: false,
          data: null,
          error: "page and pageSize must be integers",
        });
        return;
      }
      const result = await listPromptVersions(key, { page, pageSize });
      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/ai/admin/prompts/:key/versions
 * Body: { content: string, notes?: string }
 *
 * Create a new (inactive) version of the prompt. The creator (from the JWT)
 * is recorded on the row; an audit entry captures who made the change.
 */
router.post(
  "/prompts/:key/versions",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { key } = req.params;
      const { content, notes } = req.body as { content?: string; notes?: string };
      if (!content || typeof content !== "string" || content.trim().length === 0) {
        res.status(400).json({
          success: false,
          data: null,
          error: "content is required and must be a non-empty string",
        });
        return;
      }
      const userId = req.user!.userId;
      const created = await createPromptVersion(key, content, userId, notes);
      await auditLog(req, "PROMPT_VERSION_CREATE", "Prompt", created.id, {
        key,
        version: created.version,
        notes: notes ?? null,
      });
      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/ai/admin/prompts/versions/:id/activate
 *
 * Flip the active flag to a specific version. The currently-active version
 * (if any) is deactivated in the same transaction. Invalidates the registry
 * cache so the change takes effect immediately fleet-wide.
 */
router.post(
  "/prompts/versions/:id/activate",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const activated = await activatePromptVersion(id);
      await auditLog(req, "PROMPT_VERSION_ACTIVATE", "Prompt", activated.id, {
        key: activated.key,
        version: activated.version,
      });
      res.json({ success: true, data: activated, error: null });
    } catch (err) {
      // `Prompt version not found` from the service layer — return 404.
      if (err instanceof Error && /not found/i.test(err.message)) {
        res.status(404).json({ success: false, data: null, error: err.message });
        return;
      }
      next(err);
    }
  }
);

/**
 * POST /api/v1/ai/admin/prompts/:key/rollback
 *
 * Activate the version immediately prior to the currently-active one. Fails
 * with 409 if there is no prior version (e.g. v1 is active, nothing to roll
 * back to).
 */
router.post(
  "/prompts/:key/rollback",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { key } = req.params;
      const activated = await rollbackPromptKey(key);
      await auditLog(req, "PROMPT_VERSION_ROLLBACK", "Prompt", activated.id, {
        key: activated.key,
        version: activated.version,
      });
      res.json({ success: true, data: activated, error: null });
    } catch (err) {
      if (
        err instanceof Error &&
        (/no active version/i.test(err.message) || /no prior version/i.test(err.message))
      ) {
        res.status(409).json({ success: false, data: null, error: err.message });
        return;
      }
      next(err);
    }
  }
);

export { router as aiAdminRouter };
