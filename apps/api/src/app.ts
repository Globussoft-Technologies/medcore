import * as Sentry from "@sentry/node";

// Sentry must be initialised before any other imports so it can instrument
// frameworks and capture errors that happen during startup.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    // SENTRY_RELEASE is set by scripts/deploy.sh to the deploying SHA
    // (CI hardening Phase 4.2) so each error in Sentry is correlated
    // back to the exact commit that introduced it. Falls back to
    // undefined when running locally; Sentry's "release health"
    // dashboards remain functional but unattributed.
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: 0.2,
  });
}

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { createServer } from "http";
import { Server as SocketServer } from "socket.io";
import { authRouter } from "./routes/auth";
import { patientRouter } from "./routes/patients";
import { appointmentRouter } from "./routes/appointments";
import { doctorRouter } from "./routes/doctors";
import { billingRouter, razorpayWebhookRouter } from "./routes/billing";
import { prescriptionRouter, publicPrescriptionRouter } from "./routes/prescriptions";
import { queueRouter } from "./routes/queue";
import { notificationRouter } from "./routes/notifications";
import { auditRouter } from "./routes/audit";
import { analyticsRouter } from "./routes/analytics";
import { medicineRouter } from "./routes/medicines";
import { pharmacyRouter } from "./routes/pharmacy";
import { labRouter, publicLabRouter } from "./routes/lab";
import { controlledSubstancesRouter } from "./routes/controlled-substances";
import { wardRouter, bedsRouter } from "./routes/wards";
import { admissionRouter } from "./routes/admissions";
import { medicationRouter } from "./routes/medication";
import { nurseRoundRouter } from "./routes/nurse-rounds";
import { ehrRouter } from "./routes/ehr";
import { icd10Router } from "./routes/icd10";
import { uploadsRouter } from "./routes/uploads";
import { referralRouter } from "./routes/referrals";
import { surgeryRouter } from "./routes/surgery";
import { shiftRouter } from "./routes/shifts";
import { leaveRouter } from "./routes/leaves";
import { packageRouter } from "./routes/packages";
import { supplierRouter } from "./routes/suppliers";
import { purchaseOrderRouter } from "./routes/purchase-orders";
import { expenseRouter } from "./routes/expenses";
import { telemedicineRouter } from "./routes/telemedicine";
import { emergencyRouter } from "./routes/emergency";
import { antenatalRouter } from "./routes/antenatal";
import { growthRouter } from "./routes/growth";
import { bloodbankRouter } from "./routes/bloodbank";
import { ambulanceRouter } from "./routes/ambulance";
import { assetsRouter } from "./routes/assets";
import { feedbackRouter, complaintsRouter } from "./routes/feedback";
import { marketingRouter } from "./routes/marketing";
import { chatRouter } from "./routes/chat";
import { visitorsRouter } from "./routes/visitors";
import { hrOpsRouter } from "./routes/hr-ops";
import { searchRouter } from "./routes/search";
import { waitlistRouter } from "./routes/waitlist";
import { coordinatedVisitRouter } from "./routes/coordinated-visits";
import { paymentPlansRouter } from "./routes/payment-plans";
import { preauthRouter } from "./routes/preauth";
import { medReconciliationRouter } from "./routes/med-reconciliation";
import { scheduledReportsRouter } from "./routes/scheduled-reports";
import { patientExtrasRouter } from "./routes/patient-extras";
import { usersRouter } from "./routes/users";
import { aiTriageRouter } from "./routes/ai-triage";
import { aiScribeRouter } from "./routes/ai-scribe";
import { aiTranscribeRouter } from "./routes/ai-transcribe";
import { aiReportExplainerRouter } from "./routes/ai-report-explainer";
import { aiPredictionsRouter } from "./routes/ai-predictions";
import { aiLettersRouter } from "./routes/ai-letters";
import { aiERTriageRouter } from "./routes/ai-er-triage";
import { aiPharmacyRouter } from "./routes/ai-pharmacy";
import { aiAdherenceRouter } from "./routes/ai-adherence";
import { aiKnowledgeRouter } from "./routes/ai-knowledge";
import { aiChartSearchRouter } from "./routes/ai-chart-search";
import { fhirRouter } from "./routes/fhir";
import { abdmRouter } from "./routes/abdm";
import { insuranceClaimsRouter } from "./routes/insurance-claims";
import { hl7v2Router } from "./routes/hl7v2";
import { aiRadiologyRouter } from "./routes/ai-radiology";
import { aiAdminRouter } from "./routes/ai-admin";
import { aiBillExplainerRouter } from "./routes/ai-bill-explainer";
import { aiPrevisitRouter } from "./routes/ai-previsit";
import { aiSymptomDiaryRouter } from "./routes/ai-symptom-diary";
import { aiCoachingRouter } from "./routes/ai-coaching";
import { aiDifferentialRouter } from "./routes/ai-differential";
import { aiFollowupRouter } from "./routes/ai-followup";
import { aiLabIntelRouter } from "./routes/ai-lab-intel";
import { aiClaimsRouter } from "./routes/ai-claims";
import { aiCapacityRouter } from "./routes/ai-capacity";
import { aiRosterRouter } from "./routes/ai-roster";
import { aiFraudRouter } from "./routes/ai-fraud";
import { aiDocQaRouter } from "./routes/ai-doc-qa";
import { aiSentimentRouter } from "./routes/ai-sentiment";
import { tenantsRouter } from "./routes/tenants";
import { agentConsoleRouter } from "./routes/agent-console";
import { aiKpisRouter } from "./routes/ai-kpis";
import { healthRouter } from "./routes/health";
import { patientDataExportRouter } from "./routes/patient-data-export";
import { startChronicCareScheduler } from "./services/chronic-care-scheduler";
import { errorHandler } from "./middleware/error";
import { rateLimit } from "./middleware/rate-limit";
import { sanitize } from "./middleware/sanitize";
import { tenantContextMiddleware } from "./middleware/tenant";
import { withTenantContext } from "./services/tenant-context";
import { startRetentionScheduler } from "./services/retention-scheduler";
import { startClaimsScheduler } from "./services/insurance-claims-scheduler";

export function buildApp() {
  const app = express();
  const httpServer = createServer(app);

  // Ensure EHR uploads directory exists at startup
  try {
    const uploadsDir = path.join(process.cwd(), "uploads", "ehr");
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  } catch {
    // ignore in test/CI sandboxes without write permission
  }

  const io = new SocketServer(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN || "http://localhost:3000",
      methods: ["GET", "POST"],
    },
  });

  // Make io accessible to routes
  app.set("io", io);

  // Middleware
  app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:3000" }));

  // Razorpay webhook MUST be mounted before express.json() so the route's
  // own express.raw() middleware can read the unparsed body (HMAC verify
  // requires the exact bytes Razorpay signed). Auth is performed via HMAC
  // signature, NOT JWT, so it is intentionally mounted before authenticate.
  app.use("/api/v1/billing", razorpayWebhookRouter);

  app.use(express.json());
  app.use(sanitize);
  // Rate limiting is disabled in test mode to keep tests fast & deterministic.
  if (process.env.NODE_ENV !== "test") {
    app.use(rateLimit(600, 60_000));
  }

  // Multi-tenancy — resolve tenant from JWT / X-Tenant-Id header and open an
  // AsyncLocalStorage scope that Prisma middleware (see services/tenant-prisma)
  // reads to auto-inject tenantId on create and auto-filter on read. Mounted
  // globally BEFORE any route so every router (each of which does its own
  // `router.use(authenticate)`) runs inside the tenant context. The tenant
  // middleware decodes the JWT itself, so it is safe to mount before auth.
  app.use(tenantContextMiddleware);
  app.use(withTenantContext);

  // Public routes (no auth) — must be mounted BEFORE routers that require auth
  app.use("/api/v1/public", publicLabRouter);
  app.use("/api/v1/public", publicPrescriptionRouter);

  // Routes
  const authLimiter =
    process.env.NODE_ENV === "test" ? (_: any, __: any, n: any) => n() : rateLimit(30, 60_000);
  app.use("/api/v1/auth", authLimiter, authRouter);
  app.use("/api/v1/patients", patientRouter);
  app.use("/api/v1/appointments", appointmentRouter);
  app.use("/api/v1/doctors", doctorRouter);
  app.use("/api/v1/billing", billingRouter);
  app.use("/api/v1/prescriptions", prescriptionRouter);
  app.use("/api/v1/queue", queueRouter);
  app.use("/api/v1/notifications", notificationRouter);
  app.use("/api/v1/audit", auditRouter);
  app.use("/api/v1/analytics", analyticsRouter);
  app.use("/api/v1/medicines", medicineRouter);
  app.use("/api/v1/pharmacy", pharmacyRouter);
  app.use("/api/v1/lab", labRouter);
  app.use("/api/v1/controlled-substances", controlledSubstancesRouter);
  app.use("/api/v1/wards", wardRouter);
  app.use("/api/v1/beds", bedsRouter);
  app.use("/api/v1/admissions", admissionRouter);
  app.use("/api/v1/medication", medicationRouter);
  app.use("/api/v1/nurse-rounds", nurseRoundRouter);
  app.use("/api/v1/ehr", ehrRouter);
  app.use("/api/v1/icd10", icd10Router);
  app.use("/api/v1/uploads", uploadsRouter);
  app.use("/api/v1/referrals", referralRouter);
  app.use("/api/v1/surgery", surgeryRouter);
  app.use("/api/v1/shifts", shiftRouter);
  app.use("/api/v1/leaves", leaveRouter);
  app.use("/api/v1/packages", packageRouter);
  app.use("/api/v1/suppliers", supplierRouter);
  app.use("/api/v1/purchase-orders", purchaseOrderRouter);
  app.use("/api/v1/expenses", expenseRouter);
  app.use("/api/v1/telemedicine", telemedicineRouter);
  app.use("/api/v1/emergency", emergencyRouter);
  app.use("/api/v1/antenatal", antenatalRouter);
  app.use("/api/v1/growth", growthRouter);
  app.use("/api/v1/bloodbank", bloodbankRouter);
  app.use("/api/v1/ambulance", ambulanceRouter);
  app.use("/api/v1/assets", assetsRouter);
  app.use("/api/v1/feedback", feedbackRouter);
  app.use("/api/v1/complaints", complaintsRouter);
  app.use("/api/v1/chat", chatRouter);
  app.use("/api/v1/visitors", visitorsRouter);
  app.use("/api/v1/hr-ops", hrOpsRouter);
  app.use("/api/v1/search", searchRouter);
  app.use("/api/v1/waitlist", waitlistRouter);
  app.use("/api/v1/coordinated-visits", coordinatedVisitRouter);
  app.use("/api/v1/med-reconciliation", medReconciliationRouter);
  app.use("/api/v1/payment-plans", paymentPlansRouter);
  app.use("/api/v1/preauth", preauthRouter);
  app.use("/api/v1/scheduled-reports", scheduledReportsRouter);
  app.use("/api/v1/marketing", marketingRouter);
  app.use("/api/v1/ai/triage", aiTriageRouter);
  app.use("/api/v1/ai/scribe", aiScribeRouter);
  app.use("/api/v1/ai/transcribe", aiTranscribeRouter);
  app.use("/api/v1/ai/reports", aiReportExplainerRouter);
  app.use("/api/v1/ai/predictions", aiPredictionsRouter);
  app.use("/api/v1/ai/letters", aiLettersRouter);
  app.use("/api/v1/ai/er-triage", aiERTriageRouter);
  app.use("/api/v1/ai/pharmacy", aiPharmacyRouter);
  app.use("/api/v1/ai/adherence", aiAdherenceRouter);
  app.use("/api/v1/ai/knowledge", aiKnowledgeRouter);
  app.use("/api/v1/ai/chart-search", aiChartSearchRouter);
  app.use("/api/v1/fhir", fhirRouter);
  app.use("/api/v1/abdm", abdmRouter);
  app.use("/api/v1/claims", insuranceClaimsRouter);
  app.use("/api/v1/hl7v2", hl7v2Router);
  app.use("/api/v1/ai/radiology", aiRadiologyRouter);
  app.use("/api/v1/ai/admin", aiAdminRouter);
  app.use("/api/v1/ai/bill-explainer", aiBillExplainerRouter);
  app.use("/api/v1/ai/previsit", aiPrevisitRouter);
  app.use("/api/v1/ai/symptom-diary", aiSymptomDiaryRouter);
  app.use("/api/v1/ai/coaching", aiCoachingRouter);
  app.use("/api/v1/ai/differential", aiDifferentialRouter);
  app.use("/api/v1/ai/followup", aiFollowupRouter);
  app.use("/api/v1/ai/lab-intel", aiLabIntelRouter);
  app.use("/api/v1/ai/claims", aiClaimsRouter);
  app.use("/api/v1/ai/capacity", aiCapacityRouter);
  app.use("/api/v1/ai/roster", aiRosterRouter);
  app.use("/api/v1/ai/fraud", aiFraudRouter);
  app.use("/api/v1/ai/doc-qa", aiDocQaRouter);
  app.use("/api/v1/ai/sentiment", aiSentimentRouter);
  app.use("/api/v1/tenants", tenantsRouter);
  app.use("/api/v1/agent-console", agentConsoleRouter);
  app.use("/api/v1/ai/kpis", aiKpisRouter);
  app.use("/api/v1/patient-data-export", patientDataExportRouter);
  // /users — staff user mgmt (PATCH/list/reset-pw/service-cert/prefs).
  // Must be registered before the catch-all `patientExtrasRouter` mount
  // so Express finds it first.
  app.use("/api/v1/users", usersRouter);
  app.use("/api/v1", patientExtrasRouter);

  // Health check — the router provides shallow `/api/health` (public) plus
  // `/api/health/deep` (ADMIN) with DB probe + scheduler status + prompt
  // cache age. Must be mounted BEFORE any inline handler for the same path.
  app.use("/api/health", healthRouter);

  // Sentry error handler must come before the custom error handler
  if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
  }

  // Error handler
  app.use(errorHandler);

  // WebSocket for queue updates
  io.on("connection", (socket) => {
    socket.on("join-doctor-queue", (doctorId: string) => {
      socket.join(`queue:${doctorId}`);
    });
    socket.on("join-display", () => {
      socket.join("token-display");
    });
    socket.on("chat:join", (roomId: string) => {
      socket.join(`chat:${roomId}`);
    });
    socket.on("chat:leave", (roomId: string) => {
      socket.leave(`chat:${roomId}`);
    });
  });

  return { app, httpServer, io };
}

// Singleton for tests / external imports
const built = buildApp();
export const app = built.app;
export const httpServer = built.httpServer;
export const io = built.io;

// Background schedulers (daily retention cleanup, hourly TPA claims reconciliation)
if (process.env.NODE_ENV !== "test") {
  startRetentionScheduler();
  startClaimsScheduler();
  startChronicCareScheduler();
}
