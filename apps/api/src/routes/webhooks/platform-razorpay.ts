/**
 * Pearl ERP Stage 1 §8.3 (gap rows 215-218 closure piece 3c, 2026-05-25) —
 * Razorpay Subscriptions webhook for the PLATFORM-side billing (Onviqa
 * → tenant hospital). Distinct from the existing patient-side webhook
 * at `routes/billing.ts → razorpayWebhookRouter`.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: receives Razorpay-Subscriptions events (`subscription.charged`,
 *   `subscription.pending`, `payment.failed`,
 *   `subscription.halted`, `subscription.cancelled`), resolves the
 *   target `TenantSubscription` via `razorpaySubscriptionId`, and
 *   drives the state machine in `services/platform-subscription-state.ts`.
 *   On `subscription.charged` it also marks the matching `PlatformInvoice`
 *   row PAID via `markInvoicePaid` from `services/platform-invoice-generator.ts`.
 * - MODULES:
 *   - HMAC verification via `services/razorpay.ts:verifyWebhookSignature`
 *     (REUSED — same constant-time compare as the patient webhook).
 *   - State transitions via `services/platform-subscription-state.ts`.
 *   - Invoice-paid marker via `services/platform-invoice-generator.ts`.
 *   - Reads `TenantSubscription` / `PlatformInvoice` from `@medcore/db`.
 * - WHY: pieces 3a (schema) + 3b (monthly cron) are inert without
 *   payment-event input. This webhook closes the loop — when Razorpay
 *   auto-debits a tenant on the 1st, the matching `PlatformInvoice`
 *   flips to PAID and (if first payment) the subscription leaves
 *   `trial` for `active`. A failed charge or halted subscription drives
 *   `past_due` so the 7-day grace timer starts; `subscription.cancelled`
 *   terminates the row. All transitions are idempotent so Razorpay's
 *   webhook retry behaviour cannot double-flip state.
 *
 * Mount details
 * ─────────────
 * Mounted in `app.ts` BEFORE `express.json()` so the inner
 * `express.raw({type:"application/json"})` middleware can read the
 * unparsed bytes Razorpay signed. Auth is HMAC-only — NO JWT — because
 * webhook callers are public Internet. The `RAZORPAY_PLATFORM_WEBHOOK_SECRET`
 * env var holds the secret configured in the Razorpay dashboard for the
 * platform subscriptions webhook (a SEPARATE secret from the
 * patient-billing webhook's `RAZORPAY_WEBHOOK_SECRET` — both can be set
 * independently per Razorpay best-practice).
 *
 * Idempotency
 * ───────────
 * - Subscription state transitions are themselves idempotent (see
 *   `platform-subscription-state.ts`).
 * - `markInvoicePaid` short-circuits on already-PAID rows so a
 *   webhook retry can't overwrite `paidAt` / `paymentReference`.
 * - Unknown event types return 200 so Razorpay doesn't retry forever.
 */
import { Router, type Request, type Response } from "express";
import express from "express";
import { prisma } from "@medcore/db";
import { verifyWebhookSignature } from "../../services/razorpay";
import { markInvoicePaid } from "../../services/platform-invoice-generator";
import {
  transitionToActive,
  transitionToPastDue,
  transitionToSuspended,
  cancelSubscription,
} from "../../services/platform-subscription-state";

interface WebhookPaymentEntity {
  id?: string;
  status?: string;
  amount?: number; // paise
  error_description?: string;
}

interface WebhookSubscriptionEntity {
  id?: string;
  status?: string;
  current_start?: number;
  current_end?: number;
  notes?: Record<string, string>;
}

interface WebhookEvent {
  event?: string;
  payload?: {
    payment?: { entity?: WebhookPaymentEntity };
    subscription?: { entity?: WebhookSubscriptionEntity };
  };
}

const platformRazorpayRouter = Router();

async function findSubscriptionByRazorpayId(razorpaySubscriptionId: string) {
  return prisma.tenantSubscription.findFirst({
    where: { razorpaySubscriptionId },
    select: {
      id: true,
      tenantId: true,
      status: true,
      currentPeriodStart: true,
      currentPeriodEnd: true,
    },
  });
}

/**
 * Find a PlatformInvoice that this payment should settle. Strategy:
 * (1) latest ISSUED invoice for the subscription; (2) most recent
 * unpaid window. Returns null if no matching invoice exists (the
 * payment is logged but no invoice is updated — operator can reconcile
 * manually).
 */
async function findInvoiceToSettleForSubscription(subscriptionId: string) {
  return prisma.platformInvoice.findFirst({
    where: {
      subscriptionId,
      status: { in: ["ISSUED", "DRAFT"] },
    },
    orderBy: { periodStart: "desc" },
    select: { id: true, status: true },
  });
}

async function handleSubscriptionCharged(
  payment: WebhookPaymentEntity | undefined,
  subscription: WebhookSubscriptionEntity | undefined,
  now: Date,
): Promise<void> {
  const razorpaySubscriptionId = subscription?.id;
  const razorpayPaymentId = payment?.id;
  if (!razorpaySubscriptionId || !razorpayPaymentId) return;

  const sub = await findSubscriptionByRazorpayId(razorpaySubscriptionId);
  if (!sub) {
    console.warn(
      "[platform-razorpay-webhook] no TenantSubscription found for",
      razorpaySubscriptionId,
    );
    return;
  }

  // Mark the matching PlatformInvoice PAID (if one exists). `paidByUserId`
  // is `null` for webhook-driven payments — the schema permits null on the
  // operator FK exactly so auto-debit can be recorded without inventing a
  // synthetic operator User.
  const invoice = await findInvoiceToSettleForSubscription(sub.id);
  if (invoice) {
    try {
      await markInvoicePaid(
        prisma,
        invoice.id,
        null as unknown as string,
        razorpayPaymentId,
        now,
      );
    } catch (err) {
      console.error(
        "[platform-razorpay-webhook] markInvoicePaid failed",
        invoice.id,
        err,
      );
    }
  } else {
    console.warn(
      "[platform-razorpay-webhook] no unpaid PlatformInvoice for subscription",
      sub.id,
      "— payment recorded against subscription only",
    );
  }

  // Successful payment lifts trial / past_due → active. Idempotent.
  if (sub.status === "trial" || sub.status === "past_due") {
    try {
      await transitionToActive(prisma, sub.id, now);
    } catch (err) {
      console.error(
        "[platform-razorpay-webhook] transitionToActive failed",
        sub.id,
        err,
      );
    }
  }
}

async function handlePaymentFailedOrPending(
  subscription: WebhookSubscriptionEntity | undefined,
  now: Date,
): Promise<void> {
  const razorpaySubscriptionId = subscription?.id;
  if (!razorpaySubscriptionId) return;

  const sub = await findSubscriptionByRazorpayId(razorpaySubscriptionId);
  if (!sub) {
    console.warn(
      "[platform-razorpay-webhook] no TenantSubscription found for failed payment on",
      razorpaySubscriptionId,
    );
    return;
  }

  if (sub.status === "active" || sub.status === "trial") {
    try {
      await transitionToPastDue(prisma, sub.id, now);
    } catch (err) {
      console.error(
        "[platform-razorpay-webhook] transitionToPastDue failed",
        sub.id,
        err,
      );
    }
  }
}

async function handleSubscriptionHalted(
  subscription: WebhookSubscriptionEntity | undefined,
  now: Date,
): Promise<void> {
  const razorpaySubscriptionId = subscription?.id;
  if (!razorpaySubscriptionId) return;

  const sub = await findSubscriptionByRazorpayId(razorpaySubscriptionId);
  if (!sub) return;

  // `subscription.halted` from Razorpay means auto-debit has been
  // paused indefinitely. Move past_due rows on to suspended; active rows
  // through past_due → suspended is what the daily grace sweep handles,
  // but a HALTED signal is decisive — flip directly to suspended only
  // when already past_due. Otherwise mark past_due first.
  if (sub.status === "past_due") {
    try {
      await transitionToSuspended(prisma, sub.id, now);
    } catch (err) {
      console.error(
        "[platform-razorpay-webhook] transitionToSuspended failed",
        sub.id,
        err,
      );
    }
  } else if (sub.status === "active" || sub.status === "trial") {
    try {
      await transitionToPastDue(prisma, sub.id, now);
    } catch (err) {
      console.error(
        "[platform-razorpay-webhook] transitionToPastDue (halted) failed",
        sub.id,
        err,
      );
    }
  }
}

async function handleSubscriptionCancelled(
  subscription: WebhookSubscriptionEntity | undefined,
  now: Date,
): Promise<void> {
  const razorpaySubscriptionId = subscription?.id;
  if (!razorpaySubscriptionId) return;

  const sub = await findSubscriptionByRazorpayId(razorpaySubscriptionId);
  if (!sub) return;

  try {
    await cancelSubscription(prisma, sub.id, now);
  } catch (err) {
    console.error(
      "[platform-razorpay-webhook] cancelSubscription failed",
      sub.id,
      err,
    );
  }
}

platformRazorpayRouter.post(
  "/platform-razorpay",
  // raw-body: HMAC over un-parsed bytes. Confined to this route so the
  // rest of the API still uses express.json().
  express.raw({ type: "application/json", limit: "1mb" }),
  async (req: Request, res: Response) => {
    const signature = req.header("x-razorpay-signature");
    const secret = process.env.RAZORPAY_PLATFORM_WEBHOOK_SECRET;
    const raw: Buffer = (req.body as Buffer) ?? Buffer.from("");

    if (!signature) {
      res.status(401).json({ success: false, error: "missing signature" });
      return;
    }
    if (!verifyWebhookSignature(raw, signature, secret)) {
      res.status(401).json({ success: false, error: "invalid signature" });
      return;
    }

    let event: WebhookEvent;
    try {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      event = JSON.parse(text);
    } catch {
      res.status(400).json({ success: false, error: "invalid json" });
      return;
    }

    const now = new Date();
    try {
      switch (event.event) {
        case "subscription.charged":
          await handleSubscriptionCharged(
            event.payload?.payment?.entity,
            event.payload?.subscription?.entity,
            now,
          );
          break;
        case "subscription.pending":
        case "payment.failed":
          await handlePaymentFailedOrPending(
            event.payload?.subscription?.entity,
            now,
          );
          break;
        case "subscription.halted":
          await handleSubscriptionHalted(
            event.payload?.subscription?.entity,
            now,
          );
          break;
        case "subscription.cancelled":
          await handleSubscriptionCancelled(
            event.payload?.subscription?.entity,
            now,
          );
          break;
        default:
          // Unknown event — ack 200 so Razorpay doesn't retry.
          break;
      }
    } catch (e) {
      console.error("[platform-razorpay-webhook] handler error", e);
      // Still ack 200: avoid infinite Razorpay retry loops on handler
      // bugs. The error is logged for ops to investigate; the next
      // legitimate event will reconverge state because every helper is
      // idempotent.
    }

    res.status(200).json({ success: true });
  },
);

export { platformRazorpayRouter };
