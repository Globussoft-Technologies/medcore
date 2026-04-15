import crypto from "crypto";

// ─── RFC 4648 base32 ───────────────────────────────────
const B32_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHA[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32_ALPHA[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

export function base32Decode(str: string): Buffer {
  const clean = str.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = B32_ALPHA.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ─── TOTP (RFC 6238 / HOTP RFC 4226) ───────────────────

export function generateSecret(): string {
  // 20 bytes = 160 bits -> 32 base32 chars
  return base32Encode(crypto.randomBytes(20));
}

export function generateTOTP(secret: string, window = 0): string {
  const counter = Math.floor(Date.now() / 30000) + window;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const key = base32Decode(secret);
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, "0");
}

export function verifyTOTP(secret: string, token: string): boolean {
  if (!token || !/^\d{6}$/.test(token)) return false;
  for (const w of [-1, 0, 1]) {
    if (generateTOTP(secret, w) === token) return true;
  }
  return false;
}

export function buildOtpAuthUri(
  email: string,
  secret: string,
  issuer = "MedCore"
): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function generateBackupCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    // 10-character alphanumeric, formatted XXXXX-XXXXX
    const raw = crypto.randomBytes(6).toString("hex").toUpperCase().slice(0, 10);
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}
