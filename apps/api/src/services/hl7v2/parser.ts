/**
 * HL7 v2 parser — splits a message into segments and fields.
 *
 * This is intentionally minimal: it handles the canonical delimiter set
 * (`|^~\&`) declared in MSH-2 and performs the inverse of the escaping
 * performed by `segments.ts`. It is used right now only by the unit tests
 * (round-trip parsing of messages we just built) but is written defensively
 * enough to accept inbound messages later.
 *
 * We do NOT bind this to any HTTP endpoint yet — per the spec, inbound HL7
 * v2 is out of scope for this pass.
 */

import { unescapeField } from "./segments";

/** One parsed HL7 segment. Segment id is stripped from `fields`. */
export interface HL7Segment {
  /** Three-char segment id (MSH, PID, OBR, ...). */
  id: string;
  /**
   * Fields indexed 1-based (fields[1] is the FIRST field after the segment
   * id). For MSH specifically, fields[1] is the encoding characters string
   * per HL7 convention — this matches the "MSH-1 = field separator" and
   * "MSH-2 = encoding chars" numbering used by downstream consumers.
   *
   * IMPORTANT: field values are stored in their RAW (still-escaped) form.
   * Unescaping happens at COMPONENT level inside `parseComponents`, so an
   * escaped `^` (`\S\`) will not over-split a field that gets passed to
   * `parseComponents`. Consumers that want a flat unescaped scalar should
   * call `getField(...)` (which unescapes once) rather than reading
   * `fields[idx]` directly. Direct reads are still valid — they just
   * preserve the source escapes.
   */
  fields: string[];
}

/** A parsed HL7 message — list of segments plus the delimiter set. */
export interface HL7Message {
  segments: HL7Segment[];
  delimiters: {
    field: string;
    component: string;
    repetition: string;
    escape: string;
    subcomponent: string;
  };
}

/**
 * Split a field value on the component separator, unescaping each component.
 * Useful for fields like PID-5 (name) or OBX-3 (code^name^system).
 */
export function parseComponents(field: string, componentSep = "^"): string[] {
  if (!field) return [];
  return field.split(componentSep).map((c) => unescapeField(c));
}

/**
 * Parse a single segment into {id, fields}. MSH is special-cased because the
 * field separator itself appears in column 4 of the raw string (MSH|^~\&|...)
 * and must be treated as the MSH-1 value.
 *
 * Field values are kept in their RAW (still-escaped) form. The earlier
 * implementation eagerly called `unescapeField` here, which was wrong: an
 * escaped `^` (`\S\`) inside a field value would decode to a literal `^`
 * BEFORE the consumer split on components, so `parseComponents(field)` would
 * over-split fields that legitimately contained an escaped caret (e.g. a
 * patient name with `^` in it). The correct order is split-first,
 * unescape-each-component — which `parseComponents` already does. Flat
 * scalar accessors like `getField` unescape on read instead.
 */
function parseSegment(line: string, fieldSep: string): HL7Segment {
  const id = line.slice(0, 3);
  if (id === "MSH") {
    // MSH-1 is the field separator, MSH-2 is the encoding characters.
    // Raw: "MSH|^~\&|field3|field4|..."
    //       ^^^ id ^ sep  ^^^^ encoding chars
    const afterEncoding = line.slice(8); // skip "MSH|^~\&"
    const rest = afterEncoding.startsWith(fieldSep)
      ? afterEncoding.slice(1)
      : afterEncoding;
    // Keep tail fields raw — unescape happens at component level.
    const tail = rest.split(fieldSep);
    // fields[0] is unused (for parity with segment id slot); fields[1] is
    // field separator; fields[2] is encoding chars; fields[3]... are payload.
    return {
      id,
      fields: [id, fieldSep, line.slice(4, 8), ...tail],
    };
  }

  // Non-MSH: split on field separator, store raw. parts[0] is the segment id.
  const parts = line.split(fieldSep);
  return { id, fields: parts };
}

/**
 * Parse an HL7 v2 message string into structured segments. Accepts either
 * the canonical `\r` terminator or `\n` / `\r\n` for forgiving inbound use.
 * The MSH segment must be first — we read the delimiter set from it.
 */
export function parseMessage(raw: string): HL7Message {
  if (!raw || !raw.startsWith("MSH")) {
    throw new Error("parseMessage: message must start with MSH");
  }

  // Detect delimiters from the MSH header. MSH-1 is char 3 (field sep);
  // MSH-2 is chars 4-7 (component / repetition / escape / sub-component).
  const fieldSep = raw.charAt(3);
  const componentSep = raw.charAt(4);
  const repetitionSep = raw.charAt(5);
  const escapeChar = raw.charAt(6);
  const subcomponentSep = raw.charAt(7);

  // Split on any CR / LF combination; filter empty lines (trailing CR case).
  const lines = raw.split(/\r\n|\r|\n/).filter((l) => l.length > 0);

  const segments = lines.map((line) => parseSegment(line, fieldSep));

  return {
    segments,
    delimiters: {
      field: fieldSep,
      component: componentSep,
      repetition: repetitionSep,
      escape: escapeChar,
      subcomponent: subcomponentSep,
    },
  };
}

/**
 * Convenience: find the first segment by id (e.g. "PID") and return a field
 * by its 1-based index, UNESCAPED. Returns `undefined` if the segment or
 * field is absent.
 *
 * Note: `seg.fields[idx]` itself stores the raw escaped value. This accessor
 * decodes it once for callers that want a flat scalar. Callers that need to
 * split on components should use `parseComponents(seg.fields[idx])` (or the
 * `getComponent` helper below) — those paths split-then-unescape and avoid
 * the `\S\` over-split quirk.
 */
export function getField(
  message: HL7Message,
  segmentId: string,
  fieldIndex: number
): string | undefined {
  const seg = message.segments.find((s) => s.id === segmentId);
  if (!seg) return undefined;
  const raw = seg.fields[fieldIndex];
  if (raw === undefined) return undefined;
  return unescapeField(raw);
}

/**
 * Get a specific component within a field (e.g. PID-5.1 for family name).
 * Returns `undefined` if the segment/field/component is missing.
 *
 * Reads the RAW field value directly (not via `getField`, which would
 * pre-unescape and collapse `\S\` into a literal `^`) and lets
 * `parseComponents` do the correct split-then-unescape.
 */
export function getComponent(
  message: HL7Message,
  segmentId: string,
  fieldIndex: number,
  componentIndex: number
): string | undefined {
  const seg = message.segments.find((s) => s.id === segmentId);
  if (!seg) return undefined;
  const raw = seg.fields[fieldIndex];
  if (raw === undefined) return undefined;
  const parts = parseComponents(raw, message.delimiters.component);
  return parts[componentIndex - 1]; // 1-based
}

/** Return every segment with the given id (useful for OBX, OBR in ORU). */
export function getSegments(message: HL7Message, segmentId: string): HL7Segment[] {
  return message.segments.filter((s) => s.id === segmentId);
}

/**
 * Extract the MSH-9 message type triplet — `{msgType, trigger, structure}`.
 * MSH-9 is rendered as `CODE^TRIGGER^STRUCTURE` (e.g. `ADT^A04^ADT_A01`).
 * Required by the inbound dispatcher to route messages to the right ingester.
 *
 * Pulls the RAW MSH-9 (escaped) so parseComponents can split-then-unescape
 * correctly per component.
 */
export function extractMessageType(
  message: HL7Message
): { msgType: string; trigger: string; structure?: string } {
  const msh = message.segments.find((s) => s.id === "MSH");
  const raw = msh?.fields[9];
  if (!raw) {
    throw new Error("extractMessageType: MSH-9 is missing");
  }
  const parts = parseComponents(raw, message.delimiters.component);
  const msgType = parts[0] ?? "";
  const trigger = parts[1] ?? "";
  const structure = parts[2];
  if (!msgType || !trigger) {
    throw new Error(
      `extractMessageType: malformed MSH-9 value "${raw}" (need CODE^TRIGGER)`
    );
  }
  return { msgType, trigger, structure };
}

/**
 * Return the MSH-10 message control id. Used by ACKs (MSA-2) and for
 * per-message audit correlation.
 */
export function getControlId(message: HL7Message): string | undefined {
  return getField(message, "MSH", 10);
}

/**
 * Return the primary MR number carried in PID-3. PID-3 may repeat with `~`
 * and each repetition is `id^^^authority^typeCode`. We take the first
 * repetition's first component — that's the patient identifier per v2.5.1.
 *
 * Operates on the RAW PID-3 value so the repetition / component splits
 * happen on real delimiters and `parseComponents` does the per-component
 * unescape.
 */
export function getPid3MrNumber(message: HL7Message): string | undefined {
  const pid = message.segments.find((s) => s.id === "PID");
  const raw = pid?.fields[3];
  if (!raw) return undefined;
  // Split by repetition separator first — the primary MR is the first rep.
  const firstRep = raw.split(message.delimiters.repetition)[0];
  const components = parseComponents(firstRep, message.delimiters.component);
  const id = components[0]?.trim();
  return id ? id : undefined;
}

/**
 * Return the family and given name from PID-5 as a best-effort pair.
 * PID-5 layout: `family^given^middle^suffix^prefix`.
 */
export function getPid5Name(
  message: HL7Message
): { familyName: string; givenName: string } {
  const familyName = getComponent(message, "PID", 5, 1) ?? "";
  const givenName = getComponent(message, "PID", 5, 2) ?? "";
  return { familyName, givenName };
}

/**
 * Return the placer order number from ORC-2 (preferred) or OBR-2 (fallback).
 * Legacy labs sometimes omit ORC entirely — we accept either.
 */
export function getPlacerOrderNumber(message: HL7Message): string | undefined {
  return (
    getField(message, "ORC", 2) ?? getField(message, "OBR", 2) ?? undefined
  );
}
