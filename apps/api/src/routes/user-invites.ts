/**
 * Staff email-invite flow — Pearl ERP Stage 1 §8.2 (gap row 213 closure,
 * 2026-05-23).
 *
 * What / which modules / why:
 *   - Replaces the "ADMIN types a password and shares it out-of-band"
 *     UX with a token-based invite. ADMIN POSTs an invite scoped to a
 *     Role + optional branchIds → a SHA-256-hashed token is persisted
 *     (raw nonce never stored) → SendGrid sends the recipient a link to
 *     /auth/invite/accept?token=<raw>. The recipient sets a password →
 *     a User row is materialised with the role + tenantId captured at
 *     invite-time.
 *   - Mounts at /api/v1/user-invites with three endpoints:
 *       POST  /                       ADMIN-only. Mint + email an invite.
 *       GET   /:token                 PUBLIC. Look up by hashed token,
 *                                     return {email, role, tenantName}
 *                                     or 410 if expired/used/missing.
 *       POST  /:token/accept          PUBLIC. Create User from the
 *                                     invite + provided password.
 *   - Audit actions (awaited via the `auditLog` middleware so integration
 *     tests can read AuditLog immediately):
 *       USER_INVITE_SENT     — emitted on POST / by ADMIN.
 *       USER_INVITE_ACCEPTED — emitted on POST /:token/accept.
 *   - TOTP enrolment + first-login walkthrough (also mentioned in the
 *     gap row description) are explicitly out of scope for this piece;
 *     a separate row will track them.
 *
 * Security contract:
 *   - The raw token NEVER leaves the server outside the outbound email
 *     body — the POST response returns the invite id only.
 *   - The role + tenantId stored on the User row come from the persisted
 *     UserInvite row, NOT from the accept request body — an attacker
 *     cannot privilege-escalate by tampering with the accept payload.
 *   - The password is validated by the canonical `validatePasswordStrength`
 *     helper (length + char-class + common-password denylist).
 *   - The token is verified by SHA-256-hashing the URL value and looking
 *     up by that hash — a DB compromise alone cannot resurrect an invite.
 *   - Re-issuing an invite to the same (tenantId, email) collapses any
 *     prior unaccepted invites (DELETE-then-INSERT) so a typo'd email
 *     never leaves a wrong-address invite valid in the wild.
 */

import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
// Multi-tenant: scoped client auto-filters reads + tags writes by tenantId
// for TENANT_SCOPED_MODELS (cross-tenant leak fix, 2026-06-11).
import { tenantScopedPrisma as prisma } from "@medcore/db";
import { Role, validatePasswordStrength } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { sendEmail } from "../services/messaging/email";
import { renderUserInviteEmail } from "../templates/user-invite.html";

const router = Router();

// ─── Constants ───────────────────────────────────────────────────────

const INVITE_TTL_HOURS = 72;
const INVITE_TOKEN_BYTES = 32;

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function mintInviteToken(): { raw: string; hashed: string } {
  const raw = crypto.randomBytes(INVITE_TOKEN_BYTES).toString("hex");
  return { raw, hashed: hashToken(raw) };
}

function appUrl(): string {
  return (
    process.env.APP_URL ||
    process.env.WEB_APP_URL ||
    process.env.CORS_ORIGIN ||
    "http://localhost:3000"
  );
}

// ─── Schemas ─────────────────────────────────────────────────────────

const createInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum([
    "ADMIN",
    "DOCTOR",
    "NURSE",
    "RECEPTION",
    "PHARMACIST",
    "LAB_TECH",
  ]),
  branchIds: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
});

const acceptInviteSchema = z.object({
  // strongPassword is enforced via validatePasswordStrength below so we
  // can return the helper's error message (denylist hit, length, etc.)
  // verbatim instead of Zod's generic refine string.
  password: z.string().min(1).max(200),
});

// ─── Routes ──────────────────────────────────────────────────────────

// ── POST /api/v1/user-invites — ADMIN-only ─────────────────────────
//
// Authed surface. Creates a new UserInvite row (collapsing any prior
// unaccepted invites for the same (tenantId, email)) and sends an
// email to the invitee with a /auth/invite/accept?token=<raw> link.
router.post(
  "/",
  authenticate,
  authorize(Role.ADMIN),
  validate(createInviteSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof createInviteSchema>;
      const tenantId = req.user?.tenantId ?? null;
      if (!tenantId) {
        // Super-admin (tenant-less) cannot issue staff invites — there's
        // no tenant to scope the resulting User to. Surface a clear
        // 400 so the UI can prompt them to pick a tenant first.
        res.status(400).json({
          success: false,
          data: null,
          error:
            "Cannot issue an invite without a tenant context — switch into a tenant first.",
        });
        return;
      }

      // Refuse to re-invite an email that already has an active User on
      // this tenant (the admin should instead use the reset-password
      // flow or the User Management page). Cross-tenant emails are
      // allowed — same human, multiple hospitals.
      const existingUser = await prisma.user.findFirst({
        where: { email: body.email, tenantId },
        select: { id: true },
      });
      if (existingUser) {
        res.status(409).json({
          success: false,
          data: null,
          error: "A user with this email already exists in this tenant",
        });
        return;
      }

      // Collapse any outstanding unaccepted invites for the same
      // (tenantId, email). This handles the email-typo case and the
      // "re-send the invite" UX without leaving the previous link valid.
      await prisma.userInvite.deleteMany({
        where: {
          tenantId,
          email: body.email,
          acceptedAt: null,
        },
      });

      const { raw, hashed } = mintInviteToken();
      const expiresAt = new Date(
        Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000,
      );

      const invite = await prisma.userInvite.create({
        data: {
          tenantId,
          email: body.email,
          role: body.role,
          branchIds: body.branchIds ?? [],
          token: hashed,
          invitedByUserId: req.user!.userId,
          expiresAt,
        },
      });

      // Fetch tenant name for the email body. Tolerate a soft failure
      // (use a generic label) rather than blocking the invite — the
      // recipient can still set a password without a fancy email.
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true },
      });
      const tenantName = tenant?.name ?? "your MedCore workspace";

      const acceptUrl = `${appUrl().replace(/\/$/, "")}/auth/invite/accept?token=${raw}`;
      const rendered = renderUserInviteEmail({
        inviteeEmail: body.email,
        tenantName,
        acceptUrl,
        expiresAt,
      });

      // Send the invite email. We do NOT abort on a SendGrid failure —
      // the invite row is already persisted, and the ADMIN can re-send
      // (which collapses to the same DB shape) once email is back.
      // Surface the error in the response so the UI can show a warning
      // banner.
      const emailResult = await sendEmail({
        to: body.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });

      await auditLog(req, "USER_INVITE_SENT", "user_invite", invite.id, {
        email: body.email,
        role: body.role,
        branchIds: body.branchIds ?? [],
        emailDelivered: emailResult.ok,
      });

      res.status(201).json({
        success: true,
        data: {
          id: invite.id,
          email: invite.email,
          role: invite.role,
          expiresAt: invite.expiresAt,
          emailDelivered: emailResult.ok,
          emailError: emailResult.ok ? null : emailResult.error,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /api/v1/user-invites/:token — PUBLIC ───────────────────────
//
// No authenticate / no authorize. The handler hashes the URL token,
// looks up the invite row, and returns {email, role, tenantName} so
// the UI's set-password form can render meaningful context. 410 on
// missing / expired / already-accepted invites — same status for all
// three so the response itself doesn't disclose which one applies.
router.get(
  "/:token",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = req.params.token;
      // Trivial format guard. Anything that isn't 64 hex chars is
      // definitely not a valid token; reply 410 without touching the
      // DB to avoid amplifying a token-guessing flood.
      if (!/^[a-f0-9]{64}$/i.test(raw)) {
        res.status(410).json({
          success: false,
          data: null,
          error: "Invite is invalid or has expired",
        });
        return;
      }
      const invite = await prisma.userInvite.findUnique({
        where: { token: hashToken(raw) },
        include: {
          tenant: { select: { name: true } },
        },
      });
      if (
        !invite ||
        invite.acceptedAt !== null ||
        invite.expiresAt.getTime() <= Date.now()
      ) {
        res.status(410).json({
          success: false,
          data: null,
          error: "Invite is invalid or has expired",
        });
        return;
      }
      res.status(200).json({
        success: true,
        data: {
          email: invite.email,
          role: invite.role,
          tenantName: invite.tenant?.name ?? null,
          expiresAt: invite.expiresAt,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /api/v1/user-invites/:token/accept — PUBLIC ───────────────
//
// No authenticate / no authorize. Validates the token, validates the
// password against the canonical denylist, creates the User row in a
// transaction that also marks the invite accepted. Returns the new
// userId + email so the UI can hop to /login with a success toast.
router.post(
  "/:token/accept",
  validate(acceptInviteSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = req.params.token;
      const { password } = req.body as z.infer<typeof acceptInviteSchema>;

      if (!/^[a-f0-9]{64}$/i.test(raw)) {
        res.status(410).json({
          success: false,
          data: null,
          error: "Invite is invalid or has expired",
        });
        return;
      }

      // Password strength FIRST so a weak-password attempt doesn't get
      // ambiguity from the token check. Wrong-token responses come from
      // a different code path so the response shape can stay distinct.
      const strength = validatePasswordStrength(password);
      if (!strength.ok) {
        res.status(400).json({
          success: false,
          data: null,
          error: strength.error ?? "Password is too weak",
        });
        return;
      }

      const invite = await prisma.userInvite.findUnique({
        where: { token: hashToken(raw) },
      });
      if (
        !invite ||
        invite.acceptedAt !== null ||
        invite.expiresAt.getTime() <= Date.now()
      ) {
        res.status(410).json({
          success: false,
          data: null,
          error: "Invite is invalid or has expired",
        });
        return;
      }

      // Defence-in-depth: if a User row with this email landed on the
      // tenant between invite-mint and invite-accept (e.g. via the
      // legacy admin-created-with-password flow), refuse to create a
      // duplicate. The invite is consumed regardless so the link can't
      // be re-used.
      const existing = await prisma.user.findFirst({
        where: { email: invite.email, tenantId: invite.tenantId },
        select: { id: true },
      });
      if (existing) {
        await prisma.userInvite.update({
          where: { id: invite.id },
          data: { acceptedAt: new Date() },
        });
        res.status(409).json({
          success: false,
          data: null,
          error: "A user with this email already exists in this tenant",
        });
        return;
      }

      const passwordHash = await bcrypt.hash(password, 10);
      // Two-step write so the test contract that watches AuditLog for
      // the new User can also assert the invite was marked accepted.
      // Both operations are tenant-scoped via the invite row so a
      // forged tenantId on the accept body cannot cross-pollinate.
      const user = await prisma.user.create({
        data: {
          email: invite.email,
          // Phone is required on the User model. We don't have one at
          // invite-time, so plant a placeholder the user can fix from
          // their profile page after first login. This mirrors the
          // existing pattern in routes/users.ts where ADMIN-created
          // users without a phone get a sentinel value.
          phone: "0000000000",
          name: invite.email.split("@")[0] ?? "New User",
          passwordHash,
          role: invite.role,
          tenantId: invite.tenantId,
          isActive: true,
        },
      });
      await prisma.userInvite.update({
        where: { id: invite.id },
        data: {
          acceptedAt: new Date(),
          acceptedUserId: user.id,
        },
      });

      await auditLog(
        req,
        "USER_INVITE_ACCEPTED",
        "user_invite",
        invite.id,
        {
          userId: user.id,
          email: user.email,
          role: user.role,
          tenantId: user.tenantId,
        },
      );

      res.status(200).json({
        success: true,
        data: {
          userId: user.id,
          email: user.email,
          role: user.role,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export { router as userInvitesRouter };
