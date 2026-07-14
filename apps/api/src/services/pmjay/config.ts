// PM-JAY (Ayushman Bharat) integration — typed configuration.
//
// Configuration is now PER-TENANT: credentials + endpoints live in the
// `TenantPmjayConfiguration` table (one row per hospital), NOT in global env.
// `loadPmjayConfig()` resolves the current tenant (from the request's
// AsyncLocalStorage context, or an explicit id), reads that tenant's row, and
// decrypts the client secret. Only behavioural DEFAULTS (timeout / retries /
// logging / batch size) remain in env as fallbacks. When no tenant/row is
// resolved (e.g. a background job with no tenant context, or an unconfigured
// tenant) we return a safe simulation config so the workflow still runs.

import { prisma, getTenantId } from "@medcore/db";
import { decryptSecret } from "./crypto";

/** Fully-resolved PM-JAY configuration for a single process. */
export interface PmjayConfig {
  /** Master on/off switch. When false the adapter refuses live calls. */
  enabled: boolean;
  /**
   * True when we must simulate rather than call a real gateway. Set either
   * explicitly (`TPA_PMJAY_SIMULATION=true`) or implicitly when mandatory
   * credentials are missing.
   */
  simulation: boolean;
  /** Provider-network hospital id issued at empanelment. */
  hospitalId: string | null;
  /** OAuth client credentials for the token manager. */
  clientId: string | null;
  clientSecret: string | null;
  /** Per-request URLs — each may differ per state/deployment. */
  urls: {
    base: string | null;
    auth: string | null;
    bis: string | null; // Beneficiary Identification System
    tms: string | null; // Transaction Management System (claims)
    package: string | null; // Package master
  };
  /** HTTP timeout (ms) for a single outbound call. */
  timeoutMs: number;
  /** Max retry attempts on transient failure (RATE_LIMITED / TPA_UNAVAILABLE). */
  retries: number;
  /** Emit verbose request/response logs (never logs secrets or PHI bodies). */
  logging: boolean;
  /** Page size for bulk operations such as package-master sync. */
  batchSize: number;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function str(value: string | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

/** Global behavioural defaults (env). Only fallbacks — NOT credentials. */
interface PmjayDefaults {
  timeoutMs: number;
  retries: number;
  logging: boolean;
  batchSize: number;
}
function readDefaults(): PmjayDefaults {
  return {
    timeoutMs: int(process.env.PMJAY_DEFAULT_TIMEOUT, 30_000),
    retries: int(process.env.PMJAY_DEFAULT_RETRIES, 3),
    logging: bool(process.env.PMJAY_DEFAULT_LOGGING, false),
    batchSize: int(process.env.PMJAY_DEFAULT_BATCH_SIZE, 200),
  };
}

/** Shape of the persisted per-tenant row (subset we consume). */
interface PmjayConfigRow {
  enabled: boolean;
  simulationMode: boolean;
  hospitalId: string | null;
  clientId: string | null;
  clientSecret: string | null; // ciphertext
  baseUrl: string | null;
  authUrl: string | null;
  bisUrl: string | null;
  tmsUrl: string | null;
  packageUrl: string | null;
  timeout: number | null;
  retryCount: number | null;
  logging: boolean | null;
  batchSize: number | null;
}

/**
 * Safe fallback used when no tenant/row resolves (background jobs without a
 * tenant context, or a tenant that hasn't configured PM-JAY yet): simulation
 * mode, no credentials, env defaults. `enabled` still honours the legacy
 * `TPA_PMJAY_ENABLED` kill-switch so ops can globally disable if needed.
 */
function fallbackConfig(d: PmjayDefaults): PmjayConfig {
  return {
    enabled: bool(process.env.TPA_PMJAY_ENABLED, true),
    simulation: true,
    hospitalId: null,
    clientId: null,
    clientSecret: null,
    urls: { base: null, auth: null, bis: null, tms: null, package: null },
    timeoutMs: d.timeoutMs,
    retries: d.retries,
    logging: d.logging,
    batchSize: d.batchSize,
  };
}

/** Build a runtime config from a persisted tenant row (decrypts the secret). */
function fromRow(row: PmjayConfigRow, d: PmjayDefaults): PmjayConfig {
  const clientSecret = decryptSecret(row.clientSecret);
  const urls = {
    base: str(row.baseUrl ?? undefined),
    auth: str(row.authUrl ?? undefined),
    bis: str(row.bisUrl ?? undefined),
    tms: str(row.tmsUrl ?? undefined),
    package: str(row.packageUrl ?? undefined),
  };
  const hospitalId = str(row.hospitalId ?? undefined);
  const clientId = str(row.clientId ?? undefined);
  const hasLiveCreds = Boolean(urls.base && urls.auth && hospitalId && clientId && clientSecret);
  // Explicit simulation flag wins; otherwise simulate whenever creds incomplete.
  const simulation = row.simulationMode || !hasLiveCreds;
  return {
    enabled: row.enabled,
    simulation,
    hospitalId,
    clientId,
    clientSecret,
    urls,
    timeoutMs: row.timeout ?? d.timeoutMs,
    retries: row.retryCount ?? d.retries,
    logging: row.logging ?? d.logging,
    batchSize: row.batchSize ?? d.batchSize,
  };
}

/**
 * Resolve the effective PM-JAY config for the CURRENT tenant. Reads the tenant
 * from `explicitTenantId` or the request's ALS context, loads its row, and
 * merges env defaults. Never throws — falls back to simulation on any miss.
 */
export async function loadPmjayConfig(
  explicitTenantId?: string | null
): Promise<PmjayConfig> {
  const d = readDefaults();
  const tenantId =
    explicitTenantId ?? (typeof getTenantId === "function" ? getTenantId() : undefined);
  if (!tenantId) return fallbackConfig(d);

  let row: PmjayConfigRow | null = null;
  try {
    row = (await prisma.tenantPmjayConfiguration.findUnique({
      where: { tenantId },
    })) as PmjayConfigRow | null;
  } catch {
    row = null;
  }
  return row ? fromRow(row, d) : fallbackConfig(d);
}
