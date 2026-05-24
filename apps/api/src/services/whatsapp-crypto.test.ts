// Tests for services/whatsapp-crypto.ts — the AES-256-GCM helper that backs
// the WhatsAppConfig.credentialsEncrypted column (Pearl ERP §6.1 gap row 167).
//
// What's covered
//   1. Real mode (WHATSAPP_CREDS_KEY set, valid 64-char hex):
//        - encrypt → decrypt round-trip returns the original object.
//        - Repeated encrypt of the same plaintext yields different ciphertext
//          (random 12-byte IV per call).
//        - Decryption with a different key throws (AES-GCM auth-tag mismatch).
//        - Decryption of tampered ciphertext throws (auth-tag mismatch on a
//          flipped byte anywhere in iv|tag|ct).
//        - Decryption of a too-short blob throws the explicit length-guard.
//        - UTF-8 round-trip: Devanagari + emoji + zero-width joiners.
//        - Empty-object and very-long-string round-trips.
//   2. Stub mode (WHATSAPP_CREDS_KEY unset, or invalid length, or non-hex):
//        - encrypt produces a `__plaintext: true` envelope JSON.
//        - decrypt unwraps the envelope back to the original object.
//        - decrypt of REAL ciphertext when key is unset throws the explicit
//          "env var is not set, but blob is real ciphertext" error.
//   3. Cross-mode interop edge:
//        - A JSON-shaped string that ISN'T a stub envelope and ISN'T valid
//          base64 ciphertext falls through to the AES path and fails cleanly.
//
// Why this file matters
//   The route layer (apps/api/src/routes/whatsapp-config.ts) trusts the
//   round-trip silently — a regression here means tenants either can't read
//   back their saved WhatsApp creds, or worse, plaintext leaks into prod
//   storage because the stub-mode fallback fires when it shouldn't.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encryptCredentials, decryptCredentials } from "./whatsapp-crypto";

const KEY_ENV = "WHATSAPP_CREDS_KEY";

// Two distinct 64-char hex (32-byte) keys for "right key" vs "wrong key" tests.
const KEY_A =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY_B =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

let originalKey: string | undefined;

beforeEach(() => {
  originalKey = process.env[KEY_ENV];
});

afterEach(() => {
  if (originalKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = originalKey;
});

describe("whatsapp-crypto — real AES-256-GCM mode", () => {
  beforeEach(() => {
    process.env[KEY_ENV] = KEY_A;
  });

  it("encrypts then decrypts a credentials object — round-trip preserves shape", () => {
    const creds = {
      apiKey: "secret-token-12345",
      phoneNumberId: "1234567890",
      businessAccountId: "bid_abcdefg",
    };
    const ct = encryptCredentials(creds);
    expect(typeof ct).toBe("string");
    // Real-mode output is base64, not JSON — should NOT start with '{'.
    expect(ct.startsWith("{")).toBe(false);
    const decoded = decryptCredentials(ct);
    expect(decoded).toEqual(creds);
  });

  it("produces a different ciphertext for the same plaintext on each call (random IV)", () => {
    const creds = { apiKey: "k" };
    const ct1 = encryptCredentials(creds);
    const ct2 = encryptCredentials(creds);
    const ct3 = encryptCredentials(creds);
    expect(ct1).not.toBe(ct2);
    expect(ct2).not.toBe(ct3);
    expect(ct1).not.toBe(ct3);
    // All three must still decrypt to the same object.
    expect(decryptCredentials(ct1)).toEqual(creds);
    expect(decryptCredentials(ct2)).toEqual(creds);
    expect(decryptCredentials(ct3)).toEqual(creds);
  });

  it("decryption with a different key throws (auth-tag mismatch)", () => {
    process.env[KEY_ENV] = KEY_A;
    const ct = encryptCredentials({ apiKey: "secret" });
    process.env[KEY_ENV] = KEY_B;
    expect(() => decryptCredentials(ct)).toThrow();
  });

  it("decryption of tampered ciphertext (last byte flipped) throws", () => {
    const ct = encryptCredentials({ apiKey: "secret-token" });
    const buf = Buffer.from(ct, "base64");
    // Flip the LAST byte (inside the ciphertext region — past iv+tag).
    buf[buf.length - 1] = buf[buf.length - 1] ^ 0xff;
    const tampered = buf.toString("base64");
    expect(() => decryptCredentials(tampered)).toThrow();
  });

  it("decryption of tampered auth tag (middle byte flipped) throws", () => {
    const ct = encryptCredentials({ apiKey: "secret-token" });
    const buf = Buffer.from(ct, "base64");
    // IV is bytes 0-11, tag is bytes 12-27. Flip a byte in the tag.
    buf[15] = buf[15] ^ 0xff;
    const tampered = buf.toString("base64");
    expect(() => decryptCredentials(tampered)).toThrow();
  });

  it("decryption of tampered IV (byte 0 flipped) throws", () => {
    const ct = encryptCredentials({ apiKey: "secret-token" });
    const buf = Buffer.from(ct, "base64");
    buf[0] = buf[0] ^ 0xff;
    const tampered = buf.toString("base64");
    expect(() => decryptCredentials(tampered)).toThrow();
  });

  it("decryption of a too-short blob throws the explicit length guard", () => {
    // 28 bytes = iv(12) + tag(16) + ct(0). The guard requires ct >= 1 byte.
    const tooShort = Buffer.alloc(28).toString("base64");
    expect(() => decryptCredentials(tooShort)).toThrow(/ciphertext too short/);
    // Also an empty string.
    expect(() => decryptCredentials("")).toThrow(/ciphertext too short/);
  });

  it("round-trips an empty object", () => {
    const ct = encryptCredentials({});
    expect(decryptCredentials(ct)).toEqual({});
  });

  it("round-trips a very long string value (~10KB)", () => {
    const long = "x".repeat(10_000);
    const creds = { apiKey: long, extra: "tail" };
    const ct = encryptCredentials(creds);
    const decoded = decryptCredentials(ct);
    expect(decoded).toEqual(creds);
  });

  it("round-trips UTF-8 with non-ASCII (Devanagari + emoji + ZWJ)", () => {
    const creds = {
      name: "नमस्ते दुनिया",
      tagline: "Hello 🌍 world",
      family: "👨‍👩‍👧‍👦", // zero-width-joiner sequence
      arabic: "مرحبا بالعالم",
      chinese: "你好世界",
    };
    const ct = encryptCredentials(creds);
    const decoded = decryptCredentials(ct);
    expect(decoded).toEqual(creds);
  });

  it("round-trips nested objects and arrays", () => {
    const creds = {
      apiKey: "k",
      meta: { version: 1, scopes: ["send", "receive"], nested: { deep: true } },
      list: [1, 2, "three", null, { four: 4 }],
    };
    const ct = encryptCredentials(creds);
    const decoded = decryptCredentials(ct);
    expect(decoded).toEqual(creds);
  });
});

describe("whatsapp-crypto — stub mode (no key)", () => {
  beforeEach(() => {
    delete process.env[KEY_ENV];
  });

  it("encrypt produces a JSON envelope marked __plaintext: true", () => {
    const creds = { apiKey: "dev-only" };
    const out = encryptCredentials(creds);
    // Stub output is JSON starting with '{', not base64.
    expect(out.startsWith("{")).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed.__plaintext).toBe(true);
    expect(parsed.value).toEqual(creds);
  });

  it("decrypt of a stub envelope unwraps back to the original object", () => {
    const creds = { apiKey: "dev-only", extra: 42 };
    const stub = encryptCredentials(creds);
    expect(decryptCredentials(stub)).toEqual(creds);
  });

  it("decrypt of REAL ciphertext when key is unset throws the explicit env-var error", () => {
    // Mint real ciphertext with the key set, then drop the key and try to read.
    process.env[KEY_ENV] = KEY_A;
    const realCt = encryptCredentials({ apiKey: "secret" });
    delete process.env[KEY_ENV];
    expect(() => decryptCredentials(realCt)).toThrow(
      /WHATSAPP_CREDS_KEY is not set, but the stored creds are real ciphertext/,
    );
  });

  it("stub mode preserves UTF-8 inside the envelope", () => {
    const creds = { name: "नमस्ते", emoji: "🌍" };
    const stub = encryptCredentials(creds);
    expect(decryptCredentials(stub)).toEqual(creds);
  });
});

describe("whatsapp-crypto — getKey() env-var validation", () => {
  it("falls back to stub mode when key is the wrong length", () => {
    // Only 30 bytes (60 hex chars) — not 32.
    process.env[KEY_ENV] = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab";
    const out = encryptCredentials({ apiKey: "x" });
    // Stub envelope starts with '{'.
    expect(out.startsWith("{")).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed.__plaintext).toBe(true);
  });

  it("falls back to stub mode when key is non-hex garbage", () => {
    // Buffer.from(str, "hex") doesn't actually throw on garbage — it just
    // silently produces a short / empty buffer that fails the length check.
    // Either way the helper must end up in stub mode rather than crashing.
    process.env[KEY_ENV] = "not-hex-at-all-just-some-prose-totally-bogus-input!!";
    const out = encryptCredentials({ apiKey: "x" });
    expect(out.startsWith("{")).toBe(true);
    const parsed = JSON.parse(out);
    expect(parsed.__plaintext).toBe(true);
  });

  it("accepts uppercase hex keys (Buffer.from('hex') is case-insensitive)", () => {
    process.env[KEY_ENV] = KEY_A.toUpperCase();
    const ct = encryptCredentials({ apiKey: "secret" });
    // Real mode → not a JSON envelope.
    expect(ct.startsWith("{")).toBe(false);
    expect(decryptCredentials(ct)).toEqual({ apiKey: "secret" });
  });
});

describe("whatsapp-crypto — cross-mode interop edges", () => {
  it("JSON-shaped string that ISN'T a stub envelope falls through to AES path", () => {
    process.env[KEY_ENV] = KEY_A;
    // Starts with '{' (so the fast-path JSON.parse runs) but has no
    // __plaintext marker — code falls through to the AES path which then
    // tries to base64-decode the JSON text and fails the length guard or the
    // tag check.
    expect(() => decryptCredentials('{"not_an_envelope":true}')).toThrow();
  });

  it("JSON-shaped string with __plaintext:false also falls through (not stub)", () => {
    process.env[KEY_ENV] = KEY_A;
    expect(() =>
      decryptCredentials('{"__plaintext":false,"value":{"a":1}}'),
    ).toThrow();
  });

  it("malformed JSON starting with { falls through to AES path", () => {
    process.env[KEY_ENV] = KEY_A;
    // The try/catch around JSON.parse swallows the SyntaxError; then the AES
    // path runs and fails (the string isn't valid base64 ciphertext).
    expect(() => decryptCredentials("{not valid json")).toThrow();
  });
});
