import { z } from "zod";

export const FEEDBACK_CATEGORIES = [
  "DOCTOR",
  "NURSE",
  "RECEPTION",
  "CLEANLINESS",
  "FOOD",
  "WAITING_TIME",
  "BILLING",
  "OVERALL",
] as const;

export const COMPLAINT_STATUSES = [
  "OPEN",
  "UNDER_REVIEW",
  "RESOLVED",
  "ESCALATED",
  "CLOSED",
] as const;

export const COMPLAINT_PRIORITIES = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
] as const;

export const MESSAGE_TYPES = ["TEXT", "IMAGE", "FILE", "SYSTEM"] as const;

export const VISITOR_PURPOSES = [
  "PATIENT_VISIT",
  "DELIVERY",
  "APPOINTMENT",
  "MEETING",
  "OTHER",
] as const;

// ───────────────────────────────────────────────────────
// FEEDBACK
// ───────────────────────────────────────────────────────

export const createFeedbackSchema = z.object({
  patientId: z.string().uuid(),
  category: z.enum(FEEDBACK_CATEGORIES),
  rating: z.number().int().min(1).max(5),
  nps: z.number().int().min(0).max(10).optional(),
  comment: z.string().optional(),
});

// ───────────────────────────────────────────────────────
// COMPLAINTS
// ───────────────────────────────────────────────────────

export const createComplaintSchema = z
  .object({
    patientId: z.string().uuid().optional(),
    name: z.string().optional(),
    phone: z.string().optional(),
    category: z.string().min(1),
    description: z.string().min(1),
    priority: z.enum(COMPLAINT_PRIORITIES).default("MEDIUM"),
  })
  .refine((d) => d.patientId || d.name, {
    message: "Either patientId or name is required",
    path: ["name"],
  });

export const updateComplaintSchema = z.object({
  status: z.enum(COMPLAINT_STATUSES).optional(),
  assignedTo: z.string().uuid().optional(),
  resolution: z.string().optional(),
  priority: z.enum(COMPLAINT_PRIORITIES).optional(),
});

// ───────────────────────────────────────────────────────
// CHAT
// ───────────────────────────────────────────────────────

export const createChatRoomSchema = z.object({
  name: z.string().optional(),
  isGroup: z.boolean().default(false),
  participantIds: z.array(z.string().uuid()).min(1),
});

export const sendMessageSchema = z.object({
  roomId: z.string().uuid(),
  content: z.string().min(1),
  type: z.enum(MESSAGE_TYPES).default("TEXT"),
  attachmentUrl: z.string().optional(),
});

// ───────────────────────────────────────────────────────
// VISITORS
// ───────────────────────────────────────────────────────

export const checkinVisitorSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  idProofType: z.string().optional(),
  idProofNumber: z.string().optional(),
  patientId: z.string().uuid().optional(),
  purpose: z.enum(VISITOR_PURPOSES),
  department: z.string().optional(),
  notes: z.string().optional(),
});

// ───────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────
// OPS ENHANCEMENTS: engagement
// ───────────────────────────────────────────────────────

export const messageReactionSchema = z.object({
  emoji: z.string().min(1).max(8),
});

export const pinMessageSchema = z.object({
  pinned: z.boolean(),
});

export const mentionMessageSchema = sendMessageSchema.extend({
  mentionIds: z.array(z.string().uuid()).default([]),
  parentMessageId: z.string().uuid().optional(),
});

export const createChannelSchema = z.object({
  name: z.string().min(1),
  department: z.string().min(1),
  participantIds: z.array(z.string().uuid()).default([]),
});

export const visitorBlacklistSchema = z.object({
  idProofType: z.string().optional(),
  idProofNumber: z.string().optional(),
  name: z.string().optional(),
  phone: z.string().optional(),
  reason: z.string().min(1),
}).refine(
  (v) => v.idProofNumber || v.phone || v.name,
  "At least one identifier (idProofNumber, phone, or name) is required"
);

export const visitorPhotoSchema = z.object({
  photoUrl: z.string().min(1),
});

export const escalateComplaintSchema = z.object({
  reason: z.string().min(1).max(500),
});

export const feedbackRequestSchema = z.object({
  patientId: z.string().uuid(),
  channel: z.enum(["SMS", "EMAIL", "WHATSAPP"]).default("SMS"),
});

export const notificationTemplateSchema = z.object({
  type: z.string().min(1),
  channel: z.enum(["WHATSAPP", "SMS", "EMAIL", "PUSH"]),
  name: z.string().min(1),
  subject: z.string().optional(),
  body: z.string().min(1),
  isActive: z.boolean().default(true),
});

export const notificationScheduleSchema = z.object({
  quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  dndUntil: z.string().optional(),
});

export const notificationBroadcastSchema = z.object({
  title: z.string().min(1),
  message: z.string().min(1),
  audience: z.object({
    roles: z.array(z.string()).optional(),
    userIds: z.array(z.string().uuid()).optional(),
  }),
  channels: z
    .array(z.enum(["WHATSAPP", "SMS", "EMAIL", "PUSH"]))
    .default(["PUSH"]),
});

// Complaint SLA hours by priority
export const COMPLAINT_SLA_HOURS: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 24,
  MEDIUM: 72,
  LOW: 168,
};

// Sentiment keyword lists (very simple scoring)
export const SENTIMENT_POSITIVE_WORDS = [
  "good", "great", "excellent", "amazing", "wonderful", "helpful", "kind",
  "clean", "quick", "fast", "professional", "caring", "happy", "satisfied",
  "thank", "thanks", "appreciate", "best", "friendly", "comfortable",
];
export const SENTIMENT_NEGATIVE_WORDS = [
  "bad", "poor", "terrible", "awful", "worst", "rude", "slow", "dirty",
  "late", "delay", "unhelpful", "disappointed", "wait", "waiting", "angry",
  "frustrated", "unprofessional", "cold", "mistake", "error", "issue",
  "problem", "complaint", "pathetic",
];

export type CreateFeedbackInput = z.infer<typeof createFeedbackSchema>;
export type CreateComplaintInput = z.infer<typeof createComplaintSchema>;
export type UpdateComplaintInput = z.infer<typeof updateComplaintSchema>;
export type CreateChatRoomInput = z.infer<typeof createChatRoomSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type CheckinVisitorInput = z.infer<typeof checkinVisitorSchema>;
export type MessageReactionInput = z.infer<typeof messageReactionSchema>;
export type CreateChannelInput = z.infer<typeof createChannelSchema>;
export type VisitorBlacklistInput = z.infer<typeof visitorBlacklistSchema>;
export type EscalateComplaintInput = z.infer<typeof escalateComplaintSchema>;
export type NotificationTemplateInput = z.infer<typeof notificationTemplateSchema>;
export type NotificationScheduleInput = z.infer<typeof notificationScheduleSchema>;
export type NotificationBroadcastInput = z.infer<typeof notificationBroadcastSchema>;
