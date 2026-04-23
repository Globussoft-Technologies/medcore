import { z } from "zod";

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
export const createTelemedicineSchema = z.object({
  patientId: z.string().uuid(),
  doctorId: z.string().uuid(),
  scheduledAt: z.string().datetime(),
  chiefComplaint: z.string().optional(),
  fee: z.number().nonnegative().default(500),
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
export const createEmergencyCaseSchema = z.object({
  patientId: z.string().uuid().optional(),
  unknownName: z.string().optional(),
  unknownAge: z.number().int().nonnegative().optional(),
  unknownGender: z.string().optional(),
  arrivalMode: z.string().optional(),
  chiefComplaint: z.string().min(1),
});

export const triageSchema = z.object({
  caseId: z.string().uuid(),
  triageLevel: z.enum(TRIAGE_LEVELS),
  vitalsBP: z.string().optional(),
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

export const updateEmergencyStatusSchema = z.object({
  status: z.enum(EMERGENCY_STATUS),
  attendingDoctorId: z.string().uuid().optional(),
  disposition: z.string().optional(),
  outcomeNotes: z.string().optional(),
});

export const mlcDetailsSchema = z.object({
  isMLC: z.boolean(),
  mlcNumber: z.string().optional(),
  mlcPoliceStation: z.string().optional(),
  mlcFIRNumber: z.string().optional(),
  mlcOfficerName: z.string().optional(),
});

export const erTreatmentOrderSchema = z.object({
  orders: z.array(
    z.object({
      type: z.enum(["MEDICATION", "PROCEDURE", "INVESTIGATION", "OTHER"]),
      name: z.string().min(1),
      dose: z.string().optional(),
      route: z.string().optional(),
      givenAt: z.string().datetime().optional(),
      notes: z.string().optional(),
    })
  ),
});

export const erToAdmissionSchema = z.object({
  doctorId: z.string().uuid(),
  bedId: z.string().uuid(),
  reason: z.string().min(1),
  diagnosis: z.string().optional(),
});

export const massCasualtySchema = z.object({
  count: z.number().int().min(1).max(50),
  incidentNote: z.string().optional(),
  arrivalMode: z.string().optional().default("MASS_CASUALTY"),
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
