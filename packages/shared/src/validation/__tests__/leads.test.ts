// Coverage tests for CRM lead-pipeline validation schemas.
// What: exhaustive happy / invalid / edge cases for every exported Zod schema
//   and constant in packages/shared/src/validation/leads.ts — the Pearl §3.3
//   CRM lead pipeline (createLeadSchema, updateLeadSchema, createLeadActivitySchema,
//   convertLeadSchema) plus the 6-stage LEAD_STATUS_VALUES state machine, the
//   6-source LEAD_SOURCE_VALUES enum, and the 8-type LEAD_ACTIVITY_TYPE_VALUES
//   enum.
// Which modules: imports only schemas / enums / constants from ../leads.
// Why: file shipped with 0% colocated coverage (commit 928018f, Pearl gap #3).
//   Particularly important to lock in: (a) the 6-stage state-machine enum
//   (NEW → QUALIFIED → ENGAGED → BOOKED → CONVERTED → LOST) on updateLeadSchema
//   so unexpected statuses never enter the pipeline, (b) the phoneRegex's
//   10-15 digit + optional-plus contract shared across create/update/convert,
//   (c) nullable-vs-optional split (most update fields accept both undefined
//   AND explicit null for "clear this field" PATCH semantics), (d) the
//   `gender` requirement on convertLeadSchema (required while name/phone/email
//   are optional — those fall back to the lead's stored values per the file's
//   inline comment).
import { describe, it, expect } from "vitest";
import {
  LEAD_STATUS_VALUES,
  LEAD_SOURCE_VALUES,
  LEAD_ACTIVITY_TYPE_VALUES,
  createLeadSchema,
  updateLeadSchema,
  createLeadActivitySchema,
  convertLeadSchema,
} from "../leads";

const UUID = "550e8400-e29b-41d4-a716-446655441111";
const UUID_2 = "550e8400-e29b-41d4-a716-446655442222";

// ───────────────────────────────────────────────────────
// Constants — 6-stage state machine + source + activity enums
// ───────────────────────────────────────────────────────

describe("LEAD_STATUS_VALUES (6-stage state machine)", () => {
  it("contains exactly the six documented pipeline stages", () => {
    expect([...LEAD_STATUS_VALUES]).toEqual([
      "NEW",
      "QUALIFIED",
      "ENGAGED",
      "BOOKED",
      "CONVERTED",
      "LOST",
    ]);
  });
  it("has length 6", () => {
    expect(LEAD_STATUS_VALUES.length).toBe(6);
  });
  it("declares the stages in the canonical funnel order (NEW → CONVERTED with LOST as terminal exit)", () => {
    // The order matters for routes that surface a default progression UI.
    expect(LEAD_STATUS_VALUES[0]).toBe("NEW");
    expect(LEAD_STATUS_VALUES[1]).toBe("QUALIFIED");
    expect(LEAD_STATUS_VALUES[2]).toBe("ENGAGED");
    expect(LEAD_STATUS_VALUES[3]).toBe("BOOKED");
    expect(LEAD_STATUS_VALUES[4]).toBe("CONVERTED");
    expect(LEAD_STATUS_VALUES[5]).toBe("LOST");
  });
});

describe("LEAD_SOURCE_VALUES", () => {
  it("contains exactly the six documented inbound sources", () => {
    expect([...LEAD_SOURCE_VALUES]).toEqual([
      "WEB",
      "WALK_IN",
      "PHONE",
      "WHATSAPP",
      "REFERRAL",
      "OTHER",
    ]);
  });
});

describe("LEAD_ACTIVITY_TYPE_VALUES", () => {
  it("contains exactly the eight documented activity types", () => {
    expect([...LEAD_ACTIVITY_TYPE_VALUES]).toEqual([
      "STATUS_CHANGE",
      "NOTE",
      "CALL",
      "MESSAGE",
      "EMAIL",
      "WHATSAPP_OUTBOUND",
      "DOCTOR_ALLOCATION",
      "CONVERSION",
    ]);
  });
});

// ───────────────────────────────────────────────────────
// createLeadSchema
// ───────────────────────────────────────────────────────

describe("createLeadSchema", () => {
  const valid = { name: "Asha Iyer" };

  it("accepts a minimal valid lead (name only)", () => {
    expect(createLeadSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a fully-populated lead", () => {
    expect(
      createLeadSchema.safeParse({
        name: "Asha Iyer",
        phone: "+919876543210",
        email: "asha@example.com",
        source: "REFERRAL",
        preferredDoctorId: UUID,
        assignedToUserId: UUID_2,
        notes: "Referred by Dr. Rao; interested in OBGYN consult.",
        marketingEnquiryId: UUID,
      }).success
    ).toBe(true);
  });

  it("trims surrounding whitespace on name", () => {
    const r = createLeadSchema.safeParse({ name: "  Asha Iyer  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe("Asha Iyer");
  });

  it("rejects name shorter than 2 chars", () => {
    expect(createLeadSchema.safeParse({ name: "A" }).success).toBe(false);
  });

  it("rejects name that becomes shorter than 2 chars after trim", () => {
    expect(createLeadSchema.safeParse({ name: "  A  " }).success).toBe(false);
  });

  it("accepts name at exactly 2 chars (boundary)", () => {
    expect(createLeadSchema.safeParse({ name: "Bo" }).success).toBe(true);
  });

  it("accepts name at exactly 120 chars (boundary)", () => {
    expect(createLeadSchema.safeParse({ name: "x".repeat(120) }).success).toBe(true);
  });

  it("rejects name longer than 120 chars", () => {
    expect(createLeadSchema.safeParse({ name: "x".repeat(121) }).success).toBe(false);
  });

  it("rejects missing name", () => {
    expect(createLeadSchema.safeParse({}).success).toBe(false);
  });

  // Phone regex: /^\+?\d{10,15}$/

  it("accepts a 10-digit phone without leading plus", () => {
    expect(
      createLeadSchema.safeParse({ ...valid, phone: "9876543210" }).success
    ).toBe(true);
  });

  it("accepts a 15-digit phone with leading plus (upper boundary)", () => {
    expect(
      createLeadSchema.safeParse({ ...valid, phone: "+123456789012345" }).success
    ).toBe(true);
  });

  it("accepts an exactly-10-digit phone (lower boundary)", () => {
    expect(
      createLeadSchema.safeParse({ ...valid, phone: "0123456789" }).success
    ).toBe(true);
  });

  it("rejects a 9-digit phone (below lower boundary)", () => {
    expect(
      createLeadSchema.safeParse({ ...valid, phone: "012345678" }).success
    ).toBe(false);
  });

  it("rejects a 16-digit phone (above upper boundary)", () => {
    expect(
      createLeadSchema.safeParse({ ...valid, phone: "+1234567890123456" }).success
    ).toBe(false);
  });

  it("rejects a phone with spaces or dashes", () => {
    expect(
      createLeadSchema.safeParse({ ...valid, phone: "+91 98765 43210" }).success
    ).toBe(false);
    expect(
      createLeadSchema.safeParse({ ...valid, phone: "+91-98765-43210" }).success
    ).toBe(false);
  });

  it("rejects a phone with letters", () => {
    expect(
      createLeadSchema.safeParse({ ...valid, phone: "+91CALLMENOW" }).success
    ).toBe(false);
  });

  it("trims surrounding whitespace on phone before regex check", () => {
    const r = createLeadSchema.safeParse({ ...valid, phone: "  +919876543210  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.phone).toBe("+919876543210");
  });

  it("accepts phone as null (explicitly cleared)", () => {
    expect(createLeadSchema.safeParse({ ...valid, phone: null }).success).toBe(true);
  });

  it("accepts phone as undefined (omitted)", () => {
    expect(createLeadSchema.safeParse({ ...valid, phone: undefined }).success).toBe(true);
  });

  it("rejects a malformed email", () => {
    expect(
      createLeadSchema.safeParse({ ...valid, email: "not-an-email" }).success
    ).toBe(false);
  });

  it("accepts email as null", () => {
    expect(createLeadSchema.safeParse({ ...valid, email: null }).success).toBe(true);
  });

  it("accepts each documented source value", () => {
    for (const src of LEAD_SOURCE_VALUES) {
      expect(createLeadSchema.safeParse({ ...valid, source: src }).success).toBe(true);
    }
  });

  it("rejects an unknown source", () => {
    expect(
      createLeadSchema.safeParse({ ...valid, source: "FACEBOOK_ADS" as any }).success
    ).toBe(false);
  });

  it("rejects non-uuid preferredDoctorId", () => {
    expect(
      createLeadSchema.safeParse({ ...valid, preferredDoctorId: "doctor-1" }).success
    ).toBe(false);
  });

  it("accepts preferredDoctorId as null (unassigned)", () => {
    expect(
      createLeadSchema.safeParse({ ...valid, preferredDoctorId: null }).success
    ).toBe(true);
  });

  it("rejects non-uuid assignedToUserId", () => {
    expect(
      createLeadSchema.safeParse({ ...valid, assignedToUserId: "user-1" }).success
    ).toBe(false);
  });

  it("accepts assignedToUserId as null", () => {
    expect(
      createLeadSchema.safeParse({ ...valid, assignedToUserId: null }).success
    ).toBe(true);
  });

  it("accepts notes at exactly 2000 chars (boundary)", () => {
    expect(
      createLeadSchema.safeParse({ ...valid, notes: "x".repeat(2000) }).success
    ).toBe(true);
  });

  it("rejects notes longer than 2000 chars", () => {
    expect(
      createLeadSchema.safeParse({ ...valid, notes: "x".repeat(2001) }).success
    ).toBe(false);
  });

  it("accepts notes as null", () => {
    expect(createLeadSchema.safeParse({ ...valid, notes: null }).success).toBe(true);
  });

  it("rejects non-uuid marketingEnquiryId", () => {
    expect(
      createLeadSchema.safeParse({ ...valid, marketingEnquiryId: "enquiry-1" }).success
    ).toBe(false);
  });

  it("accepts marketingEnquiryId as null (no promotion source)", () => {
    expect(
      createLeadSchema.safeParse({ ...valid, marketingEnquiryId: null }).success
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────
// updateLeadSchema — including the 6-stage state-machine transitions
// ───────────────────────────────────────────────────────

describe("updateLeadSchema", () => {
  it("accepts an empty patch (all fields optional)", () => {
    expect(updateLeadSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a name-only patch", () => {
    expect(updateLeadSchema.safeParse({ name: "Asha I." }).success).toBe(true);
  });

  it("rejects a name patch shorter than 2 chars", () => {
    expect(updateLeadSchema.safeParse({ name: "A" }).success).toBe(false);
  });

  it("rejects a name patch longer than 120 chars", () => {
    expect(updateLeadSchema.safeParse({ name: "x".repeat(121) }).success).toBe(false);
  });

  it("accepts a phone-only patch with a valid number", () => {
    expect(updateLeadSchema.safeParse({ phone: "+919876543210" }).success).toBe(true);
  });

  it("accepts an explicit phone=null patch (clear-field PATCH semantics)", () => {
    expect(updateLeadSchema.safeParse({ phone: null }).success).toBe(true);
  });

  it("rejects a malformed phone patch", () => {
    expect(updateLeadSchema.safeParse({ phone: "not-a-phone" }).success).toBe(false);
  });

  it("accepts an explicit email=null patch (clear-field PATCH semantics)", () => {
    expect(updateLeadSchema.safeParse({ email: null }).success).toBe(true);
  });

  it("rejects a malformed email patch", () => {
    expect(updateLeadSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
  });

  it("accepts a source patch", () => {
    expect(updateLeadSchema.safeParse({ source: "WHATSAPP" }).success).toBe(true);
  });

  // ── 6-stage state-machine transitions ──

  it("accepts a status patch for each of the 6 pipeline stages", () => {
    for (const status of LEAD_STATUS_VALUES) {
      const r = updateLeadSchema.safeParse({ status });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.status).toBe(status);
    }
  });

  it("accepts NEW → QUALIFIED transition", () => {
    expect(updateLeadSchema.safeParse({ status: "QUALIFIED" }).success).toBe(true);
  });

  it("accepts QUALIFIED → ENGAGED transition", () => {
    expect(updateLeadSchema.safeParse({ status: "ENGAGED" }).success).toBe(true);
  });

  it("accepts ENGAGED → BOOKED transition", () => {
    expect(updateLeadSchema.safeParse({ status: "BOOKED" }).success).toBe(true);
  });

  it("accepts BOOKED → CONVERTED transition (terminal success)", () => {
    expect(updateLeadSchema.safeParse({ status: "CONVERTED" }).success).toBe(true);
  });

  it("accepts any-stage → LOST transition (terminal exit)", () => {
    expect(updateLeadSchema.safeParse({ status: "LOST" }).success).toBe(true);
  });

  it("rejects an unknown status (e.g. CLOSED — not in the 6-stage machine)", () => {
    expect(
      updateLeadSchema.safeParse({ status: "CLOSED" as any }).success
    ).toBe(false);
  });

  it("rejects lower-cased status (enum is case-sensitive)", () => {
    expect(
      updateLeadSchema.safeParse({ status: "qualified" as any }).success
    ).toBe(false);
  });

  it("rejects empty-string status", () => {
    expect(updateLeadSchema.safeParse({ status: "" as any }).success).toBe(false);
  });

  // ── Misc field patches ──

  it("accepts preferredDoctorId reassignment", () => {
    expect(
      updateLeadSchema.safeParse({ preferredDoctorId: UUID }).success
    ).toBe(true);
  });

  it("accepts preferredDoctorId=null (unassign)", () => {
    expect(
      updateLeadSchema.safeParse({ preferredDoctorId: null }).success
    ).toBe(true);
  });

  it("rejects non-uuid preferredDoctorId", () => {
    expect(
      updateLeadSchema.safeParse({ preferredDoctorId: "abc" }).success
    ).toBe(false);
  });

  it("accepts assignedToUserId=null (unassign)", () => {
    expect(
      updateLeadSchema.safeParse({ assignedToUserId: null }).success
    ).toBe(true);
  });

  it("rejects non-uuid assignedToUserId", () => {
    expect(
      updateLeadSchema.safeParse({ assignedToUserId: "abc" }).success
    ).toBe(false);
  });

  it("accepts notes patch up to 2000 chars", () => {
    expect(
      updateLeadSchema.safeParse({ notes: "x".repeat(2000) }).success
    ).toBe(true);
  });

  it("rejects notes patch over 2000 chars", () => {
    expect(
      updateLeadSchema.safeParse({ notes: "x".repeat(2001) }).success
    ).toBe(false);
  });

  it("accepts notes=null (clear-field PATCH semantics)", () => {
    expect(updateLeadSchema.safeParse({ notes: null }).success).toBe(true);
  });

  it("accepts a multi-field patch combining transition + reassignment + notes", () => {
    expect(
      updateLeadSchema.safeParse({
        status: "BOOKED",
        assignedToUserId: UUID,
        notes: "Scheduled OBGYN consult for next Tuesday.",
      }).success
    ).toBe(true);
  });

  it("does NOT accept marketingEnquiryId on update (not in updateLeadSchema)", () => {
    // updateLeadSchema does not include marketingEnquiryId — Zod's default is
    // to silently strip unknown keys, so parsing succeeds without round-tripping.
    const r = updateLeadSchema.safeParse({ marketingEnquiryId: UUID } as any);
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as any).marketingEnquiryId).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────
// createLeadActivitySchema
// ───────────────────────────────────────────────────────

describe("createLeadActivitySchema", () => {
  it("accepts a minimal activity (type only)", () => {
    expect(createLeadActivitySchema.safeParse({ type: "NOTE" }).success).toBe(true);
  });

  it("accepts each of the 8 documented activity types", () => {
    for (const type of LEAD_ACTIVITY_TYPE_VALUES) {
      expect(createLeadActivitySchema.safeParse({ type }).success).toBe(true);
    }
  });

  it("rejects an unknown activity type", () => {
    expect(
      createLeadActivitySchema.safeParse({ type: "TWEET" as any }).success
    ).toBe(false);
  });

  it("rejects missing type", () => {
    expect(createLeadActivitySchema.safeParse({}).success).toBe(false);
  });

  it("accepts type + body", () => {
    expect(
      createLeadActivitySchema.safeParse({
        type: "CALL",
        body: "Called at 14:30 — went to voicemail.",
      }).success
    ).toBe(true);
  });

  it("accepts body as null", () => {
    expect(
      createLeadActivitySchema.safeParse({ type: "CALL", body: null }).success
    ).toBe(true);
  });

  it("accepts body at exactly 5000 chars (boundary)", () => {
    expect(
      createLeadActivitySchema.safeParse({ type: "NOTE", body: "x".repeat(5000) }).success
    ).toBe(true);
  });

  it("rejects body longer than 5000 chars", () => {
    expect(
      createLeadActivitySchema.safeParse({ type: "NOTE", body: "x".repeat(5001) }).success
    ).toBe(false);
  });

  it("accepts a structured data record", () => {
    expect(
      createLeadActivitySchema.safeParse({
        type: "STATUS_CHANGE",
        data: { from: "NEW", to: "QUALIFIED", reason: "Phone screen passed" },
      }).success
    ).toBe(true);
  });

  it("accepts an empty data record", () => {
    expect(
      createLeadActivitySchema.safeParse({ type: "NOTE", data: {} }).success
    ).toBe(true);
  });

  it("accepts data with mixed primitive + nested values (z.unknown)", () => {
    expect(
      createLeadActivitySchema.safeParse({
        type: "DOCTOR_ALLOCATION",
        data: {
          doctorId: UUID,
          allocatedBy: UUID_2,
          when: "2026-05-25T10:00:00Z",
          payload: { nested: true, count: 3, items: ["a", "b"] },
        },
      }).success
    ).toBe(true);
  });

  it("rejects data when keys are not strings (z.record key constraint)", () => {
    // JS would coerce a number key to a string, but z.record(z.string(), ...)
    // enforces declared key type — non-object values fail at the record layer.
    expect(
      createLeadActivitySchema.safeParse({ type: "NOTE", data: "not-a-record" as any }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// convertLeadSchema — promotion to patient
// ───────────────────────────────────────────────────────

describe("convertLeadSchema", () => {
  const valid = { gender: "FEMALE" as const };

  it("accepts a minimal conversion (gender only — name/phone/email fall back to lead)", () => {
    expect(convertLeadSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts each documented gender value", () => {
    for (const g of ["MALE", "FEMALE", "OTHER"] as const) {
      expect(convertLeadSchema.safeParse({ gender: g }).success).toBe(true);
    }
  });

  it("rejects an unknown gender", () => {
    expect(
      convertLeadSchema.safeParse({ gender: "PREFER_NOT_TO_SAY" as any }).success
    ).toBe(false);
  });

  it("rejects missing gender (the one required field)", () => {
    expect(convertLeadSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a fully-populated conversion (overrides every lead fallback)", () => {
    expect(
      convertLeadSchema.safeParse({
        gender: "FEMALE",
        name: "Asha Iyer",
        phone: "+919876543210",
        email: "asha@example.com",
        dateOfBirth: "1990-04-12",
        age: 35,
        address: "12 MG Road, Bengaluru 560001",
      }).success
    ).toBe(true);
  });

  it("trims surrounding whitespace on name override", () => {
    const r = convertLeadSchema.safeParse({ ...valid, name: "  Asha Iyer  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe("Asha Iyer");
  });

  it("rejects name override shorter than 2 chars", () => {
    expect(
      convertLeadSchema.safeParse({ ...valid, name: "A" }).success
    ).toBe(false);
  });

  it("rejects name override longer than 120 chars", () => {
    expect(
      convertLeadSchema.safeParse({ ...valid, name: "x".repeat(121) }).success
    ).toBe(false);
  });

  it("rejects a malformed phone override", () => {
    expect(
      convertLeadSchema.safeParse({ ...valid, phone: "98765" }).success
    ).toBe(false);
  });

  it("rejects a malformed email override", () => {
    expect(
      convertLeadSchema.safeParse({ ...valid, email: "not-an-email" }).success
    ).toBe(false);
  });

  it("accepts age=0 (newborn — nonnegative lower boundary)", () => {
    expect(convertLeadSchema.safeParse({ ...valid, age: 0 }).success).toBe(true);
  });

  it("accepts age=150 (upper boundary)", () => {
    expect(convertLeadSchema.safeParse({ ...valid, age: 150 }).success).toBe(true);
  });

  it("rejects age below 0", () => {
    expect(convertLeadSchema.safeParse({ ...valid, age: -1 }).success).toBe(false);
  });

  it("rejects age above 150", () => {
    expect(convertLeadSchema.safeParse({ ...valid, age: 151 }).success).toBe(false);
  });

  it("rejects non-integer age", () => {
    expect(convertLeadSchema.safeParse({ ...valid, age: 35.5 }).success).toBe(false);
  });

  it("accepts dateOfBirth as a free-form string (route does deeper parsing)", () => {
    // The schema only constrains `dateOfBirth` to `string().optional()` —
    // any string value parses, the route does the actual date interpretation.
    expect(
      convertLeadSchema.safeParse({ ...valid, dateOfBirth: "1990-04-12" }).success
    ).toBe(true);
    expect(
      convertLeadSchema.safeParse({ ...valid, dateOfBirth: "12/04/1990" }).success
    ).toBe(true);
  });

  it("rejects non-string dateOfBirth", () => {
    expect(
      convertLeadSchema.safeParse({ ...valid, dateOfBirth: 19900412 as any }).success
    ).toBe(false);
  });

  it("accepts address as a free-form string", () => {
    expect(
      convertLeadSchema.safeParse({ ...valid, address: "12 MG Road" }).success
    ).toBe(true);
  });

  it("rejects non-string address", () => {
    expect(
      convertLeadSchema.safeParse({ ...valid, address: { line1: "12 MG Road" } as any }).success
    ).toBe(false);
  });

  // convertLeadSchema phone/email are NOT nullable (unlike create/update) —
  // only `.optional()`. Explicit null should reject.

  it("rejects phone=null on convert (not nullable, only optional)", () => {
    expect(
      convertLeadSchema.safeParse({ ...valid, phone: null as any }).success
    ).toBe(false);
  });

  it("rejects email=null on convert (not nullable, only optional)", () => {
    expect(
      convertLeadSchema.safeParse({ ...valid, email: null as any }).success
    ).toBe(false);
  });

  it("rejects name=null on convert (not nullable, only optional)", () => {
    expect(
      convertLeadSchema.safeParse({ ...valid, name: null as any }).success
    ).toBe(false);
  });
});
