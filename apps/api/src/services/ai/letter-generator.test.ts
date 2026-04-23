import { describe, it, expect, vi, beforeEach } from "vitest";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("openai", () => {
  class OpenAI {
    chat = { completions: { create: createMock } };
    constructor(_opts: any) {}
  }
  return { default: OpenAI };
});

import { generateReferralLetter, generateDischargeSummary } from "./letter-generator";

function reply(content: string) {
  return { choices: [{ message: { content } }] };
}

beforeEach(() => {
  createMock.mockReset();
});

describe("generateReferralLetter", () => {
  it("returns model-generated content as plain text", async () => {
    createMock.mockResolvedValueOnce(reply("REFERRAL LETTER\n\n..."));
    const out = await generateReferralLetter({
      patientName: "Ravi",
      patientAge: 42,
      patientGender: "M",
      fromDoctorName: "Gupta",
      fromHospital: "MedCore",
      toSpecialty: "Cardiology",
      toDoctorName: "Sharma",
      clinicalSummary: "CP on exertion",
      relevantHistory: "HTN",
      currentMedications: ["Aspirin 75mg"],
      urgency: "URGENT",
      date: "2026-04-23",
    });
    expect(out).toContain("REFERRAL LETTER");
  });

  it("embeds urgency, patient name and medications in the prompt", async () => {
    createMock.mockResolvedValueOnce(reply("..."));
    await generateReferralLetter({
      patientName: "Asha",
      fromDoctorName: "A",
      fromHospital: "H",
      toSpecialty: "Neurology",
      clinicalSummary: "headache",
      relevantHistory: "none",
      currentMedications: ["paracetamol"],
      urgency: "EMERGENCY",
      date: "2026-04-23",
    });
    const userMsg = createMock.mock.calls[0][0].messages[1].content;
    expect(userMsg).toContain("Asha");
    expect(userMsg).toContain("EMERGENCY");
    expect(userMsg).toContain("paracetamol");
    expect(userMsg).toContain("Neurology Specialist"); // no toDoctorName path
  });

  it("emits 'None' when currentMedications list is empty", async () => {
    createMock.mockResolvedValueOnce(reply("..."));
    await generateReferralLetter({
      patientName: "X",
      fromDoctorName: "Y",
      fromHospital: "H",
      toSpecialty: "ENT",
      clinicalSummary: "s",
      relevantHistory: "r",
      currentMedications: [],
      urgency: "ROUTINE",
      date: "2026-04-23",
    });
    const userMsg = createMock.mock.calls[0][0].messages[1].content;
    expect(userMsg).toContain("  - None");
  });

  it("returns empty string when model emits no content", async () => {
    createMock.mockResolvedValueOnce({ choices: [{ message: { content: null } }] });
    const out = await generateReferralLetter({
      patientName: "X",
      fromDoctorName: "Y",
      fromHospital: "H",
      toSpecialty: "ENT",
      clinicalSummary: "s",
      relevantHistory: "r",
      currentMedications: [],
      urgency: "ROUTINE",
      date: "2026-04-23",
    });
    expect(out).toBe("");
  });
});

describe("generateDischargeSummary", () => {
  it("returns model-generated discharge summary text", async () => {
    createMock.mockResolvedValueOnce(reply("DISCHARGE SUMMARY\n...Signature:"));
    const out = await generateDischargeSummary({
      patientName: "Ravi",
      patientAge: 60,
      admissionDate: "2026-04-20",
      dischargeDate: "2026-04-23",
      admittingDiagnosis: "NSTEMI",
      dischargeDiagnosis: "NSTEMI - managed",
      proceduresPerformed: ["PCI"],
      medicationsOnDischarge: ["Aspirin 75mg", "Atorvastatin 40mg"],
      followUpInstructions: "OPD in 2 weeks",
      doctorName: "Gupta",
      hospital: "MedCore",
    });
    expect(out).toContain("DISCHARGE SUMMARY");
  });

  it("lists procedures and discharge medications in the user prompt", async () => {
    createMock.mockResolvedValueOnce(reply("..."));
    await generateDischargeSummary({
      patientName: "X",
      admissionDate: "2026-04-01",
      dischargeDate: "2026-04-05",
      admittingDiagnosis: "Pneumonia",
      dischargeDiagnosis: "Pneumonia resolved",
      proceduresPerformed: [],
      medicationsOnDischarge: [],
      followUpInstructions: "GP in 1 week",
      doctorName: "Y",
      hospital: "H",
    });
    const userMsg = createMock.mock.calls[0][0].messages[1].content;
    // Both empty lists → "  - None" expected twice (procedures + medications)
    const noneMatches = userMsg.match(/  - None/g) ?? [];
    expect(noneMatches.length).toBeGreaterThanOrEqual(2);
  });
});
