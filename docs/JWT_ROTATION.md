# JWT signing-algorithm rotation procedure (issue #482)

This is the operations runbook for migrating MedCore's access-token signing
algorithm from HS256 (shared secret) to RS256 / EdDSA (asymmetric keypair)
without 401-ing any in-flight session.

The engineering scaffolding (config-driven sign/verify helpers, dual-verify
mode, fixtures, tests) ships in PR for #482 — `feat/jwt-rs256-scaffold`. The
five operational steps below execute the cutover against a deployed
environment. **Do not execute steps 2–5 outside a planned maintenance window
with the on-call engineer paged.**

---

## Why we're doing this

MedCore signs every access token with HS256 + a shared `JWT_SECRET`. Any
service that needs to verify a token must be given that secret — meaning
"verifier" and "signer" are the same trust boundary. That's fine while the
monolith is the only verifier, but breaks the moment we want:

- the e-prescription microservice (Q3 roadmap) to verify tokens it didn't issue
- the mobile app's offline mode to attest tokens locally
- third-party HIPAA-BAA partners to validate API-key-issued JWTs

Moving to RS256/EdDSA splits sign and verify into two materials — the
private key never leaves the API server, and any other consumer gets only
the public half.

## What ships in the scaffold PR

| Component | Path | Purpose |
| --- | --- | --- |
| Config + helpers | `apps/api/src/services/jwt.ts` | `signAccessToken`, `verifyAccessToken`, `getJwtConfig`, `__resetJwtConfigForTests` |
| Auth middleware | `apps/api/src/middleware/auth.ts` | Now calls `verifyAccessToken` instead of `jwt.verify` directly |
| Tenant middleware | `apps/api/src/middleware/tenant.ts` | Same |
| Auth routes | `apps/api/src/routes/auth.ts` | `generateTokens` calls `signAccessToken`; `resolveRegistrationRole` calls `verifyAccessToken` |
| Feedback route | `apps/api/src/routes/feedback.ts` | Same |
| Tests | `apps/api/src/services/jwt.test.ts` | HS256 default + RS256 + dual-verify + safety |
| Test fixtures | `apps/api/src/test/fixtures/jwt-test-{private,public}.pem` | NOT-FOR-PROD keypair |
| Env docs | `apps/api/.env.example` | New vars + pointer to this file |

Refresh tokens are NOT part of wave 1 — they continue on HS256 +
`JWT_REFRESH_SECRET` because they are server-validated against a DB row, so
the threat model is different. Wave 2 will fold them onto the same scheme
once wave 1 is stable.

---

## Env vars

| Var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `JWT_ALG` | no | `HS256` | `HS256` \| `RS256` \| `EdDSA` |
| `JWT_SECRET` | yes (HS256 + cutover) | `dev-secret` | HS256 sign/verify material; also the fallback secret during cutover |
| `JWT_PRIVATE_KEY` | yes when `JWT_ALG=RS256` or `EdDSA` | — | PEM-encoded private key, used to SIGN |
| `JWT_PUBLIC_KEY` | yes when `JWT_ALG=RS256` or `EdDSA` | — | PEM-encoded public key, used to VERIFY |
| `JWT_DUAL_VERIFY_HS256_FALLBACK` | no | unset | When `=1`, primary verify-failure falls back to HS256 + `JWT_SECRET` |

---

## Rotation procedure (5 steps)

Each step is one deploy. Do not skip steps — the dual-verify window is what
keeps in-flight tokens alive.

### Step 1 — Generate the RSA keypair

On a workstation with `openssl` (or use the Node one-liner in
`apps/api/src/test/fixtures/jwt-test-keypair.README.md`):

```bash
openssl genrsa -out medcore-jwt-private.pem 2048
openssl rsa -in medcore-jwt-private.pem -pubout -out medcore-jwt-public.pem
```

Store both keys in the secrets store (1Password / Vault / AWS Secrets
Manager). **The private key must never be committed to git, copied to
laptops, or shared via chat/email.** Production hosts pull it from secrets
at boot via the existing env-rendering mechanism.

### Step 2 — Deploy with dual-verify ON, still signing HS256

Push the env config below. Restart the API.

```env
JWT_ALG=HS256                           # still signing HS256 — DO NOT flip yet
JWT_SECRET=<existing — unchanged>
JWT_PRIVATE_KEY=<contents of medcore-jwt-private.pem>
JWT_PUBLIC_KEY=<contents of medcore-jwt-public.pem>
JWT_DUAL_VERIFY_HS256_FALLBACK=1
```

Why: pre-staging the keys + flag means step 3 (the algorithm flip) needs no
extra env edits — just `JWT_ALG=RS256`. Reduces operator-error blast radius.
Behaviour at this step is identical to pre-rotation because the primary alg
is still HS256.

Wait at least 5 minutes after rollout completes. Verify health checks green.

### Step 3 — Flip the signing algorithm to RS256

```env
JWT_ALG=RS256                           # ← flipped
JWT_SECRET=<existing — unchanged>       # ← still set so the fallback works
JWT_PRIVATE_KEY=<unchanged from step 2>
JWT_PUBLIC_KEY=<unchanged from step 2>
JWT_DUAL_VERIFY_HS256_FALLBACK=1        # ← still on
```

Restart the API.

From this moment:
- Newly minted access tokens are RS256-signed.
- Refresh-token exchanges (which mint new access tokens) are RS256.
- In-flight HS256 tokens issued before this restart KEEP VERIFYING because
  `JWT_DUAL_VERIFY_HS256_FALLBACK=1` makes the verifier fall back to HS256
  when the RS256 verify fails.

Monitor the API for 24h. Watch the 401-rate dashboard — a flat line is
success. A spike means tokens are failing both algorithms, in which case
roll back to step 2 (`JWT_ALG=HS256`) immediately.

### Step 4 — Clear the dual-verify fallback (~24h after step 3)

After one full access-token TTL has elapsed (24h), every browser session is
holding an RS256-signed token. The fallback path is no longer needed.

```env
JWT_ALG=RS256
JWT_PRIVATE_KEY=<unchanged>
JWT_PUBLIC_KEY=<unchanged>
# JWT_DUAL_VERIFY_HS256_FALLBACK= ← unset / removed
JWT_SECRET=<unchanged for now — see step 5>
```

Restart the API.

From this moment, HS256-signed access tokens are rejected. If any leaked
through the 24h window (long-running mobile sessions that didn't refresh,
e.g.), they 401 and the client reauthenticates. Watch the 401-rate
dashboard for ~30 min; a small spike is expected and acceptable.

### Step 5 — Rotate `JWT_SECRET` (hygiene)

The HS256 secret is no longer used to sign anything, but rotating it closes
the loophole where a leaked old `JWT_SECRET` could be used to forge tokens
during any future re-enabling of dual-verify. Generate a fresh random
secret and replace it:

```bash
openssl rand -base64 64 > medcore-jwt-secret.new
```

```env
JWT_ALG=RS256
JWT_PRIVATE_KEY=<unchanged>
JWT_PUBLIC_KEY=<unchanged>
JWT_SECRET=<freshly generated value>    # ← rotated
```

Restart the API. No user impact — the secret is unused at this point.

---

## Rollback plan

If anything goes wrong in steps 2–4, the rollback is always the same: set
`JWT_ALG=HS256`, leave `JWT_DUAL_VERIFY_HS256_FALLBACK=1`, restart. The
verifier accepts BOTH algorithms during that mode, so any token minted at
any point in the rollout will verify.

If a verified-bad public key was deployed: revert to the previous deploy
SHA + restart. Public keys are inert without the matching private — they
can't issue valid tokens, only fail to validate ones the private key did
issue.

---

## Audit-trail checkpoints

- The `safeAudit` row for `LOGIN_SUCCESS` carries the `jti` of the issued
  access token. Tokens minted during step 3 carry RS256-only `jti`s; you can
  spot-check by decoding the audit row's `metadata.accessTokenJti` against
  the live deploy's `JWT_PUBLIC_KEY`.
- `GET /api/v1/auth/me` round-trips a request through the verifier; a green
  response after the algorithm flip is end-to-end proof the wiring works.

---

## Open questions / wave 2

- **Refresh tokens** stay HS256 in this wave. Wave 2 (separate issue, TBD)
  will fold them onto the same scheme. The cutover procedure will mirror
  steps 1–5 above but for `JWT_REFRESH_SECRET` → `JWT_REFRESH_PRIVATE_KEY`/
  `JWT_REFRESH_PUBLIC_KEY`. Tracking issue to be filed once wave 1 has been
  stable in production for a sprint.
- **Key rotation cadence** for the asymmetric keypair itself is not covered
  here. Recommend annual rotation following the same 5-step procedure once
  this PR is merged and the steady-state RS256 mode is live.
- **JWKS endpoint** for third-party verifiers is not part of this PR —
  comes with wave 2's microservice-verifier work. For now `JWT_PUBLIC_KEY`
  is distributed manually via the secrets store.
