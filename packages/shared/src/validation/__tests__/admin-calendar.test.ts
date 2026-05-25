// Coverage tests for admin-calendar validation schemas.
// What: exhaustive happy / invalid / edge / refinement cases for every exported
//   Zod schema + constant in packages/shared/src/validation/admin-calendar.ts —
//   create+update CalendarEvent (Issue #718) and create+update
//   InsuranceProvider (Issue #724).
// Which modules: imports only from ../admin-calendar (schemas, constants).
// Why: file shipped with 0% colocated test coverage. Locks in the contract
//   shared between the browser form and the Express handler so neither side
//   can drift (the explicit reason these schemas live in @medcore/shared per
//   the file header). Particularly important to pin: (a) endAt > startAt
//   superRefine on createCalendarEventSchema and its conditional variant on
//   the update schema; (b) the "" → undefined empty-string coercion on every
//   optional free-text field; (c) the toUpperCase() pre-regex coercion on
//   InsuranceProvider.code so admins typing "medi_assist" still pass; (d)
//   the phone-format refine that allows "" / undefined / null but rejects
//   short/letter-bearing strings; (e) the default("OTHER") on calendar event
//   category.
import { describe, it, expect } from "vitest";
import {
  CALENDAR_EVENT_CATEGORIES,
  createCalendarEventSchema,
  updateCalendarEventSchema,
  createInsuranceProviderSchema,
  updateInsuranceProviderSchema,
} from "../admin-calendar";

// ───────────────────────────────────────────────────────
// CALENDAR_EVENT_CATEGORIES (Issue #718)
// ───────────────────────────────────────────────────────

describe("CALENDAR_EVENT_CATEGORIES", () => {
  it("exposes the documented 6-archetype catalog", () => {
    expect(CALENDAR_EVENT_CATEGORIES).toEqual([
      "TRAINING",
      "CLOSURE",
      "TOWN_HALL",
      "MAINTENANCE",
      "MARKETING",
      "OTHER",
    ]);
  });
  it("is a readonly tuple (length stable)", () => {
    expect(CALENDAR_EVENT_CATEGORIES.length).toBe(6);
  });
});

// ───────────────────────────────────────────────────────
// createCalendarEventSchema (Issue #718)
// ───────────────────────────────────────────────────────

describe("createCalendarEventSchema", () => {
  const valid = {
    title: "Quarterly Town Hall",
    category: "TOWN_HALL" as const,
    startAt: "2026-06-01T10:00:00+05:30",
    endAt: "2026-06-01T11:00:00+05:30",
  };

  it("accepts a minimal valid event", () => {
    expect(createCalendarEventSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a Z-suffix UTC datetime", () => {
    expect(
      createCalendarEventSchema.safeParse({
        ...valid,
        startAt: "2026-06-01T10:00:00Z",
        endAt: "2026-06-01T11:00:00Z",
      }).success
    ).toBe(true);
  });

  it("defaults category to OTHER when omitted", () => {
    const { category: _c, ...rest } = valid;
    const r = createCalendarEventSchema.safeParse(rest);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.category).toBe("OTHER");
  });

  it("accepts each canonical category", () => {
    for (const c of CALENDAR_EVENT_CATEGORIES) {
      expect(
        createCalendarEventSchema.safeParse({ ...valid, category: c }).success
      ).toBe(true);
    }
  });

  it("rejects an unknown category", () => {
    expect(
      createCalendarEventSchema.safeParse({ ...valid, category: "PARTY" as any })
        .success
    ).toBe(false);
  });

  // title
  it("trims surrounding whitespace on title before length check", () => {
    const r = createCalendarEventSchema.safeParse({
      ...valid,
      title: "  All-Hands  ",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.title).toBe("All-Hands");
  });
  it("rejects title shorter than 2 chars (post-trim)", () => {
    const r = createCalendarEventSchema.safeParse({ ...valid, title: "A" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Title must be at least 2 characters/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects title that becomes empty after trim", () => {
    expect(createCalendarEventSchema.safeParse({ ...valid, title: "   " }).success).toBe(
      false
    );
  });
  it("accepts title at exactly 2 chars (lower boundary)", () => {
    expect(createCalendarEventSchema.safeParse({ ...valid, title: "AB" }).success).toBe(
      true
    );
  });
  it("accepts title at exactly 200 chars (upper boundary)", () => {
    expect(
      createCalendarEventSchema.safeParse({ ...valid, title: "x".repeat(200) }).success
    ).toBe(true);
  });
  it("rejects title longer than 200 chars", () => {
    const r = createCalendarEventSchema.safeParse({
      ...valid,
      title: "x".repeat(201),
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /Title is too long/.test(i.message))).toBe(true);
    }
  });
  it("rejects missing title", () => {
    const { title: _t, ...rest } = valid;
    expect(createCalendarEventSchema.safeParse(rest).success).toBe(false);
  });

  // startAt / endAt
  it("rejects startAt missing timezone offset", () => {
    expect(
      createCalendarEventSchema.safeParse({ ...valid, startAt: "2026-06-01T10:00:00" })
        .success
    ).toBe(false);
  });
  it("rejects endAt missing timezone offset", () => {
    expect(
      createCalendarEventSchema.safeParse({ ...valid, endAt: "2026-06-01T11:00:00" })
        .success
    ).toBe(false);
  });
  it("rejects date-only startAt", () => {
    expect(
      createCalendarEventSchema.safeParse({ ...valid, startAt: "2026-06-01" }).success
    ).toBe(false);
  });
  it("rejects garbage startAt with the schema-provided message", () => {
    const r = createCalendarEventSchema.safeParse({ ...valid, startAt: "not-a-date" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /startAt must be an ISO datetime/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects garbage endAt with the schema-provided message", () => {
    const r = createCalendarEventSchema.safeParse({ ...valid, endAt: "tomorrow" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /endAt must be an ISO datetime/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects missing startAt", () => {
    const { startAt: _s, ...rest } = valid;
    expect(createCalendarEventSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects missing endAt", () => {
    const { endAt: _e, ...rest } = valid;
    expect(createCalendarEventSchema.safeParse(rest).success).toBe(false);
  });

  // superRefine — endAt strictly after startAt
  it("rejects endAt == startAt (refine: strict >)", () => {
    const r = createCalendarEventSchema.safeParse({
      ...valid,
      startAt: "2026-06-01T10:00:00+05:30",
      endAt: "2026-06-01T10:00:00+05:30",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /endAt must be after startAt/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects endAt before startAt", () => {
    const r = createCalendarEventSchema.safeParse({
      ...valid,
      startAt: "2026-06-01T11:00:00+05:30",
      endAt: "2026-06-01T10:00:00+05:30",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some(
          (i) => i.path[0] === "endAt" && /endAt must be after startAt/.test(i.message)
        )
      ).toBe(true);
    }
  });
  it("accepts endAt one minute after startAt", () => {
    expect(
      createCalendarEventSchema.safeParse({
        ...valid,
        startAt: "2026-06-01T10:00:00+05:30",
        endAt: "2026-06-01T10:01:00+05:30",
      }).success
    ).toBe(true);
  });
  it("accepts events that span midnight across timezones", () => {
    expect(
      createCalendarEventSchema.safeParse({
        ...valid,
        startAt: "2026-06-01T23:00:00+05:30",
        endAt: "2026-06-02T01:00:00+05:30",
      }).success
    ).toBe(true);
  });

  // color (optional + "" → undefined)
  it("accepts color omitted entirely", () => {
    const r = createCalendarEventSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.color).toBeUndefined();
  });
  it("coerces empty-string color to undefined", () => {
    const r = createCalendarEventSchema.safeParse({ ...valid, color: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.color).toBeUndefined();
  });
  it("accepts a Tailwind-style color hint", () => {
    const r = createCalendarEventSchema.safeParse({ ...valid, color: "bg-red-500" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.color).toBe("bg-red-500");
  });
  it("accepts color at exactly 40 chars", () => {
    expect(
      createCalendarEventSchema.safeParse({ ...valid, color: "x".repeat(40) }).success
    ).toBe(true);
  });
  it("rejects color longer than 40 chars", () => {
    const r = createCalendarEventSchema.safeParse({
      ...valid,
      color: "x".repeat(41),
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /Color hint is too long/.test(i.message))).toBe(
        true
      );
    }
  });

  // description (optional + "" → undefined)
  it("accepts description omitted entirely", () => {
    expect(createCalendarEventSchema.safeParse(valid).success).toBe(true);
  });
  it("coerces empty-string description to undefined", () => {
    const r = createCalendarEventSchema.safeParse({ ...valid, description: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.description).toBeUndefined();
  });
  it("accepts description at exactly 2000 chars", () => {
    expect(
      createCalendarEventSchema.safeParse({ ...valid, description: "x".repeat(2000) })
        .success
    ).toBe(true);
  });
  it("rejects description longer than 2000 chars", () => {
    const r = createCalendarEventSchema.safeParse({
      ...valid,
      description: "x".repeat(2001),
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Description is too long/.test(i.message))
      ).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────
// updateCalendarEventSchema (Issue #718)
// ───────────────────────────────────────────────────────

describe("updateCalendarEventSchema", () => {
  it("accepts an empty patch (every field optional)", () => {
    expect(updateCalendarEventSchema.safeParse({}).success).toBe(true);
  });
  it("accepts a title-only patch", () => {
    expect(
      updateCalendarEventSchema.safeParse({ title: "Renamed event" }).success
    ).toBe(true);
  });
  it("accepts a category-only reclassification", () => {
    expect(
      updateCalendarEventSchema.safeParse({ category: "MARKETING" }).success
    ).toBe(true);
  });
  it("rejects title below 2 chars", () => {
    expect(updateCalendarEventSchema.safeParse({ title: "A" }).success).toBe(false);
  });
  it("rejects title above 200 chars", () => {
    expect(
      updateCalendarEventSchema.safeParse({ title: "x".repeat(201) }).success
    ).toBe(false);
  });
  it("rejects unknown category", () => {
    expect(
      updateCalendarEventSchema.safeParse({ category: "PARTY" as any }).success
    ).toBe(false);
  });
  it("accepts null for color (clears the hint)", () => {
    expect(updateCalendarEventSchema.safeParse({ color: null }).success).toBe(true);
  });
  it("accepts null for description (clears the note)", () => {
    expect(updateCalendarEventSchema.safeParse({ description: null }).success).toBe(true);
  });
  it("rejects color longer than 40 chars", () => {
    expect(
      updateCalendarEventSchema.safeParse({ color: "x".repeat(41) }).success
    ).toBe(false);
  });
  it("rejects description longer than 2000 chars", () => {
    expect(
      updateCalendarEventSchema.safeParse({ description: "x".repeat(2001) }).success
    ).toBe(false);
  });
  it("rejects malformed startAt", () => {
    expect(updateCalendarEventSchema.safeParse({ startAt: "tomorrow" }).success).toBe(
      false
    );
  });
  it("rejects malformed endAt", () => {
    expect(updateCalendarEventSchema.safeParse({ endAt: "tomorrow" }).success).toBe(
      false
    );
  });

  // Conditional superRefine — only fires when BOTH start and end are present
  it("accepts a startAt-only patch even though there's no endAt to compare", () => {
    expect(
      updateCalendarEventSchema.safeParse({ startAt: "2026-06-01T10:00:00Z" }).success
    ).toBe(true);
  });
  it("accepts an endAt-only patch even though there's no startAt to compare", () => {
    expect(
      updateCalendarEventSchema.safeParse({ endAt: "2026-06-01T10:00:00Z" }).success
    ).toBe(true);
  });
  it("rejects when both provided and endAt <= startAt", () => {
    const r = updateCalendarEventSchema.safeParse({
      startAt: "2026-06-01T11:00:00Z",
      endAt: "2026-06-01T10:00:00Z",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some(
          (i) => i.path[0] === "endAt" && /endAt must be after startAt/.test(i.message)
        )
      ).toBe(true);
    }
  });
  it("rejects when both provided and endAt == startAt", () => {
    expect(
      updateCalendarEventSchema.safeParse({
        startAt: "2026-06-01T10:00:00Z",
        endAt: "2026-06-01T10:00:00Z",
      }).success
    ).toBe(false);
  });
  it("accepts when both provided and endAt > startAt", () => {
    expect(
      updateCalendarEventSchema.safeParse({
        startAt: "2026-06-01T10:00:00Z",
        endAt: "2026-06-01T11:00:00Z",
      }).success
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────
// createInsuranceProviderSchema (Issue #724)
// ───────────────────────────────────────────────────────

describe("createInsuranceProviderSchema", () => {
  const valid = {
    name: "Medi Assist Healthcare Services",
    code: "MEDI_ASSIST",
  };

  it("accepts a minimal valid provider", () => {
    expect(createInsuranceProviderSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a fully-populated provider", () => {
    expect(
      createInsuranceProviderSchema.safeParse({
        ...valid,
        contactPerson: "Asha Iyer",
        contactEmail: "asha@medi-assist.example.com",
        contactPhone: "+91 98765 43210",
        coverageDetails: "Cashless at all empanelled hospitals; outpatient excluded.",
      }).success
    ).toBe(true);
  });

  // name
  it("trims surrounding whitespace on name", () => {
    const r = createInsuranceProviderSchema.safeParse({
      ...valid,
      name: "  Vidal Health  ",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe("Vidal Health");
  });
  it("rejects name shorter than 2 chars", () => {
    const r = createInsuranceProviderSchema.safeParse({ ...valid, name: "A" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) =>
          /Provider name must be at least 2 characters/.test(i.message)
        )
      ).toBe(true);
    }
  });
  it("accepts name at exactly 200 chars", () => {
    expect(
      createInsuranceProviderSchema.safeParse({ ...valid, name: "x".repeat(200) }).success
    ).toBe(true);
  });
  it("rejects name longer than 200 chars", () => {
    const r = createInsuranceProviderSchema.safeParse({
      ...valid,
      name: "x".repeat(201),
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Provider name is too long/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects missing name", () => {
    const { name: _n, ...rest } = valid;
    expect(createInsuranceProviderSchema.safeParse(rest).success).toBe(false);
  });

  // code — toUpperCase + regex
  it("uppercases lowercase code before regex check", () => {
    const r = createInsuranceProviderSchema.safeParse({ ...valid, code: "medi_assist" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.code).toBe("MEDI_ASSIST");
  });
  it("uppercases mixed-case code", () => {
    const r = createInsuranceProviderSchema.safeParse({ ...valid, code: "Medi_Assist" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.code).toBe("MEDI_ASSIST");
  });
  it("trims surrounding whitespace from code", () => {
    const r = createInsuranceProviderSchema.safeParse({ ...valid, code: "  vidal  " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.code).toBe("VIDAL");
  });
  it("accepts code at length 2 (lower boundary: 1 leading + 1 follow)", () => {
    expect(
      createInsuranceProviderSchema.safeParse({ ...valid, code: "AB" }).success
    ).toBe(true);
  });
  it("accepts code at length 31 (upper boundary: 1 leading + 30 follow)", () => {
    expect(
      createInsuranceProviderSchema.safeParse({
        ...valid,
        code: "A" + "B".repeat(30),
      }).success
    ).toBe(true);
  });
  it("rejects single-letter code", () => {
    expect(createInsuranceProviderSchema.safeParse({ ...valid, code: "A" }).success).toBe(
      false
    );
  });
  it("rejects code longer than 31 chars", () => {
    expect(
      createInsuranceProviderSchema.safeParse({
        ...valid,
        code: "A" + "B".repeat(31),
      }).success
    ).toBe(false);
  });
  it("rejects code starting with a digit", () => {
    const r = createInsuranceProviderSchema.safeParse({ ...valid, code: "1MEDI" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Code must be/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects code starting with an underscore", () => {
    expect(
      createInsuranceProviderSchema.safeParse({ ...valid, code: "_MEDI" }).success
    ).toBe(false);
  });
  it("rejects code containing a dash", () => {
    expect(
      createInsuranceProviderSchema.safeParse({ ...valid, code: "MEDI-ASSIST" }).success
    ).toBe(false);
  });
  it("rejects code containing a space (post-trim)", () => {
    expect(
      createInsuranceProviderSchema.safeParse({ ...valid, code: "MEDI ASSIST" }).success
    ).toBe(false);
  });
  it("rejects code containing punctuation", () => {
    expect(
      createInsuranceProviderSchema.safeParse({ ...valid, code: "MEDI.ASSIST" }).success
    ).toBe(false);
  });
  it("accepts code with digits after the first letter", () => {
    expect(
      createInsuranceProviderSchema.safeParse({ ...valid, code: "TPA42_HEALTH" }).success
    ).toBe(true);
  });

  // contactPerson
  it("coerces empty-string contactPerson to undefined", () => {
    const r = createInsuranceProviderSchema.safeParse({
      ...valid,
      contactPerson: "",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.contactPerson).toBeUndefined();
  });
  it("accepts contactPerson at exactly 200 chars", () => {
    expect(
      createInsuranceProviderSchema.safeParse({
        ...valid,
        contactPerson: "x".repeat(200),
      }).success
    ).toBe(true);
  });
  it("rejects contactPerson longer than 200 chars", () => {
    expect(
      createInsuranceProviderSchema.safeParse({
        ...valid,
        contactPerson: "x".repeat(201),
      }).success
    ).toBe(false);
  });

  // contactEmail
  it("coerces empty-string contactEmail to undefined", () => {
    const r = createInsuranceProviderSchema.safeParse({ ...valid, contactEmail: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.contactEmail).toBeUndefined();
  });
  it("rejects malformed contactEmail", () => {
    const r = createInsuranceProviderSchema.safeParse({
      ...valid,
      contactEmail: "not-an-email",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Enter a valid email address/.test(i.message))
      ).toBe(true);
    }
  });
  it("accepts a normal contactEmail", () => {
    expect(
      createInsuranceProviderSchema.safeParse({
        ...valid,
        contactEmail: "ops@tpa.example.com",
      }).success
    ).toBe(true);
  });

  // contactPhone — refine fires only on non-undefined values
  it("coerces empty-string contactPhone to undefined (skipping the refine)", () => {
    const r = createInsuranceProviderSchema.safeParse({ ...valid, contactPhone: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.contactPhone).toBeUndefined();
  });
  it("accepts +CC contactPhone with spaces", () => {
    expect(
      createInsuranceProviderSchema.safeParse({
        ...valid,
        contactPhone: "+91 98765 43210",
      }).success
    ).toBe(true);
  });
  it("accepts bare-digit contactPhone (no +)", () => {
    expect(
      createInsuranceProviderSchema.safeParse({
        ...valid,
        contactPhone: "9876543210",
      }).success
    ).toBe(true);
  });
  it("accepts contactPhone with dashes", () => {
    expect(
      createInsuranceProviderSchema.safeParse({
        ...valid,
        contactPhone: "+1-555-867-5309",
      }).success
    ).toBe(true);
  });
  it("rejects contactPhone shorter than 7 chars (regex floor)", () => {
    const r = createInsuranceProviderSchema.safeParse({
      ...valid,
      contactPhone: "+1234",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Enter a valid phone number/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects contactPhone with letters", () => {
    expect(
      createInsuranceProviderSchema.safeParse({
        ...valid,
        contactPhone: "abc1234567",
      }).success
    ).toBe(false);
  });
  it("rejects contactPhone longer than 30 chars (max() trips before refine)", () => {
    expect(
      createInsuranceProviderSchema.safeParse({
        ...valid,
        contactPhone: "+91 " + "9".repeat(30),
      }).success
    ).toBe(false);
  });

  // coverageDetails
  it("coerces empty-string coverageDetails to undefined", () => {
    const r = createInsuranceProviderSchema.safeParse({
      ...valid,
      coverageDetails: "",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.coverageDetails).toBeUndefined();
  });
  it("accepts coverageDetails at exactly 4000 chars", () => {
    expect(
      createInsuranceProviderSchema.safeParse({
        ...valid,
        coverageDetails: "x".repeat(4000),
      }).success
    ).toBe(true);
  });
  it("rejects coverageDetails longer than 4000 chars", () => {
    const r = createInsuranceProviderSchema.safeParse({
      ...valid,
      coverageDetails: "x".repeat(4001),
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Coverage details are too long/.test(i.message))
      ).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────
// updateInsuranceProviderSchema (Issue #724)
// ───────────────────────────────────────────────────────

describe("updateInsuranceProviderSchema", () => {
  it("accepts an empty patch (every field optional)", () => {
    expect(updateInsuranceProviderSchema.safeParse({}).success).toBe(true);
  });
  it("accepts a name-only patch", () => {
    expect(
      updateInsuranceProviderSchema.safeParse({ name: "Vidal Health" }).success
    ).toBe(true);
  });
  it("accepts a code-only patch and uppercases it", () => {
    const r = updateInsuranceProviderSchema.safeParse({ code: "vidal" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.code).toBe("VIDAL");
  });
  it("accepts an isActive=false deactivation patch", () => {
    expect(updateInsuranceProviderSchema.safeParse({ isActive: false }).success).toBe(
      true
    );
  });
  it("accepts an isActive=true reactivation patch", () => {
    expect(updateInsuranceProviderSchema.safeParse({ isActive: true }).success).toBe(
      true
    );
  });
  it("rejects non-boolean isActive", () => {
    expect(
      updateInsuranceProviderSchema.safeParse({ isActive: "yes" as any }).success
    ).toBe(false);
  });

  // name
  it("rejects name below 2 chars", () => {
    expect(updateInsuranceProviderSchema.safeParse({ name: "A" }).success).toBe(false);
  });
  it("rejects name above 200 chars", () => {
    expect(
      updateInsuranceProviderSchema.safeParse({ name: "x".repeat(201) }).success
    ).toBe(false);
  });

  // code
  it("rejects code starting with digit", () => {
    expect(updateInsuranceProviderSchema.safeParse({ code: "1MEDI" }).success).toBe(
      false
    );
  });
  it("rejects code with dash", () => {
    expect(
      updateInsuranceProviderSchema.safeParse({ code: "MEDI-ASSIST" }).success
    ).toBe(false);
  });
  it("rejects single-letter code", () => {
    expect(updateInsuranceProviderSchema.safeParse({ code: "A" }).success).toBe(false);
  });

  // contactPerson — nullable on update
  it("accepts null contactPerson (clears the field)", () => {
    expect(updateInsuranceProviderSchema.safeParse({ contactPerson: null }).success).toBe(
      true
    );
  });
  it("accepts a non-empty contactPerson", () => {
    expect(
      updateInsuranceProviderSchema.safeParse({ contactPerson: "New rep" }).success
    ).toBe(true);
  });
  it("rejects contactPerson longer than 200 chars", () => {
    expect(
      updateInsuranceProviderSchema.safeParse({ contactPerson: "x".repeat(201) }).success
    ).toBe(false);
  });

  // contactEmail — nullable on update
  it("accepts null contactEmail", () => {
    expect(updateInsuranceProviderSchema.safeParse({ contactEmail: null }).success).toBe(
      true
    );
  });
  it("rejects malformed contactEmail", () => {
    expect(
      updateInsuranceProviderSchema.safeParse({ contactEmail: "not-an-email" }).success
    ).toBe(false);
  });
  it("accepts a valid contactEmail", () => {
    expect(
      updateInsuranceProviderSchema.safeParse({ contactEmail: "ops@tpa.example.com" })
        .success
    ).toBe(true);
  });

  // contactPhone — refine accepts undefined/null/"" but rejects short/letter-bearing
  it("accepts null contactPhone", () => {
    expect(updateInsuranceProviderSchema.safeParse({ contactPhone: null }).success).toBe(
      true
    );
  });
  it("accepts empty-string contactPhone (refine exempts '')", () => {
    expect(updateInsuranceProviderSchema.safeParse({ contactPhone: "" }).success).toBe(
      true
    );
  });
  it("accepts a normal contactPhone", () => {
    expect(
      updateInsuranceProviderSchema.safeParse({ contactPhone: "+91 98765 43210" }).success
    ).toBe(true);
  });
  it("rejects contactPhone with letters", () => {
    const r = updateInsuranceProviderSchema.safeParse({ contactPhone: "abc1234567" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /Enter a valid phone number/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects contactPhone shorter than 7 chars", () => {
    expect(updateInsuranceProviderSchema.safeParse({ contactPhone: "+1234" }).success).toBe(
      false
    );
  });
  it("rejects contactPhone longer than 30 chars", () => {
    expect(
      updateInsuranceProviderSchema.safeParse({
        contactPhone: "+91 " + "9".repeat(30),
      }).success
    ).toBe(false);
  });

  // coverageDetails — nullable on update
  it("accepts null coverageDetails", () => {
    expect(
      updateInsuranceProviderSchema.safeParse({ coverageDetails: null }).success
    ).toBe(true);
  });
  it("accepts coverageDetails at exactly 4000 chars", () => {
    expect(
      updateInsuranceProviderSchema.safeParse({
        coverageDetails: "x".repeat(4000),
      }).success
    ).toBe(true);
  });
  it("rejects coverageDetails longer than 4000 chars", () => {
    expect(
      updateInsuranceProviderSchema.safeParse({
        coverageDetails: "x".repeat(4001),
      }).success
    ).toBe(false);
  });
});
