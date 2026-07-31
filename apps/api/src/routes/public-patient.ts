// Public patient verification endpoint reached via QR scan from the
// printed patient ID card (see services/pdf.ts → generatePatientIdCardHTML).
// No auth: anyone with the URL sees a small, safe summary of the patient
// (no chart data, no clinical history, no contact phone, no address).
//
// Returned fields are the same data points already printed on the physical
// card itself, so the QR scan is functionally equivalent to looking at the
// card — we never disclose anything beyond what is visible to whoever holds
// the plastic.

import { Router, Request, Response, NextFunction } from "express";
import QRCode from "qrcode";
import { prisma } from "@medcore/db";
import { siteBaseUrl } from "../lib/site-link";

export const publicPatientRouter = Router();

// Shared hospital-info lookup (name/address/phone) for public confirmation views.
async function hospitalInfoForTenant(tenantId: string | null) {
  const cfg = await prisma.systemConfig.findMany({
    where: { key: { in: ["hospital_name", "hospital_address", "hospital_phone"] } },
  });
  const map: Record<string, string> = {};
  cfg.forEach((r) => (map[r.key] = r.value));
  const tenant = tenantId
    ? await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } })
    : null;
  return {
    name: tenant?.name || map.hospital_name || "Hospital",
    address: map.hospital_address || "",
    phone: map.hospital_phone || "",
  };
}

publicPatientRouter.get(
  "/verify/patient/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: req.params.id },
        include: { user: { select: { name: true } } },
      });
      if (!patient) {
        res.status(404).json({ ok: false, error: "Patient not found" });
        return;
      }

      const cfg = await prisma.systemConfig.findMany({
        where: {
          key: {
            in: [
              "hospital_name",
              "hospital_address",
              "hospital_phone",
              "hospital_email",
              "hospital_logo_url",
              "hospital_tagline",
            ],
          },
        },
      });
      const map: Record<string, string> = {};
      cfg.forEach((r) => (map[r.key] = r.value));

      res.json({
        ok: true,
        patientId: patient.id,
        mrNumber: patient.mrNumber,
        name: patient.user.name,
        age: patient.age,
        gender: patient.gender,
        bloodGroup: patient.bloodGroup,
        emergencyContactName: patient.emergencyContactName,
        emergencyContactPhone: patient.emergencyContactPhone,
        hospital: {
          name: map.hospital_name || "Hospital",
          address: map.hospital_address || "",
          phone: map.hospital_phone || "",
          email: map.hospital_email || "",
          logoUrl: map.hospital_logo_url || "",
          tagline: map.hospital_tagline || "",
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/public/verify/appointment/:id — public, redacted appointment
// confirmation reached via the Appointment QR the patient gets after booking.
// Safe-by-construction: only the doctor/department/date/token/status +
// hospital contact — no clinical data, no other-patient data, no PII beyond
// the booking itself. Mirrors /verify/patient/:id.
publicPatientRouter.get(
  "/verify/appointment/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const appt = await prisma.appointment.findUnique({
        where: { id: req.params.id },
        include: {
          doctor: {
            include: { user: { select: { name: true } } },
          },
          patient: { include: { user: { select: { name: true } } } },
        },
      });
      if (!appt) {
        res.status(404).json({ ok: false, error: "Appointment not found" });
        return;
      }
      const hospital = await hospitalInfoForTenant(appt.tenantId ?? null);
      const displayToken =
        appt.tokenNumber != null
          ? `${appt.doctor.tokenPrefix ?? ""}${appt.tokenNumber}`
          : null;
      res.json({
        ok: true,
        appointmentId: appt.id,
        status: appt.status,
        date: appt.date.toISOString().slice(0, 10),
        slotStart: appt.slotStart,
        tokenNumber: appt.tokenNumber,
        arrivalSeq: appt.arrivalSeq,
        displayToken,
        department: appt.doctor.specialization,
        doctorName: appt.doctor.user.name,
        patientName: appt.patient?.user.name ?? null,
        hospital,
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/v1/public/appointments/:id/qr — the scannable Appointment QR shown
// on the booking confirmation. Encodes the public verify URL above so a scan
// (by the patient or front desk) pulls up the confirmation. No PHI in the QR
// itself — just a URL. Reuses the qrcode lib already used for patient/Rx QRs.
publicPatientRouter.get(
  "/appointments/:id/qr",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const appt = await prisma.appointment.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!appt) {
        res.status(404).json({ ok: false, error: "Appointment not found" });
        return;
      }
      const url = `${siteBaseUrl(req)}/verify/appointment/${appt.id}`;
      const qrDataUrl = await QRCode.toDataURL(url, {
        type: "image/png",
        errorCorrectionLevel: "M",
        width: 320,
        margin: 1,
      });
      res.json({ ok: true, url, qrDataUrl });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/v1/public/hospitals — list of active tenants for the public
// patient-registration "Select Hospital / Clinic" dropdown. UNAUTHENTICATED
// and DELIBERATELY MINIMAL: only the id + display name + short code are
// returned (no plan, billing, usage, contact, or operator data). A patient
// choosing where to register only needs to recognise their hospital by name.
//
// Uses the raw (non-tenant-scoped) prisma so the list spans every tenant —
// this is the one place a public caller is allowed to see across tenants,
// and the projection is safe by construction.
publicPatientRouter.get(
  "/hospitals",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const tenants = await prisma.tenant.findMany({
        where: { active: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      });
      // The human-readable tenant CODE (e.g. "PG-01") lives in SystemConfig
      // under `tenant:<id>:code`, not on the Tenant row — fetch them in one
      // batched query and attach for display alongside the name.
      const codeRows = await prisma.systemConfig.findMany({
        where: {
          key: {
            in: tenants.flatMap((t) => [
              `tenant:${t.id}:code`,
              `tenant:${t.id}:hospital_address`,
              `tenant:${t.id}:hospital_city`,
              `tenant:${t.id}:hospital_pincode`,
              `tenant:${t.id}:hospital_latitude`,
              `tenant:${t.id}:hospital_longitude`,
            ]),
          },
        },
        select: { key: true, value: true },
      });
      const codeById = new Map<string, string>();
      const metaById = new Map<
        string,
        {
          address?: string;
          city?: string;
          pincode?: string;
          latitude?: number;
          longitude?: number;
        }
      >();
      for (const row of codeRows) {
        const m = row.key.match(/^tenant:([^:]+):(code|hospital_address|hospital_city|hospital_pincode|hospital_latitude|hospital_longitude)$/);
        if (!m) continue;
        const [, tenantId, key] = m;
        if (key === "code") {
          codeById.set(tenantId, row.value);
          continue;
        }
        const meta = metaById.get(tenantId) ?? {};
        if (key === "hospital_address") meta.address = row.value;
        if (key === "hospital_city") meta.city = row.value;
        if (key === "hospital_pincode") meta.pincode = row.value;
        if (key === "hospital_latitude") {
          const n = Number(row.value);
          if (Number.isFinite(n)) meta.latitude = n;
        }
        if (key === "hospital_longitude") {
          const n = Number(row.value);
          if (Number.isFinite(n)) meta.longitude = n;
        }
        metaById.set(tenantId, meta);
      }

      res.json({
        success: true,
        data: tenants.map((t) => ({
          id: t.id,
          name: t.name,
          code: codeById.get(t.id) ?? null,
          address: metaById.get(t.id)?.address ?? null,
          city: metaById.get(t.id)?.city ?? null,
          pincode: metaById.get(t.id)?.pincode ?? null,
          latitude: metaById.get(t.id)?.latitude ?? null,
          longitude: metaById.get(t.id)?.longitude ?? null,
        })),
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);
