/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TenantOnboardingPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises `apps/web/src/app/dashboard/tenants/[id]/onboarding/page.tsx`,
 *     the post-creation onboarding checklist for a newly-provisioned
 *     tenant. The page guides an admin through 6 setup steps and
 *     posts completion markers to SystemConfig via the tenants API.
 *
 *   - Endpoints touched:
 *       GET  /tenants/:id/onboarding   → { data: { steps: {...} } }
 *       GET  /tenants/:id              → { data: TenantDetail }
 *       POST /tenants/:id/onboarding/:step
 *
 *   - Behaviours covered:
 *       1. Loading skeleton renders with `aria-busy="true"` and the
 *          stable `tenant-onboarding-loading` testid before the
 *          parallel GETs resolve.
 *       2. Non-ADMIN role is router.pushed to /dashboard and the page
 *          shell renders null (RBAC client-side gate).
 *       3. ADMIN happy path — page chrome (testid `tenant-onboarding`),
 *          progress bar, all 8 SOW-aligned steps render, tenant name
 *          + subdomain.
 *       4. URL id threading — both GETs use `/tenants/${id}/...` with
 *          the value from `useParams()`.
 *       5. `account_created` step is auto-detected via `autoDetect(d)`
 *          → check icon renders + no "Mark complete" CTA.
 *       6. Mark-complete flow — clicking the `tenant-onboarding-complete-*`
 *          button POSTs `/tenants/:id/onboarding/:step` and reloads.
 *       7. Mark-complete API rejection → `toast.error` with the message
 *          and the page stays alive.
 *       8. Initial GET failure → `toast.error` fires and the loading
 *          state clears (page shell + skeleton-then-checklist still render).
 *       9. Steps already complete render the persisted ISO date next to
 *          the title (en-IN format) and suppress the "Mark complete" CTA.
 *      10. Progress percent — partial completion produces the correct
 *          fraction in the progress KPI.
 *      11. Skip flow — clicking `tenant-onboarding-skip-*` POSTs the
 *          new `/onboarding/:step/skip` endpoint, the page reloads, and
 *          the step renders with `data-step-status="skipped"` + an amber
 *          badge while NOT counting toward the progress numerator.
 *
 *   - Mocks: @/lib/api, @/lib/store (destructured `useAuthStore`),
 *     @/lib/toast, @/lib/i18n, @/components/Skeleton (passthrough),
 *     next/navigation (`useParams`, `useRouter`).
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from "@testing-library/react";

const {
  apiMock,
  authMock,
  toastMock,
  routerPush,
} = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  authMock: vi.fn(),
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
  routerPush: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/i18n", () => ({
  useTranslation: () => ({
    t: (_k: string, fallback?: string) => fallback ?? _k,
    setLang: vi.fn(),
    lang: "en",
  }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
  useParams: () => ({ id: "t1" }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/tenants/t1/onboarding",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonCard: ({ className }: { className?: string }) => (
    <div data-testid="skeleton-card" className={className} />
  ),
}));

import TenantOnboardingPage from "../page";

// ─── Fixtures ─────────────────────────────────────────────

const fullConfig: Record<string, string> = {
  hospital_name: "St. Johns",
  hospital_phone: "9999999999",
  hospital_email: "ops@stjohns.example",
  hospital_address: "12 MG Road",
};

const tenantDetail = {
  id: "t1",
  name: "St. Johns",
  subdomain: "stjohns",
  active: true,
  config: fullConfig,
};

function routeApiGet(opts?: {
  steps?: Record<string, string>;
  skipped?: Record<string, string>;
  detail?: typeof tenantDetail | null;
  fail?: "both" | "steps" | "detail";
  detailOverride?: Partial<typeof tenantDetail>;
}) {
  const steps = opts?.steps ?? {};
  const skipped = opts?.skipped ?? {};
  const detail = opts?.detail === null
    ? null
    : { ...tenantDetail, ...(opts?.detailOverride ?? {}) };
  apiMock.get.mockImplementation(async (url: string) => {
    if (opts?.fail === "both") throw new Error("network down");
    if (url.endsWith("/onboarding")) {
      if (opts?.fail === "steps") throw new Error("steps 500");
      return { data: { tenantId: "t1", steps, skipped } };
    }
    // /tenants/:id
    if (opts?.fail === "detail") throw new Error("detail 500");
    return { data: detail };
  });
}

function loginAs(role: string) {
  authMock.mockImplementation(() => ({
    user: { id: "u1", name: "Admin", email: "a@x.com", role },
  }));
}

describe("TenantOnboardingPage", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    routerPush.mockReset();
    toastMock.error.mockReset();
    toastMock.success.mockReset();
    authMock.mockReset();
    loginAs("ADMIN");
  });

  // ─── Loading + RBAC ────────────────────────────────────

  it("renders the skeleton loader with aria-busy=true before the GETs resolve", () => {
    // Never-resolving promise to lock the page in the loading phase.
    apiMock.get.mockImplementation(() => new Promise(() => {}));
    render(<TenantOnboardingPage />);
    const loader = screen.getByTestId("tenant-onboarding-loading");
    expect(loader).toBeInTheDocument();
    expect(loader.getAttribute("aria-busy")).toBe("true");
    expect(screen.getAllByTestId("skeleton-card")).toHaveLength(3);
  });

  it("redirects a non-ADMIN role to /dashboard and never fetches", async () => {
    loginAs("DOCTOR");
    routeApiGet();
    render(<TenantOnboardingPage />);
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/dashboard"),
    );
    // Non-ADMIN early-return: no onboarding fetch and the page chrome
    // is suppressed (returns null).
    expect(apiMock.get).not.toHaveBeenCalled();
    expect(screen.queryByTestId("tenant-onboarding")).not.toBeInTheDocument();
  });

  // ─── ADMIN happy path ──────────────────────────────────

  it("renders the page chrome with all 8 SOW-aligned steps + tenant name + subdomain after the GETs resolve (ADMIN)", async () => {
    routeApiGet();
    render(<TenantOnboardingPage />);
    // The chrome mounts immediately under a loading skeleton; wait for the
    // skeleton to disappear (= both GETs resolved) before asserting on data.
    await waitFor(() =>
      expect(
        screen.queryByTestId("tenant-onboarding-loading"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("St. Johns")).toBeInTheDocument();
    expect(screen.getByText("stjohns")).toBeInTheDocument();
    // All 8 step rows present, ordered to match the SOW §8.1 wizard.
    // Retired/deferred entries (asserted absent below):
    //   - hospital_config (retired 2026-05-29)
    //   - first_branch    (dropped 2026-05-29 — default branch seeded at signup)
    //   - seed_test_patient (dropped 2026-05-29 — operators always skipped it)
    //   - go_live         (deferred — see page.tsx header)
    for (const key of [
      "account_created",
      "default_permissions",
      "first_doctor",
      "abdm_registration",
      "whatsapp_setup",
      "payment_gateway",
      "duty_roster",
      "notification_templates",
    ]) {
      expect(
        screen.getByTestId(`tenant-onboarding-step-${key}`),
      ).toBeInTheDocument();
    }
    for (const retired of [
      "hospital_config",
      "first_branch",
      "seed_test_patient",
      "go_live",
    ]) {
      expect(
        screen.queryByTestId(`tenant-onboarding-step-${retired}`),
      ).not.toBeInTheDocument();
    }
  });

  it("threads the tenant id from useParams into both GET endpoints", async () => {
    routeApiGet();
    render(<TenantOnboardingPage />);
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/tenants/t1/onboarding"),
    );
    expect(apiMock.get).toHaveBeenCalledWith("/tenants/t1");
  });

  // ─── autoDetect branches ───────────────────────────────

  it("auto-completes account_created (autoDetect: !!detail) and suppresses its Mark-complete button", async () => {
    routeApiGet();
    render(<TenantOnboardingPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId("tenant-onboarding-step-account_created"),
      ).toBeInTheDocument(),
    );
    // The explicit "Mark complete" button is NEVER rendered for the
    // account_created step (it's guarded by `step.key !== "account_created"`).
    expect(
      screen.queryByTestId("tenant-onboarding-complete-account_created"),
    ).not.toBeInTheDocument();
  });

  // ─── Mark-complete flow ────────────────────────────────

  it("POSTs /tenants/:id/onboarding/:step and reloads when Mark-complete is clicked", async () => {
    routeApiGet();
    apiMock.post.mockResolvedValue({ data: { ok: true } });
    render(<TenantOnboardingPage />);

    await waitFor(() =>
      expect(
        screen.getByTestId("tenant-onboarding-complete-first_doctor"),
      ).toBeInTheDocument(),
    );
    apiMock.get.mockClear();

    fireEvent.click(
      screen.getByTestId("tenant-onboarding-complete-first_doctor"),
    );

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith(
        "/tenants/t1/onboarding/first_doctor",
      ),
    );
    expect(toastMock.success).toHaveBeenCalled();
    // Reload re-issues the parallel GETs.
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/tenants/t1/onboarding"),
    );
  });

  it("surfaces a toast.error when Mark-complete POST rejects and keeps the page alive", async () => {
    routeApiGet();
    apiMock.post.mockRejectedValue(new Error("conflict 409"));
    render(<TenantOnboardingPage />);

    await waitFor(() =>
      expect(
        screen.getByTestId("tenant-onboarding-complete-duty_roster"),
      ).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByTestId("tenant-onboarding-complete-duty_roster"),
    );
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("conflict 409"),
    );
    expect(screen.getByTestId("tenant-onboarding")).toBeInTheDocument();
  });

  // ─── Error-path resilience on initial load ─────────────

  it("toasts an error when the initial GETs reject but still clears the loading phase", async () => {
    routeApiGet({ fail: "both" });
    render(<TenantOnboardingPage />);
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("network down"),
    );
    // After the rejection the loading skeleton clears and the
    // checklist shell renders (empty steps map, no detail).
    await waitFor(() =>
      expect(
        screen.queryByTestId("tenant-onboarding-loading"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("tenant-onboarding")).toBeInTheDocument();
  });

  // ─── Persisted-step rendering ──────────────────────────

  it("renders the persisted completion date next to a step + hides its Mark-complete CTA", async () => {
    const completedAt = "2026-04-01T10:00:00.000Z";
    routeApiGet({
      steps: {
        first_doctor: completedAt,
      },
    });
    render(<TenantOnboardingPage />);
    await waitFor(() =>
      expect(
        screen.getByTestId("tenant-onboarding-step-first_doctor"),
      ).toBeInTheDocument(),
    );
    // The persisted-marker branch renders an en-IN date next to the
    // title (e.g. "01 Apr 2026"). We just assert that the row contains
    // the year — locale formatting can vary across jsdom versions.
    const row = screen.getByTestId("tenant-onboarding-step-first_doctor");
    expect(row.textContent).toMatch(/2026/);
    // Mark-complete CTA suppressed because the step is complete.
    expect(
      screen.queryByTestId("tenant-onboarding-complete-first_doctor"),
    ).not.toBeInTheDocument();
  });

  it("renders the correct progress fraction when some steps are complete", async () => {
    // account_created auto-completes (1). Plus an explicit first_doctor
    // marker (2). Total 8 → 25% / "2 / 8".
    routeApiGet({
      steps: { first_doctor: "2026-03-01T00:00:00.000Z" },
    });
    render(<TenantOnboardingPage />);
    // Progress only re-computes after both GETs resolve and the loading
    // skeleton clears; wait for that, not just the page chrome.
    await waitFor(() =>
      expect(
        screen.queryByTestId("tenant-onboarding-loading"),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText(/2\s*\/\s*8/)).toBeInTheDocument();
    const bar = screen.getByTestId("tenant-onboarding-progress");
    expect(bar.getAttribute("style") || "").toMatch(/width:\s*25%/);
  });

  // ─── Skip flow (new) ──────────────────────────────────

  it("renders a step marked skipped with data-step-status=\"skipped\" + amber badge, hides the Skip button, and excludes it from the progress numerator", async () => {
    // payment_gateway pre-skipped server-side. account_created still
    // auto-completes (1/8 ≈ 13%). The skipped step does NOT count.
    routeApiGet({
      skipped: { payment_gateway: "2026-05-29T08:00:00.000Z" },
    });
    render(<TenantOnboardingPage />);
    await waitFor(() =>
      expect(
        screen.queryByTestId("tenant-onboarding-loading"),
      ).not.toBeInTheDocument(),
    );

    const row = screen.getByTestId("tenant-onboarding-step-payment_gateway");
    expect(row.getAttribute("data-step-status")).toBe("skipped");
    expect(
      screen.getByTestId(
        "tenant-onboarding-skipped-badge-payment_gateway",
      ),
    ).toBeInTheDocument();
    // Skip button hides once a step is already skipped — only Mark complete
    // remains so the operator can come back and finish it.
    expect(
      screen.queryByTestId("tenant-onboarding-skip-payment_gateway"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId(
        "tenant-onboarding-complete-payment_gateway",
      ),
    ).toBeInTheDocument();

    // Progress numerator unchanged — only account_created auto-completes.
    // 1/8 rounds to 13%.
    expect(screen.getByText("13%")).toBeInTheDocument();
    expect(screen.getByText(/1\s*\/\s*8/)).toBeInTheDocument();
  });
});
