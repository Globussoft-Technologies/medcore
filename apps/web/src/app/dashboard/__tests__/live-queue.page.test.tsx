/**
 * Issue #748 — Live Queue counts must be derived from real fetched data,
 * not hard-coded literals.
 *
 * Modules under test:
 *   - apps/web/src/app/dashboard/live-queue/page.tsx
 *
 * The previous render used `<div>12 Waiting</div>` literals so the page
 * never moved during the working day. This test mocks the `/queue`
 * aggregate (per-doctor `waitingCount` + `currentToken`) plus the
 * `/appointments?status=COMPLETED` lookup, then asserts the three
 * tiles render the SUMS of those mocks.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { apiMock, authMock, routerReplace } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  routerReplace: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/live-queue",
}));

import LiveQueuePage from "../live-queue/page";

describe("LiveQueuePage (Issue #748)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    routerReplace.mockReset();
    authMock.mockImplementation((selector: any) => {
      const state = {
        user: { id: "u1", name: "Rec", email: "r@x.com", role: "RECEPTION" },
        isLoading: false,
      };
      return typeof selector === "function" ? selector(state) : state;
    });
  });

  it("derives Waiting / In Consult / Done counts from fetched data, not hard-coded literals", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/queue") {
        return Promise.resolve({
          data: [
            // 4 + 7 = 11 waiting; 2 doctors actively in consult.
            {
              doctorId: "d1",
              doctorName: "Dr. A",
              specialization: "GP",
              currentToken: 5,
              waitingCount: 4,
            },
            {
              doctorId: "d2",
              doctorName: "Dr. B",
              specialization: "Pedi",
              currentToken: 3,
              waitingCount: 7,
            },
            // No active token — does NOT count toward in-consult.
            {
              doctorId: "d3",
              doctorName: "Dr. C",
              specialization: "ENT",
              currentToken: null,
              waitingCount: 0,
            },
          ],
        });
      }
      if (url.includes("/appointments") && url.includes("status=COMPLETED")) {
        return Promise.resolve({
          data: [
            { id: "ap1", status: "COMPLETED" },
            { id: "ap2", status: "COMPLETED" },
            { id: "ap3", status: "COMPLETED" },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<LiveQueuePage />);

    // Wait until the tiles render the derived numbers.
    await waitFor(() => {
      expect(screen.getByTestId("live-queue-waiting")).toHaveTextContent("11");
      expect(screen.getByTestId("live-queue-in-consult")).toHaveTextContent(
        "2"
      );
      expect(screen.getByTestId("live-queue-done")).toHaveTextContent("3");
    });

    // The /queue endpoint MUST have been called — proves we're not on the
    // hard-coded path.
    expect(
      apiMock.get.mock.calls.some(([url]) => url === "/queue")
    ).toBe(true);
  });

  it("redirects PATIENT users away to /dashboard/not-authorized", async () => {
    authMock.mockImplementation((selector: any) => {
      const state = {
        user: { id: "u9", name: "Pat", email: "p@x.com", role: "PATIENT" },
        isLoading: false,
      };
      return typeof selector === "function" ? selector(state) : state;
    });

    render(<LiveQueuePage />);

    await waitFor(() => {
      expect(routerReplace).toHaveBeenCalledTimes(1);
      const target = routerReplace.mock.calls[0][0] as string;
      expect(target).toMatch(/\/dashboard\/not-authorized/);
    });
  });
});
