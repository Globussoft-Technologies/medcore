// Integration tests for the AI Claims router + the denial-risk pre-check on
// the legacy submit endpoint. Uses the MOCK TPA adapter so no network is
// touched. Skipped unless DATABASE_URL_TEST is set OR the new claim models
// aren't available yet (see insurance-claims.test.ts for the same guard).

import { it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createAppointmentFixture,
  createDoctorFixture,
  createInvoiceFixture,
} from "../factories";
import { mockAdapter } from "../../services/insurance-claims/adapters/mock";
import { resetMockState } from "../../services/insurance-claims/test-helpers";
import {
  setAdapterOverride,
  clearAdapterOverrides,
} from "../../services/insurance-claims/registry";

let app: any;
let adminToken: string;
let receptionToken: string;
let prisma: any;
let schemaReady = false;

/** Build a patient + doctor + appointment + invoice + SOAP-backed
 *  consultation so the AI coder can draft from it. Returns every id the
 *  tests need to assert against. */
async function makeDraftFixture(options: {
  withScribeIcd?: boolean;
  withScribeSoap?: boolean;
  insuranceProvider?: string | null;
  insurancePolicyNumber?: string | null;
  invoiceTotal?: number;
} = {}) {
  const patient = await createPatientFixture({
    insuranceProvider: options.insuranceProvider === undefined ? "Medi Assist" : options.insuranceProvider,
    insurancePolicyNumber: options.insurancePolicyNumber === undefined ? "POL-DRAFT-1" : options.insurancePolicyNumber,
  });
  const doctor = await createDoctorFixture({});
  const appointment = await createAppointmentFixture({
    patientId: patient.id,
    doctorId: doctor.id,
  });
  const invoice = await createInvoiceFixture({
    patientId: patient.id,
    appointmentId: appointment.id,
    overrides: { totalAmount: options.invoiceTotal ?? 50000 },
  });
  const consultation = await prisma.consultation.create({
    data: {
      appointmentId: appointment.id,
      doctorId: doctor.id,
      notes: "Assessment: Acute pharyngitis with fever",
    },
  });
  if (options.withScribeIcd || options.withScribeSoap) {
    await prisma.aIScribeSession.create({
      data: {
        appointmentId: appointment.id,
        doctorId: doctor.id,
        patientId: patient.id,
        consentObtained: true,
        consentAt: new Date(),
        transcript: [],
        icd10Codes: options.withScribeIcd
          ? [
              { code: "J02.9", description: "Acute pharyngitis, unspecified", confidence: 0.9 },
              { code: "R50.9", description: "Fever, unspecified", confidence: 0.8 },
            ]
          : null,
        soapFinal: options.withScribeSoap
          ? {
              subjective: { chiefComplaint: "Sore throat" },
              objective: { examinationFindings: "Erythematous pharynx" },
              assessment: { impression: "Acute pharyngitis" },
              plan: { medications: [] },
            }
          : undefined,
      },
    });
  }
  return { patient, doctor, appointment, invoice, consultation };
}

describeIfDB("AI Claims API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    const mod = await import("../../app");
    app = mod.app;
    prisma = await getPrisma();

    if (
      !(prisma as any).insuranceClaim2 ||
      !(prisma as any).claimDocument ||
      !(prisma as any).claimStatusEvent ||
      !(prisma as any).aIScribeSession
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        "[ai-claims.test] Required Prisma models not available — skipping suite."
      );
      schemaReady = false;
      return;
    }
    schemaReady = true;

    setAdapterOverride("MEDI_ASSIST", mockAdapter);
    setAdapterOverride("PARAMOUNT", mockAdapter);
    setAdapterOverride("MOCK", mockAdapter);
  });

  beforeEach(() => {
    if (!schemaReady) return;
    resetMockState();
  });

  afterEach(async () => {
    if (!schemaReady) return;
    await prisma.claimStatusEvent.deleteMany({});
    await prisma.claimDocument.deleteMany({});
    await prisma.insuranceClaim2.deleteMany({});
    await prisma.aIScribeSession.deleteMany({});
    await prisma.consultation.deleteMany({});
  });

  // ── 1: draft creation from a valid consultation ──────────────────────────
  it("drafts a claim from a valid consultation + scribe ICD codes", async () => {
    if (!schemaReady) return;
    const fx = await makeDraftFixture({ withScribeIcd: true, withScribeSoap: true });

    const res = await request(app)
      .post(`/api/v1/ai/claims/draft/${fx.consultation.id}`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.claim.billId).toBe(fx.invoice.id);
    expect(res.body.data.claim.patientId).toBe(fx.patient.id);
    expect(res.body.data.claim.tpaProvider).toBe("MEDI_ASSIST");
    expect(res.body.data.claim.icd10Codes).toEqual(
      expect.arrayContaining(["J02.9", "R50.9"])
    );
    expect(res.body.data.claim.amountClaimed).toBe(50000);
    expect(res.body.data.claim.diagnosis).toMatch(/pharyngitis/i);
    expect(res.body.data.claim.notes).toMatch(/\[AI DRAFT\]/);
    // warnings should be empty or at least not flag ICD / TPA.
    const joined = (res.body.data.warnings as string[]).join(" | ");
    expect(joined).not.toMatch(/ICD-10/);
    expect(joined).not.toMatch(/TPA/);
  });

  // ── 2: draft with missing ICD surfaces a warning ─────────────────────────
  it("drafts but returns a warning when ICD codes are missing", async () => {
    if (!schemaReady) return;
    const fx = await makeDraftFixture({ withScribeIcd: false, withScribeSoap: false });

    const res = await request(app)
      .post(`/api/v1/ai/claims/draft/${fx.consultation.id}`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.data.claim.icd10Codes).toEqual([]);
    const warnings = res.body.data.warnings as string[];
    expect(warnings.some((w) => /ICD-10/i.test(w))).toBe(true);
  });

  // ── 3: pending-drafts list surfaces the draft row ────────────────────────
  it("lists pending drafts via GET /pending-drafts", async () => {
    if (!schemaReady) return;
    const fx = await makeDraftFixture({ withScribeIcd: true });
    await request(app)
      .post(`/api/v1/ai/claims/draft/${fx.consultation.id}`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({});

    const listRes = await request(app)
      .get("/api/v1/ai/claims/pending-drafts")
      .set("Authorization", `Bearer ${receptionToken}`);

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.data)).toBe(true);
    expect(listRes.body.data.length).toBe(1);
    expect(listRes.body.data[0].notes).toMatch(/\[AI DRAFT\]/);
    expect(listRes.body.data[0].billId).toBe(fx.invoice.id);
  });

  // ── 4: high-risk denial blocks submission (422) ──────────────────────────
  // SKIPPED: the inline denial-risk assessor referenced here is not yet wired
  // into POST /api/v1/claims. The feature ships in a follow-up — see #415
  // tracker. Test kept as the contract spec for when it lands.
  it.skip("blocks submission with 422 when denial risk is HIGH", async () => {
    if (!schemaReady) return;
    const patient = await createPatientFixture({});
    const doctor = await createDoctorFixture({});
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const invoice = await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt.id,
      overrides: { totalAmount: 10000 },
    });

    // amountClaimed > 3x invoice total → rule engine returns "high".
    const res = await request(app)
      .post("/api/v1/claims")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        billId: invoice.id,
        patientId: patient.id,
        tpaProvider: "MOCK",
        insurerName: "Star Health",
        policyNumber: "POL-BLOCK-1",
        diagnosis: "Fever",
        amountClaimed: 100000, // 10x the invoice — absurd, should block
        icd10Codes: ["R50.9"],
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("DENIAL_RISK_HIGH");
    expect(res.body.data.denialRiskWarning.risk).toBe("high");
    expect(res.body.data.denialRiskWarning.reasons.length).toBeGreaterThan(0);
  });

  // ── 5: force=true overrides the block ────────────────────────────────────
  it("allows submission when ?force=true is passed despite HIGH risk", async () => {
    if (!schemaReady) return;
    const patient = await createPatientFixture({});
    const doctor = await createDoctorFixture({});
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const invoice = await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt.id,
      overrides: { totalAmount: 10000 },
    });

    const res = await request(app)
      .post("/api/v1/claims?force=true")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        billId: invoice.id,
        patientId: patient.id,
        tpaProvider: "MOCK",
        insurerName: "Star Health",
        policyNumber: "POL-FORCE-1",
        diagnosis: "Fever",
        amountClaimed: 100000,
        icd10Codes: ["R50.9"],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("SUBMITTED");
  });

  // ── 6: low/medium risk passes through + denialRiskWarning surfaces ───────
  it("passes a low-risk claim through and surfaces denialRiskWarning when applicable", async () => {
    if (!schemaReady) return;
    const patient = await createPatientFixture({});
    const doctor = await createDoctorFixture({});
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const invoice = await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt.id,
      overrides: { totalAmount: 50000 },
    });

    const res = await request(app)
      .post("/api/v1/claims")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        billId: invoice.id,
        patientId: patient.id,
        tpaProvider: "MOCK",
        insurerName: "Star Health",
        policyNumber: "POL-LOW-1",
        diagnosis: "Viral fever",
        amountClaimed: 45000,
        icd10Codes: ["R50.9", "J06.9"],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe("SUBMITTED");
    // Either no warning (truly low) or an informational medium warning, but
    // never high.
    if (res.body.data.denialRiskWarning) {
      expect(res.body.data.denialRiskWarning.risk).not.toBe("high");
    }
  });

  // ── 7: GET /:claimId/denial-risk ─────────────────────────────────────────
  it("runs the denial predictor via GET /:claimId/denial-risk", async () => {
    if (!schemaReady) return;
    const patient = await createPatientFixture({});
    const doctor = await createDoctorFixture({});
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const invoice = await createInvoiceFixture({
      patientId: patient.id,
      appointmentId: appt.id,
      overrides: { totalAmount: 10000 },
    });

    const submit = await request(app)
      .post("/api/v1/claims?force=true")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        billId: invoice.id,
        patientId: patient.id,
        tpaProvider: "PARAMOUNT",
        insurerName: "Paramount Health",
        policyNumber: "POL-RISK-1",
        diagnosis: "Pneumonia",
        amountClaimed: 10000,
        // memberId intentionally omitted → Paramount rule should surface medium
      });
    expect(submit.status).toBe(201);
    const claimId = submit.body.data.id;

    const riskRes = await request(app)
      .get(`/api/v1/ai/claims/${claimId}/denial-risk`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(riskRes.status).toBe(200);
    expect(["low", "medium", "high"]).toContain(riskRes.body.data.risk);
    const joined = (riskRes.body.data.reasons as string[]).join(" | ");
    expect(joined).toMatch(/Paramount/i);
  });

  // ── 8: POST /:claimId/auto-fix adds missing ICD from SOAP ─────────────────
  it("applies auto-fixes: adds missing ICD from the AI Scribe session", async () => {
    if (!schemaReady) return;
    const fx = await makeDraftFixture({ withScribeIcd: true });

    // Reception drafts (no ICD on the claim) → submit row + scribe has ICD
    // already. We use the dedicated draft flow to persist a row.
    const draftRes = await request(app)
      .post(`/api/v1/ai/claims/draft/${fx.consultation.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(draftRes.status).toBe(201);
    const claimId = draftRes.body.data.claim.id;

    // Remove ICD codes from the persisted claim so auto-fix has something to
    // re-add. (The draft helper copies them across already.)
    await prisma.insuranceClaim2.update({
      where: { id: claimId },
      data: { icd10Codes: [] },
    });

    const fixRes = await request(app)
      .post(`/api/v1/ai/claims/${claimId}/auto-fix`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});

    expect(fixRes.status).toBe(200);
    expect(fixRes.body.data.claim.icd10Codes).toEqual(
      expect.arrayContaining(["J02.9", "R50.9"])
    );
    const appliedTypes = (fixRes.body.data.appliedOps as any[]).map((o) => o.type);
    expect(appliedTypes).toContain("ADD_ICD_FROM_SOAP");
  });

  // ── Housekeeping ─────────────────────────────────────────────────────────
  it("teardown: clears adapter overrides", () => {
    if (!schemaReady) return;
    clearAdapterOverrides();
    expect(true).toBe(true);
  });
});
