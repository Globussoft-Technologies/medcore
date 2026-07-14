/**
 * PM-JAY per-tenant config loader + secret crypto — unit tests.
 *
 * What / which modules / why:
 *   - `crypto.ts`: encrypt→decrypt round-trips (real AES key + plaintext-stub).
 *   - `config.ts` loadPmjayConfig: no tenant → simulation fallback (no DB read);
 *     complete tenant row → live (simulation off, secret decrypted); incomplete
 *     row → simulation stays on. Proves credentials come from the tenant row,
 *     not global env.
 *   - Mocks @medcore/db (prisma + getTenantId) so no real DB is touched.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, tenantRef } = vi.hoisted(() => ({
  prismaMock: { tenantPmjayConfiguration: { findUnique: vi.fn(async () => null as any) } },
  tenantRef: { id: undefined as string | undefined },
}));

vi.mock("@medcore/db", () => ({
  prisma: prismaMock,
  getTenantId: () => tenantRef.id,
}));

import { loadPmjayConfig } from "./config";
import { encryptSecret, decryptSecret } from "./crypto";

beforeEach(() => {
  vi.clearAllMocks();
  tenantRef.id = undefined;
  prismaMock.tenantPmjayConfiguration.findUnique.mockResolvedValue(null);
  delete process.env.PMJAY_CREDS_KEY;
  delete process.env.WHATSAPP_CREDS_KEY;
});

describe("pmjay crypto", () => {
  it("round-trips a secret with a real AES key", () => {
    process.env.PMJAY_CREDS_KEY = "a".repeat(64); // 32 bytes hex
    const enc = encryptSecret("super-secret");
    expect(enc).not.toBe("super-secret");
    expect(enc.startsWith("pmjay-plaintext:")).toBe(false);
    expect(decryptSecret(enc)).toBe("super-secret");
  });

  it("uses a marked plaintext blob when no key is set (dev), still round-trips", () => {
    const enc = encryptSecret("dev-secret");
    expect(enc.startsWith("pmjay-plaintext:")).toBe(true);
    expect(decryptSecret(enc)).toBe("dev-secret");
  });

  it("returns null for empty input", () => {
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret("")).toBeNull();
  });
});

describe("loadPmjayConfig", () => {
  it("falls back to simulation when there is no tenant context (no DB read)", async () => {
    const cfg = await loadPmjayConfig();
    expect(cfg.simulation).toBe(true);
    expect(cfg.clientSecret).toBeNull();
    expect(prismaMock.tenantPmjayConfiguration.findUnique).not.toHaveBeenCalled();
  });

  it("loads live config from the tenant row (simulation off, secret decrypted)", async () => {
    tenantRef.id = "t-1";
    prismaMock.tenantPmjayConfiguration.findUnique.mockResolvedValue({
      enabled: true,
      simulationMode: false,
      hospitalId: "H-1",
      clientId: "C-1",
      clientSecret: encryptSecret("the-secret"),
      baseUrl: "https://gw",
      authUrl: "https://gw/auth",
      bisUrl: "https://gw/bis",
      tmsUrl: "https://gw/tms",
      packageUrl: "https://gw/pkg",
      timeout: 12345,
      retryCount: 7,
      logging: true,
      batchSize: 50,
    });
    const cfg = await loadPmjayConfig();
    expect(cfg.simulation).toBe(false);
    expect(cfg.clientSecret).toBe("the-secret");
    expect(cfg.hospitalId).toBe("H-1");
    expect(cfg.urls.tms).toBe("https://gw/tms");
    expect(cfg.timeoutMs).toBe(12345);
    expect(cfg.retries).toBe(7);
    expect(prismaMock.tenantPmjayConfiguration.findUnique).toHaveBeenCalledWith({ where: { tenantId: "t-1" } });
  });

  it("stays in simulation when the tenant row has incomplete credentials", async () => {
    tenantRef.id = "t-2";
    prismaMock.tenantPmjayConfiguration.findUnique.mockResolvedValue({
      enabled: true,
      simulationMode: false, // even with sim explicitly off...
      hospitalId: "H-2",
      clientId: null, // ...missing creds force simulation
      clientSecret: null,
      baseUrl: "https://gw",
      authUrl: null,
      bisUrl: null,
      tmsUrl: null,
      packageUrl: null,
      timeout: null,
      retryCount: null,
      logging: null,
      batchSize: null,
    });
    const cfg = await loadPmjayConfig();
    expect(cfg.simulation).toBe(true);
  });

  it("honours an explicit tenant id argument", async () => {
    prismaMock.tenantPmjayConfiguration.findUnique.mockResolvedValue(null);
    await loadPmjayConfig("explicit-t");
    expect(prismaMock.tenantPmjayConfiguration.findUnique).toHaveBeenCalledWith({ where: { tenantId: "explicit-t" } });
  });
});
