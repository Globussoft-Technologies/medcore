import { PrismaClient, PurchaseOrderStatus, ExpenseCategory } from "@prisma/client";

const prisma = new PrismaClient();

const PACKAGES = [
  {
    name: "Master Health Checkup",
    description: "Comprehensive annual health screening covering major organ systems.",
    services:
      "CBC, LFT, KFT, Lipid Profile, Chest X-Ray, ECG, Doctor Consultation",
    price: 3000,
    discountPrice: 2500,
    validityDays: 365,
    category: "Preventive",
  },
  {
    name: "Diabetes Care Package",
    description: "Monitor and manage diabetes with regular tests and consultations.",
    services:
      "HbA1c, Fasting Blood Sugar, Post-Prandial Sugar, Lipid Profile, KFT, 2 Doctor Consultations",
    price: 2500,
    discountPrice: 2100,
    validityDays: 180,
    category: "Diabetes Package",
  },
  {
    name: "Cardiac Wellness Package",
    description: "Detailed cardiovascular assessment for at-risk individuals.",
    services:
      "ECG, 2D Echo, Treadmill Stress Test, Lipid Profile, Cardiology Consultation",
    price: 4500,
    discountPrice: 3900,
    validityDays: 365,
    category: "Cardiac Package",
  },
  {
    name: "Pregnancy Care Package",
    description: "Complete antenatal care package covering the full gestation period.",
    services:
      "Monthly Checkups, USG (3 scans), CBC, TSH, Glucose Challenge Test, OB/GYN Consultations",
    price: 8000,
    discountPrice: 7200,
    validityDays: 270,
    category: "Pregnancy Care",
  },
  {
    name: "Senior Citizen Screening",
    description: "Specially curated screening package for adults above 60.",
    services:
      "Full Body Screening, Bone Density, ECG, Eye Checkup, Dental Checkup, Geriatric Consultation",
    price: 3500,
    discountPrice: 2950,
    validityDays: 365,
    category: "Senior Citizen",
  },
];

const SUPPLIERS = [
  {
    name: "MedSupplies India Pvt Ltd",
    contactPerson: "Ramesh Kumar",
    phone: "9876543210",
    email: "orders@medsupplies.in",
    address: "Plot 45, Industrial Area, Mumbai 400072",
    gstNumber: "27AABCM1234Z1ZP",
    paymentTerms: "Net 30",
  },
  {
    name: "Pharma Direct",
    contactPerson: "Anita Sharma",
    phone: "9823456780",
    email: "sales@pharmadirect.co.in",
    address: "22 MG Road, Bangalore 560001",
    gstNumber: "29AACCP5678Q1Z9",
    paymentTerms: "Net 45",
  },
  {
    name: "HealthCare Distributors",
    contactPerson: "Vinod Patel",
    phone: "9912345678",
    email: "procurement@hcdist.com",
    address: "Sector 18, Noida 201301",
    gstNumber: "09AAECH9876K1ZN",
    paymentTerms: "Net 30",
  },
  {
    name: "LifeLine Medical",
    contactPerson: "Sunita Rao",
    phone: "9765432198",
    email: "support@lifelinemed.in",
    address: "Hyderabad Road, Secunderabad 500003",
    gstNumber: "36AAACL4567M1Z4",
    paymentTerms: "Net 15",
  },
];

const EXPENSE_SEEDS: Array<{
  category: ExpenseCategory;
  amount: number;
  description: string;
  daysAgo: number;
  paidTo?: string;
  referenceNo?: string;
}> = [
  { category: "SALARY", amount: 325000, description: "Monthly salary - clinical staff", daysAgo: 1, paidTo: "Staff payroll" },
  { category: "SALARY", amount: 180000, description: "Monthly salary - non-clinical staff", daysAgo: 1, paidTo: "Staff payroll" },
  { category: "RENT", amount: 125000, description: "Monthly clinic rent", daysAgo: 2, paidTo: "Landlord", referenceNo: "RCPT-4521" },
  { category: "UTILITIES", amount: 28500, description: "Electricity bill", daysAgo: 4, paidTo: "Power Corp", referenceNo: "ELEC-08921" },
  { category: "UTILITIES", amount: 4200, description: "Water bill", daysAgo: 5, paidTo: "Water Board", referenceNo: "WB-1123" },
  { category: "UTILITIES", amount: 7900, description: "Internet + Phone", daysAgo: 6, paidTo: "Telecom Co", referenceNo: "BILL-2341" },
  { category: "CONSUMABLES", amount: 12800, description: "Surgical gloves and masks", daysAgo: 8, paidTo: "MedSupplies India Pvt Ltd" },
  { category: "CONSUMABLES", amount: 5400, description: "Disposable syringes and needles", daysAgo: 10, paidTo: "Pharma Direct" },
  { category: "EQUIPMENT", amount: 85000, description: "New ECG machine", daysAgo: 12, paidTo: "HealthCare Distributors", referenceNo: "INV-EQP-332" },
  { category: "MAINTENANCE", amount: 8500, description: "AC servicing - OPD area", daysAgo: 14, paidTo: "CoolFix Services" },
  { category: "MAINTENANCE", amount: 3200, description: "Plumbing repair", daysAgo: 17, paidTo: "Ravi Plumbers" },
  { category: "MARKETING", amount: 15000, description: "Health camp flyers", daysAgo: 20, paidTo: "Print Hub" },
  { category: "MARKETING", amount: 22000, description: "Google Ads campaign", daysAgo: 22, referenceNo: "GADS-91023" },
  { category: "OTHER", amount: 4800, description: "Office stationery", daysAgo: 25, paidTo: "Stationers Corp" },
  { category: "OTHER", amount: 9200, description: "Housekeeping supplies", daysAgo: 28, paidTo: "Clean Co" },
];

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function padSeq(n: number): string {
  return String(n).padStart(6, "0");
}

async function main() {
  console.log("Seeding Phase 3 finance data...");

  // ── Health Packages ───────────────────────────────
  for (const p of PACKAGES) {
    await prisma.healthPackage.upsert({
      where: { id: `seed-pkg-${p.name.toLowerCase().replace(/\s+/g, "-")}` },
      update: {
        description: p.description,
        services: p.services,
        price: p.price,
        discountPrice: p.discountPrice,
        validityDays: p.validityDays,
        category: p.category,
      },
      create: {
        id: `seed-pkg-${p.name.toLowerCase().replace(/\s+/g, "-")}`,
        name: p.name,
        description: p.description,
        services: p.services,
        price: p.price,
        discountPrice: p.discountPrice,
        validityDays: p.validityDays,
        category: p.category,
      },
    });
  }
  console.log(`  Health packages: ${PACKAGES.length}`);

  // ── Suppliers ─────────────────────────────────────
  const supplierIds: string[] = [];
  for (const s of SUPPLIERS) {
    const sup = await prisma.supplier.upsert({
      where: { name: s.name },
      update: {
        contactPerson: s.contactPerson,
        phone: s.phone,
        email: s.email,
        address: s.address,
        gstNumber: s.gstNumber,
        paymentTerms: s.paymentTerms,
      },
      create: s,
    });
    supplierIds.push(sup.id);
  }
  console.log(`  Suppliers: ${SUPPLIERS.length}`);

  // ── Admin user for PO createdBy ───────────────────
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
  if (!admin) {
    console.log("  Skipping POs & expenses (no ADMIN user found)");
    return;
  }

  // ── Seed PO number counter ────────────────────────
  const poConfig = await prisma.systemConfig.findUnique({
    where: { key: "next_po_number" },
  });
  let nextPoSeq = poConfig ? parseInt(poConfig.value) : 1;

  // ── Get a few medicines to reference ──────────────
  const medicines = await prisma.medicine.findMany({ take: 6 });

  // ── Sample POs ────────────────────────────────────
  const poSpecs: Array<{
    status: PurchaseOrderStatus;
    supplierIdx: number;
    items: Array<{ description: string; quantity: number; unitPrice: number; medicineId?: string }>;
    daysAgo: number;
  }> = [
    {
      status: "DRAFT",
      supplierIdx: 0,
      daysAgo: 2,
      items: [
        {
          description: medicines[0] ? medicines[0].name : "Paracetamol 500mg",
          medicineId: medicines[0]?.id,
          quantity: 500,
          unitPrice: 1.2,
        },
        {
          description: medicines[1] ? medicines[1].name : "Ibuprofen 400mg",
          medicineId: medicines[1]?.id,
          quantity: 300,
          unitPrice: 2.4,
        },
      ],
    },
    {
      status: "APPROVED",
      supplierIdx: 1,
      daysAgo: 7,
      items: [
        {
          description: medicines[2] ? medicines[2].name : "Amoxicillin 500mg",
          medicineId: medicines[2]?.id,
          quantity: 200,
          unitPrice: 4.5,
        },
        {
          description: "Surgical Gloves (Box of 100)",
          quantity: 50,
          unitPrice: 180,
        },
      ],
    },
    {
      status: "RECEIVED",
      supplierIdx: 2,
      daysAgo: 20,
      items: [
        {
          description: medicines[3] ? medicines[3].name : "Cetirizine 10mg",
          medicineId: medicines[3]?.id,
          quantity: 400,
          unitPrice: 1.5,
        },
        {
          description: medicines[4] ? medicines[4].name : "Pantoprazole 40mg",
          medicineId: medicines[4]?.id,
          quantity: 250,
          unitPrice: 3.2,
        },
        {
          description: "Disposable syringes 5ml (pack 100)",
          quantity: 30,
          unitPrice: 250,
        },
      ],
    },
  ];

  for (const spec of poSpecs) {
    const supplierId = supplierIds[spec.supplierIdx];
    const poNumber = `PO${padSeq(nextPoSeq)}`;
    nextPoSeq++;

    const existing = await prisma.purchaseOrder.findUnique({
      where: { poNumber },
    });
    if (existing) continue;

    const subtotal = spec.items.reduce(
      (sum, it) => sum + it.quantity * it.unitPrice,
      0
    );
    const taxAmount = subtotal * 0.05;
    const totalAmount = subtotal + taxAmount;
    const orderedAt = daysAgo(spec.daysAgo);
    const expectedAt = new Date(orderedAt);
    expectedAt.setDate(expectedAt.getDate() + 5);

    await prisma.purchaseOrder.create({
      data: {
        poNumber,
        supplierId,
        status: spec.status,
        orderedAt,
        expectedAt,
        receivedAt: spec.status === "RECEIVED" ? daysAgo(spec.daysAgo - 3) : null,
        subtotal,
        taxAmount,
        totalAmount,
        createdBy: admin.id,
        approvedBy:
          spec.status === "APPROVED" || spec.status === "RECEIVED" ? admin.id : null,
        notes: `Seeded sample PO (${spec.status.toLowerCase()})`,
        items: {
          create: spec.items.map((it) => ({
            description: it.description,
            medicineId: it.medicineId,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            amount: it.quantity * it.unitPrice,
          })),
        },
      },
    });
  }
  console.log(`  Purchase orders: ${poSpecs.length}`);

  // Update sequence counter
  await prisma.systemConfig.upsert({
    where: { key: "next_po_number" },
    create: { key: "next_po_number", value: String(nextPoSeq) },
    update: { value: String(nextPoSeq) },
  });

  // ── Expenses ──────────────────────────────────────
  let expenseCount = 0;
  for (const e of EXPENSE_SEEDS) {
    // Avoid exact duplicates on re-seed (check by description + date)
    const d = daysAgo(e.daysAgo);
    const existing = await prisma.expense.findFirst({
      where: {
        description: e.description,
        date: d,
      },
    });
    if (existing) continue;

    await prisma.expense.create({
      data: {
        category: e.category,
        amount: e.amount,
        description: e.description,
        date: d,
        paidTo: e.paidTo,
        referenceNo: e.referenceNo,
        paidBy: admin.id,
      },
    });
    expenseCount++;
  }
  console.log(`  Expenses: ${expenseCount} (new)`);

  console.log("Finance seed complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
