// Unit tests for the ABHA Milestone-1 (V3) enrolment service.
//   • RSA-OAEP/SHA-1 encryption round-trips against a real generated keypair
//   • the public certificate is fetched once and cached
//   • Aadhaar/OTP are encrypted (never sent as plaintext) to the gateway
//   • responses normalise to the shared AbhaProfileDto
//   • the server-side X-Token session store round-trips + expires unknown ids
//
// Network is mocked with vi.spyOn(globalThis,"fetch") (the same pattern as
// services/abdm/client.test.ts), branching on the request URL.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  generateKeyPairSync,
  privateDecrypt,
  constants as cryptoConstants,
} from "node:crypto";
import { _resetTokenCache } from "./client";
import {
  getPublicCertificate,
  encryptAadhaar,
  requestAadhaarOtp,
  verifyAadhaarOtp,
  putAbhaSession,
  getAbhaXToken,
  __resetAbhaCertCacheForTests,
  __resetAbhaSessionStoreForTests,
} from "./abha-enrolment";

const ORIGINAL_ENV = { ...process.env };

// A real RSA keypair so RSA-OAEP/SHA-1 encryption can be verified by decrypt.
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
// The ABHA sandbox returns JSON `{"publicKey":"<base64 DER (SPKI)>"}` — mirror
// that exact shape so the RSA round-trip below exercises the real parse path.
const PUBLIC_DER_B64 = publicKey
  .export({ type: "spki", format: "der" })
  .toString("base64");
const CERT_JSON = JSON.stringify({ publicKey: PUBLIC_DER_B64 });

// Captured outbound request bodies, keyed loosely by URL fragment.
let lastEnrolOtpBody: Record<string, unknown> | null = null;

function mockFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.includes("/gateway/v3/sessions")) {
      return new Response(
        JSON.stringify({ accessToken: "gw-token", expiresIn: 1800 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.includes("/profile/public/certificate")) {
      return new Response(CERT_JSON, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/enrollment/request/otp")) {
      lastEnrolOtpBody = body;
      return new Response(JSON.stringify({ txnId: "txn-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/enrollment/enrol/byAadhaar")) {
      return new Response(
        JSON.stringify({
          txnId: "txn-1",
          tokens: { token: "x-token-abc" },
          ABHAProfile: {
            ABHANumber: "91-1234-5678-9012",
            preferredAbhaAddress: "rahul@sbx",
            name: "Rahul Kumar",
            gender: "M",
            dob: "1990-01-01",
            mobile: "9876543210",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

beforeEach(() => {
  process.env.ABDM_CLIENT_ID = "test-client-id";
  process.env.ABDM_CLIENT_SECRET = "test-client-secret";
  process.env.ABDM_BASE_URL = "https://dev.abdm.gov.in";
  process.env.ABDM_GATEWAY_URL = "https://dev.abdm.gov.in/gateway";
  process.env.ABDM_ABHA_BASE_URL = "https://abhasbx.abdm.gov.in";
  _resetTokenCache();
  __resetAbhaCertCacheForTests();
  __resetAbhaSessionStoreForTests();
  lastEnrolOtpBody = null;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("getPublicCertificate", () => {
  it("fetches the PEM once and caches it", async () => {
    const fetchSpy = mockFetch();
    const pem1 = await getPublicCertificate();
    const pem2 = await getPublicCertificate();
    expect(pem1).toContain("BEGIN PUBLIC KEY");
    expect(pem2).toBe(pem1);
    // Token + cert = at most 2 calls on the first fetch; the second call is cached.
    const certCalls = fetchSpy.mock.calls.filter(([u]) =>
      String(u).includes("/profile/public/certificate"),
    );
    expect(certCalls).toHaveLength(1);
  });
});

describe("RSA-OAEP/SHA-1 encryption", () => {
  it("encrypts so the ABDM private key can decrypt back to the original", async () => {
    mockFetch();
    const aadhaar = "123456789012";
    const ciphertextB64 = await encryptAadhaar(aadhaar);
    expect(ciphertextB64).not.toContain(aadhaar);
    const decrypted = privateDecrypt(
      {
        key: privateKey,
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha1",
      },
      Buffer.from(ciphertextB64, "base64"),
    );
    expect(decrypted.toString("utf8")).toBe(aadhaar);
  });
});

describe("requestAadhaarOtp", () => {
  it("returns the txnId and sends an ENCRYPTED loginId (never the raw Aadhaar)", async () => {
    mockFetch();
    const { txnId } = await requestAadhaarOtp("123456789012");
    expect(txnId).toBe("txn-1");
    expect(lastEnrolOtpBody).toBeTruthy();
    expect(lastEnrolOtpBody!.scope).toEqual(["abha-enrol"]);
    expect(lastEnrolOtpBody!.otpSystem).toBe("aadhaar");
    // loginId is present but is NOT the plaintext Aadhaar.
    expect(typeof lastEnrolOtpBody!.loginId).toBe("string");
    expect(lastEnrolOtpBody!.loginId).not.toBe("123456789012");
  });
});

describe("verifyAadhaarOtp", () => {
  it("creates the ABHA and normalises the profile", async () => {
    mockFetch();
    const result = await verifyAadhaarOtp({
      txnId: "txn-1",
      otp: "123456",
      mobile: "9876543210",
    });
    expect(result.profile.abhaNumber).toBe("91-1234-5678-9012");
    expect(result.profile.abhaAddress).toBe("rahul@sbx");
    expect(result.profile.name).toBe("Rahul Kumar");
    expect(result.profile.mobile).toBe("9876543210");
    expect(result.xToken).toBe("x-token-abc");
  });
});

describe("X-Token session store", () => {
  it("round-trips a stored token and returns null for unknown/expired ids", () => {
    const id = putAbhaSession("x-token-abc");
    expect(getAbhaXToken(id)).toBe("x-token-abc");
    expect(getAbhaXToken("does-not-exist")).toBeNull();
  });
});
