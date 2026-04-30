import { z } from "zod";
import { containsHtmlOrScript } from "./security";

// Issue #424 (Apr 2026): the ER Register-New-Case modal accepted raw HTML /
// `<script>` payloads in chiefComplaint and the close-case outcome notes,
// which were then rendered later in the chart (stored XSS). The fix is to
// reject any free-text ER field that contains HTML/script vectors at the
// shared schema layer so both the web form and any direct API caller hit
// the same 400. We funnel every free-text field through this small helper
// (NOT the full sanitizeUserInput, because that also enforces normalize +
// max length + non-empty — clinical free-text fields have their own length
// rules, but they all share the "no XSS markup" rule).
//
// Note: `.refine()` returns a ZodEffects, which doesn't expose `.min()`/
// `.max()` chainable string methods, so the helper accepts a `minLen` arg
// that is applied to the underlying ZodString *before* the refinement.
const noHtmlOrScript = (field: string, minLen?: number) => {
  const base = minLen != null ? z.string().min(minLen) : z.string();
  return base.refine((v) => !containsHtmlOrScript(v), {
    message: `${field} contains characters that aren't allowed (e.g. < > or HTML tags)`,
  });
};

export const TELEMEDICINE_STATUS = [
  "SCHEDULED",
  "WAITING",
  "IN_PROGRESS",
  "COMPLETED",
  "MISSED",
  "CANCELLED",
] as const;

export const TRIAGE_LEVELS = [
  "RESUSCITATION",
  "EMERGENT",
  "URGENT",
  "LESS_URGENT",
  "NON_URGENT",
] as const;

export const EMERGENCY_STATUS = [
  "WAITING",
  "TRIAGED",
  "IN_TREATMENT",
  "ADMITTED",
  "DISCHARGED",
  "TRANSFERRED",
  "LEFT_WITHOUT_BEING_SEEN",
  "DECEASED",
] as const;

// Telemedicine
// Issues #18 / #27: reject negative fees AND past scheduledAt timestamps at
// the shared-schema layer so both the doctor/admin form and the reception
// variant refuse the same bad input client-side, and the server re-enforces it
// via `validate(createTelemedicineSchema)`.
export const createTelemedicineSchema = z.object({
  patientId: z.string().uuid(),
  doctorId: z.string().uuid(),
  scheduledAt: z
    .string()
    .datetime({ message: "scheduledAt must be an ISO datetime" })
    .refine((d) => new Date(d).getTime() > Date.now(), {
      message: "scheduledAt must be a future date",
    }),
  chiefComplaint: z.string().optional(),
  fee: z.number().min(0, "Fee must be zero or more").default(500),
});

export const updateTelemedicineStatusSchema = z.object({
  status: z.enum(TELEMEDICINE_STATUS),
  doctorNotes: z.string().optional(),
  patientRating: z.number().int().min(1).max(5).optional(),
});

export const rateTelemedicineSchema = z.object({
  patientRating: z.number().int().min(1).max(5),
});

export const endTelemedicineSchema = z.object({
  doctorNotes: z.string().optional(),
});

// Emergency
// Issue #171 (Apr 2026): the create schema previously allowed BOTH
// patientId and unknownName to be absent — and the route happily wrote
// an orphan ER case row with no patient identity. Now we require
// EXACTLY one of:
//   - `patientId` (UUID) for a registered chart, OR
//   - `unknownName` (non-empty trimmed string) for John/Jane Doe intake.
// The ER intake form already exposes a 2-tab toggle (Registered /
// Unknown) so this matches the UI contract; orphan rows are blocked at
// the API even if a stale client misses the toggle.
// Issue #424: every free-text field on this payload must reject XSS markup
// — chiefComplaint is the worst because it's rendered into the chart, but
// unknownName / unknownGender / arrivalMode are also displayed elsewhere
// (intake list, audit log, MCI dashboard).
export const createEmergencyCaseSchema = z
  .object({
    patientId: z.string().uuid().optional(),
    unknownName: z
      .string()
      .trim()
      .refine((v) => !containsHtmlOrScript(v), {
        message:
          "Unknown patient name contains characters that aren't allowed (e.g. < > or HTML tags)",
      })
      .optional(),
    unknownAge: z.number().int().nonnegative().optional(),
    unknownGender: noHtmlOrScript("Unknown patient gender").optional(),
    arrivalMode: noHtmlOrScript("Arrival mode").optional(),
    chiefComplaint: noHtmlOrScript("Chief complaint", 1),
  })
  .superRefine((data, ctx) => {
    const hasPatient = !!data.patientId;
    const hasUnknown = !!data.unknownName && data.unknownName.length > 0;
    if (!hasPatient && !hasUnknown) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["patientId"],
        message:
          "Patient is required: select a registered patient or provide a name for an unknown intake.",
      });
    }
  });

export const triageSchema = z.object({
  caseId: z.string().uuid(),
  triageLevel: z.enum(TRIAGE_LEVELS),
  // Issue #424: vitalsBP is the only free-text field on the triage form
  // (e.g. "130/80"); reject HTML/script payloads.
  vitalsBP: noHtmlOrScript("Blood pressure").optional(),
  vitalsPulse: z.number().int().optional(),
  vitalsResp: z.number().int().optional(),
  vitalsSpO2: z.number().int().optional(),
  vitalsTemp: z.number().optional(),
  glasgowComa: z.number().int().min(3).max(15).optional(),
  mewsScore: z.number().int().min(0).max(14).optional(),
});

export const assignEmergencyDoctorSchema = z.object({
  attendingDoctorId: z.string().uuid(),
});

// Issue #88 (Apr 2026): closing an ER case requires both a disposition string
// and outcome notes (audit trail + clinical handoff). They were previously
// optional which let nurses save with empty fields and just a generic
// "Validation failed" toast on the UI.
// Issue #424: both `disposition` and `outcomeNotes` were stored XSS sinks —
// the close modal lets the doctor type free text, then the chart detail page
// renders both directly. Reject HTML/script payloads at the schema layer.
export const updateEmergencyStatusSchema = z.object({
  status: z.enum(EMERGENCY_STATUS),
  attendingDoctorId: z.string().uuid().optional(),
  disposition: z
    .string({ required_error: "Disposition is required" })
    .trim()
    .min(1, "Disposition is required")
    .refine((v) => !containsHtmlOrScript(v), {
      message:
        "Disposition contains characters that aren't allowed (e.g. < > or HTML tags)",
    }),
  outcomeNotes: z
    .string({ required_error: "Outcome notes are required" })
    .trim()
    .min(1, "Outcome notes are required")
    .refine((v) => !containsHtmlOrScript(v), {
      message:
        "Outcome notes contain characters that aren't allowed (e.g. < > or HTML tags)",
    }),
});

// Issue #424: MLC fields are rendered into the chart and the medico-legal
// printout — XSS payload there would be highly embarrassing. Reject markup.
export const mlcDetailsSchema = z.object({
  isMLC: z.boolean(),
  mlcNumber: noHtmlOrScript("MLC number").optional(),
  mlcPoliceStation: noHtmlOrScript("Police station").optional(),
  mlcFIRNumber: noHtmlOrScript("FIR number").optional(),
  mlcOfficerName: noHtmlOrScript("Officer name").optional(),
});

// Issue #424: ER treatment orders are serialised to JSON and rendered back as
// a list — every free-text leg of each order needs the same XSS guard.
export const erTreatmentOrderSchema = z.object({
  orders: z.array(
    z.object({
      type: z.enum(["MEDICATION", "PROCEDURE", "INVESTIGATION", "OTHER"]),
      name: noHtmlOrScript("Order name", 1),
      dose: noHtmlOrScript("Dose").optional(),
      route: noHtmlOrScript("Route").optional(),
      givenAt: z.string().datetime().optional(),
      notes: noHtmlOrScript("Order notes").optional(),
    })
  ),
});

// Issue #424: admission reason / diagnosis flow into the IPD chart on convert.
export const erToAdmissionSchema = z.object({
  doctorId: z.string().uuid(),
  bedId: z.string().uuid(),
  reason: noHtmlOrScript("Reason", 1),
  diagnosis: noHtmlOrScript("Diagnosis").optional(),
});

// Issue #424: incidentNote becomes the MCI tag rendered on every casualty row.
export const massCasualtySchema = z.object({
  count: z.number().int().min(1).max(50),
  incidentNote: noHtmlOrScript("Incident note").optional(),
  arrivalMode: noHtmlOrScript("Arrival mode").optional().default("MASS_CASUALTY"),
});

export const telemedTechIssuesSchema = z.object({
  technicalIssues: z.string().min(1),
});

export const telemedFollowUpSchema = z.object({
  followUpScheduledAt: z.string().datetime(),
});

export const telemedPrescriptionSchema = z.object({
  items: z.array(
    z.object({
      medicineName: z.string().min(1),
      dosage: z.string().min(1),
      frequency: z.string().min(1),
      duration: z.string().optional(),
      instructions: z.string().optional(),
    })
  ).min(1),
  advice: z.string().optional(),
});

// ─── Jitsi deep-integration schemas (Apr 2026) ──────────────
export const telemedWaitingRoomJoinSchema = z.object({
  deviceInfo: z
    .object({
      userAgent: z.string().optional(),
      camera: z.boolean().optional(),
      mic: z.boolean().optional(),
    })
    .optional(),
});

export const telemedWaitingRoomAdmitSchema = z.object({
  admit: z.boolean(),
  reason: z.string().max(500).optional(),
});

export const telemedPrecheckSchema = z.object({
  camera: z.boolean(),
  mic: z.boolean(),
  bandwidthKbps: z.number().int().nonnegative().optional(),
  userAgent: z.string().max(500).optional(),
});

export const telemedRecordingStartSchema = z.object({
  consent: z.boolean(),
});

export const telemedRecordingStopSchema = z.object({
  recordingUrl: z.string().url().optional(),
});

export type CreateTelemedicineInput = z.infer<typeof createTelemedicineSchema>;
export type UpdateTelemedicineStatusInput = z.infer<
  typeof updateTelemedicineStatusSchema
>;
export type RateTelemedicineInput = z.infer<typeof rateTelemedicineSchema>;
export type EndTelemedicineInput = z.infer<typeof endTelemedicineSchema>;
export type CreateEmergencyCaseInput = z.infer<
  typeof createEmergencyCaseSchema
>;
export type TriageInput = z.infer<typeof triageSchema>;
export type AssignEmergencyDoctorInput = z.infer<
  typeof assignEmergencyDoctorSchema
>;
export type UpdateEmergencyStatusInput = z.infer<
  typeof updateEmergencyStatusSchema
>;
export type MLCDetailsInput = z.infer<typeof mlcDetailsSchema>;
export type ERTreatmentOrderInput = z.infer<typeof erTreatmentOrderSchema>;
export type ERToAdmissionInput = z.infer<typeof erToAdmissionSchema>;
export type MassCasualtyInput = z.infer<typeof massCasualtySchema>;
export type TelemedTechIssuesInput = z.infer<typeof telemedTechIssuesSchema>;
export type TelemedFollowUpInput = z.infer<typeof telemedFollowUpSchema>;
export type TelemedPrescriptionInput = z.infer<typeof telemedPrescriptionSchema>;
export type TelemedWaitingRoomJoinInput = z.infer<typeof telemedWaitingRoomJoinSchema>;
export type TelemedWaitingRoomAdmitInput = z.infer<typeof telemedWaitingRoomAdmitSchema>;
export type TelemedPrecheckInput = z.infer<typeof telemedPrecheckSchema>;
export type TelemedRecordingStartInput = z.infer<typeof telemedRecordingStartSchema>;
export type TelemedRecordingStopInput = z.infer<typeof telemedRecordingStopSchema>;

// ─── Surgery: Anesthesia record (Apr 2026) ───────────
export const ANESTHESIA_TYPES = [
  "GENERAL",
  "SPINAL",
  "EPIDURAL",
  "LOCAL",
  "REGIONAL",
  "SEDATION",
] as const;

export const anesthesiaRecordSchema = z.object({
  anesthetist: z.string().optional(),
  anesthesiaType: z.enum(ANESTHESIA_TYPES),
  inductionAt: z.string().datetime().optional(),
  extubationAt: z.string().datetime().optional(),
  agents: z
    .array(
      z.object({
        name: z.string().min(1),
        dose: z.string().optional(),
        time: z.string().optional(),
      })
    )
    .optional(),
  vitalsLog: z
    .array(
      z.object({
        time: z.string(),
        bp: z.string().optional(),
        hr: z.number().optional(),
        spo2: z.number().optional(),
        etco2: z.number().optional(),
      })
    )
    .optional(),
  ivFluids: z
    .array(
      z.object({
        fluid: z.string().min(1),
        volume: z.number().positive(),
        time: z.string().optional(),
      })
    )
    .optional(),
  bloodLossMl: z.number().int().nonnegative().optional(),
  urineOutputMl: z.number().int().nonnegative().optional(),
  complications: z.string().optional(),
  recoveryNotes: z.string().optional(),
});

// ─── Surgery: Blood requirement check ────────────────
export const bloodRequirementSchema = z.object({
  component: z.enum([
    "WHOLE_BLOOD",
    "PACKED_RED_CELLS",
    "PLATELETS",
    "FRESH_FROZEN_PLASMA",
    "CRYOPRECIPITATE",
  ]),
  units: z.number().int().min(1).max(20),
  autoReserve: z.boolean().optional().default(true),
});

// ─── Surgery: Post-op observation ────────────────────
export const postOpObservationSchema = z.object({
  bpSystolic: z.number().int().min(0).max(300).optional(),
  bpDiastolic: z.number().int().min(0).max(200).optional(),
  pulse: z.number().int().min(0).max(250).optional(),
  spO2: z.number().int().min(0).max(100).optional(),
  painScore: z.number().int().min(0).max(10).optional(),
  consciousness: z.enum(["ALERT", "DROWSY", "UNRESPONSIVE"]).optional(),
  nausea: z.boolean().optional(),
  notes: z.string().optional(),
});

// ─── Surgery: SSI report ─────────────────────────────
export const ssiReportSchema = z.object({
  ssiType: z.enum(["SUPERFICIAL", "DEEP", "ORGAN_SPACE"]),
  detectedDate: z.string(),
  treatment: z.string().optional(),
});

export type AnesthesiaRecordInput = z.infer<typeof anesthesiaRecordSchema>;
export type BloodRequirementInput = z.infer<typeof bloodRequirementSchema>;
export type PostOpObservationInput = z.infer<typeof postOpObservationSchema>;
export type SsiReportInput = z.infer<typeof ssiReportSchema>;
