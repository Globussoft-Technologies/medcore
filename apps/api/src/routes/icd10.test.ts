// Integration test for the ICD-10 search endpoint.
//
// Issue #195: a multi-word query like "essential hypertension" used to be
// passed as a single literal `contains` string and miss
// "Essential (primary) hypertension" because of the parenthetical between
// the words. The endpoint now tokenises whitespace and ANDs the tokens.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, getPrisma, getAuthToken, resetDB } from "../test/setup";

let app: any;
let token: string;

describeIfDB("ICD-10 search (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    token = await getAuthToken("DOCTOR");
    const mod = await import("../app");
    app = mod.app;

    const prisma = await getPrisma();
    // Seed a handful of rows that exercise both the prefix-rank path and
    // the multi-token AND path.
    await prisma.icd10Code.createMany({
      data: [
        {
          code: "I10",
          description: "Essential (primary) hypertension",
          category: "Circulatory",
        },
        {
          code: "I11.0",
          description: "Hypertensive heart disease with heart failure",
          category: "Circulatory",
        },
        {
          code: "I12.0",
          description: "Hypertensive chronic kidney disease, stage 5",
          category: "Circulatory",
        },
        {
          code: "E11",
          description: "Type 2 diabetes mellitus",
          category: "Endocrine",
        },
      ],
      skipDuplicates: true,
    });
  });

  it("returns the I10 row for the single-word query 'hypertension'", async () => {
    const res = await request(app)
      .get("/api/v1/icd10?q=hypertension")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const codes = (res.body.data ?? []).map((r: { code: string }) => r.code);
    expect(codes).toContain("I10");
  });

  it("returns the I10 row for the multi-word query 'essential hypertension'", async () => {
    // Issue #195 regression: this used to return zero rows because the
    // backend did `contains: "essential hypertension"` against the
    // description field, and "Essential (primary) hypertension" doesn't
    // contain that exact substring.
    const res = await request(app)
      .get("/api/v1/icd10?q=essential%20hypertension")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const rows = res.body.data as Array<{ code: string; description: string }>;
    expect(rows.length).toBeGreaterThan(0);
    const codes = rows.map((r) => r.code);
    expect(codes).toContain("I10");
    // I11.0 and I12.0 don't contain "essential" so the AND-of-tokens must
    // exclude them.
    expect(codes).not.toContain("I11.0");
    expect(codes).not.toContain("I12.0");
  });

  it("ranks exact-prefix code hits above body matches", async () => {
    const res = await request(app)
      .get("/api/v1/icd10?q=I10")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const rows = res.body.data as Array<{ code: string }>;
    expect(rows[0]?.code).toBe("I10");
  });
});
