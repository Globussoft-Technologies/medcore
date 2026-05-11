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
