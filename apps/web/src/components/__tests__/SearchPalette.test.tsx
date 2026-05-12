import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(async (_url: string) => ({
      data: [
        {
          type: "patient",
          id: "p1",
          title: "Aarav Mehta",
          subtitle: "MRN 1001",
          href: "/dashboard/patients/p1",
        },
      ],
    })),
  },
}));

// Issue #877: SearchPalette now scopes recent-search history by user id
// (each user only ever reads + writes their own slot). Mock the auth store
// to return a stable user id so loadRecent / saveRecent have a slot to
// target and tests can write to `medcore:recent-search:<userId>` directly.
const TEST_USER_ID = "test-user-1";
vi.mock("@/lib/store", () => ({
  useAuthStore: (selector: (s: { user: { id: string; role: string } }) => unknown) =>
    selector({ user: { id: TEST_USER_ID, role: "ADMIN" } }),
}));

import { SearchPalette } from "@/app/dashboard/_components/search-palette";

describe("SearchPalette", () => {
  beforeEach(() => {
    pushMock.mockClear();
    window.localStorage.clear();
  });

  it("renders the input when open", () => {
    render(<SearchPalette open onClose={() => {}} />);
    expect(
      screen.getByPlaceholderText(/search patients/i)
    ).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<SearchPalette open={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("pressing Escape fires onClose", () => {
    const onClose = vi.fn();
    render(<SearchPalette open onClose={onClose} />);
    const input = screen.getByPlaceholderText(/search patients/i);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("typing 2+ characters triggers a debounced search with results", async () => {
    render(<SearchPalette open onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/search patients/i);
    fireEvent.change(input, { target: { value: "Aa" } });
    await waitFor(
      () => expect(screen.getByText("Aarav Mehta")).toBeInTheDocument(),
      { timeout: 2000 }
    );
  });

  it("clicking a result calls router.push with its href", async () => {
    render(<SearchPalette open onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/search patients/i);
    fireEvent.change(input, { target: { value: "Aa" } });
    await waitFor(() => screen.getByText("Aarav Mehta"), { timeout: 2000 });
    fireEvent.click(screen.getByText("Aarav Mehta"));
    expect(pushMock).toHaveBeenCalledWith("/dashboard/patients/p1");
  });

  it("loads recent searches from localStorage on open", () => {
    // Issue #877: history is keyed per-user now. Write under the user-id
    // slot the mocked auth store reports.
    window.localStorage.setItem(
      `medcore:recent-search:${TEST_USER_ID}`,
      JSON.stringify(["echo", "scan"])
    );
    render(<SearchPalette open onClose={() => {}} />);
    expect(screen.getByText("Recent")).toBeInTheDocument();
    expect(screen.getByText("echo")).toBeInTheDocument();
    expect(screen.getByText("scan")).toBeInTheDocument();
  });

  it("does NOT leak recent searches from a different user (#877)", () => {
    // Pre-seed the legacy global key (the leak path) AND a different user's
    // per-user slot. The current user's palette must show neither.
    window.localStorage.setItem(
      "medcore:recent-search",
      JSON.stringify(["fatima", "MR000042"]),
    );
    window.localStorage.setItem(
      "medcore:recent-search:other-user-99",
      JSON.stringify(["leaky-query"]),
    );
    render(<SearchPalette open onClose={() => {}} />);
    expect(screen.queryByText("fatima")).not.toBeInTheDocument();
    expect(screen.queryByText("MR000042")).not.toBeInTheDocument();
    expect(screen.queryByText("leaky-query")).not.toBeInTheDocument();
    // And the legacy global key is wiped on first read so future users
    // can't be poisoned either.
    expect(window.localStorage.getItem("medcore:recent-search")).toBeNull();
  });

  it("Enter opens the active result", async () => {
    render(<SearchPalette open onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/search patients/i);
    fireEvent.change(input, { target: { value: "Aa" } });
    await waitFor(() => screen.getByText("Aarav Mehta"), { timeout: 2000 });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(pushMock).toHaveBeenCalledWith("/dashboard/patients/p1");
  });
});
