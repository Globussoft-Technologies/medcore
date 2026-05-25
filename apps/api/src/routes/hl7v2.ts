/**
 * HL7 v2 export endpoints — produces pipe-delimited HL7 v2.5.1 messages for
 * legacy Indian lab and HIS systems that don't speak FHIR.
 *
 * Every endpoint is ADMIN-only and every export is audit-logged because HL7
 * messages carry the same PHI scope as the FHIR exports. The Content-Type is
 * `application/hl7-v2` — the IANA-registered MIME for HL7 v2; callers that
 * prefer `text/plain` should negotiate client-side.
 *
 * Line endings: responses contain ONLY `\r` segment terminators. We do NOT
 * translate to `\r\n` — per HL7 v2 §2.3 the segment terminator is a single
 * CR and legacy parsers break if LF is added.
 */

import express, { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { rateLimit } from "../middleware/rate-limit";
import { requireFeature } from "../middleware/feature-flag";
import {
  buildADT_A04,
  buildORM_O01,
  buildORU_R01,
  type HL7Patient,
  type HL7LabOrder,
  type HL7LabResult,
  type HL7Admission,
} from "../services/hl7v2/messages";
import { parseMessage } from "../services/hl7v2/parser";
import {
  dispatchMessage,
  buildACK,
  type AckStatus,
} from "../services/hl7v2/inbound";

const router = Router();
router.use(authenticate);
// Pearl §6 + §18 (gap item #9 — audit fix-up #3, 2026-05-25): HL7v2 inbound
// lab analyser feed is a Stage-2 paid feature. Pearl-branded tenants set
// `hl7Inbound=false` and every HL7v2 route 404s before authorize runs.
// Non-Pearl tenants pass through (default `true`).
router.use(requireFeature("hl7Inbound"));

const HL7_CONTENT_TYPE = "application/hl7-v2";

/** Send an HL7 v2 response with the correct Content-Type. */
function sendHl7(res: Response, status: number, body: string) {
  res.status(status).type(HL7_CONTENT_TYPE).send(body);
}

/** Send a simple plaintext error response (HL7 v2 has no native error envelope). */
function sendError(res: Response, status: number, message: string) {
  res.status(status).type("text/plain").send(message);
}

// ─── GET /api/v1/hl7v2/patient/:id — ADT^A04 ─────────────────────────────────

router.get(
  "/patient/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const patient = await prisma.patient.findUnique({
        where: { id },
        include: { user: true, admissions: { orderBy: { admittedAt: "desc" }, take: 1 } },
      });
      if (!patient) {
        sendError(res, 404, `Patient ${id} not found`);
        return;
      }

      const hl7Patient: HL7Patient = {
        id: patient.id,
        mrNumber: patient.mrNumber,
        gender: patient.gender,
        dateOfBirth: patient.dateOfBirth,
        address: patient.address,
        abhaId: patient.abhaId,
        user: patient.user
          ? { name: patient.user.name, phone: patient.user.phone, email: patient.user.email }
          : null,
      };

      const latestAdmission = (patient as any).admissions?.[0];
      const admission: HL7Admission = latestAdmission
        ? {
            visitNumber: latestAdmission.admissionNumber,
            patientClass: "I",
            admittedAt: latestAdmission.admittedAt,
            dischargedAt: latestAdmission.dischargedAt,
          }
        : { patientClass: "O" };

      const message = buildADT_A04(hl7Patient, admission);

      await auditLog(req, "HL7V2_ADT_A04_EXPORT", "Patient", id, {
        messageLength: message.length,
      });
      sendHl7(res, 200, message);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/v1/hl7v2/lab-order/:id — ORM^O01 ───────────────────────────────

router.get(
  "/lab-order/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const order = await prisma.labOrder.findUnique({
        where: { id },
        include: {
          patient: { include: { user: true } },
          doctor: { include: { user: true } },
          items: { include: { test: true } },
        },
      });
      if (!order) {
        sendError(res, 404, `Lab order ${id} not found`);
        return;
      }

      const hl7Order: HL7LabOrder = {
        id: order.id,
        orderNumber: order.orderNumber,
        orderedAt: order.orderedAt,
        collectedAt: order.collectedAt,
        completedAt: order.completedAt,
        status: order.status,
        priority: order.priority,
        patient: {
          id: order.patient.id,
          mrNumber: order.patient.mrNumber,
          gender: order.patient.gender,
          dateOfBirth: order.patient.dateOfBirth,
          address: order.patient.address,
          abhaId: order.patient.abhaId,
          user: order.patient.user
            ? { name: order.patient.user.name, phone: order.patient.user.phone, email: order.patient.user.email }
            : null,
        },
        doctor: order.doctor
          ? { id: order.doctor.id, user: order.doctor.user ? { name: order.doctor.user.name } : null }
          : null,
        items: (order.items as any[]).map((it) => ({
          id: it.id,
          test: { code: it.test.code, name: it.test.name },
        })),
      };

      const message = buildORM_O01(hl7Order);

      await auditLog(req, "HL7V2_ORM_O01_EXPORT", "LabOrder", id, {
        messageLength: message.length,
        itemCount: hl7Order.items.length,
      });
      sendHl7(res, 200, message);
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/v1/hl7v2/lab-report/:id — ORU^R01 ──────────────────────────────

router.get(
  "/lab-report/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const order = await prisma.labOrder.findUnique({
        where: { id },
        include: {
          patient: { include: { user: true } },
          doctor: { include: { user: true } },
          items: {
            include: { test: true, results: true },
          },
        },
      });
      if (!order) {
        sendError(res, 404, `Lab order ${id} not found`);
        return;
      }

      const hl7Order: HL7LabOrder = {
        id: order.id,
        orderNumber: order.orderNumber,
        orderedAt: order.orderedAt,
        collectedAt: order.collectedAt,
        completedAt: order.completedAt,
        status: order.status,
        priority: order.priority,
        patient: {
          id: order.patient.id,
          mrNumber: order.patient.mrNumber,
          gender: order.patient.gender,
          dateOfBirth: order.patient.dateOfBirth,
          address: order.patient.address,
          abhaId: order.patient.abhaId,
          user: order.patient.user
            ? { name: order.patient.user.name, phone: order.patient.user.phone, email: order.patient.user.email }
            : null,
        },
        doctor: order.doctor
          ? { id: order.doctor.id, user: order.doctor.user ? { name: order.doctor.user.name } : null }
          : null,
        items: (order.items as any[]).map((it) => ({
          id: it.id,
          test: { code: it.test.code, name: it.test.name },
        })),
      };

      // Flatten results, tag each with its parent item's test code/name so the
      // OBX segment can emit a sensible code without re-querying.
      const hl7Results: HL7LabResult[] = [];
      for (const item of (order.items as any[])) {
        for (const r of (item.results as any[]) ?? []) {
          hl7Results.push({
            id: r.id,
            orderItemId: r.orderItemId,
            parameter: r.parameter,
            value: r.value,
            unit: r.unit,
            normalRange: r.normalRange,
            flag: r.flag,
            verifiedAt: r.verifiedAt,
            reportedAt: r.reportedAt,
            testCode: item.test.code,
            testName: item.test.name,
          });
        }
      }

      const message = buildORU_R01(hl7Order, hl7Results);

      await auditLog(req, "HL7V2_ORU_R01_EXPORT", "LabOrder", id, {
        messageLength: message.length,
        resultCount: hl7Results.length,
      });
      sendHl7(res, 200, message);
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST /api/v1/hl7v2/inbound — Ingestion endpoint ────────────────────────

/**
 * Accepted MIME types for inbound HL7 v2. RFC-registered `application/hl7-v2`
 * is the canonical one; `text/plain` with UTF-8 is the common legacy
 * interpretation when a sender can't set the application type.
 */
const INBOUND_ALLOWED_MIMES = new Set([
  "application/hl7-v2",
  "text/plain; charset=utf-8",
  "text/plain;charset=utf-8",
  "text/plain",
]);

/**
 * Rate limiter: 60 messages / minute per source IP. Labs burst when they
 * catch up after an outage but we don't want a single bad uploader to flood
 * the endpoint. Disabled under NODE_ENV=test so the inbound tests don't get
 * throttled; tests can opt back in by setting HL7_RATE_LIMIT=1.
 */
const inboundRateLimit =
  process.env.NODE_ENV !== "test" || process.env.HL7_RATE_LIMIT === "1"
    ? rateLimit(60, 60_000)
    : (_req: Request, _res: Response, next: NextFunction) => next();

/**
 * Raw text body parser — we MUST use this instead of express.json() for
 * inbound HL7 because the body is pipe-delimited, not JSON. The wildcard
 * `type` option catches `application/hl7-v2` and any `text/plain` variant.
 * 1 MiB limit is comfortable for even very long lab reports.
 */
const hl7TextParser = express.text({ type: "*/*", limit: "1mb" });

/** Helper: emit an ACK body with the correct Content-Type and HTTP status. */
function sendAck(res: Response, body: string, httpStatus = 200) {
  res.status(httpStatus).type("application/hl7-v2").send(body);
}

/**
 * Build a minimal ACK without a parsed source message — used only for the
 * 415 Content-Type error path where we don't have an MSH to echo. Always
 * produces a valid HL7 v2 MSH + MSA pair with CR terminators.
 */
function synthACK(status: AckStatus, text: string): string {
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const ctrlId = `ACK${Date.now()}`;
  const msh = `MSH|^~\\&|MEDCORE|MEDCORE_HIS|UNKNOWN|UNKNOWN|${ts}||ACK^^ACK|${ctrlId}|P|2.5.1|||||||UNICODE UTF-8`;
  const msa = `MSA|${status}|UNKNOWN|${text
    .replace(/\\/g, "\\E\\")
    .replace(/\|/g, "\\F\\")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")}`;
  return `${msh}\r${msa}\r`;
}

router.post(
  "/inbound",
  inboundRateLimit,
  // `authenticate` already applied globally by `router.use(authenticate)` above.
  authorize(Role.ADMIN),
  hl7TextParser,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 1. Content-Type gate. Reject non-HL7 / non-text bodies; still try to
      //    emit an ACK(AR) so the sender sees a proper HL7 response instead
      //    of JSON / HTML.
      const rawCt = (req.headers["content-type"] || "").toLowerCase().trim();
      const ctMain = rawCt.split(";")[0].trim();
      const ctAccepted =
        INBOUND_ALLOWED_MIMES.has(rawCt) ||
        INBOUND_ALLOWED_MIMES.has(ctMain) ||
        ctMain === "application/hl7-v2" ||
        ctMain === "text/plain";
      if (!ctAccepted) {
        const bodyStr = typeof req.body === "string" ? req.body : "";
        let parsed;
        try {
          parsed = parseMessage(bodyStr);
        } catch {
          parsed = null;
        }
        const ack = parsed
          ? buildACK(parsed, "AR", `Unsupported Content-Type: ${rawCt}`)
          : synthACK("AR", `Unsupported Content-Type: ${rawCt}`);
        sendAck(res, ack, 415);
        return;
      }

      const bodyStr = typeof req.body === "string" ? req.body : "";
      if (!bodyStr || bodyStr.length === 0) {
        res.status(400).type("text/plain").send("Empty HL7 body");
        return;
      }

      // 2. Parse the MSH. If we can't read an MSH we return HTTP 400 —
      //    there is no ACK envelope we can meaningfully build without it.
      let parsed;
      try {
        parsed = parseMessage(bodyStr);
      } catch (e) {
        res
          .status(400)
          .type("text/plain")
          .send(
            `Malformed HL7 v2: ${(e as Error).message || "MSH segment missing"}`
          );
        return;
      }

      // 3. Audit. Every inbound message is logged with its MSH-9 type and
      //    MSH-10 control id — PHI is NOT written to the audit blob.
      let msgTypeLabel = "UNKNOWN";
      let controlId = "UNKNOWN";
      try {
        msgTypeLabel = parsed.segments[0]?.fields[9] || "UNKNOWN";
        controlId = parsed.segments[0]?.fields[10] || "UNKNOWN";
      } catch {
        // non-fatal — audit uses UNKNOWN
      }
      auditLog(req, "HL7V2_INBOUND", "HL7v2Message", undefined, {
        messageType: msgTypeLabel,
        controlId,
      }).catch(() => {
        /* non-fatal */
      });

      // 4. Dispatch to the right reverse mapper. Unsupported types throw —
      //    we catch and build ACK(AR). Skipped outcomes map to ACK(AE).
      try {
        const result = await dispatchMessage(parsed);
        let status: AckStatus = "AA";
        if (result.action === "skipped") status = "AE";
        const warnText = (result.warnings || []).join("; ");
        const msaText =
          result.action === "skipped"
            ? warnText || "Processing skipped"
            : warnText;
        const ack = buildACK(parsed, status, msaText || undefined);
        sendAck(res, ack, 200);
      } catch (dispatchErr) {
        const ack = buildACK(
          parsed,
          "AR",
          (dispatchErr as Error).message || "Dispatch error"
        );
        sendAck(res, ack, 200);
      }
    } catch (err) {
      next(err);
    }
  }
);

// Re-use prisma import at module scope so it's not tree-shaken out when the
// export-only routes above are the only consumers.
void prisma;

export { router as hl7v2Router };
