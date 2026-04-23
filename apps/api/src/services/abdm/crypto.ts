/**
 * ABDM Health-Information (HI) bundle encryption.
 *
 * The HI-Push spec (ABDM v0.5) requires a Health Information Provider (HIP)
 * to encrypt each FHIR bundle against the Health Information User's (HIU)
 * ephemeral X25519 public key using ECDH + AES-256-GCM. The envelope shape
 * returned by `encryptBundleForHiu` is consumed by the HIU's `dataPushUrl`:
 *
 *   {
 *     encryptedData: <base64 AES-GCM ciphertext || authTag>,
 *     keyMaterial: {
 *       cryptoAlg: "ECDH",
 *       curve:     "Curve25519",
 *       dhPublicKey: { expiry, parameters, keyValue },   // our X25519 pub (base64)
 *       nonce:        <base64 sender-side 32-byte nonce>
 *     }
 *   }
 *
 * Key-derivation procedure (matches ABDM ref implementation):
 *   sharedSecret    = ECDH(ourPriv, hiuPub)                 // 32 bytes
 *   xorSalt         = hiuNonce XOR senderNonce              // 32 bytes
 *   ikm             = sharedSecret XOR xorSalt              // 32 bytes (*)
 *   okm             = HKDF-SHA256(ikm, salt=xorSalt, info="", 44 bytes)
 *   aesKey          = okm[0..32]
 *   iv              = okm[32..44]
 *
 * (*) The XOR with the combined nonces before HKDF matches the reference
 * sample published by ABDM. We pass the same `xorSalt` as HKDF salt so the
 * derivation stays collision-free even if either side reuses a key for
 * testing — production must always rotate the ephemeral keypair per-bundle.
 *
 * Implemented with Node's built-in `crypto` module only (no `jose`, no
 * `tweetnacl`). All binary values are base64 encoded on the wire.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  KeyObject,
  randomBytes,
} from "node:crypto";

// ── Constants ─────────────────────────────────────────────────────────────

/** X25519 public / private raw key length. */
const X25519_KEY_LEN = 32;
/** Per-party nonce length used by the ABDM HI envelope. */
export const ABDM_NONCE_LEN = 32;
/** AES-256 key length. */
const AES_KEY_LEN = 32;
/** AES-GCM IV length. */
const AES_IV_LEN = 12;
/** Total HKDF output length (aesKey || iv). */
const HKDF_LEN = AES_KEY_LEN + AES_IV_LEN;

// ── Errors ────────────────────────────────────────────────────────────────

/** Thrown on any crypto envelope failure (wrong lengths, bad peer key, etc). */
export class ABDMCryptoError extends Error {
  constructor(message: string) {
    super(`ABDM crypto error: ${message}`);
    this.name = "ABDMCryptoError";
  }
}

// ── Keypair generation ────────────────────────────────────────────────────

export interface X25519KeyPair {
  /** KeyObject wrapping the X25519 private key. */
  privateKey: KeyObject;
  /** KeyObject wrapping the matching X25519 public key. */
  publicKey: KeyObject;
  /** Base64-encoded raw 32-byte public key suitable for ABDM `keyValue`. */
  publicKeyBase64: string;
}

/**
 * Generate a fresh X25519 keypair. The raw 32-byte public key is returned
 * base64-encoded for direct placement into the HI envelope's `keyValue`.
 */
export function generateEphemeralKeyPair(): X25519KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  // Raw 32-byte public key lives at the end of the SPKI DER encoding.
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const raw = spki.subarray(spki.length - X25519_KEY_LEN);
  return {
    privateKey,
    publicKey,
    publicKeyBase64: raw.toString("base64"),
  };
}

/**
 * Turn a base64-encoded 32-byte raw X25519 public key into a Node KeyObject.
 * Accepts either raw-base64 or full SPKI-PEM so this helper can be used for
 * both the HIU side (raw key in JSON) and PEM material in tests.
 */
export function importX25519PublicKey(input: string): KeyObject {
  // PEM?
  if (input.includes("-----BEGIN")) {
    return createPublicKey({ key: input, format: "pem" });
  }
  const raw = Buffer.from(input, "base64");
  if (raw.length !== X25519_KEY_LEN) {
    throw new ABDMCryptoError(
      `X25519 public key must be ${X25519_KEY_LEN} bytes, got ${raw.length}`
    );
  }
  // Wrap raw 32-byte key in an SPKI DER so KeyObject will accept it.
  // SPKI prefix for X25519: 302a300506032b656e032100
  const spkiPrefix = Buffer.from("302a300506032b656e032100", "hex");
  const der = Buffer.concat([spkiPrefix, raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/** Inverse of `importX25519PublicKey` — for tests. */
export function exportX25519PublicKeyBase64(key: KeyObject): string {
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  return spki.subarray(spki.length - X25519_KEY_LEN).toString("base64");
}

// ── ECDH ──────────────────────────────────────────────────────────────────

/**
 * Compute the X25519 shared secret. Both arguments must be `KeyObject`s of
 * the correct type; raw keys must first pass through `importX25519PublicKey`.
 */
export function deriveSharedSecret(
  privateKey: KeyObject,
  peerPublicKey: KeyObject
): Buffer {
  const secret = diffieHellman({ privateKey, publicKey: peerPublicKey });
  if (secret.length !== X25519_KEY_LEN) {
    throw new ABDMCryptoError(
      `expected ${X25519_KEY_LEN}-byte shared secret, got ${secret.length}`
    );
  }
  return secret;
}

// ── HKDF-SHA256 ───────────────────────────────────────────────────────────

/**
 * HKDF-SHA256 Expand-and-Extract as used by ABDM HI-Push. Returns a raw
 * buffer of `length` bytes.
 */
export function hkdfExpand(
  ikm: Buffer,
  salt: Buffer,
  info: Buffer | string,
  length: number
): Buffer {
  const infoBuf = typeof info === "string" ? Buffer.from(info, "utf8") : info;
  const out = hkdfSync("sha256", ikm, salt, infoBuf, length);
  return Buffer.from(out);
}

// ── AES-256-GCM ───────────────────────────────────────────────────────────

export interface AesGcmCiphertext {
  /** Raw ciphertext (without authTag). */
  ciphertext: Buffer;
  /** 16-byte GCM authentication tag. */
  authTag: Buffer;
}

/**
 * AES-256-GCM encrypt. `key` must be 32 bytes, `iv` must be 12 bytes.
 */
export function encryptAesGcm(
  plaintext: Buffer,
  key: Buffer,
  iv: Buffer
): AesGcmCiphertext {
  if (key.length !== AES_KEY_LEN) {
    throw new ABDMCryptoError(`AES key must be ${AES_KEY_LEN} bytes`);
  }
  if (iv.length !== AES_IV_LEN) {
    throw new ABDMCryptoError(`AES-GCM IV must be ${AES_IV_LEN} bytes`);
  }
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext, authTag };
}

/**
 * AES-256-GCM decrypt. Throws if `authTag` does not validate.
 */
export function decryptAesGcm(
  ciphertext: Buffer,
  authTag: Buffer,
  key: Buffer,
  iv: Buffer
): Buffer {
  if (key.length !== AES_KEY_LEN) {
    throw new ABDMCryptoError(`AES key must be ${AES_KEY_LEN} bytes`);
  }
  if (iv.length !== AES_IV_LEN) {
    throw new ABDMCryptoError(`AES-GCM IV must be ${AES_IV_LEN} bytes`);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ── XOR helper ────────────────────────────────────────────────────────────

function xorBuffers(a: Buffer, b: Buffer): Buffer {
  if (a.length !== b.length) {
    throw new ABDMCryptoError(
      `XOR operands have mismatched length: ${a.length} vs ${b.length}`
    );
  }
  const out = Buffer.allocUnsafe(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i]! ^ b[i]!;
  }
  return out;
}

// ── ABDM HI envelope ──────────────────────────────────────────────────────

export interface AbdmKeyMaterial {
  cryptoAlg: "ECDH";
  curve: "Curve25519";
  dhPublicKey: {
    /** ISO-8601 expiry of the ephemeral key (default: +60 min). */
    expiry: string;
    parameters: string;
    /** Base64 raw 32-byte X25519 public key. */
    keyValue: string;
  };
  /** Base64 sender-side nonce (32 bytes). */
  nonce: string;
}

export interface AbdmEncryptedEnvelope {
  /** Base64 of (ciphertext || authTag). */
  encryptedData: string;
  keyMaterial: AbdmKeyMaterial;
}

export interface EncryptBundleArgs {
  /** The JSON bundle (serialised first as UTF-8) OR raw buffer. */
  bundle: unknown;
  /** HIU's ephemeral X25519 public key — base64 raw or SPKI-PEM. */
  hiuPublicKey: string;
  /** HIU-supplied nonce, base64, 32 bytes. */
  hiuNonce: string;
  /**
   * Optional sender nonce (base64, 32 bytes). If omitted a fresh random
   * nonce is generated. Tests pin this for determinism.
   */
  senderNonce?: string;
  /**
   * Optional sender keypair. If omitted a fresh ephemeral keypair is
   * generated (recommended in production — one keypair per bundle).
   */
  senderKeyPair?: X25519KeyPair;
  /** Optional expiry override; defaults to now + 60 min. */
  expiryISO?: string;
}

/**
 * Build the full ABDM HI-Push envelope for a single FHIR bundle. Returns
 * the object that should be placed under the push payload's `keyMaterial`
 * alongside `content = encryptedData`.
 */
export function encryptBundleForHiu(
  args: EncryptBundleArgs
): AbdmEncryptedEnvelope {
  // ── 1. Sender keypair + nonces ──────────────────────────────────────────
  const senderKeyPair = args.senderKeyPair ?? generateEphemeralKeyPair();

  const senderNonceBuf = args.senderNonce
    ? Buffer.from(args.senderNonce, "base64")
    : randomBytes(ABDM_NONCE_LEN);
  if (senderNonceBuf.length !== ABDM_NONCE_LEN) {
    throw new ABDMCryptoError(
      `senderNonce must be ${ABDM_NONCE_LEN} bytes, got ${senderNonceBuf.length}`
    );
  }

  const hiuNonceBuf = Buffer.from(args.hiuNonce, "base64");
  if (hiuNonceBuf.length !== ABDM_NONCE_LEN) {
    throw new ABDMCryptoError(
      `hiuNonce must be ${ABDM_NONCE_LEN} bytes, got ${hiuNonceBuf.length}`
    );
  }

  // ── 2. ECDH + HKDF → AES key + IV ───────────────────────────────────────
  const hiuPublic = importX25519PublicKey(args.hiuPublicKey);
  const shared = deriveSharedSecret(senderKeyPair.privateKey, hiuPublic);

  const xorSalt = xorBuffers(hiuNonceBuf, senderNonceBuf);
  const ikm = xorBuffers(shared, xorSalt);

  const okm = hkdfExpand(ikm, xorSalt, "", HKDF_LEN);
  const aesKey = okm.subarray(0, AES_KEY_LEN);
  const iv = okm.subarray(AES_KEY_LEN, AES_KEY_LEN + AES_IV_LEN);

  // ── 3. AES-GCM encrypt ──────────────────────────────────────────────────
  const plaintext =
    args.bundle instanceof Buffer
      ? args.bundle
      : Buffer.from(JSON.stringify(args.bundle), "utf8");
  const { ciphertext, authTag } = encryptAesGcm(plaintext, aesKey, iv);

  // Per GCM convention on the wire: ciphertext || authTag.
  const wire = Buffer.concat([ciphertext, authTag]);

  return {
    encryptedData: wire.toString("base64"),
    keyMaterial: {
      cryptoAlg: "ECDH",
      curve: "Curve25519",
      dhPublicKey: {
        expiry: args.expiryISO ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        parameters: "Curve25519/32byte random key",
        keyValue: senderKeyPair.publicKeyBase64,
      },
      nonce: senderNonceBuf.toString("base64"),
    },
  };
}

/**
 * Inverse of `encryptBundleForHiu` — used only by tests / the HIU side to
 * prove round-trip correctness. Splits `ciphertext || authTag`, runs ECDH
 * on the recipient's private key + sender public key, reruns HKDF, and
 * decrypts.
 */
export function decryptBundleFromHip(args: {
  envelope: AbdmEncryptedEnvelope;
  recipientPrivateKey: KeyObject;
  recipientNonce: string; // base64, 32 bytes
}): Buffer {
  const senderPublic = importX25519PublicKey(args.envelope.keyMaterial.dhPublicKey.keyValue);
  const shared = deriveSharedSecret(args.recipientPrivateKey, senderPublic);

  const recipientNonceBuf = Buffer.from(args.recipientNonce, "base64");
  const senderNonceBuf = Buffer.from(args.envelope.keyMaterial.nonce, "base64");
  const xorSalt = xorBuffers(recipientNonceBuf, senderNonceBuf);
  const ikm = xorBuffers(shared, xorSalt);

  const okm = hkdfExpand(ikm, xorSalt, "", HKDF_LEN);
  const aesKey = okm.subarray(0, AES_KEY_LEN);
  const iv = okm.subarray(AES_KEY_LEN, AES_KEY_LEN + AES_IV_LEN);

  const wire = Buffer.from(args.envelope.encryptedData, "base64");
  const authTag = wire.subarray(wire.length - 16);
  const ciphertext = wire.subarray(0, wire.length - 16);

  return decryptAesGcm(ciphertext, authTag, aesKey, iv);
}

// ── Misc exports for test use ─────────────────────────────────────────────

/** Test helper: generate a base64 32-byte nonce. */
export function generateNonceBase64(): string {
  return randomBytes(ABDM_NONCE_LEN).toString("base64");
}

/** Test helper: export an X25519 private key as PEM (for fixture storage). */
export function exportPrivateKeyPem(key: KeyObject): string {
  return key.export({ type: "pkcs8", format: "pem" }) as string;
}

/** Test helper: import an X25519 private key from PEM. */
export function importPrivateKeyPem(pem: string): KeyObject {
  return createPrivateKey({ key: pem, format: "pem" });
}
