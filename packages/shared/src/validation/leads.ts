// Pearl ERP Stage 1 §3.3 (gap item #3) — CRM lead pipeline validation.
import { z } from "zod";

export const LEAD_STATUS_VALUES = [
  "NEW",
  "QUALIFIED",
  "ENGAGED",
  "BOOKED",
  "CONVERTED",
  "LOST",
] as const;

export const LEAD_SOURCE_VALUES = [
  "WEB",
  "WALK_IN",
  "PHONE",
  "WHATSAPP",
  "REFERRAL",
  "OTHER",
] as const;

export const LEAD_ACTIVITY_TYPE_VALUES = [
  "STATUS_CHANGE",
  "NOTE",
  "CALL",
  "MESSAGE",
  "EMAIL",
  "WHATSAPP_OUTBOUND",
  "DOCTOR_ALLOCATION",
  "CONVERSION",
] as const;

const phoneRegex = /^\+?\d{10,15}$/;

export const createLeadSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().regex(phoneRegex).optional().nullable(),
  email: z.string().email().optional().nullable(),
  source: z.enum(LEAD_SOURCE_VALUES).optional(),
  preferredDoctorId: z.string().uuid().nullable().optional(),
  assignedToUserId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).optional().nullable(),
  // Promote from a MarketingEnquiry (one-way; idempotent via @@unique).
  marketingEnquiryId: z.string().uuid().optional().nullable(),
});

export const updateLeadSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().regex(phoneRegex).nullable().optional(),
  email: z.string().email().nullable().optional(),
  source: z.enum(LEAD_SOURCE_VALUES).optional(),
  status: z.enum(LEAD_STATUS_VALUES).optional(),
  preferredDoctorId: z.string().uuid().nullable().optional(),
  assignedToUserId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const createLeadActivitySchema = z.object({
  type: z.enum(LEAD_ACTIVITY_TYPE_VALUES),
  body: z.string().max(5000).optional().nullable(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const convertLeadSchema = z.object({
  // Pre-fill optional patient-create fields; the route falls back to
  // the lead's name/phone/email when these are not supplied.
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().regex(phoneRegex).optional(),
  email: z.string().email().optional(),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]),
  // Reception will fill these on the create modal.
  dateOfBirth: z.string().optional(),
  age: z.number().int().min(0).max(150).optional(),
  address: z.string().optional(),
});

export type CreateLeadInput = z.infer<typeof createLeadSchema>;
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;
export type CreateLeadActivityInput = z.infer<typeof createLeadActivitySchema>;
export type ConvertLeadInput = z.infer<typeof convertLeadSchema>;
export type LeadStatus = (typeof LEAD_STATUS_VALUES)[number];
export type LeadSource = (typeof LEAD_SOURCE_VALUES)[number];
export type LeadActivityType = (typeof LEAD_ACTIVITY_TYPE_VALUES)[number];
