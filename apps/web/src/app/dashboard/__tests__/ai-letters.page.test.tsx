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
// Stub the EntityPicker so the test doesn't rely on its searchable dropdown
// internals — this lets us control the picked id directly.
vi.mock("@/components/EntityPicker", () => ({
  EntityPicker: ({ onChange, testIdPrefix, value }: any) => (
    <input
      data-testid={`${testIdPrefix ?? "picker"}-stub`}
      value={value || ""}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

import AILettersPage from "../ai-letters/page";

describe("AILettersPage", () => {
  beforeEach(() => {
    apiMock.post.mockReset();
    toastMock.error.mockReset();
    toastMock.success.mockReset();
  });

  it("smoke renders the page heading and Referral tab by default", () => {
    render(<AILettersPage />);
    expect(
      screen.getByRole("heading", { name: /ai letter generator/i })
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("ai-letters-generate-referral")
    ).toBeInTheDocument();
  });

  it("switches to the Discharge Summary tab when clicked", async () => {
    const user = userEvent.setup();
    render(<AILettersPage />);
    await user.click(screen.getByTestId("ai-letters-tab-discharge"));
    expect(
      screen.getByTestId("ai-letters-generate-discharge")
    ).toBeInTheDocument();
  });

  it("shows an error toast when Generate is clicked with no scribe session", async () => {
    const user = userEvent.setup();
    render(<AILettersPage />);
    await user.click(screen.getByTestId("ai-letters-generate-referral"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/scribe session/i)
      )
    );
  });

  it("renders the generated letter preview on a happy-path POST", async () => {
    apiMock.post.mockResolvedValue({
      success: true,
      data: {
        letter: "Dear Dr. Sharma,\n\nReferring patient...",
        generatedAt: new Date().toISOString(),
      },
      error: null,
    });
    const user = userEvent.setup();
    render(<AILettersPage />);
    const stub = screen.getByTestId(
      "ai-letters-scribe-picker-stub"
    ) as HTMLInputElement;
    await user.type(stub, "scribe-1");
    await user.click(screen.getByTestId("ai-letters-generate-referral"));
    await waitFor(() =>
      expect(
        screen.getByText(/dear dr\. sharma/i)
      ).toBeInTheDocument()
    );
  });

  it("toasts an error when the generation API rejects", async () => {
    apiMock.post.mockRejectedValue(new Error("LLM down"));
    const user = userEvent.setup();
    render(<AILettersPage />);
    const stub = screen.getByTestId(
      "ai-letters-scribe-picker-stub"
    ) as HTMLInputElement;
    await user.type(stub, "scribe-1");
    await user.click(screen.getByTestId("ai-letters-generate-referral"));
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        expect.stringMatching(/llm down|failed to generate/i)
      )
    );
  });
});
