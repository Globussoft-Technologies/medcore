/**
 * Pearl ERP Stage 1 §8.3 (gap row 215 closure piece 3b, 2026-05-24) —
 * platform-invoice email stub.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: a deliberately-stubbed "send the invoice email" surface.
 *   Today it ONLY logs a `PLATFORM_INVOICE_EMAIL_QUEUED` audit row +
 *   a `console.log` "would-send" line. Real SendGrid wiring is
 *   deferred to a follow-up tick because the `SENDGRID_API_KEY`
 *   provisioning + `from`-address policy for platform-side mail
 *   (versus tenant-scoped patient/appointment mail) has not been
 *   decided yet.
 * - MODULES: reads `Tenant` for `name` only; writes one `AuditLog`
 *   row via `@medcore/db`.
 * - WHY: piece 3b's promise is "invoice generation + email". The
 *   audit-row + log line is enough to demonstrate the integration
 *   point exists, prove the cron is firing for every tenant, and
 *   give super-admins something to grep for in the audit table when
 *   debugging "did the invoice notification get queued?". Swapping
 *   the body to a real SendGrid call is a one-function edit later.
 *
 * Why NOT block on the real send today
 * ────────────────────────────────────
 * `apps/api/src/services/notification.ts` already plumbs SendGrid
 * for patient-facing notifications using per-tenant credentials. But
 * platform-side mail (Onviqa → tenant ADMIN) is a different `from`
 * domain + a different policy decision (do we route through the
 * tenant's SendGrid or our own?). Forcing that decision today would
 * block the cron. Stubbing the body unblocks piece 3b without
 * pre-committing to either side of the policy.
 */
import type { Prisma, PrismaClient } from "@medcore/db";

export interface PlatformInvoiceForEmail {
  id: string;
  invoiceNumber: string;
  totalInPaise: number;
  periodStart: Date;
  periodEnd: Date;
}

export interface TenantForEmail {
  id: string;
  name: string;
}

export interface SendPlatformInvoiceEmailResult {
  status: "STUBBED" | "SENT" | "ERROR";
  recipientEmail: string | null;
  message: string;
}

/**
 * "Send" a platform invoice to a tenant's billing contact. Today
 * this is a no-op stub that logs an audit row + a console line.
 *
 * Returns `{status: "STUBBED"}` deliberately so callers can detect
 * "this didn't really go out" once the real wiring lands and tests
 * start asserting on `"SENT"`.
 */
export async function sendPlatformInvoiceEmail(
  prisma: PrismaClient,
  invoice: PlatformInvoiceForEmail,
  tenant: TenantForEmail,
): Promise<SendPlatformInvoiceEmailResult> {
  // Recipient lookup is deferred until real wiring lands — the policy
  // decision is "tenant ADMIN's email" vs "explicit billingContactEmail
  // column on Tenant" (the column does not exist yet). For the stub we
  // just record the tenant + invoice in the audit trail; the real
  // SendGrid call will pick the recipient at that point.
  const recipientEmail: string | null = null;
  const totalInRupees = (invoice.totalInPaise / 100).toFixed(2);
  const periodLabel = `${invoice.periodStart
    .toISOString()
    .slice(0, 10)} → ${invoice.periodEnd.toISOString().slice(0, 10)}`;
  const message = `Would email invoice ${invoice.invoiceNumber} (₹${totalInRupees}, period ${periodLabel}) to tenant ${tenant.name} (${tenant.id})`;

  // Console line — useful when tailing the API logs during a manual
  // cron-run smoke test before the real send is wired up.
  console.log(`[platform_invoice_email STUB] ${message}`);

  try {
    await prisma.auditLog.create({
      data: {
        action: "PLATFORM_INVOICE_EMAIL_QUEUED",
        entity: "platform_invoice",
        entityId: invoice.id,
        details: {
          invoiceNumber: invoice.invoiceNumber,
          tenantId: tenant.id,
          tenantName: tenant.name,
          totalInPaise: invoice.totalInPaise,
          recipientEmail,
          mode: "STUB",
          note:
            "Real SendGrid wiring deferred — see services/platform-invoice-email.ts header",
        } as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.error(
      "[platform_invoice_email] failed to write audit row for",
      invoice.id,
      err,
    );
    return { status: "ERROR", recipientEmail, message };
  }

  return { status: "STUBBED", recipientEmail, message };
}
