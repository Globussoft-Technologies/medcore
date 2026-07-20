import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  marketingEnquirySchema,
  zodIssuesToFieldErrors,
} from "@medcore/shared";
import { rateLimit } from "../middleware/rate-limit";
import { sendEmail } from "../services/messaging/email";

export const marketingRouter = Router();

// Internal inbox that receives a copy of every website enquiry, with the full
// client details. Overridable via env so staging/prod can point elsewhere.
// Kept distinct from the SendGrid sender (SENDGRID_FROM_EMAIL) so the
// notification is never a self-send (which Gmail hides from the Inbox).
const ENQUIRY_NOTIFY_EMAIL =
  process.env.ENQUIRY_NOTIFY_EMAIL || "support@medcore.software";

// Escape user-supplied values before interpolating into the notification HTML.
function esc(v: string | null | undefined): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Anti-spam: 10 enquiries per IP per minute. Public unauthenticated endpoint —
// must be guarded against bot floods even though we have a honeypot + Zod.
// Skipped in tests so the suite can fire dozens of requests without tripping.
const enquiryRateLimit =
  process.env.NODE_ENV === "test"
    ? (_req: Request, _res: Response, next: NextFunction) => next()
    : rateLimit(10, 60_000);

// Schema is defined in @medcore/shared so the browser runs the same rules.
// Issue #45: 400 responses now carry a structured `errors: [{field,message}]`
// list so the form can surface inline errors instead of a generic toast.
const enquirySchema = marketingEnquirySchema;

// POST /api/v1/marketing/enquiry — public, anti-spam honeypot + rate limit,
// optional CRM forward.
marketingRouter.post(
  "/enquiry",
  enquiryRateLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = enquirySchema.safeParse(req.body);
      if (!parsed.success) {
        // Structured 400 (Issue #45). `error` is preserved for older clients
        // that only read the string, but new clients should consume `errors[]`.
        const errors = zodIssuesToFieldErrors(parsed.error.issues);
        res.status(400).json({
          success: false,
          data: null,
          error: "Please correct the highlighted fields.",
          errors,
        });
        return;
      }
      const data = parsed.data;

      // Honeypot — silently accept to avoid giving bots signal, but don't store.
      if (data.website && data.website.length > 0) {
        res.status(200).json({ success: true, data: { id: null } });
        return;
      }

      // Duplicate guard — one demo request per email. Returns a structured
      // field error on `email` so the form renders it inline under the input
      // (same shape as Zod validation errors — see EnquiryForm.tsx).
      const existing = await prisma.marketingEnquiry.findFirst({
        where: { email: { equals: data.email, mode: "insensitive" } },
        select: { id: true },
      });
      if (existing) {
        res.status(409).json({
          success: false,
          data: null,
          error: "You have already booked a demo with this email.",
          errors: [
            {
              field: "email",
              message: "You have already booked a demo with this email.",
            },
          ],
        });
        return;
      }

      const enquiry = await prisma.marketingEnquiry.create({
        data: {
          fullName: data.fullName,
          email: data.email,
          // phone is optional on the public form; DB column is non-null,
          // so we store an empty string when omitted.
          phone: data.phone ?? "",
          hospitalName: data.hospitalName,
          hospitalSize: data.hospitalSize,
          role: data.role,
          message: data.message || null,
          preferredContactTime: data.preferredContactTime || null,
          source: "website",
        },
      });

      // Best-effort CRM forward — CRM outages must NOT block the enquiry.
      const crmUrl = process.env.CRM_WEBHOOK_URL;
      if (crmUrl) {
        try {
          const ctrl = new AbortController();
          const timeout = setTimeout(() => ctrl.abort(), 5000);
          const resp = await fetch(crmUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-medcore-source": "website",
            },
            body: JSON.stringify({
              id: enquiry.id,
              fullName: enquiry.fullName,
              email: enquiry.email,
              phone: enquiry.phone,
              hospitalName: enquiry.hospitalName,
              hospitalSize: enquiry.hospitalSize,
              role: enquiry.role,
              message: enquiry.message,
              preferredContactTime: enquiry.preferredContactTime,
              source: enquiry.source,
              createdAt: enquiry.createdAt,
            }),
            signal: ctrl.signal,
          });
          clearTimeout(timeout);
          if (resp.ok) {
            await prisma.marketingEnquiry.update({
              where: { id: enquiry.id },
              data: { forwardedToCrmAt: new Date() },
            });
          }
        } catch (e) {
          // Swallow — caller sees success, CRM retry is an ops concern.
          console.error("[marketing] CRM forward failed:", e);
        }
      }

      // Best-effort email notifications — delivery failures must NOT block the
      // enquiry (the lead is already persisted). We fire both in parallel and
      // log any provider errors instead of surfacing them to the visitor.
      //
      // Short enquiry id stamped on BOTH subjects so Gmail/SendGrid never
      // collapse two identical-looking emails into one thread or suppress the
      // second as a duplicate.
      const refId = String(enquiry.id).slice(-6);
      const detailRows = [
        ["Full name", enquiry.fullName],
        ["Email", enquiry.email],
        ["Phone", enquiry.phone || "—"],
        ["Hospital", enquiry.hospitalName],
        ["Hospital size", enquiry.hospitalSize],
        ["Role", enquiry.role],
        ["Preferred contact time", enquiry.preferredContactTime || "Anytime"],
        ["Message", enquiry.message || "—"],
      ]
        .map(
          ([label, value]) =>
            `<tr><td style="padding:6px 12px;font-weight:600;color:#374151;vertical-align:top">${esc(
              label
            )}</td><td style="padding:6px 12px;color:#111827">${esc(
              value
            )}</td></tr>`
        )
        .join("");

      // 1) Notify the internal inbox with the full lead details.
      const notifyEmail = sendEmail({
        to: ENQUIRY_NOTIFY_EMAIL,
        // Replies to the notification go straight to the client who enquired.
        replyTo: enquiry.email,
        subject: `New demo request — ${enquiry.hospitalName} (${enquiry.fullName}) [#${refId}]`,
        html: `
          <div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto">
            <div style="font-size:22px;font-weight:800;letter-spacing:1px;color:#2563eb;margin-bottom:8px">MedCore</div>
            <h2 style="color:#111827">New demo request from the website</h2>
            <p style="color:#6b7280">A new enquiry was submitted via the MedCore Contact page.</p>
            <table style="border-collapse:collapse;width:100%;border:1px solid #e5e7eb;border-radius:8px">
              ${detailRows}
            </table>
            <p style="margin-top:16px;color:#6b7280;font-size:12px">
              Reply directly to <a href="mailto:${esc(enquiry.email)}">${esc(
          enquiry.email
        )}</a> to reach the client.
            </p>
            <p style="color:#9ca3af;font-size:11px;margin-top:8px">— MedCore Website · Reference ID: #${refId}</p>
          </div>`,
      });

      // 2) Thank-you confirmation to the client's own email address.
      const thankYouEmail = sendEmail({
        to: enquiry.email,
        subject: `Thank you for your request to book a demo — MedCore [#${refId}]`,
        html: `
          <div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto">
            <div style="font-size:22px;font-weight:800;letter-spacing:1px;color:#2563eb;margin-bottom:8px">MedCore</div>
            <h2 style="color:#111827">Thank you, ${esc(enquiry.fullName)}!</h2>
            <p style="color:#374151">
              Thank you for your request to book a demo for <strong>${esc(
                enquiry.hospitalName
              )}</strong>. Our team has received your enquiry and will get back to you within one business day.
            </p>
            <p style="color:#374151">
              For any future connection, you can reach us directly at:
            </p>
            <ul style="color:#374151">
              <li>Phone: <a href="tel:+917566063718">+91 75660 63718</a></li>
              <li>Email: <a href="mailto:support@medcore.software">support@medcore.software</a></li>
            </ul>
            <p style="color:#6b7280;font-size:12px;margin-top:16px">
              — The MedCore Team
            </p>
            <p style="color:#9ca3af;font-size:11px;margin-top:8px">Reference ID: #${refId}</p>
          </div>`,
      });

      const [notifyResult, thankYouResult] = await Promise.all([
        notifyEmail,
        thankYouEmail,
      ]);
      if (!notifyResult.ok) {
        console.error("[marketing] notify email failed:", notifyResult.error);
      }
      if (!thankYouResult.ok) {
        console.error(
          "[marketing] thank-you (client) email failed:",
          "to=",
          enquiry.email,
          "error=",
          thankYouResult.error
        );
      } else {
        console.log(
          "[marketing] thank-you (client) email sent to",
          enquiry.email
        );
      }

      // Email is best-effort and never blocks the lead, but we DO report the
      // client thank-you delivery status so the failure isn't invisible.
      res.status(201).json({
        success: true,
        data: { id: enquiry.id },
        emails: {
          notify: notifyResult.ok,
          clientThankYou: thankYouResult.ok,
          clientThankYouError: thankYouResult.ok
            ? undefined
            : thankYouResult.error,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);
