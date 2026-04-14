import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate } from "../middleware/auth";

const router = Router();

router.use(authenticate);

interface SearchHit {
  type: string;
  id: string;
  title: string;
  subtitle: string;
  meta?: string;
  href: string;
}

const ALL_TYPES = [
  "patients",
  "appointments",
  "invoices",
  "prescriptions",
  "admissions",
  "surgeries",
  "lab",
  "labels",
] as const;

type SearchType = (typeof ALL_TYPES)[number];

/**
 * GET /api/v1/search?q=&types=patients,appointments,...
 * Returns up to 10 results per entity type, scoped by role.
 */
router.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = String(req.query.q || "").trim();
      if (!q || q.length < 2) {
        res.json({ success: true, data: [], error: null });
        return;
      }

      const typesParam = String(req.query.types || "");
      const requested: SearchType[] = typesParam
        ? (typesParam
            .split(",")
            .map((t) => t.trim())
            .filter((t) => (ALL_TYPES as readonly string[]).includes(t)) as SearchType[])
        : (ALL_TYPES as unknown as SearchType[]);

      const role = req.user!.role as Role;
      const userId = req.user!.userId;

      // Resolve scope ids upfront
      let patientId: string | null = null;
      let doctorId: string | null = null;
      if (role === Role.PATIENT) {
        const p = await prisma.patient.findFirst({
          where: { userId },
          select: { id: true },
        });
        patientId = p?.id || null;
      } else if (role === Role.DOCTOR) {
        const d = await prisma.doctor.findFirst({
          where: { userId },
          select: { id: true },
        });
        doctorId = d?.id || null;
      }

      const ci = { contains: q, mode: "insensitive" as const };
      const LIMIT = 10;
      const results: SearchHit[] = [];

      // ── Patients ─────────────────────────────────────────
      if (
        requested.includes("patients") &&
        role !== Role.PATIENT // patients don't search patients
      ) {
        const patients = await prisma.patient.findMany({
          where: {
            mergedIntoId: null,
            OR: [
              { mrNumber: ci },
              { abhaId: ci },
              { user: { name: ci } },
              { user: { phone: { contains: q } } },
              { user: { email: ci } },
            ],
          },
          include: { user: { select: { name: true, phone: true, email: true } } },
          take: LIMIT,
        });
        for (const p of patients) {
          results.push({
            type: "patient",
            id: p.id,
            title: p.user?.name || p.mrNumber,
            subtitle: `${p.mrNumber} · ${p.gender}${p.age ? ` · ${p.age}y` : ""}`,
            meta: p.user?.phone || "",
            href: `/dashboard/patients/${p.id}`,
          });
        }
      }

      // ── Appointments ─────────────────────────────────────
      if (requested.includes("appointments")) {
        const where: any = {
          OR: [
            { notes: ci },
            { patient: { user: { name: ci } } },
            { patient: { mrNumber: ci } },
            { doctor: { user: { name: ci } } },
          ],
        };
        if (role === Role.PATIENT && patientId) where.patientId = patientId;
        else if (role === Role.PATIENT) where.id = "__none__";
        else if (role === Role.DOCTOR && doctorId) where.doctorId = doctorId;

        const appts = await prisma.appointment.findMany({
          where,
          include: {
            patient: {
              include: { user: { select: { name: true } } },
            },
            doctor: { include: { user: { select: { name: true } } } },
          },
          orderBy: { date: "desc" },
          take: LIMIT,
        });
        for (const a of appts) {
          results.push({
            type: "appointment",
            id: a.id,
            title: `${a.patient?.user?.name || "Patient"} · ${a.type}`,
            subtitle: `Dr. ${a.doctor?.user?.name || "—"} · ${new Date(a.date).toLocaleDateString()}`,
            meta: a.status,
            href: `/dashboard/appointments?id=${a.id}`,
          });
        }
      }

      // ── Invoices ─────────────────────────────────────────
      if (requested.includes("invoices")) {
        const where: any = {
          OR: [
            { invoiceNumber: ci },
            { patient: { user: { name: ci } } },
            { patient: { mrNumber: ci } },
            { notes: ci },
          ],
        };
        if (role === Role.PATIENT && patientId) where.patientId = patientId;
        else if (role === Role.PATIENT) where.id = "__none__";

        const invoices = await prisma.invoice.findMany({
          where,
          include: {
            patient: { include: { user: { select: { name: true } } } },
          },
          orderBy: { createdAt: "desc" },
          take: LIMIT,
        });
        for (const inv of invoices) {
          results.push({
            type: "invoice",
            id: inv.id,
            title: `Invoice ${inv.invoiceNumber}`,
            subtitle: `${inv.patient?.user?.name || ""} · Rs. ${inv.totalAmount.toFixed(0)}`,
            meta: inv.paymentStatus,
            href: `/dashboard/billing?id=${inv.id}`,
          });
        }
      }

      // ── Prescriptions ────────────────────────────────────
      if (requested.includes("prescriptions")) {
        const where: any = {
          OR: [
            { diagnosis: ci },
            { advice: ci },
            { patient: { user: { name: ci } } },
            { patient: { mrNumber: ci } },
          ],
        };
        if (role === Role.PATIENT && patientId) where.patientId = patientId;
        else if (role === Role.PATIENT) where.id = "__none__";
        else if (role === Role.DOCTOR && doctorId) where.doctorId = doctorId;

        const rxs = await prisma.prescription.findMany({
          where,
          include: {
            patient: { include: { user: { select: { name: true } } } },
            doctor: { include: { user: { select: { name: true } } } },
          },
          orderBy: { createdAt: "desc" },
          take: LIMIT,
        });
        for (const rx of rxs) {
          results.push({
            type: "prescription",
            id: rx.id,
            title: `Rx — ${rx.diagnosis}`,
            subtitle: `${rx.patient?.user?.name || ""} · Dr. ${rx.doctor?.user?.name || "—"}`,
            meta: new Date(rx.createdAt).toLocaleDateString(),
            href: `/dashboard/prescriptions?id=${rx.id}`,
          });
        }
      }

      // ── Admissions ───────────────────────────────────────
      if (requested.includes("admissions")) {
        const where: any = {
          OR: [
            { admissionNumber: ci },
            { reason: ci },
            { diagnosis: ci },
            { patient: { user: { name: ci } } },
            { patient: { mrNumber: ci } },
          ],
        };
        if (role === Role.PATIENT && patientId) where.patientId = patientId;
        else if (role === Role.PATIENT) where.id = "__none__";
        else if (role === Role.DOCTOR && doctorId) where.doctorId = doctorId;

        const admissions = await prisma.admission.findMany({
          where,
          include: {
            patient: { include: { user: { select: { name: true } } } },
            bed: { include: { ward: true } },
          },
          orderBy: { admittedAt: "desc" },
          take: LIMIT,
        });
        for (const a of admissions) {
          results.push({
            type: "admission",
            id: a.id,
            title: `${a.admissionNumber} · ${a.patient?.user?.name || ""}`,
            subtitle: `${a.reason}${a.bed?.ward ? ` · ${a.bed.ward.name} Bed ${a.bed.bedNumber}` : ""}`,
            meta: a.status,
            href: `/dashboard/ipd/${a.id}`,
          });
        }
      }

      // ── Surgeries ────────────────────────────────────────
      if (requested.includes("surgeries")) {
        const where: any = {
          OR: [
            { caseNumber: ci },
            { procedure: ci },
            { diagnosis: ci },
            { patient: { user: { name: ci } } },
            { patient: { mrNumber: ci } },
          ],
        };
        if (role === Role.PATIENT && patientId) where.patientId = patientId;
        else if (role === Role.PATIENT) where.id = "__none__";
        else if (role === Role.DOCTOR && doctorId) where.surgeonId = doctorId;

        const surgeries = await prisma.surgery.findMany({
          where,
          include: {
            patient: { include: { user: { select: { name: true } } } },
            surgeon: { include: { user: { select: { name: true } } } },
          },
          orderBy: { scheduledAt: "desc" },
          take: LIMIT,
        });
        for (const s of surgeries) {
          results.push({
            type: "surgery",
            id: s.id,
            title: `${s.caseNumber} · ${s.procedure}`,
            subtitle: `${s.patient?.user?.name || ""} · Dr. ${s.surgeon?.user?.name || "—"}`,
            meta: s.status,
            href: `/dashboard/surgery?id=${s.id}`,
          });
        }
      }

      // ── Lab orders ───────────────────────────────────────
      if (requested.includes("lab")) {
        const where: any = {
          OR: [
            { orderNumber: ci },
            { notes: ci },
            { patient: { user: { name: ci } } },
            { patient: { mrNumber: ci } },
          ],
        };
        if (role === Role.PATIENT && patientId) where.patientId = patientId;
        else if (role === Role.PATIENT) where.id = "__none__";
        else if (role === Role.DOCTOR && doctorId) where.doctorId = doctorId;

        const labs = await prisma.labOrder.findMany({
          where,
          include: {
            patient: { include: { user: { select: { name: true } } } },
            items: { include: { test: { select: { name: true } } } },
          },
          orderBy: { orderedAt: "desc" },
          take: LIMIT,
        });
        for (const lo of labs) {
          const tests = lo.items
            .slice(0, 3)
            .map((i) => i.test?.name)
            .filter(Boolean)
            .join(", ");
          results.push({
            type: "lab",
            id: lo.id,
            title: `Lab ${lo.orderNumber}`,
            subtitle: `${lo.patient?.user?.name || ""} · ${tests || "—"}`,
            meta: lo.status,
            href: `/dashboard/lab?id=${lo.id}`,
          });
        }
      }

      // ── Static labels: quick module navigation ──────────
      if (requested.includes("labels")) {
        const labels: Array<{ label: string; href: string; roles?: Role[] }> = [
          { label: "Appointments", href: "/dashboard/appointments" },
          { label: "Patients", href: "/dashboard/patients", roles: [Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION] },
          { label: "Queue", href: "/dashboard/queue" },
          { label: "Wards", href: "/dashboard/wards", roles: [Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION] },
          { label: "Admissions", href: "/dashboard/admissions", roles: [Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION] },
          { label: "Pharmacy", href: "/dashboard/pharmacy", roles: [Role.ADMIN, Role.RECEPTION] },
          { label: "Medicines", href: "/dashboard/medicines" },
          { label: "Lab", href: "/dashboard/lab" },
          { label: "Billing", href: "/dashboard/billing" },
          { label: "Prescriptions", href: "/dashboard/prescriptions" },
          { label: "Doctors", href: "/dashboard/doctors" },
          { label: "Surgery", href: "/dashboard/surgery" },
          { label: "Telemedicine", href: "/dashboard/telemedicine" },
          { label: "Emergency", href: "/dashboard/emergency" },
          { label: "Blood Bank", href: "/dashboard/bloodbank" },
          { label: "Ambulance", href: "/dashboard/ambulance" },
          { label: "Analytics", href: "/dashboard/analytics", roles: [Role.ADMIN] },
          { label: "Reports", href: "/dashboard/reports", roles: [Role.ADMIN, Role.RECEPTION] },
          { label: "Users", href: "/dashboard/users", roles: [Role.ADMIN] },
          { label: "Admin Console", href: "/dashboard/admin-console", roles: [Role.ADMIN] },
          { label: "Calendar", href: "/dashboard/calendar" },
          { label: "Workspace", href: "/dashboard/workspace", roles: [Role.DOCTOR] },
          { label: "Workstation", href: "/dashboard/workstation", roles: [Role.NURSE] },
        ];
        const ql = q.toLowerCase();
        for (const l of labels) {
          if (!l.label.toLowerCase().includes(ql)) continue;
          if (l.roles && !l.roles.includes(role)) continue;
          results.push({
            type: "label",
            id: `label:${l.href}`,
            title: l.label,
            subtitle: "Open module",
            href: l.href,
          });
          if (results.filter((r) => r.type === "label").length >= LIMIT) break;
        }
      }

      res.json({ success: true, data: results, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as searchRouter };
