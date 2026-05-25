// Coverage tests for the AI Differential Diagnosis dashboard page.
// Modules under test: apps/web/src/app/dashboard/ai-differential/page.tsx —
//   clinician-facing page that searches patients via GET /patients,
//   submits POST /ai/differential with chief complaint + optional vitals
//   and history, and renders differentials with probability badges,
//   recommended tests, red flags, and guideline references.
// Why: page was at 0% coverage. These assertions lock in the rendered
//   surface (patient picker flow, submit gating, vitals coercion, result
//   rendering of differentials/redFlags/tests/guidelines, empty + error
//   states) so future refactors cannot silently regress the surface.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const { apiGetMock, apiPostMock, toastErrorMock, toastSuccessMock } =
  vi.hoisted(() => ({
    apiGetMock: vi.fn(),
    apiPostMock: vi.fn(),
    toastErrorMock: vi.fn(),
    toastSuccessMock: vi.fn(),
  }));

vi.mock("@/lib/api", () => ({
  api: {
    get: apiGetMock,
    post: apiPostMock,
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/ai-differential",
}));

import AIDifferentialPage from "../page";

function patient(overrides: Partial<any> = {}) {
  return {
    id: "pt-1",
    mrNumber: "MR-100",
    user: { name: "Asha Patel" },
    ...overrides,
  };
}

function differentialResult(overrides: Partial<any> = {}) {
  return {
    differentials: [
      {
        diagnosis: "Community-acquired pneumonia",
        icd10: "J18.9",
        probability: "high",
        reasoning: "Productive cough + fever + crackles",
        recommendedTests: ["Chest X-ray", "CBC"],
        redFlags: ["Hypoxia <90% SpO2"],
      },
      {
        diagnosis: "Acute bronchitis",
        probability: "medium",
        reasoning: "Self-limited viral illness",
        recommendedTests: [],
        redFlags: [],
      },
    ],
    guidelineReferences: ["IDSA CAP 2019 §III"],
    ...overrides,
  };
}

describe("AI Differential Diagnosis dashboard page", () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
  });

  it("renders the header chrome and disables submit until patient + complaint are provided", () => {
    render(<AIDifferentialPage />);

    expect(
      screen.getByRole("heading", { name: /AI Differential Diagnosis/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Clinical decision support/i),
    ).toBeInTheDocument();

    const submit = screen.getByTestId("differential-submit");
    expect(submit).toBeDisabled();
  });

  it("searches patients on button click and renders the result list", async () => {
    apiGetMock.mockResolvedValueOnce({
      data: { patients: [patient(), patient({ id: "pt-2", mrNumber: "MR-200", user: { name: "Ravi Kumar" } })] },
    });

    render(<AIDifferentialPage />);

    const input = screen.getByTestId("differential-patient-input");
    fireEvent.change(input, { target: { value: "Asha" } });

    // The Search button has only an icon — find it as the sibling of the
    // input (the only other button until the picker results render).
    const searchBtns = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-testid") !== "differential-submit");
    fireEvent.click(searchBtns[0]);

    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith(
        "/patients?search=Asha&limit=5",
      ),
    );

    expect(await screen.findByText("Asha Patel")).toBeInTheDocument();
    expect(screen.getByText("Ravi Kumar")).toBeInTheDocument();
    expect(screen.getByText(/MR-100/)).toBeInTheDocument();
  });

  it("searches patients on Enter key", async () => {
    apiGetMock.mockResolvedValueOnce({ data: { patients: [patient()] } });

    render(<AIDifferentialPage />);

    const input = screen.getByTestId("differential-patient-input");
    fireEvent.change(input, { target: { value: "Asha" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith(
        "/patients?search=Asha&limit=5",
      ),
    );
  });

  it("no-ops the search when the query is empty/whitespace", () => {
    render(<AIDifferentialPage />);
    const input = screen.getByTestId("differential-patient-input");
    fireEvent.change(input, { target: { value: "   " } });

    // Click the search button (the lone non-submit button at this point).
    const searchBtns = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-testid") !== "differential-submit");
    fireEvent.click(searchBtns[0]);

    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it("toasts an error when patient search rejects", async () => {
    apiGetMock.mockRejectedValueOnce(new Error("network down"));

    render(<AIDifferentialPage />);
    fireEvent.change(screen.getByTestId("differential-patient-input"), {
      target: { value: "Asha" },
    });
    const searchBtns = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-testid") !== "differential-submit");
    fireEvent.click(searchBtns[0]);

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Patient search failed"),
    );
  });

  it("falls back to res.data when the API returns a bare array (no .patients)", async () => {
    apiGetMock.mockResolvedValueOnce({ data: [patient()] });

    render(<AIDifferentialPage />);
    fireEvent.change(screen.getByTestId("differential-patient-input"), {
      target: { value: "Asha" },
    });
    const searchBtns = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-testid") !== "differential-submit");
    fireEvent.click(searchBtns[0]);

    expect(await screen.findByText("Asha Patel")).toBeInTheDocument();
  });

  it("selecting a search result populates patientId and clears the result list", async () => {
    apiGetMock.mockResolvedValueOnce({ data: { patients: [patient()] } });

    render(<AIDifferentialPage />);
    fireEvent.change(screen.getByTestId("differential-patient-input"), {
      target: { value: "Asha" },
    });
    const searchBtns = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-testid") !== "differential-submit");
    fireEvent.click(searchBtns[0]);

    const row = await screen.findByText("Asha Patel");
    fireEvent.click(row);

    // Selected patientId footer + cleared search results.
    expect(
      await screen.findByText(/Selected patientId: pt-1/),
    ).toBeInTheDocument();
    // After click, the picker list should have collapsed — no surviving "MR-100"
    // anywhere on the page (the picker row was the only place it appeared).
    expect(screen.queryByText(/\(MR-100\)/)).not.toBeInTheDocument();

    // Submit becomes enabled only after a chief complaint is also entered.
    const submit = screen.getByTestId("differential-submit");
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Chief Complaint/i), {
      target: { value: "Productive cough x 3 days" },
    });
    expect(submit).not.toBeDisabled();
  });

  it("toasts error when submit is fired without patientId or chief complaint", async () => {
    render(<AIDifferentialPage />);

    // The submit button is disabled until both fields are set, so we can't
    // click it directly. Validate the guard indirectly: the submit MUST stay
    // disabled (i.e. no path to call runAnalysis without inputs).
    expect(screen.getByTestId("differential-submit")).toBeDisabled();
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it("runs analysis with full vitals + history, posting coerced numerics", async () => {
    // Patient pick first.
    apiGetMock.mockResolvedValueOnce({ data: { patients: [patient()] } });
    apiPostMock.mockResolvedValueOnce({ data: differentialResult() });

    render(<AIDifferentialPage />);

    fireEvent.change(screen.getByTestId("differential-patient-input"), {
      target: { value: "Asha" },
    });
    const searchBtns = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-testid") !== "differential-submit");
    fireEvent.click(searchBtns[0]);
    fireEvent.click(await screen.findByText("Asha Patel"));

    fireEvent.change(screen.getByLabelText(/Chief Complaint/i), {
      target: { value: "Productive cough x 3 days" },
    });
    fireEvent.change(screen.getByPlaceholderText(/BP/i), {
      target: { value: "130/85" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Pulse/i), {
      target: { value: "92" },
    });
    fireEvent.change(screen.getByPlaceholderText(/Temp/i), {
      target: { value: "38.5" },
    });
    fireEvent.change(screen.getByPlaceholderText(/SpO2/i), {
      target: { value: "94" },
    });
    fireEvent.change(screen.getByLabelText(/Relevant History/i), {
      target: { value: "Diabetic, smoker" },
    });

    fireEvent.click(screen.getByTestId("differential-submit"));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));
    expect(apiPostMock).toHaveBeenCalledWith("/ai/differential", {
      patientId: "pt-1",
      chiefComplaint: "Productive cough x 3 days",
      vitals: { bp: "130/85", pulse: 92, temp: 38.5, spo2: 94 },
      relevantHistory: "Diabetic, smoker",
    });

    // Differentials render.
    expect(
      await screen.findByText(/Community-acquired pneumonia/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Acute bronchitis/)).toBeInTheDocument();

    // ICD-10 chip.
    expect(screen.getByText(/\[J18\.9\]/)).toBeInTheDocument();

    // Probability badge labels.
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("Medium")).toBeInTheDocument();

    // Recommended tests + red flags.
    expect(screen.getByText("Chest X-ray")).toBeInTheDocument();
    expect(screen.getByText("CBC")).toBeInTheDocument();
    expect(screen.getByText(/Hypoxia <90% SpO2/)).toBeInTheDocument();

    // Guideline references.
    expect(screen.getByText(/IDSA CAP 2019/)).toBeInTheDocument();
  });

  it("omits vitals + relevantHistory from POST body when fields are blank", async () => {
    apiGetMock.mockResolvedValueOnce({ data: { patients: [patient()] } });
    apiPostMock.mockResolvedValueOnce({
      data: { differentials: [], guidelineReferences: [] },
    });

    render(<AIDifferentialPage />);

    fireEvent.change(screen.getByTestId("differential-patient-input"), {
      target: { value: "Asha" },
    });
    const searchBtns = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-testid") !== "differential-submit");
    fireEvent.click(searchBtns[0]);
    fireEvent.click(await screen.findByText("Asha Patel"));

    fireEvent.change(screen.getByLabelText(/Chief Complaint/i), {
      target: { value: "Headache" },
    });
    fireEvent.click(screen.getByTestId("differential-submit"));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));
    expect(apiPostMock).toHaveBeenCalledWith("/ai/differential", {
      patientId: "pt-1",
      chiefComplaint: "Headache",
      vitals: undefined,
      relevantHistory: undefined,
    });
  });

  it("renders the empty-state copy when the API returns zero differentials", async () => {
    apiGetMock.mockResolvedValueOnce({ data: { patients: [patient()] } });
    apiPostMock.mockResolvedValueOnce({
      data: { differentials: [], guidelineReferences: [] },
    });

    render(<AIDifferentialPage />);

    fireEvent.change(screen.getByTestId("differential-patient-input"), {
      target: { value: "Asha" },
    });
    const searchBtns = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-testid") !== "differential-submit");
    fireEvent.click(searchBtns[0]);
    fireEvent.click(await screen.findByText("Asha Patel"));

    fireEvent.change(screen.getByLabelText(/Chief Complaint/i), {
      target: { value: "Fatigue" },
    });
    fireEvent.click(screen.getByTestId("differential-submit"));

    expect(
      await screen.findByText(/No differentials returned\./i),
    ).toBeInTheDocument();
  });

  it("toasts the rejection message on analysis failure and clears the loading spinner", async () => {
    apiGetMock.mockResolvedValueOnce({ data: { patients: [patient()] } });
    apiPostMock.mockRejectedValueOnce({ message: "Model timed out" });

    render(<AIDifferentialPage />);

    fireEvent.change(screen.getByTestId("differential-patient-input"), {
      target: { value: "Asha" },
    });
    const searchBtns = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-testid") !== "differential-submit");
    fireEvent.click(searchBtns[0]);
    fireEvent.click(await screen.findByText("Asha Patel"));

    fireEvent.change(screen.getByLabelText(/Chief Complaint/i), {
      target: { value: "Chest pain" },
    });
    fireEvent.click(screen.getByTestId("differential-submit"));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Model timed out"),
    );

    // Submit button is re-enabled (loading flipped back to false).
    await waitFor(() =>
      expect(screen.getByTestId("differential-submit")).not.toBeDisabled(),
    );
  });

  it("falls back to the default copy when analysis rejects without a message", async () => {
    apiGetMock.mockResolvedValueOnce({ data: { patients: [patient()] } });
    apiPostMock.mockRejectedValueOnce({});

    render(<AIDifferentialPage />);

    fireEvent.change(screen.getByTestId("differential-patient-input"), {
      target: { value: "Asha" },
    });
    const searchBtns = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-testid") !== "differential-submit");
    fireEvent.click(searchBtns[0]);
    fireEvent.click(await screen.findByText("Asha Patel"));

    fireEvent.change(screen.getByLabelText(/Chief Complaint/i), {
      target: { value: "Dizziness" },
    });
    fireEvent.click(screen.getByTestId("differential-submit"));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Analysis failed"),
    );
  });

  it("disables the submit button while the POST is in flight", async () => {
    apiGetMock.mockResolvedValueOnce({ data: { patients: [patient()] } });
    apiPostMock.mockImplementation(() => new Promise(() => {}));

    render(<AIDifferentialPage />);

    fireEvent.change(screen.getByTestId("differential-patient-input"), {
      target: { value: "Asha" },
    });
    const searchBtns = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-testid") !== "differential-submit");
    fireEvent.click(searchBtns[0]);
    fireEvent.click(await screen.findByText("Asha Patel"));

    fireEvent.change(screen.getByLabelText(/Chief Complaint/i), {
      target: { value: "Migraine" },
    });
    const submit = screen.getByTestId("differential-submit");
    expect(submit).not.toBeDisabled();

    fireEvent.click(submit);
    await waitFor(() => expect(submit).toBeDisabled());
  });

  it("renders an unknown-probability fallback label using the raw value", async () => {
    apiGetMock.mockResolvedValueOnce({ data: { patients: [patient()] } });
    apiPostMock.mockResolvedValueOnce({
      data: {
        differentials: [
          {
            diagnosis: "Idiopathic syndrome",
            probability: "uncertain",
            reasoning: "No clear pattern",
            recommendedTests: [],
            redFlags: [],
          },
        ],
        guidelineReferences: [],
      },
    });

    render(<AIDifferentialPage />);

    fireEvent.change(screen.getByTestId("differential-patient-input"), {
      target: { value: "Asha" },
    });
    const searchBtns = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-testid") !== "differential-submit");
    fireEvent.click(searchBtns[0]);
    fireEvent.click(await screen.findByText("Asha Patel"));

    fireEvent.change(screen.getByLabelText(/Chief Complaint/i), {
      target: { value: "Vague malaise" },
    });
    fireEvent.click(screen.getByTestId("differential-submit"));

    expect(
      await screen.findByText(/Idiopathic syndrome/),
    ).toBeInTheDocument();
    // ProbabilityBadge falls back to the raw probability string.
    expect(screen.getByText("uncertain")).toBeInTheDocument();
  });
});
