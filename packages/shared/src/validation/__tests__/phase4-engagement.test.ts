// Coverage tests for phase4-engagement validation schemas.
// What: exhaustive happy / invalid / edge cases for every exported Zod schema
//   in packages/shared/src/validation/phase4-engagement.ts (feedback,
//   complaints, chat, visitors, ops enhancements, notification templates).
// Which modules: imports only the schemas + constants from ../phase4-engagement.
// Why: file shipped with 0% test coverage; the schemas back PII-bearing
//   surfaces (feedback comments, complaint descriptions, visitor names) plus
//   the Issue #577 reject-HTML-not-strip contract. Regression guards needed
//   so the sanitize-middleware interaction (SCHEMA_REJECT_PATHS) doesn't
//   silently regress.
import { describe, it, expect } from "vitest";
import {
  FEEDBACK_CATEGORIES,
  COMPLAINT_STATUSES,
  COMPLAINT_PRIORITIES,
  MESSAGE_TYPES,
  VISITOR_PURPOSES,
  COMPLAINT_SLA_HOURS,
  SENTIMENT_POSITIVE_WORDS,
  SENTIMENT_NEGATIVE_WORDS,
  createFeedbackSchema,
  createComplaintSchema,
  updateComplaintSchema,
  createChatRoomSchema,
  sendMessageSchema,
  checkinVisitorSchema,
  messageReactionSchema,
  pinMessageSchema,
  mentionMessageSchema,
  createChannelSchema,
  visitorBlacklistSchema,
  visitorPhotoSchema,
  escalateComplaintSchema,
  feedbackRequestSchema,
  notificationTemplateSchema,
  notificationScheduleSchema,
  notificationBroadcastSchema,
} from "../phase4-engagement";

const UUID = "550e8400-e29b-41d4-a716-446655441111";
const UUID_2 = "550e8400-e29b-41d4-a716-446655442222";

// ───────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────

describe("exported constant tuples", () => {
  it("FEEDBACK_CATEGORIES contains the 8 canonical categories", () => {
    expect(FEEDBACK_CATEGORIES).toEqual([
      "DOCTOR",
      "NURSE",
      "RECEPTION",
      "CLEANLINESS",
      "FOOD",
      "WAITING_TIME",
      "BILLING",
      "OVERALL",
    ]);
  });
  it("COMPLAINT_STATUSES contains the 5 lifecycle states", () => {
    expect(COMPLAINT_STATUSES).toEqual([
      "OPEN",
      "UNDER_REVIEW",
      "RESOLVED",
      "ESCALATED",
      "CLOSED",
    ]);
  });
  it("COMPLAINT_PRIORITIES contains LOW..CRITICAL", () => {
    expect(COMPLAINT_PRIORITIES).toEqual(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
  });
  it("MESSAGE_TYPES contains TEXT/IMAGE/FILE/SYSTEM", () => {
    expect(MESSAGE_TYPES).toEqual(["TEXT", "IMAGE", "FILE", "SYSTEM"]);
  });
  it("VISITOR_PURPOSES contains the 5 canonical purposes", () => {
    expect(VISITOR_PURPOSES).toEqual([
      "PATIENT_VISIT",
      "DELIVERY",
      "APPOINTMENT",
      "MEETING",
      "OTHER",
    ]);
  });
  it("COMPLAINT_SLA_HOURS encodes the priority→hours map", () => {
    expect(COMPLAINT_SLA_HOURS.CRITICAL).toBe(4);
    expect(COMPLAINT_SLA_HOURS.HIGH).toBe(24);
    expect(COMPLAINT_SLA_HOURS.MEDIUM).toBe(72);
    expect(COMPLAINT_SLA_HOURS.LOW).toBe(168);
  });
  it("sentiment word lists are non-empty and lowercase", () => {
    expect(SENTIMENT_POSITIVE_WORDS.length).toBeGreaterThan(0);
    expect(SENTIMENT_NEGATIVE_WORDS.length).toBeGreaterThan(0);
    for (const w of SENTIMENT_POSITIVE_WORDS) expect(w).toBe(w.toLowerCase());
    for (const w of SENTIMENT_NEGATIVE_WORDS) expect(w).toBe(w.toLowerCase());
  });
});

// ───────────────────────────────────────────────────────
// FEEDBACK
// ───────────────────────────────────────────────────────

describe("createFeedbackSchema", () => {
  const valid = {
    patientId: UUID,
    category: "DOCTOR" as const,
    rating: 5,
  };
  it("accepts a minimal valid feedback", () => {
    expect(createFeedbackSchema.safeParse(valid).success).toBe(true);
  });
  it("accepts feedback with nps + comment", () => {
    expect(
      createFeedbackSchema.safeParse({
        ...valid,
        nps: 9,
        comment: "Loved the visit",
      }).success
    ).toBe(true);
  });
  it("rejects non-uuid patientId", () => {
    expect(
      createFeedbackSchema.safeParse({ ...valid, patientId: "not-a-uuid" }).success
    ).toBe(false);
  });
  it("rejects unknown category", () => {
    expect(
      createFeedbackSchema.safeParse({ ...valid, category: "WIFI" as any }).success
    ).toBe(false);
  });
  it("rejects rating below 1", () => {
    expect(createFeedbackSchema.safeParse({ ...valid, rating: 0 }).success).toBe(false);
  });
  it("rejects rating above 5", () => {
    expect(createFeedbackSchema.safeParse({ ...valid, rating: 6 }).success).toBe(false);
  });
  it("rejects non-integer rating", () => {
    expect(createFeedbackSchema.safeParse({ ...valid, rating: 3.5 }).success).toBe(false);
  });
  it("accepts rating boundary values 1 and 5", () => {
    expect(createFeedbackSchema.safeParse({ ...valid, rating: 1 }).success).toBe(true);
    expect(createFeedbackSchema.safeParse({ ...valid, rating: 5 }).success).toBe(true);
  });
  it("accepts nps boundary values 0 and 10", () => {
    expect(createFeedbackSchema.safeParse({ ...valid, nps: 0 }).success).toBe(true);
    expect(createFeedbackSchema.safeParse({ ...valid, nps: 10 }).success).toBe(true);
  });
  it("rejects nps below 0 / above 10", () => {
    expect(createFeedbackSchema.safeParse({ ...valid, nps: -1 }).success).toBe(false);
    expect(createFeedbackSchema.safeParse({ ...valid, nps: 11 }).success).toBe(false);
  });
  it("rejects comment longer than 2000 chars", () => {
    expect(
      createFeedbackSchema.safeParse({ ...valid, comment: "x".repeat(2001) }).success
    ).toBe(false);
  });
  it("accepts comment exactly 2000 chars", () => {
    expect(
      createFeedbackSchema.safeParse({ ...valid, comment: "x".repeat(2000) }).success
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────
// COMPLAINTS — create
// ───────────────────────────────────────────────────────

describe("createComplaintSchema", () => {
  const validWithPatient = {
    patientId: UUID,
    category: "BILLING",
    description: "Charged twice for the same procedure.",
  };
  const validWalkIn = {
    name: "Anita Sharma",
    category: "CLEANLINESS",
    description: "Restroom on 2nd floor unattended for hours.",
  };
  it("accepts a complaint tied to a patient", () => {
    expect(createComplaintSchema.safeParse(validWithPatient).success).toBe(true);
  });
  it("accepts a walk-in complaint with name only", () => {
    expect(createComplaintSchema.safeParse(validWalkIn).success).toBe(true);
  });
  it("defaults priority to MEDIUM", () => {
    const r = createComplaintSchema.safeParse(validWithPatient);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.priority).toBe("MEDIUM");
  });
  it("rejects when both patientId and name are missing (Issue #577 refine)", () => {
    const r = createComplaintSchema.safeParse({
      category: "OVERALL",
      description: "x".repeat(20),
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /patientId or name is required/i.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects HTML in name (Issue #577)", () => {
    expect(
      createComplaintSchema.safeParse({
        ...validWalkIn,
        name: "<script>alert(1)</script>",
      }).success
    ).toBe(false);
  });
  it("rejects HTML in category", () => {
    expect(
      createComplaintSchema.safeParse({
        ...validWithPatient,
        category: "<b>BILLING</b>",
      }).success
    ).toBe(false);
  });
  it("rejects HTML in description", () => {
    expect(
      createComplaintSchema.safeParse({
        ...validWithPatient,
        description: "<img src=x onerror=alert(1)>",
      }).success
    ).toBe(false);
  });
  it("rejects name longer than 200 chars", () => {
    expect(
      createComplaintSchema.safeParse({
        ...validWalkIn,
        name: "A".repeat(201),
      }).success
    ).toBe(false);
  });
  it("rejects category longer than 200 chars", () => {
    expect(
      createComplaintSchema.safeParse({
        ...validWithPatient,
        category: "x".repeat(201),
      }).success
    ).toBe(false);
  });
  it("rejects description longer than 4000 chars", () => {
    expect(
      createComplaintSchema.safeParse({
        ...validWithPatient,
        description: "x".repeat(4001),
      }).success
    ).toBe(false);
  });
  it("accepts description at exactly 4000 chars", () => {
    expect(
      createComplaintSchema.safeParse({
        ...validWithPatient,
        description: "x".repeat(4000),
      }).success
    ).toBe(true);
  });
  it("rejects empty description (min 1)", () => {
    expect(
      createComplaintSchema.safeParse({
        ...validWithPatient,
        description: "",
      }).success
    ).toBe(false);
  });
  it("rejects empty category (min 1)", () => {
    expect(
      createComplaintSchema.safeParse({
        ...validWithPatient,
        category: "",
      }).success
    ).toBe(false);
  });
  it("rejects gibberish phone", () => {
    expect(
      createComplaintSchema.safeParse({
        ...validWalkIn,
        phone: "asdf",
      }).success
    ).toBe(false);
  });
  it("accepts a well-formed phone with leading +", () => {
    expect(
      createComplaintSchema.safeParse({
        ...validWalkIn,
        phone: "+91 9876543210",
      }).success
    ).toBe(true);
  });
  it("rejects non-uuid patientId", () => {
    expect(
      createComplaintSchema.safeParse({
        ...validWithPatient,
        patientId: "abc",
      }).success
    ).toBe(false);
  });
  it("rejects unknown priority", () => {
    expect(
      createComplaintSchema.safeParse({
        ...validWithPatient,
        priority: "URGENT" as any,
      }).success
    ).toBe(false);
  });
  it("accepts every documented priority", () => {
    for (const p of COMPLAINT_PRIORITIES) {
      expect(
        createComplaintSchema.safeParse({ ...validWithPatient, priority: p }).success
      ).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────
// COMPLAINTS — update + escalate
// ───────────────────────────────────────────────────────

describe("updateComplaintSchema", () => {
  it("accepts an empty patch (all fields optional)", () => {
    expect(updateComplaintSchema.safeParse({}).success).toBe(true);
  });
  it("accepts a status-only patch", () => {
    expect(updateComplaintSchema.safeParse({ status: "RESOLVED" }).success).toBe(true);
  });
  it("rejects unknown status", () => {
    expect(updateComplaintSchema.safeParse({ status: "PENDING" as any }).success).toBe(false);
  });
  it("rejects non-uuid assignedTo", () => {
    expect(updateComplaintSchema.safeParse({ assignedTo: "abc" }).success).toBe(false);
  });
  it("accepts uuid assignedTo", () => {
    expect(updateComplaintSchema.safeParse({ assignedTo: UUID }).success).toBe(true);
  });
  it("rejects HTML in resolution (Issue #577)", () => {
    const r = updateComplaintSchema.safeParse({
      status: "RESOLVED",
      resolution: "<script>alert(1)</script>",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Resolution cannot contain HTML/i.test(i.message))
      ).toBe(true);
    }
  });
  it("accepts plain-text resolution", () => {
    expect(
      updateComplaintSchema.safeParse({
        status: "RESOLVED",
        resolution: "Refund of 1200 INR issued on 2026-05-25.",
      }).success
    ).toBe(true);
  });
  it("rejects resolution longer than 4000 chars", () => {
    expect(
      updateComplaintSchema.safeParse({ resolution: "x".repeat(4001) }).success
    ).toBe(false);
  });
  it("accepts undefined resolution (refine bypass when missing)", () => {
    expect(updateComplaintSchema.safeParse({ status: "OPEN" }).success).toBe(true);
  });
  it("rejects unknown priority", () => {
    expect(updateComplaintSchema.safeParse({ priority: "MEGA" as any }).success).toBe(false);
  });
});

describe("escalateComplaintSchema", () => {
  it("accepts a plain-text reason", () => {
    expect(
      escalateComplaintSchema.safeParse({ reason: "No response after 72h." }).success
    ).toBe(true);
  });
  it("rejects empty reason", () => {
    expect(escalateComplaintSchema.safeParse({ reason: "" }).success).toBe(false);
  });
  it("rejects reason longer than 500 chars", () => {
    expect(
      escalateComplaintSchema.safeParse({ reason: "x".repeat(501) }).success
    ).toBe(false);
  });
  it("accepts reason at exactly 500 chars", () => {
    expect(
      escalateComplaintSchema.safeParse({ reason: "x".repeat(500) }).success
    ).toBe(true);
  });
  it("rejects HTML in reason (Issue #577)", () => {
    const r = escalateComplaintSchema.safeParse({
      reason: "<script>alert(1)</script>",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Reason cannot contain HTML/i.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects javascript: scheme in reason", () => {
    expect(
      escalateComplaintSchema.safeParse({ reason: "javascript:alert(1)" }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// CHAT
// ───────────────────────────────────────────────────────

describe("createChatRoomSchema", () => {
  it("accepts a minimal 1:1 room", () => {
    expect(
      createChatRoomSchema.safeParse({ participantIds: [UUID] }).success
    ).toBe(true);
  });
  it("defaults isGroup to false", () => {
    const r = createChatRoomSchema.safeParse({ participantIds: [UUID] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.isGroup).toBe(false);
  });
  it("accepts a named group room", () => {
    expect(
      createChatRoomSchema.safeParse({
        name: "Triage huddle",
        isGroup: true,
        participantIds: [UUID, UUID_2],
      }).success
    ).toBe(true);
  });
  it("rejects empty participantIds", () => {
    expect(createChatRoomSchema.safeParse({ participantIds: [] }).success).toBe(false);
  });
  it("rejects non-uuid participantId", () => {
    expect(
      createChatRoomSchema.safeParse({ participantIds: ["abc"] }).success
    ).toBe(false);
  });
});

describe("sendMessageSchema", () => {
  it("accepts a minimal text message", () => {
    expect(
      sendMessageSchema.safeParse({ roomId: UUID, content: "hi" }).success
    ).toBe(true);
  });
  it("defaults type to TEXT", () => {
    const r = sendMessageSchema.safeParse({ roomId: UUID, content: "hi" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.type).toBe("TEXT");
  });
  it("rejects empty content", () => {
    expect(sendMessageSchema.safeParse({ roomId: UUID, content: "" }).success).toBe(false);
  });
  it("rejects non-uuid roomId", () => {
    expect(sendMessageSchema.safeParse({ roomId: "no", content: "hi" }).success).toBe(false);
  });
  it("rejects unknown type", () => {
    expect(
      sendMessageSchema.safeParse({
        roomId: UUID,
        content: "hi",
        type: "VOICE" as any,
      }).success
    ).toBe(false);
  });
  it("accepts every documented type", () => {
    for (const t of MESSAGE_TYPES) {
      expect(
        sendMessageSchema.safeParse({ roomId: UUID, content: "x", type: t }).success
      ).toBe(true);
    }
  });
});

describe("messageReactionSchema", () => {
  it("accepts a single emoji", () => {
    expect(messageReactionSchema.safeParse({ emoji: "+1" }).success).toBe(true);
  });
  it("rejects empty emoji", () => {
    expect(messageReactionSchema.safeParse({ emoji: "" }).success).toBe(false);
  });
  it("rejects emoji longer than 8 chars", () => {
    expect(
      messageReactionSchema.safeParse({ emoji: "x".repeat(9) }).success
    ).toBe(false);
  });
  it("accepts emoji at exactly 8 chars", () => {
    expect(
      messageReactionSchema.safeParse({ emoji: "x".repeat(8) }).success
    ).toBe(true);
  });
});

describe("pinMessageSchema", () => {
  it("accepts pinned=true", () => {
    expect(pinMessageSchema.safeParse({ pinned: true }).success).toBe(true);
  });
  it("accepts pinned=false", () => {
    expect(pinMessageSchema.safeParse({ pinned: false }).success).toBe(true);
  });
  it("rejects non-boolean pinned", () => {
    expect(pinMessageSchema.safeParse({ pinned: "yes" as any }).success).toBe(false);
  });
  it("rejects missing pinned", () => {
    expect(pinMessageSchema.safeParse({}).success).toBe(false);
  });
});

describe("mentionMessageSchema", () => {
  it("accepts a mention with default empty mentionIds", () => {
    const r = mentionMessageSchema.safeParse({ roomId: UUID, content: "hey" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.mentionIds).toEqual([]);
  });
  it("accepts mentionIds + parentMessageId", () => {
    expect(
      mentionMessageSchema.safeParse({
        roomId: UUID,
        content: "ping",
        mentionIds: [UUID, UUID_2],
        parentMessageId: UUID,
      }).success
    ).toBe(true);
  });
  it("rejects non-uuid mentionId", () => {
    expect(
      mentionMessageSchema.safeParse({
        roomId: UUID,
        content: "x",
        mentionIds: ["not-a-uuid"],
      }).success
    ).toBe(false);
  });
  it("rejects non-uuid parentMessageId", () => {
    expect(
      mentionMessageSchema.safeParse({
        roomId: UUID,
        content: "x",
        parentMessageId: "abc",
      }).success
    ).toBe(false);
  });
  it("inherits sendMessageSchema's empty-content rejection", () => {
    expect(
      mentionMessageSchema.safeParse({ roomId: UUID, content: "" }).success
    ).toBe(false);
  });
});

describe("createChannelSchema", () => {
  it("accepts a minimal channel", () => {
    expect(
      createChannelSchema.safeParse({ name: "general", department: "OPD" }).success
    ).toBe(true);
  });
  it("defaults participantIds to []", () => {
    const r = createChannelSchema.safeParse({ name: "x", department: "y" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.participantIds).toEqual([]);
  });
  it("rejects empty name", () => {
    expect(
      createChannelSchema.safeParse({ name: "", department: "OPD" }).success
    ).toBe(false);
  });
  it("rejects empty department", () => {
    expect(
      createChannelSchema.safeParse({ name: "x", department: "" }).success
    ).toBe(false);
  });
  it("rejects non-uuid participantId", () => {
    expect(
      createChannelSchema.safeParse({
        name: "x",
        department: "y",
        participantIds: ["nope"],
      }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// VISITORS
// ───────────────────────────────────────────────────────

describe("checkinVisitorSchema", () => {
  const valid = {
    name: "Ramesh Patel",
    purpose: "PATIENT_VISIT" as const,
  };
  it("accepts a minimal visitor check-in", () => {
    expect(checkinVisitorSchema.safeParse(valid).success).toBe(true);
  });
  it("accepts a full visitor record", () => {
    expect(
      checkinVisitorSchema.safeParse({
        ...valid,
        phone: "9876543210",
        idProofType: "AADHAAR",
        idProofNumber: "1234 5678 9012",
        patientId: UUID,
        purpose: "DELIVERY",
        department: "Pharmacy",
        notes: "Picking up TPN order for inpatient.",
      }).success
    ).toBe(true);
  });
  it("rejects empty name", () => {
    expect(checkinVisitorSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });
  it("rejects name longer than 120 chars (Issue #575)", () => {
    expect(
      checkinVisitorSchema.safeParse({ ...valid, name: "A".repeat(121) }).success
    ).toBe(false);
  });
  it("accepts name at exactly 120 chars", () => {
    expect(
      checkinVisitorSchema.safeParse({ ...valid, name: "A".repeat(120) }).success
    ).toBe(true);
  });
  it("rejects gibberish phone", () => {
    expect(
      checkinVisitorSchema.safeParse({ ...valid, phone: "abcd" }).success
    ).toBe(false);
  });
  it("rejects unknown purpose", () => {
    expect(
      checkinVisitorSchema.safeParse({ ...valid, purpose: "TOUR" as any }).success
    ).toBe(false);
  });
  it("rejects non-uuid patientId", () => {
    expect(
      checkinVisitorSchema.safeParse({ ...valid, patientId: "abc" }).success
    ).toBe(false);
  });
  it("rejects idProofType longer than 40 chars", () => {
    expect(
      checkinVisitorSchema.safeParse({ ...valid, idProofType: "x".repeat(41) }).success
    ).toBe(false);
  });
  it("rejects idProofNumber longer than 60 chars", () => {
    expect(
      checkinVisitorSchema.safeParse({ ...valid, idProofNumber: "x".repeat(61) }).success
    ).toBe(false);
  });
  it("rejects department longer than 120 chars", () => {
    expect(
      checkinVisitorSchema.safeParse({ ...valid, department: "x".repeat(121) }).success
    ).toBe(false);
  });
  it("rejects notes longer than 2000 chars", () => {
    expect(
      checkinVisitorSchema.safeParse({ ...valid, notes: "x".repeat(2001) }).success
    ).toBe(false);
  });
});

describe("visitorBlacklistSchema", () => {
  it("accepts blacklist row keyed by phone", () => {
    expect(
      visitorBlacklistSchema.safeParse({
        phone: "9876543210",
        reason: "Caught attempting to access ward without permission.",
      }).success
    ).toBe(true);
  });
  it("accepts blacklist row keyed by idProofNumber", () => {
    expect(
      visitorBlacklistSchema.safeParse({
        idProofNumber: "AB-9988",
        reason: "Verbal abuse to reception.",
      }).success
    ).toBe(true);
  });
  it("accepts blacklist row keyed by name", () => {
    expect(
      visitorBlacklistSchema.safeParse({
        name: "Unknown loiterer",
        reason: "Repeat trespass.",
      }).success
    ).toBe(true);
  });
  it("rejects when NO identifier supplied (refine)", () => {
    const r = visitorBlacklistSchema.safeParse({ reason: "x" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) =>
          /At least one identifier/i.test(i.message)
        )
      ).toBe(true);
    }
  });
  it("rejects empty reason", () => {
    expect(
      visitorBlacklistSchema.safeParse({ phone: "9876543210", reason: "" }).success
    ).toBe(false);
  });
  it("rejects reason longer than 2000 chars", () => {
    expect(
      visitorBlacklistSchema.safeParse({
        phone: "9876543210",
        reason: "x".repeat(2001),
      }).success
    ).toBe(false);
  });
  it("rejects gibberish phone shape", () => {
    expect(
      visitorBlacklistSchema.safeParse({ phone: "abc", reason: "x" }).success
    ).toBe(false);
  });
});

describe("visitorPhotoSchema", () => {
  it("accepts a non-empty photoUrl", () => {
    expect(
      visitorPhotoSchema.safeParse({
        photoUrl: "https://cdn.example.com/v/123.jpg",
      }).success
    ).toBe(true);
  });
  it("rejects empty photoUrl", () => {
    expect(visitorPhotoSchema.safeParse({ photoUrl: "" }).success).toBe(false);
  });
  it("rejects missing photoUrl", () => {
    expect(visitorPhotoSchema.safeParse({}).success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// NOTIFICATIONS
// ───────────────────────────────────────────────────────

describe("feedbackRequestSchema", () => {
  it("accepts a minimal request (defaults channel=SMS)", () => {
    const r = feedbackRequestSchema.safeParse({ patientId: UUID });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.channel).toBe("SMS");
  });
  it("accepts an EMAIL channel", () => {
    expect(
      feedbackRequestSchema.safeParse({ patientId: UUID, channel: "EMAIL" }).success
    ).toBe(true);
  });
  it("accepts a WHATSAPP channel", () => {
    expect(
      feedbackRequestSchema.safeParse({ patientId: UUID, channel: "WHATSAPP" }).success
    ).toBe(true);
  });
  it("rejects unknown channel", () => {
    expect(
      feedbackRequestSchema.safeParse({ patientId: UUID, channel: "FAX" as any })
        .success
    ).toBe(false);
  });
  it("rejects non-uuid patientId", () => {
    expect(feedbackRequestSchema.safeParse({ patientId: "abc" }).success).toBe(false);
  });
});

describe("notificationTemplateSchema", () => {
  const valid = {
    type: "APPOINTMENT_REMINDER",
    channel: "SMS" as const,
    name: "appt-24h",
    body: "Reminder: your appointment is tomorrow at {{time}}.",
  };
  it("accepts a minimal template (default isActive=true)", () => {
    const r = notificationTemplateSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.isActive).toBe(true);
  });
  it("accepts every channel", () => {
    for (const ch of ["WHATSAPP", "SMS", "EMAIL", "PUSH"] as const) {
      expect(
        notificationTemplateSchema.safeParse({ ...valid, channel: ch }).success
      ).toBe(true);
    }
  });
  it("rejects unknown channel", () => {
    expect(
      notificationTemplateSchema.safeParse({ ...valid, channel: "FAX" as any }).success
    ).toBe(false);
  });
  it("rejects empty type", () => {
    expect(notificationTemplateSchema.safeParse({ ...valid, type: "" }).success).toBe(false);
  });
  it("rejects empty name", () => {
    expect(notificationTemplateSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });
  it("rejects empty body", () => {
    expect(notificationTemplateSchema.safeParse({ ...valid, body: "" }).success).toBe(false);
  });
  it("accepts an optional subject", () => {
    expect(
      notificationTemplateSchema.safeParse({ ...valid, subject: "Reminder" }).success
    ).toBe(true);
  });
  it("accepts isActive=false override", () => {
    const r = notificationTemplateSchema.safeParse({ ...valid, isActive: false });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.isActive).toBe(false);
  });
});

describe("notificationScheduleSchema", () => {
  it("accepts an empty schedule (all optional)", () => {
    expect(notificationScheduleSchema.safeParse({}).success).toBe(true);
  });
  it("accepts a valid HH:MM quiet-hours window", () => {
    expect(
      notificationScheduleSchema.safeParse({
        quietHoursStart: "22:00",
        quietHoursEnd: "07:00",
      }).success
    ).toBe(true);
  });
  it("rejects malformed quietHoursStart (no leading zero)", () => {
    expect(
      notificationScheduleSchema.safeParse({ quietHoursStart: "9:00" }).success
    ).toBe(false);
  });
  it("rejects garbage quietHoursEnd", () => {
    expect(
      notificationScheduleSchema.safeParse({ quietHoursEnd: "morning" }).success
    ).toBe(false);
  });
  it("accepts an arbitrary dndUntil string", () => {
    expect(
      notificationScheduleSchema.safeParse({ dndUntil: "2026-05-25T18:00:00Z" }).success
    ).toBe(true);
  });
});

describe("notificationBroadcastSchema", () => {
  const valid = {
    title: "System maintenance",
    message: "EHR will be offline 02:00-03:00 IST.",
    audience: { roles: ["DOCTOR", "NURSE"] },
  };
  it("accepts a minimal broadcast (default channels=[PUSH])", () => {
    const r = notificationBroadcastSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.channels).toEqual(["PUSH"]);
  });
  it("accepts audience keyed by userIds", () => {
    expect(
      notificationBroadcastSchema.safeParse({
        ...valid,
        audience: { userIds: [UUID, UUID_2] },
      }).success
    ).toBe(true);
  });
  it("accepts both audience legs simultaneously", () => {
    expect(
      notificationBroadcastSchema.safeParse({
        ...valid,
        audience: { roles: ["DOCTOR"], userIds: [UUID] },
      }).success
    ).toBe(true);
  });
  it("accepts a fully empty audience object (both fields optional)", () => {
    expect(
      notificationBroadcastSchema.safeParse({ ...valid, audience: {} }).success
    ).toBe(true);
  });
  it("rejects non-uuid userIds entry", () => {
    expect(
      notificationBroadcastSchema.safeParse({
        ...valid,
        audience: { userIds: ["abc"] },
      }).success
    ).toBe(false);
  });
  it("rejects empty title / message", () => {
    expect(
      notificationBroadcastSchema.safeParse({ ...valid, title: "" }).success
    ).toBe(false);
    expect(
      notificationBroadcastSchema.safeParse({ ...valid, message: "" }).success
    ).toBe(false);
  });
  it("rejects unknown channel", () => {
    expect(
      notificationBroadcastSchema.safeParse({
        ...valid,
        channels: ["FAX" as any],
      }).success
    ).toBe(false);
  });
  it("accepts a multi-channel broadcast", () => {
    expect(
      notificationBroadcastSchema.safeParse({
        ...valid,
        channels: ["PUSH", "SMS", "EMAIL", "WHATSAPP"],
      }).success
    ).toBe(true);
  });
  it("rejects missing audience field", () => {
    expect(
      notificationBroadcastSchema.safeParse({
        title: "x",
        message: "y",
      } as any).success
    ).toBe(false);
  });
});
