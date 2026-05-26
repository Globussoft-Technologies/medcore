/**
 * Tests for the mobile DPDP Data Export screen (`app/ai/data-export.tsx`).
 *
 * The screen is the patient's Right-to-Data-Portability surface: pick a format
 * (JSON / FHIR / PDF), POST /patient-data-export, poll each created request,
 * then offer a Download once status flips to READY. These tests mock global
 * fetch (the screen uses its own inline `request` helper that calls
 * `fetch(BASE_URL + path)` directly) and exercise: smoke load, format select,
 * happy request, queued -> ready row + Download link out, error-paths
 * (429 rate-limit branch and generic error branch).
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";

jest.mock("expo-router", () => ({
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));
jest.mock("expo-linking", () => ({
  canOpenURL: jest.fn().mockResolvedValue(true),
  openURL: jest.fn().mockResolvedValue(undefined),
}));

// Silence Alert.alert; assert state instead.
const alertSpy = jest
  .spyOn(require("react-native").Alert, "alert")
  .mockImplementation(() => {});

import DataExportScreen from "../app/ai/data-export";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Linking = require("expo-linking");

type FetchMock = jest.Mock<Promise<Partial<Response>>, any>;

function mockResponse(status: number, body: any): Partial<Response> {
  return {
    ok: status >= 200 && status < 400,
    status,
    statusText: status === 429 ? "Too Many Requests" : "OK",
    json: () => Promise.resolve(body),
  } as Partial<Response>;
}

const originalFetch = global.fetch;
let fetchMock: FetchMock;

beforeEach(() => {
  jest.clearAllMocks();
  fetchMock = jest.fn();
  // @ts-expect-error — assigning the jest mock onto the global is fine in tests
  global.fetch = fetchMock;
});

afterAll(() => {
  global.fetch = originalFetch;
  alertSpy.mockRestore();
});

// TODO(#1008): un-skip once apps/mobile jest preset is fixed.
// Tracked: https://github.com/Globussoft-Technologies/medcore/issues/1008
// Symptom: `npx jest` fails on `preset: "react-native"` because RN no longer
// ships the preset (moved to @react-native/jest-preset, not in deps). ALL
// mobile tests are currently blocked — not specific to this file.
describe.skip("DataExportScreen smoke", () => {
  it("loads and exports a default component", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../app/ai/data-export");
    expect(typeof mod.default).toBe("function");
  });
});

// TODO(#1008): un-skip once apps/mobile jest preset is fixed.
// Tracked: https://github.com/Globussoft-Technologies/medcore/issues/1008
// Symptom: `npx jest` fails on `preset: "react-native"` because RN no longer
// ships the preset (moved to @react-native/jest-preset, not in deps). ALL
// mobile tests are currently blocked — not specific to this file.
describe.skip("DataExportScreen render", () => {
  it("renders the title, the three format options and the empty-state copy", async () => {
    const { findByText, getByText } = render(<DataExportScreen />);
    expect(await findByText("Download My Data")).toBeTruthy();
    expect(getByText("JSON — full record")).toBeTruthy();
    expect(getByText("FHIR R4 bundle")).toBeTruthy();
    expect(getByText("PDF summary")).toBeTruthy();
    expect(getByText("Request export")).toBeTruthy();
    expect(getByText("No exports yet.")).toBeTruthy();
  });
});

// TODO(#1008): un-skip once apps/mobile jest preset is fixed.
// Tracked: https://github.com/Globussoft-Technologies/medcore/issues/1008
// Symptom: `npx jest` fails on `preset: "react-native"` because RN no longer
// ships the preset (moved to @react-native/jest-preset, not in deps). ALL
// mobile tests are currently blocked — not specific to this file.
describe.skip("DataExportScreen format selection", () => {
  it("tapping FHIR R4 bundle row makes the subsequent POST send {format:'fhir'}", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(201, {
        success: true,
        data: { requestId: "req-1", status: "QUEUED", format: "fhir" },
      })
    );

    const { getByText, findByText } = render(<DataExportScreen />);
    await findByText("Download My Data");

    await act(async () => {
      fireEvent.press(getByText("FHIR R4 bundle"));
    });
    await act(async () => {
      fireEvent.press(getByText("Request export"));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      format: "fhir",
    });
  });
});

// TODO(#1008): un-skip once apps/mobile jest preset is fixed.
// Tracked: https://github.com/Globussoft-Technologies/medcore/issues/1008
// Symptom: `npx jest` fails on `preset: "react-native"` because RN no longer
// ships the preset (moved to @react-native/jest-preset, not in deps). ALL
// mobile tests are currently blocked — not specific to this file.
describe.skip("DataExportScreen request flow", () => {
  it("creating an export prepends a QUEUED row to the past-exports list", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(201, {
        success: true,
        data: { requestId: "req-json-1", status: "QUEUED", format: "json" },
      })
    );

    const { getByText, findByText, queryByText } = render(<DataExportScreen />);
    await findByText("Download My Data");

    await act(async () => {
      fireEvent.press(getByText("Request export"));
    });

    // Empty-state copy disappears; QUEUED + JSON pill should render.
    await waitFor(() => expect(queryByText("No exports yet.")).toBeNull());
    expect(await findByText("Queued")).toBeTruthy();
    expect(await findByText("JSON")).toBeTruthy();
  });

  it("429 from the API surfaces the rate-limit message in the error row and an alert", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(429, { error: "rate limited" })
    );

    const { getByText, findByText } = render(<DataExportScreen />);
    await findByText("Download My Data");

    await act(async () => {
      fireEvent.press(getByText("Request export"));
    });

    expect(
      await findByText(
        "You have reached the daily limit of 3 exports. Try again tomorrow."
      )
    ).toBeTruthy();
    expect(alertSpy).toHaveBeenCalled();
  });

  it("non-429 server error falls through to the generic error branch", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(500, { message: "boom" })
    );

    const { getByText, findByText } = render(<DataExportScreen />);
    await findByText("Download My Data");

    await act(async () => {
      fireEvent.press(getByText("Request export"));
    });

    // The error returned from the server is surfaced verbatim ("boom").
    expect(await findByText("boom")).toBeTruthy();
    expect(alertSpy).toHaveBeenCalled();
  });
});

// TODO(#1008): un-skip once apps/mobile jest preset is fixed.
// Tracked: https://github.com/Globussoft-Technologies/medcore/issues/1008
// Symptom: `npx jest` fails on `preset: "react-native"` because RN no longer
// ships the preset (moved to @react-native/jest-preset, not in deps). ALL
// mobile tests are currently blocked — not specific to this file.
describe.skip("DataExportScreen download flow", () => {
  it("rows that resolve to READY render a Download button that calls Linking.openURL", async () => {
    jest.useFakeTimers();
    try {
      // First fetch: create returns QUEUED.
      fetchMock.mockResolvedValueOnce(
        mockResponse(201, {
          success: true,
          data: { requestId: "req-ready-1", status: "QUEUED", format: "json" },
        })
      );
      // The 5s poller re-fetches each row by id; arm the GET to return READY
      // + a downloadable signed URL.
      fetchMock.mockResolvedValue(
        mockResponse(200, {
          success: true,
          data: {
            requestId: "req-ready-1",
            format: "json",
            status: "READY",
            requestedAt: new Date().toISOString(),
            readyAt: new Date().toISOString(),
            errorMessage: null,
            fileSize: 1234,
            downloadUrl: "/patient-data-export/req-ready-1/file?sig=abc",
            downloadTtlSeconds: 3600,
          },
        })
      );

      const { getByText, findByText } = render(<DataExportScreen />);
      await findByText("Download My Data");

      // Kick off the create.
      await act(async () => {
        fireEvent.press(getByText("Request export"));
      });
      await findByText("Queued");

      // Advance fake timers to fire the poller.
      await act(async () => {
        jest.advanceTimersByTime(5500);
      });
      // Let the awaited fetch resolve.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const downloadBtn = await findByText("Download");
      expect(downloadBtn).toBeTruthy();
      expect(await findByText("Ready")).toBeTruthy();

      await act(async () => {
        fireEvent.press(downloadBtn);
      });

      await waitFor(() =>
        expect(Linking.canOpenURL).toHaveBeenCalledTimes(1)
      );
      expect(Linking.openURL).toHaveBeenCalledTimes(1);
      const opened = (Linking.openURL as jest.Mock).mock.calls[0][0] as string;
      // Should be an absolute URL that ends with the signed relative path.
      expect(opened.startsWith("http")).toBe(true);
      expect(
        opened.endsWith("/patient-data-export/req-ready-1/file?sig=abc")
      ).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
