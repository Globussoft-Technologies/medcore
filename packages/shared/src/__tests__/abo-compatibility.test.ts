// Pins the ABO + Rh blood-group compatibility matrix used by the blood-bank
// "issue units" UI and the API validation gate (Issue #93). Three invariants
// the resolver and the matrix depend on:
//   - The closed set of 8 blood groups (ALL_BLOOD_GROUPS) covers exactly the
//     keys in both RBC_COMPATIBILITY and PLASMA_COMPATIBILITY maps.
//   - Universal-donor (O-) and universal-recipient (AB+) clinical rules are
//     enforced: O- RBCs go to every recipient; AB+ accepts every donor's RBCs.
//   - Plasma direction is INVERTED vs RBC (donor ABO antibodies live in the
//     plasma) — AB plasma is universal donor, O plasma can only go to O.
//   - The resolver fails safe on unknown / null / undefined / lowercase
//     inputs (defaults to false rather than silently approving a mismatch),
//     and the human-readable mismatch reason mirrors that fail-safe.

import { describe, it, expect } from "vitest";
import {
  ALL_BLOOD_GROUPS,
  RBC_COMPATIBILITY,
  PLASMA_COMPATIBILITY,
  isAboCompatible,
  prettyBloodGroup,
  aboMismatchReason,
  type AboBloodGroup,
} from "../abo-compatibility";

describe("ALL_BLOOD_GROUPS — closed set contract", () => {
  it("exposes exactly the 8 ABO+Rh groups (A/B/AB/O × +/-)", () => {
    expect([...ALL_BLOOD_GROUPS].sort()).toEqual(
      [
        "A_NEG",
        "A_POS",
        "AB_NEG",
        "AB_POS",
        "B_NEG",
        "B_POS",
        "O_NEG",
        "O_POS",
      ].sort(),
    );
  });

  it("contains no duplicate groups", () => {
    const set = new Set(ALL_BLOOD_GROUPS);
    expect(set.size).toBe(ALL_BLOOD_GROUPS.length);
  });

  it("emits groups as non-empty strings (the wire contract Prisma enums rely on)", () => {
    for (const g of ALL_BLOOD_GROUPS) {
      expect(typeof g).toBe("string");
      expect(g.length).toBeGreaterThan(0);
    }
  });
});

describe("RBC_COMPATIBILITY — covers exactly ALL_BLOOD_GROUPS", () => {
  it("has a recipient row for every group in ALL_BLOOD_GROUPS", () => {
    for (const g of ALL_BLOOD_GROUPS) {
      expect(RBC_COMPATIBILITY[g]).toBeDefined();
    }
  });

  it("has no orphan recipient rows beyond ALL_BLOOD_GROUPS", () => {
    const matrixKeys = Object.keys(RBC_COMPATIBILITY).sort();
    const allGroups = [...ALL_BLOOD_GROUPS].sort();
    expect(matrixKeys).toEqual(allGroups);
  });

  it("only lists donor groups that are themselves valid ALL_BLOOD_GROUPS entries", () => {
    const valid = new Set<string>(ALL_BLOOD_GROUPS);
    for (const recipient of ALL_BLOOD_GROUPS) {
      for (const donor of RBC_COMPATIBILITY[recipient]) {
        expect(valid.has(donor)).toBe(true);
      }
    }
  });

  it("AB+ is the universal recipient (accepts every donor's RBCs)", () => {
    expect([...RBC_COMPATIBILITY.AB_POS].sort()).toEqual(
      [...ALL_BLOOD_GROUPS].sort(),
    );
  });

  it("O- is the universal donor (its RBCs appear in every recipient's list)", () => {
    for (const recipient of ALL_BLOOD_GROUPS) {
      expect(RBC_COMPATIBILITY[recipient]).toContain("O_NEG");
    }
  });

  it("O- recipient accepts ONLY O- donors (most restrictive recipient)", () => {
    expect(RBC_COMPATIBILITY.O_NEG).toEqual(["O_NEG"]);
  });

  it("Rh- recipients accept only Rh- donors (no Rh+ leak into Rh- recipients)", () => {
    const rhNegRecipients: AboBloodGroup[] = ["A_NEG", "B_NEG", "AB_NEG", "O_NEG"];
    for (const recipient of rhNegRecipients) {
      for (const donor of RBC_COMPATIBILITY[recipient]) {
        expect(donor.endsWith("_NEG")).toBe(true);
      }
    }
  });

  it("every recipient can receive their own group (reflexive)", () => {
    for (const recipient of ALL_BLOOD_GROUPS) {
      expect(RBC_COMPATIBILITY[recipient]).toContain(recipient);
    }
  });
});

describe("RBC_COMPATIBILITY — full 8×8 truth matrix", () => {
  // Pin every cell — any future edit forces a deliberate test update.
  // Format: [donor, recipient, compatible?]
  const cases: Array<[AboBloodGroup, AboBloodGroup, boolean]> = [
    // O- donor (universal) — goes to everyone
    ["O_NEG", "O_NEG", true],
    ["O_NEG", "O_POS", true],
    ["O_NEG", "A_NEG", true],
    ["O_NEG", "A_POS", true],
    ["O_NEG", "B_NEG", true],
    ["O_NEG", "B_POS", true],
    ["O_NEG", "AB_NEG", true],
    ["O_NEG", "AB_POS", true],
    // O+ donor — goes to all Rh+ recipients
    ["O_POS", "O_NEG", false],
    ["O_POS", "O_POS", true],
    ["O_POS", "A_NEG", false],
    ["O_POS", "A_POS", true],
    ["O_POS", "B_NEG", false],
    ["O_POS", "B_POS", true],
    ["O_POS", "AB_NEG", false],
    ["O_POS", "AB_POS", true],
    // A- donor
    ["A_NEG", "O_NEG", false],
    ["A_NEG", "O_POS", false],
    ["A_NEG", "A_NEG", true],
    ["A_NEG", "A_POS", true],
    ["A_NEG", "B_NEG", false],
    ["A_NEG", "B_POS", false],
    ["A_NEG", "AB_NEG", true],
    ["A_NEG", "AB_POS", true],
    // A+ donor
    ["A_POS", "O_NEG", false],
    ["A_POS", "O_POS", false],
    ["A_POS", "A_NEG", false],
    ["A_POS", "A_POS", true],
    ["A_POS", "B_NEG", false],
    ["A_POS", "B_POS", false],
    ["A_POS", "AB_NEG", false],
    ["A_POS", "AB_POS", true],
    // B- donor
    ["B_NEG", "O_NEG", false],
    ["B_NEG", "O_POS", false],
    ["B_NEG", "A_NEG", false],
    ["B_NEG", "A_POS", false],
    ["B_NEG", "B_NEG", true],
    ["B_NEG", "B_POS", true],
    ["B_NEG", "AB_NEG", true],
    ["B_NEG", "AB_POS", true],
    // B+ donor
    ["B_POS", "O_NEG", false],
    ["B_POS", "O_POS", false],
    ["B_POS", "A_NEG", false],
    ["B_POS", "A_POS", false],
    ["B_POS", "B_NEG", false],
    ["B_POS", "B_POS", true],
    ["B_POS", "AB_NEG", false],
    ["B_POS", "AB_POS", true],
    // AB- donor
    ["AB_NEG", "O_NEG", false],
    ["AB_NEG", "O_POS", false],
    ["AB_NEG", "A_NEG", false],
    ["AB_NEG", "A_POS", false],
    ["AB_NEG", "B_NEG", false],
    ["AB_NEG", "B_POS", false],
    ["AB_NEG", "AB_NEG", true],
    ["AB_NEG", "AB_POS", true],
    // AB+ donor — most restricted, only AB+ recipient
    ["AB_POS", "O_NEG", false],
    ["AB_POS", "O_POS", false],
    ["AB_POS", "A_NEG", false],
    ["AB_POS", "A_POS", false],
    ["AB_POS", "B_NEG", false],
    ["AB_POS", "B_POS", false],
    ["AB_POS", "AB_NEG", false],
    ["AB_POS", "AB_POS", true],
  ];

  for (const [donor, recipient, expected] of cases) {
    it(`RBC ${donor} -> ${recipient} = ${expected}`, () => {
      expect(isAboCompatible(donor, recipient, "RBC")).toBe(expected);
    });
  }

  it("has 64 total cases pinned (8 donors × 8 recipients)", () => {
    expect(cases.length).toBe(64);
  });
});

describe("PLASMA_COMPATIBILITY — covers exactly ALL_BLOOD_GROUPS and inverts RBC", () => {
  it("has a recipient row for every group in ALL_BLOOD_GROUPS", () => {
    for (const g of ALL_BLOOD_GROUPS) {
      expect(PLASMA_COMPATIBILITY[g]).toBeDefined();
    }
  });

  it("has no orphan recipient rows beyond ALL_BLOOD_GROUPS", () => {
    const matrixKeys = Object.keys(PLASMA_COMPATIBILITY).sort();
    const allGroups = [...ALL_BLOOD_GROUPS].sort();
    expect(matrixKeys).toEqual(allGroups);
  });

  it("AB plasma is universal donor — appears in every recipient's plasma list", () => {
    for (const recipient of ALL_BLOOD_GROUPS) {
      expect(PLASMA_COMPATIBILITY[recipient]).toContain("AB_POS");
      expect(PLASMA_COMPATIBILITY[recipient]).toContain("AB_NEG");
    }
  });

  it("O is universal recipient for plasma (O- and O+ accept all groups)", () => {
    expect([...PLASMA_COMPATIBILITY.O_NEG].sort()).toEqual(
      [...ALL_BLOOD_GROUPS].sort(),
    );
    expect([...PLASMA_COMPATIBILITY.O_POS].sort()).toEqual(
      [...ALL_BLOOD_GROUPS].sort(),
    );
  });

  it("AB recipients accept ONLY AB plasma (most restrictive plasma recipient)", () => {
    expect([...PLASMA_COMPATIBILITY.AB_POS].sort()).toEqual(["AB_NEG", "AB_POS"]);
    expect([...PLASMA_COMPATIBILITY.AB_NEG].sort()).toEqual(["AB_NEG", "AB_POS"]);
  });

  it("A recipients accept A and AB plasma only", () => {
    expect([...PLASMA_COMPATIBILITY.A_POS].sort()).toEqual(
      ["AB_NEG", "AB_POS", "A_NEG", "A_POS"].sort(),
    );
    expect([...PLASMA_COMPATIBILITY.A_NEG].sort()).toEqual(
      ["AB_NEG", "AB_POS", "A_NEG", "A_POS"].sort(),
    );
  });

  it("B recipients accept B and AB plasma only", () => {
    expect([...PLASMA_COMPATIBILITY.B_POS].sort()).toEqual(
      ["AB_NEG", "AB_POS", "B_NEG", "B_POS"].sort(),
    );
    expect([...PLASMA_COMPATIBILITY.B_NEG].sort()).toEqual(
      ["AB_NEG", "AB_POS", "B_NEG", "B_POS"].sort(),
    );
  });

  it("only lists donor groups that are themselves valid ALL_BLOOD_GROUPS entries", () => {
    const valid = new Set<string>(ALL_BLOOD_GROUPS);
    for (const recipient of ALL_BLOOD_GROUPS) {
      for (const donor of PLASMA_COMPATIBILITY[recipient]) {
        expect(valid.has(donor)).toBe(true);
      }
    }
  });

  it("plasma direction is inverted vs RBC — AB+ is restricted, O- is universal recipient", () => {
    // AB+ recipient: universal for RBC (8 donors), restricted for plasma (2 donors).
    expect(RBC_COMPATIBILITY.AB_POS.length).toBe(8);
    expect(PLASMA_COMPATIBILITY.AB_POS.length).toBe(2);
    // O- recipient: restricted for RBC (1 donor), universal for plasma (8 donors).
    expect(RBC_COMPATIBILITY.O_NEG.length).toBe(1);
    expect(PLASMA_COMPATIBILITY.O_NEG.length).toBe(8);
  });
});

describe("isAboCompatible — happy paths", () => {
  it("defaults productType to RBC when omitted", () => {
    // O- → AB+ is RBC-compatible AND plasma-compatible, so to verify the
    // default branch we need a pair that differs: A+ donor → A+ recipient.
    // For RBC this is true; for plasma A+ donor → A+ recipient is also true.
    // Use AB+ donor → O- recipient: RBC=false, plasma=false. Use O- donor →
    // O+ recipient: RBC=true, plasma=true. The cleanest differentiator is
    // O+ donor → AB+ recipient: RBC=true, plasma=false.
    expect(isAboCompatible("O_POS", "AB_POS")).toBe(true); // RBC default
    expect(isAboCompatible("O_POS", "AB_POS", "PLASMA")).toBe(false);
  });

  it("returns true for universal donor O- to every recipient (RBC)", () => {
    for (const recipient of ALL_BLOOD_GROUPS) {
      expect(isAboCompatible("O_NEG", recipient, "RBC")).toBe(true);
    }
  });

  it("returns true for every donor to universal recipient AB+ (RBC)", () => {
    for (const donor of ALL_BLOOD_GROUPS) {
      expect(isAboCompatible(donor, "AB_POS", "RBC")).toBe(true);
    }
  });

  it("returns true for AB plasma to every recipient", () => {
    for (const recipient of ALL_BLOOD_GROUPS) {
      expect(isAboCompatible("AB_POS", recipient, "PLASMA")).toBe(true);
      expect(isAboCompatible("AB_NEG", recipient, "PLASMA")).toBe(true);
    }
  });

  it("returns true for every donor to O plasma recipient (universal plasma recipient)", () => {
    for (const donor of ALL_BLOOD_GROUPS) {
      expect(isAboCompatible(donor, "O_NEG", "PLASMA")).toBe(true);
      expect(isAboCompatible(donor, "O_POS", "PLASMA")).toBe(true);
    }
  });
});

describe("isAboCompatible — fail-safe on invalid inputs", () => {
  it("returns false when donor is null (fail-safe)", () => {
    expect(isAboCompatible(null, "AB_POS", "RBC")).toBe(false);
    expect(isAboCompatible(null, "AB_POS", "PLASMA")).toBe(false);
  });

  it("returns false when recipient is null (fail-safe)", () => {
    expect(isAboCompatible("O_NEG", null, "RBC")).toBe(false);
    expect(isAboCompatible("O_NEG", null, "PLASMA")).toBe(false);
  });

  it("returns false when donor is undefined (fail-safe)", () => {
    expect(isAboCompatible(undefined, "AB_POS")).toBe(false);
  });

  it("returns false when recipient is undefined (fail-safe)", () => {
    expect(isAboCompatible("O_NEG", undefined)).toBe(false);
  });

  it("returns false when both are null/undefined (fail-safe)", () => {
    expect(isAboCompatible(null, null)).toBe(false);
    expect(isAboCompatible(undefined, undefined)).toBe(false);
    expect(isAboCompatible(null, undefined)).toBe(false);
  });

  it("returns false for empty string donor or recipient", () => {
    expect(isAboCompatible("", "AB_POS")).toBe(false);
    expect(isAboCompatible("O_NEG", "")).toBe(false);
  });

  it("returns false for unknown / garbage blood-group strings", () => {
    expect(isAboCompatible("XYZ", "AB_POS")).toBe(false);
    expect(isAboCompatible("O_NEG", "BOGUS")).toBe(false);
    expect(isAboCompatible("C_POS", "AB_POS")).toBe(false);
  });

  it("returns false for lowercase variants (the enum is case-sensitive)", () => {
    expect(isAboCompatible("o_neg", "AB_POS")).toBe(false);
    expect(isAboCompatible("O_NEG", "ab_pos")).toBe(false);
    expect(isAboCompatible("o_neg", "ab_pos")).toBe(false);
  });

  it("returns false for human-readable shorthand (O+, A-, AB+ are NOT accepted)", () => {
    // The matrix uses the Prisma enum form (O_POS), not the UI form (O+).
    // Callers must map before invoking.
    expect(isAboCompatible("O-", "AB+")).toBe(false);
    expect(isAboCompatible("A+", "A+")).toBe(false);
  });

  it("returns false for whitespace-padded valid groups (no trimming inside the resolver)", () => {
    expect(isAboCompatible(" O_NEG", "AB_POS")).toBe(false);
    expect(isAboCompatible("O_NEG", "AB_POS ")).toBe(false);
  });
});

describe("prettyBloodGroup — UI label helper", () => {
  it("converts _POS suffix to +", () => {
    expect(prettyBloodGroup("A_POS")).toBe("A+");
    expect(prettyBloodGroup("B_POS")).toBe("B+");
    expect(prettyBloodGroup("AB_POS")).toBe("AB+");
    expect(prettyBloodGroup("O_POS")).toBe("O+");
  });

  it("converts _NEG suffix to -", () => {
    expect(prettyBloodGroup("A_NEG")).toBe("A-");
    expect(prettyBloodGroup("B_NEG")).toBe("B-");
    expect(prettyBloodGroup("AB_NEG")).toBe("AB-");
    expect(prettyBloodGroup("O_NEG")).toBe("O-");
  });

  it("emits all 8 group labels cleanly with no underscores left behind", () => {
    for (const g of ALL_BLOOD_GROUPS) {
      const pretty = prettyBloodGroup(g);
      expect(pretty).not.toContain("_");
      expect(pretty.length).toBeLessThanOrEqual(3);
    }
  });

  it("falls back to underscore-to-space for non-standard inputs (no throw)", () => {
    // Defensive: shouldn't happen at runtime, but the helper shouldn't throw.
    expect(prettyBloodGroup("UNKNOWN")).toBe("UNKNOWN");
    expect(prettyBloodGroup("FOO_BAR")).toBe("FOO BAR");
  });

  it("does not throw on empty string", () => {
    expect(prettyBloodGroup("")).toBe("");
  });
});

describe("aboMismatchReason — human-readable warning", () => {
  it("returns null when donor + recipient are RBC-compatible", () => {
    expect(aboMismatchReason("O_NEG", "AB_POS")).toBeNull();
    expect(aboMismatchReason("A_POS", "AB_POS")).toBeNull();
    expect(aboMismatchReason("O_NEG", "O_NEG")).toBeNull();
  });

  it("returns null when donor + recipient are plasma-compatible (productType=PLASMA)", () => {
    expect(aboMismatchReason("AB_POS", "A_POS", "PLASMA")).toBeNull();
    expect(aboMismatchReason("O_NEG", "O_NEG", "PLASMA")).toBeNull();
  });

  it("returns the unknown-group reason when donor is invalid", () => {
    const reason = aboMismatchReason("XYZ", "AB_POS");
    expect(reason).toContain("Unknown blood group");
    expect(reason).toContain("donor=XYZ");
    expect(reason).toContain("recipient=AB_POS");
  });

  it("returns the unknown-group reason when recipient is invalid", () => {
    const reason = aboMismatchReason("O_NEG", "BOGUS");
    expect(reason).toContain("Unknown blood group");
    expect(reason).toContain("donor=O_NEG");
    expect(reason).toContain("recipient=BOGUS");
  });

  it("substitutes ? for null donor in the unknown-group reason", () => {
    const reason = aboMismatchReason(null, "AB_POS");
    expect(reason).toContain("donor=?");
    expect(reason).toContain("recipient=AB_POS");
  });

  it("substitutes ? for undefined recipient in the unknown-group reason", () => {
    const reason = aboMismatchReason("O_NEG", undefined);
    expect(reason).toContain("donor=O_NEG");
    expect(reason).toContain("recipient=?");
  });

  it("substitutes ? for both null donor and null recipient", () => {
    const reason = aboMismatchReason(null, null);
    expect(reason).toContain("donor=?");
    expect(reason).toContain("recipient=?");
  });

  it("returns RBC mismatch banner for incompatible valid groups (RBC default)", () => {
    const reason = aboMismatchReason("A_POS", "B_POS");
    expect(reason).toContain("RBC mismatch");
    expect(reason).toContain("A+");
    expect(reason).toContain("B+");
    expect(reason).toContain("cannot be issued");
  });

  it("returns PLASMA mismatch banner when productType=PLASMA and groups are incompatible", () => {
    // O+ donor → AB+ recipient is RBC-compatible but plasma-INcompatible.
    const reason = aboMismatchReason("O_POS", "AB_POS", "PLASMA");
    expect(reason).toContain("PLASMA mismatch");
    expect(reason).toContain("O+");
    expect(reason).toContain("AB+");
  });

  it("uses pretty labels (O+, AB-) not enum names (O_POS, AB_NEG) in the banner", () => {
    const reason = aboMismatchReason("AB_NEG", "O_POS");
    expect(reason).not.toContain("AB_NEG");
    expect(reason).not.toContain("O_POS");
    expect(reason).toContain("AB-");
    expect(reason).toContain("O+");
  });

  it("returns a non-null string for every incompatible RBC pair in the full matrix", () => {
    for (const donor of ALL_BLOOD_GROUPS) {
      for (const recipient of ALL_BLOOD_GROUPS) {
        const compatible = isAboCompatible(donor, recipient, "RBC");
        const reason = aboMismatchReason(donor, recipient, "RBC");
        if (compatible) {
          expect(reason).toBeNull();
        } else {
          expect(reason).not.toBeNull();
          expect(typeof reason).toBe("string");
          expect(reason!.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("returns a non-null string for every incompatible PLASMA pair in the full matrix", () => {
    for (const donor of ALL_BLOOD_GROUPS) {
      for (const recipient of ALL_BLOOD_GROUPS) {
        const compatible = isAboCompatible(donor, recipient, "PLASMA");
        const reason = aboMismatchReason(donor, recipient, "PLASMA");
        if (compatible) {
          expect(reason).toBeNull();
        } else {
          expect(reason).not.toBeNull();
        }
      }
    }
  });
});

describe("AboBloodGroup type — compile-time narrowing surface", () => {
  it("accepts every ALL_BLOOD_GROUPS entry as an AboBloodGroup at runtime", () => {
    // Trivial assignment guard — ensures the const-assertion narrows correctly
    // so callers like `RBC_COMPATIBILITY[g]` type-check against the canonical list.
    for (const g of ALL_BLOOD_GROUPS) {
      const narrowed: AboBloodGroup = g;
      expect(RBC_COMPATIBILITY[narrowed]).toBeDefined();
      expect(PLASMA_COMPATIBILITY[narrowed]).toBeDefined();
    }
  });
});
