// PRD §4.5.6 — unit tests for the AI Scribe review-screen voice-command parser.
//
// Covers the full pattern matrix (accept/reject per section, accept-all, sign-off,
// change-dosage, add-note, discard, what-can-I-say, unknown) plus loose-order and
// filler-tolerant variants. Pure-function tests — no React, no Web Speech API.

import { describe, it, expect } from "vitest";
import { parseVoiceCommand } from "../voice-commands";

describe("parseVoiceCommand — accept/reject per section", () => {
  it("accepts each section by name", () => {
    expect(parseVoiceCommand("accept subjective")).toEqual({ kind: "accept-section", section: "S" });
    expect(parseVoiceCommand("accept objective")).toEqual({ kind: "accept-section", section: "O" });
    expect(parseVoiceCommand("accept assessment")).toEqual({ kind: "accept-section", section: "A" });
    expect(parseVoiceCommand("accept plan")).toEqual({ kind: "accept-section", section: "P" });
  });

  it("rejects each section by name", () => {
    expect(parseVoiceCommand("reject subjective")).toEqual({ kind: "reject-section", section: "S" });
    expect(parseVoiceCommand("reject plan")).toEqual({ kind: "reject-section", section: "P" });
  });

  it("tolerates filler words and articles ('accept the plan')", () => {
    expect(parseVoiceCommand("accept the plan")).toEqual({ kind: "accept-section", section: "P" });
    expect(parseVoiceCommand("please accept the assessment")).toEqual({
      kind: "accept-section",
      section: "A",
    });
  });

  it("supports loose word order ('plan accept')", () => {
    expect(parseVoiceCommand("plan accept")).toEqual({ kind: "accept-section", section: "P" });
    expect(parseVoiceCommand("subjective reject")).toEqual({ kind: "reject-section", section: "S" });
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseVoiceCommand("  ACCEPT PLAN  ")).toEqual({ kind: "accept-section", section: "P" });
    expect(parseVoiceCommand("Reject Assessment.")).toEqual({ kind: "reject-section", section: "A" });
  });

  it("treats 'approve' as a synonym for 'accept'", () => {
    expect(parseVoiceCommand("approve plan")).toEqual({ kind: "accept-section", section: "P" });
    expect(parseVoiceCommand("approve subjective")).toEqual({ kind: "accept-section", section: "S" });
  });
});

describe("parseVoiceCommand — accept all / sign off", () => {
  it("recognises 'accept all' and 'approve all'", () => {
    expect(parseVoiceCommand("accept all")).toEqual({ kind: "accept-all" });
    expect(parseVoiceCommand("approve all")).toEqual({ kind: "accept-all" });
  });

  it("treats sign-off / finalize / submit as accept-all", () => {
    expect(parseVoiceCommand("sign off")).toEqual({ kind: "accept-all" });
    expect(parseVoiceCommand("finalize")).toEqual({ kind: "accept-all" });
    expect(parseVoiceCommand("submit")).toEqual({ kind: "accept-all" });
  });
});

describe("parseVoiceCommand — change dosage", () => {
  it("parses 'change dosage of <medicine> to <new>'", () => {
    expect(parseVoiceCommand("change dosage of metformin to 500 mg twice daily")).toEqual({
      kind: "change-dosage",
      medicineQuery: "metformin",
      newDosage: "500 mg twice daily",
    });
  });

  it("accepts 'dose' as a synonym for 'dosage'", () => {
    expect(parseVoiceCommand("change dose of paracetamol to 650 mg")).toEqual({
      kind: "change-dosage",
      medicineQuery: "paracetamol",
      newDosage: "650 mg",
    });
  });

  it("supports multi-word medicine names", () => {
    expect(parseVoiceCommand("change dosage of amoxicillin clavulanate to 875 mg BD")).toEqual({
      kind: "change-dosage",
      medicineQuery: "amoxicillin clavulanate",
      newDosage: "875 mg BD",
    });
  });

  it("strips trailing punctuation", () => {
    expect(parseVoiceCommand("Change dosage of metformin to 1000 mg.")).toEqual({
      kind: "change-dosage",
      medicineQuery: "metformin",
      newDosage: "1000 mg",
    });
  });
});

describe("parseVoiceCommand — add note", () => {
  it("parses 'add note <text>' with no section", () => {
    expect(parseVoiceCommand("add note patient declined statin")).toEqual({
      kind: "add-note",
      section: null,
      text: "patient declined statin",
    });
  });

  it("parses 'add note to plan <text>'", () => {
    expect(parseVoiceCommand("add note to plan follow up in 2 weeks")).toEqual({
      kind: "add-note",
      section: "P",
      text: "follow up in 2 weeks",
    });
  });

  it("parses 'add plan note <text>'", () => {
    expect(parseVoiceCommand("add plan note review labs next visit")).toEqual({
      kind: "add-note",
      section: "P",
      text: "review labs next visit",
    });
  });
});

describe("parseVoiceCommand — discard / cancel / help", () => {
  it("parses discard variants", () => {
    expect(parseVoiceCommand("discard")).toEqual({ kind: "discard" });
    expect(parseVoiceCommand("cancel")).toEqual({ kind: "discard" });
    expect(parseVoiceCommand("go back")).toEqual({ kind: "discard" });
    expect(parseVoiceCommand("cancel review")).toEqual({ kind: "discard" });
  });

  it("parses 'what can I say'", () => {
    expect(parseVoiceCommand("what can I say")).toEqual({ kind: "show-help" });
    expect(parseVoiceCommand("show commands")).toEqual({ kind: "show-help" });
    expect(parseVoiceCommand("voice help")).toEqual({ kind: "show-help" });
  });
});

describe("parseVoiceCommand — unknown", () => {
  it("returns unknown for empty / whitespace input", () => {
    expect(parseVoiceCommand("")).toEqual({ kind: "unknown", raw: "" });
    expect(parseVoiceCommand("   ")).toEqual({ kind: "unknown", raw: "" });
  });

  it("returns unknown with the raw transcript when no pattern matches", () => {
    const result = parseVoiceCommand("the patient looks well today");
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.raw).toBe("the patient looks well today");
    }
  });

  it("does not falsely match section words without an action verb", () => {
    expect(parseVoiceCommand("subjective is fine").kind).toBe("unknown");
  });
});
