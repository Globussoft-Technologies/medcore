/**
 * Outbound HTML body for the Pearl §8.2 super-admin invite flow.
 * Rendered by routes/super-admin-users.ts when an existing super-admin
 * invites a new cross-tenant operator; delivered via
 * services/messaging/email.ts (SendGrid).
 *
 * Unlike the tenant-staff `user-invite.html.ts` flow, the super-admin
 * invite carries an INITIAL PASSWORD (operator-typed at invite time)
 * rather than a one-use accept link — the platform admin signs in
 * directly and is force-prompted through TOTP enrolment on first
 * login (`auth.ts` returns 412 + enrolToken when
 * `superadmin:<id>:require_two_factor=true`).
 *
 * Inputs are escaped via {@link escapeHtml} so any operator-supplied
 * name / email containing markup can't leak inline into the body.
 */

export interface SuperAdminInviteEmailInput {
  inviteeName: string;
  inviteeEmail: string;
  temporaryPassword: string;
  signInUrl: string;
  requireTwoFactor: boolean;
  invitedByName?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderSuperAdminInviteEmail(
  input: SuperAdminInviteEmailInput,
): { subject: string; html: string; text: string } {
  const safeName = escapeHtml(input.inviteeName);
  const safeEmail = escapeHtml(input.inviteeEmail);
  const safePassword = escapeHtml(input.temporaryPassword);
  const safeUrl = escapeHtml(input.signInUrl);
  const safeInviter = input.invitedByName
    ? escapeHtml(input.invitedByName)
    : "the Pearl operations team";

  const subject = "You've been invited as a MedCore Super-Admin";

  const totpBlock = input.requireTwoFactor
    ? `<tr>
        <td style="padding:8px 32px 24px 32px;">
          <div style="border-left:4px solid #f59e0b; background:#fffbeb; padding:12px 16px; border-radius:6px;">
            <p style="margin:0; font-size:13px; color:#78350f; line-height:1.5;">
              <strong>Two-factor authentication is required.</strong><br />
              On first sign-in you'll be prompted to scan a QR code with an
              authenticator app (Google Authenticator, Authy, 1Password).
              You can't access the console until TOTP is enrolled.
            </p>
          </div>
        </td>
      </tr>`
    : "";

  const html = `<!doctype html>
<html lang="en">
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#f7fafc; margin:0; padding:24px; color:#1f2937;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px; margin:0 auto; background:#ffffff; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,0.08);">
      <tr>
        <td style="padding:32px 32px 8px 32px;">
          <div style="display:inline-block; padding:8px 12px; background:#ede9fe; color:#6d28d9; border-radius:999px; font-size:11px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase;">
            Super-Admin Invite
          </div>
          <h1 style="font-size:22px; margin:16px 0 8px 0; color:#0f172a;">
            Welcome to MedCore, ${safeName}
          </h1>
          <p style="margin:0; color:#475569; font-size:14px; line-height:1.6;">
            ${safeInviter} has granted you super-admin access to the MedCore
            platform. From this role you can onboard hospital tenants, view
            cross-tenant operations data, and manage platform billing.
          </p>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 32px 8px 32px;">
          <h2 style="font-size:13px; margin:0 0 8px 0; color:#334155; text-transform:uppercase; letter-spacing:0.04em;">
            Your sign-in details
          </h2>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px;">
            <tr>
              <td style="padding:12px 16px; border-bottom:1px solid #e2e8f0;">
                <div style="font-size:11px; color:#64748b; text-transform:uppercase; letter-spacing:0.04em;">Email</div>
                <div style="font-size:14px; color:#0f172a; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; margin-top:4px;">${safeEmail}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 16px;">
                <div style="font-size:11px; color:#64748b; text-transform:uppercase; letter-spacing:0.04em;">Temporary password</div>
                <div style="font-size:14px; color:#0f172a; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; margin-top:4px; word-break:break-all;">${safePassword}</div>
                <p style="margin:8px 0 0 0; font-size:12px; color:#dc2626;">
                  Change this on first sign-in. Don't share or store it
                  outside a password manager.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:16px 32px 8px 32px; text-align:center;">
          <a href="${safeUrl}"
             style="display:inline-block; padding:12px 28px; background:#6d28d9; color:#ffffff; text-decoration:none; border-radius:8px; font-weight:600; font-size:14px;">
            Sign in to MedCore
          </a>
        </td>
      </tr>
      ${totpBlock}
      <tr>
        <td style="padding:16px 32px 32px 32px; border-top:1px solid #e2e8f0;">
          <p style="margin:0 0 8px 0; font-size:12px; color:#64748b;">
            Trouble with the button? Paste this link into your browser:
          </p>
          <p style="margin:0; font-size:12px; word-break:break-all;">
            <a href="${safeUrl}" style="color:#6d28d9;">${safeUrl}</a>
          </p>
          <p style="margin:16px 0 0 0; font-size:11px; color:#94a3b8;">
            If you weren't expecting this invitation, reply to this email
            so the Pearl team can investigate.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text =
    `You've been invited as a MedCore Super-Admin.\n\n` +
    `Name: ${input.inviteeName}\n` +
    `Email: ${input.inviteeEmail}\n` +
    `Temporary password: ${input.temporaryPassword}\n\n` +
    `Sign in: ${input.signInUrl}\n\n` +
    (input.requireTwoFactor
      ? `Two-factor authentication is required — on first sign-in you'll be prompted to set up TOTP using an authenticator app. You can't access the console until TOTP is enrolled.\n\n`
      : "") +
    `Change the temporary password on first sign-in. If you weren't expecting this invitation, reply to this email so we can investigate.`;

  return { subject, html, text };
}
