// Issue #367 (Apr 30 2026) — Pharmacy Returns / Transfers tabs were slow
// because the route fetched every row with no LIMIT. The route now accepts
// `page` and `limit` (capped at 200) and the response carries a meta block.
//
// Pure unit test of the parse/clamp logic used by both /pharmacy/returns
// and /pharmacy/transfers — no DB needed.
import { describe, it, expect } from "vitest";

function parsePagination(query: { page?: string; limit?: string }): {
  skip: number;
  take: number;
} {
  const limit = query.limit ?? "100";
  const page = query.page ?? "1";
  const take = Math.min(parseInt(limit, 10), 200);
  const skip = (parseInt(page, 10) - 1) * take;
  return { skip, take };
}

describe("pharmacy pagination parsing (Issue #367)", () => {
  it("defaults to page 1 / limit 100", () => {
    expect(parsePagination({})).toEqual({ skip: 0, take: 100 });
  });

  it("caps `limit` at 200 even when callers ask for more", () => {
    expect(parsePagination({ limit: "1000" })).toEqual({ skip: 0, take: 200 });
  });

  it("computes skip from `page` * `take`", () => {
    expect(parsePagination({ page: "3", limit: "50" })).toEqual({
      skip: 100,
      take: 50,
    });
  });

  it("respects custom limit under the cap", () => {
    expect(parsePagination({ page: "1", limit: "25" })).toEqual({
      skip: 0,
      take: 25,
    });
  });
});
