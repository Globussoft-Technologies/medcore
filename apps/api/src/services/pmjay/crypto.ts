// PM-JAY client-secret encryption (at rest).
//
// AES-256-GCM, same scheme as the WhatsApp creds helper. Key from
// PMJAY_CREDS_KEY (64-char hex = 32 bytes), falling back to WHATSAPP_CREDS_KEY
// so ops can reuse one tenant-secrets key. When neither is set (dev/CI) the
// value is wrapped as a marked plaintext blob so local dev works without a key
// — production MUST set the key. Output: base64(iv | authTag | ciphertext).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
const PLAINTEXT_PREFIX = "pmjay-plaintext:";

function getKey(): Buffer | null {
  const raw = process.env.PMJAY_CREDS_KEY || process.env.WHATSAPP_CREDS_KEY;
  if (!raw) return null;
  try {
    const buf = Buffer.from(raw, "hex");
    if (buf.length !== 32) {
      console.warn("[pmjay-crypto] creds key must be 64-char hex (32 bytes) — using stub mode.");
      return null;
    }
    return buf;
  } catch {
    console.warn("[pmjay-crypto] creds key is not valid hex — using stub mode.");
    return null;
  }
}

/** Encrypt a client secret. Returns a storable string (never plaintext in prod). */
export function encryptSecret(plain: string): string {
  const key = getKey();
  if (!key) {
    console.warn(
      "[pmjay-crypto] no creds key set — storing PM-JAY client secret AS PLAINTEXT. " +
        "Set PMJAY_CREDS_KEY (64-char hex) before production."
    );
    return PLAINTEXT_PREFIX + Buffer.from(plain, "utf8").toString("base64");
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

/** Decrypt a value written by {@link encryptSecret}. Returns null on failure. */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (stored.startsWith(PLAINTEXT_PREFIX)) {
    try {
      return Buffer.from(stored.slice(PLAINTEXT_PREFIX.length), "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  const key = getKey();
  if (!key) {
    console.warn("[pmjay-crypto] creds key missing but stored secret is ciphertext — cannot decrypt.");
    return null;
  }
  try {
    const buf = Buffer.from(stored, "base64");
    if (buf.length < IV_LEN + AUTH_TAG_LEN + 1) return null;
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
    const ct = buf.subarray(IV_LEN + AUTH_TAG_LEN);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
