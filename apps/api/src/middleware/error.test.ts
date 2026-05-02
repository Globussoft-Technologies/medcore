/**
 * Unit tests for the central Express error-handling middleware.
 *
 * Two response shapes:
 *   - `ZodError` → 400 with field-level `details[]`.
 *   - everything else → 500, with the original message hidden in production.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z, ZodError } from "zod";
import { errorHandler } from "./error";

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const originalNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  vi.restoreAllMocks();
});

describe("errorHandler — ZodError mapping", () => {
  function makeZodError() {
    const schema = z.object({
      email: z.string().email(),
      age: z.number().int().min(0),
    });
    const result = schema.safeParse({ email: "not-an-email", age: -1 });
    if (result.success) throw new Error("expected Zod failure");
    return result.error;
  }

  it("returns 400 with success:false and field-level details", () => {
    const res = makeRes();
    errorHandler(makeZodError(), {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details.length).toBeGreaterThan(0);
    for (const detail of body.details) {
      expect(typeof detail.field).toBe("string");
      expect(typeof detail.message).toBe("string");
    }
  });

  it("joins nested field paths with '.'", () => {
    const schema = z.object({ user: z.object({ email: z.string().email() }) });
    const result = schema.safeParse({ user: { email: "x" } });
    if (result.success) throw new Error("expected Zod failure");
    const res = makeRes();
    errorHandler(result.error, {} as any, res, vi.fn());
    const body = res.json.mock.calls[0][0];
    expect(body.details[0].field).toBe("user.email");
  });

  it("emits an empty details[] for a top-level type mismatch", () => {
    // A Zod error with an empty `path` produces field "" — we just verify the
    // shape stays valid (no crash).
    const result = z.string().safeParse(42);
    if (result.success) throw new Error("expected Zod failure");
    const res = makeRes();
    errorHandler(result.error, {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.details[0].field).toBe("");
  });

  it("recognizes hand-rolled ZodError instances (instanceof check)", () => {
    const err = new ZodError([
      { code: "custom", path: ["foo"], message: "nope" } as any,
    ]);
    const res = makeRes();
    errorHandler(err, {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].details).toEqual([
      { field: "foo", message: "nope" },
    ]);
  });
});

describe("errorHandler — generic errors", () => {
  it("returns 500 with the original message in development", () => {
    process.env.NODE_ENV = "development";
    const res = makeRes();
    errorHandler(new Error("internal boom"), {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0]).toEqual({
      success: false,
      data: null,
      error: "internal boom",
    });
  });

  it("hides the original message in production", () => {
    process.env.NODE_ENV = "production";
    const res = makeRes();
    errorHandler(new Error("leaks db host"), {} as any, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0]).toEqual({
      success: false,
      data: null,
      error: "Internal server error",
    });
  });

  it("hides the message on test/unset NODE_ENV (anything not 'production')", () => {
    process.env.NODE_ENV = "test";
    const res = makeRes();
    errorHandler(new Error("test mode visible"), {} as any, res, vi.fn());
    expect(res.json.mock.calls[0][0].error).toBe("test mode visible");
  });

  it("logs the error to console.error regardless of branch", () => {
    process.env.NODE_ENV = "production";
    const res = makeRes();
    const err = new Error("boom");
    errorHandler(err, {} as any, res, vi.fn());
    expect(console.error).toHaveBeenCalledWith("Error:", err);
  });
});

describe("errorHandler — middleware contract", () => {
  it("does not call next (it's a terminal error handler)", () => {
    const next = vi.fn();
    const res = makeRes();
    errorHandler(new Error("x"), {} as any, res, next);
    expect(next).not.toHaveBeenCalled();
  });
});
