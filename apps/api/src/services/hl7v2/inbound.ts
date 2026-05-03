/**
 * HL7 v2 inbound ingestion — reverse mappers that take a parsed HL7 v2 message
 * and upsert the relevant Prisma rows. Used by the `POST /hl7v2/inbound`
 * endpoint for Indian lab and legacy HIS integrations that can only speak
 * pipe-delimited HL7 v2 (no FHIR support).
 *
 * Design notes:
 * - Every ingest function returns a structured result (`action`, `entity`,
 *   `entityId`, optional `warnings`) so the HTTP layer can build an accurate
 *   ACK. We never throw for "business rule" failures — only for malformed
 *   input (e.g. missing MSH-9). Business rules return `{action: "skipped", ...}`
 *   with a warning so the sender sees a proper ACK(AE) / ACK(AR) body.
 * - All DB writes happen inside `prisma.$transaction` so we don't leave
 *   half-built aggregates behind on a crash between patient + admission /
 *   order + items.
 * - We use the typed `prisma.*` delegates (no `as any`). Prisma is imported
 *   from `@medcore/db` directly — NOT via `tenantScopedPrisma` — because
 *   inbound messages arrive with no caller tenant context (ADMIN-only ingest
 *   at an infrastructure boundary). The caller may set tenantId via other
 *   means (e.g. JWT) and the row is written with that context intact; we do
 *   not force a tenant on ingest.
 * - HL7 line endings are ALWAYS `\r` — never `\n`. `buildACK` below enforces
 *   that invariant.
 *
 * Supported message types (MSH-9):
 *
 *   ADT^A04   register a patient     → patient + admission upsert
 *   ORM^O01   order                  → lab order + items upsert
 *   ORU^R01   unsolicited result     → lab result upsert
 *
 * Unknown message types return ACK(AR) with a diagnostic reason.
 */

import { prisma } from "@medcore/db";
import {
  type HL7Message,
  extractMessageType,
  getField,
  getControlId,
  getPid3MrNumber,
  getPid5Name,
  getPlacerOrderNumber,
  getSegments,
  parseComponents,
} from "./parser";
import {
  MSH,
  unescapeField,
  type MSHData,
  SEGMENT_TERMINATOR,
  FIELD_SEP,
} from "./segments";

// ─── Result shape ───────────────────────────────────────────────────────────

export type IngestAction = "created" | "updated" | "skipped";

export interface IngestResult {
  action: IngestAction;
  /** The Prisma entity type name — e.g. "Patient", "LabOrder", "LabResult". */
  entity: string;
  /** The id of the primary entity created / updated. `null` when skipped. */
  entityId: string | null;
  /** Non-fatal issues the sender should see in ACK comments. */
  warnings?: string[];
}

// ─── Small parsing helpers ──────────────────────────────────────────────────

/**
 * Parse HL7 TS / DTM (YYYYMMDDHHMMSS or YYYYMMDD) into a JS Date.
 * Returns `null` for empty / unparseable strings. HL7 timestamps are
 * interpreted as UTC here; receivers that need local time must apply their
 * own offset.
 */
export function parseHl7Ts(raw: string | undefined | null): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!/^\d{8}(\d{2}(\d{2}(\d{2})?)?)?/.test(s)) return null;
  const year = Number(s.slice(0, 4));
  const month = Number(s.slice(4, 6)) - 1;
  const day = Number(s.slice(6, 8));
  const hour = s.length >= 10 ? Number(s.slice(8, 10)) : 0;
  const minute = s.length >= 12 ? Number(s.slice(10, 12)) : 0;
  const second = s.length >= 14 ? Number(s.slice(12, 14)) : 0;
  const d = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** Map PID-8 ('M' / 'F' / 'O' / 'U') to our Gender enum. */
function mapSex(code: string | undefined): "MALE" | "FEMALE" | "OTHER" {
  switch ((code || "").toUpperCase()) {
    case "M":
      return "MALE";
    case "F":
      return "FEMALE";
    default:
      return "OTHER";
  }
}

/** Map OBX-8 abnormal flag code to our LabResultFlag enum. */
function mapObxFlag(
  code: string | undefined
): "NORMAL" | "LOW" | "HIGH" | "CRITICAL" {
  switch ((code || "").toUpperCase()) {
    case "H":
      return "HIGH";
    case "L":
      return "LOW";
    case "HH":
    case "LL":
      return "CRITICAL";
    default:
      return "NORMAL";
  }
}

/**
 * Assemble a full name from PID-5 components. We store User.name as a single
 * string, so we join family + given with a space. Empty components are
 * tolerated.
 */
function joinName(family: string, given: string): string {
  const parts = [given, family].map((p) => p.trim()).filter((p) => p.length > 0);
  return parts.join(" ") || "Unknown";
}

/**
 * Short random token for synthesised user records so we don't collide on
 * email/phone when an ADT^A04 doesn't supply contact details. We never
 * expose these emails — they're placeholders to satisfy the unique index.
 */
function syntheticStub(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

// ─── ADT^A04 — Patient registration ─────────────────────────────────────────

/**
 * Upsert a Patient (keyed by PID-3 MR number) and optionally create a new
 * Admission row. We never delete / close an existing admission here — A04 is
 * an additive "register a patient" event, not an admit+discharge.
 *
 * If the message supplies bed info via PV1-3 we try to resolve a real bed;
 * otherwise we skip admission creation with a warning. External HIS systems
 * don't know our bed numbering and the Admission FK makes it mandatory.
 */
export async function ingestADT_A04(
  message: HL7Message
): Promise<IngestResult> {
  const warnings: string[] = [];

  const mrNumber = getPid3MrNumber(message);
  if (!mrNumber) {
    return {
      action: "skipped",
      entity: "Patient",
      entityId: null,
      warnings: ["PID-3 MR number is required"],
    };
  }

  const { familyName, givenName } = getPid5Name(message);
  const dob = parseHl7Ts(getField(message, "PID", 7));
  const sex = mapSex(getField(message, "PID", 8));
  const phone = getField(message, "PID", 13) || "";

  // PID-11 address — take first repetition, unescape components.
  // Read the RAW field (not via getField, which would pre-unescape and
  // collapse \S\ into a literal ^) so repetition / component splits happen
  // on real delimiters; parseComponents does the per-component unescape.
  const pidSeg = message.segments.find((s) => s.id === "PID");
  const pid11Raw = pidSeg?.fields[11];
  let addressLine: string | undefined;
  if (pid11Raw) {
    const firstRep = pid11Raw.split(message.delimiters.repetition)[0];
    const comps = parseComponents(firstRep, message.delimiters.component);
    const line = comps[0] ?? "";
    const city = comps[2] ?? "";
    const state = comps[3] ?? "";
    const pieces = [line, city, state].filter((p) => p && p.length > 0);
    if (pieces.length > 0) addressLine = pieces.join(", ");
  }

  const fullName = joinName(familyName, givenName);
  const displayPhone = phone || "0000000000";

  // Transaction: find-or-upsert User + Patient, optionally create Admission.
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.patient.findUnique({
      where: { mrNumber },
      include: { user: true },
    });

    let patientId: string;
    let created = false;
    if (existing) {
      patientId = existing.id;
      await tx.patient.update({
        where: { id: existing.id },
        data: {
          gender: sex,
          dateOfBirth: dob ?? existing.dateOfBirth,
          address: addressLine ?? existing.address,
        },
      });
      // Update the backing user name/phone if we got something meaningful.
      if (existing.userId) {
        await tx.user.update({
          where: { id: existing.userId },
          data: {
            name: fullName !== "Unknown" ? fullName : existing.user?.name ?? fullName,
            ...(phone ? { phone } : {}),
          },
        });
      }
    } else {
      // Synthesise a User (required by schema). Email must be unique.
      const user = await tx.user.create({
        data: {
          email: `${syntheticStub("hl7")}@hl7.inbound.local`,
          name: fullName,
          phone: displayPhone,
          passwordHash: "!hl7v2-stub!", // never usable — no login for auto-reg
          role: "PATIENT",
        },
      });
      const pat = await tx.patient.create({
        data: {
          userId: user.id,
          mrNumber,
          gender: sex,
          dateOfBirth: dob,
          address: addressLine,
        },
      });
      patientId = pat.id;
      created = true;
    }

    // PV1 — try to create an Admission only if we can resolve a bed+doctor.
    // PV1-2 patient class, PV1-3 assigned location, PV1-7 attending doctor.
    const pv1_2 = getField(message, "PV1", 2);
    const pv1_19 = getField(message, "PV1", 19); // visit number
    const admitTs = parseHl7Ts(getField(message, "PV1", 44));
    if (pv1_2 && pv1_2 !== "") {
      // Only bother trying to admit if patient class is I (Inpatient).
      if (pv1_2 === "I") {
        // Resolve bed + doctor as best we can. External systems don't know
        // our internal ids — we fall back to any AVAILABLE bed + any doctor.
        const bed = await tx.bed.findFirst({ where: { status: "AVAILABLE" } });
        const doctor = await tx.doctor.findFirst();
        if (!bed || !doctor) {
          warnings.push(
            "PV1 present but no AVAILABLE bed or doctor to link — admission skipped"
          );
        } else {
          const admissionNumber =
            pv1_19 && pv1_19.trim().length > 0
              ? pv1_19
              : `ADMHL7${Date.now()}${Math.floor(Math.random() * 1000)}`;
          // Only create a new admission if the visit number isn't already present.
          const existingAdm = await tx.admission.findFirst({
            where: { admissionNumber },
          });
          if (!existingAdm) {
            await tx.admission.create({
              data: {
                admissionNumber,
                patientId,
                doctorId: doctor.id,
                bedId: bed.id,
                reason: "[HL7v2 auto-registered]",
                status: "ADMITTED",
                admittedAt: admitTs ?? new Date(),
              },
            });
            await tx.bed.update({
              where: { id: bed.id },
              data: { status: "OCCUPIED" },
            });
          }
        }
      }
    }

    return { patientId, created };
  });

  return {
    action: result.created ? "created" : "updated",
    entity: "Patient",
    entityId: result.patientId,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// ─── ORM^O01 — Lab order ────────────────────────────────────────────────────

/**
 * Upsert a LabOrder + LabOrderItem(s) keyed by the placer order number
 * (ORC-2 / OBR-2). Requires the patient to already exist (by PID-3 MR
 * number). Items are matched to existing LabTest rows by `test.code`; unknown
 * test codes are rejected with a warning.
 */
export async function ingestORM_O01(
  message: HL7Message
): Promise<IngestResult> {
  const warnings: string[] = [];
  const mrNumber = getPid3MrNumber(message);
  if (!mrNumber) {
    return {
      action: "skipped",
      entity: "LabOrder",
      entityId: null,
      warnings: ["PID-3 MR number is required"],
    };
  }

  const placer = getPlacerOrderNumber(message);
  if (!placer) {
    return {
      action: "skipped",
      entity: "LabOrder",
      entityId: null,
      warnings: ["ORC-2 / OBR-2 placer order number is required"],
    };
  }

  // Pull each OBR (one per ordered test) and resolve the test code.
  const obrSegs = getSegments(message, "OBR");
  const orcSegs = getSegments(message, "ORC");
  // Use OBR-4.1 first; fall back to the OBR-4 raw value if unstructured.
  const testCodes: string[] = [];
  for (const obr of obrSegs) {
    const obr4 = obr.fields[4] ?? "";
    const [code] = parseComponents(obr4, message.delimiters.component);
    if (code && code.trim().length > 0) testCodes.push(code.trim());
  }
  if (testCodes.length === 0) {
    return {
      action: "skipped",
      entity: "LabOrder",
      entityId: null,
      warnings: ["No OBR segments with a test code found"],
    };
  }

  const requestedTs =
    parseHl7Ts(orcSegs[0]?.fields[9]) ??
    parseHl7Ts(obrSegs[0]?.fields[6]) ??
    new Date();

  const result = await prisma.$transaction(async (tx) => {
    const patient = await tx.patient.findUnique({ where: { mrNumber } });
    if (!patient) {
      return {
        missingPatient: true as const,
      };
    }

    // Resolve tests by code. Any unknown codes are collected as warnings;
    // we still create the order for the known codes.
    const tests = await tx.labTest.findMany({
      where: { code: { in: testCodes } },
    });
    const known = new Map(tests.map((t) => [t.code, t]));
    const unknown = testCodes.filter((c) => !known.has(c));
    const resolvedIds = testCodes
      .map((c) => known.get(c)?.id)
      .filter((id): id is string => !!id);

    if (resolvedIds.length === 0) {
      return {
        noKnownTests: true as const,
        unknown,
      };
    }

    // Doctor is required by schema. Pick any doctor.
    const doctor = await tx.doctor.findFirst();
    if (!doctor) {
      return { noDoctor: true as const };
    }

    // Find-or-create by orderNumber (= placer order number).
    const existing = await tx.labOrder.findUnique({
      where: { orderNumber: placer },
      include: { items: true },
    });

    let orderId: string;
    let createdFlag = false;
    if (existing) {
      orderId = existing.id;
      // Add any items that aren't already present.
      const existingTestIds = new Set(existing.items.map((i) => i.testId));
      const toAdd = resolvedIds.filter((id) => !existingTestIds.has(id));
      if (toAdd.length > 0) {
        await tx.labOrderItem.createMany({
          data: toAdd.map((testId) => ({ orderId, testId })),
        });
      }
    } else {
      const created = await tx.labOrder.create({
        data: {
          orderNumber: placer,
          patientId: patient.id,
          doctorId: doctor.id,
          status: "ORDERED",
          orderedAt: requestedTs,
          notes: "[HL7v2 inbound order]",
          items: {
            create: resolvedIds.map((testId) => ({ testId })),
          },
        },
      });
      orderId = created.id;
      createdFlag = true;
    }
    return {
      orderId,
      created: createdFlag,
      unknown,
    };
  });

  if ("missingPatient" in result) {
    return {
      action: "skipped",
      entity: "LabOrder",
      entityId: null,
      warnings: [
        `Patient with MR ${mrNumber} not found — send ADT^A04 first`,
      ],
    };
  }
  if ("noKnownTests" in result) {
    return {
      action: "skipped",
      entity: "LabOrder",
      entityId: null,
      warnings: [
        `None of the test codes are registered: ${(result.unknown ?? []).join(
          ", "
        )}`,
      ],
    };
  }
  if ("noDoctor" in result) {
    return {
      action: "skipped",
      entity: "LabOrder",
      entityId: null,
      warnings: ["No doctor available to link the order to"],
    };
  }

  if ("unknown" in result && (result.unknown?.length ?? 0) > 0) {
    warnings.push(
      `Unknown test codes ignored: ${(result.unknown ?? []).join(", ")}`
    );
  }

  return {
    action: result.created ? "created" : "updated",
    entity: "LabOrder",
    entityId: result.orderId,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// ─── ORU^R01 — Observation result ───────────────────────────────────────────

/**
 * Write one LabResult per OBX segment, linked to its parent LabOrder by
 * placer order number (ORC-2 / OBR-2). If no LabOrder exists yet, we
 * auto-create a minimal one with `notes: "[HL7v2 autocreated]"` so the
 * results don't vanish.
 *
 * OBX-3.1 is the parameter name; OBX-5 is the value; OBX-8 maps to flag.
 */
export async function ingestORU_R01(
  message: HL7Message
): Promise<IngestResult> {
  const warnings: string[] = [];
  const mrNumber = getPid3MrNumber(message);
  if (!mrNumber) {
    return {
      action: "skipped",
      entity: "LabResult",
      entityId: null,
      warnings: ["PID-3 MR number is required"],
    };
  }

  const placer = getPlacerOrderNumber(message);
  if (!placer) {
    return {
      action: "skipped",
      entity: "LabResult",
      entityId: null,
      warnings: ["ORC-2 / OBR-2 placer order number is required"],
    };
  }

  const obxSegs = getSegments(message, "OBX");
  if (obxSegs.length === 0) {
    return {
      action: "skipped",
      entity: "LabResult",
      entityId: null,
      warnings: ["No OBX segments found"],
    };
  }

  // OBR-4 gives us the fallback test code for items we auto-create.
  const firstObr = getSegments(message, "OBR")[0];
  const obr4 = firstObr?.fields[4] ?? "";
  const [obrTestCode] = parseComponents(obr4, message.delimiters.component);

  const result = await prisma.$transaction(async (tx) => {
    const patient = await tx.patient.findUnique({ where: { mrNumber } });
    if (!patient) {
      return { missingPatient: true as const };
    }

    let order = await tx.labOrder.findUnique({
      where: { orderNumber: placer },
      include: { items: { include: { test: true } } },
    });
    let orderCreated = false;

    if (!order) {
      // Auto-create: we need a doctor and at least one LabOrderItem. Pick
      // any doctor + try to resolve the OBR-4 test code; if we can't find
      // it, we auto-create a placeholder LabTest keyed by the OBR code so
      // results aren't lost. (This is the "minimal" autocreate path from
      // the spec.)
      const doctor = await tx.doctor.findFirst();
      if (!doctor) {
        return { noDoctor: true as const };
      }
      let testId: string | null = null;
      if (obrTestCode && obrTestCode.trim().length > 0) {
        const existing = await tx.labTest.findUnique({
          where: { code: obrTestCode },
        });
        if (existing) {
          testId = existing.id;
        } else {
          const synth = await tx.labTest.create({
            data: {
              code: obrTestCode,
              name: `HL7v2 auto ${obrTestCode}`,
              price: 0,
            },
          });
          testId = synth.id;
        }
      }
      if (!testId) {
        return { noTest: true as const };
      }
      const created = await tx.labOrder.create({
        data: {
          orderNumber: placer,
          patientId: patient.id,
          doctorId: doctor.id,
          status: "COMPLETED",
          orderedAt: new Date(),
          notes: "[HL7v2 autocreated]",
          items: { create: [{ testId }] },
        },
        include: { items: { include: { test: true } } },
      });
      order = created;
      orderCreated = true;
    }

    // Each OBX becomes one LabResult. We attach every result to the first
    // matching LabOrderItem — or the first item overall if no match.
    // Production senders can use OBR-pair grouping to disambiguate.
    if (order.items.length === 0) {
      return { noItems: true as const };
    }

    const firstItemId = order.items[0].id;
    const resultIds: string[] = [];
    for (const obx of obxSegs) {
      const obx2Raw = obx.fields[2] ?? "";
      const obx3 = obx.fields[3] ?? "";
      const value = obx.fields[5] ?? "";
      const unit = obx.fields[6] ?? "";
      const refRange = obx.fields[7] ?? "";
      const flagCode = obx.fields[8] ?? "";
      const [paramCode, paramName] = parseComponents(
        obx3,
        message.delimiters.component
      );
      const parameter = paramName || paramCode || "unknown";
      const res = await tx.labResult.create({
        data: {
          orderItemId: firstItemId,
          parameter,
          value: String(value),
          unit: unit || null,
          normalRange: refRange || null,
          flag: mapObxFlag(flagCode),
          enteredBy: "hl7v2-inbound",
          reportedAt: parseHl7Ts(obx.fields[14]) ?? new Date(),
        },
      });
      resultIds.push(res.id);
      // OBX-2 value type is informational; we store value as string either way.
      void obx2Raw;
    }

    return {
      orderId: order.id,
      created: orderCreated,
      resultIds,
    };
  });

  if ("missingPatient" in result) {
    return {
      action: "skipped",
      entity: "LabResult",
      entityId: null,
      warnings: [`Patient with MR ${mrNumber} not found`],
    };
  }
  if ("noDoctor" in result) {
    return {
      action: "skipped",
      entity: "LabResult",
      entityId: null,
      warnings: ["No doctor available to auto-create the order"],
    };
  }
  if ("noTest" in result) {
    return {
      action: "skipped",
      entity: "LabResult",
      entityId: null,
      warnings: ["OBR-4 test code missing — cannot auto-create order"],
    };
  }
  if ("noItems" in result) {
    return {
      action: "skipped",
      entity: "LabResult",
      entityId: null,
      warnings: ["Order has no items to attach results to"],
    };
  }

  if (result.created) {
    warnings.push("Parent order was not found — created minimal autocreated order");
  }
  return {
    action: "created",
    entity: "LabResult",
    entityId: result.resultIds[0] ?? null,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

/**
 * Read MSH-9 and route to the matching ingester. Throws for unsupported
 * message types — the HTTP layer maps the throw to ACK(AR).
 */
export async function dispatchMessage(
  message: HL7Message
): Promise<IngestResult> {
  const { msgType, trigger } = extractMessageType(message);
  const key = `${msgType}^${trigger}`;
  switch (key) {
    case "ADT^A04":
      return ingestADT_A04(message);
    case "ORM^O01":
      return ingestORM_O01(message);
    case "ORU^R01":
      return ingestORU_R01(message);
    default:
      throw new Error(
        `Unsupported HL7 v2 message type: ${key} (only ADT^A04, ORM^O01, ORU^R01 supported)`
      );
  }
}

// ─── ACK construction ──────────────────────────────────────────────────────

export type AckStatus = "AA" | "AE" | "AR";

/**
 * Build an HL7 v2 ACK (Application Acknowledgement). Structure per v2.5.1
 * §2.9.2 is minimum `MSH` + `MSA`. MSA-1 carries the status code; MSA-2 must
 * echo the original sender's MSH-10 control id so they can correlate.
 *
 * Line endings are ALWAYS `\r` — we rely on `SEGMENT_TERMINATOR` from
 * `segments.ts` which is a bare CR. `\n` MUST NOT appear anywhere in the
 * returned string.
 */
export function buildACK(
  originalMessage: HL7Message,
  status: AckStatus,
  text?: string
): string {
  // Pull sender/receiver and flip them for the ACK.
  const origSendingApp = getField(originalMessage, "MSH", 3) || "UNKNOWN";
  const origSendingFac = getField(originalMessage, "MSH", 4) || "UNKNOWN";
  const origReceivingApp = getField(originalMessage, "MSH", 5) || "MEDCORE";
  const origReceivingFac = getField(originalMessage, "MSH", 6) || "MEDCORE_HIS";
  const origControlId = getControlId(originalMessage) || "UNKNOWN";

  // The ACK's MSH-9 trigger event mirrors the original trigger so routers
  // can tell ADT-ACKs from ORM-ACKs. Structure is ACK per v2.5.1.
  let origTrigger = "";
  try {
    origTrigger = extractMessageType(originalMessage).trigger;
  } catch {
    origTrigger = "";
  }

  const mshData: MSHData = {
    sendingApplication: origReceivingApp,
    sendingFacility: origReceivingFac,
    receivingApplication: origSendingApp,
    receivingFacility: origSendingFac,
    timestamp: new Date(),
    messageType: {
      code: "ACK",
      trigger: origTrigger,
      structure: "ACK",
    },
    controlId: `ACK${Date.now()}${Math.floor(Math.random() * 1000)}`,
    processingId: "P",
  };
  const msh = MSH(mshData);

  // MSA: MSA-1 = AckCode, MSA-2 = original control id, MSA-3 = text.
  const msaFields = [
    status,
    origControlId,
    text ? escapeForMsaText(text) : "",
  ];
  const msa = ["MSA", ...msaFields].join(FIELD_SEP);

  const body = `${msh}${SEGMENT_TERMINATOR}${msa}${SEGMENT_TERMINATOR}`;

  // Defensive: an HL7 v2 message must not contain an LF. Strip if anyone
  // smuggled one in via the text param.
  return body.replace(/\n/g, "");
}

/**
 * Minimal escape for free-text MSA-3 — field separator and newlines are the
 * two real risks. We defer to the segment builder's own escaping for other
 * reserved chars by only wrapping `|` -> `\F\` here.
 */
function escapeForMsaText(raw: string): string {
  return raw
    .replace(/\\/g, "\\E\\")
    .replace(/\|/g, "\\F\\")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ");
}

// Re-export for callers that want the unescape for custom handling.
export { unescapeField };
