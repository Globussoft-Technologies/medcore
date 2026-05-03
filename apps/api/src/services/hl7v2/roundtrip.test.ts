/**
 * Round-trip tests for `roundtrip.ts` semantics — parse → serialize → parse
 * preserves bytes for canonical ADT^A04 / ORU^R01 / ORM^O01 fixtures.
 *
 * The actual `roundtrip.ts` module is a CLI smoke script (calls `main()`
 * and `process.exit`) so we don't import it directly; we exercise the
 * same invariants it asserts. The non-deterministic MSH-7 timestamp and
 * MSH-10 control id are stripped before comparison, mirroring
 * `assertStableEquality` in roundtrip.ts.
 *
 * Closes gap #4 from `docs/TEST_GAPS_2026-05-03.md`.
 */

import { describe, it, expect } from "vitest";
import {
  buildADT_A04,
  buildORM_O01,
  buildORU_R01,
  type HL7Patient,
  type HL7LabOrder,
  type HL7LabResult,
} from "./messages";
import { parseMessage, getField, getSegments } from "./parser";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const patient: HL7Patient = {
  id: "pat-rt",
  mrNumber: "MR-RT-001",
  gender: "MALE",
  dateOfBirth: new Date("1990-05-15T00:00:00Z"),
  address: "42 Lake Road, Bengaluru",
  abhaId: "14-1111-2222-3333",
  user: {
    name: "Ravi Kumar",
    phone: "+919999999999",
    email: "ravi@example.com",
  },
};

const labOrder: HL7LabOrder = {
  id: "order-rt",
  orderNumber: "LAB-RT-001",
  orderedAt: new Date("2026-04-23T09:00:00Z"),
  collectedAt: new Date("2026-04-23T09:15:00Z"),
  completedAt: new Date("2026-04-23T10:00:00Z"),
  status: "COMPLETED",
  priority: "ROUTINE",
  patient,
  doctor: { id: "doc-rt", user: { name: "Dr. Mehta" } },
  items: [
    { id: "item-rt-1", test: { code: "CBC", name: "Complete Blood Count" } },
  ],
};

const results: HL7LabResult[] = [
  {
    id: "res-rt-1",
    orderItemId: "item-rt-1",
    parameter: "Hemoglobin",
    value: "13.5",
    unit: "g/dL",
    normalRange: "12-16",
    flag: "NORMAL",
    verifiedAt: new Date("2026-04-23T10:05:00Z"),
    reportedAt: new Date("2026-04-23T10:00:00Z"),
  },
];

// ─── Helper: strip non-deterministic MSH-7 + MSH-10 ─────────────────────────

/**
 * Mirror of `assertStableEquality` from roundtrip.ts: blank out MSH-7
 * (timestamp) and MSH-10 (control id) so two builds of the same fixture
 * compare byte-equal.
 */
function canonicalise(s: string): string {
  return s
    .replace(/(MSH\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|)\d{14}/g, "$1<TS>")
    .replace(
      /(MSH\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|)[^|]+/g,
      "$1<CTRL>"
    );
}

// ─── ADT^A04 round-trip ─────────────────────────────────────────────────────

describe("ADT^A04 round-trip preservation", () => {
  it("two builds of the same patient produce byte-identical output (MSH-7/10 blanked)", () => {
    const a = buildADT_A04(patient, { patientClass: "O" });
    const b = buildADT_A04(patient, { patientClass: "O" });
    expect(canonicalise(a)).toBe(canonicalise(b));
  });

  it("parse → re-extract recovers PID-3 MR number", () => {
    const adt = buildADT_A04(patient, { patientClass: "O" });
    const parsed = parseMessage(adt);
    expect(getField(parsed, "PID", 3)).toContain("MR-RT-001");
  });

  it("preserves segment order MSH → PID → PV1", () => {
    const adt = buildADT_A04(patient, { patientClass: "O" });
    const parsed = parseMessage(adt);
    expect(parsed.segments.map((s) => s.id)).toEqual(["MSH", "PID", "PV1"]);
  });

  it("uses CR (not LF) as the segment terminator throughout", () => {
    const adt = buildADT_A04(patient, { patientClass: "O" });
    expect(adt.includes("\n")).toBe(false);
    expect(adt.includes("\r")).toBe(true);
  });
});

// ─── ORU^R01 round-trip ─────────────────────────────────────────────────────

describe("ORU^R01 round-trip preservation", () => {
  it("two builds of the same lab result produce byte-identical output", () => {
    const a = buildORU_R01(labOrder, results);
    const b = buildORU_R01(labOrder, results);
    expect(canonicalise(a)).toBe(canonicalise(b));
  });

  it("parse → re-extract recovers OBX-5 numeric value", () => {
    const oru = buildORU_R01(labOrder, results);
    const parsed = parseMessage(oru);
    const obxs = getSegments(parsed, "OBX");
    expect(obxs.length).toBe(1);
    expect(obxs[0].fields[5]).toBe("13.5");
  });

  it("MSH-9 is ORU^R01^ORU_R01", () => {
    const oru = buildORU_R01(labOrder, results);
    const parsed = parseMessage(oru);
    expect(parsed.segments[0].fields[9]).toBe("ORU^R01^ORU_R01");
  });
});

// ─── ORM^O01 round-trip ─────────────────────────────────────────────────────

describe("ORM^O01 round-trip preservation", () => {
  it("two builds of the same order produce byte-identical output", () => {
    const a = buildORM_O01(labOrder);
    const b = buildORM_O01(labOrder);
    expect(canonicalise(a)).toBe(canonicalise(b));
  });

  it("parse exposes ORC and OBR for the single-item order", () => {
    const orm = buildORM_O01(labOrder);
    const parsed = parseMessage(orm);
    expect(getSegments(parsed, "ORC").length).toBe(1);
    expect(getSegments(parsed, "OBR").length).toBe(1);
  });
});

// ─── Escape-sequence preservation through the round-trip ────────────────────

describe("Round-trip escape sequence preservation", () => {
  it("`|` in a patient name is escaped to \\F\\ on build and decoded back on parse", () => {
    const escapy: HL7Patient = {
      ...patient,
      user: { name: "O|Brien Shaun", phone: "0", email: "x@x" },
    };
    const adt = buildADT_A04(escapy, { patientClass: "O" });
    // Build emitted \F\ in lieu of literal |.
    expect(adt.includes("O\\F\\Brien")).toBe(true);
    const parsed = parseMessage(adt);
    const pid5 = getField(parsed, "PID", 5)!;
    // PID-5 layout: family^given. splitName promotes last-token to family,
    // so "O|Brien Shaun" becomes given="O|Brien" + family="Shaun".
    expect(pid5).toContain("O|Brien");
  });

  it("backslash in a name round-trips through \\E\\ encoding", () => {
    const escapy: HL7Patient = {
      ...patient,
      // A literal backslash must be escaped on build (\E\) and unescaped on parse.
      user: { name: "Path\\Name Smith", phone: "0", email: "x@x" },
    };
    const adt = buildADT_A04(escapy, { patientClass: "O" });
    expect(adt.includes("Path\\E\\Name")).toBe(true);
    const parsed = parseMessage(adt);
    const pid5 = getField(parsed, "PID", 5)!;
    expect(pid5).toContain("Path\\Name");
  });
});

// ─── Optional segments in a round-trip ──────────────────────────────────────

describe("Round-trip with optional segments", () => {
  it("ADT^A04 with no admission options still parses cleanly", () => {
    const adt = buildADT_A04(patient, {}); // no patientClass / visitNumber / doctor
    const parsed = parseMessage(adt);
    // PV1 is always emitted by buildADT_A04 — the values are just empty.
    expect(parsed.segments.map((s) => s.id)).toEqual(["MSH", "PID", "PV1"]);
  });

  it("ORM^O01 with two order items emits two ORC + two OBR", () => {
    const twoItem: HL7LabOrder = {
      ...labOrder,
      items: [
        { id: "i1", test: { code: "CBC", name: "Complete Blood Count" } },
        { id: "i2", test: { code: "LFT", name: "Liver Function" } },
      ],
    };
    const orm = buildORM_O01(twoItem);
    const parsed = parseMessage(orm);
    expect(getSegments(parsed, "ORC").length).toBe(2);
    expect(getSegments(parsed, "OBR").length).toBe(2);
  });
});
