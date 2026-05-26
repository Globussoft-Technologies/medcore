// Colocated coverage for the reports validation surface.
//
// What: happy + invalid cases for every exported schema in `./reports.ts` —
// `scheduledReportCreateSchema` (name min/max, reportType enum, frequency
// enum, dayOfWeek 0..6, dayOfMonth 1..31, timeOfDay HH:MM regex, recipients
// email[] min(1)/max(50), config record, active bool),
// `scheduledReportUpdateSchema` (partial of the create schema), and
// `dashboardPreferenceSchema` (layout.widgets[] shape).
//
// Why: reports.ts had no colocated *.test.ts file. Pure Zod safeParse
// surface — no DB, no network, no mocks — drives every refine branch and
// boundary in the module so the test-writing cron sees coverage closure.

import { describe, it, expect } from "vitest";
import {
  scheduledReportCreateSchema,
  scheduledReportUpdateSchema,
  dashboardPreferenceSchema,
} from "./reports";

const validCreate = {
  name: "Daily census report",
  reportType: "DAILY_CENSUS" as const,
  frequency: "DAILY" as const,
  timeOfDay: "08:30",
  recipients: ["ops@medcore.local"],
};

describe("scheduledReportCreateSchema accepts the canonical happy path", () => {
  it("accepts the minimal required shape", () => {
    expect(scheduledReportCreateSchema.safeParse(validCreate).success).toBe(true);
  });

  it("accepts a fully populated schedule", () => {
    expect(
      scheduledReportCreateSchema.safeParse({
        ...validCreate,
        dayOfWeek: 1,
        dayOfMonth: 15,
        config: { includeCharts: true, header: "Hospital A" },
        active: true,
      }).success,
    ).toBe(true);
  });
});

describe("scheduledReportCreateSchema — name min/max bounds", () => {
  it("rejects empty name", () => {
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, name: "" }).success,
    ).toBe(false);
  });

  it("accepts a 200-char name at the upper boundary", () => {
    expect(
      scheduledReportCreateSchema.safeParse({
        ...validCreate,
        name: "a".repeat(200),
      }).success,
    ).toBe(true);
  });

  it("rejects a 201-char name above the upper boundary", () => {
    expect(
      scheduledReportCreateSchema.safeParse({
        ...validCreate,
        name: "a".repeat(201),
      }).success,
    ).toBe(false);
  });

  it("rejects non-string name", () => {
    expect(
      scheduledReportCreateSchema.safeParse({
        ...validCreate,
        name: 42 as unknown as string,
      }).success,
    ).toBe(false);
  });
});

describe("scheduledReportCreateSchema — reportType enum", () => {
  it("accepts each documented reportType", () => {
    for (const reportType of [
      "DAILY_CENSUS",
      "WEEKLY_REVENUE",
      "MONTHLY_SUMMARY",
      "CUSTOM",
    ] as const) {
      expect(
        scheduledReportCreateSchema.safeParse({ ...validCreate, reportType }).success,
      ).toBe(true);
    }
  });

  it("rejects unknown reportType", () => {
    expect(
      scheduledReportCreateSchema.safeParse({
        ...validCreate,
        reportType: "QUARTERLY" as unknown as "DAILY_CENSUS",
      }).success,
    ).toBe(false);
  });

  it("rejects missing reportType", () => {
    const { reportType: _r, ...noType } = validCreate;
    expect(scheduledReportCreateSchema.safeParse(noType).success).toBe(false);
  });
});

describe("scheduledReportCreateSchema — frequency enum", () => {
  it("accepts each documented frequency", () => {
    for (const frequency of ["DAILY", "WEEKLY", "MONTHLY"] as const) {
      expect(
        scheduledReportCreateSchema.safeParse({ ...validCreate, frequency }).success,
      ).toBe(true);
    }
  });

  it("rejects unknown frequency", () => {
    expect(
      scheduledReportCreateSchema.safeParse({
        ...validCreate,
        frequency: "YEARLY" as unknown as "DAILY",
      }).success,
    ).toBe(false);
  });

  it("rejects missing frequency", () => {
    const { frequency: _f, ...noFreq } = validCreate;
    expect(scheduledReportCreateSchema.safeParse(noFreq).success).toBe(false);
  });
});

describe("scheduledReportCreateSchema — dayOfWeek boundaries", () => {
  it("accepts 0 and 6 boundaries", () => {
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, dayOfWeek: 0 }).success,
    ).toBe(true);
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, dayOfWeek: 6 }).success,
    ).toBe(true);
  });

  it("rejects -1 and 7 just outside boundary", () => {
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, dayOfWeek: -1 }).success,
    ).toBe(false);
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, dayOfWeek: 7 }).success,
    ).toBe(false);
  });

  it("rejects non-integer dayOfWeek", () => {
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, dayOfWeek: 3.5 }).success,
    ).toBe(false);
  });
});

describe("scheduledReportCreateSchema — dayOfMonth boundaries", () => {
  it("accepts 1 and 31 boundaries", () => {
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, dayOfMonth: 1 }).success,
    ).toBe(true);
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, dayOfMonth: 31 }).success,
    ).toBe(true);
  });

  it("rejects 0 and 32 just outside boundary", () => {
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, dayOfMonth: 0 }).success,
    ).toBe(false);
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, dayOfMonth: 32 }).success,
    ).toBe(false);
  });

  it("rejects non-integer dayOfMonth", () => {
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, dayOfMonth: 15.5 })
        .success,
    ).toBe(false);
  });
});

describe("scheduledReportCreateSchema — timeOfDay HH:MM regex", () => {
  it("accepts a typical HH:MM string", () => {
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, timeOfDay: "08:30" })
        .success,
    ).toBe(true);
  });

  it("accepts boundary 00:00 and 23:59", () => {
    // Regex is \d{2}:\d{2} (no range check), so both pass formatting.
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, timeOfDay: "00:00" })
        .success,
    ).toBe(true);
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, timeOfDay: "23:59" })
        .success,
    ).toBe(true);
  });

  it("rejects single-digit hour (8:30)", () => {
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, timeOfDay: "8:30" })
        .success,
    ).toBe(false);
  });

  it("rejects missing colon (0830)", () => {
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, timeOfDay: "0830" })
        .success,
    ).toBe(false);
  });

  it("rejects non-numeric characters (ab:cd)", () => {
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, timeOfDay: "ab:cd" })
        .success,
    ).toBe(false);
  });

  it("rejects missing timeOfDay", () => {
    const { timeOfDay: _t, ...noTime } = validCreate;
    expect(scheduledReportCreateSchema.safeParse(noTime).success).toBe(false);
  });
});

describe("scheduledReportCreateSchema — recipients email array bounds", () => {
  it("accepts a single recipient (min(1) boundary)", () => {
    expect(
      scheduledReportCreateSchema.safeParse({
        ...validCreate,
        recipients: ["one@medcore.local"],
      }).success,
    ).toBe(true);
  });

  it("rejects an empty recipients array (below min(1))", () => {
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, recipients: [] }).success,
    ).toBe(false);
  });

  it("accepts a 50-element recipients array (max(50) boundary)", () => {
    const recipients = Array.from({ length: 50 }, (_, i) => `r${i}@medcore.local`);
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, recipients }).success,
    ).toBe(true);
  });

  it("rejects a 51-element recipients array (above max(50))", () => {
    const recipients = Array.from({ length: 51 }, (_, i) => `r${i}@medcore.local`);
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, recipients }).success,
    ).toBe(false);
  });

  it("rejects malformed email in recipients", () => {
    expect(
      scheduledReportCreateSchema.safeParse({
        ...validCreate,
        recipients: ["not-an-email"],
      }).success,
    ).toBe(false);
  });

  it("rejects recipients with a bad email mixed in", () => {
    expect(
      scheduledReportCreateSchema.safeParse({
        ...validCreate,
        recipients: ["ok@medcore.local", "bad-email"],
      }).success,
    ).toBe(false);
  });

  it("rejects missing recipients", () => {
    const { recipients: _r, ...noRecipients } = validCreate;
    expect(scheduledReportCreateSchema.safeParse(noRecipients).success).toBe(false);
  });
});

describe("scheduledReportCreateSchema — config + active optional fields", () => {
  it("accepts an empty config record", () => {
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, config: {} }).success,
    ).toBe(true);
  });

  it("accepts arbitrary keys/values inside config (z.any())", () => {
    expect(
      scheduledReportCreateSchema.safeParse({
        ...validCreate,
        config: { a: 1, b: "two", c: true, d: { nested: [1, 2] } },
      }).success,
    ).toBe(true);
  });

  it("rejects non-object config", () => {
    expect(
      scheduledReportCreateSchema.safeParse({
        ...validCreate,
        config: "not-an-object" as unknown as Record<string, unknown>,
      }).success,
    ).toBe(false);
  });

  it("accepts active=true and active=false", () => {
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, active: true }).success,
    ).toBe(true);
    expect(
      scheduledReportCreateSchema.safeParse({ ...validCreate, active: false }).success,
    ).toBe(true);
  });

  it("rejects non-boolean active", () => {
    expect(
      scheduledReportCreateSchema.safeParse({
        ...validCreate,
        active: "yes" as unknown as boolean,
      }).success,
    ).toBe(false);
  });
});

describe("scheduledReportUpdateSchema (partial of create)", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(scheduledReportUpdateSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a single-field update (active only)", () => {
    expect(
      scheduledReportUpdateSchema.safeParse({ active: false }).success,
    ).toBe(true);
  });

  it("accepts a name-only update at the boundary", () => {
    expect(
      scheduledReportUpdateSchema.safeParse({ name: "x".repeat(200) }).success,
    ).toBe(true);
  });

  it("still enforces field-level constraints on supplied fields", () => {
    expect(
      scheduledReportUpdateSchema.safeParse({ name: "" }).success,
    ).toBe(false);
    expect(
      scheduledReportUpdateSchema.safeParse({ timeOfDay: "8:30" }).success,
    ).toBe(false);
    expect(
      scheduledReportUpdateSchema.safeParse({ recipients: [] }).success,
    ).toBe(false);
    expect(
      scheduledReportUpdateSchema.safeParse({ dayOfWeek: 7 }).success,
    ).toBe(false);
    expect(
      scheduledReportUpdateSchema.safeParse({
        reportType: "QUARTERLY" as unknown as "CUSTOM",
      }).success,
    ).toBe(false);
  });
});

describe("dashboardPreferenceSchema accepts/rejects layout shape", () => {
  it("accepts an empty widgets array", () => {
    expect(
      dashboardPreferenceSchema.safeParse({ layout: { widgets: [] } }).success,
    ).toBe(true);
  });

  it("accepts a minimal widget (type only)", () => {
    expect(
      dashboardPreferenceSchema.safeParse({
        layout: { widgets: [{ type: "census-counter" }] },
      }).success,
    ).toBe(true);
  });

  it("accepts a fully populated widget", () => {
    expect(
      dashboardPreferenceSchema.safeParse({
        layout: {
          widgets: [
            {
              type: "revenue-chart",
              visible: true,
              order: 1,
              config: { range: "30d", currency: "INR" },
            },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it("accepts multiple widgets in the layout", () => {
    expect(
      dashboardPreferenceSchema.safeParse({
        layout: {
          widgets: [
            { type: "census-counter", order: 0 },
            { type: "revenue-chart", order: 1 },
            { type: "alerts", visible: false },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it("rejects missing layout", () => {
    expect(dashboardPreferenceSchema.safeParse({}).success).toBe(false);
  });

  it("rejects missing widgets inside layout", () => {
    expect(dashboardPreferenceSchema.safeParse({ layout: {} }).success).toBe(false);
  });

  it("rejects widget without type", () => {
    expect(
      dashboardPreferenceSchema.safeParse({
        layout: { widgets: [{ visible: true } as unknown as { type: string }] },
      }).success,
    ).toBe(false);
  });

  it("rejects non-string widget type", () => {
    expect(
      dashboardPreferenceSchema.safeParse({
        layout: {
          widgets: [{ type: 42 as unknown as string }],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects non-boolean widget.visible", () => {
    expect(
      dashboardPreferenceSchema.safeParse({
        layout: {
          widgets: [
            { type: "x", visible: "yes" as unknown as boolean },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects non-number widget.order", () => {
    expect(
      dashboardPreferenceSchema.safeParse({
        layout: {
          widgets: [{ type: "x", order: "first" as unknown as number }],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects widgets not an array", () => {
    expect(
      dashboardPreferenceSchema.safeParse({
        layout: { widgets: "not-array" as unknown as Array<{ type: string }> },
      }).success,
    ).toBe(false);
  });
});
