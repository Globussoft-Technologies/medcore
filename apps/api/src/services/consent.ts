import { prisma } from "@medcore/db";

export type ConsentFeature = "TRIAGE" | "SCRIBE";

export interface ConsentRecord {
  sessionId: string;
  feature: ConsentFeature;
  userId?: string;
  patientId?: string;
  consentGiven: boolean;
  consentAt: Date | null;
  status: "ACTIVE" | "WITHDRAWN" | "COMPLETED";
}

/**
 * Record or update consent for a session.
 */
export async function recordConsent(
  feature: ConsentFeature,
  sessionId: string,
  consentGiven: boolean
): Promise<void> {
  const consentAt = consentGiven ? new Date() : null;

  if (feature === "TRIAGE") {
    await prisma.aITriageSession.update({
      where: { id: sessionId },
      data: { consentGiven, consentAt },
    });
  } else {
    await prisma.aIScribeSession.update({
      where: { id: sessionId },
      data: { consentObtained: consentGiven, consentAt },
    });
  }
}

/**
 * Check if consent is currently active for a session.
 */
export async function checkConsent(
  feature: ConsentFeature,
  sessionId: string
): Promise<{ hasConsent: boolean; consentAt: Date | null }> {
  if (feature === "TRIAGE") {
    const session = await prisma.aITriageSession.findUnique({
      where: { id: sessionId },
      select: { consentGiven: true, consentAt: true, status: true },
    });

    if (!session) return { hasConsent: false, consentAt: null };

    const hasConsent =
      session.consentGiven === true && session.status === "ACTIVE";
    return { hasConsent, consentAt: session.consentAt };
  } else {
    const session = await prisma.aIScribeSession.findUnique({
      where: { id: sessionId },
      select: { consentObtained: true, consentAt: true, status: true },
    });

    if (!session) return { hasConsent: false, consentAt: null };

    const hasConsent =
      session.consentObtained === true && session.status === "ACTIVE";
    return { hasConsent, consentAt: session.consentAt };
  }
}

/**
 * Revoke consent — marks the session as CONSENT_WITHDRAWN (scribe) or ABANDONED (triage)
 * and clears transcript data.
 */
export async function revokeConsent(
  feature: ConsentFeature,
  sessionId: string
): Promise<void> {
  if (feature === "TRIAGE") {
    await prisma.aITriageSession.update({
      where: { id: sessionId },
      data: { status: "ABANDONED" },
    });
  } else {
    await prisma.aIScribeSession.update({
      where: { id: sessionId },
      data: {
        status: "CONSENT_WITHDRAWN",
        transcript: [] as any,
      },
    });
  }
}

/**
 * Get full consent history for a patient, merged from both session tables,
 * sorted by consentAt descending.
 */
export async function getConsentHistory(
  patientId: string
): Promise<ConsentRecord[]> {
  const [triageSessions, scribeSessions] = await Promise.all([
    prisma.aITriageSession.findMany({
      where: { patientId },
      select: {
        id: true,
        patientId: true,
        consentGiven: true,
        consentAt: true,
        status: true,
      },
    }),
    prisma.aIScribeSession.findMany({
      where: { patientId },
      select: {
        id: true,
        patientId: true,
        consentObtained: true,
        consentAt: true,
        status: true,
      },
    }),
  ]);

  const triageRecords: ConsentRecord[] = triageSessions.map((s) => ({
    sessionId: s.id,
    feature: "TRIAGE" as ConsentFeature,
    patientId: s.patientId ?? undefined,
    consentGiven: s.consentGiven ?? false,
    consentAt: s.consentAt,
    status: mapTriageStatus(s.status),
  }));

  const scribeRecords: ConsentRecord[] = scribeSessions.map((s) => ({
    sessionId: s.id,
    feature: "SCRIBE" as ConsentFeature,
    patientId: s.patientId,
    consentGiven: s.consentObtained,
    consentAt: s.consentAt,
    status: mapScribeStatus(s.status),
  }));

  const all = [...triageRecords, ...scribeRecords];

  // Sort by consentAt descending — sessions without a consentAt go last
  all.sort((a, b) => {
    if (!a.consentAt && !b.consentAt) return 0;
    if (!a.consentAt) return 1;
    if (!b.consentAt) return -1;
    return b.consentAt.getTime() - a.consentAt.getTime();
  });

  return all;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mapTriageStatus(
  status: string
): "ACTIVE" | "WITHDRAWN" | "COMPLETED" {
  if (status === "ABANDONED" || status === "EMERGENCY_DETECTED") return "WITHDRAWN";
  if (status === "COMPLETED") return "COMPLETED";
  return "ACTIVE";
}

function mapScribeStatus(
  status: string
): "ACTIVE" | "WITHDRAWN" | "COMPLETED" {
  if (status === "CONSENT_WITHDRAWN") return "WITHDRAWN";
  if (status === "COMPLETED") return "COMPLETED";
  return "ACTIVE";
}
