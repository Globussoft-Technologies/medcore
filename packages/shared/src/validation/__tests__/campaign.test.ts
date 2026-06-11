// Coverage tests for campaign validation schemas.
// What: exhaustive happy / invalid / edge cases for every exported Zod schema
//   and helper in packages/shared/src/validation/campaign.ts (Pearl ERP §5.1
//   Campaign + CampaignAudience CRUD + audience-rule DSL + operator state
//   machine).
// Which modules: imports only the schemas, enums, constants, and the
//   OPERATOR_STATUS_TRANSITIONS map from ../campaign.
// Why: file shipped with 0% test coverage. The schemas back operator-driven
//   marketing surfaces (broadcast/drip/trigger campaigns), audience rules
//   stored as JSON, and a state machine. The sendWindow paired-or-neither
//   refinement, the http(s)-only linkTargetUrl guard, the operator-writeable
//   status subset (COMPLETED/RUNNING rejected at write-time), and the
//   audience-rules strict() top-level envelope are all load-bearing
//   invariants that regression-tested here so future DSL evolution doesn't
//   silently relax them.
import { describe, it, expect } from "vitest";
import {
  campaignChannelEnum,
  campaignKindEnum,
  campaignStatusEnum,
  createCampaignSchema,
  updateCampaignSchema,
  AUDIENCE_FILTER_FIELDS,
  AUDIENCE_FILTER_OPS,
  AUDIENCE_MATCH_MODES,
  audienceFilterSchema,
  audienceRulesSchema,
  createCampaignAudienceSchema,
  updateCampaignAudienceSchema,
  OPERATOR_STATUS_TRANSITIONS,
} from "../campaign";

const UUID = "550e8400-e29b-41d4-a716-446655441111";
const UUID_2 = "550e8400-e29b-41d4-a716-446655442222";

// ───────────────────────────────────────────────────────
// Enums
// ───────────────────────────────────────────────────────

describe("campaignChannelEnum", () => {
  it("accepts all four documented channels", () => {
    for (const ch of ["WHATSAPP", "SMS", "EMAIL", "PUSH"]) {
      expect(campaignChannelEnum.safeParse(ch).success).toBe(true);
    }
  });
  it("rejects unknown channel", () => {
    expect(campaignChannelEnum.safeParse("FAX").success).toBe(false);
  });
  it("rejects empty string", () => {
    expect(campaignChannelEnum.safeParse("").success).toBe(false);
  });
});

describe("campaignKindEnum", () => {
  it("accepts BROADCAST/DRIP/TRIGGER/COHORT_REMINDER", () => {
    for (const k of ["BROADCAST", "DRIP", "TRIGGER", "COHORT_REMINDER"]) {
      expect(campaignKindEnum.safeParse(k).success).toBe(true);
    }
  });
  it("rejects unknown kind", () => {
    expect(campaignKindEnum.safeParse("BLAST").success).toBe(false);
  });
});

describe("campaignStatusEnum", () => {
  it("accepts all six lifecycle states", () => {
    for (const s of [
      "DRAFT",
      "SCHEDULED",
      "RUNNING",
      "PAUSED",
      "COMPLETED",
      "CANCELLED",
    ]) {
      expect(campaignStatusEnum.safeParse(s).success).toBe(true);
    }
  });
  it("rejects unknown status", () => {
    expect(campaignStatusEnum.safeParse("ARCHIVED").success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Audience DSL constants
// ───────────────────────────────────────────────────────

describe("audience DSL constants", () => {
  it("AUDIENCE_FILTER_FIELDS is the documented field set", () => {
    expect(AUDIENCE_FILTER_FIELDS).toEqual([
      "gender",
      "age",
      "lastVisitDays",
      "abhaLinked",
      "city",
      "branchId",
      "optedOut",
      // 2026-06: diagnosis / chronic-condition match (cohort Add-by-rule).
      "condition",
    ]);
  });
  it("AUDIENCE_FILTER_OPS is the v1 documented operator set", () => {
    expect(AUDIENCE_FILTER_OPS).toEqual(["eq", "gte", "lte", "in"]);
  });
  it("AUDIENCE_MATCH_MODES is ALL/ANY", () => {
    expect(AUDIENCE_MATCH_MODES).toEqual(["ALL", "ANY"]);
  });
});

// ───────────────────────────────────────────────────────
// createCampaignSchema
// ───────────────────────────────────────────────────────

describe("createCampaignSchema", () => {
  const minimal = {
    name: "Diwali outreach",
    channels: ["SMS" as const],
  };

  it("accepts a minimal payload with channel only", () => {
    expect(createCampaignSchema.safeParse(minimal).success).toBe(true);
  });

  it("defaults status to DRAFT", () => {
    const r = createCampaignSchema.safeParse(minimal);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.status).toBe("DRAFT");
  });

  it("defaults kind to BROADCAST", () => {
    const r = createCampaignSchema.safeParse(minimal);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.kind).toBe("BROADCAST");
  });

  it("accepts a fully populated campaign", () => {
    const r = createCampaignSchema.safeParse({
      name: "Antenatal follow-up",
      description: "Drip for ANC week 28",
      status: "SCHEDULED",
      kind: "DRIP",
      channels: ["WHATSAPP", "SMS"],
      templateId: UUID,
      subject: "Visit reminder",
      body: "Your next ANC visit is in 7 days.",
      audienceId: UUID_2,
      scheduledAt: "2026-06-01T09:00:00Z",
      sendWindowStart: 540, // 09:00
      sendWindowEnd: 1140, // 19:00
      abVariants: [
        { id: "A", weight: 50, subjectOverride: "Reminder A" },
        { id: "B", weight: 50, bodyOverride: "Reminder B" },
      ],
      linkTargetUrl: "https://example.com/campaigns/anc",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.scheduledAt).toBeInstanceOf(Date);
  });

  it("rejects when name is shorter than 2 chars", () => {
    expect(
      createCampaignSchema.safeParse({ ...minimal, name: "x" }).success,
    ).toBe(false);
  });

  it("rejects when name is longer than 200 chars", () => {
    expect(
      createCampaignSchema.safeParse({ ...minimal, name: "x".repeat(201) })
        .success,
    ).toBe(false);
  });

  it("accepts name at the 2- and 200-char boundaries", () => {
    expect(
      createCampaignSchema.safeParse({ ...minimal, name: "ab" }).success,
    ).toBe(true);
    expect(
      createCampaignSchema.safeParse({ ...minimal, name: "x".repeat(200) })
        .success,
    ).toBe(true);
  });

  it("rejects when channels is empty (min 1)", () => {
    const r = createCampaignSchema.safeParse({ ...minimal, channels: [] });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /At least one channel is required/.test(i.message)),
      ).toBe(true);
    }
  });

  it("rejects unknown channel value", () => {
    expect(
      createCampaignSchema.safeParse({ ...minimal, channels: ["FAX"] as any })
        .success,
    ).toBe(false);
  });

  it("rejects non-uuid templateId", () => {
    expect(
      createCampaignSchema.safeParse({ ...minimal, templateId: "not-a-uuid" })
        .success,
    ).toBe(false);
  });

  it("accepts null templateId", () => {
    expect(
      createCampaignSchema.safeParse({ ...minimal, templateId: null }).success,
    ).toBe(true);
  });

  it("rejects subject longer than 255 chars", () => {
    expect(
      createCampaignSchema.safeParse({ ...minimal, subject: "x".repeat(256) })
        .success,
    ).toBe(false);
  });

  it("rejects body longer than 8000 chars", () => {
    expect(
      createCampaignSchema.safeParse({ ...minimal, body: "x".repeat(8001) })
        .success,
    ).toBe(false);
  });

  it("accepts body at exactly 8000 chars", () => {
    expect(
      createCampaignSchema.safeParse({ ...minimal, body: "x".repeat(8000) })
        .success,
    ).toBe(true);
  });

  it("rejects description longer than 2000 chars", () => {
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        description: "x".repeat(2001),
      }).success,
    ).toBe(false);
  });

  it("coerces scheduledAt from ISO string to Date", () => {
    const r = createCampaignSchema.safeParse({
      ...minimal,
      scheduledAt: "2026-06-01T09:00:00Z",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.scheduledAt).toBeInstanceOf(Date);
  });

  it("rejects garbage scheduledAt", () => {
    expect(
      createCampaignSchema.safeParse({ ...minimal, scheduledAt: "yesterday" })
        .success,
    ).toBe(false);
  });

  // sendWindow refinement #1 — paired-or-neither
  it("rejects sendWindowStart without sendWindowEnd", () => {
    const r = createCampaignSchema.safeParse({
      ...minimal,
      sendWindowStart: 540,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) =>
          /sendWindowStart and sendWindowEnd must be set together/.test(i.message),
        ),
      ).toBe(true);
    }
  });

  it("rejects sendWindowEnd without sendWindowStart", () => {
    expect(
      createCampaignSchema.safeParse({ ...minimal, sendWindowEnd: 1140 })
        .success,
    ).toBe(false);
  });

  it("accepts both sendWindow fields null (treated as neither set)", () => {
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        sendWindowStart: null,
        sendWindowEnd: null,
      }).success,
    ).toBe(true);
  });

  // sendWindow refinement #2 — strict ordering
  it("rejects sendWindowStart === sendWindowEnd (must be strictly less)", () => {
    const r = createCampaignSchema.safeParse({
      ...minimal,
      sendWindowStart: 600,
      sendWindowEnd: 600,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) =>
          /sendWindowStart must be strictly less than sendWindowEnd/.test(i.message),
        ),
      ).toBe(true);
    }
  });

  it("rejects sendWindowStart > sendWindowEnd", () => {
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        sendWindowStart: 1200,
        sendWindowEnd: 600,
      }).success,
    ).toBe(false);
  });

  // minuteOfDay bounds (0..1439)
  it("rejects sendWindowStart below 0", () => {
    // Both negative AND below the 540 policy floor — schema rejects.
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        sendWindowStart: -1,
        sendWindowEnd: 1140,
      }).success,
    ).toBe(false);
  });

  it("rejects sendWindowEnd above 1439", () => {
    // Above the minuteOfDay max AND above the 1260 policy ceiling.
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        sendWindowStart: 540,
        sendWindowEnd: 1440,
      }).success,
    ).toBe(false);
  });

  // Issue #985 — quiet-hour policy locks the accepted window to
  // 09:00..21:00 (540..1260). Prior tests treated 0..1439 as accepted;
  // those values would now violate the policy refinement.
  it("accepts sendWindow at the 540..1260 (09:00..21:00) policy boundary", () => {
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        sendWindowStart: 540,
        sendWindowEnd: 1260,
      }).success,
    ).toBe(true);
  });

  it("rejects sendWindowEnd at 22:00 (#985 — out-of-policy)", () => {
    const r = createCampaignSchema.safeParse({
      ...minimal,
      sendWindowStart: 540, // 09:00
      sendWindowEnd: 1320, // 22:00
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) =>
          /09:00.*21:00|Send window must be within/.test(i.message),
        ),
      ).toBe(true);
    }
  });

  it("rejects sendWindowStart at 08:00 (#985 — before policy floor)", () => {
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        sendWindowStart: 480, // 08:00
        sendWindowEnd: 1260,
      }).success,
    ).toBe(false);
  });

  it("rejects non-integer minuteOfDay", () => {
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        sendWindowStart: 9.5,
        sendWindowEnd: 100,
      }).success,
    ).toBe(false);
  });

  // abVariants
  it("rejects more than 10 abVariants", () => {
    const variants = Array.from({ length: 11 }, (_, i) => ({
      id: `v${i}`,
      weight: 5,
    }));
    expect(
      createCampaignSchema.safeParse({ ...minimal, abVariants: variants })
        .success,
    ).toBe(false);
  });

  it("accepts exactly 10 abVariants", () => {
    const variants = Array.from({ length: 10 }, (_, i) => ({
      id: `v${i}`,
      weight: 10,
    }));
    expect(
      createCampaignSchema.safeParse({ ...minimal, abVariants: variants })
        .success,
    ).toBe(true);
  });

  it("rejects abVariant with empty id", () => {
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        abVariants: [{ id: "", weight: 50 }],
      }).success,
    ).toBe(false);
  });

  it("rejects abVariant with weight < 1", () => {
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        abVariants: [{ id: "A", weight: 0 }],
      }).success,
    ).toBe(false);
  });

  it("rejects abVariant with weight > 100", () => {
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        abVariants: [{ id: "A", weight: 101 }],
      }).success,
    ).toBe(false);
  });

  it("rejects abVariant with non-integer weight", () => {
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        abVariants: [{ id: "A", weight: 12.5 }],
      }).success,
    ).toBe(false);
  });

  it("rejects abVariant id longer than 40 chars", () => {
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        abVariants: [{ id: "x".repeat(41), weight: 50 }],
      }).success,
    ).toBe(false);
  });

  it("rejects abVariant subjectOverride longer than 255 chars", () => {
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        abVariants: [{ id: "A", weight: 50, subjectOverride: "x".repeat(256) }],
      }).success,
    ).toBe(false);
  });

  it("rejects abVariant bodyOverride longer than 8000 chars", () => {
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        abVariants: [{ id: "A", weight: 50, bodyOverride: "x".repeat(8001) }],
      }).success,
    ).toBe(false);
  });

  // linkTargetUrl refinement — http(s) only
  it("accepts https linkTargetUrl", () => {
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        linkTargetUrl: "https://example.com/landing",
      }).success,
    ).toBe(true);
  });

  it("accepts http linkTargetUrl", () => {
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        linkTargetUrl: "http://example.com/landing",
      }).success,
    ).toBe(true);
  });

  it("rejects javascript: linkTargetUrl (phishing scheme guard)", () => {
    const r = createCampaignSchema.safeParse({
      ...minimal,
      linkTargetUrl: "javascript:alert(1)",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      // Either the .url() check or the http(s) refine will trip; both are correct rejections.
      expect(r.error.issues.length).toBeGreaterThan(0);
    }
  });

  it("rejects data: linkTargetUrl", () => {
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        linkTargetUrl: "data:text/html,<script>alert(1)</script>",
      }).success,
    ).toBe(false);
  });

  it("rejects ftp:// linkTargetUrl (parses as URL but not http(s))", () => {
    const r = createCampaignSchema.safeParse({
      ...minimal,
      linkTargetUrl: "ftp://example.com/file",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /linkTargetUrl must use http\(s\) scheme/.test(i.message)),
      ).toBe(true);
    }
  });

  it("rejects garbage linkTargetUrl", () => {
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        linkTargetUrl: "not a url",
      }).success,
    ).toBe(false);
  });

  it("rejects linkTargetUrl longer than 2048 chars", () => {
    const longPath = "https://example.com/" + "x".repeat(2050);
    expect(
      createCampaignSchema.safeParse({
        ...minimal,
        linkTargetUrl: longPath,
      }).success,
    ).toBe(false);
  });

  it("accepts null linkTargetUrl", () => {
    expect(
      createCampaignSchema.safeParse({ ...minimal, linkTargetUrl: null })
        .success,
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────
// updateCampaignSchema
// ───────────────────────────────────────────────────────

describe("updateCampaignSchema", () => {
  it("accepts an empty patch (all fields optional)", () => {
    expect(updateCampaignSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a name-only patch", () => {
    expect(
      updateCampaignSchema.safeParse({ name: "New name" }).success,
    ).toBe(true);
  });

  it("rejects COMPLETED in operator-writeable status (terminal-only — dispatcher's domain)", () => {
    // VALID_STATUS_VALUES = [DRAFT, SCHEDULED, RUNNING, PAUSED, CANCELLED] —
    // COMPLETED is the one status the route layer never lets operators set
    // directly (dispatcher closes the loop at end-of-send).
    expect(
      updateCampaignSchema.safeParse({ status: "COMPLETED" }).success,
    ).toBe(false);
  });

  it("accepts every operator-writeable status individually (RUNNING included — route enforces current→next on top of this)", () => {
    // Per the source-side comment: schema permits the full VALID_STATUS_VALUES
    // set; the route then enforces the (current → next) transition matrix
    // documented in OPERATOR_STATUS_TRANSITIONS. RUNNING in particular is
    // reachable from PAUSED → RUNNING (operator-driven resume).
    for (const s of ["DRAFT", "SCHEDULED", "RUNNING", "PAUSED", "CANCELLED"]) {
      expect(updateCampaignSchema.safeParse({ status: s }).success).toBe(true);
    }
  });

  it("rejects unknown status", () => {
    expect(
      updateCampaignSchema.safeParse({ status: "ARCHIVED" as any }).success,
    ).toBe(false);
  });

  it("rejects channels empty array", () => {
    expect(
      updateCampaignSchema.safeParse({ channels: [] }).success,
    ).toBe(false);
  });

  it("rejects non-uuid templateId", () => {
    expect(
      updateCampaignSchema.safeParse({ templateId: "abc" }).success,
    ).toBe(false);
  });

  it("accepts null templateId (clearing)", () => {
    expect(
      updateCampaignSchema.safeParse({ templateId: null }).success,
    ).toBe(true);
  });

  it("rejects cancelReason longer than 500 chars", () => {
    expect(
      updateCampaignSchema.safeParse({ cancelReason: "x".repeat(501) }).success,
    ).toBe(false);
  });

  it("accepts cancelReason at exactly 500 chars", () => {
    expect(
      updateCampaignSchema.safeParse({ cancelReason: "x".repeat(500) }).success,
    ).toBe(true);
  });

  // sendWindow refinement — touches-either logic
  it("accepts a patch touching NEITHER sendWindow field", () => {
    expect(
      updateCampaignSchema.safeParse({ name: "renamed-campaign" }).success,
    ).toBe(true);
  });

  it("rejects a patch setting sendWindowStart but omitting end", () => {
    expect(
      updateCampaignSchema.safeParse({ sendWindowStart: 540 }).success,
    ).toBe(false);
  });

  it("rejects a patch nulling start while setting end (paired-or-neither)", () => {
    expect(
      updateCampaignSchema.safeParse({
        sendWindowStart: null,
        sendWindowEnd: 600,
      }).success,
    ).toBe(false);
  });

  it("accepts a patch nulling BOTH sendWindow fields together (clear window)", () => {
    expect(
      updateCampaignSchema.safeParse({
        sendWindowStart: null,
        sendWindowEnd: null,
      }).success,
    ).toBe(true);
  });

  it("accepts a patch setting BOTH sendWindow fields together", () => {
    expect(
      updateCampaignSchema.safeParse({
        sendWindowStart: 540,
        sendWindowEnd: 1140,
      }).success,
    ).toBe(true);
  });

  it("rejects sendWindowStart >= sendWindowEnd", () => {
    expect(
      updateCampaignSchema.safeParse({
        sendWindowStart: 600,
        sendWindowEnd: 600,
      }).success,
    ).toBe(false);
  });

  it("rejects javascript: linkTargetUrl on update too", () => {
    expect(
      updateCampaignSchema.safeParse({ linkTargetUrl: "javascript:alert(1)" })
        .success,
    ).toBe(false);
  });

  it("accepts null linkTargetUrl on update (clearing)", () => {
    expect(
      updateCampaignSchema.safeParse({ linkTargetUrl: null }).success,
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────
// audienceFilterSchema
// ───────────────────────────────────────────────────────

describe("audienceFilterSchema", () => {
  it("accepts a documented (field, op, value) triple", () => {
    expect(
      audienceFilterSchema.safeParse({
        field: "gender",
        op: "eq",
        value: "FEMALE",
      }).success,
    ).toBe(true);
  });

  it("accepts an unknown field — Zod is permissive by design", () => {
    expect(
      audienceFilterSchema.safeParse({
        field: "chronicConditions.code",
        op: "gt",
        value: 5,
      }).success,
    ).toBe(true);
  });

  it("accepts any JSON-shaped value (object / array / null)", () => {
    expect(
      audienceFilterSchema.safeParse({
        field: "city",
        op: "in",
        value: ["Mumbai", "Pune"],
      }).success,
    ).toBe(true);
    expect(
      audienceFilterSchema.safeParse({
        field: "x",
        op: "y",
        value: { nested: true },
      }).success,
    ).toBe(true);
    // z.unknown() accepts undefined too — the property simply isn't required.
    expect(
      audienceFilterSchema.safeParse({ field: "x", op: "y", value: null })
        .success,
    ).toBe(true);
  });

  it("rejects empty field", () => {
    expect(
      audienceFilterSchema.safeParse({ field: "", op: "eq", value: 1 }).success,
    ).toBe(false);
  });

  it("rejects empty op", () => {
    expect(
      audienceFilterSchema.safeParse({ field: "age", op: "", value: 1 })
        .success,
    ).toBe(false);
  });

  it("rejects field longer than 80 chars", () => {
    expect(
      audienceFilterSchema.safeParse({
        field: "x".repeat(81),
        op: "eq",
        value: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects op longer than 20 chars", () => {
    expect(
      audienceFilterSchema.safeParse({
        field: "age",
        op: "x".repeat(21),
        value: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown top-level keys (.strict())", () => {
    expect(
      audienceFilterSchema.safeParse({
        field: "age",
        op: "gte",
        value: 18,
        extraneous: "no",
      } as any).success,
    ).toBe(false);
  });

  it("rejects non-string field", () => {
    expect(
      audienceFilterSchema.safeParse({ field: 123 as any, op: "eq", value: 1 })
        .success,
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// audienceRulesSchema
// ───────────────────────────────────────────────────────

describe("audienceRulesSchema", () => {
  it("accepts an empty rules object (everyone)", () => {
    expect(audienceRulesSchema.safeParse({}).success).toBe(true);
  });

  it("accepts filters + matchMode ALL", () => {
    expect(
      audienceRulesSchema.safeParse({
        filters: [{ field: "gender", op: "eq", value: "FEMALE" }],
        matchMode: "ALL",
      }).success,
    ).toBe(true);
  });

  it("accepts filters + matchMode ANY", () => {
    expect(
      audienceRulesSchema.safeParse({
        filters: [
          { field: "age", op: "gte", value: 18 },
          { field: "age", op: "lte", value: 65 },
        ],
        matchMode: "ANY",
      }).success,
    ).toBe(true);
  });

  it("rejects unknown matchMode", () => {
    expect(
      audienceRulesSchema.safeParse({ matchMode: "MAYBE" as any }).success,
    ).toBe(false);
  });

  it("rejects unknown TOP-LEVEL keys (.strict() envelope)", () => {
    expect(
      audienceRulesSchema.safeParse({
        filters: [],
        matchMode: "ALL",
        notes: "this should not be allowed",
      } as any).success,
    ).toBe(false);
  });

  it("rejects a filter that fails its own schema (empty field)", () => {
    expect(
      audienceRulesSchema.safeParse({
        filters: [{ field: "", op: "eq", value: 1 }],
      }).success,
    ).toBe(false);
  });

  it("permissive at filter level — unknown filter field still passes top schema", () => {
    expect(
      audienceRulesSchema.safeParse({
        filters: [{ field: "nonexistentField", op: "weirdop", value: 42 }],
      }).success,
    ).toBe(true);
  });

  it("accepts empty filters array", () => {
    expect(
      audienceRulesSchema.safeParse({ filters: [], matchMode: "ALL" }).success,
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────
// createCampaignAudienceSchema
// ───────────────────────────────────────────────────────

describe("createCampaignAudienceSchema", () => {
  const valid = {
    name: "Women 18-45 in OPD",
    rules: {
      filters: [
        { field: "gender", op: "eq", value: "FEMALE" },
        { field: "age", op: "gte", value: 18 },
        { field: "age", op: "lte", value: 45 },
      ],
      matchMode: "ALL" as const,
    },
  };

  it("accepts a minimal audience", () => {
    expect(createCampaignAudienceSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts an audience with description + active", () => {
    expect(
      createCampaignAudienceSchema.safeParse({
        ...valid,
        description: "Cohort for ANC outreach",
        active: true,
      }).success,
    ).toBe(true);
  });

  it("rejects name shorter than 2 chars", () => {
    expect(
      createCampaignAudienceSchema.safeParse({ ...valid, name: "x" }).success,
    ).toBe(false);
  });

  it("rejects name longer than 200 chars", () => {
    expect(
      createCampaignAudienceSchema.safeParse({
        ...valid,
        name: "x".repeat(201),
      }).success,
    ).toBe(false);
  });

  it("rejects description longer than 2000 chars", () => {
    expect(
      createCampaignAudienceSchema.safeParse({
        ...valid,
        description: "x".repeat(2001),
      }).success,
    ).toBe(false);
  });

  it("rejects missing rules (required)", () => {
    expect(
      createCampaignAudienceSchema.safeParse({ name: "x".repeat(5) } as any)
        .success,
    ).toBe(false);
  });

  it("rejects rules with extraneous top-level keys", () => {
    expect(
      createCampaignAudienceSchema.safeParse({
        ...valid,
        rules: { ...valid.rules, extra: true } as any,
      }).success,
    ).toBe(false);
  });

  it("rejects non-boolean active", () => {
    expect(
      createCampaignAudienceSchema.safeParse({
        ...valid,
        active: "yes" as any,
      }).success,
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// updateCampaignAudienceSchema
// ───────────────────────────────────────────────────────

describe("updateCampaignAudienceSchema", () => {
  it("accepts an empty patch (all fields optional)", () => {
    expect(updateCampaignAudienceSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a name-only patch", () => {
    expect(
      updateCampaignAudienceSchema.safeParse({ name: "renamed" }).success,
    ).toBe(true);
  });

  it("accepts a null description (clearing)", () => {
    expect(
      updateCampaignAudienceSchema.safeParse({ description: null }).success,
    ).toBe(true);
  });

  it("accepts a rules-only patch", () => {
    expect(
      updateCampaignAudienceSchema.safeParse({
        rules: { filters: [], matchMode: "ANY" },
      }).success,
    ).toBe(true);
  });

  it("rejects rules with extraneous top-level keys", () => {
    expect(
      updateCampaignAudienceSchema.safeParse({
        rules: { filters: [], extra: 1 } as any,
      }).success,
    ).toBe(false);
  });

  it("rejects name shorter than 2 chars", () => {
    expect(
      updateCampaignAudienceSchema.safeParse({ name: "x" }).success,
    ).toBe(false);
  });

  it("rejects active=non-boolean", () => {
    expect(
      updateCampaignAudienceSchema.safeParse({ active: 1 as any }).success,
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// OPERATOR_STATUS_TRANSITIONS helper map
// ───────────────────────────────────────────────────────

describe("OPERATOR_STATUS_TRANSITIONS", () => {
  it("has an entry for every documented status", () => {
    for (const s of [
      "DRAFT",
      "SCHEDULED",
      "RUNNING",
      "PAUSED",
      "COMPLETED",
      "CANCELLED",
    ]) {
      expect(OPERATOR_STATUS_TRANSITIONS).toHaveProperty(s);
    }
  });

  it("DRAFT can transition to SCHEDULED or CANCELLED", () => {
    expect([...OPERATOR_STATUS_TRANSITIONS.DRAFT].sort()).toEqual(
      ["CANCELLED", "SCHEDULED"].sort(),
    );
  });

  it("SCHEDULED can revert to DRAFT or be CANCELLED", () => {
    expect([...OPERATOR_STATUS_TRANSITIONS.SCHEDULED].sort()).toEqual(
      ["CANCELLED", "DRAFT"].sort(),
    );
  });

  it("RUNNING can transition to PAUSED or CANCELLED", () => {
    expect([...OPERATOR_STATUS_TRANSITIONS.RUNNING].sort()).toEqual(
      ["CANCELLED", "PAUSED"].sort(),
    );
  });

  it("PAUSED can transition to RUNNING or CANCELLED", () => {
    expect([...OPERATOR_STATUS_TRANSITIONS.PAUSED].sort()).toEqual(
      ["CANCELLED", "RUNNING"].sort(),
    );
  });

  it("COMPLETED is terminal (no operator-initiated transition)", () => {
    expect(OPERATOR_STATUS_TRANSITIONS.COMPLETED).toEqual([]);
  });

  it("CANCELLED is terminal (no operator-initiated transition)", () => {
    expect(OPERATOR_STATUS_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it("never allows an operator-initiated jump directly to RUNNING from DRAFT/SCHEDULED", () => {
    // RUNNING is dispatcher-only; the only RUNNING source is PAUSED → RUNNING (resume).
    expect(OPERATOR_STATUS_TRANSITIONS.DRAFT).not.toContain("RUNNING");
    expect(OPERATOR_STATUS_TRANSITIONS.SCHEDULED).not.toContain("RUNNING");
  });

  it("never allows an operator-initiated jump directly to COMPLETED", () => {
    for (const from of [
      "DRAFT",
      "SCHEDULED",
      "RUNNING",
      "PAUSED",
    ] as const) {
      expect(OPERATOR_STATUS_TRANSITIONS[from]).not.toContain("COMPLETED");
    }
  });
});
