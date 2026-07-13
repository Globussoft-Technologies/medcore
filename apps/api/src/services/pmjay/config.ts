// PM-JAY (Ayushman Bharat) integration — typed configuration.
//
// Every PM-JAY endpoint + behavioural knob is read from the environment so the
// adapter is portable across state gateways (SHA deployments differ in base
// URLs and auth flows). NOTHING is hardcoded here. When mandatory live
// credentials are absent we fall back to `simulation` mode, which lets the
// whole beneficiary → pre-auth → claim → settle workflow run end-to-end in dev
// without touching a real government API.

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

/**
 * Read PM-JAY config from `process.env` on every call (cheap; avoids a stale
 * module-scope cache leaking across tests that mutate env). The important
 * derived value is `simulation`: we require a base URL + auth URL + hospital id
 * + client credentials for a live run; anything missing forces simulation.
 */
export function readPmjayConfig(): PmjayConfig {
  const urls = {
    base: str(process.env.TPA_PMJAY_BASE_URL),
    auth: str(process.env.TPA_PMJAY_AUTH_URL),
    bis: str(process.env.TPA_PMJAY_BIS_URL),
    tms: str(process.env.TPA_PMJAY_TMS_URL),
    package: str(process.env.TPA_PMJAY_PACKAGE_URL),
  };
  const hospitalId = str(process.env.TPA_PMJAY_HOSPITAL_ID);
  const clientId = str(process.env.TPA_PMJAY_CLIENT_ID);
  const clientSecret = str(process.env.TPA_PMJAY_CLIENT_SECRET);

  const hasLiveCreds = Boolean(
    urls.base && urls.auth && hospitalId && clientId && clientSecret
  );
  // Explicit simulation flag wins; otherwise simulate whenever creds are absent.
  const simulation = bool(process.env.TPA_PMJAY_SIMULATION, !hasLiveCreds);

  return {
    enabled: bool(process.env.TPA_PMJAY_ENABLED, true),
    simulation,
    hospitalId,
    clientId,
    clientSecret,
    urls,
    timeoutMs: int(process.env.TPA_PMJAY_TIMEOUT, 30_000),
    retries: int(process.env.TPA_PMJAY_RETRIES, 3),
    logging: bool(process.env.TPA_PMJAY_LOGGING, false),
    batchSize: int(process.env.TPA_PMJAY_BATCH_SIZE, 200),
  };
}
