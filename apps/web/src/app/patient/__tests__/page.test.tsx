// Behaviour coverage for the patient PWA landing page (`apps/web/src/app/patient/page.tsx`).
//
// Companion to `landing.page.test.tsx` (which covers layout, manifest, and
// route-group chrome). This file pins the four core probe-driven phase
// transitions of the page component itself, exercising the
// `useEffect → api.get("/auth/me") → setPhase("unauthed") | router.replace(...)`
// state machine:
//   1. Loading state — the initial "probing" phase renders the spinner shell
//      before the `/auth/me` promise resolves.
//   2. Unauthed render — when the probe rejects with a non-2xx (e.g. 401), the
//      welcome marketing surface + Sign-in CTA renders.
//   3. Authed PATIENT bounce — when the probe resolves with role=PATIENT,
//      `router.replace("/patient/dashboard")` is invoked.
//   4. Error state — when the probe throws (network down, sync throw), the
//      catch branch falls back to the unauthed surface rather than getting
//      stuck on the loading shell.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";

const { replaceMock, pushMock, apiGetMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  pushMock: vi.fn(),
  apiGetMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: pushMock }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: apiGetMock,
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

import PatientLandingPage from "../page";

describe("PatientLandingPage — probe phase machine", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    apiGetMock.mockReset();
  });

  it("renders the loading shell during the initial probing phase", async () => {
    // A never-resolving promise pins the component in `phase === "probing"`
    // so we can assert the loading shell renders exactly once before any
    // transition. The `data-testid="patient-landing-probing"` testid is the
    // contract the source exposes for this phase.
    apiGetMock.mockReturnValueOnce(new Promise(() => {}));
    render(<PatientLandingPage />);
    const shell = screen.getByTestId("patient-landing-probing");
    expect(shell).toBeInTheDocument();
    expect(shell).toHaveTextContent(/loading/i);
    // The welcome heading must NOT render while probing — that would mean
    // the page flashed the unauthed surface before the probe settled.
    expect(
      screen.queryByRole("heading", { name: /welcome to your patient portal/i }),
    ).not.toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("renders the unauthed welcome surface when /auth/me resolves with no PATIENT user", async () => {
    apiGetMock.mockResolvedValueOnce({ success: false, data: null });
    render(<PatientLandingPage />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /welcome to your patient portal/i }),
      ).toBeInTheDocument();
    });
    const signIn = screen.getByTestId("patient-landing-signin");
    expect(signIn).toHaveAttribute("href", "/patient/login");
    const book = screen.getByTestId("patient-landing-book");
    expect(book).toBeDisabled();
    expect(book).toHaveAttribute("title", "Available after sign in");
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("bounces to /patient/dashboard via router.replace when /auth/me returns a PATIENT", async () => {
    apiGetMock.mockResolvedValueOnce({
      success: true,
      data: { user: { id: "u-patient-1", role: "PATIENT" } },
    });
    render(<PatientLandingPage />);
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/patient/dashboard");
    });
    // Bounced — must not have used router.push (which would push a history
    // entry the back button would land on) and must not have flashed the
    // welcome surface mid-bounce.
    expect(pushMock).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: /welcome to your patient portal/i }),
    ).not.toBeInTheDocument();
  });

  it("falls back to the unauthed surface when the /auth/me probe throws (error path)", async () => {
    // The page wraps the probe in try/catch; any thrown error must land on
    // the unauthed surface, NOT leave the component stuck on the loading
    // shell. This pins the catch branch.
    apiGetMock.mockRejectedValueOnce(new Error("network down"));
    render(<PatientLandingPage />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /welcome to your patient portal/i }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("patient-landing-probing")).not.toBeInTheDocument();
    expect(screen.getByTestId("patient-landing-signin")).toHaveAttribute(
      "href",
      "/patient/login",
    );
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("does NOT bounce when /auth/me returns a non-PATIENT role (e.g. DOCTOR)", async () => {
    // Belt-and-braces for the role guard — a staff session that landed on
    // /patient (deep link, bookmark) must see the welcome surface, NOT be
    // shovelled into the patient dashboard which would 403 against their JWT.
    apiGetMock.mockResolvedValueOnce({
      success: true,
      data: { user: { id: "u-doctor-1", role: "DOCTOR" } },
    });
    render(<PatientLandingPage />);
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /welcome to your patient portal/i }),
      ).toBeInTheDocument();
    });
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("does not call router.replace after unmount when the probe resolves late (cancellation guard)", async () => {
    // The page's effect tracks a `cancelled` flag in its cleanup. If we
    // unmount before the probe resolves, the late-resolving PATIENT response
    // must NOT invoke router.replace — that would warn about state updates
    // on an unmounted component and could clobber a navigation the user
    // already initiated elsewhere.
    let resolveProbe: ((v: unknown) => void) | undefined;
    apiGetMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProbe = resolve;
      }),
    );
    const { unmount } = render(<PatientLandingPage />);
    unmount();
    await act(async () => {
      resolveProbe?.({ success: true, data: { user: { id: "u-late", role: "PATIENT" } } });
      // Flush microtasks
      await Promise.resolve();
    });
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
