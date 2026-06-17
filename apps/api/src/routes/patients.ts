import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  createPatientSchema,
  updatePatientSchema,
  recordVitalsSchema,
  mergePatientSchema,
  recoverPhoneSchema,
  canonicalisePhone,
  Role,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { assertPatientOwnsResource } from "../middleware/patient-self-only";
import { formatDoctorName } from "../lib/format-doctor-name";
import { resolvePatientPhotoUrl, resolveFirstPhotoUrl } from "../lib/patient-photo";
import {
  resolveMrPrefix,
  nextMrSeq,
  mrCounterKey,
  formatMrNumber,
} from "../services/mr-number";

const router = Router();

// All patient routes require authentication
router.use(authenticate);

// GET /api/v1/patients — search/list patients
// Issue #884: PHARMACIST + LAB_TECH added — they need to look up patients to
// verify identity at dispensing / sample-collection. Both roles already have
// lawful per-patient PHI access on `/prescriptions/:id` and `/lab/:id`
// respectively, so list access is within their existing envelope rather than
// a privilege expansion. The web allow-list at
// apps/web/src/app/dashboard/patients/page.tsx is updated in lockstep.
router.get(
  "/",
  authorize(
    Role.ADMIN,
    Role.DOCTOR,
    Role.RECEPTION,
    Role.NURSE,
    Role.PHARMACIST,
    Role.LAB_TECH,
  ),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { search, page = "1", limit = "20", tenantId: tenantIdParam } =
        req.query;
      const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
      const take = Math.min(parseInt(limit as string), 100);

      const where: any = search
        ? {
            AND: [
              { mergedIntoId: null },
              {
                OR: [
                  { mrNumber: { contains: search as string, mode: "insensitive" } },
                  { user: { name: { contains: search as string, mode: "insensitive" } } },
                  { user: { phone: { contains: search as string } } },
                  { user: { email: { contains: search as string, mode: "insensitive" } } },
                  // Patient email now lives on contactEmail (not always
                  // mirrored to the login user.email) — search it too.
                  { contactEmail: { contains: search as string, mode: "insensitive" } },
                  { address: { contains: search as string, mode: "insensitive" } },
                  { abhaId: { contains: search as string } },
                ],
              },
            ],
          }
        : { mergedIntoId: null };

      // Super-admin tenant filter. A platform/super-admin caller has NO tenant
      // context (`req.tenantId` is undefined → tenantScopedPrisma doesn't
      // scope, so they see every tenant's patients). The `/dashboard/patients`
      // tenant dropdown (super-admin only) sends `?tenantId=<id>` to narrow
      // that view to one tenant. Ignored when the caller IS tenant-bound — the
      // tenantScopedPrisma extension overwrites `where.tenantId` with their own
      // tenant anyway, so this can never be used to read across tenants.
      if (
        !req.tenantId &&
        typeof tenantIdParam === "string" &&
        tenantIdParam.trim().length > 0
      ) {
        where.tenantId = tenantIdParam.trim();
      }

      const [patients, total] = await Promise.all([
        prisma.patient.findMany({
          where,
          include: {
            user: {
              // Select user.photoUrl too — the photo may live on the User
              // row (Settings) or the Patient row (registration/edit).
              select: { id: true, name: true, email: true, phone: true, photoUrl: true },
            },
          },
          skip,
          take,
          orderBy: { user: { name: "asc" } },
        }),
        prisma.patient.count({ where }),
      ]);

      // Attach a signed avatar URL per row — resolved from the Patient
      // photo first, then the linked User photo. Parallel; ≤100 rows.
      const withPhotos = await Promise.all(
        patients.map(async (p) => ({
          ...p,
          photoSignedUrl: await resolveFirstPhotoUrl(
            p.photoUrl,
            p.user?.photoUrl,
          ),
        })),
      );

      res.json({
        success: true,
        data: withPhotos,
        error: null,
        meta: { page: parseInt(page as string), limit: take, total },
      });
    } catch (err) {
      next(err);
    }
  }
);

// Issue #331 (Apr 2026) + #891 (May 2026): defensive masker.
//
// As of #891 the schema is `email String? @unique` and new registrations
// store `null` directly — no placeholder is ever fabricated, and the
// migration at 20260519000003 cleared the 183 historical rows back to
// NULL. We keep this regex + the maskPlaceholderEmail helper as a back-
// compat safety net: any sentinel that survived the migration (e.g. a
// row restored from a pre-#891 backup, a tenant that hasn't run the
// migration yet) is still scrubbed on the read path before it can leak
// to the frontend or CRM export. It is also referenced by the
// create-side duplicate-email pre-check below, which intentionally
// skips placeholders rather than matching one patient to another's
// sentinel.
const PLACEHOLDER_EMAIL_RE =
  /^(?:noemail\+[^@]+@medcore\.invalid|patient_\d+@medcore\.local)$/i;
function maskPlaceholderEmail<T extends { email?: string | null } | null | undefined>(
  user: T,
): T {
  if (!user || typeof user.email !== "string") return user;
  if (PLACEHOLDER_EMAIL_RE.test(user.email)) {
    return { ...user, email: null } as T;
  }
  return user;
}

// GET /api/v1/patients/:id
// Issue #599 (May 2026): the previous handler was authenticated-only,
// allowing any role with a valid JWT to fetch the full patient chart
// (PII, address, blood group, insurance, emergency contacts). Tightened
// to an explicit role allowlist; PATIENT is allowed but still goes
// through assertPatientOwnsResource for per-row scoping.
//
// 2026-05-09 follow-up: the test at e2e/patients-id.spec.ts:268,297 pins
// the product intent that PHARMACIST + LAB_TECH need patient demographics
// for their workflows (Rx dispensing requires patient name/age/allergies;
// sample collection requires patient identity). Page CTAs are still gated
// by client-side `canEdit` / `isDoctor` flags, so these roles see the
// chart but can't mutate. The PHI in the response is the same set every
// allowed role sees today; if a future audit wants role-based field
// stripping, that's a separate change.
router.get(
  "/:id",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION, Role.NURSE, Role.PATIENT, Role.PHARMACIST, Role.LAB_TECH),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Issue #170 (Apr 2026): previously a single `findUnique` with a
      // wide `include` block. If ANY one relation (vitals, prescriptions,
      // appointments) hit a transient error or timed out, the whole route
      // 503'd — and pediatric patients with sparse but valid relations
      // tripped this most often. Split the relations into independent
      // queries with `.catch(() => [])` per-call so a missing/empty/slow
      // relation can't tank the chart-load. Empty arrays are guaranteed,
      // never `undefined` — that's what the frontend defends against in
      // the matching iteration sites.
      const patient = await prisma.patient.findUnique({
        where: { id: req.params.id },
        include: {
          user: {
            // photoUrl: the patient's photo can be set on the User row
            // (Settings → Profile) OR the Patient row (registration /
            // edit). Select both so the avatar resolves from either.
            select: { id: true, name: true, email: true, phone: true, photoUrl: true },
          },
        },
      });

      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      // Issue surfaced by 2026-05-05 e2e/patients-id agent: this handler
      // had no `authorize()` middleware AND no patient-self ownership
      // check. Any authenticated user (incl. PATIENT) could fetch any
      // patient's chart by UUID — IDOR / BOLA / OWASP API1:2023. The
      // #474 sweep applied `assertPatientOwnsResource` to 11 other /:id
      // handlers but missed this one. Closing the gap now: PATIENT
      // callers must own the row; staff roles always pass.
      if (!(await assertPatientOwnsResource(req, res, patient.id))) return;

      const [appointments, vitals, prescriptions] = await Promise.all([
        prisma.appointment
          .findMany({
            where: { patientId: req.params.id },
            orderBy: { date: "desc" },
            take: 20,
            include: {
              doctor: { include: { user: { select: { name: true } } } },
            },
          })
          .catch(() => []),
        prisma.vitals
          .findMany({
            where: { patientId: req.params.id },
            orderBy: { recordedAt: "desc" },
            take: 10,
          })
          .catch(() => []),
        prisma.prescription
          .findMany({
            where: { patientId: req.params.id },
            orderBy: { createdAt: "desc" },
            take: 10,
            include: { items: true },
          })
          .catch(() => []),
      ]);

      res.json({
        success: true,
        data: {
          ...patient,
          user: maskPlaceholderEmail(patient.user),
          // Signed URL for the profile photo — resolved from the Patient
          // row first, then the linked User row (Settings-set photo), so
          // it shows regardless of which surface uploaded it.
          photoSignedUrl: await resolveFirstPhotoUrl(
            patient.photoUrl,
            patient.user?.photoUrl,
          ),
          appointments,
          vitals,
          prescriptions,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/patients — register new patient (reception)
router.post(
  "/",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(createPatientSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = req.body;

      // #895: front-door guard was attempted (rejected when req.tenantId
      // was missing) but had too broad a blast radius — test fixtures
      // and tenantless super-admin tooling both legitimately hit this
      // endpoint without a tenant context. The fix is now defense-in-
      // depth at the write site below: explicitly pass req.tenantId
      // (which may be undefined; that matches pre-#895 behaviour for
      // tenantless writes) so the route at least propagates whatever
      // tenant the caller is in. The eventual systemic fix is the
      // \$transaction extension propagation question tracked at #895.

      // Identity is keyed on (phone + name). Duplicate phone numbers are
      // ALLOWED (a family shares one number; a parent + child each get their
      // own chart on the same phone). So we only block when BOTH the phone
      // AND the name match an existing chart — that's a genuine duplicate of
      // the SAME person. Same phone + a different name is a different person
      // and is permitted. (Previously this blocked on phone alone — #103.)
      // We DO NOT rely on a DB unique constraint: phone is intentionally
      // non-unique, and we want an actionable 409 (with the MR number) rather
      // than a generic Prisma 500.
      if (
        typeof data.phone === "string" &&
        data.phone.trim().length > 0 &&
        typeof data.name === "string" &&
        data.name.trim().length > 0
      ) {
        const existing = await prisma.patient.findFirst({
          where: {
            mergedIntoId: null,
            user: {
              phone: data.phone.trim(),
              name: { equals: data.name.trim(), mode: "insensitive" },
            },
          },
          select: { id: true, mrNumber: true, user: { select: { name: true } } },
        });
        if (existing) {
          res.status(409).json({
            success: false,
            data: null,
            error: `A patient with this name and phone is already registered (MR: ${existing.mrNumber}).`,
            details: [
              {
                field: "phone",
                message: `Already registered as ${existing.user?.name ?? "patient"} (MR: ${existing.mrNumber}). Same phone with a different name is allowed.`,
              },
            ],
            existingPatient: {
              id: existing.id,
              mrNumber: existing.mrNumber,
              name: existing.user?.name ?? null,
            },
          });
          return;
        }
      }

      // Patient email duplicate pre-check — scoped to the CALLER'S TENANT.
      //
      // A patient's email is NOT a login credential (it lives on
      // `Patient.contactEmail`, not the globally-unique `User.email`), so
      // the same email may legitimately exist for a patient in another
      // tenant, or for a staff login. We therefore only flag a duplicate
      // when ANOTHER patient IN THIS TENANT already uses the email. The
      // `prisma` client is tenant-scoped, so `patient.findFirst` is already
      // limited to req.tenantId; we match on `contactEmail` (the patient's
      // own email) rather than the login `user.email`.
      if (typeof data.email === "string" && data.email.trim().length > 0) {
        const trimmed = data.email.trim().toLowerCase();
        if (
          !PLACEHOLDER_EMAIL_RE.test(trimmed) &&
          !trimmed.endsWith("@medcore.invalid")
        ) {
          const existingByEmail = await prisma.patient.findFirst({
            where: {
              mergedIntoId: null,
              contactEmail: { equals: trimmed, mode: "insensitive" },
            },
            select: {
              id: true,
              mrNumber: true,
              user: { select: { name: true } },
            },
          });
          if (existingByEmail) {
            res.status(409).json({
              success: false,
              data: null,
              error: `A patient with this email is already registered (MR: ${existingByEmail.mrNumber}).`,
              details: [
                {
                  field: "email",
                  message: `Already registered as ${existingByEmail.user?.name ?? "patient"} (MR: ${existingByEmail.mrNumber}).`,
                },
              ],
              existingPatient: {
                id: existingByEmail.id,
                mrNumber: existingByEmail.mrNumber,
                name: existingByEmail.user?.name ?? null,
              },
            });
            return;
          }
        }
      }

      // Issue #892: catch the same-person-registered-twice case the phone +
      // email checks above miss — a duplicate keyed in with a different
      // phone. A hard block on name ALONE would wrongly reject two genuinely
      // distinct people sharing a common Indian name, so we require BOTH an
      // exact (case-insensitive) name match AND an identical dateOfBirth:
      // two different humans with the identical full name AND identical
      // birth date is vanishingly rare, so this pair is a near-certain
      // duplicate and the "split medical history" risk is real. Same-name /
      // different-DOB stays allowed (correctly — different people).
      if (
        typeof data.name === "string" &&
        data.name.trim().length > 0 &&
        typeof data.dateOfBirth === "string" &&
        data.dateOfBirth.trim().length > 0
      ) {
        const dob = new Date(data.dateOfBirth);
        if (!Number.isNaN(dob.getTime())) {
          const existingByNameDob = await prisma.patient.findFirst({
            where: {
              mergedIntoId: null,
              dateOfBirth: dob,
              user: {
                name: { equals: data.name.trim(), mode: "insensitive" },
              },
            },
            select: {
              id: true,
              mrNumber: true,
              user: { select: { name: true } },
            },
          });
          if (existingByNameDob) {
            res.status(409).json({
              success: false,
              data: null,
              error: `A patient with this name and date of birth is already registered (MR: ${existingByNameDob.mrNumber}).`,
              details: [
                {
                  field: "name",
                  message: `Already registered as ${existingByNameDob.user?.name ?? "patient"} (MR: ${existingByNameDob.mrNumber}). Open that chart instead of creating a duplicate.`,
                },
              ],
              existingPatient: {
                id: existingByNameDob.id,
                mrNumber: existingByNameDob.mrNumber,
                name: existingByNameDob.user?.name ?? null,
              },
            });
            return;
          }
        }
      }

      // #895 defense-in-depth: explicitly pin tenantId on both writes
      // inside the transaction. The tenantScopedPrisma $extends hook
      // SHOULD auto-inject via $allOperations, but PRD evidence
      // (MR000275 created with tenantId:null on staging) shows it isn't
      // reliable inside `$transaction` interactive callbacks for this
      // Prisma version + extension setup. Passing tenantId explicitly
      // closes the gap regardless of whether the extension fires.
      // Tenant-bound callers always write to their OWN tenant (req.tenantId).
      // A super-admin/platform caller has no tenant context, so they pick the
      // target tenant via the form (data.tenantId). The `req.tenantId ??`
      // ordering guarantees a tenant user can NEVER override their own tenant
      // with a body value (it's only consulted when req.tenantId is undefined).
      // Resolved BEFORE the MR number because the MR scheme is now per-tenant.
      const reqTenantId =
        req.tenantId ??
        (typeof data.tenantId === "string" && data.tenantId.trim()
          ? data.tenantId.trim()
          : undefined);

      // Auto-generate MR number — PER-TENANT scheme `<tenant code><sequence>`
      // (e.g. PG01000001). Shared with public self-registration via
      // services/mr-number.ts so both surfaces produce the same format.
      // See that module for the prefix-derivation + counter details.
      const mrPrefix = await resolveMrPrefix(prisma, reqTenantId);
      const counterKey = mrCounterKey(reqTenantId);
      const formatMr = (seq: number) => formatMrNumber(mrPrefix, seq);
      let mrSeq = await nextMrSeq(prisma, counterKey, mrPrefix);

      // Issue #891 (May 2026): no more placeholder email. The schema
      // is now `email String? @unique` — when reception doesn't capture
      // an email, we store `null` instead of fabricating
      // `noemail+<MR>@medcore.invalid`. That sentinel was bouncing every
      // EMAIL-channel notification, polluting Razorpay receipts, and
      // making password-reset enumeration impossible. Schema-side null
      // is the source of truth: every reader
      // (notification.ts, prescriptions.ts, fhir/resources.ts) already
      // null-guards before sending. For phone we just pass through what
      // reception typed — never invent one.
      const trimmedEmail =
        typeof data.email === "string" ? data.email.trim() : "";
      // The patient's email always lands on `Patient.contactEmail`. It is
      // ALSO mirrored to the login `User.email` only when that email is not
      // already taken by another User globally — `User.email` is globally
      // unique (sign-in identity), so reusing an email a staff/admin login
      // already owns must NOT block patient registration. When it's taken,
      // the login User.email stays null (the patient doesn't sign in by
      // email here) and the email is still captured on contactEmail.
      const patientContactEmail = trimmedEmail || null;
      let loginEmail: string | null = patientContactEmail;
      if (loginEmail) {
        const emailOwner = await prisma.user.findUnique({
          where: { email: loginEmail },
          select: { id: true },
        });
        if (emailOwner) loginEmail = null; // globally taken → don't mirror
      }
      // Create user + patient in a transaction, retrying on an mrNumber
      // collision. Each attempt bumps the sequence by one; an email/phone
      // P2002 (a genuine duplicate) is NOT an mrNumber clash, so it
      // re-throws to the outer handler for the proper field-level 409.
      const MAX_MR_ATTEMPTS = 5;
      const createWithMr = (mrNumber: string) =>
        prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              name: data.name,
              // Mirror to the login identity only when globally free (see
              // loginEmail derivation above). Null otherwise — the patient
              // email is still captured on Patient.contactEmail below.
              email: loginEmail,
              phone: data.phone,
              passwordHash: "", // walk-in patients may not need login
              role: "PATIENT",
              tenantId: reqTenantId,
            },
          });

          const patient = await tx.patient.create({
            data: {
              userId: user.id,
              mrNumber,
              // Patient email lives here (per-tenant), decoupled from the
              // globally-unique login User.email. Stored lowercased to match
              // the case-insensitive pre-check.
              contactEmail: patientContactEmail
                ? patientContactEmail.toLowerCase()
                : null,
              dateOfBirth: data.dateOfBirth
                ? new Date(data.dateOfBirth)
                : undefined,
              age: data.age,
              gender: data.gender,
              address: data.address,
              bloodGroup: data.bloodGroup,
              emergencyContactName: data.emergencyContactName,
              emergencyContactPhone: data.emergencyContactPhone,
              insuranceProvider: data.insuranceProvider,
              insurancePolicyNumber: data.insurancePolicyNumber,
              // Profile photo — bare storage key from POST /uploads (empty
              // string from the form means "no photo" → store null).
              photoUrl: data.photoUrl ? data.photoUrl : undefined,
              // Pearl §2.1.1 source tagging: this endpoint is the staff
              // dashboard "Add Patient" surface, so an omitted source
              // defaults to WEB (a staff member keying the row through the
              // web panel). The dropdown on the form can still send WALK_IN
              // / PHONE / REFERRAL / WHATSAPP / OTHER when reception is
              // capturing a different attribution. The schema DEFAULT
              // (WALK_IN) only kicks in for non-route callers (seeders,
              // fixtures, future patient-self-registration which will pass
              // "PWA" explicitly).
              source: data.source ?? "WEB",
              tenantId: reqTenantId,
            },
          });

          await tx.systemConfig.upsert({
            where: { key: counterKey },
            update: { value: String(mrSeq + 1) },
            create: { key: counterKey, value: String(mrSeq + 1) },
          });

          return { ...patient, user: { id: user.id, name: user.name, email: user.email, phone: user.phone } };
        });

      let result: Awaited<ReturnType<typeof createWithMr>> | undefined;
      for (let attempt = 0; attempt < MAX_MR_ATTEMPTS; attempt++) {
        try {
          result = await createWithMr(formatMr(mrSeq));
          break;
        } catch (err) {
          // Only retry when the collision is on mrNumber — a stale counter
          // racing real data. Any other P2002 (email/phone) is a real
          // duplicate the outer catch must report as a field error.
          const code = (err as { code?: string })?.code;
          const target = (err as { meta?: { target?: string[] | string } })
            ?.meta?.target;
          const fields = Array.isArray(target)
            ? target
            : target
              ? [String(target)]
              : [];
          const isMrClash = code === "P2002" && fields.includes("mrNumber");
          if (!isMrClash || attempt === MAX_MR_ATTEMPTS - 1) throw err;
          // Recompute from the live max in case several rows are stale,
          // then advance past the number we just collided on.
          mrSeq = Math.max(
            await nextMrSeq(prisma, counterKey, mrPrefix),
            mrSeq + 1,
          );
        }
      }

      res.status(201).json({ success: true, data: result, error: null });
    } catch (err) {
      // Friendly handling for unique-constraint violations (Prisma P2002) so
      // the UI shows a clear message instead of the raw `Invalid
      // tx.user.create() invocation …` dump. The tenant-scoped pre-checks
      // above can't catch a cross-tenant `User.email` collision — User.email
      // is GLOBALLY unique (it's the login identity), so an email already
      // registered under ANOTHER tenant still 409s here.
      const code = (err as { code?: string })?.code;
      if (code === "P2002") {
        const target = (err as { meta?: { target?: string[] | string } })?.meta
          ?.target;
        const fields = Array.isArray(target)
          ? target
          : target
            ? [String(target)]
            : [];
        const field = fields.includes("email")
          ? "email"
          : fields.includes("phone")
            ? "phone"
            : fields.includes("mrNumber")
              ? "mrNumber"
              : fields[0] ?? "value";
        const label = field === "mrNumber" ? "MR number" : field;
        const msg =
          field === "email"
            ? "This email is already registered to another account. Use a different email, or leave it blank."
            : `A patient with this ${label} already exists.`;
        // `details` lets the web form (extractFieldErrors) render the message
        // inline under the offending input in addition to the toast. We do
        // NOT include the conflicting patient's identity here — it may live in
        // another tenant (User.email is global), and surfacing it would leak
        // cross-tenant data.
        res.status(409).json({
          success: false,
          data: null,
          error: msg,
          details: [{ field, message: msg }],
        });
        return;
      }
      next(err);
    }
  }
);

// PATCH /api/v1/patients/me — patient PWA self-service profile update.
// Pearl §6.1 "My profile" (gap #5 piece 3e of 4). Narrow allowlist of
// patient-row fields the PATIENT-PWA form is allowed to write:
//   • address           (free-text postal address)
//   • dateOfBirth       (ISO date; updateProfileSchema's DOB-in-the-past
//                        guard reused by re-parsing through updatePatientSchema)
//   • abhaId            (Health-ID placeholder — full ABHA link flow is
//                        deferred; user can paste an existing id today)
//   • preferredLanguage (also writeable via PATCH /auth/me which mirrors
//                        the User.preferredLanguage column; we accept it
//                        here too so the form can ship one round-trip
//                        per user gesture without forcing the caller to
//                        decide which surface owns the field)
//
//   • gender            (MALE/FEMALE/OTHER — patient-self-editable as of the
//                        2026-06 profile update; previously staff-only. Zod
//                        enum-validated via updatePatientSchema.)
//
// NOT writeable here:
//   • name / email — live on `User`; edited via PATCH /auth/me.
//   • phone — lives on `User` and secures sign-in; the web form surfaces it
//     read-only with a "contact reception to change" hint (a self-service
//     change would need an OTP re-verification flow the spec defers).
//   • bloodGroup — clinical field, staff-corrected only.
//   • mrNumber / userId / tenantId / branchId — administrative columns
//     the patient must never be able to mutate.
//
// MUST be declared BEFORE `PATCH /:id` so Express's first-match router
// doesn't shadow `/me` with the `:id` param (CLAUDE.md "Post-fix
// verification grep — static-before-dynamic route declaration" gotcha
// codified in /medcore-bola-sweep).
router.patch(
  "/me",
  authorize(Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        address?: string | null;
        city?: string | null;
        state?: string | null;
        pincode?: string | null;
        dateOfBirth?: string | null;
        abhaId?: string | null;
        preferredLanguage?: string | null;
        gender?: string | null;
      };

      // Reuse the existing partial patient schema for the DOB-in-the-past
      // guard + length / type sanity. Only pass the keys we accept so
      // mass-assignment of any other field is blocked at the schema layer
      // (unknown keys are dropped by .partial() without erroring, but
      // .pick() keeps the surface tight and self-documenting).
      const parsed = updatePatientSchema.safeParse({
        ...(body.address !== undefined ? { address: body.address ?? undefined } : {}),
        ...(body.city !== undefined ? { city: body.city ?? undefined } : {}),
        ...(body.state !== undefined ? { state: body.state ?? undefined } : {}),
        ...(body.pincode !== undefined ? { pincode: body.pincode ?? undefined } : {}),
        ...(body.dateOfBirth !== undefined ? { dateOfBirth: body.dateOfBirth ?? undefined } : {}),
        ...(body.abhaId !== undefined ? { abhaId: body.abhaId ?? undefined } : {}),
        ...(body.preferredLanguage !== undefined
          ? { preferredLanguage: body.preferredLanguage ?? undefined }
          : {}),
        ...(body.gender !== undefined ? { gender: body.gender ?? undefined } : {}),
      });
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: parsed.error.issues[0]?.message ?? "Invalid payload",
          details: parsed.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        });
        return;
      }

      // Locate the caller's Patient row via their User id. PATIENT JWT
      // carries userId but not patientId, and we deliberately don't trust
      // any patientId on the body — the route's identity is "caller's own
      // row" by construction.
      const me = await prisma.patient.findFirst({
        where: { userId: req.user!.userId, mergedIntoId: null },
        select: { id: true },
      });
      if (!me) {
        res.status(404).json({
          success: false,
          data: null,
          error: "No patient profile linked to this account",
        });
        return;
      }

      const data: Record<string, unknown> = {};
      if (body.address !== undefined) data.address = body.address;
      if (body.city !== undefined) data.city = body.city || null;
      if (body.state !== undefined) data.state = body.state || null;
      if (body.pincode !== undefined) data.pincode = body.pincode || null;
      if (body.dateOfBirth !== undefined) {
        data.dateOfBirth = body.dateOfBirth ? new Date(body.dateOfBirth) : null;
      }
      if (body.abhaId !== undefined) data.abhaId = body.abhaId;
      if (body.preferredLanguage !== undefined) data.preferredLanguage = body.preferredLanguage;
      // Gender is now patient-self-editable (was staff-only). The Zod enum on
      // updatePatientSchema already constrained it to MALE/FEMALE/OTHER above,
      // so `parsed.success` guarantees a valid value here.
      if (body.gender !== undefined) data.gender = parsed.data.gender;

      if (Object.keys(data).length === 0) {
        res.status(400).json({ success: false, data: null, error: "Nothing to update" });
        return;
      }

      const updated = await prisma.patient.update({
        where: { id: me.id },
        data,
        select: {
          id: true,
          address: true,
          city: true,
          state: true,
          pincode: true,
          dateOfBirth: true,
          abhaId: true,
          preferredLanguage: true,
          gender: true,
        },
      });

      auditLog(req, "PATIENT_SELF_UPDATE", "patient", me.id, {
        fields: Object.keys(data),
      }).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/patients/:id/recover-phone — Pearl §5.3 / gap row 149.
//
// Reception-mediated forgot-phone recovery for a patient who has lost
// access to their registered phone (lost SIM, switched carrier, etc.)
// and therefore CANNOT use the self-service OTP login at
// /patient-auth/otp-request. Reception verifies the patient's identity
// in-person against a govt ID (or matches the chart photoUrl) and the
// new phone is attached to the patient's User row.
//
// RBAC: RECEPTION + ADMIN only. PATIENT cannot self-trigger (that would
// defeat the purpose — anyone with the lost number's chart could
// hijack the account).
//
// MUST be declared BEFORE `PATCH /:id` so the Express first-match
// router doesn't shadow `/:id/recover-phone` with the `:id` param
// (CLAUDE.md gotcha §14 — static-before-dynamic route ordering, codified
// in /medcore-bola-sweep). The existing /:id/vitals, /:id/merge etc.
// already live above /:id for the same reason; we follow suit.
//
// On success we (a) update User.phone, (b) invalidate every outstanding
// PatientOtpChallenge for the OLD phone (mark consumed:true) so a
// previously-minted code can't be replayed by whoever has the old SIM,
// (c) revoke all active RefreshToken rows for the User so any session
// the lost device still has is hard-killed (patient must re-OTP from
// the new phone), and (d) AuditLog with PHONE-SUFFIX-ONLY payload —
// full phones never hit the audit log per HIPAA/DPDP minimisation.
router.post(
  "/:id/recover-phone",
  authorize(Role.RECEPTION, Role.ADMIN),
  validate(recoverPhoneSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { newPhone: rawNewPhone, identityVerification } = req.body as {
        newPhone: string;
        identityVerification: { method: string; note: string };
      };
      const newPhone = canonicalisePhone(rawNewPhone);

      // Load the patient + linked User. The tenant-scoped Prisma wrapper
      // returns 404 for cross-tenant rows (the underlying findUnique
      // filter is rewritten to include the caller's tenantId), so the
      // null-check below collapses BOTH not-found and cross-tenant into
      // a single 404 — same posture as every other /:id handler in this
      // file.
      const patient = await prisma.patient.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          userId: true,
          user: { select: { id: true, phone: true } },
        },
      });
      if (!patient || !patient.user) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Patient not found",
        });
        return;
      }

      const oldPhone = patient.user.phone;

      // Reject if the new phone already belongs to a DIFFERENT User. We
      // skip this check when newPhone === oldPhone (no-op recovery) so
      // reception can re-confirm identity on a phone the patient still
      // has — the audit row is still written, which is the useful part.
      if (newPhone !== oldPhone) {
        const conflicting = await prisma.user.findFirst({
          where: { phone: newPhone, id: { not: patient.userId } },
          select: { id: true },
        });
        if (conflicting) {
          res.status(409).json({
            success: false,
            data: null,
            error: "Phone already registered to another patient",
          });
          return;
        }
      }

      // Transaction: phone swap + OTP-challenge invalidation + refresh-
      // token revocation. All three must succeed or none — otherwise we
      // could end up with the new phone attached but the old phone's
      // session still alive.
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: patient.userId },
          data: { phone: newPhone },
        });
        // Burn any outstanding OTP challenge for the OLD phone so a
        // previously-minted code can't be replayed by whoever has the
        // lost SIM. updateMany is idempotent — 0 affected rows is fine.
        if (oldPhone) {
          await tx.patientOtpChallenge.updateMany({
            where: { phone: oldPhone, consumed: false },
            data: { consumed: true },
          });
        }
        // Revoke active sessions. Any access token the lost device
        // already holds is still valid until its TTL (no per-token
        // blocklist for access tokens), but the refresh path is broken,
        // so the longest the lost device can stay signed in is the
        // 24h access-token TTL. Acceptable for a manual-recovery flow.
        await tx.refreshToken.deleteMany({
          where: { userId: patient.userId },
        });
      });

      // AuditLog with phone SUFFIX only (last 4) — full phones are PII
      // and the audit log is queryable by analytics roles. Matches the
      // posture used by patient-auth.ts for OTP_REQUEST/VERIFY.
      await auditLog(
        req,
        "PATIENT_PHONE_RECOVERY",
        "patient",
        patient.id,
        {
          patientId: patient.id,
          oldPhoneSuffix: oldPhone ? oldPhone.slice(-4) : null,
          newPhoneSuffix: newPhone.slice(-4),
          identityMethod: identityVerification.method,
          // Note text persisted on the audit row so a later compliance
          // review can see WHAT was verified, not just THAT something was.
          identityNote: identityVerification.note,
          byReceptionistUserId: req.user!.userId,
        },
      );

      res.json({
        success: true,
        data: {
          patientId: patient.id,
          newPhoneSuffix: newPhone.slice(-4),
          recoveredAt: new Date().toISOString(),
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/v1/patients/:id — update demographics. Open to most staff so
// typos in phone/address/name can be corrected without escalation. MR number
// is immutable and is never touched here.
router.patch(
  "/:id",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION, Role.NURSE),
  validate(updatePatientSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        name?: string;
        phone?: string;
        email?: string;
        dateOfBirth?: string | null;
        [key: string]: unknown;
      };
      const { name, phone, email, dateOfBirth, ...rest } = body;

      const patient = await prisma.patient.findUnique({
        where: { id: req.params.id },
        include: { user: { select: { name: true } } },
      });
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }
      const currentUser = patient.user;

      // Issues #595 / #596 (May 2026): the Edit Patient form let staff
      // change a patient's email or phone to one that another active
      // record already used. The DB has `@unique` on User.email, so the
      // write would 500 with a Prisma P2002; phone has no unique
      // constraint so the duplicate would persist silently and break
      // every "lookup by phone" workflow. Mirror the create-side
      // pre-checks: when the new value differs from the patient's
      // current value, look up any OTHER active patient using it and
      // return a structured 409 so the form can show inline.
      if (typeof email === "string" && email.trim().length > 0) {
        const trimmed = email.trim().toLowerCase();
        const dupEmail = await prisma.patient.findFirst({
          where: {
            mergedIntoId: null,
            id: { not: req.params.id },
            user: { email: { equals: trimmed, mode: "insensitive" } },
          },
          select: { mrNumber: true, user: { select: { name: true } } },
        });
        if (dupEmail) {
          res.status(409).json({
            success: false,
            data: null,
            error: `Another patient with this email is already registered (MR: ${dupEmail.mrNumber}).`,
            details: [
              {
                field: "email",
                message: `Already registered as ${dupEmail.user?.name ?? "patient"} (MR: ${dupEmail.mrNumber}).`,
              },
            ],
          });
          return;
        }
      }
      if (typeof phone === "string" && phone.trim().length > 0) {
        const trimmedPhone = phone.trim();
        // Identity is keyed on (phone + name), mirroring the create-side
        // check at the top of this file. The SAME phone with a DIFFERENT
        // name is allowed — families routinely share one number, and a
        // guardian's phone legitimately appears on several patient records.
        // We only reject a true identity collision: another active patient
        // with BOTH the same phone AND the same name. The effective name is
        // the one being saved (if the edit changes it) or the patient's
        // current name otherwise.
        const effectiveName = (
          (typeof name === "string" && name.trim().length > 0
            ? name
            : currentUser?.name) ?? ""
        ).trim();
        const dupPhone = await prisma.patient.findFirst({
          where: {
            mergedIntoId: null,
            id: { not: req.params.id },
            user: {
              phone: trimmedPhone,
              name: { equals: effectiveName, mode: "insensitive" },
            },
          },
          select: { mrNumber: true, user: { select: { name: true } } },
        });
        if (dupPhone) {
          res.status(409).json({
            success: false,
            data: null,
            error: `Another patient with this name and phone is already registered (MR: ${dupPhone.mrNumber}).`,
            details: [
              {
                field: "phone",
                message: `Already registered as ${dupPhone.user?.name ?? "patient"} (MR: ${dupPhone.mrNumber}). Same phone with a different name is allowed.`,
              },
            ],
          });
          return;
        }
      }

      // Defence-in-depth: MR number is never editable via PATCH. The Zod
      // schema doesn't include it, but strip any stray value just in case.
      const patientData: Record<string, unknown> = { ...rest };
      delete patientData.mrNumber;
      if (dateOfBirth !== undefined) {
        patientData.dateOfBirth = dateOfBirth ? new Date(dateOfBirth as string) : null;
      }
      // Profile photo: an empty string from the editor means "remove the
      // photo" → persist null so the avatar falls back to initials.
      if (patientData.photoUrl === "") {
        patientData.photoUrl = null;
      }

      await prisma.$transaction(async (tx) => {
        if (name || phone || email) {
          await tx.user.update({
            where: { id: patient.userId },
            data: {
              ...(name && { name }),
              ...(phone && { phone }),
              ...(email && { email }),
            },
          });
        }

        if (Object.keys(patientData).length > 0) {
          await tx.patient.update({
            where: { id: req.params.id },
            data: patientData,
          });
        }
      });

      auditLog(req, "PATIENT_UPDATE", "patient", req.params.id, {
        fields: [
          ...(name ? ["name"] : []),
          ...(phone ? ["phone"] : []),
          ...(email ? ["email"] : []),
          ...Object.keys(patientData),
        ],
      }).catch(console.error);

      const updated = await prisma.patient.findUnique({
        where: { id: req.params.id },
        include: {
          user: { select: { id: true, name: true, email: true, phone: true } },
        },
      });

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/patients/:id/vitals — record vitals (nurse)
router.post(
  "/:id/vitals",
  authorize(Role.NURSE, Role.DOCTOR, Role.ADMIN),
  validate(recordVitalsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Compute baseline + analysis (considering patient baseline)
      const { computePatientBaseline, detectSuddenChanges } = await import(
        "../services/vitals-baseline"
      );
      const { computeVitalsFlagsWithBaseline } = await import(
        "../services/vitals-analysis"
      );
      const baseline = await computePatientBaseline(req.params.id);
      const analysis = computeVitalsFlagsWithBaseline(req.body, {
        bpSystolic: baseline.bpSystolic,
        bpDiastolic: baseline.bpDiastolic,
        pulse: baseline.pulse,
        spO2: baseline.spO2,
      });

      // Detect sudden changes vs last 24h
      const suddenChanges = await detectSuddenChanges(req.params.id, req.body);

      const vitalsData = {
        ...req.body,
        patientId: req.params.id,
        nurseId: req.user!.userId,
        bmi: analysis.bmi,
        isAbnormal: analysis.isAbnormal,
        abnormalFlags:
          analysis.flags.length > 0 ? analysis.flags.join(",") : null,
      };
      // Vitals.appointmentId is @unique — one vitals snapshot per appointment.
      // Re-recording for the same appointment (e.g. correcting a reading on the
      // consult screen) must UPDATE that row, not create a duplicate that 400s
      // with a P2002 unique-constraint error.
      const existingForAppt = req.body.appointmentId
        ? await prisma.vitals.findFirst({
            where: { appointmentId: req.body.appointmentId },
            select: { id: true },
          })
        : null;
      const vitals = existingForAppt
        ? await prisma.vitals.update({
            where: { id: existingForAppt.id },
            data: vitalsData,
          })
        : await prisma.vitals.create({ data: vitalsData });

      // If critical, push a notification to the doctor for the appointment
      if (analysis.isCritical && req.body.appointmentId) {
        (async () => {
          try {
            const apt = await prisma.appointment.findUnique({
              where: { id: req.body.appointmentId },
              select: {
                doctorId: true,
                patient: { select: { user: { select: { name: true, phone: true } } } },
              },
            });
            if (apt?.doctorId) {
              const doc = await prisma.doctor.findUnique({
                where: { id: apt.doctorId },
                select: { userId: true },
              });
              if (doc?.userId) {
                await prisma.notification.create({
                  data: {
                    userId: doc.userId,
                    type: "APPOINTMENT_REMINDER" as any,
                    channel: "PUSH" as any,
                    title: "Critical Vitals Alert",
                    message: `${apt.patient?.user?.name || "Patient"}: ${analysis.flags.join(", ")}`,
                    data: {
                      vitalsId: vitals.id,
                      flags: analysis.flags,
                    } as any,
                    sentAt: new Date(),
                  },
                });
              }
            }

            // If vitals are critical (e.g. LOW_SPO2), also send an SMS to
            // the patient per configured template.
            const patientUser = apt?.patient?.user;
            if (patientUser?.phone) {
              const cfg = await prisma.systemConfig.findUnique({
                where: { key: "vitals_alert_sms_template" },
              });
              const tpl =
                cfg?.value ||
                "Your recent vitals reading shows {{flags}}. Please contact the clinic for follow-up.";
              const msg = tpl.replace(
                "{{flags}}",
                analysis.critical.join(", ")
              );
              const { sendSMS, sendWhatsApp } = await import(
                "../services/notification"
              );
              sendSMS(patientUser.phone, msg).catch(() => undefined);
              sendWhatsApp(patientUser.phone, msg).catch(() => undefined);
            }
          } catch (e) {
            console.error("vitals-critical-notify", e);
          }
        })().catch(console.error);
      }

      // Fire notification to doctor when sudden changes are detected
      if (suddenChanges.hasSignificantChange && req.body.appointmentId) {
        (async () => {
          try {
            const apt = await prisma.appointment.findUnique({
              where: { id: req.body.appointmentId },
              select: {
                doctorId: true,
                patient: { select: { user: { select: { name: true } } } },
              },
            });
            if (apt?.doctorId) {
              const doc = await prisma.doctor.findUnique({
                where: { id: apt.doctorId },
                select: { userId: true },
              });
              if (doc?.userId) {
                const sigs = suddenChanges.changes
                  .filter((c) => c.significant)
                  .map((c) => `${c.field}: Δ${c.delta}`)
                  .join(", ");
                await prisma.notification.create({
                  data: {
                    userId: doc.userId,
                    type: "APPOINTMENT_REMINDER" as any,
                    channel: "PUSH" as any,
                    title: "Sudden Vitals Change",
                    message: `${apt.patient?.user?.name || "Patient"}: ${sigs}`,
                    data: {
                      vitalsId: vitals.id,
                      changes: suddenChanges.changes,
                    } as any,
                    sentAt: new Date(),
                  },
                });
              }
            }
          } catch (e) {
            console.error("vitals-sudden-notify", e);
          }
        })().catch(console.error);
      }

      res.status(201).json({
        success: true,
        data: {
          ...vitals,
          analysis,
          changes: suddenChanges.changes,
          previousRecordedAt: suddenChanges.previousRecordedAt,
          baseline,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/patients/:id/vitals?limit=N — recent vitals for a patient,
// newest first. Backs the consult screen's "Last vitals" panel (and any other
// surface wanting the latest readings) — previously the client called this and
// silently fell back to "No vitals" because the route didn't exist. Tenant-
// scoped via the prisma wrapper. limit defaults to 10, capped at 50.
router.get(
  "/:id/vitals",
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawLimit = parseInt(String(req.query.limit ?? ""), 10);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(rawLimit, 1), 50)
        : 10;
      const vitals = await prisma.vitals.findMany({
        where: { patientId: req.params.id },
        orderBy: { recordedAt: "desc" },
        take: limit,
      });
      res.json({ success: true, data: vitals, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/patients/:id/merge — merge another patient record into this one
router.post(
  "/:id/merge",
  authorize(Role.ADMIN),
  validate(mergePatientSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const keepId = req.params.id;
      const { otherPatientId } = req.body as { otherPatientId: string };
      if (keepId === otherPatientId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Cannot merge a patient into itself",
        });
        return;
      }

      const [keep, other] = await Promise.all([
        prisma.patient.findUnique({ where: { id: keepId } }),
        prisma.patient.findUnique({ where: { id: otherPatientId } }),
      ]);

      if (!keep || !other) {
        res.status(404).json({
          success: false,
          data: null,
          error: "One or both patients not found",
        });
        return;
      }
      if (other.mergedIntoId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Source patient is already merged",
        });
        return;
      }

      const result = await prisma.$transaction(async (tx) => {
        // Repoint all dependent child records to the keep patient
        await tx.appointment.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });
        await tx.vitals.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });
        await tx.prescription.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });
        await tx.invoice.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });
        await tx.patientAllergy.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });
        await tx.chronicCondition.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });
        await tx.familyHistory.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });
        await tx.immunization.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });
        await tx.patientDocument.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });
        await tx.labOrder.updateMany({
          where: { patientId: otherPatientId },
          data: { patientId: keepId },
        });

        // Mark the source as merged (keep for audit trail)
        const marked = await tx.patient.update({
          where: { id: otherPatientId },
          data: { mergedIntoId: keepId },
        });
        return marked;
      });

      auditLog(req, "PATIENT_MERGE", "patient", keepId, {
        mergedFrom: otherPatientId,
      }).catch(console.error);

      res.json({
        success: true,
        data: { keptId: keepId, mergedId: result.id },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/patients/:id/history — visit history
router.get(
  "/:id/history",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const appointments = await prisma.appointment.findMany({
        where: { patientId: req.params.id },
        orderBy: { date: "desc" },
        include: {
          doctor: { include: { user: { select: { name: true } } } },
          vitals: true,
          consultation: true,
          prescription: { include: { items: true } },
          invoice: { include: { payments: true } },
        },
      });

      res.json({ success: true, data: appointments, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/patients/:id/timeline — unified chronological timeline
router.get(
  "/:id/timeline",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patientId = req.params.id;
      const [
        appointments,
        consultations,
        prescriptions,
        vitals,
        admissions,
        labOrders,
        surgeries,
        invoices,
        emergencies,
      ] = await Promise.all([
        prisma.appointment.findMany({
          where: { patientId },
          include: {
            doctor: { include: { user: { select: { name: true } } } },
          },
          orderBy: { date: "desc" },
          take: 200,
        }),
        prisma.consultation.findMany({
          where: { appointment: { patientId } },
          include: {
            appointment: true,
            doctor: { include: { user: { select: { name: true } } } },
          },
          orderBy: { createdAt: "desc" },
          take: 200,
        }),
        prisma.prescription.findMany({
          where: { patientId },
          include: {
            doctor: { include: { user: { select: { name: true } } } },
            items: true,
          },
          orderBy: { createdAt: "desc" },
          take: 200,
        }),
        prisma.vitals.findMany({
          where: { patientId },
          orderBy: { recordedAt: "desc" },
          take: 200,
        }),
        prisma.admission.findMany({
          where: { patientId },
          include: {
            doctor: { include: { user: { select: { name: true } } } },
            bed: { include: { ward: true } },
          },
          orderBy: { admittedAt: "desc" },
          take: 200,
        }),
        prisma.labOrder.findMany({
          where: { patientId },
          include: {
            items: { include: { test: true, results: true } },
          },
          orderBy: { orderedAt: "desc" },
          take: 200,
        }),
        prisma.surgery.findMany({
          where: { patientId },
          include: {
            surgeon: { include: { user: { select: { name: true } } } },
          },
          orderBy: { scheduledAt: "desc" },
          take: 200,
        }),
        prisma.invoice.findMany({
          where: { patientId },
          orderBy: { createdAt: "desc" },
          take: 200,
        }),
        prisma.emergencyCase.findMany({
          where: { patientId },
          orderBy: { arrivedAt: "desc" },
          take: 200,
        }),
      ]);

      type Entry = {
        id: string;
        type: string;
        title: string;
        description: string;
        timestamp: string;
        icon: string;
        color: string;
        link: string | null;
      };
      const entries: Entry[] = [];

      // Issue #842: legacy transferred-appointment notes were persisted
      // with the shape `[TRANSFERRED from <doctorUuid> by <userUuid>] reason`.
      // The fix at appointments.ts:1806 (write-side) embeds friendly names
      // for any new transfer, but historical rows are still in the DB.
      // Scrub any legacy UUIDs out of the description text shown to the
      // user — replace with a generic "previous doctor" / "staff" tag,
      // preserving the reason text after the bracket.
      const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
      const scrubTransferNote = (note: string): string =>
        note.replace(
          /\[TRANSFERRED from ([^\]]+) by ([^\]]+)\]/g,
          (_full, from: string, by: string) => {
            const fromClean = UUID_RE.test(from) ? "previous doctor" : from;
            UUID_RE.lastIndex = 0;
            const byClean = UUID_RE.test(by) ? "staff" : by;
            UUID_RE.lastIndex = 0;
            return `[Transferred from ${fromClean} by ${byClean}]`;
          },
        );

      for (const a of appointments) {
        const cleanNotes = a.notes ? scrubTransferNote(a.notes) : "";
        entries.push({
          id: `appt-${a.id}`,
          type: "appointment",
          title: `Appointment with ${formatDoctorName(a.doctor?.user?.name) || "—"}`,
          description: `${a.type} · ${a.status.replace(/_/g, " ")}${
            cleanNotes ? ` · ${cleanNotes}` : ""
          }`,
          timestamp: new Date(a.date).toISOString(),
          icon: "Calendar",
          color: "blue",
          link: `/dashboard/appointments`,
        });
      }

      for (const c of consultations) {
        entries.push({
          id: `cons-${c.id}`,
          type: "consultation",
          title: `Consultation with ${formatDoctorName(c.doctor?.user?.name) || "—"}`,
          description:
            (c.findings ? `Findings: ${c.findings}` : "") +
            (c.notes ? (c.findings ? " · " : "") + `Notes: ${c.notes}` : ""),
          timestamp: c.createdAt.toISOString(),
          icon: "Stethoscope",
          color: "indigo",
          link: null,
        });
      }

      for (const p of prescriptions) {
        entries.push({
          id: `rx-${p.id}`,
          type: "prescription",
          title: `Prescription — ${p.diagnosis}`,
          description: `${p.items.length} medication(s)${
            p.followUpDate
              ? ` · Follow up: ${new Date(p.followUpDate).toLocaleDateString()}`
              : ""
          }`,
          timestamp: p.createdAt.toISOString(),
          icon: "FileText",
          color: "green",
          link: null,
        });
      }

      for (const v of vitals) {
        const parts: string[] = [];
        if (v.bloodPressureSystolic && v.bloodPressureDiastolic) {
          parts.push(`BP ${v.bloodPressureSystolic}/${v.bloodPressureDiastolic}`);
        }
        if (v.pulseRate) parts.push(`HR ${v.pulseRate}`);
        if (v.temperature) parts.push(`Temp ${v.temperature}`);
        if (v.spO2) parts.push(`SpO2 ${v.spO2}%`);
        if (v.weight) parts.push(`Wt ${v.weight}kg`);
        entries.push({
          id: `vit-${v.id}`,
          type: "vitals",
          title: "Vitals Recorded",
          description: parts.join(" · ") || "—",
          timestamp: v.recordedAt.toISOString(),
          icon: "Activity",
          color: "cyan",
          link: null,
        });
      }

      for (const a of admissions) {
        entries.push({
          id: `adm-in-${a.id}`,
          type: "admission",
          title: `Admitted — ${a.admissionNumber}`,
          description: `${a.reason} · ${formatDoctorName(a.doctor?.user?.name) || "—"} · Ward ${
            a.bed?.ward?.name || ""
          } Bed ${a.bed?.bedNumber || ""}`.trim(),
          timestamp: a.admittedAt.toISOString(),
          icon: "BedDouble",
          color: "purple",
          link: `/dashboard/ipd/${a.id}`,
        });
        if (a.dischargedAt) {
          entries.push({
            id: `adm-out-${a.id}`,
            type: "admission",
            title: `Discharged — ${a.admissionNumber}`,
            description: a.dischargeSummary || a.dischargeNotes || "Discharged",
            timestamp: a.dischargedAt.toISOString(),
            icon: "BedDouble",
            color: "gray",
            link: `/dashboard/ipd/${a.id}`,
          });
        }
      }

      for (const lo of labOrders) {
        const testNames = lo.items.map((i) => i.test.name).join(", ");
        entries.push({
          id: `lab-${lo.id}`,
          type: "lab",
          title: `Lab Order ${lo.orderNumber}`,
          description: `${testNames || "—"} · ${lo.status.replace(/_/g, " ")}`,
          timestamp: lo.orderedAt.toISOString(),
          icon: "FlaskConical",
          color: "amber",
          link: null,
        });
        if (lo.completedAt) {
          const totalResults = lo.items.reduce(
            (s, i) => s + i.results.length,
            0
          );
          const abnormal = lo.items.reduce(
            (s, i) =>
              s + i.results.filter((r) => r.flag !== "NORMAL").length,
            0
          );
          entries.push({
            id: `lab-result-${lo.id}`,
            type: "lab",
            title: `Lab Results — ${lo.orderNumber}`,
            description: `${totalResults} result(s)${
              abnormal > 0 ? ` · ${abnormal} abnormal` : ""
            }`,
            timestamp: lo.completedAt.toISOString(),
            icon: "FlaskConical",
            color: abnormal > 0 ? "red" : "green",
            link: null,
          });
        }
      }

      for (const s of surgeries) {
        entries.push({
          id: `surg-${s.id}`,
          type: "surgery",
          title: `Surgery — ${s.procedure}`,
          description: `${s.caseNumber} · ${formatDoctorName(s.surgeon?.user?.name) || "—"} · ${s.status.replace(
            /_/g,
            " "
          )}`,
          timestamp: s.scheduledAt.toISOString(),
          icon: "Scissors",
          color: "rose",
          link: null,
        });
      }

      for (const inv of invoices) {
        entries.push({
          id: `inv-${inv.id}`,
          type: "invoice",
          title: `Invoice ${inv.invoiceNumber}`,
          description: `Rs. ${inv.totalAmount.toFixed(2)} · ${inv.paymentStatus}`,
          timestamp: inv.createdAt.toISOString(),
          icon: "CreditCard",
          color: inv.paymentStatus === "PAID" ? "green" : "orange",
          link: null,
        });
      }

      for (const ec of emergencies) {
        entries.push({
          id: `er-${ec.id}`,
          type: "emergency",
          title: `ER Visit — ${ec.caseNumber}`,
          description: `${ec.chiefComplaint} · ${ec.status.replace(/_/g, " ")}${
            ec.triageLevel ? ` · Triage ${ec.triageLevel}` : ""
          }`,
          timestamp: ec.arrivedAt.toISOString(),
          icon: "Siren",
          color: "red",
          link: null,
        });
      }

      entries.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      res.json({ success: true, data: entries, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/patients/:id/vitals-trend?from=&to=
router.get(
  "/:id/vitals-trend",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from, to } = req.query;
      const where: any = { patientId: req.params.id };
      if (from || to) {
        where.recordedAt = {};
        if (from) where.recordedAt.gte = new Date(from as string);
        if (to) where.recordedAt.lte = new Date(to as string);
      }

      const [opdVitals, ipdVitals] = await Promise.all([
        prisma.vitals.findMany({
          where,
          orderBy: { recordedAt: "asc" },
          select: {
            recordedAt: true,
            bloodPressureSystolic: true,
            bloodPressureDiastolic: true,
            temperature: true,
            temperatureUnit: true,
            pulseRate: true,
            spO2: true,
            weight: true,
            height: true,
            bmi: true,
            isAbnormal: true,
            abnormalFlags: true,
            respiratoryRate: true,
            painScale: true,
          },
        }),
        prisma.ipdVitals.findMany({
          where: {
            admission: { patientId: req.params.id },
            ...(from || to
              ? {
                  recordedAt: {
                    ...(from ? { gte: new Date(from as string) } : {}),
                    ...(to ? { lte: new Date(to as string) } : {}),
                  },
                }
              : {}),
          },
          orderBy: { recordedAt: "asc" },
          select: {
            recordedAt: true,
            bloodPressureSystolic: true,
            bloodPressureDiastolic: true,
            temperature: true,
            pulseRate: true,
            spO2: true,
          },
        }),
      ]);

      const combined = [
        ...opdVitals.map((v) => ({ ...v, weight: v.weight ?? null })),
        ...ipdVitals.map((v) => ({ ...v, weight: null })),
      ].sort(
        (a, b) =>
          new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime()
      );

      res.json({ success: true, data: combined, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/patients/:id/stats
router.get(
  "/:id/stats",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patientId = req.params.id;
      const now = new Date();
      const todayStr = now.toISOString().split("T")[0];

      // Issue #330: previously totalVisits only counted COMPLETED +
      // IN_CONSULTATION, so a freshly-registered walk-in (status BOOKED)
      // showed Total Visits = 0 in the header KPI strip even though the
      // "Last 90 Days" panel and the Recent Activity / Timeline both
      // surfaced the same row as a visit. The two displays disagreed on
      // the same screen.
      //
      // Align the count with what users (and the timeline) consider a
      // visit: any real appointment, excluding only CANCELLED and
      // NO_SHOW. The Last 90 Days panel derives from the same /history
      // feed, so the two now agree by construction (Last 90 Days = a
      // trailing-90-day subset of the same denominator).
      const VISIT_STATUSES = [
        "BOOKED",
        "CHECKED_IN",
        "IN_CONSULTATION",
        "COMPLETED",
      ] as const;
      const [
        totalVisits,
        lastVisit,
        paidInvoices,
        activeConditions,
        activeAllergies,
        upcomingAppointments,
        pendingBills,
        currentAdmission,
      ] = await Promise.all([
        prisma.appointment.count({
          where: { patientId, status: { in: [...VISIT_STATUSES] } },
        }),
        prisma.appointment.findFirst({
          where: { patientId, status: { in: [...VISIT_STATUSES] } },
          orderBy: { date: "desc" },
          select: { date: true },
        }),
        prisma.invoice.aggregate({
          where: { patientId, paymentStatus: "PAID" },
          _sum: { totalAmount: true },
        }),
        // Issue #85: previously this only counted chronic conditions with
        // status ACTIVE/RELAPSED. The Patient 360 "Problem List" card,
        // backed by GET /ehr/patients/:id/problem-list, treats CONTROLLED
        // as active too — so the KPI tile read 0 while the card showed 7.
        // Aligning the include set fixes the mismatch.
        prisma.chronicCondition.count({
          where: {
            patientId,
            status: { in: ["ACTIVE", "RELAPSED", "CONTROLLED"] },
          },
        }),
        prisma.patientAllergy.count({
          where: { patientId },
        }),
        prisma.appointment.count({
          where: {
            patientId,
            status: { in: ["BOOKED", "CHECKED_IN"] },
            date: { gte: new Date(todayStr) },
          },
        }),
        prisma.invoice.count({
          where: {
            patientId,
            paymentStatus: { in: ["PENDING", "PARTIAL"] },
          },
        }),
        prisma.admission.findFirst({
          where: { patientId, status: "ADMITTED" },
          select: { id: true, admissionNumber: true },
        }),
      ]);

      res.json({
        success: true,
        data: {
          totalVisits,
          lastVisitDate: lastVisit?.date || null,
          totalSpent: paidInvoices._sum.totalAmount || 0,
          activeConditionsCount: activeConditions,
          activeAllergiesCount: activeAllergies,
          upcomingAppointments,
          pendingBills,
          currentAdmissionId: currentAdmission?.id || null,
          currentAdmissionNumber: currentAdmission?.admissionNumber || null,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/patients/:id/invoices
router.get(
  "/:id/invoices",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invoices = await prisma.invoice.findMany({
        where: { patientId: req.params.id },
        include: {
          items: true,
          payments: true,
          appointment: {
            include: {
              doctor: { include: { user: { select: { name: true } } } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      res.json({ success: true, data: invoices, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/patients/:id/lab-orders
router.get(
  "/:id/lab-orders",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const orders = await prisma.labOrder.findMany({
        where: { patientId: req.params.id },
        include: {
          doctor: { include: { user: { select: { name: true } } } },
          items: {
            include: {
              test: true,
              results: true,
            },
          },
        },
        orderBy: { orderedAt: "desc" },
      });

      res.json({ success: true, data: orders, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── FAMILY LINKING (Apr 2026) ──────────────────────────

// GET /api/v1/patients/:id/family
router.get(
  "/:id/family",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: req.params.id },
        select: { id: true, guardianPatientId: true },
      });
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }
      const [guardian, dependents, familyLinks] = await Promise.all([
        patient.guardianPatientId
          ? prisma.patient.findUnique({
              where: { id: patient.guardianPatientId },
              include: { user: { select: { name: true, phone: true } } },
            })
          : Promise.resolve(null),
        prisma.patient.findMany({
          where: { guardianPatientId: patient.id },
          include: { user: { select: { name: true, phone: true } } },
        }),
        prisma.patientFamilyLink.findMany({
          where: { patientId: patient.id },
          include: {
            relatedPatient: {
              include: { user: { select: { name: true, phone: true } } },
            },
          },
        }),
      ]);

      res.json({
        success: true,
        data: { guardian, dependents, familyLinks },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/patients/:id/link-family
router.post(
  "/:id/link-family",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patientId = req.params.id;
      const { relatedPatientId, relationship } = req.body as {
        relatedPatientId: string;
        relationship: "PARENT" | "CHILD" | "SPOUSE" | "SIBLING" | "GUARDIAN";
      };
      if (!relatedPatientId || !relationship) {
        res.status(400).json({
          success: false,
          data: null,
          error: "relatedPatientId and relationship required",
        });
        return;
      }
      if (relatedPatientId === patientId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Cannot link a patient to themselves",
        });
        return;
      }
      const [patient, related] = await Promise.all([
        prisma.patient.findUnique({ where: { id: patientId } }),
        prisma.patient.findUnique({ where: { id: relatedPatientId } }),
      ]);
      if (!patient || !related) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      // Create bidirectional link (simplified — inverse relation is PARENT<->CHILD, otherwise same)
      const inverse: Record<string, string> = {
        PARENT: "CHILD",
        CHILD: "PARENT",
        SPOUSE: "SPOUSE",
        SIBLING: "SIBLING",
        GUARDIAN: "CHILD",
      };

      const [a, b] = await prisma.$transaction([
        prisma.patientFamilyLink.upsert({
          where: {
            patientId_relatedPatientId: { patientId, relatedPatientId },
          },
          create: { patientId, relatedPatientId, relationship },
          update: { relationship },
        }),
        prisma.patientFamilyLink.upsert({
          where: {
            patientId_relatedPatientId: {
              patientId: relatedPatientId,
              relatedPatientId: patientId,
            },
          },
          create: {
            patientId: relatedPatientId,
            relatedPatientId: patientId,
            relationship: inverse[relationship] || relationship,
          },
          update: { relationship: inverse[relationship] || relationship },
        }),
      ]);

      // If PARENT/GUARDIAN, set guardianPatientId on this patient
      if (relationship === "PARENT" || relationship === "GUARDIAN") {
        await prisma.patient.update({
          where: { id: patientId },
          data: { guardianPatientId: relatedPatientId },
        });
      }
      if (relationship === "CHILD") {
        await prisma.patient.update({
          where: { id: relatedPatientId },
          data: { guardianPatientId: patientId },
        });
      }

      auditLog(req, "FAMILY_LINK", "patient", patientId, {
        relatedPatientId,
        relationship,
      }).catch(console.error);

      res.status(201).json({
        success: true,
        data: { primaryLink: a, inverseLink: b },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/patients/:id/link-family/:relatedId
router.delete(
  "/:id/link-family/:relatedId",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id, relatedId } = req.params;
      await prisma.$transaction([
        prisma.patientFamilyLink.deleteMany({
          where: { patientId: id, relatedPatientId: relatedId },
        }),
        prisma.patientFamilyLink.deleteMany({
          where: { patientId: relatedId, relatedPatientId: id },
        }),
      ]);
      auditLog(req, "FAMILY_UNLINK", "patient", id, { relatedId }).catch(
        console.error
      );
      res.json({ success: true, data: { unlinked: true }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/patients/:id/renal-function
// Latest creatinine + Cockcroft-Gault eGFR estimate
router.get(
  "/:id/renal-function",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: req.params.id },
        select: { id: true, dateOfBirth: true, age: true, gender: true },
      });
      if (!patient) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      // Find latest creatinine lab result (parameter includes 'creatinine', case-insensitive)
      const recentResults = await prisma.labResult.findMany({
        where: {
          parameter: { contains: "reatinine", mode: "insensitive" },
          orderItem: { order: { patientId: patient.id } },
        },
        orderBy: { reportedAt: "desc" },
        take: 1,
        include: {
          orderItem: {
            select: {
              order: {
                select: { orderedAt: true, orderNumber: true },
              },
            },
          },
        },
      });

      const latest = recentResults[0] ?? null;
      const creatinineMgDl = latest ? parseFloat(latest.value) : null;

      // Get latest weight from vitals for CrCl calc
      const latestVitals = await prisma.vitals.findFirst({
        where: { patientId: patient.id, weight: { not: null } },
        orderBy: { recordedAt: "desc" },
        select: { weight: true, recordedAt: true },
      });

      const ageYears =
        patient.age ??
        (patient.dateOfBirth
          ? Math.floor(
              (Date.now() - patient.dateOfBirth.getTime()) /
                (365.25 * 24 * 3600 * 1000)
            )
          : null);
      const genderMale = patient.gender === "MALE";
      const weightKg = latestVitals?.weight ?? null;

      let crcl: number | null = null;
      if (creatinineMgDl && creatinineMgDl > 0 && ageYears && weightKg) {
        let v = ((140 - ageYears) * weightKg) / (72 * creatinineMgDl);
        if (!genderMale) v *= 0.85;
        crcl = Math.round(v * 10) / 10;
      }

      let stage: string | null = null;
      if (crcl !== null) {
        if (crcl < 15) stage = "KIDNEY_FAILURE";
        else if (crcl < 30) stage = "SEVERE";
        else if (crcl < 60) stage = "MODERATE";
        else if (crcl < 90) stage = "MILD";
        else stage = "NORMAL";
      }

      res.json({
        success: true,
        data: {
          patientId: patient.id,
          ageYears,
          genderMale,
          weightKg,
          latestCreatinine: latest
            ? {
                value: creatinineMgDl,
                unit: latest.unit,
                reportedAt: latest.reportedAt,
                orderNumber: latest.orderItem.order.orderNumber,
              }
            : null,
          crClMlPerMin: crcl,
          ckdStage: stage,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as patientRouter };
