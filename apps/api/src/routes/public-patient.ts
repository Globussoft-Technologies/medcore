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
import { prisma } from "@medcore/db";

export const publicPatientRouter = Router();

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
          key: { in: tenants.map((t) => `tenant:${t.id}:code`) },
        },
        select: { key: true, value: true },
      });
      const codeById = new Map<string, string>();
      for (const row of codeRows) {
        const m = row.key.match(/^tenant:([^:]+):code$/);
        if (m) codeById.set(m[1], row.value);
      }

      res.json({
        success: true,
        data: tenants.map((t) => ({
          id: t.id,
          name: t.name,
          code: codeById.get(t.id) ?? null,
        })),
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);
