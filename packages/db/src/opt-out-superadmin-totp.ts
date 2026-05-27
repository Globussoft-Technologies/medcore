// One-shot dev unblock — Pearl §8.2.
//
// Why this file exists: the login handler (apps/api/src/routes/auth.ts) blocks
// every admin-like account without `twoFactorEnabled=true` UNLESS the
// SystemConfig key `superadmin:<userId>:require_two_factor` is explicitly set
// to "false". On a freshly-pushed DB the key is absent → default-ON → 412
// "Super-admin accounts must enrol TOTP before signing in" before the operator
// can even reach the dashboard.
//
// This script flips that flag to "false" for every existing admin-like row
// (Role.ADMIN with tenantId=null, OR Role.SUPER_ADMIN). Production-onboarded
// super-admins still default to require=true on creation; only existing rows
// at the time you run this are opted out.
//
// Run with:
//   npm run -w @medcore/db db:opt-out-superadmin-totp

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const candidates = await prisma.user.findMany({
    where: {
      OR: [
        { role: "SUPER_ADMIN" as never },
        { AND: [{ role: "ADMIN" }, { tenantId: null }] },
      ],
    },
    select: { id: true, email: true, role: true, tenantId: true },
  });

  if (candidates.length === 0) {
    console.log("No admin-like users found (Role.SUPER_ADMIN or ADMIN+tenantId=null).");
    return;
  }

  for (const u of candidates) {
    await prisma.systemConfig.upsert({
      where: { key: `superadmin:${u.id}:require_two_factor` },
      update: { value: "false" },
      create: {
        key: `superadmin:${u.id}:require_two_factor`,
        value: "false",
      },
    });
    console.log(`opt-out → ${u.email} (${u.role}, tenantId=${u.tenantId ?? "null"})`);
  }
  console.log(`Done. ${candidates.length} account(s) can now sign in without TOTP.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
