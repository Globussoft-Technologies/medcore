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
import cookieParser from "cookie-parser";
import helmet from "helmet";
import fs from "fs";
import path from "path";
import { createServer } from "http";
import { Server as SocketServer } from "socket.io";
import { authRouter } from "./routes/auth";
import { patientAuthRouter } from "./routes/patient-auth";
import { featureFlagsRouter } from "./routes/feature-flags";
import { leadRouter } from "./routes/leads";
import { patientRouter } from "./routes/patients";
import { appointmentRouter } from "./routes/appointments";
import { doctorRouter } from "./routes/doctors";
// Pearl ERP Stage 1 §2.1.4 (gap item #50) — per-doctor favourite-medicine
// quick-add list. Mounted BEFORE doctorRouter so Express picks it up
// before any /:id-shaped handler on the doctors router (CLAUDE.md gotcha
// §14 — static-before-dynamic).
import { doctorFavouritesRouter } from "./routes/doctor-favourites";
import { billingRouter, razorpayWebhookRouter } from "./routes/billing";
import { prescriptionRouter, publicPrescriptionRouter } from "./routes/prescriptions";
import { publicPatientRouter } from "./routes/public-patient";
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
// Pearl ERP Stage 1 §4.1 (gap row 101) — referring-doctor commission
// ledger persistence surface. Auto-rows are created by the billing
// route; this router is just CRUD on the snapshot table.
import { referralCommissionsRouter } from "./routes/referral-commissions";
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
// Issue #744: friendly tenant resolver for the dashboard chrome (so the
// admin-console can render tenant.name/subdomain instead of raw clinicId
// UUID strings, without granting non-super-admins access to the
// super-admin-only /tenants endpoints).
import { meTenantRouter } from "./routes/me-tenant";
// Issue #746: canonical "today" visitor stats endpoint, anchored to the
// hospital's local-day boundary (Asia/Kolkata). Adds a single source-of-
// truth so the admin-console card, the visitors page tile, and the
// reports page all agree on the same KPI.
import { visitorsStatsRouter } from "./routes/visitors-stats";
// Issue #749: public read-only holidays endpoint so the calendar grid
// can render holiday cells for every authed role (the existing
// /api/v1/hr-ops/holidays endpoint is admin-only).
import { holidaysRouter } from "./routes/holidays";
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
import { insuranceProvidersRouter } from "./routes/insurance-providers";
import { calendarEventsRouter } from "./routes/calendar-events";
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
import { tenantOnboardingRouter } from "./routes/tenant-onboarding";
import { dpdpWorkbenchRouter } from "./routes/dpdp-workbench";
import { scheduledJobsRouter } from "./routes/scheduled-jobs";
import { supportTicketsRouter } from "./routes/support-tickets";
import { branchesRouter } from "./routes/branches";
import { campaignsRouter, publicCampaignsRouter } from "./routes/campaigns";
import { campaignAudiencesRouter } from "./routes/campaign-audiences";
import { settingsRouter } from "./routes/settings";
// Pearl §6.1 gap row 167 piece 3j-i of 4 — per-tenant WhatsApp inbox
// provider config (GUPSHUP / WATI / AISENSEI / INTERAKT / META). The
// outbound adapter at services/channels/whatsapp.ts stays unchanged
// (still env-driven) until piece 3j-iv flips it to per-tenant creds.
import { whatsappConfigRouter } from "./routes/whatsapp-config";
// Pearl §6.1 gap row 167 piece 3j-ii — inbound WhatsApp webhook receiver
// (5 providers). Unauthenticated by JWT — gated by per-provider
// signature verification. Mounted before express.json() because the
// router uses express.raw() for HMAC over the un-parsed bytes.
import { whatsappWebhookRouter } from "./routes/whatsapp-webhook";
// Pearl §6.1 gap row 167 piece 3j-iii — reception inbox read endpoints.
// ADMIN/RECEPTION/DOCTOR/NURSE read conversations + messages persisted
// by the inbound webhook (piece 3j-ii). PATIENT role denied. Reply +
// outbound send is piece 3j-iv.
import { whatsappInboxRouter } from "./routes/whatsapp-inbox";
import { agentConsoleRouter } from "./routes/agent-console";
import { aiKpisRouter } from "./routes/ai-kpis";
import { healthRouter } from "./routes/health";
// Pearl ERP Stage 1 §8.4 (gap row 221 closure, 2026-05-23) — public
// status page backend. Mounted BEFORE any auth-bearing router so the
// /status Next.js page (and external uptime monitors) can probe
// MedCore without a session.
import { statusRouter } from "./routes/status";
import { patientDataExportRouter } from "./routes/patient-data-export";
import { startChronicCareScheduler } from "./services/chronic-care-scheduler";
import { errorHandler } from "./middleware/error";
import { rateLimit } from "./middleware/rate-limit";
import { sanitize } from "./middleware/sanitize";
import { tenantContextMiddleware } from "./middleware/tenant";
// Issue #477: cookie-parser populates req.cookies for the auth middleware
// (which now reads `medcore_at`) and the CSRF guard (which compares the
// `medcore_csrf` cookie against the X-CSRF-Token header on mutations).
import { csrfProtection } from "./middleware/csrf";
import { withTenantContext } from "./services/tenant-context";
// Pearl ERP Stage 1 gap item #2 — piece 2a (2026-05-21). Branch context
// is resolved from `X-Branch-Id` (header-only for piece 2a; JWT-claim
// + session fallback land in piece 2b alongside the picker UI). The
// pair must be mounted AFTER the tenant middleware so the branch ALS
// scope opens INSIDE the tenant ALS scope.
import { branchContextMiddleware, withBranchContext } from "@medcore/db";
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

  // ─── Security headers (#475) ─────────────────────────────────────────────
  // Mount helmet first so EVERY response — including 4xx/5xx from later
  // middleware (CORS rejection, rate-limit, auth, validation) — carries the
  // hardened header set. The API serves JSON only (no inline HTML/JS), so
  // a strict default-src 'none' CSP is appropriate; any HTML responses
  // (e.g. /api/v1/public/verify/rx/:id) override CSP per-route if needed.
  // - x-powered-by disabled to avoid leaking the Express stack identifier.
  // - HSTS 2y + includeSubDomains + preload — matches modern bank-grade
  //   posture; only delivered over HTTPS so local http://dev is unaffected.
  // - frameguard DENY blocks clickjacking; no legitimate consumer of this
  //   API embeds it in an iframe.
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
      frameguard: { action: "deny" },
      noSniff: true,
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      crossOriginResourcePolicy: { policy: "same-site" },
    })
  );

  // Middleware
  app.use(cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    credentials: true,
  }));

  // Razorpay webhook MUST be mounted before express.json() so the route's
  // own express.raw() middleware can read the unparsed body (HMAC verify
  // requires the exact bytes Razorpay signed). Auth is performed via HMAC
  // signature, NOT JWT, so it is intentionally mounted before authenticate.
  app.use("/api/v1/billing", razorpayWebhookRouter);

  // Pearl §6.1 gap row 167 piece 3j-ii — inbound WhatsApp webhook. Same
  // pre-JSON-parser placement reason as the Razorpay webhook above:
  // per-provider HMAC verification (Meta / Gupshup) needs the raw bytes.
  // Unauth on purpose — gated by signature verification inside.
  app.use("/api/v1/wa/webhook", whatsappWebhookRouter);

  // Audio transcription sends base64-encoded audio chunks (~200 KB per 8 s flush).
  // Mount a higher limit for that route before the default 100 KB global parser.
  app.use("/api/v1/ai/transcribe", express.json({ limit: "10mb" }));
  
 app.use(express.json({ limit: "5mb" }));

  // Issue #477: parse cookies BEFORE auth middleware so the cookie-based
  // JWT lookup (medcore_at) and the CSRF guard (medcore_csrf) can both
  // read req.cookies.
  app.use(cookieParser());
  app.use(sanitize);
  // Rate limiting is disabled in test mode to keep tests fast & deterministic.
  if (process.env.NODE_ENV !== "test") {
    app.use(rateLimit(600, 60_000));
  }
  // Issue #477: CSRF protection on every mutation. Skipped on safe
  // methods + on auth endpoints that mint the CSRF cookie (login,
  // register, refresh, 2fa-verify, forgot/reset-password). See
  // middleware/csrf.ts for the bypass list. Mounted AFTER cookieParser
  // (it reads req.cookies) and BEFORE the routers so every state-
  // changing endpoint inherits the guard for free.
  if (process.env.NODE_ENV !== "test") {
    app.use(csrfProtection);
  }

  // Multi-tenancy — resolve tenant from JWT / X-Tenant-Id header and open an
  // AsyncLocalStorage scope that Prisma middleware (see services/tenant-prisma)
  // reads to auto-inject tenantId on create and auto-filter on read. Mounted
  // globally BEFORE any route so every router (each of which does its own
  // `router.use(authenticate)`) runs inside the tenant context. The tenant
  // middleware decodes the JWT itself, so it is safe to mount before auth.
  app.use(tenantContextMiddleware);
  app.use(withTenantContext);

  // Pearl §7.2 — branch context. Resolved from `X-Branch-Id` header
  // (piece 2a, 2026-05-21). No-op when the header is absent so every
  // existing request shape continues to work unchanged. Mounted AFTER
  // the tenant ALS scope so the branch scope nests inside it; the
  // branchScopedPrisma extension reads both scopes per call.
  app.use(branchContextMiddleware as any);
  app.use(withBranchContext as any);

  // Public routes (no auth) — must be mounted BEFORE routers that require auth
  app.use("/api/v1/public", publicLabRouter);
  app.use("/api/v1/public", publicPrescriptionRouter);
  app.use("/api/v1/public", publicPatientRouter);
  app.use("/api/v1/public", publicCampaignsRouter);
  // Pearl §8.4 gap row 221 — public status endpoint. UNAUTHENTICATED;
  // mounted alongside the other /public routes (and BEFORE any router
  // that calls `router.use(authenticate)`). External uptime monitors
  // and the /status Next.js page consume it.
  app.use("/api/v1/status", statusRouter);

  // Routes
  const authLimiter =
    process.env.NODE_ENV === "test" ? (_: any, __: any, n: any) => n() : rateLimit(30, 60_000);
  app.use("/api/v1/auth", authLimiter, authRouter);
  // Pearl §5.3 / §6.1 — patient phone-OTP login (gap #5 piece 2 of 4).
  // No global authLimiter here: the router does per-phone rate limiting
  // internally so a shared-NAT mobile network isn't punished collectively.
  app.use("/api/v1/patient-auth", patientAuthRouter);
  app.use("/api/v1/feature-flags", featureFlagsRouter);
  app.use("/api/v1/leads", leadRouter);
  app.use("/api/v1/patients", patientRouter);
  app.use("/api/v1/appointments", appointmentRouter);
  // Pearl §2.1.4 gap #50 — favourite-medicine quick-add. Mounted BEFORE
  // the generic doctorRouter so Express matches /doctors/me/favourites
  // first (static path > dynamic /:id).
  app.use("/api/v1/doctors/me/favourites", doctorFavouritesRouter);
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
  // Pearl §4.1 — must mount this BEFORE any /:id-shaped handler on the
  // referrals router (it isn't on referralRouter today but staying defensive).
  app.use("/api/v1/referral-commissions", referralCommissionsRouter);
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
  // Issue #744: caller-scoped tenant info; any authenticated role.
  app.use("/api/v1/me", meTenantRouter);
  // Issue #746: canonical "Visitors-Today" KPI shared by admin-console,
  // visitors page, and reports page (Asia/Kolkata day boundary).
  app.use("/api/v1/visitors-stats", visitorsStatsRouter);
  // Issue #749: read-only holidays for the calendar grid (any authed role).
  app.use("/api/v1/holidays", holidaysRouter);
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
  // Issues #718 + #724: admin Calendar New-Event + Insurance Add-Provider
  // CRUD. Both are simple Zod-validated tenant-scoped tables added in
  // migration 20260508000002.
  app.use("/api/v1/calendar-events", calendarEventsRouter);
  app.use("/api/v1/insurance-providers", insuranceProvidersRouter);
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
  // Pearl §8.1 gap #6 piece 2 of 4 — super-admin onboarding wizard
  // (3-step MVP creates tenant + first branch + super-admin user
  // atomically). HFR/HPR/WhatsApp/Razorpay config steps deferred to
  // piece 2b. See apps/web/src/app/super-admin/onboard/.
  app.use("/api/v1/tenant-onboarding", tenantOnboardingRouter);
  // Pearl §8.4 gap row 222 closure (2026-05-22) — background-job queue
  // view + retry for super-admins. Surfaces ScheduledTaskRun rows
  // persisted by services/scheduled-tasks.ts; mounts UI at
  // /super-admin/jobs.
  app.use("/api/v1/scheduled-jobs", scheduledJobsRouter);
  // Pearl §8.6 gap row 224 closure (2026-05-23) — cross-tenant DPDP
  // erasure-request workbench. Super-admins on /super-admin/dpdp file
  // / execute / reject right-to-erasure tickets per DPDP Act 2023 §17.
  app.use("/api/v1/dpdp-workbench", dpdpWorkbenchRouter);
  // Pearl §8.5 gap row 223 closure (2026-05-23) — Pearl-operator support
  // inbox. Orthogonal to the patient→hospital Complaint flow; tenant
  // ADMINs raise tickets against the Pearl operator (super-admin) team
  // and the operator triages on /super-admin/support.
  app.use("/api/v1/support-tickets", supportTicketsRouter);
  app.use("/api/v1/branches", branchesRouter);
  app.use("/api/v1/campaigns", campaignsRouter);
  app.use("/api/v1/campaign-audiences", campaignAudiencesRouter);
  app.use("/api/v1/settings", settingsRouter);
  // Pearl §6.1 gap row 167 piece 3j-i — per-tenant WhatsApp inbox
  // provider config. ADMIN-only; sibling to /settings/integrations.
  app.use("/api/v1/wa/config", whatsappConfigRouter);
  // Pearl §6.1 gap row 167 piece 3j-iii — reception inbox read endpoints.
  // ADMIN/RECEPTION/DOCTOR/NURSE — PATIENT denied. Backs
  // /dashboard/whatsapp (list) + /dashboard/whatsapp/[id] (thread view).
  app.use("/api/v1/wa/inbox", whatsappInboxRouter);
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
