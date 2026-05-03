// Unit tests for the adherence reminder bot.
//
// adherence-bot.ts instantiates an OpenAI client (pointed at Sarvam's base URL)
// at module-import time, so we mock the openai package the same way
// er-triage.test.ts does. The fallback path is exercised by rejecting the
// mock or returning empty content — the bot must always emit a usable
// reminder string regardless.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("openai", () => {
  class OpenAI {
    chat = { completions: { create: createMock } };
    constructor(_opts: any) {}
  }
  return { default: OpenAI };
});

import { generateReminderMessage, getMedicationsDueNow } from "./adherence-bot";

function textResponse(content: string) {
  return {
    choices: [{ message: { content, tool_calls: undefined } }],
  };
}

beforeEach(() => {
  createMock.mockReset();
});

describe("generateReminderMessage", () => {
  const baseOpts = {
    patientName: "Asha",
    medications: [{ name: "Metformin", dosage: "500mg", frequency: "BD" }],
    language: "en" as const,
    reminderType: "morning" as const,
  };

  it("returns the trimmed Sarvam reply on the happy path", async () => {
    createMock.mockResolvedValueOnce(
      textResponse("  Hi Asha, time for your Metformin. Take care.  ")
    );
    const out = await generateReminderMessage(baseOpts);
    expect(out).toBe("Hi Asha, time for your Metformin. Take care.");
  });

  it("falls back to a deterministic English message when Sarvam throws", async () => {
    createMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    const out = await generateReminderMessage(baseOpts);
    expect(out).toMatch(/Reminder/);
    expect(out).toMatch(/Metformin/);
  });

  it("falls back to the deterministic message when Sarvam returns empty content", async () => {
    createMock.mockResolvedValueOnce(textResponse(""));
    const out = await generateReminderMessage(baseOpts);
    expect(out).not.toBe("");
    expect(out).toMatch(/Reminder/);
    expect(out).toMatch(/Metformin/);
  });

  it("forwards Hindi language hint into the user prompt", async () => {
    createMock.mockResolvedValueOnce(textResponse("नमस्ते"));
    await generateReminderMessage({ ...baseOpts, language: "hi" });
    const callArgs = createMock.mock.calls[0][0];
    const userMsg = callArgs.messages.find((m: any) => m.role === "user");
    expect(userMsg.content).toMatch(/Language: Hindi/);
  });

  it("includes every prescribed medication in the prompt", async () => {
    createMock.mockResolvedValueOnce(textResponse("ok"));
    await generateReminderMessage({
      ...baseOpts,
      medications: [
        { name: "Metformin", dosage: "500mg", frequency: "BD" },
        { name: "Amlodipine", dosage: "5mg", frequency: "OD" },
      ],
    });
    const userMsg = createMock.mock.calls[0][0].messages.find(
      (m: any) => m.role === "user"
    );
    expect(userMsg.content).toMatch(/Metformin/);
    expect(userMsg.content).toMatch(/Amlodipine/);
  });

  it("fallback message lists every medication name", async () => {
    createMock.mockRejectedValueOnce(new Error("offline"));
    const out = await generateReminderMessage({
      ...baseOpts,
      medications: [
        { name: "Metformin", dosage: "500mg", frequency: "BD" },
        { name: "Amlodipine", dosage: "5mg", frequency: "OD" },
      ],
    });
    expect(out).toMatch(/Metformin/);
    expect(out).toMatch(/Amlodipine/);
  });
});

describe("getMedicationsDueNow", () => {
  it("returns medications whose reminderTime is within +/- 15 minutes of now", () => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const meds = [
      {
        name: "Metformin",
        dosage: "500mg",
        frequency: "BD",
        reminderTimes: [`${hh}:${mm}`],
      },
      {
        name: "Aspirin",
        dosage: "75mg",
        frequency: "OD",
        reminderTimes: ["03:00"], // 3am — far from any normal test run hour
      },
    ];
    const due = getMedicationsDueNow(meds);
    const dueNames = due.map((d) => d.name);
    expect(dueNames).toContain("Metformin");
    // Aspirin only matches if the test run happens to land in a 3am window —
    // skip the negative assertion to avoid a flaky boundary.
  });

  it("returns an empty array when no times are within window", () => {
    // Always-far times: pick the hour 12 hours opposite to "now" so we are
    // guaranteed to be outside the +/- 15min window in either direction.
    const farHour = (new Date().getHours() + 12) % 24;
    const hh = String(farHour).padStart(2, "0");
    const meds = [
      {
        name: "X",
        dosage: "1",
        frequency: "OD",
        reminderTimes: [`${hh}:00`],
      },
    ];
    expect(getMedicationsDueNow(meds)).toEqual([]);
  });

  it("ignores malformed time strings without throwing", () => {
    const meds = [
      {
        name: "Junk",
        dosage: "1",
        frequency: "OD",
        reminderTimes: ["banana", "25:99"],
      },
    ];
    expect(getMedicationsDueNow(meds)).toEqual([]);
  });
});
