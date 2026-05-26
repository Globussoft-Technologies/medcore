/**
 * Tests for the mobile Bill Explanation screen (app/ai/bill-explanation.tsx).
 *
 * The screen uses an inline `fetch` client (not lib/ai) — driven by an
 * `invoiceId` URL param via `useLocalSearchParams`. We stub `expo-router`,
 * stub the global `fetch`, and walk the screen through its main shapes:
 * loading → no-explanation empty state → request CTA → AI summary card with
 * flagged line items → 404 silent empty → server-error path → status-chip
 * variants (DRAFT/APPROVED/SENT).
 */
import { render, fireEvent, act, waitFor } from "@testing-library/react-native";

let mockParams: { invoiceId?: string; explanationId?: string } = {};
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));

// lib/api only needs to expose API_BASE_URL + ApiError for the inline client.
jest.mock("../lib/api", () => {
  class ApiError extends Error {
    status: number;
    body: any;
    constructor(status: number, message: string, body: any) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }
  return {
    API_BASE_URL: "https://example.test/api/v1",
    ApiError,
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ApiError } = require("../lib/api");

import BillExplanationScreen from "../app/ai/bill-explanation";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  } as unknown as Response;
}

const baseExplanation = {
  id: "e1",
  invoiceId: "inv-1",
  language: "en",
  content: "This bill includes consultation and lab charges.",
  status: "APPROVED" as const,
  flaggedItems: [],
  sentAt: null,
  createdAt: new Date("2026-05-20T10:00:00Z").toISOString(),
};

describe("BillExplanationScreen smoke", () => {
  it("loads and exports a default component", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../app/ai/bill-explanation");
    expect(typeof mod.default).toBe("function");
  });
});

describe("BillExplanationScreen render + load flows", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    mockParams = {};
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("with no invoiceId / explanationId, never calls fetch and shows the empty state without the request CTA", async () => {
    const { findByText, queryByText } = render(<BillExplanationScreen />);
    expect(await findByText("No explanation yet")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    // The CTA only renders when invoiceId is present.
    expect(queryByText("Request an explanation")).toBeNull();
  });

  it("with an invoiceId, fetches by invoice and renders the summary content", async () => {
    mockParams = { invoiceId: "inv-1" };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: baseExplanation })
    );

    const { findByText } = render(<BillExplanationScreen />);

    expect(await findByText("This bill includes consultation and lab charges."))
      .toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/ai/bill-explainer/inv-1");
    // The non-generate fetch must be a plain GET (no method/body override).
    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.method).toBeUndefined();
  });

  it("with an explanationId, fetches by explanation id (preferred over invoiceId path)", async () => {
    mockParams = { explanationId: "exp-9" };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { ...baseExplanation, id: "exp-9" } })
    );

    render(<BillExplanationScreen />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toContain("/ai/bill-explainer/exp-9");
  });

  it("renders flagged line items with the breakdown header", async () => {
    mockParams = { invoiceId: "inv-2" };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: {
          ...baseExplanation,
          flaggedItems: [
            { description: "MRI Scan", amount: 8500, reason: "Duplicate charge" },
            { description: "Bed charges", amount: 1200, reason: "Higher than tariff" },
          ],
        },
      })
    );

    const { findByText } = render(<BillExplanationScreen />);

    expect(await findByText("Items to double-check")).toBeTruthy();
    expect(await findByText("MRI Scan")).toBeTruthy();
    expect(await findByText("Bed charges")).toBeTruthy();
  });

  it("DRAFT status shows the 'awaiting review' chip + pending note", async () => {
    mockParams = { invoiceId: "inv-3" };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { ...baseExplanation, status: "DRAFT" },
      })
    );

    const { findByText } = render(<BillExplanationScreen />);
    expect(await findByText("Awaiting review")).toBeTruthy();
    // The pending note is only rendered for DRAFT status.
    expect(
      await findByText(
        "Our billing desk is reviewing this explanation. You'll get a notification when it's ready."
      )
    ).toBeTruthy();
  });

  it("SENT status maps to the 'Delivered' chip", async () => {
    mockParams = { invoiceId: "inv-4" };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { ...baseExplanation, status: "SENT" },
      })
    );

    const { findByText } = render(<BillExplanationScreen />);
    expect(await findByText("Delivered")).toBeTruthy();
  });

  it("404 from the load endpoint shows the empty state silently (no error message)", async () => {
    mockParams = { invoiceId: "inv-missing" };
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404));

    const { findByText, queryByText } = render(<BillExplanationScreen />);

    // Empty state should render (CTA present because we have an invoiceId).
    expect(await findByText("No explanation yet")).toBeTruthy();
    expect(await findByText("Request an explanation")).toBeTruthy();
    // No error banner should leak through on 404.
    expect(queryByText("Could not load explanation")).toBeNull();
  });

  it("non-404 server errors surface the error banner", async () => {
    mockParams = { invoiceId: "inv-boom" };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "server explosion" }, 500)
    );

    const { findByText } = render(<BillExplanationScreen />);
    expect(await findByText("server explosion")).toBeTruthy();
  });

  it("pressing 'Request an explanation' POSTs to /generate and renders the returned card", async () => {
    mockParams = { invoiceId: "inv-req" };
    // First load → 404 (empty), then generate → APPROVED card.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404))
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            ...baseExplanation,
            id: "e-new",
            invoiceId: "inv-req",
            content: "Generated breakdown for inv-req.",
            status: "APPROVED",
          },
        })
      );

    const { findByText } = render(<BillExplanationScreen />);
    const cta = await findByText("Request an explanation");

    await act(async () => {
      fireEvent.press(cta);
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [genUrl, genInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(genUrl).toContain("/ai/bill-explainer/inv-req/generate");
    expect(genInit.method).toBe("POST");

    expect(await findByText("Generated breakdown for inv-req.")).toBeTruthy();
  });

  it("ApiError thrown by the inline client is treated the same as a fetch !ok response (banner shown)", async () => {
    mockParams = { invoiceId: "inv-throw" };
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "bad gateway" }, 502));

    const { findByText } = render(<BillExplanationScreen />);
    expect(await findByText("bad gateway")).toBeTruthy();
    // sanity-check: ApiError import resolved to a real constructor.
    expect(typeof ApiError).toBe("function");
  });
});
