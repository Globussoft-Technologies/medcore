import { describe, it, expect, vi } from "vitest";
import { z, ZodError } from "zod";
import { validate } from "./validate";

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe("validate", () => {
  const schema = z.object({
    name: z.string().min(1),
    age: z.number().int().nonnegative(),
  });

  it("happy path: parses body and calls next with no args", () => {
    const req: any = { body: { name: "Asha", age: 30 } };
    const res = makeRes();
    const next = vi.fn();
    validate(schema)(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(); // no error argument
    expect(req.body).toEqual({ name: "Asha", age: 30 });
  });

  it("forwards a ZodError to next() on missing field", () => {
    const req: any = { body: { name: "Asha" } }; // age missing
    const res = makeRes();
    const next = vi.fn();
    validate(schema)(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(ZodError);
  });

  it("forwards a ZodError on wrong type", () => {
    const req: any = { body: { name: "Asha", age: "thirty" } };
    const res = makeRes();
    const next = vi.fn();
    validate(schema)(req, res, next);
    const err = next.mock.calls[0][0];
    expect(err).toBeInstanceOf(ZodError);
  });

  it("strips unknown fields by default (zod strips)", () => {
    const req: any = { body: { name: "Asha", age: 30, nickname: "ash" } };
    const res = makeRes();
    const next = vi.fn();
    validate(schema)(req, res, next);
    expect(next).toHaveBeenCalledWith(); // success
    expect(req.body).toEqual({ name: "Asha", age: 30 });
    expect("nickname" in req.body).toBe(false);
  });

  it("applies schema transforms to the body", () => {
    const coerceSchema = z.object({
      age: z.coerce.number().int(),
      flag: z.string().transform((s) => s.toUpperCase()),
    });
    const req: any = { body: { age: "42", flag: "on" } };
    const res = makeRes();
    const next = vi.fn();
    validate(coerceSchema)(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ age: 42, flag: "ON" });
  });
});
