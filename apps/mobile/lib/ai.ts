/**
 * AI feature API client for the mobile app.
 *
 * Wraps the backend AI routes mounted under /api/v1/ai/*.
 * Uses the same fetch + SecureStore-based auth flow as ./api.ts, but
 * kept in its own module so AI features can evolve independently.
 */

import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { ApiError, API_BASE_URL } from "./api";

const ACCESS_TOKEN_KEY = "medcore_access_token";

// Resolve base URL identical to lib/api.ts so both share the same backend.
const FALLBACK_URL = "https://medcore.globusdemos.com/api/v1";
const BASE_URL: string =
  API_BASE_URL ||
  (process.env.EXPO_PUBLIC_API_URL as string | undefined) ||
  (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ||
  FALLBACK_URL;

async function getAccessToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
  } catch {
    return null;
  }
}

async function aiRequest<T = any>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${endpoint}`, { ...options, headers });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (body as any)?.message || (body as any)?.error || res.statusText, body);
  }
  return res.json();
}

// ── AI Triage ─────────────────────────────────────────────────────────────

export type TriageLanguage = "en" | "hi";
export type TriageInputMode = "text" | "voice";

export interface TriageMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
}

export interface StartTriagePayload {
  language: TriageLanguage;
  inputMode: TriageInputMode;
  patientId?: string;
  isForDependent?: boolean;
  dependentRelationship?: string;
  consentGiven?: boolean;
  bookingFor?: "SELF" | "DEPENDENT";
  dependentPatientId?: string;
}

export interface StartTriageResponse {
  sessionId: string;
  message: string;
  language: TriageLanguage;
  disclaimer: string;
}

export interface SendTriageMessageResponse {
  message: string;
  isEmergency?: boolean;
  emergencyReason?: string | null;
  sessionStatus?: string;
  suggestedSpecialties?: Array<{ specialty: string; confidence: number; reasoning?: string }>;
  confidence?: number;
}

export interface TriageDoctorSuggestion {
  doctorId: string;
  name: string;
  specialty: string;
  subSpecialty: string | null;
  qualification?: string | null;
  photoUrl?: string | null;
  experienceYears: number | null;
  languages: string[];
  rating: number | null;
  consultationFee: number | null;
  consultationMode: string;
  reasoning: string;
  confidence: number;
}

export interface TriageSessionSummary {
  session: {
    id: string;
    status: string;
    language: TriageLanguage;
    messages: TriageMessage[];
    redFlagDetected: boolean;
    redFlagReason: string | null;
    confidence: number | null;
  };
  doctorSuggestions: TriageDoctorSuggestion[];
}

/**
 * POST /api/v1/ai/triage/start
 * Creates a new AI triage chat session.
 */
export async function startTriageSession(
  payload: StartTriagePayload = { language: "en", inputMode: "text" }
): Promise<StartTriageResponse> {
  const res = await aiRequest<{ success: boolean; data: StartTriageResponse; error: string | null }>(
    "/ai/triage/start",
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );
  return res.data;
}

/**
 * POST /api/v1/ai/triage/:sessionId/message
 * Sends a user turn and returns the assistant reply (or emergency notice).
 */
export async function sendTriageMessage(
  sessionId: string,
  message: string,
  language?: TriageLanguage
): Promise<SendTriageMessageResponse> {
  const res = await aiRequest<{ success: boolean; data: SendTriageMessageResponse; error: string | null }>(
    `/ai/triage/${sessionId}/message`,
    {
      method: "POST",
      body: JSON.stringify({ message, ...(language ? { language } : {}) }),
    }
  );
  return res.data;
}

/**
 * GET /api/v1/ai/triage/:sessionId
 * Returns session state + matched doctor suggestions.
 */
export async function getTriageSummary(
  sessionId: string
): Promise<TriageSessionSummary> {
  const res = await aiRequest<{ success: boolean; data: TriageSessionSummary; error: string | null }>(
    `/ai/triage/${sessionId}`
  );
  return res.data;
}

/**
 * POST /api/v1/ai/triage/:sessionId/book
 * Books the chosen appointment from a triage session.
 */
export async function bookTriageAppointment(
  sessionId: string,
  payload: {
    doctorId: string;
    date: string;
    slotStart: string;
    slotEnd?: string;
    patientId?: string;
  }
): Promise<any> {
  const res = await aiRequest<{ success: boolean; data: any; error: string | null }>(
    `/ai/triage/${sessionId}/book`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );
  return res.data;
}

// ── Lab Report Explainer ──────────────────────────────────────────────────

export type LabFlag =
  | "NORMAL"
  | "HIGH"
  | "LOW"
  | "CRITICAL_HIGH"
  | "CRITICAL_LOW"
  | "ABNORMAL";

export interface LabFlaggedValue {
  parameter: string;
  value: string;
  flag: LabFlag | string;
  plainLanguage: string;
}

export interface LabReportExplanation {
  id: string;
  labOrderId: string;
  patientId: string;
  explanation: string;
  flaggedValues: LabFlaggedValue[];
  language: "en" | "hi" | string;
  status: "PENDING_REVIEW" | "APPROVED" | "SENT" | string;
  approvedBy: string | null;
  approvedAt: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * GET /api/v1/ai/reports/:labOrderId
 * Returns the AI-generated patient-friendly explanation for a lab order.
 * Patients may only read their own.
 */
export async function fetchLabExplanation(
  labOrderId: string
): Promise<LabReportExplanation> {
  const res = await aiRequest<{ success: boolean; data: LabReportExplanation; error: string | null }>(
    `/ai/reports/${labOrderId}`
  );
  return res.data;
}

// ── Medication Adherence ──────────────────────────────────────────────────

export interface AdherenceMedication {
  name: string;
  dosage: string;
  frequency: string;
  duration: string;
  reminderTimes: string[];
}

export interface AdherenceSchedule {
  id: string;
  patientId: string;
  prescriptionId: string;
  medications: AdherenceMedication[];
  startDate: string;
  endDate: string;
  active: boolean;
  remindersSent: number;
  lastReminderAt: string | null;
  createdAt: string;
}

/**
 * GET /api/v1/ai/adherence/:patientId
 * Returns the active medication reminder schedules for a patient.
 */
export async function fetchAdherenceSchedules(
  patientId: string
): Promise<AdherenceSchedule[]> {
  const res = await aiRequest<{ success: boolean; data: AdherenceSchedule[]; error: string | null }>(
    `/ai/adherence/${patientId}`
  );
  return res.data ?? [];
}

/**
 * POST /api/v1/ai/adherence/enroll
 * Enrolls a prescription into the adherence / reminder system.
 */
export async function enrollAdherence(payload: {
  prescriptionId: string;
  reminderTimes?: string[];
}): Promise<AdherenceSchedule> {
  const res = await aiRequest<{ success: boolean; data: AdherenceSchedule; error: string | null }>(
    "/ai/adherence/enroll",
    {
      method: "POST",
      body: JSON.stringify(payload),
    }
  );
  return res.data;
}

/**
 * DELETE /api/v1/ai/adherence/:scheduleId
 * Unenrolls a medication reminder schedule.
 */
export async function unenrollAdherence(scheduleId: string): Promise<void> {
  await aiRequest(`/ai/adherence/${scheduleId}`, { method: "DELETE" });
}
