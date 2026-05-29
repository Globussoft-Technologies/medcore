/**
 * Pearl ERP Stage 1 §8.3 piece 3f (2026-05-28) — monthly platform-invoice
 * mailer.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: a daily cron task that walks every ISSUED PlatformInvoice
 *   whose `emailedAt` is null AND whose tenant has a
 *   `billingContactEmail` set, renders an HTML body containing the
 *   invoice header + line items + GST split + total, and sends it via
 *   the existing SendGrid transport (`services/messaging/email.ts`).
 *   After a successful send, stamps an `INVOICE_EMAILED` audit row so
 *   re-runs idempotently skip already-delivered invoices.
 * - MODULES: reads `PlatformInvoice` + `Tenant` + `PlatformInvoiceLineItem`
 *   from `@medcore/db`, calls `sendEmail()` from `messaging/email.ts`,
 *   writes `AuditLog` rows via Prisma. No new schema columns —
 *   "already sent" is tracked entirely via the AuditLog idempotency
 *   join below so this can ship without a migration.
 * - WHY: piece 3b ships the invoice generator. Without delivery the
 *   tenant has no way to discover that they owe money — operators have
 *   to chase manually. This closes the loop: cron generates → cron
 *   emails → operator marks paid (or Razorpay webhook does it
 *   automatically when auto-debit lands in a future piece).
 *
 * Idempotency
 * ───────────
 * Re-runs are gated by an AuditLog probe:
 *   `auditLog.findFirst({ action: "PLATFORM_INVOICE_EMAILED", entityId: invoiceId })`
 * So a server restart in the middle of the daily sweep cannot
 * double-send. If the SendGrid call fails, no audit row is written —
 * the next sweep retries automatically. We deliberately do NOT swallow
 * the SendGrid error into a "delivered" claim.
 */
import type { PrismaClient } from "@medcore/db";
import { sendEmail } from "./messaging/email";

export interface MonthlyInvoiceMailerResult {
  inspected: number;
  sent: number;
  skippedAlreadyEmailed: number;
  skippedNoContact: number;
  errors: number;
}

function formatPaise(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const rupees = Math.abs(paise) / 100;
  return `${sign}₹${rupees.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function renderInvoiceHtml(invoice: {
  invoiceNumber: string;
  periodStart: Date;
  periodEnd: Date;
  subtotalInPaise: number;
  cgstInPaise: number;
  sgstInPaise: number;
  igstInPaise: number;
  totalInPaise: number;
  issuedAt: Date | null;
  tenant: { name: string };
  lineItems: Array<{
    description: string;
    quantity: number;
    unitPriceInPaise: number;
    amountInPaise: number;
  }>;
}): string {
  const periodLabel = `${invoice.periodStart.toUTCString().slice(5, 16)} – ${new Date(
    invoice.periodEnd.getTime() - 1,
  )
    .toUTCString()
    .slice(5, 16)}`;
  const lineRows = invoice.lineItems
    .map(
      (li) => `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${li.description}</td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;">${li.quantity.toLocaleString()}</td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;">${formatPaise(li.unitPriceInPaise)}</td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;">${formatPaise(li.amountInPaise)}</td>
        </tr>`,
    )
    .join("");

  const gstRow = invoice.igstInPaise > 0
    ? `<tr><td colspan="3" style="padding:8px;text-align:right;">IGST (18%)</td><td style="padding:8px;text-align:right;">${formatPaise(invoice.igstInPaise)}</td></tr>`
    : `<tr><td colspan="3" style="padding:8px;text-align:right;">CGST (9%)</td><td style="padding:8px;text-align:right;">${formatPaise(invoice.cgstInPaise)}</td></tr>
       <tr><td colspan="3" style="padding:8px;text-align:right;">SGST (9%)</td><td style="padding:8px;text-align:right;">${formatPaise(invoice.sgstInPaise)}</td></tr>`;

  return `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9fafb;padding:24px;color:#111827;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
    <h1 style="margin:0 0 4px 0;font-size:20px;">MedCore HMS — Platform Invoice</h1>
    <p style="margin:0 0 24px 0;color:#6b7280;font-size:13px;">${invoice.invoiceNumber} · ${periodLabel}</p>
    <p style="margin:0 0 16px 0;">Hello ${invoice.tenant.name},</p>
    <p style="margin:0 0 24px 0;">Your platform invoice for the period above is ready. The breakdown is below.</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#f3f4f6;text-align:left;">
          <th style="padding:8px;">Description</th>
          <th style="padding:8px;text-align:right;">Qty</th>
          <th style="padding:8px;text-align:right;">Unit</th>
          <th style="padding:8px;text-align:right;">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${lineRows}
        <tr><td colspan="3" style="padding:8px;text-align:right;font-weight:600;">Subtotal</td><td style="padding:8px;text-align:right;font-weight:600;">${formatPaise(invoice.subtotalInPaise)}</td></tr>
        ${gstRow}
        <tr style="background:#f9fafb;"><td colspan="3" style="padding:12px 8px;text-align:right;font-weight:700;font-size:14px;">Total</td><td style="padding:12px 8px;text-align:right;font-weight:700;font-size:14px;">${formatPaise(invoice.totalInPaise)}</td></tr>
      </tbody>
    </table>
    <p style="margin:24px 0 0 0;color:#6b7280;font-size:12px;">Bank transfer / auto-debit reference: <strong>${invoice.invoiceNumber}</strong>. For queries, reply to this email.</p>
  </div>
</body></html>`;
}

/**
 * Sweep every ISSUED PlatformInvoice that hasn't been emailed yet,
 * send it to the tenant's billing contact, and stamp an audit row.
 * Returns a summary the scheduled-task wrapper logs.
 */
export interface SendSingleInvoiceResult {
  sent: boolean;
  reason?: "NOT_FOUND" | "NO_CONTACT" | "NOT_ISSUED" | "SEND_FAILED";
  to: string | null;
  error?: string;
}

/**
 * Pearl §8.3 piece 3f (2026-05-28) — operator-initiated reminder. Emails
 * a single PlatformInvoice (no idempotency probe — operators can fire
 * the reminder multiple times deliberately) and writes a
 * PLATFORM_INVOICE_REMINDER_SENT audit row distinct from the cron's
 * PLATFORM_INVOICE_EMAILED row. Returns a small result digest the route
 * surfaces to the UI alert.
 */
export async function sendSingleInvoiceReminder(
  prisma: PrismaClient,
  invoiceId: string,
  triggeredByUserId: string | null,
): Promise<SendSingleInvoiceResult> {
  const inv = await prisma.platformInvoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      invoiceNumber: true,
      periodStart: true,
      periodEnd: true,
      subtotalInPaise: true,
      cgstInPaise: true,
      sgstInPaise: true,
      igstInPaise: true,
      totalInPaise: true,
      issuedAt: true,
      status: true,
      tenantId: true,
      tenant: {
        select: { id: true, name: true, billingContactEmail: true },
      },
      lineItems: {
        orderBy: { createdAt: "asc" },
        select: {
          description: true,
          quantity: true,
          unitPriceInPaise: true,
          amountInPaise: true,
        },
      },
    },
  });
  if (!inv) {
    return { sent: false, reason: "NOT_FOUND", to: null };
  }
  if (inv.status !== "ISSUED") {
    return { sent: false, reason: "NOT_ISSUED", to: null };
  }
  const contact = inv.tenant?.billingContactEmail ?? null;
  if (!contact) {
    return { sent: false, reason: "NO_CONTACT", to: null };
  }

  const html = renderInvoiceHtml({
    invoiceNumber: inv.invoiceNumber,
    periodStart: inv.periodStart,
    periodEnd: inv.periodEnd,
    subtotalInPaise: inv.subtotalInPaise,
    cgstInPaise: inv.cgstInPaise,
    sgstInPaise: inv.sgstInPaise,
    igstInPaise: inv.igstInPaise,
    totalInPaise: inv.totalInPaise,
    issuedAt: inv.issuedAt,
    tenant: { name: inv.tenant?.name ?? "" },
    lineItems: inv.lineItems,
  });

  const result = await sendEmail({
    to: contact,
    subject: `Reminder — Invoice ${inv.invoiceNumber} (MedCore HMS Platform)`,
    html,
  });
  if (!result.ok) {
    return {
      sent: false,
      reason: "SEND_FAILED",
      to: contact,
      error: result.error,
    };
  }

  await prisma.auditLog.create({
    data: {
      action: "PLATFORM_INVOICE_REMINDER_SENT",
      entity: "platform_invoice",
      entityId: inv.id,
      ...(triggeredByUserId ? { userId: triggeredByUserId } : {}),
      details: {
        invoiceNumber: inv.invoiceNumber,
        tenantId: inv.tenantId,
        to: contact,
        sentAt: new Date().toISOString(),
      },
    },
  });

  return { sent: true, to: contact };
}

export async function sendMonthlyInvoiceEmails(
  prisma: PrismaClient,
): Promise<MonthlyInvoiceMailerResult> {
  const summary: MonthlyInvoiceMailerResult = {
    inspected: 0,
    sent: 0,
    skippedAlreadyEmailed: 0,
    skippedNoContact: 0,
    errors: 0,
  };

  const invoices = await prisma.platformInvoice.findMany({
    where: { status: "ISSUED" },
    orderBy: { issuedAt: "asc" },
    select: {
      id: true,
      invoiceNumber: true,
      periodStart: true,
      periodEnd: true,
      subtotalInPaise: true,
      cgstInPaise: true,
      sgstInPaise: true,
      igstInPaise: true,
      totalInPaise: true,
      issuedAt: true,
      tenantId: true,
      tenant: {
        select: { id: true, name: true, billingContactEmail: true },
      },
      lineItems: {
        orderBy: { createdAt: "asc" },
        select: {
          description: true,
          quantity: true,
          unitPriceInPaise: true,
          amountInPaise: true,
        },
      },
    },
    take: 200,
  });

  summary.inspected = invoices.length;

  for (const inv of invoices) {
    try {
      const contact = inv.tenant?.billingContactEmail;
      if (!contact) {
        summary.skippedNoContact += 1;
        continue;
      }

      // Idempotency probe — never double-send a single invoice.
      const alreadySent = await prisma.auditLog.findFirst({
        where: {
          action: "PLATFORM_INVOICE_EMAILED",
          entity: "platform_invoice",
          entityId: inv.id,
        },
        select: { id: true },
      });
      if (alreadySent) {
        summary.skippedAlreadyEmailed += 1;
        continue;
      }

      const html = renderInvoiceHtml({
        invoiceNumber: inv.invoiceNumber,
        periodStart: inv.periodStart,
        periodEnd: inv.periodEnd,
        subtotalInPaise: inv.subtotalInPaise,
        cgstInPaise: inv.cgstInPaise,
        sgstInPaise: inv.sgstInPaise,
        igstInPaise: inv.igstInPaise,
        totalInPaise: inv.totalInPaise,
        issuedAt: inv.issuedAt,
        tenant: { name: inv.tenant?.name ?? "" },
        lineItems: inv.lineItems,
      });

      const result = await sendEmail({
        to: contact,
        subject: `Invoice ${inv.invoiceNumber} — MedCore HMS Platform`,
        html,
      });
      if (!result.ok) {
        summary.errors += 1;
        console.error(
          "[platform_invoice_mailer] send failed for",
          inv.invoiceNumber,
          result.error,
        );
        continue;
      }

      await prisma.auditLog.create({
        data: {
          action: "PLATFORM_INVOICE_EMAILED",
          entity: "platform_invoice",
          entityId: inv.id,
          details: {
            invoiceNumber: inv.invoiceNumber,
            tenantId: inv.tenantId,
            to: contact,
            sentAt: new Date().toISOString(),
          },
        },
      });
      summary.sent += 1;
    } catch (err) {
      summary.errors += 1;
      console.error(
        "[platform_invoice_mailer] unexpected error for",
        inv.invoiceNumber,
        err,
      );
    }
  }

  return summary;
}
