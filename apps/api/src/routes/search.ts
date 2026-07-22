import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant: scoped client auto-filters reads + tags writes by tenantId
// for TENANT_SCOPED_MODELS (cross-tenant leak fix, 2026-06-11).
import { tenantScopedPrisma as prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate } from "../middleware/auth";
import { formatDoctorName } from "../lib/format-doctor-name";

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

/**
 * Issue #630: the global search palette previously returned raw enum
 * status values (`IN_PROGRESS`, `SAMPLE_COLLECTED`, `NO_SHOW`) on the
 * `meta` field, which then rendered verbatim in the dropdown. Lab tech
 * users got `IN_PROGRESS` while the lab list page used a styled chip with
 * the prettified `In Progress` label — visually inconsistent. Map the
 * raw enum to title-case here so every consumer of the search API sees a
 * presentable label without each frontend re-implementing the rule.
 */
function humanizeStatus(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  return raw
    .toLowerCase()
    .split("_")
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

const ALL_TYPES = [
  "patients",
  "appointments",
  "invoices",
  "prescriptions",
  "admissions",
  "surgeries",
  "lab",
  // Catalog / operational entities (added 2026-07): searchable by the roles
  // that own them, gated by ROLE_ALLOWED_TYPES below.
  "doctors",
  "medicines",
  "wards",
  "blood",
  "ambulances",
  "staff",
  // Super-admin only (platform surface): find a hospital/tenant by name or
  // subdomain. Gated by isSuperAdmin in the query block, not just the role map.
  "tenants",
  "labels",
] as const;

type SearchType = (typeof ALL_TYPES)[number];

// Per-role searchable surface (ACCESS BASIS). A role can ONLY find the entity
// types listed for it — a caller can't widen this by passing `?types=`. Roles
// that are additionally SELF-SCOPED (PATIENT → own records, DOCTOR → own
// caseload) are narrowed further in each query block below. Unknown/platform
// roles fall back to module shortcuts only.
const ROLE_ALLOWED_TYPES: Record<string, readonly SearchType[]> = {
  ADMIN: ALL_TYPES,
  SUPER_ADMIN: ALL_TYPES,
  DOCTOR: [
    "patients",
    "appointments",
    "prescriptions",
    "admissions",
    "surgeries",
    "lab",
    "doctors",
    "medicines",
    "wards",
    "labels",
  ],
  NURSE: [
    "patients",
    "appointments",
    "admissions",
    "surgeries",
    "lab",
    "doctors",
    "medicines",
    "wards",
    "blood",
    "labels",
  ],
  RECEPTION: [
    "patients",
    "appointments",
    "invoices",
    "admissions",
    "doctors",
    "ambulances",
    "labels",
  ],
  PHARMACIST: ["patients", "prescriptions", "medicines", "labels"],
  LAB_TECH: ["patients", "lab", "labels"],
  BILLING: ["patients", "invoices", "labels"],
  PATIENT: [
    "appointments",
    "invoices",
    "prescriptions",
    "admissions",
    "lab",
    "labels",
  ],
  PLATFORM_OPERATOR: ["labels"],
  PLATFORM_BILLING_OPERATOR: ["labels"],
};

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
      // Super-admin = the explicit SUPER_ADMIN role OR the legacy tenant-less
      // ADMIN pattern (tenantId null). Only they may search across tenants /
      // reach the platform modules below.
      const isSuperAdmin =
        role === Role.SUPER_ADMIN ||
        (role === Role.ADMIN && !req.tenantId);

      // Access-basis gate (Issue #612 + 2026-07 expansion): every role has an
      // explicit allow-list (ROLE_ALLOWED_TYPES). Intersect the requested types
      // with it so a caller can never widen their surface via `?types=`.
      // Unknown roles fall back to module shortcuts only.
      const allowedForRole =
        ROLE_ALLOWED_TYPES[role as string] ??
        (["labels"] as readonly SearchType[]);
      const requestedScoped = requested.filter((t) =>
        allowedForRole.includes(t),
      );

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
        requestedScoped.includes("patients") &&
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
            // Issue #612: PHARMACIST does not need the patient's phone in
            // the search palette (PII minimisation, paired with #599).
            meta: role === Role.PHARMACIST ? "" : (p.user?.phone || ""),
            href: `/dashboard/patients/${p.id}`,
          });
        }
      }

      // ── Appointments ─────────────────────────────────────
      if (requestedScoped.includes("appointments")) {
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
            subtitle: `${formatDoctorName(a.doctor?.user?.name) || "—"} · ${new Date(a.date).toLocaleDateString()}`,
            meta: humanizeStatus(a.status),
            href: `/dashboard/appointments?id=${a.id}`,
          });
        }
      }

      // ── Invoices ─────────────────────────────────────────
      if (requestedScoped.includes("invoices")) {
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
      if (requestedScoped.includes("prescriptions")) {
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
            subtitle: `${rx.patient?.user?.name || ""} · ${formatDoctorName(rx.doctor?.user?.name) || "—"}`,
            meta: new Date(rx.createdAt).toLocaleDateString(),
            href: `/dashboard/prescriptions?id=${rx.id}`,
          });
        }
      }

      // ── Admissions ───────────────────────────────────────
      if (requestedScoped.includes("admissions")) {
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
            meta: humanizeStatus(a.status),
            href: `/dashboard/ipd/${a.id}`,
          });
        }
      }

      // ── Surgeries ────────────────────────────────────────
      if (requestedScoped.includes("surgeries")) {
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
            subtitle: `${s.patient?.user?.name || ""} · ${formatDoctorName(s.surgeon?.user?.name) || "—"}`,
            meta: humanizeStatus(s.status),
            href: `/dashboard/surgery?id=${s.id}`,
          });
        }
      }

      // ── Lab orders ───────────────────────────────────────
      if (requestedScoped.includes("lab")) {
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
            meta: humanizeStatus(lo.status),
            href: `/dashboard/lab?id=${lo.id}`,
          });
        }
      }

      // ── Doctors ──────────────────────────────────────────
      if (requestedScoped.includes("doctors")) {
        const docs = await prisma.doctor.findMany({
          where: {
            OR: [
              { user: { name: ci } },
              { specialization: ci },
              { subSpecialty: ci },
            ],
          },
          include: { user: { select: { name: true } } },
          take: LIMIT,
        });
        for (const d of docs) {
          results.push({
            type: "doctor",
            id: d.id,
            title: formatDoctorName(d.user?.name) || "Doctor",
            subtitle:
              [d.specialization, d.subSpecialty].filter(Boolean).join(" · ") ||
              "—",
            href: `/dashboard/doctors`,
          });
        }
      }

      // ── Medicines (catalog) ──────────────────────────────
      if (requestedScoped.includes("medicines")) {
        const meds = await prisma.medicine.findMany({
          where: {
            OR: [{ name: ci }, { genericName: ci }, { brand: ci }],
          },
          take: LIMIT,
        });
        for (const m of meds) {
          const strengthForm = [m.strength, m.form].filter(Boolean).join(" ");
          results.push({
            type: "medicine",
            id: m.id,
            title: m.name,
            subtitle:
              [m.genericName, strengthForm].filter(Boolean).join(" · ") ||
              (m.category ?? "—"),
            href: `/dashboard/medicines`,
          });
        }
      }

      // ── Wards / beds ─────────────────────────────────────
      if (requestedScoped.includes("wards")) {
        const wards = await prisma.ward.findMany({
          where: { OR: [{ name: ci }, { floor: ci }] },
          take: LIMIT,
        });
        for (const w of wards) {
          results.push({
            type: "ward",
            id: w.id,
            title: w.name,
            subtitle: `${w.type}${w.floor ? ` · Floor ${w.floor}` : ""}`,
            href: `/dashboard/wards`,
          });
        }
      }

      // ── Blood units ──────────────────────────────────────
      if (requestedScoped.includes("blood")) {
        const units = await prisma.bloodUnit.findMany({
          where: { OR: [{ unitNumber: ci }, { storageLocation: ci }] },
          take: LIMIT,
        });
        for (const u of units) {
          results.push({
            type: "blood",
            id: u.id,
            title: `${u.bloodGroup} · ${u.unitNumber}`,
            subtitle: `${u.volumeMl}ml${u.storageLocation ? ` · ${u.storageLocation}` : ""}`,
            meta: humanizeStatus(u.status),
            href: `/dashboard/bloodbank`,
          });
        }
      }

      // ── Ambulances ───────────────────────────────────────
      if (requestedScoped.includes("ambulances")) {
        const ambs = await prisma.ambulance.findMany({
          where: {
            OR: [
              { vehicleNumber: ci },
              { driverName: ci },
              { make: ci },
              { model: ci },
            ],
          },
          take: LIMIT,
        });
        for (const a of ambs) {
          results.push({
            type: "ambulance",
            id: a.id,
            title: a.vehicleNumber,
            subtitle:
              [a.type, [a.make, a.model].filter(Boolean).join(" "), a.driverName]
                .filter(Boolean)
                .join(" · ") || "—",
            meta: humanizeStatus(a.status),
            href: `/dashboard/ambulance`,
          });
        }
      }

      // ── Staff / users (ADMIN surface) ────────────────────
      if (requestedScoped.includes("staff")) {
        const staff = await prisma.user.findMany({
          where: {
            role: { not: Role.PATIENT },
            OR: [{ name: ci }, { email: ci }, { phone: { contains: q } }],
          },
          select: { id: true, name: true, email: true, role: true },
          take: LIMIT,
        });
        for (const s of staff) {
          results.push({
            type: "staff",
            id: s.id,
            title: s.name,
            subtitle: `${s.role}${s.email ? ` · ${s.email}` : ""}`,
            href: `/dashboard/users`,
          });
        }
      }

      // ── Tenants (SUPER-ADMIN platform surface) ───────────
      if (requestedScoped.includes("tenants") && isSuperAdmin) {
        const tenants = await prisma.tenant.findMany({
          where: { OR: [{ name: ci }, { subdomain: ci }] },
          select: {
            id: true,
            name: true,
            subdomain: true,
            plan: true,
            active: true,
          },
          take: LIMIT,
        });
        for (const t of tenants) {
          results.push({
            type: "tenant",
            id: t.id,
            title: t.name,
            subtitle: `${t.subdomain}${t.plan ? ` · ${t.plan}` : ""}`,
            meta: t.active ? "Active" : "Inactive",
            href: `/dashboard/tenants/${t.id}`,
          });
        }
      }

      // ── Static labels: quick module navigation ──────────
      if (requestedScoped.includes("labels")) {
        const labels: Array<{
          label: string;
          href: string;
          roles?: Role[];
          superAdmin?: boolean;
        }> = [
          { label: "Appointments", href: "/dashboard/appointments" },
          { label: "Patients", href: "/dashboard/patients", roles: [Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION] },
          { label: "Queue", href: "/dashboard/queue" },
          { label: "Wards", href: "/dashboard/wards", roles: [Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION] },
          { label: "Admissions", href: "/dashboard/admissions", roles: [Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION] },
          { label: "Pharmacy", href: "/dashboard/pharmacy", roles: [Role.ADMIN, Role.RECEPTION] },
          { label: "Medicines", href: "/dashboard/medicines" },
          // Department / store module shortcuts — jump to the page, mirroring
          // the sidebar tabs. Departments + Materials are admin-managed; the
          // Requisitions tab is on every requisition role's sidebar.
          { label: "Departments", href: "/dashboard/departments", roles: [Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION, Role.PHARMACIST, Role.LAB_TECH] },
          { label: "Materials", href: "/dashboard/materials", roles: [Role.ADMIN, Role.PHARMACIST] },
          { label: "Requisitions", href: "/dashboard/requisitions", roles: [Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION, Role.PHARMACIST, Role.LAB_TECH] },
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
          // Platform (super-admin) modules — gated by isSuperAdmin so a regular
          // tenant admin never sees them (they can't reach these routes).
          { label: "Tenants", href: "/dashboard/tenants", superAdmin: true },
          { label: "Platform Billing", href: "/dashboard/platform-billing", superAdmin: true },
          { label: "Observability", href: "/dashboard/observability", superAdmin: true },
          { label: "Agent Console", href: "/dashboard/agent-console", superAdmin: true },
        ];
        const ql = q.toLowerCase();
        for (const l of labels) {
          if (!l.label.toLowerCase().includes(ql)) continue;
          if (l.superAdmin && !isSuperAdmin) continue;
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
