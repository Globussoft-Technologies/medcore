/**
 * Outbound HTML body for the Pearl §8.2 (gap row 213) staff email-invite
 * flow. Rendered by routes/user-invites.ts when an ADMIN issues an invite;
 * shipped via services/messaging/email.ts (SendGrid).
 *
 * Inputs are escaped via {@link escapeHtml} so a tenant name / inviter
 * email containing markup never lands inline in the body. The accept URL
 * is built by the route handler — we only stitch it into an <a href="…">
 * here (URL itself is server-controlled, no escaping needed beyond the
 * standard attribute boundary).
 */

export interface UserInviteEmailInput {
  inviteeEmail: string;
  tenantName: string;
  acceptUrl: string;
  expiresAt: Date;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatExpiry(expiresAt: Date): string {
  // Asia/Kolkata business hours match the rest of the platform.
  return expiresAt.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function renderUserInviteEmail(input: UserInviteEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const safeTenant = escapeHtml(input.tenantName);
  const safeEmail = escapeHtml(input.inviteeEmail);
  const safeUrl = escapeHtml(input.acceptUrl);
  const safeExpiry = escapeHtml(formatExpiry(input.expiresAt));

  const subject = `You've been invited to join ${input.tenantName} on MedCore`;

  const html = `<!doctype html>
<html lang="en">
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#f7fafc; margin:0; padding:24px; color:#1f2937;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px; margin:0 auto; background:#ffffff; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,0.08);">
      <tr>
        <td style="padding:32px 32px 16px 32px;">
          <h1 style="font-size:20px; margin:0 0 8px 0; color:#0f172a;">You're invited to ${safeTenant}</h1>
          <p style="margin:0; color:#475569; font-size:14px; line-height:1.5;">
            An administrator at <strong>${safeTenant}</strong> has invited
            <strong>${safeEmail}</strong> to join their MedCore workspace.
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 32px 24px 32px;">
          <p style="margin:0 0 16px 0; font-size:14px; color:#334155;">
            Click the button below to set your password and finish creating
            your account. This invite expires on <strong>${safeExpiry}</strong>.
          </p>
          <p style="margin:0 0 24px 0; text-align:center;">
            <a href="${safeUrl}"
               style="display:inline-block; padding:12px 24px; background:#2563eb; color:#ffffff; text-decoration:none; border-radius:8px; font-weight:600; font-size:14px;">
              Set your password
            </a>
          </p>
          <p style="margin:0; font-size:12px; color:#64748b; line-height:1.5;">
            If the button doesn't work, copy this link into your browser:<br />
            <a href="${safeUrl}" style="color:#2563eb; word-break:break-all;">${safeUrl}</a>
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 32px 32px 32px; border-top:1px solid #e2e8f0;">
          <p style="margin:0; font-size:12px; color:#94a3b8;">
            If you weren't expecting this invitation, you can safely ignore
            this email. The link will stop working after the expiry above.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text =
    `You've been invited to join ${input.tenantName} on MedCore.\n\n` +
    `Email: ${input.inviteeEmail}\n` +
    `Set your password: ${input.acceptUrl}\n` +
    `Expires: ${formatExpiry(input.expiresAt)} (Asia/Kolkata)\n\n` +
    `If you weren't expecting this invitation, you can safely ignore this email.`;

  return { subject, html, text };
}
