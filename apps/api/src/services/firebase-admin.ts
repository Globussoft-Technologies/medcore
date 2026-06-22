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
// Credentials: the Firebase service-account JSON is supplied INLINE via an env
// var so it travels with the deploy — no filesystem dependency, which is what
// production / containers / serverless need (a fixed file path is unreliable
// there and won't exist on the server):
//   FIREBASE_ADMIN_CREDENTIALS_JSON  — the full service-account JSON, inline.
//      The value may be raw JSON, or base64-encoded JSON (some hosts mangle
//      multi-line secrets — base64 sidesteps that).
//   FIREBASE_PROJECT_ID              — must match the client-side project
//      (NEXT_PUBLIC_FIREBASE_PROJECT_ID) so the ID-token audience/issuer check
//      passes. If omitted, we fall back to the project_id inside the JSON.
//
// FIREBASE_ADMIN_CREDENTIALS_JSON is mandatory; missing it throws at first call
// so a misconfigured deploy fails the FIRST patient sign-in cleanly rather than
// 5xx-ing somewhere deeper in the route handler.

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
 * Read the service-account JSON STRING from the inline env var. Accepts raw
 * JSON or base64-encoded JSON (some hosts mangle multi-line secrets). Returns
 * the raw JSON text; throws if the var is missing or malformed.
 *
 * Exported for unit tests — this is the prod-critical credential-resolution
 * path, so its raw/base64/missing/malformed branches are pinned by tests.
 */
export function readServiceAccountRaw(): string {
  const inline = process.env.FIREBASE_ADMIN_CREDENTIALS_JSON;
  if (!inline || !inline.trim()) {
    throw new Error(
      "FIREBASE_ADMIN_CREDENTIALS_JSON is not set. Provide the Firebase " +
        "service-account JSON inline (raw or base64-encoded) — it travels " +
        "with the deploy so it works on local, containers and serverless alike.",
    );
  }
  const trimmed = inline.trim();
  // Heuristic: a JSON object starts with "{". If it doesn't, assume the value
  // was base64-encoded (common when a host won't accept multi-line secrets)
  // and decode it.
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

/** Exported for unit tests; see {@link readServiceAccountRaw}. */
export function loadServiceAccount(): ServiceAccount {
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

/**
 * Boot-time, NEVER-secret diagnostic for the Firebase Admin config. Logs the
 * shape of the credential env (present? raw vs base64? which project?) and
 * eagerly tries to initialise the SDK so a misconfigured deploy is obvious in
 * the server log at startup — instead of only surfacing as a generic 401 the
 * first time a patient tries to sign in. NEVER logs the private key or the raw
 * JSON; only booleans, lengths, and the (non-secret) project id / client email.
 */
export function logFirebaseAdminDiagnostics(): void {
  const tag = "[firebase-admin][diag]";
  const jsonVar = process.env.FIREBASE_ADMIN_CREDENTIALS_JSON;
  const pathVar = process.env.FIREBASE_ADMIN_CREDENTIALS_PATH;
  const projectEnv = process.env.FIREBASE_PROJECT_ID;

  console.log(`${tag} FIREBASE_ADMIN_CREDENTIALS_JSON set: ${!!(jsonVar && jsonVar.trim())} (length: ${jsonVar ? jsonVar.trim().length : 0})`);
  if (pathVar) {
    console.warn(`${tag} FIREBASE_ADMIN_CREDENTIALS_PATH is still set ("${pathVar}") but is NO LONGER read — the code requires FIREBASE_ADMIN_CREDENTIALS_JSON. Remove PATH and set JSON.`);
  }
  console.log(`${tag} FIREBASE_PROJECT_ID env: ${projectEnv ?? "(unset — will fall back to JSON project_id)"}`);

  try {
    const sa = loadServiceAccount() as ServiceAccount & { project_id?: string };
    const saProject = sa.projectId ?? sa.project_id ?? "(none)";
    console.log(`${tag} service-account parsed OK — project_id: ${saProject}, client_email: ${sa.clientEmail ?? (sa as { client_email?: string }).client_email ?? "(none)"}`);
    const effectiveProject = projectEnv || sa.projectId;
    console.log(`${tag} effective projectId used for token verification: ${effectiveProject}`);
    if (projectEnv && sa.projectId && projectEnv !== sa.projectId) {
      console.error(`${tag} ⚠️ MISMATCH: FIREBASE_PROJECT_ID (${projectEnv}) !== service-account project_id (${sa.projectId}). Token verification WILL fail unless these match the web client's NEXT_PUBLIC_FIREBASE_PROJECT_ID.`);
    }
    // Eagerly init the SDK so a bad credential surfaces NOW, at boot.
    getFirebaseAdminAuth();
    console.log(`${tag} ✅ Firebase Admin SDK initialised successfully.`);
  } catch (err) {
    console.error(`${tag} ❌ Firebase Admin is NOT usable — patient OTP login will return 401. Reason: ${(err as Error).message}`);
  }
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
  let decoded;
  try {
    decoded = await auth.verifyIdToken(idToken, /* checkRevoked */ true);
  } catch (err) {
    // Surface the SPECIFIC Firebase Admin failure (code + message) so a prod
    // 401 can be diagnosed from the server log without guessing. The route's
    // user-facing copy stays generic; this is server-side detail only.
    const code = (err as { code?: string })?.code;
    console.error(
      `[firebase-admin] verifyIdToken FAILED — code: ${code ?? "(none)"} | message: ${(err as Error).message} | ` +
        `effectiveProject: ${process.env.FIREBASE_PROJECT_ID || "(from JSON)"}. ` +
        `Common causes: (a) prod FIREBASE_ADMIN_CREDENTIALS_JSON is for a DIFFERENT project than the web client's ` +
        `NEXT_PUBLIC_FIREBASE_PROJECT_ID (issuer/audience mismatch), (b) token expired/clock skew, (c) credentials missing.`,
    );
    throw err;
  }
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
