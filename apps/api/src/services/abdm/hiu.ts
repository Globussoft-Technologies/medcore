/**
 * ABDM HIU (Health Information User) — fetch records from other providers.
 *
 * Complements the HIP push side in `health-records.ts`. As an HIU, MedCore:
 *
 *   1. requestDataTransfer(consentId)
 *      — for a GRANTED ConsentArtefact, generate an ephemeral X25519 keypair
 *        + 32-byte nonce, persist them (PEM) on an AbdmTransaction row keyed
 *        by transactionId, and POST
 *        /api/hiecm/data-flow/v3/health-information/request (v3) to the
 *        gateway. The remote HIP later pushes the encrypted bundle to our
 *        data-push callback.
 *
 *   2. receiveHealthInformation(payload)
 *      — our data-push endpoint (POST /abdm/hiu/data-push): look up the
 *        transfer session by transactionId, decrypt each entry with the
 *        stored private key + nonce (X25519 ECDH → HKDF → AES-256-GCM), and
 *        store each decrypted FHIR bundle as a MedicalRecord (HIU_EXTERNAL).
 *
 * Sandbox note: the gateway HI-request is real; if the sandbox does not push
 * back (no real remote HIP), the consent simply stays "fetch requested" and
 * MedicalRecord rows appear once a push arrives. The decrypt path is fully
 * implemented and unit-tested against the crypto round-trip.
 */

import { prisma } from "@medcore/db";
import { abdmRequest, ABDMError } from "./client";
import {
  generateEphemeralKeyPair,
  generateNonceBase64,
  exportX25519PublicKeyBase64,
  exportPrivateKeyPem,
  importPrivateKeyPem,
  decryptBundleFromHip,
  type AbdmEncryptedEnvelope,
} from "./crypto";

export interface RequestDataTransferResult {
  transactionId: string;
  requestId: string;
}

/**
 * Request a data-transfer for a GRANTED consent. Returns the transactionId the
 * remote HIP will quote when it pushes the encrypted bundle back to us.
 */
export async function requestDataTransfer(
  consentId: string,
): Promise<RequestDataTransferResult> {
  const consent = await prisma.consentArtefact.findUnique({
    where: { id: consentId },
  });
  if (!consent) {
    throw new ABDMError("Consent not found", 404);
  }
  if (consent.status !== "GRANTED") {
    throw new ABDMError(
      `Consent must be GRANTED to fetch records (current: ${consent.status})`,
      409,
    );
  }

  // Ephemeral key material for THIS transfer. The HIP will ECDH against our
  // public key + nonce; we keep the private key to decrypt the push-back.
  const keyPair = generateEphemeralKeyPair();
  const nonce = generateNonceBase64();
  const transactionId = cryptoRandomId();
  const requestId = cryptoRandomId();

  // The consent artefact carries the granted consent's id we send upstream.
  const artefact = (consent.artefact ?? {}) as Record<string, unknown>;
  const consentArtefactId =
    (artefact.consentId as string | undefined) ?? consentId;

  // Persist the transfer session BEFORE the gateway call so a fast push-back
  // can always resolve its keypair. PEM-encode the private key (never logged).
  await prisma.abdmTransaction.create({
    data: {
      type: "HIU_REQUEST",
      status: "PENDING",
      requestId: transactionId,
      refId: consentId,
      patientId: consent.patientId,
      tenantId: consent.tenantId,
      summary: `HIU data-transfer requested for consent ${consentId}`,
      detail: {
        transactionId,
        consentId,
        privateKeyPem: exportPrivateKeyPem(keyPair.privateKey),
        nonce,
        publicKey: keyPair.publicKeyBase64,
      },
    },
  });

  // v3 data-flow HI request (was /v0.5/health-information/cm/request). Body is
  // just `hiRequest`; REQUEST-ID/TIMESTAMP go as headers, and the v3 endpoint
  // requires X-HIU-ID. Sandbox-tolerant: a non-2xx upstream is surfaced but the
  // session row already exists for retry/debug.
  await abdmRequest({
    method: "POST",
    path: "/data-flow/v3/health-information/request",
    requestId,
    headers: { "X-HIU-ID": consent.hiuId },
    body: {
      hiRequest: {
        consent: { id: consentArtefactId },
        dateRange: {
          from: consent.createdAt.toISOString(),
          to: consent.expiresAt.toISOString(),
        },
        dataPushUrl: dataPushCallbackUrl(),
        keyMaterial: {
          cryptoAlg: "ECDH",
          curve: "Curve25519",
          dhPublicKey: {
            expiry: consent.expiresAt.toISOString(),
            parameters: "Curve25519/32byte random key",
            keyValue: keyPair.publicKeyBase64,
          },
          nonce,
        },
      },
    },
  }).catch(async (err) => {
    // Mark the session failed but don't throw past the caller's try — the
    // route surfaces a 502 with this message.
    await prisma.abdmTransaction.updateMany({
      where: { requestId: transactionId, type: "HIU_REQUEST" },
      data: { status: "FAILED", errorMessage: (err as Error).message },
    });
    throw err;
  });

  return { transactionId, requestId };
}

export interface ReceivePayload {
  transactionId: string;
  entries: Array<{
    content: AbdmEncryptedEnvelope | string;
    careContextReference?: string;
    media?: string;
  }>;
  // Some HIPs nest the envelope key material on the page; we read it from the
  // entry's content envelope when present.
  keyMaterial?: unknown;
}

export interface ReceiveResult {
  stored: number;
  failed: number;
  records: string[]; // created MedicalRecord ids
}

/**
 * HIU data-push receiver. Looks up the transfer session by transactionId,
 * decrypts each entry, and stores it as a MedicalRecord. Idempotent-ish: a
 * re-push of the same transaction simply creates additional records (the
 * gateway pages, so callers should send distinct content per page).
 */
export async function receiveHealthInformation(
  payload: ReceivePayload,
): Promise<ReceiveResult> {
  const session = await prisma.abdmTransaction.findFirst({
    where: { requestId: payload.transactionId, type: "HIU_REQUEST" },
    orderBy: { createdAt: "desc" },
  });
  if (!session) {
    throw new ABDMError("Unknown transactionId — no transfer session", 404);
  }
  const detail = (session.detail ?? {}) as Record<string, unknown>;
  const privateKeyPem = detail.privateKeyPem as string | undefined;
  const nonce = detail.nonce as string | undefined;
  if (!privateKeyPem || !nonce) {
    throw new ABDMError("Transfer session is missing key material", 500);
  }
  const recipientPrivateKey = importPrivateKeyPem(privateKeyPem);

  const created: string[] = [];
  let failed = 0;

  for (const entry of payload.entries ?? []) {
    try {
      // The entry content may be a full envelope object or a base64 string
      // wrapped in the page's keyMaterial — normalise to an envelope.
      const envelope = normaliseEnvelope(entry.content, payload.keyMaterial);
      const plaintext = decryptBundleFromHip({
        envelope,
        recipientPrivateKey,
        recipientNonce: nonce,
      });
      const bundle = JSON.parse(plaintext.toString("utf8")) as Record<
        string,
        unknown
      >;
      const title = deriveBundleTitle(bundle, entry.careContextReference);
      const rec = await prisma.medicalRecord.create({
        data: {
          patientId: session.patientId!,
          tenantId: session.tenantId,
          source: "HIU_EXTERNAL",
          hiType: String((bundle.meta as any)?.profile?.[0] ?? "HealthDocumentRecord"),
          title,
          consentId: session.refId,
          careContextRef: entry.careContextReference ?? null,
          fhirBundle: bundle as any,
          fetchedAt: new Date(),
          recordDate: new Date(),
        },
        select: { id: true },
      });
      created.push(rec.id);
    } catch {
      failed += 1;
    }
  }

  await prisma.abdmTransaction.create({
    data: {
      type: "HIU_RECEIVE",
      status: failed === 0 ? "SUCCESS" : created.length > 0 ? "SUCCESS" : "FAILED",
      requestId: payload.transactionId,
      refId: session.refId,
      patientId: session.patientId,
      tenantId: session.tenantId,
      summary: `Received ${created.length} record(s) (${failed} failed) for txn ${payload.transactionId}`,
      detail: { stored: created.length, failed },
    },
  });

  return { stored: created.length, failed, records: created };
}

// ── helpers ───────────────────────────────────────────────────────────

function dataPushCallbackUrl(): string {
  const base = (process.env.PUBLIC_API_URL || process.env.ABDM_CALLBACK_BASE || "")
    .replace(/\/$/, "");
  return `${base}/api/v1/abdm/hiu/data-push`;
}

function cryptoRandomId(): string {
  // crypto.randomUUID is available in the Node runtime used here.
  return (globalThis.crypto as Crypto).randomUUID();
}

function normaliseEnvelope(
  content: AbdmEncryptedEnvelope | string,
  pageKeyMaterial: unknown,
): AbdmEncryptedEnvelope {
  if (typeof content === "object" && content && "encryptedData" in content) {
    return content as AbdmEncryptedEnvelope;
  }
  // content is a base64 string; the keyMaterial lives on the page.
  if (typeof content === "string" && pageKeyMaterial) {
    return {
      encryptedData: content,
      keyMaterial: pageKeyMaterial as AbdmEncryptedEnvelope["keyMaterial"],
    };
  }
  throw new ABDMError("Could not interpret pushed entry content", 400);
}

function deriveBundleTitle(
  bundle: Record<string, unknown>,
  careContextRef?: string,
): string {
  const profile = (bundle.meta as any)?.profile?.[0] as string | undefined;
  if (profile) return profile.replace(/Record$/, "").trim() || profile;
  if (careContextRef) return careContextRef;
  return "Health record";
}

/** Re-export so routes can mint our HIU public key for discovery if needed. */
export { exportX25519PublicKeyBase64 };
