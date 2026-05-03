/**
 * Unit tests for the HL7 v2 parser primitives in `parser.ts`.
 *
 * `messages.test.ts` exercises the parser end-to-end via the message
 * builders. This file targets the parser's own contract: pipe-delimited
 * splitting, MSH-2 encoding-character extraction, escape-sequence
 * round-tripping (\F\ \S\ \T\ \R\ \E\), repetition (~), subcomponents (&),
 * empty fields, MSH-only messages, and tolerance for CRLF / mixed
 * terminators. Closes gap #4 from `docs/TEST_GAPS_2026-05-03.md`.
 */

import { describe, it, expect } from "vitest";
import {
  parseMessage,
  parseComponents,
  getField,
  getComponent,
  getSegments,
  extractMessageType,
  getControlId,
  getPid3MrNumber,
  getPid5Name,
  getPlacerOrderNumber,
} from "./parser";

// ─── Canonical fixtures ─────────────────────────────────────────────────────

const MSH_ADT_A04 =
  "MSH|^~\\&|MEDCORE|MEDCORE_HIS|LAB|LAB01|20260423100000||ADT^A04^ADT_A01|CTRL-ADT-1|P|2.5.1|||||||UNICODE UTF-8";
const MSH_ORU_R01 =
  "MSH|^~\\&|LAB|LAB_FAC|MEDCORE|MEDCORE_HIS|20260423100000||ORU^R01^ORU_R01|CTRL-ORU-1|P|2.5.1|||||||UNICODE UTF-8";
const MSH_ORM_O01 =
  "MSH|^~\\&|MEDCORE|MEDCORE_HIS|LAB|LAB_FAC|20260423100000||ORM^O01^ORM_O01|CTRL-ORM-1|P|2.5.1|||||||UNICODE UTF-8";

const PID_BASIC = "PID|1||MR-100^^^MR^MR||Sharma^Arjun||19850615|M";
const PV1_OUTPATIENT = "PV1|1|O";

// ─── Pipe-delimited message parsing ─────────────────────────────────────────

describe("parseMessage — canonical message types", () => {
  it("parses a canonical ADT^A04 into MSH + PID + PV1 segments in order", () => {
    const raw = [MSH_ADT_A04, PID_BASIC, PV1_OUTPATIENT].join("\r");
    const parsed = parseMessage(raw);
    expect(parsed.segments.map((s) => s.id)).toEqual(["MSH", "PID", "PV1"]);
  });

  it("parses a canonical ORU^R01 into MSH + PID + OBR + OBX (×2)", () => {
    const raw = [
      MSH_ORU_R01,
      PID_BASIC,
      "OBR|1|PLACER-1||CBC^Complete Blood Count^LN",
      "OBX|1|NM|HGB^Hemoglobin^LN||13.5|g/dL|12-16|N|||F",
      "OBX|2|NM|WBC^WBC Count^LN||7.2|10^3/uL|4-11|N|||F",
    ].join("\r");
    const parsed = parseMessage(raw);
    expect(parsed.segments.map((s) => s.id)).toEqual([
      "MSH",
      "PID",
      "OBR",
      "OBX",
      "OBX",
    ]);
    expect(getSegments(parsed, "OBX").length).toBe(2);
    expect(extractMessageType(parsed)).toEqual({
      msgType: "ORU",
      trigger: "R01",
      structure: "ORU_R01",
    });
  });

  it("parses a canonical ORM^O01 with ORC + OBR pair", () => {
    const raw = [
      MSH_ORM_O01,
      PID_BASIC,
      "ORC|NW|PLACER-1||||SC",
      "OBR|1|PLACER-1||CBC^Complete Blood Count^LN|||20260423094500",
    ].join("\r");
    const parsed = parseMessage(raw);
    expect(parsed.segments.map((s) => s.id)).toEqual([
      "MSH",
      "PID",
      "ORC",
      "OBR",
    ]);
    expect(getPlacerOrderNumber(parsed)).toBe("PLACER-1");
  });
});

// ─── Escape-sequence handling ───────────────────────────────────────────────

describe("parseMessage — escape sequences", () => {
  it("unescapes \\F\\ to | inside a field", () => {
    const raw = [MSH_ADT_A04, "PID|1||MR-1^^^MR^MR||O\\F\\Brien^Anne"].join(
      "\r"
    );
    const parsed = parseMessage(raw);
    const family = getComponent(parsed, "PID", 5, 1);
    expect(family).toBe("O|Brien");
  });

  it("unescapes \\S\\ to ^ at the field level", () => {
    // Note: parseSegment unescapes the WHOLE field before component-splitting,
    // so an escaped ^ at field level is indistinguishable from a real
    // component separator on the returned `fields[]`. Verify the unescape
    // happened on a single-component field — that's the contract this layer
    // exposes. Component-level escape preservation is documented as
    // "split-then-unescape" via parseComponents (see parser.ts §parseComponents).
    const raw = [MSH_ADT_A04, "PID|1||MR-1^^^MR^MR||family|a\\S\\b"].join(
      "\r"
    );
    const parsed = parseMessage(raw);
    // PID-6 (mother's maiden name slot here) is a single field with a
    // literal ^ produced by \S\ — getField returns it as "a^b".
    expect(getField(parsed, "PID", 6)).toBe("a^b");
  });

  it("unescapes \\T\\ to & inside a field", () => {
    const raw = [MSH_ADT_A04, "PID|1||MR-1^^^MR^MR||x\\T\\y^Anne"].join("\r");
    const parsed = parseMessage(raw);
    expect(getComponent(parsed, "PID", 5, 1)).toBe("x&y");
  });

  it("unescapes \\R\\ to ~ inside a field", () => {
    const raw = [MSH_ADT_A04, "PID|1||MR-1^^^MR^MR||p\\R\\q^Anne"].join("\r");
    const parsed = parseMessage(raw);
    expect(getComponent(parsed, "PID", 5, 1)).toBe("p~q");
  });

  it("unescapes \\E\\ to a single backslash without double-processing", () => {
    // a\E\b should round-trip to a\b — and the \E\ must be processed AFTER the
    // other sequences so we don't accidentally re-trigger \F\ etc.
    const raw = [MSH_ADT_A04, "PID|1||MR-1^^^MR^MR||a\\E\\b^c"].join("\r");
    const parsed = parseMessage(raw);
    expect(getComponent(parsed, "PID", 5, 1)).toBe("a\\b");
  });
});

// ─── Empty fields / repetition / subcomponents ──────────────────────────────

describe("parseMessage — empty fields, repetition, subcomponents", () => {
  it("represents `||` empty positions as empty strings (not undefined)", () => {
    // PID|1||MR^^^MR^MR||family^given||| leaves PID-2, PID-4, PID-6 empty.
    const raw = [
      MSH_ADT_A04,
      "PID|1||MR-1^^^MR^MR||Sharma^Arjun|||",
    ].join("\r");
    const parsed = parseMessage(raw);
    const pid = parsed.segments.find((s) => s.id === "PID")!;
    expect(pid.fields[1]).toBe("1");
    expect(pid.fields[2]).toBe("");
    expect(pid.fields[4]).toBe("");
    expect(pid.fields[6]).toBe("");
    // Type assertion: explicit empty string, never undefined.
    expect(typeof pid.fields[6]).toBe("string");
  });

  it("represents PID-3 repetition as a single ~ separated string at the field level", () => {
    // PID-3 with two repetitions: primary MR and ABHA.
    const raw = [
      MSH_ADT_A04,
      "PID|1||MR-1^^^MR^MR~14-1234-5678-9012^^^ABHA^NI||Sharma^Arjun",
    ].join("\r");
    const parsed = parseMessage(raw);
    const pid3 = getField(parsed, "PID", 3)!;
    // Field-level: split on the parser's recorded repetition delimiter.
    const reps = pid3.split(parsed.delimiters.repetition);
    expect(reps.length).toBe(2);
    expect(reps[0].startsWith("MR-1")).toBe(true);
    expect(reps[1].startsWith("14-1234")).toBe(true);
    // getPid3MrNumber takes the first repetition's first component.
    expect(getPid3MrNumber(parsed)).toBe("MR-1");
  });

  it("preserves subcomponent (&) values inside a component", () => {
    // PID-11 address; line carries a subcomponent (addr1&apt2).
    // Field positions after the segment id: 1=set-id, 2=ext, 3=pid3,
    // 4=alt, 5=pid5, 6=maiden, 7=dob, 8=sex, 9=alias, 10=race, 11=addr.
    const raw = [
      MSH_ADT_A04,
      "PID|1||MR-1^^^MR^MR||Sharma^Arjun||19850615|M|||addr1&apt2^^Kolkata",
    ].join("\r");
    const parsed = parseMessage(raw);
    const pid11 = getField(parsed, "PID", 11)!;
    expect(pid11).toBe("addr1&apt2^^Kolkata");
    const components = parseComponents(pid11);
    expect(components[0]).toBe("addr1&apt2");
    // Subcomponent split is the consumer's job, not the parser's, but we
    // can still verify the & survived round-trip through the parser.
    const subs = components[0].split(parsed.delimiters.subcomponent);
    expect(subs).toEqual(["addr1", "apt2"]);
  });
});

// ─── MSH-only / structural error cases ──────────────────────────────────────

describe("parseMessage — structural edge cases", () => {
  it("parses an MSH-only message without errors", () => {
    const parsed = parseMessage(MSH_ADT_A04);
    expect(parsed.segments.length).toBe(1);
    expect(parsed.segments[0].id).toBe("MSH");
    // MSH-1 (field separator) and MSH-2 (encoding chars) decoded.
    expect(parsed.delimiters.field).toBe("|");
    expect(parsed.delimiters.component).toBe("^");
    expect(parsed.delimiters.repetition).toBe("~");
    expect(parsed.delimiters.escape).toBe("\\");
    expect(parsed.delimiters.subcomponent).toBe("&");
  });

  it("throws when the message does not start with MSH", () => {
    expect(() => parseMessage("PID|1||MR-1")).toThrow(
      /must start with MSH/
    );
  });

  it("throws when the input is empty", () => {
    expect(() => parseMessage("")).toThrow(/must start with MSH/);
  });

  it("extractMessageType throws on a malformed MSH-9 (CODE only, no trigger)", () => {
    // MSH-9 = "ADT" only — no trigger event.
    const raw =
      "MSH|^~\\&|APP|FAC|RECV|RFAC|20260423100000||ADT|CTRL-1|P|2.5.1";
    const parsed = parseMessage(raw);
    expect(() => extractMessageType(parsed)).toThrow(/malformed MSH-9/);
  });

  it("tolerates trailing CR and CRLF mixed terminators", () => {
    // Mixed: CRLF between MSH and PID, then a trailing CR — the parser
    // splits on /\r\n|\r|\n/ and filters empty lines.
    const raw = `${MSH_ADT_A04}\r\n${PID_BASIC}\r${PV1_OUTPATIENT}\r`;
    const parsed = parseMessage(raw);
    expect(parsed.segments.map((s) => s.id)).toEqual(["MSH", "PID", "PV1"]);
    // And PID payload survived the line-splitting.
    expect(getPid3MrNumber(parsed)).toBe("MR-100");
  });

  it("tolerates a bare LF as segment terminator (legacy senders)", () => {
    const raw = [MSH_ADT_A04, PID_BASIC].join("\n");
    const parsed = parseMessage(raw);
    expect(parsed.segments.map((s) => s.id)).toEqual(["MSH", "PID"]);
  });
});

// ─── Helper accessors ───────────────────────────────────────────────────────

describe("parser helpers", () => {
  const raw = [MSH_ADT_A04, PID_BASIC, PV1_OUTPATIENT].join("\r");
  const parsed = parseMessage(raw);

  it("getControlId returns MSH-10", () => {
    expect(getControlId(parsed)).toBe("CTRL-ADT-1");
  });

  it("getPid5Name returns family + given", () => {
    expect(getPid5Name(parsed)).toEqual({
      familyName: "Sharma",
      givenName: "Arjun",
    });
  });

  it("getField returns undefined when the segment is absent", () => {
    expect(getField(parsed, "OBX", 5)).toBeUndefined();
  });

  it("parseComponents on an empty field returns an empty array", () => {
    expect(parseComponents("")).toEqual([]);
  });
});
