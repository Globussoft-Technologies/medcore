import { PrismaClient, Role, Gender } from "@prisma/client";
import bcrypt from "bcryptjs";
import { PLAN_DEFINITIONS, SUPER_ADMIN_PERMISSIONS } from "@medcore/shared";

const prisma = new PrismaClient();

function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

async function main() {
  console.log("Seeding database...");

  // Create the default tenant first. Multi-tenancy is plumbed through
  // every authed request: User.tenantId becomes the JWT 'tenantId'
  // claim, which tenantScopedPrisma uses to filter every read+write.
  // Without this seed row, all seeded users would land with
  // tenantId=null and several E2E specs fail (cross-tenant-isolation
  // wire-level beacon, /auth/me tenantId surfacing, any test that
  // asserts cross-tenant isolation behaviours).
  const defaultTenant = await prisma.tenant.upsert({
    where: { subdomain: "default" },
    update: {},
    create: {
      name: "MedCore Default",
      subdomain: "default",
      active: true,
    },
  });
  console.log("Created tenant:", defaultTenant.subdomain);
  const tenantId = defaultTenant.id;

  // Create Admin
  const admin = await prisma.user.upsert({
    where: { email: "admin@medcore.local" },
    update: { tenantId },
    create: {
      email: "admin@medcore.local",
      phone: "9999900000",
      name: "System Admin",
      passwordHash: hashPassword("admin123"),
      role: Role.ADMIN,
      tenantId,
    },
  });
  console.log("Created admin:", admin.email);

  // Create Super Admin (Onviqa platform operator).
  //
  // The super-admin route group at apps/web/src/app/super-admin/ gates on
  // `role === "ADMIN" AND tenantId == null` (see super-admin/layout.tsx
  // line 8 and apps/api/src/routes/tenants.ts requireSuperAdmin). The
  // tenant-less Admin signals "cross-tenant operator" — distinct from
  // the per-tenant admin above. NEVER stamp a tenantId on this row, or
  // the super-admin UI redirects to /dashboard/not-authorized AND the
  // tenant-scoped Prisma extension silently pins them to one tenant.
  //
  // Change `superadmin123` to a strong password before any non-local
  // deploy — this is dev-seed credential parity with admin@medcore.local.
  // Pearl §8.2 — the seed super-admin uses the dedicated SUPER_ADMIN
  // role (added 2026-05-27). On re-seed, any legacy row that still has
  // `role=ADMIN` is upgraded to `SUPER_ADMIN` via the `update` clause so
  // existing local DBs converge without a manual UPDATE.
  //
  // NOTE: the literal `"SUPER_ADMIN"` is cast to Role because the
  // Prisma client must be regenerated (`npm run db:push`) before its
  // emitted enum picks up the new value. Once regenerate runs, this
  // cast becomes a no-op and the value is enum-validated as normal.
  const SUPER_ADMIN = "SUPER_ADMIN" as Role;
  const superAdmin = await prisma.user.upsert({
    where: { email: "superadmin@medcore.local" },
    update: {
      tenantId: null,
      role: SUPER_ADMIN,
      isMainSuperAdmin: true,
    },
    create: {
      email: "superadmin@medcore.local",
      phone: "9999900099",
      name: "Super Admin",
      passwordHash: hashPassword("superadmin123"),
      role: SUPER_ADMIN,
      tenantId: null,
      isMainSuperAdmin: true,
    },
  });
  console.log("Created super admin:", superAdmin.email);

  // Pearl §8.2 — note: we deliberately do NOT mass-upgrade legacy
  // ADMIN+tenantId=null users to SUPER_ADMIN. Only this seed account
  // (superadmin@medcore.local) carries the SUPER_ADMIN role. Other
  // tenant-less ADMINs stay as ADMIN per the operator's intent.

  // Pearl §8.2 — dev opt-out for mandatory TOTP on the seeded admins.
  // The login handler (apps/api/src/routes/auth.ts) blocks any admin-like
  // account without `twoFactorEnabled=true` UNLESS the SystemConfig key
  // `superadmin:<userId>:require_two_factor` is explicitly "false". The
  // seeded credentials must remain usable with just email+password for
  // local development — production-onboarded super-admins (created via
  // POST /api/v1/super-admin/users) still default to `require_two_factor=true`
  // and are forced through /auth/2fa/setup as designed.
  for (const u of [admin, superAdmin]) {
    await prisma.systemConfig.upsert({
      where: { key: `superadmin:${u.id}:require_two_factor` },
      update: { value: "false" },
      create: {
        key: `superadmin:${u.id}:require_two_factor`,
        value: "false",
      },
    });
  }
  console.log("Disabled mandatory TOTP for seeded admins (dev convenience)");

  // ── Platform plan catalog (Pearl §8.3, dynamic DB-backed plans) ──────
  // Seed the three baseline tiers from the (seed-only) PLAN_DEFINITIONS
  // constant. At runtime everything reads PlatformPlan from the DB; super
  // admins can add/edit more via the platform-billing UI. Idempotent on key.
  const PLAN_NAMES: Record<string, string> = {
    STARTER: "Starter",
    GROWTH: "Growth",
    ENTERPRISE: "Enterprise",
  };
  let planSort = 1;
  for (const def of Object.values(PLAN_DEFINITIONS)) {
    await prisma.platformPlan.upsert({
      where: { key: def.key },
      update: {
        name: PLAN_NAMES[def.key] ?? def.key,
        monthlyPriceInPaise: def.monthlyPriceInPaise,
        includedFeatures: def.includedFeatures,
      },
      create: {
        key: def.key,
        name: PLAN_NAMES[def.key] ?? def.key,
        monthlyPriceInPaise: def.monthlyPriceInPaise,
        includedFeatures: def.includedFeatures,
        sortOrder: planSort,
      },
    });
    planSort++;
  }
  console.log("Seeded platform plans:", Object.keys(PLAN_DEFINITIONS).join(", "));

  // ── Super-admin permission catalog (dynamic DB-backed grants) ────────
  // Seed the baseline grants from the (seed-only) SUPER_ADMIN_PERMISSIONS
  // constant. At runtime the invite form + API validation read the
  // SuperAdminPermission table from the DB; grants can be added/edited/disabled
  // there without a code change. Idempotent on key.
  let permSort = 1;
  for (const perm of SUPER_ADMIN_PERMISSIONS) {
    await prisma.superAdminPermission.upsert({
      where: { key: perm.key },
      update: {
        label: perm.label,
        description: perm.description,
        defaultGranted: perm.defaultGranted,
      },
      create: {
        key: perm.key,
        label: perm.label,
        description: perm.description,
        defaultGranted: perm.defaultGranted,
        sortOrder: permSort,
      },
    });
    permSort++;
  }
  console.log(
    "Seeded super-admin permission catalog:",
    SUPER_ADMIN_PERMISSIONS.map((p) => p.key).join(", "),
  );

  // Backfill legacy Tenant.plan values onto the unified plan keys so older
  // tenants (created when Tenant.plan used the BASIC/PRO/ENTERPRISE enum)
  // line up with the catalog. ENTERPRISE already matches.
  await prisma.tenant.updateMany({ where: { plan: "BASIC" }, data: { plan: "STARTER" } });
  await prisma.tenant.updateMany({ where: { plan: "PRO" }, data: { plan: "GROWTH" } });

  // Pearl §8.1 wizard step 3 — role-permission catalog.
  // The initial 10 roles + their permissions are inserted by the
  // migration `20260530000001_add_role_permissions`, so this seed file
  // does NOTHING for that catalog on fresh DBs. Edits made via
  // /dashboard/tenants/[id]/role-permissions go straight to the
  // role_catalog_entries / role_permission_items tables.

  // Create Doctors
  // Specialization strings here MUST match what the AI triage prompt returns
  // (apps/api/src/services/ai/prompts.ts → TRIAGE_SYSTEM). The triage route's
  // /:sessionId GET handler does `Doctor.findMany({ specialization: { in:
  // suggestedSpecialties } })` (exact match), so any mismatch yields an empty
  // "Recommended Doctors" panel for that complaint.
  const doctorsData = [
    {
      email: "dr.sharma@medcore.local",
      phone: "9999900001",
      name: "Dr. Rajesh Sharma",
      specialization: "General Medicine",
      qualification: "MBBS, MD",
    },
    {
      email: "dr.patel@medcore.local",
      phone: "9999900002",
      name: "Dr. Priya Patel",
      specialization: "Pediatrics",
      qualification: "MBBS, DCH",
    },
    {
      email: "dr.khan@medcore.local",
      phone: "9999900003",
      name: "Dr. Amir Khan",
      specialization: "Orthopedics",
      qualification: "MBBS, MS Ortho",
    },
    {
      email: "dr.iyer@medcore.local",
      phone: "9999900004",
      name: "Dr. Anjali Iyer",
      specialization: "Pulmonologist",
      qualification: "MBBS, MD (Pulmonary Medicine)",
    },
    {
      email: "dr.menon@medcore.local",
      phone: "9999900005",
      name: "Dr. Vikram Menon",
      specialization: "Cardiologist",
      qualification: "MBBS, MD, DM (Cardiology)",
    },
    {
      email: "dr.rao@medcore.local",
      phone: "9999900006",
      name: "Dr. Kavita Rao",
      specialization: "Dermatologist",
      qualification: "MBBS, MD (Dermatology)",
    },
    {
      email: "dr.singh@medcore.local",
      phone: "9999900007",
      name: "Dr. Harpreet Singh",
      specialization: "ENT",
      qualification: "MBBS, MS (ENT)",
    },
    {
      email: "dr.banerjee@medcore.local",
      phone: "9999900008",
      name: "Dr. Sourav Banerjee",
      specialization: "Neurologist",
      qualification: "MBBS, MD, DM (Neurology)",
    },
    {
      email: "dr.gupta@medcore.local",
      phone: "9999900009",
      name: "Dr. Neha Gupta",
      specialization: "Gastroenterologist",
      qualification: "MBBS, MD, DM (Gastroenterology)",
    },
    {
      email: "dr.fernandes@medcore.local",
      phone: "9999900012",
      name: "Dr. Maria Fernandes",
      specialization: "Gynecologist",
      qualification: "MBBS, MS (Obstetrics & Gynecology)",
    },
    {
      email: "dr.nair@medcore.local",
      phone: "9999900013",
      name: "Dr. Arjun Nair",
      specialization: "Psychiatrist",
      qualification: "MBBS, MD (Psychiatry)",
    },
    {
      email: "dr.bose@medcore.local",
      phone: "9999900014",
      name: "Dr. Ritu Bose",
      specialization: "Ophthalmologist",
      qualification: "MBBS, MS (Ophthalmology)",
    },
    {
      email: "dr.joshi@medcore.local",
      phone: "9999900015",
      name: "Dr. Sameer Joshi",
      specialization: "Urologist",
      qualification: "MBBS, MS, MCh (Urology)",
    },
    {
      email: "dr.reddy@medcore.local",
      phone: "9999900016",
      name: "Dr. Lakshmi Reddy",
      specialization: "Endocrinologist",
      qualification: "MBBS, MD, DM (Endocrinology)",
    },
    {
      email: "dr.dsouza@medcore.local",
      phone: "9999900017",
      name: "Dr. Rohan D'Souza",
      specialization: "General Physician",
      qualification: "MBBS, MD (General Medicine)",
    },
    {
      email: "dr.mehta@medcore.local",
      phone: "9998000001",
      name: "Dr. Anita Mehta",
      specialization: "General Physician",
      qualification: "MBBS, MD (General Medicine)",
    },
    {
      email: "dr.verma@medcore.local",
      phone: "9998000002",
      name: "Dr. Sanjay Verma",
      specialization: "General Physician",
      qualification: "MBBS, DNB (Family Medicine)",
    },
    {
      email: "dr.chowdhury@medcore.local",
      phone: "9998000003",
      name: "Dr. Riya Chowdhury",
      specialization: "General Medicine",
      qualification: "MBBS, MD (Internal Medicine)",
    },
    {
      email: "dr.pillai@medcore.local",
      phone: "9998000004",
      name: "Dr. Suresh Pillai",
      specialization: "General Medicine",
      qualification: "MBBS, MD (Medicine)",
    },
    {
      email: "dr.deshmukh.p@medcore.local",
      phone: "9998000005",
      name: "Dr. Meera Deshmukh",
      specialization: "Pediatrics",
      qualification: "MBBS, MD (Pediatrics)",
    },
    {
      email: "dr.kulkarni@medcore.local",
      phone: "9998000006",
      name: "Dr. Aditya Kulkarni",
      specialization: "Pediatrics",
      qualification: "MBBS, DCH",
    },
    {
      email: "dr.krishnan@medcore.local",
      phone: "9998000007",
      name: "Dr. Geetha Krishnan",
      specialization: "Cardiologist",
      qualification: "MBBS, MD, DM (Cardiology)",
    },
    {
      email: "dr.malhotra@medcore.local",
      phone: "9998000008",
      name: "Dr. Rohit Malhotra",
      specialization: "Cardiologist",
      qualification: "MBBS, MD, DM (Cardiology)",
    },
    {
      email: "dr.shetty@medcore.local",
      phone: "9998000009",
      name: "Dr. Pooja Shetty",
      specialization: "Dermatologist",
      qualification: "MBBS, MD (Dermatology)",
    },
    {
      email: "dr.bhat@medcore.local",
      phone: "9998000010",
      name: "Dr. Nikhil Bhat",
      specialization: "Dermatologist",
      qualification: "MBBS, DDVL",
    },
    {
      email: "dr.chauhan@medcore.local",
      phone: "9998000011",
      name: "Dr. Vikrant Chauhan",
      specialization: "Orthopedics",
      qualification: "MBBS, MS (Orthopedics)",
    },
    {
      email: "dr.kapoor@medcore.local",
      phone: "9998000012",
      name: "Dr. Simran Kapoor",
      specialization: "Orthopedics",
      qualification: "MBBS, MS (Ortho), Fellowship (Arthroplasty)",
    },
    {
      email: "dr.sengupta@medcore.local",
      phone: "9998000013",
      name: "Dr. Ananya Sengupta",
      specialization: "Gynecologist",
      qualification: "MBBS, MS (Obstetrics & Gynecology)",
    },
    {
      email: "dr.varma.g@medcore.local",
      phone: "9998000014",
      name: "Dr. Sneha Varma",
      specialization: "Gynecologist",
      qualification: "MBBS, DGO, DNB (Obstetrics & Gynecology)",
    },
    {
      email: "dr.sinha@medcore.local",
      phone: "9998000015",
      name: "Dr. Manish Sinha",
      specialization: "Nephrologist",
      qualification: "MBBS, MD, DM (Nephrology)",
    },
    {
      email: "dr.agarwal@medcore.local",
      phone: "9998000016",
      name: "Dr. Deepa Agarwal",
      specialization: "Oncologist",
      qualification: "MBBS, MD, DM (Medical Oncology)",
    },
    {
      email: "dr.rana@medcore.local",
      phone: "9998000017",
      name: "Dr. Karan Rana",
      specialization: "Rheumatologist",
      qualification: "MBBS, MD, DM (Rheumatology)",
    },
    {
      email: "dr.nanda@medcore.local",
      phone: "9998000018",
      name: "Dr. Shalini Nanda",
      specialization: "Dentist",
      qualification: "BDS, MDS (Conservative Dentistry)",
    },
    {
      email: "dr.kale@medcore.local",
      phone: "9998000019",
      name: "Dr. Prashant Kale",
      specialization: "General Surgeon",
      qualification: "MBBS, MS (General Surgery)",
    },
    {
      email: "dr.thomas@medcore.local",
      phone: "9998000020",
      name: "Dr. Elizabeth Thomas",
      specialization: "Hematologist",
      qualification: "MBBS, MD, DM (Hematology)",
    },
    {
      email: "dr.bhatt@medcore.local",
      phone: "9998000021",
      name: "Dr. Yogesh Bhatt",
      specialization: "Plastic Surgeon",
      qualification: "MBBS, MS, MCh (Plastic Surgery)",
    },
    {
      email: "dr.ahuja@medcore.local",
      phone: "9998000022",
      name: "Dr. Ritika Ahuja",
      specialization: "Diabetologist",
      qualification: "MBBS, MD, Fellowship (Diabetology)",
    },
    {
      email: "dr.ramesh@medcore.local",
      phone: "9998000023",
      name: "Dr. Suresh Ramesh",
      specialization: "Neurosurgeon",
      qualification: "MBBS, MS, MCh (Neurosurgery)",
    },
    {
      email: "dr.kaur@medcore.local",
      phone: "9998000024",
      name: "Dr. Harleen Kaur",
      specialization: "Pediatric Surgeon",
      qualification: "MBBS, MS, MCh (Pediatric Surgery)",
    },
    {
      email: "dr.das@medcore.local",
      phone: "9998000025",
      name: "Dr. Anirban Das",
      specialization: "Pediatric Cardiologist",
      qualification: "MBBS, MD (Pediatrics), DM (Cardiology)",
    },
    {
      email: "dr.mukherjee@medcore.local",
      phone: "9998000026",
      name: "Dr. Soma Mukherjee",
      specialization: "Radiologist",
      qualification: "MBBS, MD (Radiodiagnosis)",
    },
    {
      email: "dr.qureshi@medcore.local",
      phone: "9998000027",
      name: "Dr. Imran Qureshi",
      specialization: "Anesthesiologist",
      qualification: "MBBS, MD (Anesthesiology)",
    },
    {
      email: "dr.pawar@medcore.local",
      phone: "9998000028",
      name: "Dr. Snehal Pawar",
      specialization: "Physiotherapist",
      qualification: "BPT, MPT (Orthopedics)",
    },
    {
      email: "dr.menezes@medcore.local",
      phone: "9998000029",
      name: "Dr. Carol Menezes",
      specialization: "Nutritionist",
      qualification: "MSc (Clinical Nutrition & Dietetics)",
    },
    // ── Full hospital department coverage (June 2026) ──────────────────
    // The remaining specialties a multi-specialty hospital typically staffs,
    // so the booking flow / doctor directory has a doctor for nearly any
    // complaint. Phones continue the 9998xxxxxx block (…0030 onward).
    {
      email: "dr.bansal@medcore.local",
      phone: "9998000030",
      name: "Dr. Rohan Bansal",
      specialization: "Cardiothoracic Surgeon",
      qualification: "MBBS, MS, MCh (Cardiothoracic Surgery)",
    },
    {
      email: "dr.saxena@medcore.local",
      phone: "9998000031",
      name: "Dr. Priyanka Saxena",
      specialization: "Vascular Surgeon",
      qualification: "MBBS, MS, MCh (Vascular Surgery)",
    },
    {
      email: "dr.ghosh@medcore.local",
      phone: "9998000032",
      name: "Dr. Abhijit Ghosh",
      specialization: "Gastrointestinal Surgeon",
      qualification: "MBBS, MS, MCh (GI Surgery)",
    },
    {
      email: "dr.reddy.s@medcore.local",
      phone: "9998000033",
      name: "Dr. Madhavi Reddy",
      specialization: "Surgical Oncologist",
      qualification: "MBBS, MS, MCh (Surgical Oncology)",
    },
    {
      email: "dr.kapadia@medcore.local",
      phone: "9998000034",
      name: "Dr. Farhan Kapadia",
      specialization: "Radiation Oncologist",
      qualification: "MBBS, MD (Radiation Oncology)",
    },
    {
      email: "dr.nair.n@medcore.local",
      phone: "9998000035",
      name: "Dr. Latha Nair",
      specialization: "Neonatologist",
      qualification: "MBBS, MD (Pediatrics), Fellowship (Neonatology)",
    },
    {
      email: "dr.iqbal@medcore.local",
      phone: "9998000036",
      name: "Dr. Tariq Iqbal",
      specialization: "Geriatrician",
      qualification: "MBBS, MD (Geriatric Medicine)",
    },
    {
      email: "dr.bose.p@medcore.local",
      phone: "9998000037",
      name: "Dr. Pranab Bose",
      specialization: "Pain Management Specialist",
      qualification: "MBBS, MD (Anesthesiology), Fellowship (Pain Medicine)",
    },
    {
      email: "dr.shah.i@medcore.local",
      phone: "9998000038",
      name: "Dr. Ishaan Shah",
      specialization: "Infectious Disease Specialist",
      qualification: "MBBS, MD (Medicine), Fellowship (Infectious Diseases)",
    },
    {
      email: "dr.rao.a@medcore.local",
      phone: "9998000039",
      name: "Dr. Anusha Rao",
      specialization: "Allergist & Immunologist",
      qualification: "MBBS, MD (Medicine), Fellowship (Clinical Immunology)",
    },
    {
      email: "dr.varghese@medcore.local",
      phone: "9998000040",
      name: "Dr. Thomas Varghese",
      specialization: "Hepatologist",
      qualification: "MBBS, MD, DM (Hepatology)",
    },
    {
      email: "dr.mathur@medcore.local",
      phone: "9998000041",
      name: "Dr. Nidhi Mathur",
      specialization: "Pediatric Neurologist",
      qualification: "MBBS, MD (Pediatrics), DM (Neurology)",
    },
    {
      email: "dr.sodhi@medcore.local",
      phone: "9998000042",
      name: "Dr. Gurpreet Sodhi",
      specialization: "Andrologist",
      qualification: "MBBS, MS (Urology), Fellowship (Andrology)",
    },
    {
      email: "dr.basu@medcore.local",
      phone: "9998000043",
      name: "Dr. Indrani Basu",
      specialization: "Reproductive Medicine Specialist",
      qualification: "MBBS, MD (Obstetrics & Gynecology), Fellowship (IVF)",
    },
    {
      email: "dr.menon.s@medcore.local",
      phone: "9998000044",
      name: "Dr. Sreelatha Menon",
      specialization: "Endodontist",
      qualification: "BDS, MDS (Endodontics)",
    },
    {
      email: "dr.fernando@medcore.local",
      phone: "9998000045",
      name: "Dr. Joseph Fernando",
      specialization: "Orthodontist",
      qualification: "BDS, MDS (Orthodontics)",
    },
    {
      email: "dr.khanna@medcore.local",
      phone: "9998000046",
      name: "Dr. Vivek Khanna",
      specialization: "Oral & Maxillofacial Surgeon",
      qualification: "BDS, MDS, MCh (Maxillofacial Surgery)",
    },
    {
      email: "dr.roy@medcore.local",
      phone: "9998000047",
      name: "Dr. Ananya Roy",
      specialization: "Psychologist",
      qualification: "MA, MPhil (Clinical Psychology)",
    },
    {
      email: "dr.naidu@medcore.local",
      phone: "9998000048",
      name: "Dr. Kiran Naidu",
      specialization: "Emergency Medicine Specialist",
      qualification: "MBBS, MD (Emergency Medicine)",
    },
    {
      email: "dr.pandey@medcore.local",
      phone: "9998000049",
      name: "Dr. Alok Pandey",
      specialization: "Critical Care Specialist",
      qualification: "MBBS, MD, IDCCM (Critical Care)",
    },
    {
      email: "dr.chandra@medcore.local",
      phone: "9998000050",
      name: "Dr. Sunita Chandra",
      specialization: "Family Physician",
      qualification: "MBBS, DNB (Family Medicine)",
    },
    {
      email: "dr.lal@medcore.local",
      phone: "9998000051",
      name: "Dr. Mohit Lal",
      specialization: "Sports Medicine Specialist",
      qualification: "MBBS, MS (Ortho), Fellowship (Sports Medicine)",
    },
    {
      email: "dr.bhattacharya@medcore.local",
      phone: "9998000052",
      name: "Dr. Riya Bhattacharya",
      specialization: "Dietitian",
      qualification: "BSc, MSc (Dietetics)",
    },
    {
      email: "dr.kumar.s@medcore.local",
      phone: "9998000053",
      name: "Dr. Sandeep Kumar",
      specialization: "Spine Surgeon",
      qualification: "MBBS, MS (Ortho), Fellowship (Spine Surgery)",
    },
    {
      email: "dr.iyer.l@medcore.local",
      phone: "9998000054",
      name: "Dr. Lakshmi Iyer",
      specialization: "Interventional Radiologist",
      qualification: "MBBS, MD (Radiodiagnosis), Fellowship (Interventional Radiology)",
    },
  ];

  for (const doc of doctorsData) {
    const user = await prisma.user.upsert({
      where: { email: doc.email },
      update: { tenantId },
      create: {
        email: doc.email,
        phone: doc.phone,
        name: doc.name,
        passwordHash: hashPassword("doctor123"),
        role: Role.DOCTOR,
        tenantId,
      },
    });

    const doctor = await prisma.doctor.upsert({
      where: { userId: user.id },
      update: { tenantId },
      create: {
        userId: user.id,
        specialization: doc.specialization,
        qualification: doc.qualification,
        tenantId,
      },
    });

    // Create default schedule: Mon-Fri, 10:00-13:00 and 16:00-19:00
    for (let day = 1; day <= 5; day++) {
      for (const shift of [
        { start: "10:00", end: "13:00" },
        { start: "16:00", end: "19:00" },
      ]) {
        await prisma.doctorSchedule.upsert({
          where: {
            doctorId_dayOfWeek_startTime: {
              doctorId: doctor.id,
              dayOfWeek: day,
              startTime: shift.start,
            },
          },
          update: {},
          create: {
            doctorId: doctor.id,
            dayOfWeek: day,
            startTime: shift.start,
            endTime: shift.end,
            slotDurationMinutes: 15,
          },
        });
      }
    }

    console.log("Created doctor:", doc.name);
  }

  // Create Reception
  const reception = await prisma.user.upsert({
    where: { email: "reception@medcore.local" },
    update: { tenantId },
    create: {
      email: "reception@medcore.local",
      phone: "9999900010",
      name: "Front Desk",
      passwordHash: hashPassword("reception123"),
      role: Role.RECEPTION,
      tenantId,
    },
  });
  console.log("Created reception:", reception.email);

  // Create Nurse
  const nurse = await prisma.user.upsert({
    where: { email: "nurse@medcore.local" },
    update: { tenantId },
    create: {
      email: "nurse@medcore.local",
      phone: "9999900020",
      name: "Nurse Anita",
      passwordHash: hashPassword("nurse123"),
      role: Role.NURSE,
      tenantId,
    },
  });
  console.log("Created nurse:", nurse.email);

  // Create LAB_TECH and PHARMACIST so all 7 roles in `e2e/helpers.ts CREDS`
  // exist after `db:seed`. Without these, the RBAC matrix spec
  // (e2e/rbac-matrix.spec.ts) hits 401 on every loginAs("LAB_TECH" /
  // "PHARMACIST") and cascades into apiLogin failures across both ALL_ROLES
  // smoke groups (/dashboard/profile and /dashboard/account).
  const labtech = await prisma.user.upsert({
    where: { email: "labtech@medcore.local" },
    update: { tenantId },
    create: {
      email: "labtech@medcore.local",
      phone: "9999900030",
      name: "Lab Tech Suresh",
      passwordHash: hashPassword("labtech123"),
      role: Role.LAB_TECH,
      tenantId,
    },
  });
  console.log("Created lab tech:", labtech.email);

  const pharmacist = await prisma.user.upsert({
    where: { email: "pharmacist@medcore.local" },
    update: { tenantId },
    create: {
      email: "pharmacist@medcore.local",
      phone: "9999900040",
      name: "Pharmacist Vikram",
      passwordHash: hashPassword("pharmacist123"),
      role: Role.PHARMACIST,
      tenantId,
    },
  });
  console.log("Created pharmacist:", pharmacist.email);

  // Create sample patient — uses patient1@medcore.local (NOT @example.com)
  // to match the @medcore.local convention used by every other seeded user
  // and (importantly) by the E2E helper at e2e/helpers.ts which expects
  // `patient1@medcore.local / patient123` for the PATIENT role.
  const patientUser = await prisma.user.upsert({
    where: { email: "patient1@medcore.local" },
    update: { tenantId },
    create: {
      email: "patient1@medcore.local",
      phone: "9876543210",
      name: "Rahul Kumar",
      passwordHash: hashPassword("patient123"),
      role: Role.PATIENT,
      tenantId,
    },
  });

  await prisma.patient.upsert({
    where: { userId: patientUser.id },
    // `contactEmail` MUST be set (and kept in sync on re-seed) — the
    // /auth/register duplicate-email anti-enumeration check matches an
    // existing patient by (tenantId, contactEmail). Without it the seeded
    // patient is invisible to that check, so registering patient1's email
    // is treated as brand-new and issues tokens (breaks the public-auth
    // "duplicate email" e2e, which asserts NO tokens are returned).
    update: { tenantId, contactEmail: "patient1@medcore.local" },
    create: {
      userId: patientUser.id,
      mrNumber: "MR000001",
      gender: Gender.MALE,
      age: 35,
      address: "123 Main Street, Mumbai",
      bloodGroup: "B+",
      contactEmail: "patient1@medcore.local",
      tenantId,
    },
  });
  console.log("Created patient:", patientUser.name);

  // Initialize system config
  const configs = [
    { key: "hospital_name", value: "MedCore Hospital" },
    { key: "hospital_address", value: "Mumbai, Maharashtra, India" },
    { key: "hospital_phone", value: "+91 22 1234 5678" },
    { key: "consultation_fee", value: "500" },
    { key: "gst_percentage", value: "0" },
    // next_mr_number must stay above every MR allocated by the seed bundle.
    // seed.ts seeds MR000001 (Rahul Kumar). After the 2026-05-09 idempotency
    // pass, seed-realistic.ts now namespaces its 35 patients as
    // MRSEED000001..MRSEED000035 (so it can be re-run on every deploy
    // without colliding with the live MR counter). seed-pediatric-patients.ts
    // still seeds MR000036..MR000043 (8 patients) under the live counter.
    // The first free MR available to real-tenant `patients.ts` registration
    // is therefore 44 — Rahul Kumar (MR000001) + pediatric (8) = 9 used.
    // Bug #499 regression — must keep this aligned when pediatric mrSeqBase
    // changes; seed-realistic.ts no longer participates in the live counter.
    { key: "next_mr_number", value: "44" },
    { key: "next_invoice_number", value: "1" },
  ];

  for (const config of configs) {
    await prisma.systemConfig.upsert({
      where: { key: config.key },
      update: { value: config.value },
      create: config,
    });
  }
  console.log("System config initialized");

  console.log("Seeding complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
