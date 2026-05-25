export enum Role {
  ADMIN = "ADMIN",
  DOCTOR = "DOCTOR",
  RECEPTION = "RECEPTION",
  NURSE = "NURSE",
  PATIENT = "PATIENT",
  PHARMACIST = "PHARMACIST",
  LAB_TECH = "LAB_TECH",
  // Finance staff — TDS, no-show, commission, lead-funnel reports (added 2026-05-24).
  // Shared TS enum was previously behind the Prisma enum which already had a
  // `BILLING` value used by FeedbackCategory; now we expose it as a USER role
  // too so the 4 §4.4 finance reports can widen ADMIN-only → ADMIN+BILLING.
  BILLING = "BILLING",
  // Onviqa platform-level staff. Users with these roles have `tenantId = null`
  // in their JWT; tenantContextMiddleware short-circuits tenant-scope filtering
  // for them so they can act across tenants. New platform-level roles go on the
  // PLATFORM_ROLES allow-list in `@medcore/db` so the bypass picks them up.
  PLATFORM_OPERATOR = "PLATFORM_OPERATOR",
  PLATFORM_BILLING_OPERATOR = "PLATFORM_BILLING_OPERATOR",
}

export interface UserBase {
  id: string;
  email: string;
  phone: string;
  name: string;
  role: Role;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
