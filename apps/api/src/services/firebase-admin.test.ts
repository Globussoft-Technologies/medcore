// Unit tests for the Firebase Admin credential loader.
//
// What: pins the resolution of the service-account JSON from the
//       FIREBASE_ADMIN_CREDENTIALS_JSON env var (raw JSON, base64-encoded
//       JSON, missing, and malformed). This is the prod-critical path that
//       decides whether patient phone-OTP sign-in can verify tokens at all —
//       a regression here surfaces in live as a generic "Couldn't sign you in"
//       401, so the branches are locked down here.
// Why:  the loader reads process.env directly; we snapshot + restore the var
//       around each test so the module-scope env mutation never leaks across
//       files under vitest's singleFork worker (CLAUDE.md test gotcha #2).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readServiceAccountRaw, loadServiceAccount } from "./firebase-admin";

const ENV_KEY = "FIREBASE_ADMIN_CREDENTIALS_JSON";

// A minimal but structurally-valid service-account object.
const SA = {
  type: "service_account",
  project_id: "medcore-test-project",
  private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
  client_email: "svc@medcore-test-project.iam.gserviceaccount.com",
};

describe("firebase-admin credential loader", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV_KEY];
  });

  afterEach(() => {
    // Restore the original value so other suites under the shared worker see
    // exactly what they had before.
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  describe("readServiceAccountRaw", () => {
    it("returns the raw JSON when the env var is inline JSON", () => {
      const json = JSON.stringify(SA);
      process.env[ENV_KEY] = json;
      expect(readServiceAccountRaw()).toBe(json);
    });

    it("trims surrounding whitespace and still recognises raw JSON", () => {
      const json = JSON.stringify(SA);
      process.env[ENV_KEY] = `  \n${json}\n  `;
      expect(readServiceAccountRaw()).toBe(json);
    });

    it("decodes a base64-encoded JSON value", () => {
      const json = JSON.stringify(SA);
      process.env[ENV_KEY] = Buffer.from(json, "utf8").toString("base64");
      expect(readServiceAccountRaw()).toBe(json);
    });

    it("throws when the env var is unset", () => {
      delete process.env[ENV_KEY];
      expect(() => readServiceAccountRaw()).toThrow(/is not set/i);
    });

    it("throws when the env var is empty / whitespace only", () => {
      process.env[ENV_KEY] = "   ";
      expect(() => readServiceAccountRaw()).toThrow(/is not set/i);
    });

    it("throws when the value is neither raw JSON nor valid base64 JSON", () => {
      // "not-json" base64-decodes to bytes that don't start with "{".
      process.env[ENV_KEY] = "not-json-and-not-base64-json";
      expect(() => readServiceAccountRaw()).toThrow(
        /neither raw JSON .* nor valid base64-encoded JSON/i,
      );
    });
  });

  describe("loadServiceAccount", () => {
    it("parses inline JSON into a ServiceAccount object", () => {
      process.env[ENV_KEY] = JSON.stringify(SA);
      const sa = loadServiceAccount();
      expect(sa.clientEmail ?? (sa as { client_email?: string }).client_email).toBe(
        SA.client_email,
      );
    });

    it("bridges snake_case project_id onto camelCase projectId", () => {
      process.env[ENV_KEY] = JSON.stringify(SA);
      const sa = loadServiceAccount() as { projectId?: string };
      expect(sa.projectId).toBe(SA.project_id);
    });

    it("parses a base64-encoded service account too", () => {
      process.env[ENV_KEY] = Buffer.from(JSON.stringify(SA), "utf8").toString("base64");
      const sa = loadServiceAccount() as { projectId?: string };
      expect(sa.projectId).toBe(SA.project_id);
    });

    it("throws a clear error when the JSON is malformed", () => {
      process.env[ENV_KEY] = "{ not valid json";
      expect(() => loadServiceAccount()).toThrow(/not valid JSON/i);
    });
  });
});
