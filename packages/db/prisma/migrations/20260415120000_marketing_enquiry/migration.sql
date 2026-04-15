-- CreateTable
CREATE TABLE "marketing_enquiries" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "hospitalName" TEXT NOT NULL,
    "hospitalSize" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "message" TEXT,
    "preferredContactTime" TEXT,
    "source" TEXT NOT NULL DEFAULT 'website',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "forwardedToCrmAt" TIMESTAMP(3),

    CONSTRAINT "marketing_enquiries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "marketing_enquiries_createdAt_idx" ON "marketing_enquiries"("createdAt");

-- CreateIndex
CREATE INDEX "marketing_enquiries_email_idx" ON "marketing_enquiries"("email");
