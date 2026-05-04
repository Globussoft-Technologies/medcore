// Patient self-only authorization helpers — fixes issue #474 (IDOR / BOLA).
//
// Background
// ----------
// Several patient-scoped resources (admissions, surgeries, lab orders,
// telemedicine sessions, prescriptions) expose `GET /:id` handlers that
// only call `authenticate`. Once a PATIENT-role user has a valid JWT,
// they can fetch ANY resource by UUID — including resources belonging to
// other patients. This is OWASP API1:2023 BOLA / CWE-285.
//
// Modules
// -------
// `assertPatientOwnsResource` — runtime helper called inside individual
// route handlers right after the resource has been loaded. Verifies
// that, when the caller's role is PATIENT, the resource's `patientId`
// resolves to the same Patient row as the caller's `userId`. Returns
// `true` to continue, `false` after writing a 403 response.
//
// Why a helper, not a wrapping middleware
// ---------------------------------------
// Existing handlers already do a `findUnique` that pulls the resource;
// adding a wrapping middleware would force every handler to repeat that
// query (or each route to declare a model name + pk-field mapping).
// The single-call helper lets each handler reuse its existing fetch
// while still centralising the ownership comparison.
//
// Caller contract
// ---------------
//   if (!(await assertPatientOwnsResource(req, res, resource.patientId))) return;
//
// On 403 the helper writes the standard `{success:false,data:null,error}`
// envelope so the route handler just early-returns.

import type { Request, Response } from "express";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";

/**
 * For a request authenticated as PATIENT, verify the supplied resource's
 * `patientId` corresponds to the caller's own Patient row. Non-PATIENT
 * roles always pass (their own role-level RBAC has already gated entry).
 *
 * @param req      Express request — must have `req.user` populated.
 * @param res      Express response — used to write the 403 envelope on
 *                 mismatch so the caller can early-return without
 *                 needing to format the error themselves.
 * @param patientId The `patientId` of the resource being fetched. Pass
 *                 `null`/`undefined` to indicate the resource has no
 *                 owning patient (treated as a forbidden access for
 *                 PATIENT callers since they can only see their own
 *                 records).
 * @returns Promise<boolean> — `true` to continue, `false` after a 403
 *          has been written. The caller MUST `return` immediately when
 *          this resolves to `false`.
 */
export async function assertPatientOwnsResource(
  req: Request,
  res: Response,
  patientId: string | null | undefined
): Promise<boolean> {
  if (!req.user) {
    res.status(401).json({ success: false, data: null, error: "Unauthorized" });
    return false;
  }

  // Staff roles already cleared their authorize() gate. Only PATIENT
  // is subject to per-row ownership.
  if (req.user.role !== "PATIENT") return true;

  if (!patientId) {
    res.status(403).json({ success: false, data: null, error: "Forbidden" });
    return false;
  }

  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    select: { userId: true },
  });

  if (!patient || patient.userId !== req.user.userId) {
    res.status(403).json({ success: false, data: null, error: "Forbidden" });
    return false;
  }

  return true;
}
