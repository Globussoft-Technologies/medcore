/**
 * Issue #288 (2026-04-30) — Pin the contract for PATCH /expenses/:id/approve.
 *
 * The Admin Console used to POST an empty body to this route. Zod then
 * rejected with a 400 because `approveExpenseSchema` requires `approved`
 * — but the FE catch-block dropped the field-level error and showed a
 * generic "Approve failed" toast. After teaching the FE to send the
 * real `{ approved: true }` payload we want the green-path covered, plus
 * the precondition message admins now see when they double-click an
 * already-approved row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    expense: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn(async () => ({ id: "al-x" })) },
    systemConfig: { findUnique: vi.fn(async () => null) },
    $extends(_c: unknown) {
      return base;
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

import { expenseRouter } from "./expenses";
import { errorHandler } from "../middleware/error";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/expenses", expenseRouter);
  // Use the real error handler — we assert the ZodError → 400 +
  // `details: [{ field, message }]` shape that the FE depends on for
  // its toast / per-field error rendering.
  app.use(errorHandler);
  return app;
}

function adminToken(): string {
  return jwt.sign(
    { userId: "u-admin", email: "a@test.local", role: "ADMIN" },
    "test-secret"
  );
}

describe("Issue #288 — PATCH /expenses/:id/approve", () => {
  beforeEach(() => {
    prismaMock.expense.findUnique.mockReset();
    prismaMock.expense.update.mockReset();
  });

  it("approves a PENDING expense when sent { approved: true } (happy path used by Admin Console card)", async () => {
    prismaMock.expense.findUnique.mockResolvedValueOnce({
      id: "exp-1",
      approvalStatus: "PENDING",
      amount: 75000,
    });
    prismaMock.expense.update.mockResolvedValueOnce({
      id: "exp-1",
      approvalStatus: "APPROVED",
      amount: 75000,
      approvedBy: "u-admin",
      approvedAt: new Date(),
    });

    const res = await request(buildApp())
      .patch("/api/v1/expenses/exp-1/approve")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ approved: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.approvalStatus).toBe("APPROVED");
    expect(prismaMock.expense.update).toHaveBeenCalledOnce();
  });

  it("returns 400 zod field-level details when the body is empty (the prior-failing case the FE used to send)", async () => {
    const res = await request(buildApp())
      .patch("/api/v1/expenses/exp-2/approve")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    // The validate middleware emits `details: [{ field, message }]`
    // which the FE pipes through `extractFieldErrors`. A non-array or
    // empty list here would silently regress that toast surface.
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThan(0);
    expect(prismaMock.expense.update).not.toHaveBeenCalled();
  });

  it("returns 400 with a specific 'already APPROVED' message when the expense isn't PENDING", async () => {
    prismaMock.expense.findUnique.mockResolvedValueOnce({
      id: "exp-3",
      approvalStatus: "APPROVED",
      amount: 5000,
    });

    const res = await request(buildApp())
      .patch("/api/v1/expenses/exp-3/approve")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ approved: true });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(String(res.body.error)).toMatch(/already APPROVED/i);
    expect(prismaMock.expense.update).not.toHaveBeenCalled();
  });
});
