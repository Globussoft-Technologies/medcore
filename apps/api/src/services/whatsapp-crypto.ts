// Pearl ERP Stage 1 §6.1 (gap row 167 — piece 3j-i of 4).
// Tiny symmetric-encryption helper for per-tenant WhatsApp creds at rest.
//
// What / which modules / why:
//   - Backs the WhatsAppConfig.credentialsEncrypted column. The route
//     layer (apps/api/src/routes/whatsapp-config.ts) wraps Zod-validated
//     creds through encrypt() before persist and through decrypt() on
//     read.
//   - WHATSAPP_CREDS_KEY env var = 32-byte AES-256 key as a 64-char hex
//     string. When unset (dev / CI), we fall back to a marked plaintext
//     blob so local development doesn't require a key — the marker
//     `__plaintext: true` lets every consumer scream loudly in logs but
//     keeps the surface usable. Production deployments MUST set the env.
//   - Output format: base64(iv | authTag | ciphertext). 12-byte IV per
//     NIST SP 800-38D for AES-GCM. 16-byte auth tag.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const KEY_ENV = "WHATSAPP_CREDS_KEY";
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;

function getKey(): Buffer | null {
  const raw = process.env[KEY_ENV];
  if (!raw) return null;
  try {
    const buf = Buffer.from(raw, "hex");
    if (buf.length !== 32) {
      console.warn(
        `[whatsapp-crypto] ${KEY_ENV} must be a 64-char hex (32-byte) key — falling back to stub mode.`,
      );
      return null;
    }
    return buf;
  } catch {
    console.warn(
      `[whatsapp-crypto] ${KEY_ENV} is not valid hex — falling back to stub mode.`,
    );
    return null;
  }
}

/**
 * Encrypts the credentials object as a JSON string.
 *
 * Real mode: AES-256-GCM with WHATSAPP_CREDS_KEY → base64(iv|tag|ciphertext).
 * Stub mode: wraps the object with `__plaintext: true` and stringifies it
 *            (dev / CI fallback). Always logs a warn so the operator knows.
 */
export function encryptCredentials(creds: Record<string, unknown>): string {
  const key = getKey();
  const json = JSON.stringify(creds);
  if (!key) {
    console.warn(
      "[whatsapp-crypto] WHATSAPP_CREDS_KEY unset — storing creds AS PLAINTEXT. " +
        "Set WHATSAPP_CREDS_KEY (64-char hex) before production deploy.",
    );
    return JSON.stringify({ __plaintext: true, value: creds });
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

/**
 * Decrypts a value previously written by encryptCredentials. Returns the
 * original JSON object. Stub-mode blobs (with `__plaintext: true`) are
 * transparently unwrapped.
 *
 * Throws on truncated input, tag-mismatch (i.e. someone tampered with the
 * stored value), or missing key when the blob is real ciphertext.
 */
export function decryptCredentials(stored: string): Record<string, unknown> {
  // Stub-mode fast path — the value is JSON, not base64.
  if (stored.startsWith("{")) {
    try {
      const parsed = JSON.parse(stored) as Record<string, unknown>;
      if (parsed && (parsed as { __plaintext?: boolean }).__plaintext === true) {
        return (parsed as { value: Record<string, unknown> }).value;
      }
    } catch {
      // fall through to the AES path
    }
  }
  const key = getKey();
  if (!key) {
    throw new Error(
      `[whatsapp-crypto] ${KEY_ENV} is not set, but the stored creds are real ciphertext. ` +
        `Restore the env var or re-save the config to recover.`,
    );
  }
  const buf = Buffer.from(stored, "base64");
  if (buf.length < IV_LEN + AUTH_TAG_LEN + 1) {
    throw new Error("[whatsapp-crypto] ciphertext too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
  const ct = buf.subarray(IV_LEN + AUTH_TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  return JSON.parse(pt) as Record<string, unknown>;
}

// ── Multi-provider credential vault ─────────────────────────────────────────
// A tenant can save creds for SEVERAL WhatsApp providers and mark ONE active
// (WhatsAppConfig.provider). To avoid a schema migration we keep storing a
// single encrypted blob, but its shape is now a per-provider map:
//   { byProvider: { META: {...}, GUPSHUP: {...} } }
// Legacy rows hold a FLAT object (just the one provider's creds). The helpers
// below read/write both shapes so nothing that decrypts existing rows breaks.

/** A decrypted blob is the new multi shape when it has a `byProvider` object. */
export function isMultiProviderBlob(
  decrypted: Record<string, unknown> | null | undefined,
): boolean {
  return (
    !!decrypted &&
    typeof (decrypted as { byProvider?: unknown }).byProvider === "object" &&
    (decrypted as { byProvider?: unknown }).byProvider !== null
  );
}

/** Return every provider's creds as a map, normalising the legacy flat shape
 *  (which belongs to `activeProvider`) into a one-entry map. */
export function credentialsMap(
  decrypted: Record<string, unknown> | null | undefined,
  activeProvider: string,
): Record<string, Record<string, unknown>> {
  if (!decrypted) return {};
  if (isMultiProviderBlob(decrypted)) {
    return (decrypted as { byProvider: Record<string, Record<string, unknown>> })
      .byProvider;
  }
  // Legacy flat blob → the whole object is the active provider's creds.
  return { [activeProvider]: decrypted };
}

/** The flat creds for the ACTIVE provider — what senders/receivers consume.
 *  Handles both the multi map and the legacy flat blob. */
export function resolveActiveCredentials(
  decrypted: Record<string, unknown> | null | undefined,
  activeProvider: string,
): Record<string, unknown> | null {
  if (!decrypted) return null;
  if (isMultiProviderBlob(decrypted)) {
    const map = (decrypted as {
      byProvider: Record<string, Record<string, unknown>>;
    }).byProvider;
    return map[activeProvider] ?? null;
  }
  return decrypted; // legacy flat → already the active provider's creds
}
