import { z } from "zod";

export const createPatientSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  dateOfBirth: z.string().optional(),
  age: z.number().int().min(0).max(150).optional(),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]),
  phone: z.string().min(10, "Phone number must be at least 10 digits"),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().optional(),
  bloodGroup: z
    .enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"])
    .optional(),
  emergencyContactName: z.string().optional(),
  emergencyContactPhone: z.string().optional(),
  insuranceProvider: z.string().optional(),
  insurancePolicyNumber: z.string().optional(),
  maritalStatus: z
    .enum(["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "SEPARATED"])
    .optional(),
  occupation: z.string().optional(),
  religion: z.string().optional(),
  preferredLanguage: z.string().optional(),
  abhaId: z.string().optional(),
  aadhaarMasked: z.string().optional(),
  photoUrl: z.string().url().optional().or(z.literal("")),
});

export const updatePatientSchema = createPatientSchema.partial();

export const mergePatientSchema = z.object({
  otherPatientId: z.string().uuid(),
});

export const recordVitalsSchema = z.object({
  appointmentId: z.string().uuid(),
  patientId: z.string().uuid(),
  bloodPressureSystolic: z.number().int().min(50).max(300).optional(),
  bloodPressureDiastolic: z.number().int().min(30).max(200).optional(),
  temperature: z.number().min(0).max(120).optional(),
  temperatureUnit: z.enum(["F", "C"]).optional(),
  weight: z.number().min(0.5).max(500).optional(),
  height: z.number().min(20).max(300).optional(),
  pulseRate: z.number().int().min(20).max(300).optional(),
  spO2: z.number().int().min(0).max(100).optional(),
  respiratoryRate: z.number().int().min(5).max(80).optional(),
  painScale: z.number().int().min(0).max(10).optional(),
  notes: z.string().optional(),
});

export type CreatePatientInput = z.infer<typeof createPatientSchema>;
export type UpdatePatientInput = z.infer<typeof updatePatientSchema>;
export type MergePatientInput = z.infer<typeof mergePatientSchema>;
export type RecordVitalsInput = z.infer<typeof recordVitalsSchema>;
