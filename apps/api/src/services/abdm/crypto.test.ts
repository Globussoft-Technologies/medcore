import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  ABDM_NONCE_LEN,
  ABDMCryptoError,
  decryptAesGcm,
  decryptBundleFromHip,
  deriveSharedSecret,
  encryptAesGcm,
  encryptBundleForHiu,
  exportX25519PublicKeyBase64,
  generateEphemeralKeyPair,
  generateNonceBase64,
  hkdfExpand,
  importX25519PublicKey,
} from "./crypto";

describe("generateEphemeralKeyPair", () => {
  it("produces a round-trippable X25519 keypair with a 32-byte base64 public key", () => {
    const kp = generateEphemeralKeyPair();
    expect(kp.privateKey.asymmetricKeyType).toBe("x25519");
    expect(kp.publicKey.asymmetricKeyType).toBe("x25519");
    const raw = Buffer.from(kp.publicKeyBase64, "base64");
    expect(raw.length).toBe(32);
    // Re-importing the base64 pub key should give an equivalent KeyObject.
    const reimported = importX25519PublicKey(kp.publicKeyBase64);
    expect(exportX25519PublicKeyBase64(reimported)).toBe(kp.publicKeyBase64);
  });
});

describe("deriveSharedSecret (ECDH)", () => {
  it("produces the same 32-byte secret on both sides", () => {
    const alice = generateEphemeralKeyPair();
    const bob = generateEphemeralKeyPair();
    const aSecret = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const bSecret = deriveSharedSecret(bob.privateKey, alice.publicKey);
    expect(aSecret.length).toBe(32);
    expect(aSecret.equals(bSecret)).toBe(true);
  });

  it("produces different secrets when one party is different", () => {
    const alice = generateEphemeralKeyPair();
    const bob = generateEphemeralKeyPair();
    const eve = generateEphemeralKeyPair();
    const sharedAB = deriveSharedSecret(alice.privateKey, bob.publicKey);
    const sharedAE = deriveSharedSecret(alice.privateKey, eve.publicKey);
    expect(sharedAB.equals(sharedAE)).toBe(false);
  });
});

describe("hkdfExpand", () => {
  it("is deterministic for identical inputs", () => {
    const ikm = Buffer.from("ikm-fixed-1234567890123456789012", "utf8");
    const salt = Buffer.from("salt-fixed-12345678901234567890", "utf8");
    const a = hkdfExpand(ikm, salt, "info", 44);
    const b = hkdfExpand(ikm, salt, "info", 44);
    expect(a.length).toBe(44);
    expect(a.equals(b)).toBe(true);
  });

  it("produces different output when salt changes", () => {
    const ikm = Buffer.from("k".repeat(32), "utf8");
    const a = hkdfExpand(ikm, Buffer.from("A".repeat(32)), "", 32);
    const b = hkdfExpand(ikm, Buffer.from("B".repeat(32)), "", 32);
    expect(a.equals(b)).toBe(false);
  });
});

describe("AES-256-GCM encrypt/decrypt", () => {
  it("round-trips plaintext", () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const plaintext = Buffer.from("the quick brown fox jumps over the lazy dog");
    const { ciphertext, authTag } = encryptAesGcm(plaintext, key, iv);
    const decrypted = decryptAesGcm(ciphertext, authTag, key, iv);
    expect(decrypted.equals(plaintext)).toBe(true);
    expect(authTag.length).toBe(16);
  });

  it("throws when the authTag is wrong", () => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const plaintext = Buffer.from("secret payload");
    const { ciphertext, authTag } = encryptAesGcm(plaintext, key, iv);
    const tampered = Buffer.from(authTag);
    tampered[0] = tampered[0]! ^ 0xff;
    expect(() => decryptAesGcm(ciphertext, tampered, key, iv)).toThrow();
  });

  it("rejects wrong key length", () => {
    expect(() =>
      encryptAesGcm(Buffer.from("x"), randomBytes(16), randomBytes(12))
    ).toThrowError(ABDMCryptoError);
  });

  it("rejects wrong IV length", () => {
    expect(() =>
      encryptAesGcm(Buffer.from("x"), randomBytes(32), randomBytes(16))
    ).toThrowError(ABDMCryptoError);
  });
});

describe("encryptBundleForHiu", () => {
  it("produces an envelope with the expected ABDM shape", () => {
    const hiu = generateEphemeralKeyPair();
    const hiuNonce = generateNonceBase64();
    const bundle = { resourceType: "Bundle", id: "b1", entries: [] };

    const envelope = encryptBundleForHiu({
      bundle,
      hiuPublicKey: hiu.publicKeyBase64,
      hiuNonce,
    });

    expect(envelope).toHaveProperty("encryptedData");
    expect(typeof envelope.encryptedData).toBe("string");
    expect(envelope.keyMaterial.cryptoAlg).toBe("ECDH");
    expect(envelope.keyMaterial.curve).toBe("Curve25519");
    expect(envelope.keyMaterial.dhPublicKey.parameters).toContain("Curve25519");
    expect(Buffer.from(envelope.keyMaterial.dhPublicKey.keyValue, "base64").length).toBe(32);
    expect(Buffer.from(envelope.keyMaterial.nonce, "base64").length).toBe(ABDM_NONCE_LEN);
    // expiry must be a parseable ISO date in the future.
    expect(Date.parse(envelope.keyMaterial.dhPublicKey.expiry)).toBeGreaterThan(Date.now());
  });

  it("round-trips via decryptBundleFromHip using the recipient's private key", () => {
    const hiu = generateEphemeralKeyPair();
    const hiuNonce = generateNonceBase64();
    const bundle = {
      resourceType: "Bundle",
      id: "round-trip",
      entries: [{ fullUrl: "urn:uuid:x", resource: { resourceType: "Patient" } }],
    };

    const envelope = encryptBundleForHiu({
      bundle,
      hiuPublicKey: hiu.publicKeyBase64,
      hiuNonce,
    });

    const decrypted = decryptBundleFromHip({
      envelope,
      recipientPrivateKey: hiu.privateKey,
      recipientNonce: hiuNonce,
    });
    const parsed = JSON.parse(decrypted.toString("utf8"));
    expect(parsed).toEqual(bundle);
  });

  it("rejects HIU nonce with wrong length", () => {
    const hiu = generateEphemeralKeyPair();
    const badNonce = Buffer.alloc(16).toString("base64");
    expect(() =>
      encryptBundleForHiu({
        bundle: { a: 1 },
        hiuPublicKey: hiu.publicKeyBase64,
        hiuNonce: badNonce,
      })
    ).toThrowError(ABDMCryptoError);
  });

  it("rejects HIU public key with wrong length", () => {
    const shortKey = Buffer.alloc(16).toString("base64");
    expect(() =>
      encryptBundleForHiu({
        bundle: { a: 1 },
        hiuPublicKey: shortKey,
        hiuNonce: generateNonceBase64(),
      })
    ).toThrowError(ABDMCryptoError);
  });

  it("fails to decrypt when recipient uses the wrong nonce", () => {
    const hiu = generateEphemeralKeyPair();
    const hiuNonce = generateNonceBase64();
    const envelope = encryptBundleForHiu({
      bundle: { secret: "payload" },
      hiuPublicKey: hiu.publicKeyBase64,
      hiuNonce,
    });
    expect(() =>
      decryptBundleFromHip({
        envelope,
        recipientPrivateKey: hiu.privateKey,
        recipientNonce: generateNonceBase64(), // wrong nonce
      })
    ).toThrow();
  });
});
