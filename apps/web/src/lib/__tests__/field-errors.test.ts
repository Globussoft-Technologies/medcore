import { describe, it, expect } from "vitest";
import {
  extractFieldErrors,
  humanizeZodMessage,
  topLineError,
} from "../field-errors";

// Issues #487 / #490 (May 2026):
//   - #487 — "X is required" was shown when the field had a value but was
//            the wrong shape (e.g. "Expected string, received number"). The
//            humaniser must distinguish *value missing* from *value wrong*.
//   - #490 — "Patient ID must be a valid UUID" leaked Zod / dev jargon to
//            clinicians. The humaniser must suppress all "uuid" wording.
//
// These tests pin the contract: changes here mean a UX-visible regression,
// so any future edit must update both the helper and these assertions.

describe("humanizeZodMessage", () => {
  describe("required vs invalid (#487)", () => {
    it("maps the literal Zod default 'Required' to a friendly required message", () => {
      expect(humanizeZodMessage("Required")).toBe("This field is required");
    });

    it("does NOT say 'required' when the value is the wrong type (string vs number)", () => {
      const out = humanizeZodMessage("Expected string, received number");
      expect(out.toLowerCase()).not.toContain("required");
      expect(out).toBe("Invalid value");
    });

    it("does NOT say 'required' when the value is the wrong type (number vs string)", () => {
      const out = humanizeZodMessage("Expected number, received string");
      expect(out.toLowerCase()).not.toContain("required");
      expect(out).toBe("Invalid value");
    });

    it("DOES say 'required' when Zod reports the field as undefined", () => {
      // Zod surfaces missing required fields as either "Required" or
      // "Expected <type>, received undefined" depending on the schema; both
      // should map to a user-facing required message.
      expect(humanizeZodMessage("Expected string, received undefined")).toBe(
        "This field is required",
      );
      expect(humanizeZodMessage("Expected number, received null")).toBe(
        "This field is required",
      );
    });

    it("treats lone 'Invalid' as a generic invalid message, not required", () => {
      const out = humanizeZodMessage("Invalid");
      expect(out.toLowerCase()).not.toContain("required");
      expect(out).toBe("Invalid value");
    });
  });

  describe("UUID jargon suppression (#490)", () => {
    it("rewrites Zod's default 'Invalid uuid'", () => {
      const out = humanizeZodMessage("Invalid uuid");
      expect(out.toUpperCase()).not.toContain("UUID");
      expect(out).toBe("Invalid selection");
    });

    it("rewrites 'must be a valid UUID' phrasing", () => {
      const out = humanizeZodMessage("Patient ID must be a valid UUID");
      expect(out.toUpperCase()).not.toContain("UUID");
      expect(out).toBe("Invalid selection");
    });

    it("rewrites case-insensitive uuid mentions", () => {
      expect(humanizeZodMessage("Invalid UUID")).toBe("Invalid selection");
      expect(humanizeZodMessage("expected uuid string")).toBe(
        "Invalid selection",
      );
    });
  });

  describe("other Zod defaults", () => {
    it("softens 'Invalid email'", () => {
      expect(humanizeZodMessage("Invalid email")).toBe(
        "Enter a valid email address",
      );
    });

    it("softens 'Invalid url'", () => {
      expect(humanizeZodMessage("Invalid url")).toBe("Enter a valid URL");
    });

    it("softens 'Invalid date'", () => {
      expect(humanizeZodMessage("Invalid date")).toBe("Enter a valid date");
    });

    it("rewrites string too_small with character count preserved", () => {
      expect(
        humanizeZodMessage("String must contain at least 8 character(s)"),
      ).toBe("Must be at least 8 characters");
      expect(
        humanizeZodMessage("String must contain at least 1 character(s)"),
      ).toBe("Must be at least 1 character");
    });

    it("rewrites string too_big with character count preserved", () => {
      expect(
        humanizeZodMessage("String must contain at most 50 character(s)"),
      ).toBe("Must be at most 50 characters");
    });

    it("rewrites number bounds", () => {
      expect(
        humanizeZodMessage("Number must be greater than or equal to 0"),
      ).toBe("Must be at least 0");
      expect(
        humanizeZodMessage("Number must be less than or equal to 130"),
      ).toBe("Must be at most 130");
    });
  });

  describe("custom developer messages pass through unchanged", () => {
    it("keeps 'Phone must be 10 digits'", () => {
      expect(humanizeZodMessage("Phone must be 10 digits")).toBe(
        "Phone must be 10 digits",
      );
    });

    it("keeps 'Age must be between 1 and 130'", () => {
      expect(humanizeZodMessage("Age must be between 1 and 130")).toBe(
        "Age must be between 1 and 130",
      );
    });

    it("returns 'Invalid value' for empty / non-string input", () => {
      expect(humanizeZodMessage("")).toBe("Invalid value");
      // @ts-expect-error — guarding against runtime garbage from the API
      expect(humanizeZodMessage(undefined)).toBe("Invalid value");
      // @ts-expect-error — guarding against runtime garbage from the API
      expect(humanizeZodMessage(null)).toBe("Invalid value");
    });
  });
});

describe("extractFieldErrors", () => {
  function apiErr(details: Array<{ field: string; message: string }>) {
    return { payload: { details } };
  }

  it("returns null for non-validation errors", () => {
    expect(extractFieldErrors(null)).toBeNull();
    expect(extractFieldErrors(undefined)).toBeNull();
    expect(extractFieldErrors(new Error("network down"))).toBeNull();
    expect(extractFieldErrors({})).toBeNull();
    expect(extractFieldErrors({ payload: {} })).toBeNull();
    expect(extractFieldErrors({ payload: { details: "nope" } })).toBeNull();
  });

  it("humanises every detail through humanizeZodMessage", () => {
    const out = extractFieldErrors(
      apiErr([
        { field: "name", message: "Required" },
        { field: "patientId", message: "Invalid uuid" },
        { field: "age", message: "Expected number, received string" },
      ]),
    );
    expect(out).toEqual({
      name: "This field is required",
      patientId: "Invalid selection",
      age: "Invalid value",
    });
  });

  it("never includes 'UUID' in any extracted message (#490)", () => {
    const out = extractFieldErrors(
      apiErr([
        { field: "patientId", message: "Patient ID must be a valid UUID" },
        { field: "appointmentId", message: "Invalid uuid" },
      ]),
    )!;
    for (const v of Object.values(out)) {
      expect(v.toUpperCase()).not.toContain("UUID");
    }
  });

  it("never says 'required' for a wrong-type error (#487)", () => {
    const out = extractFieldErrors(
      apiErr([{ field: "phone", message: "Expected string, received number" }]),
    )!;
    expect(out.phone.toLowerCase()).not.toContain("required");
  });

  it("keeps the first message per field (existing contract)", () => {
    const out = extractFieldErrors(
      apiErr([
        { field: "email", message: "Invalid email" },
        { field: "email", message: "Required" },
      ]),
    )!;
    expect(out.email).toBe("Enter a valid email address");
  });

  it("returns null when details array is empty or has only malformed entries", () => {
    expect(extractFieldErrors(apiErr([]))).toBeNull();
    expect(
      extractFieldErrors({
        payload: { details: [{ field: 1, message: 2 } as unknown] },
      }),
    ).toBeNull();
  });
});

describe("topLineError", () => {
  it("uses the first humanised field message when available", () => {
    expect(
      topLineError({
        payload: {
          details: [
            { field: "patientId", message: "Invalid uuid" },
            { field: "name", message: "Required" },
          ],
        },
      }),
    ).toBe("Invalid selection");
  });

  it("falls back to err.message for non-validation errors", () => {
    expect(topLineError(new Error("Network error"))).toBe("Network error");
  });

  it("falls back to the supplied default when nothing matches", () => {
    expect(topLineError({}, "Save failed")).toBe("Save failed");
  });
});
