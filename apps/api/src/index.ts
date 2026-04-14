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
import { billingRouter } from "./routes/billing";
import { prescriptionRouter } from "./routes/prescriptions";
import { queueRouter } from "./routes/queue";
import { notificationRouter } from "./routes/notifications";
import { auditRouter } from "./routes/audit";
import { analyticsRouter } from "./routes/analytics";
import { medicineRouter } from "./routes/medicines";
import { pharmacyRouter } from "./routes/pharmacy";
import { labRouter } from "./routes/lab";
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
import { errorHandler } from "./middleware/error";
import { rateLimit } from "./middleware/rate-limit";
import { sanitize } from "./middleware/sanitize";

const app = express();
const httpServer = createServer(app);

// Ensure EHR uploads directory exists at startup
const uploadsDir = path.join(process.cwd(), "uploads", "ehr");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

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
app.use(express.json());
app.use(sanitize);
app.use(rateLimit(100, 60_000));

// Routes
app.use("/api/v1/auth", rateLimit(10, 60_000), authRouter);
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

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Error handler
app.use(errorHandler);

// WebSocket for queue updates
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

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

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`MedCore API running on port ${PORT}`);
});

export { io };
