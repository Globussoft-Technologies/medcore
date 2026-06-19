// Firebase Admin SDK — lazy, singleton init.
//
// Why: the patient phone-OTP flow uses Firebase to deliver SMS + verify the
// 6-digit code. The Firebase ID token that comes back to the client is NOT
// trusted directly by our backend — we verify it here with the Admin SDK
// (which checks the JWT signature against Google's public keys, the
// audience, the issuer, and the expiry), pull the verified phone number
// out, and use that to look up the patient User row. Everything downstream
// (cookie issuance, audit log, tenant scoping) is our existing machinery —
// Firebase is just the OTP transport.
//
// Credentials: the Firebase service-account JSON is supplied EITHER as raw
// JSON in an env var (preferred for production / containers / serverless,
// where a fixed filesystem path is unreliable), OR as a path to a JSON file
// on disk (convenient for local dev). Resolution order:
//   1. FIREBASE_ADMIN_CREDENTIALS_JSON  — the full service-account JSON,
//      inline. Travels with the deploy; no filesystem dependency. Use this
//      in live. The value may be the raw JSON, or base64-encoded JSON (some
//      hosts mangle multi-line secrets — base64 sidesteps that).
//   2. FIREBASE_ADMIN_CREDENTIALS_PATH  — absolute path to the JSON file.
//      Fine locally; will NOT work in live if the path doesn't exist on the
//      server (it usually doesn't), so prefer (1) for deployed environments.
// AND, in both cases:
//   FIREBASE_PROJECT_ID                 — must match the client-side project
//                                         (NEXT_PUBLIC_FIREBASE_PROJECT_ID) so
//                                         the ID-token audience/issuer check
//                                         passes. If omitted, we fall back to
//                                         the project_id inside the JSON.
//
// At least one credential source is mandatory; missing both throws at first
// call so a misconfigured deploy fails the FIRST patient sign-in cleanly
// rather than 5xx-ing somewhere deeper in the route handler.

import { existsSync, readFileSync } from "node:fs";
import {
  cert,
  getApps,
  initializeApp,
  type App,
  type ServiceAccount,
} from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";

let cachedApp: App | null = null;
let cachedAuth: Auth | null = null;

/**
 * Read the service-account JSON STRING from whichever source is configured.
 * Prefers the inline env var (production-safe); falls back to the file path
 * (local-dev convenience). Returns the raw JSON text.
 */
function readServiceAccountRaw(): string {
  // 1. Inline JSON env var — preferred for live. Accept raw JSON or base64.
  const inline = process.env.FIREBASE_ADMIN_CREDENTIALS_JSON;
  if (inline && inline.trim()) {
    const trimmed = inline.trim();
    // Heuristic: a JSON object starts with "{". If it doesn't, assume the
    // value was base64-encoded (common when a host won't accept multi-line
    // secrets) and decode it.
    if (trimmed.startsWith("{")) return trimmed;
    try {
      const decoded = Buffer.from(trimmed, "base64").toString("utf8");
      if (decoded.trim().startsWith("{")) return decoded;
    } catch {
      // fall through to the error below
    }
    throw new Error(
      "FIREBASE_ADMIN_CREDENTIALS_JSON is set but is neither raw JSON " +
        "(starting with '{') nor valid base64-encoded JSON.",
    );
  }

  // 2. File path — local-dev fallback. Will NOT work in live if the path
  //    doesn't exist on the server, hence the inline var is preferred there.
  const path = process.env.FIREBASE_ADMIN_CREDENTIALS_PATH;
  if (!path) {
    throw new Error(
      "No Firebase credentials configured. Set FIREBASE_ADMIN_CREDENTIALS_JSON " +
        "(inline service-account JSON — preferred for production) OR " +
        "FIREBASE_ADMIN_CREDENTIALS_PATH (path to the JSON file — local dev).",
    );
  }
  if (!existsSync(path)) {
    throw new Error(
      `FIREBASE_ADMIN_CREDENTIALS_PATH points at "${path}" but that file does not exist. ` +
        "On a deployed server this path usually won't exist — use FIREBASE_ADMIN_CREDENTIALS_JSON instead.",
    );
  }
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `Could not read FIREBASE_ADMIN_CREDENTIALS_PATH at "${path}": ${(err as Error).message}`,
    );
  }
}

function loadServiceAccount(): ServiceAccount {
  const raw = readServiceAccountRaw();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Firebase service-account credentials are not valid JSON: ${(err as Error).message}`,
    );
  }
  const sa = parsed as ServiceAccount & { project_id?: string };
  if (!sa.projectId && sa.project_id) {
    // Service-account JSONs use snake_case; firebase-admin's ServiceAccount
    // type wants camelCase. Bridge for older JSON exports.
    sa.projectId = sa.project_id;
  }
  return sa;
}

function getFirebaseAdminApp(): App {
  if (cachedApp) return cachedApp;
  // firebase-admin keeps its own app registry — if hot-reload or another
  // module has already initialised the default app, reuse it.
  const existing = getApps();
  if (existing.length > 0) {
    cachedApp = existing[0];
    return cachedApp;
  }
  const serviceAccount = loadServiceAccount();
  // Prefer an explicit FIREBASE_PROJECT_ID, but fall back to the project_id
  // baked into the service-account JSON. Using the JSON's own project_id
  // removes the most common misconfig — a project mismatch between the env
  // var and the credentials — which surfaces as a silent "Couldn't sign you
  // in" because the ID-token audience/issuer check fails.
  const projectId =
    process.env.FIREBASE_PROJECT_ID || serviceAccount.projectId;
  if (!projectId) {
    throw new Error(
      "Could not determine the Firebase project id. Set FIREBASE_PROJECT_ID " +
        "(must match NEXT_PUBLIC_FIREBASE_PROJECT_ID on the web client) or ensure " +
        "the service-account JSON includes project_id.",
    );
  }
  cachedApp = initializeApp({
    credential: cert(serviceAccount),
    projectId,
  });
  return cachedApp;
}

/** Lazy-initialised Firebase Admin Auth client. Safe to call repeatedly. */
export function getFirebaseAdminAuth(): Auth {
  if (cachedAuth) return cachedAuth;
  cachedAuth = getAuth(getFirebaseAdminApp());
  return cachedAuth;
}

export interface VerifiedFirebasePhoneToken {
  uid: string;
  phoneNumber: string; // E.164, e.g. "+919876543210"
  emailVerified: boolean;
}

/**
 * Verify a Firebase ID token and assert that it came from a phone-auth
 * sign-in (so an attacker can't take any old anonymous-auth token from the
 * same project and use it as a patient login). Returns the verified phone
 * number on success, throws on any failure.
 */
export async function verifyPhoneIdToken(
  idToken: string,
): Promise<VerifiedFirebasePhoneToken> {
  if (typeof idToken !== "string" || idToken.length === 0) {
    throw new Error("ID token is required.");
  }
  const auth = getFirebaseAdminAuth();
  // `checkRevoked=true` makes the call also reject tokens whose underlying
  // Firebase user has been disabled or whose refresh tokens have been
  // revoked since the token was minted — cheap defence vs. a stolen token
  // replay after the patient signs out.
  const decoded = await auth.verifyIdToken(idToken, /* checkRevoked */ true);
  // Firebase phone-auth populates `phone_number` on the decoded token; if
  // it's missing, the token came from a different sign-in method (e.g.
  // anonymous or email) and we refuse to honour it as a patient login.
  const phoneNumber = decoded.phone_number;
  if (!phoneNumber || typeof phoneNumber !== "string") {
    throw new Error(
      "Firebase token has no phone_number claim — only phone sign-in tokens are accepted here.",
    );
  }
  return {
    uid: decoded.uid,
    phoneNumber,
    emailVerified: Boolean(decoded.email_verified),
  };
}
