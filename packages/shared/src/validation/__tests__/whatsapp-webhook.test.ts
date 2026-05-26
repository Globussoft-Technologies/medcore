// Coverage tests for the normalized inbound-WhatsApp webhook schema.
// What: exhaustive happy / invalid / edge cases for normalizedInboundMessageSchema
//   exported from packages/shared/src/validation/whatsapp-webhook.ts — the
//   single uniform shape that per-provider parsers (Gupshup / Wati / AiSensei /
//   Interakt / Meta Cloud API) emit before the webhook route persists a
//   WhatsAppMessage row.
// Which modules: imports only the schema + inferred type from
//   ../whatsapp-webhook. No DB, no Express, no provider parsers.
// Why: file shipped with 0% colocated coverage (Pearl §6.1 gap row 167,
//   piece 3j-ii — commit f4710c1). The schema is the LAST line of defense
//   between a drifted provider payload and a half-baked DB row; locking the
//   E.164 regex (+<7-15 digits>), the 8192-char body cap, the URL-shape on
//   mediaUrl, the trim+min(1) on providerMessageId, and the Date-instance
//   requirement on sentAt guards against silent regressions if a future
//   refactor relaxes any field.
import { describe, it, expect } from "vitest";
import {
  normalizedInboundMessageSchema,
  type NormalizedInboundMessage,
} from "../whatsapp-webhook";

// A canonical valid payload reused as the base across nearly every test.
const validBase = {
  phone: "+919876543210",
  body: "Hello doctor, can I reschedule my appointment?",
  mediaUrl: "https://cdn.gupshup.io/wa/abc.jpg",
  providerMessageId: "gs_msg_abc123",
  sentAt: new Date("2026-05-24T10:30:00.000Z"),
};

// ───────────────────────────────────────────────────────
// Happy path
// ───────────────────────────────────────────────────────

describe("normalizedInboundMessageSchema — happy paths", () => {
  it("accepts a fully-populated payload", () => {
    const r = normalizedInboundMessageSchema.safeParse(validBase);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.phone).toBe("+919876543210");
      expect(r.data.body).toBe(
        "Hello doctor, can I reschedule my appointment?"
      );
      expect(r.data.mediaUrl).toBe("https://cdn.gupshup.io/wa/abc.jpg");
      expect(r.data.providerMessageId).toBe("gs_msg_abc123");
      expect(r.data.sentAt).toBeInstanceOf(Date);
    }
  });

  it("accepts a minimal payload (mediaUrl + providerMessageId omitted)", () => {
    const { mediaUrl: _m, providerMessageId: _p, ...minimal } = validBase;
    const r = normalizedInboundMessageSchema.safeParse(minimal);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.mediaUrl).toBeUndefined();
      expect(r.data.providerMessageId).toBeUndefined();
    }
  });

  it("accepts mediaUrl = null (nullable)", () => {
    const r = normalizedInboundMessageSchema.safeParse({
      ...validBase,
      mediaUrl: null,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.mediaUrl).toBeNull();
  });

  it("accepts providerMessageId = null (nullable)", () => {
    const r = normalizedInboundMessageSchema.safeParse({
      ...validBase,
      providerMessageId: null,
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.providerMessageId).toBeNull();
  });

  it("accepts media-only message (empty body string + non-null mediaUrl)", () => {
    // The source comment explicitly calls this out as the media-only shape.
    const r = normalizedInboundMessageSchema.safeParse({
      ...validBase,
      body: "",
      mediaUrl: "https://cdn.example.com/audio/voice.ogg",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.body).toBe("");
      expect(r.data.mediaUrl).toBe("https://cdn.example.com/audio/voice.ogg");
    }
  });

  it("infers the NormalizedInboundMessage type with the expected fields", () => {
    // Compile-time assertion via assignment: if the type drifts, this stops
    // type-checking. Runtime assertion is incidental.
    const sample: NormalizedInboundMessage = {
      phone: "+15551234567",
      body: "hi",
      mediaUrl: null,
      providerMessageId: null,
      sentAt: new Date(),
    };
    expect(sample.phone).toBe("+15551234567");
  });
});

// ───────────────────────────────────────────────────────
// phone — canonical E.164 regex
// ───────────────────────────────────────────────────────

describe("normalizedInboundMessageSchema — phone field", () => {
  it("accepts E.164 with min 7 digits", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        phone: "+1234567",
      }).success
    ).toBe(true);
  });

  it("accepts E.164 with max 15 digits", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        phone: "+123456789012345",
      }).success
    ).toBe(true);
  });

  it("trims surrounding whitespace before regex check", () => {
    const r = normalizedInboundMessageSchema.safeParse({
      ...validBase,
      phone: "  +919876543210  ",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.phone).toBe("+919876543210");
  });

  it("rejects phone with fewer than 7 digits", () => {
    const r = normalizedInboundMessageSchema.safeParse({
      ...validBase,
      phone: "+123456",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) =>
          /phone must be canonical E\.164/.test(i.message)
        )
      ).toBe(true);
    }
  });

  it("rejects phone with more than 15 digits", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        phone: "+1234567890123456",
      }).success
    ).toBe(false);
  });

  it("rejects phone missing the leading +", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        phone: "919876543210",
      }).success
    ).toBe(false);
  });

  it("rejects phone with provider prefix (whatsapp:+91...)", () => {
    // The source comment says the parser strips these BEFORE validation;
    // they MUST fail validation if they leak through.
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        phone: "whatsapp:+919876543210",
      }).success
    ).toBe(false);
  });

  it("rejects phone with non-digit chars after +", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        phone: "+91-987-654-3210",
      }).success
    ).toBe(false);
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        phone: "+91 9876543210",
      }).success
    ).toBe(false);
  });

  it("rejects empty phone", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({ ...validBase, phone: "" })
        .success
    ).toBe(false);
  });

  it("rejects whitespace-only phone (trim then empty)", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        phone: "   ",
      }).success
    ).toBe(false);
  });

  it("rejects missing phone field", () => {
    const { phone: _p, ...rest } = validBase;
    expect(normalizedInboundMessageSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects non-string phone", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        phone: 919876543210 as any,
      }).success
    ).toBe(false);
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        phone: null as any,
      }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// body — string with 8192 char cap
// ───────────────────────────────────────────────────────

describe("normalizedInboundMessageSchema — body field", () => {
  it("accepts empty body", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({ ...validBase, body: "" })
        .success
    ).toBe(true);
  });

  it("accepts body at exactly 8192 chars", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        body: "x".repeat(8192),
      }).success
    ).toBe(true);
  });

  it("rejects body longer than 8192 chars", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        body: "x".repeat(8193),
      }).success
    ).toBe(false);
  });

  it("accepts unicode body (emoji, Devanagari, RTL)", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        body: "नमस्ते 🙏 मرحبا",
      }).success
    ).toBe(true);
  });

  it("rejects missing body field", () => {
    const { body: _b, ...rest } = validBase;
    expect(normalizedInboundMessageSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects non-string body", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        body: 123 as any,
      }).success
    ).toBe(false);
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        body: null as any,
      }).success
    ).toBe(false);
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        body: { text: "hi" } as any,
      }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// mediaUrl — optional + nullable URL
// ───────────────────────────────────────────────────────

describe("normalizedInboundMessageSchema — mediaUrl field", () => {
  it("accepts a valid https URL", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        mediaUrl: "https://cdn.example.com/file.pdf",
      }).success
    ).toBe(true);
  });

  it("accepts a valid http URL", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        mediaUrl: "http://cdn.example.com/file.jpg",
      }).success
    ).toBe(true);
  });

  it("rejects malformed URL", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        mediaUrl: "not-a-url",
      }).success
    ).toBe(false);
  });

  it("rejects bare path (no scheme/host)", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        mediaUrl: "/wa/abc.jpg",
      }).success
    ).toBe(false);
  });

  it("rejects empty string mediaUrl (z.string().url() rejects '')", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        mediaUrl: "",
      }).success
    ).toBe(false);
  });

  it("rejects non-string non-null mediaUrl", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        mediaUrl: 42 as any,
      }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// providerMessageId — optional + nullable trimmed-min(1)
// ───────────────────────────────────────────────────────

describe("normalizedInboundMessageSchema — providerMessageId field", () => {
  it("accepts a normal id string", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        providerMessageId: "msg_xyz_789",
      }).success
    ).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    const r = normalizedInboundMessageSchema.safeParse({
      ...validBase,
      providerMessageId: "  msg_xyz_789  ",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.providerMessageId).toBe("msg_xyz_789");
  });

  it("rejects empty string providerMessageId (min(1) after trim)", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        providerMessageId: "",
      }).success
    ).toBe(false);
  });

  it("rejects whitespace-only providerMessageId", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        providerMessageId: "    ",
      }).success
    ).toBe(false);
  });

  it("rejects non-string non-null providerMessageId", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        providerMessageId: 99 as any,
      }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// sentAt — must be a Date instance
// ───────────────────────────────────────────────────────

describe("normalizedInboundMessageSchema — sentAt field", () => {
  it("accepts a Date instance", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        sentAt: new Date(),
      }).success
    ).toBe(true);
  });

  it("accepts a Date for an epoch-0 timestamp", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        sentAt: new Date(0),
      }).success
    ).toBe(true);
  });

  it("rejects ISO string (the parser is expected to coerce upstream)", () => {
    // The source intentionally uses z.date() not z.coerce.date() — providers
    // ship epoch-seconds or ISO strings and the per-provider parser converts
    // BEFORE handing to this schema. If a future refactor relaxes this to
    // z.coerce.date(), this test will catch it.
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        sentAt: "2026-05-24T10:30:00.000Z" as any,
      }).success
    ).toBe(false);
  });

  it("rejects numeric epoch (must be a Date instance)", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        sentAt: 1716540000000 as any,
      }).success
    ).toBe(false);
  });

  it("rejects an Invalid Date (NaN-valued Date instance)", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        sentAt: new Date("not-a-real-date"),
      }).success
    ).toBe(false);
  });

  it("rejects missing sentAt field", () => {
    const { sentAt: _s, ...rest } = validBase;
    expect(normalizedInboundMessageSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects null sentAt", () => {
    expect(
      normalizedInboundMessageSchema.safeParse({
        ...validBase,
        sentAt: null as any,
      }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Top-level shape behavior
// ───────────────────────────────────────────────────────

describe("normalizedInboundMessageSchema — top-level shape", () => {
  it("rejects entirely empty payload", () => {
    expect(normalizedInboundMessageSchema.safeParse({}).success).toBe(false);
  });

  it("rejects non-object payload", () => {
    expect(normalizedInboundMessageSchema.safeParse(null).success).toBe(false);
    expect(normalizedInboundMessageSchema.safeParse(undefined).success).toBe(
      false
    );
    expect(normalizedInboundMessageSchema.safeParse("hello").success).toBe(
      false
    );
    expect(normalizedInboundMessageSchema.safeParse(42).success).toBe(false);
    expect(normalizedInboundMessageSchema.safeParse([]).success).toBe(false);
  });

  it("strips unknown fields silently (Zod default)", () => {
    const r = normalizedInboundMessageSchema.safeParse({
      ...validBase,
      unknownField: "should be stripped",
      anotherExtra: 999,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as any).unknownField).toBeUndefined();
      expect((r.data as any).anotherExtra).toBeUndefined();
    }
  });

  it("aggregates multiple field errors in a single parse pass", () => {
    const r = normalizedInboundMessageSchema.safeParse({
      phone: "invalid",
      body: 123,
      sentAt: "not-a-date",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // At minimum: phone regex + body type + sentAt type → ≥3 issues.
      expect(r.error.issues.length).toBeGreaterThanOrEqual(3);
    }
  });
});
