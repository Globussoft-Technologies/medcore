-- AlterEnum: add PHARMACIST and LAB_TECH to Role
-- Postgres requires ALTER TYPE ... ADD VALUE outside a transaction block;
-- Prisma runs each statement separately so this is safe.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'PHARMACIST';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'LAB_TECH';
