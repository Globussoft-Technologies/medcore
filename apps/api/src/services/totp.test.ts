import { describe, it, expect, vi, afterEach } from "vitest";
import crypto from "crypto";
import {
  base32Encode,
  base32Decode,
  generateSecret,
  generateTOTP,
  verifyTOTP,
  generateBackupCodes,
  buildOtpAuthUri,
} from "./totp";

describe("base32 encode / decode", () => {
  it("round-trips arbitrary bytes", () => {
    const raw = Buffer.from("Hello, MedCore!", "utf8");
    const enc = base32Encode(raw);
    expect(enc).toMatch(/^[A-Z2-7]+$/);
    expect(base32Decode(enc).toString("utf8")).toBe("Hello, MedCore!");
  });

  it("matches RFC 4648 test vector for 'foobar'", () => {
    // Base32 of "foobar" = MZXW6YTBOI
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI").toString("utf8")).toBe("foobar");
  });
});

describe("generateSecret", () => {
  it("returns a 32-character base32 string (160-bit)", () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
  });
});

describe("generateTOTP / verifyTOTP", () => {
  const SECRET = generateSecret();

  afterEach(() => {
    vi.useRealTimers();
  });

  it("verifyTOTP accepts the code for the current 30-second window", () => {
    const code = generateTOTP(SECRET, 0);
    expect(verifyTOTP(SECRET, code)).toBe(true);
  });

  it("verifyTOTP accepts codes ±1 time-step", () => {
    const prev = generateTOTP(SECRET, -1);
    const next = generateTOTP(SECRET, 1);
    expect(verifyTOTP(SECRET, prev)).toBe(true);
    expect(verifyTOTP(SECRET, next)).toBe(true);
  });

  it("verifyTOTP rejects codes outside ±1 window", () => {
    const tooOld = generateTOTP(SECRET, -5);
    expect(verifyTOTP(SECRET, tooOld)).toBe(false);
  });

  it("verifyTOTP rejects empty / malformed tokens", () => {
    expect(verifyTOTP(SECRET, "")).toBe(false);
    expect(verifyTOTP(SECRET, "abcdef")).toBe(false);
    expect(verifyTOTP(SECRET, "12345")).toBe(false);
    expect(verifyTOTP(SECRET, "1234567")).toBe(false);
  });

  it("generateTOTP returns a 6-digit numeric code", () => {
    const code = generateTOTP(SECRET);
    expect(code).toMatch(/^\d{6}$/);
  });

  it("generateTOTP matches the RFC 6238 reference (59s, 20-byte ASCII seed)", () => {
    const seed = Buffer.from("12345678901234567890", "ascii");
    const secret = base32Encode(seed);
    // Fake Date.now = 59000 (ms) → counter = 1
    const origNow = Date.now;
    (Date as any).now = () => 59_000;
    try {
      const code = generateTOTP(secret, 0);
      // RFC 6238 Appendix B test vector for T=59s (counter=1) is 94287082 → last 6 digits "287082"
      expect(code).toBe("287082");
    } finally {
      (Date as any).now = origNow;
    }
  });
});

describe("generateBackupCodes", () => {
  it("generates N codes by default", () => {
    const codes = generateBackupCodes();
    expect(codes.length).toBe(10);
  });

  it("each code is formatted XXXXX-XXXXX", () => {
    const codes = generateBackupCodes(3);
    for (const c of codes) {
      expect(c).toMatch(/^[A-F0-9]{5}-[A-F0-9]{5}$/);
    }
  });

  it("codes are unique within a batch", () => {
    const codes = generateBackupCodes(20);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("buildOtpAuthUri", () => {
  it("encodes issuer and email into an otpauth URI", () => {
    const uri = buildOtpAuthUri("alice@example.com", "ABCDEF234567", "Clinic");
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain("Clinic");
    expect(uri).toContain(encodeURIComponent("alice@example.com"));
    expect(uri).toContain("secret=ABCDEF234567");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });

  it("defaults issuer to MedCore", () => {
    const uri = buildOtpAuthUri("u@x.io", "ABCDEF234567");
    expect(uri).toContain("MedCore");
  });
});

describe("HMAC-based code matches manual reference", () => {
  it("produces the same code as an inline HOTP implementation", () => {
    const secret = generateSecret();
    const counter = Math.floor(Date.now() / 30000);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const key = base32Decode(secret);
    const hmac = crypto.createHmac("sha1", key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const bin =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);
    const expected = String(bin % 1_000_000).padStart(6, "0");
    expect(generateTOTP(secret)).toBe(expected);
  });
});
