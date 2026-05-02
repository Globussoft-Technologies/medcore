/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/ai-differential",
}));

import AIDifferentialPage from "../ai-differential/page";

describe("AIDifferentialPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    toastMock.error.mockReset();
    apiMock.get.mockResolvedValue({ data: [] });
    apiMock.post.mockResolvedValue({ data: null });
  });

  it("smoke renders the page heading", () => {
    render(<AIDifferentialPage />);
    expect(
      screen.getByRole("heading", { name: /ai differential diagnosis/i })
    ).toBeInTheDocument();
  });

  it("renders the chief-complaint and patient-search inputs", () => {
    render(<AIDifferentialPage />);
    expect(
      screen.getByPlaceholderText(/search by name or mr number/i)
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/productive cough and fever/i)
    ).toBeInTheDocument();
  });

  it("disables the Suggest Differentials button until a patient and complaint are picked", () => {
    render(<AIDifferentialPage />);
    const submit = screen.getByTestId("differential-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("renders differentials when the API returns suggestions", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/patients?search="))
        return Promise.resolve({
          data: [{ id: "p1", mrNumber: "MR-1", user: { name: "Aarav" } }],
        });
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({
      data: {
        differentials: [
          {
            diagnosis: "Community-acquired pneumonia",
            icd10: "J18.9",
            probability: "high",
            reasoning: "Productive cough + fever 3 days",
            recommendedTests: ["CXR"],
            redFlags: ["Hypoxia"],
          },
        ],
        guidelineReferences: [],
      },
    });
    const user = userEvent.setup();
    render(<AIDifferentialPage />);
    await user.type(
      screen.getByPlaceholderText(/search by name or mr number/i),
      "Aarav"
    );
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByText(/aarav/i)).toBeInTheDocument()
    );
    await user.click(screen.getByText(/aarav/i));
    await user.type(
      screen.getByPlaceholderText(/productive cough and fever/i),
      "Cough and fever"
    );
    await user.click(screen.getByTestId("differential-submit"));
    await waitFor(() =>
      expect(
        screen.getByText(/community-acquired pneumonia/i)
      ).toBeInTheDocument()
    );
  });

  it("toasts an error when the analysis API rejects", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.includes("/patients?search="))
        return Promise.resolve({
          data: [{ id: "p1", mrNumber: "MR-1", user: { name: "Aarav" } }],
        });
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockRejectedValue(new Error("503 LLM offline"));
    const user = userEvent.setup();
    render(<AIDifferentialPage />);
    await user.type(
      screen.getByPlaceholderText(/search by name or mr number/i),
      "Aarav"
    );
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByText(/aarav/i)).toBeInTheDocument()
    );
    await user.click(screen.getByText(/aarav/i));
    await user.type(
      screen.getByPlaceholderText(/productive cough and fever/i),
      "Cough"
    );
    await user.click(screen.getByTestId("differential-submit"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/503 LLM offline|Analysis failed/i)
      )
    );
  });
});
