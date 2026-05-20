-- ================================================================
-- 20260520000006_pearl_tenant_razorpay_and_admin_totp
--
-- Closes Pearl ERP Stage 1 gap item #10b — per-tenant Razorpay
-- credentials + mandatory-TOTP toggle for tenant ADMIN.
--
-- Schema additive only. Existing single-tenant deployments are not
-- affected: when razorpayKeyId / razorpayKeySecret are NULL the
-- runtime falls back to the RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET env
-- vars (current behaviour). When requireAdminTOTP=false (default)
-- ADMIN login flow is unchanged.
-- ================================================================

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "razorpayKeyId" TEXT,
  ADD COLUMN IF NOT EXISTS "razorpayKeySecret" TEXT,
  ADD COLUMN IF NOT EXISTS "razorpayMode" TEXT,
  ADD COLUMN IF NOT EXISTS "requireAdminTOTP" BOOLEAN NOT NULL DEFAULT FALSE;
