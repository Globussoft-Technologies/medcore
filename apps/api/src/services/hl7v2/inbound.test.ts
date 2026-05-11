/**
 * Unit tests for the HL7 v2 inbound ingest path.
 *
 * These exercise `dispatchMessage`, `buildACK`, and the three reverse
 * mappers through an in-memory Prisma mock so we don't need a live DB. The
 * mock simulates the minimum surface area each mapper touches (patient,
 * user, labOrder, labOrderItem, labResult, labTest, doctor, bed, admission)
 * plus `$transaction` which we collapse into a synchronous call on the mock.
 *
 * Why a hand-rolled mock rather than `vi.mock("@medcore/db")`:
 *   - vi.mock's hoisting + ESM interop is brittle across our monorepo setup.
 *   - The assertions target specific rows / counters, which a tiny mock
 *     makes very explicit.
 *   - This file stays independent of a running Postgres instance so it runs
 *     on every CI node, not just the DB-equipped ones.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── In-memory Prisma mock ────────────────────────────────────────────────
type Row = Record<string, unknown>;
const state: {
  users: Row[];
  patients: Row[];
  doctors: Row[];
  beds: Row[];
  admissions: Row[];
  labTests: Row[];
  labOrders: Row[];
  labOrderItems: Row[];
  labResults: Row[];
  seq: number;
} = {
  users: [],
  patients: [],
  doctors: [],
  beds: [],
  admissions: [],
  labTests: [],
  labOrders: [],
  labOrderItems: [],
  labResults: [],
  seq: 0,
};

function nextId(prefix: string): string {
  state.seq++;
  return `${prefix}-${state.seq}`;
}

function matchesWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === "object" && "in" in (v as Row)) {
      const arr = (v as { in: unknown[] }).in;
      if (!arr.includes(row[k])) return false;
    } else {
      if (row[k] !== v) return false;
    }
  }
  return true;
}

function mkDelegate(
  key: keyof typeof state,
  idPrefix: string,
  options: { include?: string[] } = {}
) {
  const table = () => state[key] as Row[];
  return {
    async create({ data, include }: { data: Row; include?: Row }) {
      const row: Row = { id: nextId(idPrefix), ...data };
      // Handle nested `items: { create: [...] }` for labOrder.create.
      if (key === "labOrders" && data.items && typeof data.items === "object") {
        const items = (data.items as { create?: Row[] }).create ?? [];
        for (const it of items) {
          const item = { id: nextId("item"), orderId: row.id, ...it };
          state.labOrderItems.push(item);
        }
        delete (row as Row).items;
      }
      table().push(row);
      void options;
      // If include was requested, re-hydrate relations on the returned row.
      if (include) {
        return withIncludes(key, row, include);
      }
      return row;
    },
    async createMany({ data }: { data: Row[] }) {
      for (const d of data) {
        table().push({ id: nextId(idPrefix), ...d });
      }
      return { count: data.length };
    },
    async update({ where, data }: { where: Row; data: Row }) {
      const idx = table().findIndex((r) => matchesWhere(r, where));
      if (idx === -1) throw new Error(`update: row not found in ${String(key)}`);
      table()[idx] = { ...table()[idx], ...data };
      return table()[idx];
    },
    async findUnique({ where, include }: { where: Row; include?: Row }) {
      const row = table().find((r) => matchesWhere(r, where));
      if (!row) return null;
      return withIncludes(key, row, include);
    },
    async findFirst({ where, include }: { where?: Row; include?: Row } = {}) {
      const row = table().find((r) => matchesWhere(r, where));
      if (!row) return null;
      return withIncludes(key, row, include);
    },
    async findMany({ where }: { where?: Row } = {}) {
      return table().filter((r) => matchesWhere(r, where));
    },
  };
}

function withIncludes(
  key: keyof typeof state,
  row: Row,
  include?: Row
): Row {
  if (!include) return row;
  const out: Row = { ...row };
  if (key === "patients" && "user" in include) {
    out.user = state.users.find((u) => u.id === row.userId) ?? null;
  }
  if (key === "labOrders" && "items" in include) {
    const items = state.labOrderItems.filter((i) => i.orderId === row.id);
    const itemsIncluded = items.map((it) => {
      const obj: Row = { ...it };
      const incOpts = include.items as Row;
      if (incOpts && "include" in incOpts) {
        const nested = (incOpts.include as Row) ?? {};
        if ("test" in nested) {
          obj.test = state.labTests.find((t) => t.id === it.testId) ?? null;
        }
      }
      return obj;
    });
    out.items = itemsIncluded;
  }
  return out;
}

const mockPrisma: Row = {
  user: mkDelegate("users", "user"),
  patient: mkDelegate("patients", "pat"),
  doctor: mkDelegate("doctors", "doc"),
  bed: mkDelegate("beds", "bed"),
  admission: mkDelegate("admissions", "adm"),
  labTest: mkDelegate("labTests", "test"),
  labOrder: mkDelegate("labOrders", "order"),
  labOrderItem: mkDelegate("labOrderItems", "item"),
  labResult: mkDelegate("labResults", "res"),
  $transaction: async (fn: (tx: Row) => Promise<unknown>) => fn(mockPrisma),
};

// vi.mock is hoisted — the factory must not close over any outer binding
// initialised above it. We reference mockPrisma lazily via globalThis so
// the hoist order doesn't matter.
(globalThis as Record<string, unknown>).__hl7InboundTestPrisma = mockPrisma;

vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => { throw new Error("tenant ctx required"); },
  get prisma() {
    return (globalThis as Record<string, unknown>).__hl7InboundTestPrisma;
  },
}));

import { parseMessage } from "./parser";
import { MSH, PID, OBX, OBR, ORC, escapeField } from "./segments";
import {
  dispatchMessage,
  buildACK,
  ingestADT_A04,
  ingestORM_O01,
  ingestORU_R01,
} from "./inbound";

// ── Fixture helpers ─────────────────────────────────────────────────────

function seed() {
  state.users.length = 0;
  state.patients.length = 0;
  state.doctors.length = 0;
  state.beds.length = 0;
  state.admissions.length = 0;
  state.labTests.length = 0;
  state.labOrders.length = 0;
  state.labOrderItems.length = 0;
  state.labResults.length = 0;
  state.seq = 0;

  state.doctors.push({ id: "doc-seed", userId: "u-doc" });
  state.beds.push({ id: "bed-seed", status: "AVAILABLE" });
  state.labTests.push({
    id: "test-cbc",
    code: "CBC",
    name: "Complete Blood Count",
  });
  state.labTests.push({
    id: "test-lft",
    code: "LFT",
    name: "Liver Function",
  });
}

function msh(messageType: string, ctrlId = "CTRL001"): string {
  return `MSH|^~\\&|LAB|LAB_FAC|MEDCORE|MEDCORE_HIS|20260423100000||${messageType}|${ctrlId}|P|2.5.1|||||||UNICODE UTF-8`;
}

/** Build an ADT^A04 with the given MR number + name. */
function adtA04Fixture(mr: string, name = "Sharma^Arjun"): string {
  return [
    msh("ADT^A04^ADT_A01", "ADT-1"),
    `PID|1||${mr}^^^MR^MR||${name}||19850615|M||||${escapeField(
      "12 Park Street"
    )}^^Kolkata^WB^^IN`,
    "PV1|1|O",
    "",
  ].join("\r");
}

function ormO01Fixture(
  mr: string,
  placer: string,
  testCodes: string[] = ["CBC"]
): string {
  const segs: string[] = [
    msh("ORM^O01^ORM_O01", "ORM-1"),
    `PID|1||${mr}^^^MR^MR||Sharma^Arjun||19850615|M`,
  ];
  testCodes.forEach((code, idx) => {
    segs.push(`ORC|NW|${placer}||||SC`);
    segs.push(
      `OBR|${idx + 1}|${placer}||${code}^Test Name^LN|||20260423094500`
    );
  });
  segs.push("");
  return segs.join("\r");
}

function oruR01Fixture(
  mr: string,
  placer: string,
  testCode = "CBC"
): string {
  return [
    msh("ORU^R01^ORU_R01", "ORU-1"),
    `PID|1||${mr}^^^MR^MR||Sharma^Arjun||19850615|M`,
    `OBR|1|${placer}||${testCode}^Complete Blood Count^LN`,
    "OBX|1|NM|HGB^Hemoglobin^LN||13.5|g/dL|12-16|N|||F",
    "OBX|2|NM|WBC^WBC Count^LN||7.2|10^3/uL|4-11|N|||F",
    "",
  ].join("\r");
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("HL7 v2 inbound reverse-mappers", () => {
  beforeEach(() => {
    seed();
  });

  // 1. ADT^A04 creates a new Patient
  it("ADT^A04 creates a new Patient when MR number is unknown", async () => {
    const msg = parseMessage(adtA04Fixture("MR-NEW-001"));
    const result = await ingestADT_A04(msg);
    expect(result.action).toBe("created");
    expect(result.entity).toBe("Patient");
    expect(state.patients.length).toBe(1);
    expect(state.patients[0].mrNumber).toBe("MR-NEW-001");
    // Admission is skipped for outpatient (PV1-2=O).
    expect(state.admissions.length).toBe(0);
  });

  // 2. ADT^A04 updates an existing Patient
  it("ADT^A04 with an existing MR number updates the patient", async () => {
    // Pre-seed a patient with the same MR.
    state.users.push({ id: "u-existing", name: "Old Name", phone: "0" });
    state.patients.push({
      id: "p-existing",
      userId: "u-existing",
      mrNumber: "MR-EXIST-001",
      gender: "OTHER",
      dateOfBirth: null,
      address: null,
    });
    const msg = parseMessage(adtA04Fixture("MR-EXIST-001"));
    const result = await ingestADT_A04(msg);
    expect(result.action).toBe("updated");
    expect(result.entityId).toBe("p-existing");
    // Sex should have been updated to MALE (PID-8=M).
    expect(state.patients[0].gender).toBe("MALE");
  });

  // 3. ORM^O01 creates LabOrder + items
  it("ORM^O01 creates a LabOrder + LabOrderItem rows", async () => {
    // Need the patient first.
    state.users.push({ id: "u-p", name: "X", phone: "1" });
    state.patients.push({
      id: "p-1",
      userId: "u-p",
      mrNumber: "MR-ORD-001",
    });
    const msg = parseMessage(
      ormO01Fixture("MR-ORD-001", "PLACER-001", ["CBC", "LFT"])
    );
    const result = await ingestORM_O01(msg);
    expect(result.action).toBe("created");
    expect(state.labOrders.length).toBe(1);
    expect(state.labOrders[0].orderNumber).toBe("PLACER-001");
    expect(state.labOrderItems.length).toBe(2);
    const codes = state.labOrderItems
      .map((i) => state.labTests.find((t) => t.id === i.testId)?.code)
      .sort();
    expect(codes).toEqual(["CBC", "LFT"]);
  });

  // 4. ORU^R01 writes LabResult rows
  it("ORU^R01 writes LabResult rows when the parent order exists", async () => {
    state.users.push({ id: "u-p2", name: "X", phone: "1" });
    state.patients.push({
      id: "p-2",
      userId: "u-p2",
      mrNumber: "MR-RES-001",
    });
    state.labOrders.push({
      id: "order-exist",
      orderNumber: "PLACER-EXIST",
      patientId: "p-2",
      doctorId: "doc-seed",
      status: "ORDERED",
      orderedAt: new Date(),
    });
    state.labOrderItems.push({
      id: "item-exist",
      orderId: "order-exist",
      testId: "test-cbc",
    });
    const msg = parseMessage(oruR01Fixture("MR-RES-001", "PLACER-EXIST"));
    const result = await ingestORU_R01(msg);
    expect(result.action).toBe("created");
    expect(state.labResults.length).toBe(2);
    expect(state.labResults[0].value).toBe("13.5");
    expect(state.labResults[0].unit).toBe("g/dL");
    expect(state.labResults[0].normalRange).toBe("12-16");
    // No parent order was auto-created.
    expect(state.labOrders.length).toBe(1);
  });

  // 5. ORU^R01 auto-creates a minimal order when none exists
  it("ORU^R01 auto-creates a minimal LabOrder when no parent exists", async () => {
    state.users.push({ id: "u-p3", name: "X", phone: "1" });
    state.patients.push({
      id: "p-3",
      userId: "u-p3",
      mrNumber: "MR-ORPH-001",
    });
    const msg = parseMessage(oruR01Fixture("MR-ORPH-001", "PLACER-ORPH"));
    const result = await ingestORU_R01(msg);
    expect(result.action).toBe("created");
    expect(state.labOrders.length).toBe(1);
    expect(state.labOrders[0].orderNumber).toBe("PLACER-ORPH");
    expect(state.labOrders[0].notes).toBe("[HL7v2 autocreated]");
    expect(state.labResults.length).toBe(2);
  });

  // 6. Unsupported message type → dispatchMessage throws → route uses AR
  it("dispatchMessage rejects SIU^S12 with a clear error", async () => {
    const raw = [
      msh("SIU^S12^SIU_S12", "SIU-1"),
      "SCH|1|||||||Appointment",
      "",
    ].join("\r");
    const parsed = parseMessage(raw);
    await expect(dispatchMessage(parsed)).rejects.toThrow(
      /Unsupported HL7 v2 message type/
    );
  });

  // 7. Field escaping survives round-trip
  it('PID-5 with an escaped \\F\\ (|) is correctly decoded to "|"', async () => {
    // Build a PID with a real `|` in the given name, then escape it.
    const msgRaw = [
      msh("ADT^A04^ADT_A01", "ESC-1"),
      `PID|1||MR-ESC-001^^^MR^MR||${escapeField("O|Brien")}^Anne`,
      "PV1|1|O",
      "",
    ].join("\r");
    const parsed = parseMessage(msgRaw);
    const result = await ingestADT_A04(parsed);
    expect(result.action).toBe("created");
    // The parsed family name should have been round-tripped to the real `|`.
    const user = state.users.find(
      (u) => u.id === state.patients[0].userId
    );
    expect((user?.name as string).includes("O|Brien")).toBe(true);
  });

  // 7b. Devanagari passes through untouched
  it("Devanagari in PID-5 passes through to the stored name", async () => {
    const msgRaw = [
      msh("ADT^A04^ADT_A01", "UN-1"),
      `PID|1||MR-UNI-001^^^MR^MR||शर्मा^राहुल||19900101|M`,
      "PV1|1|O",
      "",
    ].join("\r");
    const parsed = parseMessage(msgRaw);
    await ingestADT_A04(parsed);
    const user = state.users.find(
      (u) => u.id === state.patients[0].userId
    );
    expect((user?.name as string).includes("शर्मा")).toBe(true);
    expect((user?.name as string).includes("राहुल")).toBe(true);
  });

  // 8. ACK construction — MSA-2 echoes original MSH-10, MSH-9 is ACK^<trigger>
  it("buildACK echoes MSH-10 into MSA-2 and sets MSH-9 to ACK^<trigger>", async () => {
    const original = parseMessage(adtA04Fixture("MR-ACK-001"));
    const ack = buildACK(original, "AA", "All good");
    expect(ack.endsWith("\r")).toBe(true);
    expect(ack.includes("\n")).toBe(false);
    const parsed = parseMessage(ack);
    // MSH-9 structure for ACKs: ACK^<trigger>^ACK
    expect(parsed.segments[0].fields[9]).toBe("ACK^A04^ACK");
    // MSA-2 should equal the original MSH-10.
    const msa = parsed.segments.find((s) => s.id === "MSA");
    expect(msa).toBeDefined();
    expect(msa!.fields[1]).toBe("AA");
    expect(msa!.fields[2]).toBe("ADT-1");
    expect(msa!.fields[3]).toBe("All good");
  });

  // 9. ACK has CR-only terminators
  it("buildACK produces CR-only terminators (no LF)", () => {
    const original = parseMessage(ormO01Fixture("MR-XYZ", "P-XYZ"));
    const ack = buildACK(original, "AE", "warn\nwith\rnewlines");
    expect(ack.includes("\n")).toBe(false);
    // Sanitised text must not break the segment grid.
    const parsed = parseMessage(ack);
    expect(parsed.segments[0].id).toBe("MSH");
    expect(parsed.segments[1].id).toBe("MSA");
  });
});

// Keep exported symbols used so unused-import ESLint doesn't complain.
void MSH;
void PID;
void OBX;
void OBR;
void ORC;
