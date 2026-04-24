# MedCore Environment Variables

Appendix to [`DEPLOY.md`](DEPLOY.md). Canonical template lives at
`apps/api/.env.example` — **never** commit real values. Prod `.env` lives at
`/home/empcloud-development/medcore/.env` (chmod 600, git-ignored). Mobile
is build-time; values baked via EAS.

Legend: **SM** = secret-management (vault / sealed), **CM** = config-management
(plaintext in `.env`, non-sensitive), **R** = required, **r** = recommended,
**o** = optional (feature falls back to mock / disabled).

## API (`/home/empcloud-development/medcore/.env`)

> **HL7 v2 inbound:** `POST /api/v1/hl7v2/inbound` accepts pipe-delimited HL7 v2 messages from legacy lab / HIS systems. Role-gated to **ADMIN** and rate-limited to 60 msg/min/IP; nginx or the host firewall should further restrict the source-IP range to the specific lab partners that need access — the endpoint handles PHI and must not be open to the public internet.

| Var | Class | Level | Notes |
|---|---|---|---|
| `DATABASE_URL` | SM | R | Postgres DSN — server refuses to start without. |
| `JWT_SECRET` | SM | R | Access-token HS256 secret. |
| `JWT_REFRESH_SECRET` | SM | R | Refresh-token HS256 secret. |
| `UPLOAD_SIGNING_SECRET` | SM | R | Signed-URL HMAC secret for uploads. |
| `PORT` | CM | R | 4100 in prod (see `ecosystem.medcore.config.js`). |
| `NODE_ENV` | CM | R | `production`. |
| `CORS_ORIGIN` | CM | R | `https://medcore.globusdemos.com`. |
| `SARVAM_API_KEY` | SM | r | AI features fall back to mock responses if unset. |
| `RAZORPAY_KEY_ID` | SM | r | Billing runs in mock mode without this pair. |
| `RAZORPAY_KEY_SECRET` | SM | r | Paired with `RAZORPAY_KEY_ID`. |
| `RAZORPAY_WEBHOOK_SECRET` | SM | R-if-live | Required if Razorpay is live; webhook rejects everything otherwise. |
| `WHATSAPP_API_KEY` / `WHATSAPP_API_URL` | SM | o | Mock logs message if unset. |
| `SMS_API_KEY` / `SMS_API_URL` / `SMS_PROVIDER` / `SMS_SENDER_ID` | SM/CM | o | MSG91 or Twilio-compat. |
| `EMAIL_API_KEY` / `EMAIL_API_URL` / `EMAIL_FROM` | SM/CM | o | SendGrid. |
| `EXPO_ACCESS_TOKEN` | SM | o | Push throughput; basic Expo push works without. |
| `STORAGE_PROVIDER` | CM | o | `s3` activates S3 adapter; unset = local disk. |
| `AWS_REGION` / `AWS_S3_BUCKET` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_S3_ENDPOINT` | SM/CM | r-if-S3 | Required when `STORAGE_PROVIDER=s3`. |
| `JITSI_DOMAIN` | CM | r | `meet.jit.si` for dev, self-hosted/JaaS domain for prod. |
| `JITSI_APP_ID` / `JITSI_APP_SECRET` | SM | r-if-prod-JaaS | Unsigned rooms otherwise. |
| `TPA_MEDIASSIST_API_KEY` / `..._HOSPITAL_ID` / `..._API_URL` | SM/CM | o | Only set for TPAs your hospital is actually contracted with. |
| `TPA_PARAMOUNT_API_KEY` / `..._CLIENT_CODE` / `..._API_URL` | SM/CM | o | Same. |
| `TPA_VIDAL_API_KEY` / `..._PROVIDER_ID` | SM | o | Same. |
| `TPA_FHPL_API_KEY` / `..._PROVIDER_ID` | SM | o | Same. |
| `TPA_ICICI_LOMBARD_API_KEY` / `..._AGENT_CODE` | SM | o | Same. |
| `TPA_STAR_HEALTH_API_KEY` / `..._HOSPITAL_CODE` | SM | o | Same. |
| `SENTRY_DSN` | SM | r | Error reporting. |
| `ABDM_CLIENT_ID` / `ABDM_CLIENT_SECRET` | SM | r-if-ABDM-live | ABDM /dashboard/abdm features disabled without. |
| `ABDM_BASE_URL` / `ABDM_GATEWAY_URL` / `ABDM_CM_ID` / `ABDM_JWKS_URL` | CM | r-if-ABDM-live | Sandbox defaults in `.env.example`. |
| `ABDM_SKIP_VERIFY` | CM | o | **NEVER** true in prod. Dev-only. |
| `DISABLE_RATE_LIMITS` | CM | o | Ops escape hatch. **Never** persist in `ecosystem.medcore.config.js`. See DEPLOY.md §8a. |

## Web (baked into Next.js build — change means a rebuild)

| Var | Class | Level | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | CM | R | Points browser at API base. `https://medcore.globusdemos.com/api/v1`. |
| `NEXT_PUBLIC_SENTRY_DSN` | CM | r | Client-side Sentry. |
| `NEXT_PUBLIC_ABDM_MODE` | CM | o | `production` hides sandbox-only banners on `/dashboard/abdm`. |

## Mobile (EAS build-time, baked into JS bundle)

| Var | Class | Level | Notes |
|---|---|---|---|
| `EXPO_PUBLIC_API_URL` | CM | R | Already set per-profile in `apps/mobile/eas.json`. |
| `EAS_PROJECT_ID` | CM | R | Expo project linkage. |
| `GOOGLE_SERVICES_JSON` | SM | r-if-push | Path to Firebase config for Android push. |

---

When rotating an SM value: change it in the vault, redeploy the API
(`pm2 restart medcore-api` after updating `.env`), and invalidate any signed
URLs that used the old signing secret.
