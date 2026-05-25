// Pearl ERP Stage 1 §8.2 (gap row 212) integration test —
// per-tenant idle session timeout: schema + config UI surface.
//
// What this brackets: the PATCH /api/v1/tenants/:id handler now
// accepts a `sessionIdleMinutes` field (integer, 5..1440) which
// persists to `Tenant.sessionIdleMinutes` and (when the value
// actually changes) writes a dedicated TENANT_SESSION_IDLE_UPDATED
// AuditLog row. JWT TTL enforcement (apps/api/src/routes/auth.ts)
// is explicitly DEFERRED — this row is closed only for the
// schema-field + config-UI half; the actual idle-timeout enforcement
// at the token-signing layer is a separate piece.
//
// Which modules: routes/tenants.ts (PATCH handler + Zod schema),
//                middleware/audit.ts (audit row write),
//                packages/db/prisma/schema.prisma (Tenant model).
//
// Why: an operator needs to set the per-tenant idle timeout from
// the super-admin tenant edit drawer. Validating range, RBAC,
// persistence, and audit row are all that's in scope for this
// row's closure.
import { it, expect, beforeEach } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { waitForAuditFlush } from "../helpers/audit-wait";

let app: any;
let adminToken: string;
let doctorToken: string;

describeIfDB("Tenant per-tenant session idle timeout (Pearl §8.2 row 212)", () => {
  beforeEach(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("PATCH /tenants/:id with sessionIdleMinutes=60 → 200 + persists + emits TENANT_SESSION_IDLE_UPDATED audit row", async () => {
    const prisma = await getPrisma();
    let tenant = await prisma.tenant.findFirst({
      select: { id: true, sessionIdleMinutes: true },
    });
    if (!tenant) {
      tenant = await prisma.tenant.create({
        data: { name: "Default Test Tenant", subdomain: "default" },
        select: { id: true, sessionIdleMinutes: true },
      });
    }
    expect(tenant).toBeTruthy();

    const res = await request(app)
      .patch(`/api/v1/tenants/${tenant.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ sessionIdleMinutes: 60 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sessionIdleMinutes).toBe(60);

    const fresh = await prisma.tenant.findUnique({
      where: { id: tenant.id },
      select: { sessionIdleMinutes: true },
    });
    expect(fresh?.sessionIdleMinutes).toBe(60);

    // Audit row landed (fire-and-forget through safeAudit-style wrapper,
    // poll until visible).
    const row = await waitForAuditFlush(prisma, {
      action: "TENANT_SESSION_IDLE_UPDATED",
      entity: "tenant",
      entityId: tenant.id,
    });
    expect(row).toBeTruthy();
    const details = row.details as { previous?: number; next?: number } | null;
    expect(details?.next).toBe(60);
  });

  it("PATCH /tenants/:id with sessionIdleMinutes=4 (too low) → 400", async () => {
    const prisma = await getPrisma();
    const tenant = await prisma.tenant.findFirst({ select: { id: true } });
    if (!tenant) return;

    const res = await request(app)
      .patch(`/api/v1/tenants/${tenant.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ sessionIdleMinutes: 4 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("PATCH /tenants/:id with sessionIdleMinutes=2000 (too high) → 400", async () => {
    const prisma = await getPrisma();
    const tenant = await prisma.tenant.findFirst({ select: { id: true } });
    if (!tenant) return;

    const res = await request(app)
      .patch(`/api/v1/tenants/${tenant.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ sessionIdleMinutes: 2000 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("non-super-admin (DOCTOR) → 403 even with valid body", async () => {
    const prisma = await getPrisma();
    const tenant = await prisma.tenant.findFirst({ select: { id: true } });
    if (!tenant) return;

    const res = await request(app)
      .patch(`/api/v1/tenants/${tenant.id}`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ sessionIdleMinutes: 45 });

    expect(res.status).toBe(403);
  });
});
