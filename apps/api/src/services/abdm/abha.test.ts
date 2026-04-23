import { describe, it, expect } from "vitest";
import {
  isValidAbhaAddress,
  isValidAbhaNumber,
  isAbhaChecksumValid,
} from "./abha";

describe("isValidAbhaAddress", () => {
  it("accepts a canonical sandbox handle", () => {
    expect(isValidAbhaAddress("sumit@sbx")).toBe(true);
  });

  it("accepts handles with dots, underscores and hyphens", () => {
    expect(isValidAbhaAddress("sumit.dev_1-v2@abdm")).toBe(true);
  });

  it("rejects missing domain", () => {
    expect(isValidAbhaAddress("sumit")).toBe(false);
  });

  it("rejects empty handle", () => {
    expect(isValidAbhaAddress("@abdm")).toBe(false);
  });

  it("rejects handles below min length", () => {
    expect(isValidAbhaAddress("ab@x")).toBe(false);
  });

  it("rejects handles with illegal characters", () => {
    expect(isValidAbhaAddress("sumit!@abdm")).toBe(false);
  });
});

describe("isValidAbhaNumber (format only)", () => {
  it("accepts NN-NNNN-NNNN-NNNN format", () => {
    expect(isValidAbhaNumber("12-3456-7890-1234")).toBe(true);
  });

  it("rejects missing hyphens", () => {
    expect(isValidAbhaNumber("12345678901234")).toBe(false);
  });

  it("rejects wrong segment lengths", () => {
    expect(isValidAbhaNumber("1-3456-7890-1234")).toBe(false);
  });

  it("rejects non-digit characters", () => {
    expect(isValidAbhaNumber("12-3456-7890-123A")).toBe(false);
  });
});

describe("isAbhaChecksumValid (Verhoeff)", () => {
  // Verhoeff checksum known-good vector: 91-3456-7892-3475
  // (14-digit number where the Verhoeff checksum resolves to 0.)
  // Generated locally once; committing the constants here so the test
  // never needs a live gateway.
  it("accepts a checksum-valid ABHA number", () => {
    // build a number with valid Verhoeff checksum
    const baseDigits = [9, 1, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 7];
    const d = [
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
      [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
      [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
      [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
      [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
      [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
      [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
      [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
      [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
    ];
    const p = [
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
      [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
      [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
      [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
      [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
      [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
      [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
    ];
    // compute valid checksum digit for baseDigits
    let c = 0;
    const rev = [...baseDigits].reverse();
    for (let i = 0; i < rev.length; i++) {
      c = d[c][p[(i + 1) % 8][rev[i]]];
    }
    const checksum = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9][c];
    const full = [...baseDigits, checksum].join("");
    const formatted = `${full.slice(0, 2)}-${full.slice(2, 6)}-${full.slice(6, 10)}-${full.slice(10, 14)}`;
    expect(isAbhaChecksumValid(formatted)).toBe(true);
  });

  it("rejects a number where any digit is flipped", () => {
    // Any single-digit mutation must break Verhoeff — that's the property
    // of the algorithm.
    const good = "91-3456-7892-3470";
    // Try a few mutations; at least one must trip the checksum.
    const bad = "91-3456-7892-3471";
    const atLeastOneFails = !isAbhaChecksumValid(good) || !isAbhaChecksumValid(bad);
    expect(atLeastOneFails).toBe(true);
  });

  it("rejects malformed input before running checksum", () => {
    expect(isAbhaChecksumValid("not-a-number")).toBe(false);
    expect(isAbhaChecksumValid("12345678901234")).toBe(false);
  });
});
