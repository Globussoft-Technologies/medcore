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
  toastMock: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/walk-in",
}));

import WalkInPage from "../walk-in/page";

const doctors = [
  { id: "d1", user: { name: "Dr. Singh" }, specialization: "GP" },
  { id: "d2", user: { name: "Dr. Gupta" }, specialization: "Pediatrics" },
];

describe("WalkInPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    toastMock.error.mockReset();
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/doctors")) return Promise.resolve({ data: doctors });
      return Promise.resolve({ data: [] });
    });
    document.documentElement.classList.remove("dark");
  });

  it("renders the Walk-in Registration heading", async () => {
    render(<WalkInPage />);
    expect(
      screen.getByRole("heading", { name: /walk-in registration/i })
    ).toBeInTheDocument();
  });

  it("renders a doctor tile for each doctor", async () => {
    render(<WalkInPage />);
    await waitFor(() => {
      expect(screen.getByText("Dr. Singh")).toBeInTheDocument();
      expect(screen.getByText("Dr. Gupta")).toBeInTheDocument();
    });
  });

  it("shows the new-patient form when '+ New Patient' is clicked", async () => {
    const user = userEvent.setup();
    render(<WalkInPage />);
    await waitFor(() => screen.getByText("Dr. Singh"));
    await user.click(screen.getByRole("button", { name: /\+ new patient/i }));
    expect(screen.getByPlaceholderText(/^name$/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/^phone$/i)).toBeInTheDocument();
  });

  it("validates name and phone are required (red border + error text)", async () => {
    const user = userEvent.setup();
    render(<WalkInPage />);
    await waitFor(() => screen.getByText("Dr. Singh"));
    await user.click(screen.getByText("Dr. Singh"));
    await user.click(screen.getByRole("button", { name: /\+ new patient/i }));
    await user.click(screen.getByRole("button", { name: /assign token/i }));
    await waitFor(() => {
      expect(screen.getByText(/name is required/i)).toBeInTheDocument();
      expect(screen.getByText(/phone number is required/i)).toBeInTheDocument();
    });
    const nameInput = screen.getByPlaceholderText(/^name$/i);
    expect(nameInput.className).toMatch(/border-red-500/);
  });

  it("rejects a phone shorter than 10 digits", async () => {
    const user = userEvent.setup();
    render(<WalkInPage />);
    await waitFor(() => screen.getByText("Dr. Singh"));
    await user.click(screen.getByText("Dr. Singh"));
    await user.click(screen.getByRole("button", { name: /\+ new patient/i }));
    await user.type(screen.getByPlaceholderText(/^name$/i), "Testy");
    await user.type(screen.getByPlaceholderText(/^phone$/i), "12345");
    await user.click(screen.getByRole("button", { name: /assign token/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/enter a valid 10-digit phone/i)
      ).toBeInTheDocument();
    });
  });

  it("Assign Token is disabled until a doctor is selected", async () => {
    render(<WalkInPage />);
    await waitFor(() => screen.getByText("Dr. Singh"));
    const btn = screen.getByRole("button", {
      name: /assign token/i,
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
