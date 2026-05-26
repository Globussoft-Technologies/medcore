// Coverage tests for the Pearl §3.1 (gap row 74) bulk-edit doctor-appointment-mode
// validation schema.
// What: exhaustive happy / invalid / edge cases for the two exported Zod schemas
//   (bulkUpdateDoctorsUpdatesSchema + bulkUpdateDoctorsSchema) and the
//   BULK_UPDATE_ALLOWED_FIELDS allowlist constant.
// Which modules: imports only from ../doctor-bulk-update.
// Why: file shipped with 0% colocated coverage. The schema is the security-critical
//   mass-assignment guard for POST /api/v1/doctors/bulk-update — a regression here
//   could silently let an admin payload mutate fields like `commissionPercent` or
//   `isActive` outside the allowlist. Particularly important to lock in:
//   (a) `.strict()` rejecting unknown keys on `updates` (mass-assignment guard),
//   (b) the `.refine()` requiring at least one updates field (no-op guard),
//   (c) doctorIds min(1) / max(100) bounds (transaction-size guard),
//   (d) uuid-OR-cuid acceptance on doctorIds (fixture compatibility),
//   (e) every per-field nullable + numeric / enum boundary on `updates`.
import { describe, it, expect } from "vitest";
import {
  BULK_UPDATE_ALLOWED_FIELDS,
  bulkUpdateDoctorsUpdatesSchema,
  bulkUpdateDoctorsSchema,
} from "../doctor-bulk-update";

const UUID = "550e8400-e29b-41d4-a716-446655441111";
const UUID_2 = "550e8400-e29b-41d4-a716-446655442222";
// canonical 25-char cuid sample (cuid v1 shape: c + 24 lowercase alphanumeric chars)
const CUID = "ckvabcd1234567890abcdefgh";
const CUID_2 = "ckvabcd9876543210zyxwvutsr";

// ───────────────────────────────────────────────────────
// BULK_UPDATE_ALLOWED_FIELDS — allowlist constant
// ───────────────────────────────────────────────────────

describe("BULK_UPDATE_ALLOWED_FIELDS", () => {
  it("contains each documented bulk-editable column", () => {
    expect(BULK_UPDATE_ALLOWED_FIELDS).toEqual([
      "appointmentMode",
      "tokenPrefix",
      "tokenStartNumber",
      "dailyAppointmentLimit",
      "nearTurnAlertThreshold",
      "lastHourPolicy",
    ]);
  });
  it("exports a readonly tuple (length 6)", () => {
    expect(BULK_UPDATE_ALLOWED_FIELDS.length).toBe(6);
  });
  it("every entry is a string", () => {
    for (const f of BULK_UPDATE_ALLOWED_FIELDS) {
      expect(typeof f).toBe("string");
    }
  });
  it("does not contain mass-assignment-prone columns", () => {
    // Negative guard: if anyone adds e.g. `commissionPercent` or `isActive` to the
    // allowlist, this test forces the change to be intentional + reviewed.
    for (const danger of [
      "commissionPercent",
      "isActive",
      "userId",
      "tenantId",
      "id",
      "password",
      "email",
    ]) {
      expect(BULK_UPDATE_ALLOWED_FIELDS).not.toContain(danger);
    }
  });
});

// ───────────────────────────────────────────────────────
// bulkUpdateDoctorsUpdatesSchema — the per-field `updates` object
// ───────────────────────────────────────────────────────

describe("bulkUpdateDoctorsUpdatesSchema — happy paths", () => {
  it("accepts a single-key patch (appointmentMode only)", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ appointmentMode: "SLOT" }).success
    ).toBe(true);
  });
  it("accepts each appointmentMode enum value", () => {
    for (const m of ["CALLING", "TOKEN", "SLOT"]) {
      expect(
        bulkUpdateDoctorsUpdatesSchema.safeParse({ appointmentMode: m }).success
      ).toBe(true);
    }
  });
  it("accepts each lastHourPolicy enum value", () => {
    for (const p of ["ACCEPT_ALL", "BLOCK_NEW", "WALK_IN_ONLY"]) {
      expect(
        bulkUpdateDoctorsUpdatesSchema.safeParse({ lastHourPolicy: p }).success
      ).toBe(true);
    }
  });
  it("accepts a fully-populated patch (every allowlist key set)", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({
        appointmentMode: "TOKEN",
        tokenPrefix: "O",
        tokenStartNumber: 1,
        dailyAppointmentLimit: 40,
        nearTurnAlertThreshold: 5,
        lastHourPolicy: "BLOCK_NEW",
      }).success
    ).toBe(true);
  });
  it("accepts nullable fields explicitly set to null (reset semantics)", () => {
    // Each nullable field can be set to null to unset / reset the column on the
    // doctor row. This is the canonical "clear me" shape.
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({
        tokenPrefix: null,
        tokenStartNumber: null,
        dailyAppointmentLimit: null,
        nearTurnAlertThreshold: null,
        lastHourPolicy: null,
      }).success
    ).toBe(true);
  });
});

describe("bulkUpdateDoctorsUpdatesSchema — strict-mode mass-assignment guard", () => {
  it("rejects an unknown key (commissionPercent — not in allowlist)", () => {
    const r = bulkUpdateDoctorsUpdatesSchema.safeParse({
      appointmentMode: "SLOT",
      commissionPercent: 99,
    } as any);
    expect(r.success).toBe(false);
  });
  it("rejects an unknown key (isActive — not in allowlist)", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({
        appointmentMode: "SLOT",
        isActive: false,
      } as any).success
    ).toBe(false);
  });
  it("rejects an unknown key (id — not in allowlist)", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({
        appointmentMode: "SLOT",
        id: UUID,
      } as any).success
    ).toBe(false);
  });
  it("rejects a typo (tokenPrefixxx — silent no-op guard)", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({
        tokenPrefixxx: "O",
      } as any).success
    ).toBe(false);
  });
  it("rejects a payload containing only unknown keys", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ foo: "bar" } as any).success
    ).toBe(false);
  });
});

describe("bulkUpdateDoctorsUpdatesSchema — refine: at least one field required", () => {
  it("rejects an empty object (no fields)", () => {
    const r = bulkUpdateDoctorsUpdatesSchema.safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) =>
          /updates must contain at least one field/.test(i.message)
        )
      ).toBe(true);
    }
  });
});

describe("bulkUpdateDoctorsUpdatesSchema — per-field validation", () => {
  // appointmentMode
  it("rejects unknown appointmentMode enum", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({
        appointmentMode: "TOKENS" as any,
      }).success
    ).toBe(false);
  });
  it("rejects non-string appointmentMode", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ appointmentMode: 1 as any }).success
    ).toBe(false);
  });
  // tokenPrefix
  it("accepts tokenPrefix at empty string (no min — only max(8))", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ tokenPrefix: "" }).success
    ).toBe(true);
  });
  it("accepts tokenPrefix at exactly 8 chars (max boundary)", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ tokenPrefix: "ABCDEFGH" }).success
    ).toBe(true);
  });
  it("rejects tokenPrefix longer than 8 chars", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ tokenPrefix: "ABCDEFGHI" }).success
    ).toBe(false);
  });
  it("rejects non-string tokenPrefix", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ tokenPrefix: 42 as any }).success
    ).toBe(false);
  });
  // tokenStartNumber
  it("accepts tokenStartNumber at boundary 1", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ tokenStartNumber: 1 }).success
    ).toBe(true);
  });
  it("accepts tokenStartNumber at boundary 99999", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ tokenStartNumber: 99999 }).success
    ).toBe(true);
  });
  it("rejects tokenStartNumber = 0 (below min)", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ tokenStartNumber: 0 }).success
    ).toBe(false);
  });
  it("rejects tokenStartNumber = 100000 (above max)", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ tokenStartNumber: 100000 }).success
    ).toBe(false);
  });
  it("rejects non-integer tokenStartNumber", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ tokenStartNumber: 1.5 }).success
    ).toBe(false);
  });
  it("rejects negative tokenStartNumber", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ tokenStartNumber: -1 }).success
    ).toBe(false);
  });
  // dailyAppointmentLimit
  it("accepts dailyAppointmentLimit at boundary 1", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ dailyAppointmentLimit: 1 }).success
    ).toBe(true);
  });
  it("accepts dailyAppointmentLimit at boundary 500", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ dailyAppointmentLimit: 500 }).success
    ).toBe(true);
  });
  it("rejects dailyAppointmentLimit = 0 (below min)", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ dailyAppointmentLimit: 0 }).success
    ).toBe(false);
  });
  it("rejects dailyAppointmentLimit = 501 (above max)", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ dailyAppointmentLimit: 501 }).success
    ).toBe(false);
  });
  it("rejects non-integer dailyAppointmentLimit", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ dailyAppointmentLimit: 40.5 }).success
    ).toBe(false);
  });
  // nearTurnAlertThreshold
  it("accepts nearTurnAlertThreshold at boundary 1", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ nearTurnAlertThreshold: 1 }).success
    ).toBe(true);
  });
  it("accepts nearTurnAlertThreshold at boundary 50", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ nearTurnAlertThreshold: 50 }).success
    ).toBe(true);
  });
  it("rejects nearTurnAlertThreshold = 0 (below min)", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ nearTurnAlertThreshold: 0 }).success
    ).toBe(false);
  });
  it("rejects nearTurnAlertThreshold = 51 (above max)", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ nearTurnAlertThreshold: 51 }).success
    ).toBe(false);
  });
  it("rejects non-integer nearTurnAlertThreshold", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({ nearTurnAlertThreshold: 5.5 }).success
    ).toBe(false);
  });
  // lastHourPolicy
  it("rejects unknown lastHourPolicy enum", () => {
    expect(
      bulkUpdateDoctorsUpdatesSchema.safeParse({
        lastHourPolicy: "DEFER" as any,
      }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// bulkUpdateDoctorsSchema — full request envelope
// ───────────────────────────────────────────────────────

describe("bulkUpdateDoctorsSchema — happy paths", () => {
  const validUpdates = { appointmentMode: "SLOT" as const };
  it("accepts a single-uuid doctorIds + minimal updates", () => {
    expect(
      bulkUpdateDoctorsSchema.safeParse({
        doctorIds: [UUID],
        updates: validUpdates,
      }).success
    ).toBe(true);
  });
  it("accepts a single-cuid doctorIds", () => {
    expect(
      bulkUpdateDoctorsSchema.safeParse({
        doctorIds: [CUID],
        updates: validUpdates,
      }).success
    ).toBe(true);
  });
  it("accepts a mixed-shape doctorIds (uuid + cuid in same array)", () => {
    // The union `z.string().uuid().or(z.string().cuid())` is per-element, so a
    // mixed array is legal — fixtures historically mint either shape.
    expect(
      bulkUpdateDoctorsSchema.safeParse({
        doctorIds: [UUID, CUID, UUID_2, CUID_2],
        updates: validUpdates,
      }).success
    ).toBe(true);
  });
  it("accepts a multi-uuid doctorIds with a multi-field updates", () => {
    expect(
      bulkUpdateDoctorsSchema.safeParse({
        doctorIds: [UUID, UUID_2],
        updates: {
          appointmentMode: "SLOT",
          dailyAppointmentLimit: 40,
          lastHourPolicy: "BLOCK_NEW",
        },
      }).success
    ).toBe(true);
  });
  it("accepts doctorIds at exactly the max boundary (100)", () => {
    const ids = Array.from({ length: 100 }, () => UUID);
    expect(
      bulkUpdateDoctorsSchema.safeParse({ doctorIds: ids, updates: validUpdates })
        .success
    ).toBe(true);
  });
});

describe("bulkUpdateDoctorsSchema — doctorIds bounds", () => {
  const validUpdates = { appointmentMode: "SLOT" as const };
  it("rejects empty doctorIds array (min 1)", () => {
    const r = bulkUpdateDoctorsSchema.safeParse({
      doctorIds: [],
      updates: validUpdates,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) =>
          /doctorIds must contain at least one id/.test(i.message)
        )
      ).toBe(true);
    }
  });
  it("rejects doctorIds longer than 100 (max boundary +1)", () => {
    const ids = Array.from({ length: 101 }, () => UUID);
    const r = bulkUpdateDoctorsSchema.safeParse({
      doctorIds: ids,
      updates: validUpdates,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) =>
          /doctorIds may not exceed 100 entries per request/.test(i.message)
        )
      ).toBe(true);
    }
  });
  it("rejects non-uuid + non-cuid id in array", () => {
    expect(
      bulkUpdateDoctorsSchema.safeParse({
        doctorIds: ["not-an-id"],
        updates: validUpdates,
      }).success
    ).toBe(false);
  });
  it("rejects a doctorIds array containing one valid + one invalid id", () => {
    expect(
      bulkUpdateDoctorsSchema.safeParse({
        doctorIds: [UUID, "garbage"],
        updates: validUpdates,
      }).success
    ).toBe(false);
  });
  it("rejects non-array doctorIds (single string)", () => {
    expect(
      bulkUpdateDoctorsSchema.safeParse({
        doctorIds: UUID as any,
        updates: validUpdates,
      }).success
    ).toBe(false);
  });
  it("rejects missing doctorIds key", () => {
    expect(
      bulkUpdateDoctorsSchema.safeParse({ updates: validUpdates } as any).success
    ).toBe(false);
  });
});

describe("bulkUpdateDoctorsSchema — updates envelope wiring", () => {
  it("rejects missing updates key", () => {
    expect(
      bulkUpdateDoctorsSchema.safeParse({ doctorIds: [UUID] } as any).success
    ).toBe(false);
  });
  it("rejects empty updates object (propagates inner refine)", () => {
    expect(
      bulkUpdateDoctorsSchema.safeParse({ doctorIds: [UUID], updates: {} }).success
    ).toBe(false);
  });
  it("rejects unknown key in updates (propagates strict mode)", () => {
    expect(
      bulkUpdateDoctorsSchema.safeParse({
        doctorIds: [UUID],
        updates: { appointmentMode: "SLOT", commissionPercent: 99 } as any,
      }).success
    ).toBe(false);
  });
  it("rejects invalid per-field value in updates (propagates inner schema)", () => {
    expect(
      bulkUpdateDoctorsSchema.safeParse({
        doctorIds: [UUID],
        updates: { dailyAppointmentLimit: 501 },
      }).success
    ).toBe(false);
  });
});
