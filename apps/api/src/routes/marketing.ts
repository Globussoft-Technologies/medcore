import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { z } from "zod";
import { rateLimit } from "../middleware/rate-limit";

export const marketingRouter = Router();

// Anti-spam: 10 enquiries per IP per minute. Public unauthenticated endpoint —
// must be guarded against bot floods even though we have a honeypot + Zod.
// Skipped in tests so the suite can fire dozens of requests without tripping.
const enquiryRateLimit =
  process.env.NODE_ENV === "test"
    ? (_req: Request, _res: Response, next: NextFunction) => next()
    : rateLimit(10, 60_000);

const enquirySchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().min(6).max(30),
  hospitalName: z.string().trim().min(2).max(200),
  hospitalSize: z.enum(["1-10", "10-50", "50-200", "200+"]),
  role: z.enum(["Administrator", "Doctor", "IT", "Other"]),
  message: z.string().trim().max(2000).optional().or(z.literal("")),
  preferredContactTime: z
    .enum(["Morning", "Afternoon", "Evening", "Anytime"])
    .optional(),
  // Honeypot — real users leave this empty; bots fill it in.
  website: z.string().optional(),
});

// POST /api/v1/marketing/enquiry — public, anti-spam honeypot + rate limit,
// optional CRM forward.
marketingRouter.post(
  "/enquiry",
  enquiryRateLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = enquirySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Invalid enquiry payload",
        });
        return;
      }
      const data = parsed.data;

      // Honeypot — silently accept to avoid giving bots signal, but don't store.
      if (data.website && data.website.length > 0) {
        res.status(200).json({ success: true, data: { id: null } });
        return;
      }

      const enquiry = await prisma.marketingEnquiry.create({
        data: {
          fullName: data.fullName,
          email: data.email,
          phone: data.phone,
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

      res.status(201).json({ success: true, data: { id: enquiry.id } });
    } catch (err) {
      next(err);
    }
  }
);
