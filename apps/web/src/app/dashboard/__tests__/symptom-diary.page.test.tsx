/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { apiMock, authMock, toastMock, routerMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  routerMock: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/symptom-diary",
}));

import SymptomDiaryPage from "../symptom-diary/page";

function setUser(role: string | null) {
  // Return a STABLE object across renders — useEffects in the page depend
  // on `user` identity, so a fresh object each call would cause an
  // infinite re-fetch loop and clobber state updates.
  const state = {
    user: role
      ? { id: "u1", name: "Asha", email: "asha@x.com", role }
      : null,
    isLoading: false,
  };
  authMock.mockImplementation(() => state);
}

describe("SymptomDiaryPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    routerMock.replace.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    toastMock.warning.mockReset();
    apiMock.get.mockResolvedValue({ data: [] });
  });

  it("renders the diary page for a PATIENT", async () => {
    setUser("PATIENT");
    render(<SymptomDiaryPage />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /symptom diary/i }),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("symptom-diary-page")).toBeInTheDocument();
    expect(screen.getByTestId("symptom-diary-log-button")).toBeInTheDocument();
  });

  it("opens the modal, saves an entry, and refreshes the list", async () => {
    setUser("PATIENT");
    apiMock.post.mockResolvedValueOnce({
      data: {
        id: "row-1",
        patientId: "p1",
        symptomDate: new Date("2026-04-30T10:00:00Z").toISOString(),
        entries: [{ symptom: "Headache", severity: 3, notes: "Throbbing" }],
      },
    });

    const user = userEvent.setup();
    render(<SymptomDiaryPage />);

    await user.click(await screen.findByTestId("symptom-diary-log-button"));
    expect(screen.getByTestId("symptom-diary-modal")).toBeInTheDocument();

    await user.type(
      screen.getByTestId("symptom-diary-description"),
      "Headache",
    );
    await user.click(screen.getByTestId("symptom-diary-severity-3"));

    await user.click(screen.getByTestId("symptom-diary-save"));

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        "/ai/symptom-diary",
        expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({ symptom: "Headache", severity: 3 }),
          ]),
        }),
      );
    });
    await waitFor(() => {
      expect(toastMock.success).toHaveBeenCalled();
    });
    // List now shows the freshly saved row.
    await waitFor(() => {
      expect(screen.getByTestId("symptom-diary-row-row-1-0")).toBeInTheDocument();
    });
  });

  it("redirects an unauthorised role (LAB_TECH) to /dashboard/not-authorized", async () => {
    setUser("LAB_TECH");
    render(<SymptomDiaryPage />);
    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith(
        expect.stringContaining("/dashboard/not-authorized?from="),
      );
    });
    // No diary content rendered for forbidden roles.
    expect(screen.queryByTestId("symptom-diary-page")).not.toBeInTheDocument();
  });

  it("expands a truncated history row when the toggle is clicked", async () => {
    setUser("PATIENT");
    const longText = "a".repeat(220);
    apiMock.get.mockResolvedValueOnce({
      data: [
        {
          id: "row-2",
          patientId: "p1",
          symptomDate: new Date("2026-04-29T10:00:00Z").toISOString(),
          entries: [
            {
              symptom: "Cough",
              severity: 2,
              notes: longText,
            },
          ],
        },
      ],
    });

    const user = userEvent.setup();
    render(<SymptomDiaryPage />);

    const text = await screen.findByTestId("symptom-diary-row-row-2-0-text");
    // Truncated initially: only ~120 chars + ellipsis, not the full 220.
    expect(text.textContent?.length ?? 0).toBeLessThan(longText.length);
    expect(text.textContent).toContain("...");

    await user.click(screen.getByTestId("symptom-diary-row-row-2-0-toggle"));

    await waitFor(() => {
      const expanded = screen.getByTestId("symptom-diary-row-row-2-0-text");
      expect(expanded.textContent).toBe(longText);
    });
  });
});
