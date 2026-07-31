import { describe, expect, it } from "vitest";
import {
  firstQuickBookIdentityError,
  validateQuickBookIdentity,
} from "../identity-validation";

describe("quick booking identity validation", () => {
  it("returns field errors before the patient can continue", () => {
    const errors = validateQuickBookIdentity({
      name: "",
      phone: "123",
      gender: "",
      dob: "",
      email: "not-an-email",
      city: "a".repeat(121),
      pincode: "5600",
    });

    expect(errors.name).toMatch(/name/i);
    expect(errors.phone).toMatch(/whatsapp/i);
    expect(errors.gender).toMatch(/gender/i);
    expect(errors.dob).toMatch(/date of birth/i);
    expect(errors.email).toMatch(/email/i);
    expect(errors.city).toMatch(/city/i);
    expect(errors.pincode).toMatch(/pin code/i);
    expect(firstQuickBookIdentityError(errors)).toBe(errors.name);
  });

  it("accepts a complete valid identity form", () => {
    expect(
      validateQuickBookIdentity({
        name: "Rahul Sharma",
        phone: "+91 9876543210",
        gender: "MALE",
        dob: "1995-04-12",
        email: "",
        city: "Bengaluru",
        pincode: "560001",
      }),
    ).toEqual({});
  });
});
