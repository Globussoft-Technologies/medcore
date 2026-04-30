// Integration tests for the chat router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createUserFixture } from "../factories";

let app: any;
let adminToken: string;
let doctorToken: string;
let doctorUserId: string;

describeIfDB("Chat API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    const mod = await import("../../app");
    app = mod.app;
    const prisma = await getPrisma();
    const doc = await prisma.user.findUnique({
      where: { email: "doctor@test.local" },
    });
    doctorUserId = doc!.id;
  });

  async function createOneOnOne() {
    const other = await createUserFixture({ role: "NURSE" });
    const res = await request(app)
      .post("/api/v1/chat/rooms")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ isGroup: false, participantIds: [other.id] });
    return { room: res.body.data, other, status: res.status };
  }

  it("creates a 1-on-1 room with both participants", async () => {
    const { room, status } = await createOneOnOne();
    expect([200, 201]).toContain(status);
    expect(room?.participants?.length).toBe(2);
  });

  it("returns the same room on duplicate 1-on-1 creation", async () => {
    const { room, other } = await createOneOnOne();
    const res = await request(app)
      .post("/api/v1/chat/rooms")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ isGroup: false, participantIds: [other.id] });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.id).toBe(room.id);
  });

  it("lists my rooms", async () => {
    await createOneOnOne();
    const res = await request(app)
      .get("/api/v1/chat/rooms")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("requires auth (401)", async () => {
    const res = await request(app).get("/api/v1/chat/rooms");
    expect(res.status).toBe(401);
  });

  it("rejects bad createRoom payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/chat/rooms")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ participantIds: [] });
    expect(res.status).toBe(400);
  });

  it("sends a message and broadcasts to room (lastMessageAt updated)", async () => {
    const { room } = await createOneOnOne();
    const res = await request(app)
      .post(`/api/v1/chat/rooms/${room.id}/messages`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ content: "Hello team!", type: "TEXT" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.content).toBe("Hello team!");

    const prisma = await getPrisma();
    const r = await prisma.chatRoom.findUnique({ where: { id: room.id } });
    expect(r?.lastMessageAt).toBeTruthy();
  });

  it("non-participants cannot send messages (403)", async () => {
    const { room } = await createOneOnOne();
    // Use RECEPTION (a non-participant role for this room) — ADMIN bypasses
    // the participant check post-#189 (agent-console triage), so the original
    // assertion against adminToken now reasonably 201s.
    const receptionToken = await getAuthToken("RECEPTION");
    const res = await request(app)
      .post(`/api/v1/chat/rooms/${room.id}/messages`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ content: "hi", type: "TEXT" });
    expect(res.status).toBe(403);
  });

  it("marks a room read (lastReadAt stamped)", async () => {
    const { room } = await createOneOnOne();
    const res = await request(app)
      .patch(`/api/v1/chat/rooms/${room.id}/read`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.lastReadAt).toBeTruthy();
  });

  it("toggles a reaction on a message", async () => {
    const { room } = await createOneOnOne();
    const msg = await request(app)
      .post(`/api/v1/chat/rooms/${room.id}/messages`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ content: "React me", type: "TEXT" });
    const res = await request(app)
      .post(`/api/v1/chat/messages/${msg.body.data.id}/reactions`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ emoji: "👍" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.reactions).toBeTruthy();
  });

  it("admin creates a channel (permission: admin-only)", async () => {
    const res = await request(app)
      .post("/api/v1/chat/channels")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: `General-${Date.now()}`, department: "Nursing" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.isChannel).toBe(true);
  });

  it("doctor cannot create a channel (403)", async () => {
    const res = await request(app)
      .post("/api/v1/chat/channels")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ name: "Test", department: "Doctors" });
    expect(res.status).toBe(403);
  });

  it("chat search requires q >= 2 chars (400)", async () => {
    const res = await request(app)
      .get("/api/v1/chat/search?q=x")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(400);
    // keep doctorUserId referenced
    expect(doctorUserId).toBeTruthy();
  });
});
