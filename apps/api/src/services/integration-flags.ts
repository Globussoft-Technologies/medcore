/**
 * Per-tenant integration on/off flags.
 *
 * What / which modules / why:
 *   - The Settings → Integrations tab (apps/web/.../settings/page.tsx) lets a
 *     tenant admin toggle third-party connectors (sendgrid / twilio / razorpay
 *     / abdm / fhir / hl7v2 / sentry). Toggles persist to SystemConfig under
 *     `tenant:<id>:integration_<key>_enabled` via routes/settings.ts.
 *   - Until now that flag was cosmetic — nothing read it at runtime. This
 *     module is the single source of truth every enforcement point calls so a
 *     disabled connector actually stops working for that tenant.
 *
 * Semantics (deliberate):
 *   - DEFAULT ON: a connector is enabled UNLESS the flag is explicitly "false".
 *     A tenant that never touched the toggle keeps its existing behaviour, so
 *     turning enforcement on can't silently break live hospitals.
 *   - FAIL OPEN: if the flag lookup errors (DB blip), treat the connector as
 *     enabled. A transient infra fault must never silently mute payments /
 *     notifications — an explicit admin "off" is the only thing that disables.
 *   - No tenant context (tenantId null/undefined) → enabled. Platform/system
 *     paths aren't scoped to a tenant's toggle.
 */

import { prisma } from "@medcore/db";
import { tenantConfigKey } from "./tenant-provisioning";

/** Canonical integration keys mirrored from routes/settings.ts KNOWN_INTEGRATIONS. */
export type IntegrationKey =
  | "sendgrid"
  | "twilio"
  | "razorpay"
  | "abdm"
  | "fhir"
  | "hl7v2"
  | "sentry";

/**
 * Is `key` enabled for `tenantId`? Default-on, fail-open (see module docstring).
 */
export async function isIntegrationEnabled(
  tenantId: string | null | undefined,
  key: IntegrationKey,
): Promise<boolean> {
  if (!tenantId) return true;
  try {
    const row = await prisma.systemConfig.findUnique({
      where: { key: tenantConfigKey(tenantId, `integration_${key}_enabled`) },
    });
    return row?.value !== "false";
  } catch (err) {
    console.warn(
      `[integration-flags] lookup failed for tenant=${tenantId} key=${key} — failing open (enabled):`,
      (err as Error)?.message ?? err,
    );
    return true;
  }
}
