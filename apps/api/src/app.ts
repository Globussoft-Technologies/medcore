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
import { errorHandler } from "./middleware/error";
import { rateLimit } from "./middleware/rate-limit";
import { sanitize } from "./middleware/sanitize";

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
  app.use("/api/v1", patientExtrasRouter);

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

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
