// Unit tests for the shared formatDoctorName helper.
//
// Guards against Issue #12 ("Dr. Dr. Rajesh Sharma" in workspace header) and
// Issue #25 ("Dr. Dr." in patient-facing surfaces). The helper must ALWAYS
// emit exactly one "Dr. " prefix, even when the stored User.name already has
// one (which the seed data does) or has been accidentally double-prefixed
// (legacy buggy data).
import { describe, it, expect } from "vitest";
import { formatDoctorName } from "../format-doctor-name";

describe("formatDoctorName", () => {
  it("returns empty string for null / undefined / empty input", () => {
    expect(formatDoctorName(null)).toBe("");
    expect(formatDoctorName(undefined)).toBe("");
    expect(formatDoctorName("")).toBe("");
    expect(formatDoctorName("   ")).toBe("");
  });

  it("prepends Dr. to a plain name", () => {
    expect(formatDoctorName("Rajesh Sharma")).toBe("Dr. Rajesh Sharma");
    expect(formatDoctorName("Priya Kumar")).toBe("Dr. Priya Kumar");
  });

  it("does not double-prefix when the name already starts with Dr.", () => {
    expect(formatDoctorName("Dr. Rajesh Sharma")).toBe("Dr. Rajesh Sharma");
    expect(formatDoctorName("Dr Rajesh Sharma")).toBe("Dr. Rajesh Sharma");
  });

  it("is case-insensitive for the stripped prefix", () => {
    expect(formatDoctorName("dr. rajesh")).toBe("Dr. rajesh");
    expect(formatDoctorName("DR. RAJESH")).toBe("Dr. RAJESH");
  });

  it("collapses pre-buggy double prefixes", () => {
    expect(formatDoctorName("Dr. Dr. Rajesh")).toBe("Dr. Rajesh");
    expect(formatDoctorName("Dr. Dr. Dr. Rajesh")).toBe("Dr. Rajesh");
  });

  it("trims extra whitespace inside stripped prefix", () => {
    expect(formatDoctorName("Dr.   Rajesh")).toBe("Dr. Rajesh");
  });
});
