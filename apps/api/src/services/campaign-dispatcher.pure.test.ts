// Unit tests for the pure helpers exported from `campaign-dispatcher.ts` —
// the dispatcher proper is exercised by `campaign-dispatcher-sweep.test.ts`
// (sweep-side mock) and the integration test. This file pins down the
// pure functions that previously had ZERO coverage, lifting the unit
// suite's function-coverage above the 68% gate (see fix-ticks `b776629`,
// `cee3f50`, `993fa7a`).
//
// Why colocated: matches the `test:coverage:unit` glob
// (`apps/api/src/services packages/shared`) — same precedent as
// `whatsapp-providers.test.ts` + `dpdp-receipt.test.ts`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  nowMinuteOfDayIST,
  isWithinSendWindow,
  nextSendWindowStart,
  substituteTemplate,
  buildClickUrl,
  parseAbVariants,
  pickVariant,
  type CampaignVariant,
} from "./campaign-dispatcher";

describe("nowMinuteOfDayIST", () => {
  it("returns 9:00 IST for 03:30 UTC (UTC+5:30 offset)", () => {
    const utc0330 = new Date("2026-05-23T03:30:00Z");
    expect(nowMinuteOfDayIST(utc0330)).toBe(9 * 60); // 540
  });

  it("wraps around midnight IST correctly (22:00 UTC = 03:30 IST next day)", () => {
    const utc22 = new Date("2026-05-23T22:00:00Z");
    // 22:00 UTC + 5:30 = 27:30 → mod 24h = 03:30 IST = 210 minutes.
    expect(nowMinuteOfDayIST(utc22)).toBe(3 * 60 + 30);
  });

  it("returns 0 for IST midnight (18:30 UTC the previous day)", () => {
    const utc1830 = new Date("2026-05-23T18:30:00Z");
    expect(nowMinuteOfDayIST(utc1830)).toBe(0);
  });

  it("defaults to new Date() when called with no arg", () => {
    // Just verify it doesn't throw + returns a sane minute count.
    const m = nowMinuteOfDayIST();
    expect(m).toBeGreaterThanOrEqual(0);
    expect(m).toBeLessThan(24 * 60);
  });
});

describe("isWithinSendWindow", () => {
  it("returns true when no window is configured (null,null)", () => {
    const anytime = new Date("2026-05-23T15:00:00Z"); // 20:30 IST
    expect(isWithinSendWindow(null, null, anytime)).toBe(true);
    expect(isWithinSendWindow(undefined, undefined, anytime)).toBe(true);
  });

  it("returns true when now is inside a configured window", () => {
    // Window 9:00-18:00 IST. Pick 10:30 IST = 05:00 UTC.
    const istMorning = new Date("2026-05-23T05:00:00Z");
    expect(isWithinSendWindow(540, 1080, istMorning)).toBe(true);
  });

  it("returns false when now is outside the window (before start)", () => {
    // Window 9:00-18:00 IST. Pick 07:00 IST = 01:30 UTC.
    const istEarly = new Date("2026-05-23T01:30:00Z");
    expect(isWithinSendWindow(540, 1080, istEarly)).toBe(false);
  });

  it("returns false when now is outside the window (after end)", () => {
    // Window 9:00-18:00 IST. Pick 19:00 IST = 13:30 UTC.
    const istEvening = new Date("2026-05-23T13:30:00Z");
    expect(isWithinSendWindow(540, 1080, istEvening)).toBe(false);
  });
});

describe("nextSendWindowStart", () => {
  it("returns today's start when start hasn't fired yet today", () => {
    // 09:00 IST start, now = 06:00 IST (00:30 UTC). Next start = today 09:00 IST.
    const now = new Date("2026-05-23T00:30:00Z");
    const next = nextSendWindowStart(540, now);
    // 09:00 IST = 03:30 UTC. Verify timestamp difference (~2.5h ahead).
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.getTime() - now.getTime()).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it("returns tomorrow's start when start has already fired today", () => {
    // 09:00 IST start, now = 15:00 IST (09:30 UTC). Next start = tomorrow 09:00 IST.
    const now = new Date("2026-05-23T09:30:00Z");
    const next = nextSendWindowStart(540, now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    // Should be ~18 hours ahead.
    const hoursAhead = (next.getTime() - now.getTime()) / (60 * 60 * 1000);
    expect(hoursAhead).toBeGreaterThan(12);
    expect(hoursAhead).toBeLessThan(24);
  });
});

describe("substituteTemplate", () => {
  const ctx = {
    patient: {
      firstName: "Asha",
      lastName: "Sharma",
      fullName: "Asha Sharma",
      mrNumber: "MR000001",
    },
    tenant: { name: "Onviqa Demo Hospital" },
    campaignClickUrl: "https://example.com/click/abc",
  };

  it("returns empty string for null/undefined input", () => {
    expect(substituteTemplate(null, ctx)).toBe("");
    expect(substituteTemplate(undefined, ctx)).toBe("");
  });

  it("substitutes two-level patient tokens", () => {
    expect(substituteTemplate("Hi {{patient.firstName}}", ctx)).toBe("Hi Asha");
    expect(substituteTemplate("{{patient.mrNumber}}", ctx)).toBe("MR000001");
    expect(substituteTemplate("{{ patient.fullName }}", ctx)).toBe("Asha Sharma");
  });

  it("substitutes tenant.name", () => {
    expect(substituteTemplate("From {{tenant.name}}", ctx)).toBe(
      "From Onviqa Demo Hospital",
    );
  });

  it("substitutes the single-level campaignClickUrl token", () => {
    expect(substituteTemplate("Visit {{campaignClickUrl}}", ctx)).toContain(
      "https://example.com/click/abc",
    );
  });

  it("leaves unknown tokens verbatim so operators spot typos", () => {
    expect(substituteTemplate("Hi {{patient.firstname}}", ctx)).toContain(
      "{{patient.firstname}}",
    );
    expect(substituteTemplate("{{unknown}}", ctx)).toContain("{{unknown}}");
    expect(substituteTemplate("{{too.many.parts}}", ctx)).toContain(
      "{{too.many.parts}}",
    );
    expect(substituteTemplate("{{nopath.foo}}", ctx)).toContain(
      "{{nopath.foo}}",
    );
  });

  it("falls back to the raw token when campaignClickUrl is undefined", () => {
    const ctxNoUrl = { ...ctx, campaignClickUrl: undefined };
    expect(substituteTemplate("{{campaignClickUrl}}", ctxNoUrl)).toContain(
      "{{campaignClickUrl}}",
    );
  });
});

describe("buildClickUrl", () => {
  const origEnv = process.env.PUBLIC_API_URL;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.PUBLIC_API_URL;
    else process.env.PUBLIC_API_URL = origEnv;
  });

  it("builds a URL under the public api base + send id", () => {
    process.env.PUBLIC_API_URL = "https://api.example.com/api/v1";
    const url = buildClickUrl("send-123");
    expect(url).toBe("https://api.example.com/api/v1/public/campaigns/click/send-123");
  });

  it("strips a trailing slash on the base", () => {
    process.env.PUBLIC_API_URL = "https://api.example.com/api/v1/";
    const url = buildClickUrl("xyz");
    expect(url).not.toContain("//public");
    expect(url.endsWith("/public/campaigns/click/xyz")).toBe(true);
  });

  it("falls back to the demo host when env is unset", () => {
    delete process.env.PUBLIC_API_URL;
    const url = buildClickUrl("abc");
    expect(url).toContain("medcore.globusdemos.com");
    expect(url).toContain("/public/campaigns/click/abc");
  });
});

describe("parseAbVariants", () => {
  it("returns null when raw is not an array or is empty", () => {
    expect(parseAbVariants(null)).toBeNull();
    expect(parseAbVariants("not-an-array")).toBeNull();
    expect(parseAbVariants([])).toBeNull();
  });

  it("returns null when all entries are invalid", () => {
    expect(parseAbVariants([{ id: "", weight: 1 }, { id: "x", weight: 0 }])).toBeNull();
    expect(parseAbVariants([null, "string", 42])).toBeNull();
  });

  it("filters out invalid entries and keeps the good ones", () => {
    const raw = [
      { id: "A", weight: 50, subjectOverride: "Hi A", bodyOverride: "body A" },
      { id: "  B  ", weight: 25 }, // id trimmed
      { id: "", weight: 100 }, // dropped — empty id
      { id: "C", weight: -5 }, // dropped — negative weight
      { id: "D", weight: 1.7 }, // weight floored to 1
    ];
    const parsed = parseAbVariants(raw);
    expect(parsed).toHaveLength(3);
    expect(parsed?.[0]).toEqual({
      id: "A",
      weight: 50,
      subjectOverride: "Hi A",
      bodyOverride: "body A",
    });
    expect(parsed?.[1].id).toBe("B");
    expect(parsed?.[2].weight).toBe(1);
  });
});

describe("pickVariant", () => {
  const variants: CampaignVariant[] = [
    { id: "A", weight: 70 },
    { id: "B", weight: 30 },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns A when Math.random() lands in the first weight band", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // 0.5 * 100 = 50 → A bucket
    expect(pickVariant(variants).id).toBe("A");
  });

  it("returns B when Math.random() lands in the second weight band", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.85); // 0.85 * 100 = 85 → B bucket
    expect(pickVariant(variants).id).toBe("B");
  });

  it("falls back to the last variant on float-drift (random = 1.0 → 100)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999999);
    expect(pickVariant(variants).id).toBe("B");
  });

  it("distributes across many runs roughly in proportion to weight", () => {
    // Sanity check — not a statistical assertion, just that both buckets fire.
    const counts: Record<string, number> = { A: 0, B: 0 };
    for (let i = 0; i < 200; i++) {
      counts[pickVariant(variants).id] += 1;
    }
    expect(counts.A).toBeGreaterThan(0);
    expect(counts.B).toBeGreaterThan(0);
  });
});
