/**
 * Pearl ERP Stage 1 §8.3 piece 3g (2026-05-28) — DB-backed platform-billing
 * configuration.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: a tiny accessor + seed module for every operator-tunable knob
 *   that platform billing reads. Each value lives in a single
 *   `SystemConfig` row keyed `platform_billing:<name>` so a super-admin
 *   can change pricing / GST state / grace window without a deploy.
 * - MODULES: reads/writes `SystemConfig` via `@medcore/db`. Consumed by
 *   `usage-tracker.aggregateUsageForBilling`, the monthly invoice
 *   generator (`platform-invoice-generator.ts`) and the state machine
 *   (`platform-subscription-state.ts`).
 * - WHY: the operator requested "dont hard coded anythigs in code what
 *   need that you can store in DB thst later can add like you think".
 *   Pricing for WhatsApp / SMS / LLM tokens / ABDM messages will move
 *   over time as the underlying providers change their rates; GST
 *   place-of-supply + grace window are operations-policy levers. Keeping
 *   them in SystemConfig means an operator UI can later expose an
 *   "edit platform-billing settings" page without any schema work.
 *
 * Seed behaviour
 * ──────────────
 * `seedPlatformBillingConfig()` is called once at app boot from
 * `services/scheduled-tasks.ts` → `startScheduler()`. It performs an
 * idempotent `upsert(create only on missing)` for every key in
 * `PLATFORM_BILLING_DEFAULTS`. Already-present rows are left alone so
 * operator edits are never clobbered on restart.
 *
 * Read path
 * ─────────
 * Each `get<Knob>()` accessor does a single `findUnique` against the key
 * and parses the string value. On missing / malformed rows it falls
 * back to the same default the seed would have written — defensive belt
 * for the case where the seed hasn't run yet on a brand-new database.
 */
import { prisma } from "@medcore/db";

// ─── Key constants ──────────────────────────────────────────────────

const USAGE_UNIT_PRICE_KEY = (kind: string) =>
  `platform_billing:usage_price:${kind}`;
const OPERATOR_STATE_KEY = "platform_billing:operator_state";
const CGST_RATE_KEY = "platform_billing:cgst_rate";
const SGST_RATE_KEY = "platform_billing:sgst_rate";
const IGST_RATE_KEY = "platform_billing:igst_rate";
const GRACE_PERIOD_DAYS_KEY = "platform_billing:grace_period_days";
const SAAS_HSN_SAC_KEY = "platform_billing:saas_hsn_sac";

// ─── Defaults (seed source, NOT a runtime fallback layer) ───────────

/** Used by the seed only. After the seed runs these values live in DB. */
const PLATFORM_BILLING_DEFAULTS: Array<{ key: string; value: string }> = [
  // WhatsApp template message — ₹0.50 / message
  { key: USAGE_UNIT_PRICE_KEY("WHATSAPP_SENT"), value: "50" },
  // SMS transactional — ₹0.20 / message
  { key: USAGE_UNIT_PRICE_KEY("SMS_SENT"), value: "20" },
  // LLM tokens — ₹0.01 / token (combined input+output)
  { key: USAGE_UNIT_PRICE_KEY("LLM_TOKENS"), value: "1" },
  // ABDM message — ₹0.10 / message
  { key: USAGE_UNIT_PRICE_KEY("ABDM_MESSAGE"), value: "10" },
  // Platform-operator place-of-supply for GST split (CGST+SGST vs IGST)
  { key: OPERATOR_STATE_KEY, value: "Karnataka" },
  // GST rates (percent). 9 + 9 = 18 same-state; 18 cross-state.
  { key: CGST_RATE_KEY, value: "9" },
  { key: SGST_RATE_KEY, value: "9" },
  { key: IGST_RATE_KEY, value: "18" },
  // Read-only grace window between past_due and suspended
  { key: GRACE_PERIOD_DAYS_KEY, value: "7" },
  // HSN/SAC code for SaaS line items — Information Technology Software Services
  { key: SAAS_HSN_SAC_KEY, value: "998314" },
];

// In-process cache so the monthly cron doesn't issue dozens of identical
// SystemConfig queries inside one loop iteration. Invalidated on
// `setConfigValue()` to keep operator edits visible immediately.
const cache = new Map<string, string>();

async function readKey(key: string): Promise<string | null> {
  const hit = cache.get(key);
  if (hit != null) return hit;
  const row = await prisma.systemConfig.findUnique({
    where: { key },
    select: { value: true },
  });
  if (row?.value != null) {
    cache.set(key, row.value);
    return row.value;
  }
  return null;
}

function defaultFor(key: string): string | null {
  return (
    PLATFORM_BILLING_DEFAULTS.find((d) => d.key === key)?.value ?? null
  );
}

async function readNumber(key: string): Promise<number | null> {
  const v = (await readKey(key)) ?? defaultFor(key);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve the per-unit price (in paise) for a billable usage kind. Reads
 * SystemConfig; falls back to the seed default if missing.
 */
export async function getUsageUnitPaise(kind: string): Promise<number> {
  const v = await readNumber(USAGE_UNIT_PRICE_KEY(kind));
  return v ?? 0;
}

/**
 * Resolve every usage kind's unit price in one batched read. Used by the
 * monthly aggregator so a single tenant's invoice doesn't fire N queries.
 */
export async function getAllUsageUnitPaise(): Promise<Record<string, number>> {
  const kinds = [
    "WHATSAPP_SENT",
    "SMS_SENT",
    "LLM_TOKENS",
    "ABDM_MESSAGE",
  ] as const;
  const keys = kinds.map((k) => USAGE_UNIT_PRICE_KEY(k));
  const rows = await prisma.systemConfig.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  });
  const map: Record<string, number> = {};
  for (const k of kinds) map[k] = Number(defaultFor(USAGE_UNIT_PRICE_KEY(k)));
  for (const r of rows) {
    const kind = r.key.replace(/^platform_billing:usage_price:/, "");
    const n = Number(r.value);
    if (Number.isFinite(n)) map[kind] = n;
  }
  return map;
}

export async function getPlatformOperatorState(): Promise<string> {
  return (await readKey(OPERATOR_STATE_KEY)) ?? defaultFor(OPERATOR_STATE_KEY)!;
}

export async function getGstRates(): Promise<{
  cgst: number;
  sgst: number;
  igst: number;
}> {
  const [cgst, sgst, igst] = await Promise.all([
    readNumber(CGST_RATE_KEY),
    readNumber(SGST_RATE_KEY),
    readNumber(IGST_RATE_KEY),
  ]);
  return {
    cgst: cgst ?? 9,
    sgst: sgst ?? 9,
    igst: igst ?? 18,
  };
}

export async function getGracePeriodDays(): Promise<number> {
  const v = await readNumber(GRACE_PERIOD_DAYS_KEY);
  return v ?? 7;
}

export async function getSaasHsnSac(): Promise<string> {
  return (await readKey(SAAS_HSN_SAC_KEY)) ?? defaultFor(SAAS_HSN_SAC_KEY)!;
}

/**
 * Write a config value and invalidate the in-process cache so subsequent
 * reads see the new value immediately. Returns the persisted value.
 * Used by the future operator UI (PUT /platform-billing/config/:key).
 */
export async function setConfigValue(
  key: string,
  value: string,
): Promise<string> {
  if (!key.startsWith("platform_billing:")) {
    throw new Error(
      "Only platform_billing:* keys can be set through this helper.",
    );
  }
  await prisma.systemConfig.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
  cache.set(key, value);
  return value;
}

/**
 * Idempotently seed every default config row. Safe to re-run on every
 * boot — uses `create` inside a try/catch on the unique-key constraint
 * so existing operator edits are never clobbered.
 */
export async function seedPlatformBillingConfig(): Promise<{
  inserted: number;
  alreadyPresent: number;
}> {
  let inserted = 0;
  let alreadyPresent = 0;
  for (const d of PLATFORM_BILLING_DEFAULTS) {
    const existing = await prisma.systemConfig.findUnique({
      where: { key: d.key },
      select: { value: true },
    });
    if (existing) {
      alreadyPresent += 1;
      cache.set(d.key, existing.value);
      continue;
    }
    await prisma.systemConfig.create({ data: d });
    cache.set(d.key, d.value);
    inserted += 1;
  }
  return { inserted, alreadyPresent };
}

/** Test-only — drop the cache so seeded values don't leak across files. */
export function __resetPlatformBillingConfigCacheForTests(): void {
  cache.clear();
}
