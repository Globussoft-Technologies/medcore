// security(2026-04-23-med): tests for the shared validateUuidParams
// middleware — verifies malformed UUIDs produce a clean 400 and never reach
// the handler (so they never reach prisma.findUnique either).
import { describe, it, expect, vi } from "vitest";
import { validateUuidParams } from "./validate-params";

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const VALID_UUID = "11111111-2222-3333-4444-555555555555";

describe("validateUuidParams", () => {
  it("calls next() when all declared params are valid UUIDs", () => {
    const req: any = {
      params: { id: VALID_UUID, patientId: VALID_UUID },
    };
    const res = makeRes();
    const next = vi.fn();

    validateUuidParams(["id", "patientId"])(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects non-UUID values with a 400 and does not call next", () => {
    const req: any = { params: { id: "not-a-uuid" } };
    const res = makeRes();
    const next = vi.fn();

    validateUuidParams(["id"])(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.stringMatching(/invalid id/i),
      })
    );
  });

  it("rejects missing params (undefined) with 400", () => {
    const req: any = { params: {} };
    const res = makeRes();
    const next = vi.fn();

    validateUuidParams(["id"])(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("fails fast on the first bad param and includes its name in the error", () => {
    const req: any = {
      params: { id: VALID_UUID, patientId: "garbage", other: VALID_UUID },
    };
    const res = makeRes();
    const next = vi.fn();

    validateUuidParams(["id", "patientId", "other"])(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining("patientId"),
      })
    );
  });
});
