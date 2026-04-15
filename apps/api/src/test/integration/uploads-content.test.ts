// Content-integrity integration test for /api/v1/uploads.
// Verifies an uploaded buffer can be re-fetched byte-for-byte and also that
// the file actually lands on local disk under uploads/ehr/ (current backend).
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { describeIfDB, resetDB, getAuthToken } from "../setup";

let app: any;
let token: string;

describeIfDB("Uploads content integrity (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    token = await getAuthToken("ADMIN");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("uploads a binary buffer and re-fetches identical bytes", async () => {
    // Pseudo-random buffer (~64KB) so we know we're not just round-tripping
    // a buffer of repeating bytes.
    const original = crypto.randomBytes(64 * 1024);
    const b64 = original.toString("base64");

    const up = await request(app)
      .post("/api/v1/uploads")
      .set("Authorization", `Bearer ${token}`)
      .send({
        filename: "content-integrity.bin",
        base64Content: b64,
        type: "OTHER",
      });
    expect([200, 201]).toContain(up.status);
    expect(up.body.data?.fileSize).toBe(original.length);
    const stored: string = up.body.data.filename;
    const filePath: string = up.body.data.filePath;
    expect(filePath).toBe(`uploads/ehr/${stored}`);

    // 1) Fetch via the HTTP endpoint and assert byte equality
    const get = await request(app)
      .get(`/api/v1/uploads/${stored}`)
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(get.status).toBe(200);
    const fetched: Buffer = (get as any).body;
    expect(Buffer.isBuffer(fetched)).toBe(true);
    expect(fetched.length).toBe(original.length);
    expect(fetched.equals(original)).toBe(true);

    // 2) Sanity-check: file actually exists on local disk (current backend
    //    is the local fs, not S3 / Cloudinary). This documents the fact —
    //    if storage is moved to a bucket, change this assertion.
    const onDisk = path.join(process.cwd(), "uploads", "ehr", stored);
    expect(fs.existsSync(onDisk)).toBe(true);
    const diskBytes = fs.readFileSync(onDisk);
    expect(diskBytes.equals(original)).toBe(true);
  });
});
