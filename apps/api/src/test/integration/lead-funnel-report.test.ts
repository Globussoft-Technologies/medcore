// Integration tests for GET /api/v1/analytics/lead-funnel-report — the
// Lead → Patient conversion funnel report that closes Pearl §4.4 row 115.
// Aggregates Lead rows by current status (NEW / QUALIFIED / ENGAGED / BOOKED
// / CONVERTED / LOST) + by source + computes the overall conversion rate so
// marketing can see funnel-stage drop-off. Powered by Pearl gap #3 data
// model (Lead + LeadActivity + CONVERSION activity row, post-`928018f`).
//
// Covers: default-range aggregation + totals math, source filter,
// from/to date filter, CSV export (content-type + filename + audit row),
// zero-data edge case (no divide-by-zero), non-ADMIN 403, byStage
// always-six invariant.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import {
  describeIfDB,
  resetDB,
  getAuthToken,
  getPrisma,
} from "../setup";
import { waitForAuditFlush } from "../helpers/audit-wait";

let app: any;
let adminToken: string;
let doctorToken: string;
let receptionToken: string;

const ALL_STAGES = ["NEW", "QUALIFIED", "ENGAGED", "BOOKED", "CONVERTED", "LOST"] as const;

/**
 * Seed a Lead row directly via Prisma. The factories.ts file doesn't yet
 * have a createLeadFixture (Lead model shipped in `928018f` for Pearl gap #3
 * after the factory file was last touched), so spell it out inline.
 */
async function seedLead(args: {
  status?: string;
  source?: string;
  name?: string;
}) {
  const prisma = await getPrisma();
  return prisma.lead.create({
    data: {
      name: args.name ?? `Lead ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      phone: `9${Math.floor(Math.random() * 1e9).toString().padStart(9, "0")}`,
      source: (args.source ?? "WEB") as any,
      status: (args.status ?? "NEW") as any,
    },
  });
}

describeIfDB("Analytics lead-funnel-report (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    receptionToken = await getAuthToken("RECEPTION");
    const mod = await import("../../app");
    app = mod.app;

    // 10 leads spread across the 6 stages + 3 sources so the funnel math
    // is non-trivial:
    //   NEW         × 2  (1 WEB,      1 WHATSAPP)
    //   QUALIFIED   × 2  (1 WEB,      1 REFERRAL)
    //   ENGAGED     × 1  (1 WHATSAPP)
    //   BOOKED      × 1  (1 WHATSAPP)
    //   CONVERTED   × 3  (1 WEB,      2 WHATSAPP)
    //   LOST        × 1  (1 REFERRAL)
    //
    // Totals: 10 leads, 3 converted (30%), 1 lost, 6 open (NEW+QUALIFIED+ENGAGED+BOOKED)
    // By source (derived from the per-stage rows above — do NOT re-count;
    // the original "4 WEB / 4 WHATSAPP" comment was a miscount that shipped
    // wrong assertions and turned main red on `aeb625a`):
    //   WEB:      3 leads, 1 converted (33.33%)  [NEW + QUALIFIED + CONVERTED]
    //   WHATSAPP: 5 leads, 2 converted (40%)     [NEW + ENGAGED + BOOKED + 2×CONVERTED]
    //   REFERRAL: 2 leads, 0 converted (0%)      [QUALIFIED + LOST]
    await seedLead({ status: "NEW",       source: "WEB" });
    await seedLead({ status: "NEW",       source: "WHATSAPP" });
    await seedLead({ status: "QUALIFIED", source: "WEB" });
    await seedLead({ status: "QUALIFIED", source: "REFERRAL" });
    await seedLead({ status: "ENGAGED",   source: "WHATSAPP" });
    await seedLead({ status: "BOOKED",    source: "WHATSAPP" });
    await seedLead({ status: "CONVERTED", source: "WEB" });
    await seedLead({ status: "CONVERTED", source: "WHATSAPP" });
    await seedLead({ status: "CONVERTED", source: "WHATSAPP" });
    await seedLead({ status: "LOST",      source: "REFERRAL" });
  });

  it("aggregates funnel totals + per-stage + per-source over default window", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/lead-funnel-report")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const { totals, byStage, bySource, dateRange, filters } = res.body.data;
    expect(dateRange.from).toBeTruthy();
    expect(dateRange.to).toBeTruthy();
    expect(filters).toEqual({ source: null, branchId: null });

    expect(totals.totalLeads).toBe(10);
    expect(totals.convertedLeads).toBe(3);
    expect(totals.lostLeads).toBe(1);
    expect(totals.openLeads).toBe(6);
    expect(totals.conversionRate).toBe(30);

    // byStage always emits all 6 stages in canonical order, zero-filled.
    expect(byStage).toHaveLength(6);
    expect(byStage.map((s: any) => s.stage)).toEqual([...ALL_STAGES]);

    const stageByName: Record<string, any> = {};
    for (const s of byStage) stageByName[s.stage] = s;
    expect(stageByName.NEW.count).toBe(2);
    expect(stageByName.QUALIFIED.count).toBe(2);
    expect(stageByName.ENGAGED.count).toBe(1);
    expect(stageByName.BOOKED.count).toBe(1);
    expect(stageByName.CONVERTED.count).toBe(3);
    expect(stageByName.LOST.count).toBe(1);
    expect(stageByName.CONVERTED.percentOfTotal).toBe(30);

    // bySource only emits sources present (3 of the 6 LeadSource values).
    expect(bySource).toHaveLength(3);
    const srcByName: Record<string, any> = {};
    for (const b of bySource) srcByName[b.source] = b;
    expect(srcByName.WEB).toEqual({ source: "WEB", count: 3, converted: 1, rate: 33.33 });
    expect(srcByName.WHATSAPP).toEqual({ source: "WHATSAPP", count: 5, converted: 2, rate: 40 });
    expect(srcByName.REFERRAL).toEqual({ source: "REFERRAL", count: 2, converted: 0, rate: 0 });
  });

  it("filters by source=WHATSAPP to narrow the rollup", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/lead-funnel-report?source=WHATSAPP")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const { totals, bySource, filters } = res.body.data;
    expect(filters.source).toBe("WHATSAPP");
    expect(totals.totalLeads).toBe(5);
    expect(totals.convertedLeads).toBe(2);
    expect(totals.conversionRate).toBe(40);
    expect(bySource).toHaveLength(1);
    expect(bySource[0].source).toBe("WHATSAPP");
    expect(bySource[0].count).toBe(5);
  });

  it("rejects an invalid source filter with 400", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/lead-funnel-report?source=NOT_A_SOURCE")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source/i);
  });

  it("narrows window with from/to filters", async () => {
    // 5 years in the past — no leads seeded there. Confirms the createdAt
    // filter actually narrows. (The default window picks up everything
    // because all seeded leads land in the current month / now.)
    const past = new Date();
    past.setFullYear(past.getFullYear() - 5);
    const pastStart = new Date(past.getFullYear(), past.getMonth(), 1).toISOString();
    const pastEnd = new Date(past.getFullYear(), past.getMonth(), 28).toISOString();
    const res = await request(app)
      .get(`/api/v1/analytics/lead-funnel-report?from=${pastStart}&to=${pastEnd}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totals.totalLeads).toBe(0);
    expect(res.body.data.bySource).toEqual([]);
  });

  it("handles empty window without divide-by-zero", async () => {
    const past = new Date();
    past.setFullYear(past.getFullYear() - 5);
    const pastStart = new Date(past.getFullYear(), past.getMonth(), 1).toISOString();
    const pastEnd = new Date(past.getFullYear(), past.getMonth(), 28).toISOString();
    const res = await request(app)
      .get(`/api/v1/analytics/lead-funnel-report?from=${pastStart}&to=${pastEnd}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totals).toEqual({
      totalLeads: 0,
      convertedLeads: 0,
      conversionRate: 0,
      lostLeads: 0,
      openLeads: 0,
    });
    // All 6 stage buckets still emitted with zero counts (CSV-alignment invariant).
    expect(res.body.data.byStage).toHaveLength(6);
    for (const s of res.body.data.byStage) {
      expect(s.count).toBe(0);
      expect(s.percentOfTotal).toBe(0);
    }
  });

  it("exports CSV with attachment headers + audit row (LEAD_FUNNEL_REPORT_EXPORTED)", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/lead-funnel-report?format=csv")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment;/);
    expect(res.headers["content-disposition"]).toMatch(
      /filename="lead-funnel-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv"/,
    );

    const text = res.text;
    // Summary section
    expect(text).toContain("Report,Lead Funnel");
    expect(text).toContain("Total Leads,10");
    expect(text).toContain("Converted,3");
    expect(text).toContain("Conversion Rate %,30");
    // Stage breakdown header + at least one stage row
    expect(text).toContain("Stage,Count,Percent Of Total %");
    expect(text).toMatch(/CONVERTED,3,30/);
    // Source breakdown header
    expect(text).toContain("Source,Count,Converted,Conversion Rate %");
    expect(text).toMatch(/WHATSAPP,5,2,40/);

    // Audit row is written fire-and-forget — poll until it lands.
    const prisma = await getPrisma();
    const row = await waitForAuditFlush(prisma, {
      action: "LEAD_FUNNEL_REPORT_EXPORTED",
      entity: "lead",
    });
    expect(row).toBeTruthy();
    const details = row.details as any;
    expect(details.format).toBe("csv");
    expect(details.source).toBe(null);
  });

  it("rejects non-ADMIN callers (DOCTOR → 403, RECEPTION → 403)", async () => {
    const doctorRes = await request(app)
      .get("/api/v1/analytics/lead-funnel-report")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(doctorRes.status).toBe(403);

    const recRes = await request(app)
      .get("/api/v1/analytics/lead-funnel-report")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(recRes.status).toBe(403);
  });

  it("rejects invalid `from` date with 400", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/lead-funnel-report?from=not-a-date")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/from/i);
  });
});
