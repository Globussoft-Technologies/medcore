/* eslint-disable @typescript-eslint/no-explicit-any */
// Smoke tests for /super-admin/users — Pearl §8.2 (gap row 208 closure).
//
// Covers:
//   - Table renders mocked /api/v1/super-admin/users response (3 rows).
//   - Active-filter chips toggle and refetch with the new `active`
//     query param.
//   - Free-text search debounces and refetches with `q=`.
//   - "Deactivate" button calls PATCH; the row's optimistic state +
//     refetch surfaces the new isActive=false status.
//   - "Last active" 409 from the API renders as an inline error alert
//     and the row is NOT optimistically downgraded (rollback path).
//   - Caller's own row's button is disabled (no self-deactivation).
//
// fetch is stubbed at the global level so the page can be unit-tested
// without the real API. The auth store mock makes `currentUser.id` match
// one of the seeded rows so the self-guard branch is exercised.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const sampleUsers = [
  {
    id: "sa-1-self",
    name: "Pearl Ops (you)",
    email: "ops@pearl.test",
    role: "ADMIN",
    isActive: true,
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
  },
  {
    id: "sa-2-other",
    name: "Other Super",
    email: "other@pearl.test",
    role: "ADMIN",
    isActive: true,
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString(),
  },
  {
    id: "sa-3-inactive",
    name: "Retired Super",
    email: "retired@pearl.test",
    role: "ADMIN",
    isActive: false,
    createdAt: new Date(Date.now() - 100 * 24 * 60 * 60_000).toISOString(),
  },
];

const fetchMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({}),
}));

// Mock the auth store so currentUser.id matches "sa-1-self" — exercises
// the self-row disabled-button guard.
vi.mock("@/lib/store", () => ({
  useAuthStore: () => ({
    user: {
      id: "sa-1-self",
      email: "ops@pearl.test",
      name: "Pearl Ops (you)",
      role: "ADMIN",
      tenantId: null,
    },
  }),
}));

function mockListOk(users = sampleUsers) {
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: { users },
      error: null,
    }),
  }));
}

beforeEach(() => {
  fetchMock.mockReset();
  mockListOk();
  (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

import SuperAdminUsersPage from "../page";

describe("Super-admin /super-admin/users page — Pearl §8.2", () => {
  it("renders the 3 mocked super-admin rows", async () => {
    render(<SuperAdminUsersPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("super-admin-users-row-sa-1-self"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("super-admin-users-row-sa-2-other"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("super-admin-users-row-sa-3-inactive"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("super-admin-users-count-summary").textContent,
    ).toMatch(/3 super-admin users shown/i);
  });

  it("active filter chip toggles and refetches with `active=false`", async () => {
    render(<SuperAdminUsersPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("super-admin-users-row-sa-1-self"),
      ).toBeInTheDocument();
    });
    // Initial fetch carries active=all (the default).
    const firstUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(firstUrl).toContain("active=all");

    fireEvent.click(screen.getByTestId("super-admin-users-filter-false"));
    await waitFor(() => {
      const last = fetchMock.mock.calls.at(-1);
      expect(String(last?.[0] ?? "")).toContain("active=false");
    });
  });

  it("search input debounces and refetches with q=", async () => {
    render(<SuperAdminUsersPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("super-admin-users-row-sa-1-self"),
      ).toBeInTheDocument();
    });
    fireEvent.change(
      screen.getByTestId("super-admin-users-search"),
      { target: { value: "other" } },
    );
    // Real-timer debounce is 250ms; waitFor's default polling interval
    // covers that window without an explicit sleep.
    await waitFor(
      () => {
        const last = fetchMock.mock.calls.at(-1);
        expect(String(last?.[0] ?? "")).toContain("q=other");
      },
      { timeout: 1500 },
    );
  });

  it("clicking Deactivate on another super-admin fires PATCH and refetches", async () => {
    render(<SuperAdminUsersPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("super-admin-users-row-sa-2-other"),
      ).toBeInTheDocument();
    });

    // Set up the PATCH response: success + then a refetch with the row
    // flipped to inactive.
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          ...sampleUsers[1],
          isActive: false,
        },
        error: null,
      }),
    }));
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          users: [
            sampleUsers[0],
            { ...sampleUsers[1], isActive: false },
            sampleUsers[2],
          ],
        },
        error: null,
      }),
    }));

    fireEvent.click(
      screen.getByTestId("super-admin-users-toggle-sa-2-other"),
    );

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (c) => (c[1] as any)?.method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      expect(String(patchCall?.[0] ?? "")).toContain(
        "/api/v1/super-admin/users/sa-2-other",
      );
      expect((patchCall?.[1] as any).body).toContain('"active":false');
    });

    // After refetch the row's status badge should read Deactivated.
    await waitFor(() => {
      expect(
        screen.getByTestId("super-admin-users-status-sa-2-other").textContent,
      ).toMatch(/Deactivated/i);
    });
  });

  it("surfaces the 'last active super-admin' 409 inline and does not flip the row", async () => {
    render(<SuperAdminUsersPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("super-admin-users-row-sa-2-other"),
      ).toBeInTheDocument();
    });
    // PATCH returns 409 + the canonical error string. We also need to
    // override the subsequent fetchRows() call (which fires inside the
    // try block before the throw is rethrown — actually only on the
    // happy path; on error we never refetch).
    fetchMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        data: null,
        error:
          "Cannot deactivate the last active super-admin — promote another user first",
      }),
    }));

    fireEvent.click(
      screen.getByTestId("super-admin-users-toggle-sa-2-other"),
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("super-admin-users-error").textContent,
      ).toMatch(/last active super-admin/i);
    });
    // Row stays Active (no optimistic flip in error path).
    expect(
      screen.getByTestId("super-admin-users-status-sa-2-other").textContent,
    ).toMatch(/Active/i);
  });

  it("disables the Deactivate button on the caller's own row (self-guard)", async () => {
    render(<SuperAdminUsersPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("super-admin-users-row-sa-1-self"),
      ).toBeInTheDocument();
    });
    const selfBtn = screen.getByTestId(
      "super-admin-users-toggle-sa-1-self",
    ) as HTMLButtonElement;
    expect(selfBtn.disabled).toBe(true);
  });

  it("uses 44px (h-11) touch targets on filter chips, search input, and toggle button", async () => {
    render(<SuperAdminUsersPage />);
    await waitFor(() => {
      expect(
        screen.getByTestId("super-admin-users-row-sa-2-other"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("super-admin-users-filter-all").className,
    ).toMatch(/h-11/);
    expect(
      screen.getByTestId("super-admin-users-search").className,
    ).toMatch(/h-11/);
    expect(
      screen.getByTestId("super-admin-users-toggle-sa-2-other").className,
    ).toMatch(/h-11/);
  });
});
