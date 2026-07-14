-- Per-tenant PM-JAY configuration. Moves PM-JAY credentials/endpoints out of
-- global TPA_PMJAY_* env into a tenant-scoped table so each hospital has its
-- own independent connection config. clientSecret holds AES-256-GCM ciphertext.
-- Additive only.

CREATE TABLE "tenant_pmjay_configurations" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "simulationMode" BOOLEAN NOT NULL DEFAULT true,
    "hospitalId" TEXT,
    "clientId" TEXT,
    "clientSecret" TEXT,
    "baseUrl" TEXT,
    "authUrl" TEXT,
    "bisUrl" TEXT,
    "tmsUrl" TEXT,
    "packageUrl" TEXT,
    "timeout" INTEGER,
    "retryCount" INTEGER,
    "logging" BOOLEAN,
    "batchSize" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tenant_pmjay_configurations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_pmjay_configurations_tenantId_key" ON "tenant_pmjay_configurations"("tenantId");

ALTER TABLE "tenant_pmjay_configurations"
    ADD CONSTRAINT "tenant_pmjay_configurations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
