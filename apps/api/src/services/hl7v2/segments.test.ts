/**
 * Unit tests for the HL7 v2 segment primitives in `segments.ts`.
 *
 * `messages.test.ts` covers the high-frequency MSH/PID positional shape;
 * this file targets the rest of the segment builders (PV1, ORC, OBR, OBX,
 * NTE), the field-accessor contract via re-parsing, and the boundary
 * behaviour of empty / undefined inputs vs. the placeholder slots HL7
 * requires us to keep in place.
 *
 * Closes gap #4 from `docs/TEST_GAPS_2026-05-03.md`.
 */

import { describe, it, expect } from "vitest";
import {
  PID,
  PV1,
  ORC,
  OBR,
  OBX,
  NTE,
  MSH,
  escapeField,
  unescapeField,
  formatTs,
  formatDate,
  FIELD_SEP,
  COMPONENT_SEP,
  REPETITION_SEP,
  ENCODING_CHARS,
  HL7_VERSION,
} from "./segments";

// ─── Required-field rendering ───────────────────────────────────────────────

describe("PID — required field rendering", () => {
  it("PID-3 (patient identifier) carries the MR number in component 1", () => {
    const seg = PID({
      mrNumber: "MR-9999",
      familyName: "Doe",
      givenName: "Jane",
      gender: "F",
    });
    const parts = seg.split(FIELD_SEP);
    // parts[0]=PID, parts[1]=set-id, parts[3]=PID-3
    const pid3 = parts[3];
    const components = pid3.split(COMPONENT_SEP);
    expect(components[0]).toBe("MR-9999");
    // Standard MR triplet identifier-typeCode.
    expect(components[3]).toBe("MR");
    expect(components[4]).toBe("MR");
  });

  it("PID-3 includes ABHA as a second repetition when provided", () => {
    const seg = PID({
      mrNumber: "MR-1",
      familyName: "Doe",
      givenName: "Jane",
      gender: "F",
      abhaId: "14-0001-0002-0003",
    });
    const parts = seg.split(FIELD_SEP);
    const reps = parts[3].split(REPETITION_SEP);
    expect(reps.length).toBe(2);
    expect(reps[0].startsWith("MR-1")).toBe(true);
    // ABHA identifier triplet.
    expect(reps[1]).toContain("14-0001-0002-0003");
    expect(reps[1].endsWith("ABHA^NI")).toBe(true);
  });

  it("PID-3 carries the MR even when the MR number contains reserved chars (escaped)", () => {
    const seg = PID({
      mrNumber: "MR|1", // literal pipe — must escape to \F\
      familyName: "Doe",
      givenName: "Jane",
      gender: "F",
    });
    const parts = seg.split(FIELD_SEP);
    expect(parts[3].startsWith("MR\\F\\1")).toBe(true);
    // And the escape round-trips back to the original on unescape.
    const components = parts[3].split(COMPONENT_SEP);
    expect(unescapeField(components[0])).toBe("MR|1");
  });
});

describe("PV1 — required patient class", () => {
  it("PV1-2 emits the patientClass code verbatim (O=Outpatient)", () => {
    const seg = PV1({ patientClass: "O" });
    const parts = seg.split(FIELD_SEP);
    expect(parts[0]).toBe("PV1");
    // parts[1] = PV1-1 set id; parts[2] = PV1-2 patient class.
    expect(parts[2]).toBe("O");
  });

  it("PV1-2 supports all enum values without alteration", () => {
    for (const code of ["I", "O", "E", "R", "P", "B", "N"] as const) {
      const seg = PV1({ patientClass: code });
      expect(seg.split(FIELD_SEP)[2]).toBe(code);
    }
  });

  it("PV1-3 assignedLocation renders as pointOfCare^room^bed^facility", () => {
    const seg = PV1({
      patientClass: "I",
      assignedLocation: {
        pointOfCare: "WARD-A",
        room: "101",
        bed: "1",
        facility: "MAIN",
      },
    });
    const parts = seg.split(FIELD_SEP);
    expect(parts[3]).toBe("WARD-A^101^1^MAIN");
  });

  it("PV1-44 admit datetime renders as YYYYMMDDHHMMSS when provided", () => {
    const seg = PV1({
      patientClass: "I",
      admitDateTime: new Date("2026-04-23T15:30:00Z"),
    });
    const parts = seg.split(FIELD_SEP);
    // PV1-44 is at index 44 (after segment id at 0). 1=set-id ... 44=admit.
    expect(parts[44]).toBe("20260423153000");
  });
});

// ─── OBR — set id and order linkage ─────────────────────────────────────────

describe("OBR — required set ID and identifiers", () => {
  it("OBR-1 (set ID) is rendered as a positive integer string", () => {
    const seg = OBR({
      setId: 1,
      placerOrderNumber: "PLACER-42",
      testCode: "CBC",
      testName: "Complete Blood Count",
    });
    const parts = seg.split(FIELD_SEP);
    // parts[0]=OBR, parts[1]=OBR-1 set-id.
    expect(parts[1]).toBe("1");
    // OBR-2 is the placer order number.
    expect(parts[2]).toBe("PLACER-42");
  });

  it("OBR-4 universal service identifier carries code^name^codingSystem", () => {
    const seg = OBR({
      setId: 1,
      placerOrderNumber: "P-1",
      testCode: "LFT",
      testName: "Liver Function",
      codingSystem: "LN",
    });
    const parts = seg.split(FIELD_SEP);
    expect(parts[4]).toBe("LFT^Liver Function^LN");
  });

  it("OBR coerces a higher setId to its string form (multi-OBR per ORM)", () => {
    const seg = OBR({
      setId: 3,
      placerOrderNumber: "P-1",
      testCode: "CBC",
      testName: "CBC",
    });
    expect(seg.split(FIELD_SEP)[1]).toBe("3");
  });
});

// ─── ORC — order control ────────────────────────────────────────────────────

describe("ORC — order control + placer order", () => {
  it("ORC-1 carries the order control code and ORC-2 the placer order number", () => {
    const seg = ORC({
      orderControl: "NW",
      placerOrderNumber: "PLACER-100",
      orderStatus: "SC",
    });
    const parts = seg.split(FIELD_SEP);
    expect(parts[0]).toBe("ORC");
    expect(parts[1]).toBe("NW");
    expect(parts[2]).toBe("PLACER-100");
    // ORC-5 = order status.
    expect(parts[5]).toBe("SC");
  });

  it("ORC-12 ordering provider renders id^family^given when present", () => {
    const seg = ORC({
      orderControl: "NW",
      placerOrderNumber: "P-1",
      orderingProvider: { id: "DOC-1", familyName: "Mehta", givenName: "Aditi" },
    });
    const parts = seg.split(FIELD_SEP);
    expect(parts[12]).toBe("DOC-1^Mehta^Aditi");
  });
});

// ─── OBX — value type + result content ──────────────────────────────────────

describe("OBX — observation value rendering", () => {
  it("OBX-1 set ID, OBX-2 value type, OBX-3 obs id, OBX-5 value, OBX-6 units", () => {
    const seg = OBX({
      setId: 1,
      valueType: "NM",
      code: "HGB",
      name: "Hemoglobin",
      codingSystem: "LN",
      value: "13.5",
      units: "g/dL",
      referenceRange: "12-16",
      abnormalFlags: "N",
      resultStatus: "F",
    });
    const parts = seg.split(FIELD_SEP);
    expect(parts[1]).toBe("1");
    expect(parts[2]).toBe("NM");
    expect(parts[3]).toBe("HGB^Hemoglobin^LN");
    expect(parts[5]).toBe("13.5");
    expect(parts[6]).toBe("g/dL");
    expect(parts[7]).toBe("12-16");
    expect(parts[8]).toBe("N");
    expect(parts[11]).toBe("F");
  });

  it("OBX numeric value (number type) is stringified at OBX-5", () => {
    const seg = OBX({
      setId: 1,
      valueType: "NM",
      code: "HGB",
      name: "Hemoglobin",
      value: 13.5,
      resultStatus: "F",
    });
    expect(seg.split(FIELD_SEP)[5]).toBe("13.5");
  });
});

// ─── NTE — comments ─────────────────────────────────────────────────────────

describe("NTE — comment rendering", () => {
  it("NTE renders setId | source | escaped comment", () => {
    const seg = NTE({ setId: 1, source: "L", comment: "Repeat tomorrow" });
    const parts = seg.split(FIELD_SEP);
    expect(parts[0]).toBe("NTE");
    expect(parts[1]).toBe("1");
    expect(parts[2]).toBe("L");
    expect(parts[3]).toBe("Repeat tomorrow");
  });

  it("NTE escapes a `|` in the comment to \\F\\ so it does not split the field", () => {
    const seg = NTE({ setId: 1, comment: "see notes | follow up" });
    const parts = seg.split(FIELD_SEP);
    // The comment has been escaped — there are no extra | tokens.
    expect(parts.length).toBe(4);
    expect(parts[3]).toBe("see notes \\F\\ follow up");
    // Round-trip via unescape.
    expect(unescapeField(parts[3])).toBe("see notes | follow up");
  });
});

// ─── Optional / absent fields → empty positions ─────────────────────────────

describe("Optional fields render as empty positions, not undefined", () => {
  it("PID with no DOB / phone leaves PID-7 / PID-13 empty (no `undefined` literal)", () => {
    const seg = PID({
      mrNumber: "MR-1",
      familyName: "Doe",
      givenName: "Jane",
      gender: "F",
    });
    const parts = seg.split(FIELD_SEP);
    expect(parts[7]).toBe(""); // PID-7 DOB
    expect(parts[13]).toBe(""); // PID-13 phone
    expect(seg.includes("undefined")).toBe(false);
  });

  it("PV1 with no admit / discharge times leaves PV1-44 / PV1-45 empty", () => {
    const seg = PV1({ patientClass: "O" });
    const parts = seg.split(FIELD_SEP);
    expect(parts[44]).toBe("");
    expect(parts[45]).toBe("");
    expect(seg.includes("undefined")).toBe(false);
  });

  it("OBX with no units / range / flags leaves OBX-6/7/8 empty", () => {
    const seg = OBX({
      setId: 1,
      valueType: "ST",
      code: "C",
      name: "Color",
      value: "Yellow",
      resultStatus: "F",
    });
    const parts = seg.split(FIELD_SEP);
    expect(parts[6]).toBe("");
    expect(parts[7]).toBe("");
    expect(parts[8]).toBe("");
  });
});

// ─── Field accessors via known message ──────────────────────────────────────

describe("Field accessors return correct values for a known message", () => {
  it("MSH builder produces a header with field separator + encoding chars at fixed positions", () => {
    const msh = MSH({
      sendingApplication: "APP",
      sendingFacility: "FAC",
      receivingApplication: "RAPP",
      receivingFacility: "RFAC",
      timestamp: new Date("2026-04-23T10:00:00Z"),
      messageType: { code: "ADT", trigger: "A04", structure: "ADT_A01" },
      controlId: "CID-1",
    });
    expect(msh.startsWith(`MSH${FIELD_SEP}${ENCODING_CHARS}${FIELD_SEP}`)).toBe(
      true
    );
    const parts = msh.split(FIELD_SEP);
    expect(parts[6]).toBe("20260423100000"); // MSH-7 timestamp
    expect(parts[8]).toBe("ADT^A04^ADT_A01"); // MSH-9 message type
    expect(parts[9]).toBe("CID-1"); // MSH-10 control id
    expect(parts[11]).toBe(HL7_VERSION); // MSH-12 version
  });

  it("formatTs / formatDate produce stable UTC strings", () => {
    expect(formatTs(new Date("2026-04-23T14:05:30Z"))).toBe("20260423140530");
    expect(formatDate(new Date("2026-04-23T14:05:30Z"))).toBe("20260423");
    expect(formatTs(undefined)).toBe("");
    expect(formatTs("not-a-date")).toBe("");
  });
});

// ─── Escape round-trip ─────────────────────────────────────────────────────

describe("escapeField + unescapeField round-trip", () => {
  it("each reserved delimiter survives an encode/decode cycle", () => {
    for (const ch of ["|", "^", "~", "&", "\\"]) {
      const input = `before${ch}after`;
      expect(unescapeField(escapeField(input))).toBe(input);
    }
  });
});
