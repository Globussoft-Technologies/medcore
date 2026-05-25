/**
 * Pearl ERP Stage 1 §8.3 (gap row 215 closure piece 3b, 2026-05-24) —
 * platform-invoice email-stub tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: pins the contract of the deliberately-stubbed
 *   `sendPlatformInvoiceEmail` so a future change that swaps in
 *   real SendGrid wiring still writes the same audit row + still
 *   surfaces a structured return value.
 * - MODULES: mocks `@medcore/db` so no real Prisma is touched.
 * - WHY: tests the "stubbed" contract today and is a tripwire when
 *   the real wiring lands — flipping `status` to `"SENT"` will
 *   intentionally fail this test, which is the signal to swap the
 *   expectation as part of the real-send commit.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@medcore/db", () => ({}));

import { sendPlatformInvoiceEmail } from "./platform-invoice-email";

function buildPrisma() {
  const auditStore: any[] = [];
  const prismaMock: any = {
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        auditStore.push(data);
        return { id: `audit-${auditStore.length}` };
      }),
    },
  };
  return { prismaMock, auditStore };
}

describe("sendPlatformInvoiceEmail (stub)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns STUBBED and writes a PLATFORM_INVOICE_EMAIL_QUEUED audit row", async () => {
    const { prismaMock, auditStore } = buildPrisma();
    const invoice = {
      id: "inv-1",
      invoiceNumber: "PI-202604-0001",
      totalInPaise: 118_000,
      periodStart: new Date("2026-04-01T00:00:00Z"),
      periodEnd: new Date("2026-05-01T00:00:00Z"),
    };
    const tenant = { id: "t-1", name: "Acme Hospital" };

    const result = await sendPlatformInvoiceEmail(prismaMock, invoice, tenant);

    expect(result.status).toBe("STUBBED");
    expect(result.recipientEmail).toBeNull();
    expect(result.message).toContain("PI-202604-0001");
    expect(result.message).toContain("Acme Hospital");
    expect(auditStore).toHaveLength(1);
    expect(auditStore[0]).toMatchObject({
      action: "PLATFORM_INVOICE_EMAIL_QUEUED",
      entity: "platform_invoice",
      entityId: "inv-1",
    });
    expect(auditStore[0].details).toMatchObject({
      invoiceNumber: "PI-202604-0001",
      tenantId: "t-1",
      tenantName: "Acme Hospital",
      totalInPaise: 118_000,
      mode: "STUB",
    });
  });

  it("returns ERROR when the audit-log write fails — failure must be visible", async () => {
    const prismaMock: any = {
      auditLog: {
        create: vi.fn(async () => {
          throw new Error("DB down");
        }),
      },
    };
    const invoice = {
      id: "inv-1",
      invoiceNumber: "PI-202604-0001",
      totalInPaise: 118_000,
      periodStart: new Date("2026-04-01T00:00:00Z"),
      periodEnd: new Date("2026-05-01T00:00:00Z"),
    };
    const tenant = { id: "t-1", name: "Acme Hospital" };

    const result = await sendPlatformInvoiceEmail(prismaMock, invoice, tenant);

    expect(result.status).toBe("ERROR");
  });
});
