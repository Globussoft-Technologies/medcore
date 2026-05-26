/**
 * Tests for the mobile Symptom Diary screen.
 *
 * The screen calls `fetch` directly (via a local `request` helper) instead of
 * going through `lib/ai`, so we stub `global.fetch` per-test to drive the
 * GET /ai/symptom-diary, POST /ai/symptom-diary, and POST
 * /ai/symptom-diary/analyze flows. Real RNTL mount + fireEvent.press so the
 * load → form → submit → reload and analyse-state paths all run.
 *
 * EXECUTION-BLOCKED: every test in apps/mobile/__tests__/ currently fails at
 * config-load time because `apps/mobile/package.json` references the
 * `react-native` jest preset which no longer ships from RN 0.85.x. Tracked at
 * https://github.com/Globussoft-Technologies/medcore/issues/1007. Tests are
 * wired as `it.skip(...)` until that infra fix lands; flip back to `it(...)`
 * when #1007 closes.
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));

// Silence Alert dialogs — we assert via fetch-call shape, not the dialog.
jest.spyOn(require("react-native").Alert, "alert").mockImplementation(() => {});

import SymptomDiaryScreen from "../app/ai/symptom-diary";

const baseRow = (overrides: Partial<any> = {}) => ({
  id: "row-1",
  patientId: "p1",
  symptomDate: new Date().toISOString(),
  entries: [{ symptom: "Headache", severity: 7, notes: "since morning" }],
  lastAnalysis: null,
  lastAnalysisAt: null,
  ...overrides,
});

function mockFetchOnce(payload: any, init: { ok?: boolean; status?: number } = {}) {
  const ok = init.ok ?? true;
  const status = init.status ?? 200;
  (global.fetch as jest.Mock).mockImplementationOnce(
    async () =>
      ({
        ok,
        status,
        statusText: ok ? "OK" : "Error",
        json: async () => payload,
      }) as any
  );
}

beforeEach(() => {
  // Fresh fetch mock per test so the call log is clean.
  global.fetch = jest.fn();
});

describe("SymptomDiaryScreen smoke", () => {
  it.skip("loads and exports a default component", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../app/ai/symptom-diary");
    expect(typeof mod.default).toBe("function");
  });
});

describe("SymptomDiaryScreen render + flows", () => {
  it.skip("renders the header title and form chrome after fetchDiary resolves", async () => {
    mockFetchOnce({ success: true, data: [baseRow()] });

    const { findByText, findByPlaceholderText } = render(<SymptomDiaryScreen />);

    expect(await findByText("Symptom Diary")).toBeTruthy();
    expect(await findByText("Log today's symptom")).toBeTruthy();
    expect(await findByPlaceholderText("Symptom (e.g. headache)")).toBeTruthy();
    expect(await findByPlaceholderText("Notes (optional)")).toBeTruthy();
    expect(await findByText("Last 14 days")).toBeTruthy();
    expect(await findByText("Recent entries")).toBeTruthy();
  });

  it.skip("renders existing diary entries returned by the API", async () => {
    mockFetchOnce({
      success: true,
      data: [
        baseRow({
          id: "r1",
          entries: [{ symptom: "Cough", severity: 4, notes: "dry" }],
        }),
        baseRow({
          id: "r2",
          entries: [{ symptom: "Fever", severity: 6 }],
        }),
      ],
    });

    const { findByText } = render(<SymptomDiaryScreen />);

    expect(await findByText(/Cough — 4\/10/)).toBeTruthy();
    expect(await findByText(/Fever — 6\/10/)).toBeTruthy();
  });

  it.skip("shows the empty-state copy when the API returns zero rows", async () => {
    mockFetchOnce({ success: true, data: [] });

    const { findByText } = render(<SymptomDiaryScreen />);

    expect(await findByText("No entries yet.")).toBeTruthy();
    expect(
      await findByText("Log at least one entry, then press Analyse to see trends.")
    ).toBeTruthy();
  });

  it.skip("typing a symptom and pressing Save entry POSTs to /ai/symptom-diary then reloads", async () => {
    // Initial GET: empty list so we hit empty state.
    mockFetchOnce({ success: true, data: [] });
    // POST submit response.
    mockFetchOnce({ success: true, data: baseRow({ id: "r-new" }) });
    // Reload GET after submit.
    mockFetchOnce({
      success: true,
      data: [
        baseRow({
          id: "r-new",
          entries: [{ symptom: "Sore throat", severity: 5 }],
        }),
      ],
    });

    const { findByPlaceholderText, findByText } = render(<SymptomDiaryScreen />);

    const symptomInput = await findByPlaceholderText("Symptom (e.g. headache)");
    await act(async () => {
      fireEvent.changeText(symptomInput, "Sore throat");
    });

    const saveBtn = await findByText("Save entry");
    await act(async () => {
      fireEvent.press(saveBtn);
    });

    await waitFor(() =>
      expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(3)
    );

    // 2nd call (index 1) should be the POST.
    const postCall = (global.fetch as jest.Mock).mock.calls[1];
    expect(postCall[0]).toMatch(/\/ai\/symptom-diary$/);
    expect(postCall[1].method).toBe("POST");
    const body = JSON.parse(postCall[1].body);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].symptom).toBe("Sore throat");
    expect(body.entries[0].severity).toBe(5); // default severity
    expect(typeof body.symptomDate).toBe("string");

    // Reload happened — the new row should be visible.
    expect(await findByText(/Sore throat — 5\/10/)).toBeTruthy();
  });

  it.skip("does not POST when the symptom field is blank (validation)", async () => {
    mockFetchOnce({ success: true, data: [] });

    const { findByText } = render(<SymptomDiaryScreen />);
    const saveBtn = await findByText("Save entry");

    await act(async () => {
      fireEvent.press(saveBtn);
    });

    // Only the initial GET should have fired — no POST.
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
    expect((global.fetch as jest.Mock).mock.calls[0][1]?.method).toBeUndefined();
  });

  it.skip("Analyse button is disabled when there are no rows (no /analyze POST fires)", async () => {
    mockFetchOnce({ success: true, data: [] });

    const { findByText } = render(<SymptomDiaryScreen />);
    const analyseBtn = await findByText("Analyse");

    await act(async () => {
      fireEvent.press(analyseBtn);
    });

    // No second fetch — only the initial GET.
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it.skip("pressing Analyse with rows present POSTs to /ai/symptom-diary/analyze and renders trends", async () => {
    mockFetchOnce({ success: true, data: [baseRow()] });
    mockFetchOnce({
      success: true,
      data: {
        trends: [
          {
            symptom: "Headache",
            direction: "improving",
            averageSeverity: 4,
            peakSeverity: 7,
          },
        ],
        followUpRecommended: true,
        reasoning: "Severity trending down over the last week.",
      },
    });

    const { findByText } = render(<SymptomDiaryScreen />);
    const analyseBtn = await findByText("Analyse");

    await act(async () => {
      fireEvent.press(analyseBtn);
    });

    await waitFor(() =>
      expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2)
    );

    const analyseCall = (global.fetch as jest.Mock).mock.calls[1];
    expect(analyseCall[0]).toMatch(/\/ai\/symptom-diary\/analyze$/);
    expect(analyseCall[1].method).toBe("POST");

    // Trend bits render.
    expect(
      await findByText("Severity trending down over the last week.")
    ).toBeTruthy();
    expect(await findByText("improving")).toBeTruthy();
    expect(
      await findByText("We recommend booking a follow-up appointment.")
    ).toBeTruthy();
  });

  it.skip("renders a pre-existing analysis returned from the initial GET", async () => {
    mockFetchOnce({
      success: true,
      data: [
        baseRow({
          lastAnalysis: {
            trends: [
              {
                symptom: "Cough",
                direction: "worsening",
                averageSeverity: 6,
                peakSeverity: 9,
              },
            ],
            followUpRecommended: false,
            reasoning: "Cough getting worse — monitor.",
          },
          lastAnalysisAt: new Date().toISOString(),
        }),
      ],
    });

    const { findByText, queryByText } = render(<SymptomDiaryScreen />);

    expect(await findByText("Cough getting worse — monitor.")).toBeTruthy();
    expect(await findByText("worsening")).toBeTruthy();
    // followUpRecommended false → that banner is NOT rendered.
    expect(
      queryByText("We recommend booking a follow-up appointment.")
    ).toBeNull();
  });

  it.skip("renders an error message when the initial fetch rejects", async () => {
    (global.fetch as jest.Mock).mockImplementationOnce(async () => {
      throw new Error("network down");
    });

    const { findByText } = render(<SymptomDiaryScreen />);

    expect(await findByText("network down")).toBeTruthy();
  });

  it.skip("surfaces a non-2xx GET as an error banner via ApiError message", async () => {
    mockFetchOnce(
      { error: "server exploded" },
      { ok: false, status: 500 }
    );

    const { findByText } = render(<SymptomDiaryScreen />);

    expect(await findByText("server exploded")).toBeTruthy();
  });
});
