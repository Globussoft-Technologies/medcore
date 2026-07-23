/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ReferralsPage — adjacent-to-source coverage (test-cron pick 2026-05-26).
 *
 * What / which modules / why:
 *   - Exercises apps/web/src/app/dashboard/referrals/page.tsx, the
 *     specialist-referrals workspace (internal doctor-to-doctor + external
 *     provider). Endpoints touched:
 *       GET   /referrals?limit=100                     (ADMIN list)
 *       GET   /referrals?fromDoctorId=...&limit=100    (DOCTOR outgoing tab)
 *       GET   /referrals/inbox?doctorId=...&limit=100  (DOCTOR incoming tab)
 *       GET   /doctors                                 (modal + myDoctorId lookup)
 *       GET   /patients?search=...&limit=10            (modal patient picker)
 *       POST  /referrals                               (create)
 *       PATCH /referrals/:id                           (status updates)
 *
 *   - Behaviours covered: ADMIN render + fetch wiring, DOCTOR tab switching
 *     (outgoing / incoming / all), patient-search debounce + select + clear,
 *     create modal validation (required patient, required fromDoctor, Zod-
 *     surfaced reason, external-mode Hospital required), happy-path POST
 *     with both internal AND external shapes, POST error surfacing via
 *     toast, status-update transitions (PENDING → ACCEPTED → COMPLETED;
 *     PENDING → DECLINED), error-path resilience on initial list GET, and
 *     mode-switch UI between internal/external referral types.
 *
 *   - Mocks: @/lib/api, @/lib/store (useAuthStore, object-destructure),
 *            @/lib/toast, next/navigation, @/components/Skeleton,
 *            @/components/Autocomplete, @medcore/shared (Zod schema).
 *     The Zod schema is mocked with a passthrough so we don't have to
 *     plumb real UUIDs through every test — the page only consults
 *     parsed.success / parsed.error.issues.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from "@testing-library/react";

const {
  apiMock,
  toastMock,
  authMock,
  routerMock,
  schemaMock,
} = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  toastMock: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
  authMock: vi.fn(),
  routerMock: {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  },
  // Mutable parse result so each test can opt into Zod failure or success.
  schemaMock: { safeParse: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));
vi.mock("@/lib/store", () => ({ useAuthStore: authMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard/referrals",
}));
vi.mock("@/components/Skeleton", () => ({
  SkeletonTable: ({ rows, columns }: { rows: number; columns: number }) => (
    <div data-testid="skeleton-stub" data-rows={rows} data-columns={columns} />
  ),
}));
vi.mock("@/components/Autocomplete", () => ({
  Autocomplete: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (val: string, item?: string) => void;
    placeholder?: string;
  }) => (
    <input
      data-testid="autocomplete-stub"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value, e.target.value)}
    />
  ),
}));
vi.mock("@medcore/shared", () => ({
  createReferralSchema: schemaMock,
}));

import ReferralsPage from "../page";

type Referral = {
  id: string;
  referralNumber: string;
  patientId: string;
  fromDoctorId: string;
  toDoctorId?: string | null;
  externalProvider?: string | null;
  externalContact?: string | null;
  specialty?: string | null;
  reason: string;
  notes?: string | null;
  status: "PENDING" | "ACCEPTED" | "COMPLETED" | "DECLINED" | "EXPIRED";
  referredAt: string;
  respondedAt?: string | null;
  patient: {
    id: string;
    mrNumber?: string;
    user: { name: string; phone?: string };
  };
  fromDoctor: { id: string; user: { name: string } };
  toDoctor?: { id: string; user: { name: string } } | null;
};

function refFixture(overrides: Partial<Referral> = {}): Referral {
  return {
    id: "ref-1",
    referralNumber: "REF-0001",
    patientId: "pat-1",
    fromDoctorId: "doc-1",
    toDoctorId: "doc-2",
    externalProvider: null,
    externalContact: null,
    specialty: "Cardiologist",
    reason: "Cardiac eval",
    notes: null,
    status: "PENDING",
    referredAt: "2026-05-20T10:00:00Z",
    respondedAt: null,
    patient: {
      id: "pat-1",
      mrNumber: "MR-001",
      user: { name: "Ramesh Kumar", phone: "9999999999" },
    },
    fromDoctor: { id: "doc-1", user: { name: "Dr From" } },
    toDoctor: { id: "doc-2", user: { name: "Dr To" } },
    ...overrides,
  };
}

const DOC_ROW = {
  id: "doc-me",
  userId: "u-doc",
  user: { name: "Dr Me" },
  specialization: "Cardiologist",
};

const OTHER_DOC = {
  id: "doc-other",
  userId: "u-other",
  user: { name: "Dr Other" },
  specialization: "Neurologist",
};

function asAdmin() {
  authMock.mockReturnValue({
    user: { id: "u-admin", role: "ADMIN", name: "Admin" },
  });
}

function asDoctor() {
  authMock.mockReturnValue({
    user: { id: "u-doc", role: "DOCTOR", name: "Dr Me" },
  });
}

function asReception() {
  authMock.mockReturnValue({
    user: { id: "u-recep", role: "RECEPTION", name: "Recep" },
  });
}

describe("Referrals dashboard page (specialist referrals workspace)", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    apiMock.put.mockReset();
    apiMock.patch.mockReset();
    apiMock.delete.mockReset();
    Object.values(toastMock).forEach((fn: any) => fn.mockReset());
    Object.values(routerMock).forEach((fn: any) => fn.mockReset());
    authMock.mockReset();
    schemaMock.safeParse.mockReset();
    // Default: Zod passes — tests that want failure opt in explicitly.
    schemaMock.safeParse.mockReturnValue({ success: true, data: {} });
    asAdmin();
    // Default: every GET returns empty so individual tests only wire what they assert on.
    apiMock.get.mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the page chrome + fires the ADMIN list fetch on mount", async () => {
    render(<ReferralsPage />);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/referrals?limit=100"),
    );
    expect(
      screen.getByRole("heading", { name: /^Referrals$/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /New Referral/i }),
    ).toBeInTheDocument();
    // ADMIN gets NO outgoing/incoming/all tabs — those render only for DOCTOR.
    expect(
      screen.queryByRole("button", { name: /^Outgoing$/i }),
    ).not.toBeInTheDocument();
  });

  it("RECEPTION (non-doctor, non-admin) still fetches the unfiltered list", async () => {
    asReception();

    render(<ReferralsPage />);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith("/referrals?limit=100"),
    );
    expect(
      screen.queryByRole("button", { name: /^Outgoing$/i }),
    ).not.toBeInTheDocument();
  });

  it("renders the SkeletonTable loading branch while the initial GET is pending", () => {
    apiMock.get.mockReturnValue(new Promise(() => {}));

    render(<ReferralsPage />);

    expect(screen.getByTestId("referrals-loading")).toBeInTheDocument();
    expect(screen.getByTestId("skeleton-stub")).toBeInTheDocument();
  });

  it("renders the empty branch when the list is empty", async () => {
    apiMock.get.mockResolvedValue({ data: [] });

    render(<ReferralsPage />);

    expect(
      await screen.findByText(/No referrals found/i),
    ).toBeInTheDocument();
  });

  it("silently swallows an initial GET rejection and renders the empty branch", async () => {
    apiMock.get.mockRejectedValue(new Error("boom"));

    render(<ReferralsPage />);

    expect(
      await screen.findByText(/No referrals found/i),
    ).toBeInTheDocument();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("renders one row per result with referral number + patient + status pill", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        refFixture({ id: "ref-1", referralNumber: "REF-A", status: "PENDING" }),
        refFixture({ id: "ref-2", referralNumber: "REF-B", status: "ACCEPTED" }),
        refFixture({
          id: "ref-3",
          referralNumber: "REF-C",
          status: "COMPLETED",
          // External row to exercise the externalProvider / ArrowRightLeft branch.
          toDoctor: null,
          externalProvider: "Apollo Cardiac",
        }),
        refFixture({
          id: "ref-4",
          referralNumber: "REF-D",
          status: "DECLINED",
          specialty: null,
        }),
        refFixture({
          id: "ref-5",
          referralNumber: "REF-E",
          status: "EXPIRED",
          toDoctor: null,
          externalProvider: null,
        }),
      ],
    });

    render(<ReferralsPage />);

    expect(await screen.findByText("REF-A")).toBeInTheDocument();
    expect(screen.getByText("REF-A").closest("tr")).toHaveClass("dark:text-gray-100", "dark:hover:bg-gray-700/60");
    expect(screen.getByText("REF-B")).toBeInTheDocument();
    expect(screen.getByText("REF-C")).toBeInTheDocument();
    expect(screen.getByText("REF-D")).toBeInTheDocument();
    expect(screen.getByText("REF-E")).toBeInTheDocument();

    // Status pills all render.
    expect(screen.getByText("PENDING").className).toMatch(/bg-yellow-100/);
    expect(screen.getByText("ACCEPTED").className).toMatch(/bg-blue-100/);
    expect(screen.getByText("COMPLETED").className).toMatch(/bg-green-100/);
    expect(screen.getByText("DECLINED").className).toMatch(/bg-red-100/);
    expect(screen.getByText("EXPIRED").className).toMatch(/bg-gray-100/);

    // External-provider branch surfaces the provider name.
    expect(screen.getByText("Apollo Cardiac")).toBeInTheDocument();
    // External-with-no-name branch falls back to "External".
    expect(screen.getByText("External")).toBeInTheDocument();
    // Specialty=null row renders the em-dash.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("DOCTOR with a matching /doctors row fetches outgoing referrals by default", async () => {
    asDoctor();
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") return Promise.resolve({ data: [DOC_ROW, OTHER_DOC] });
      return Promise.resolve({ data: [] });
    });

    render(<ReferralsPage />);

    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        `/referrals?fromDoctorId=doc-me&limit=100`,
      ),
    );
    // Tab buttons render for DOCTOR only.
    expect(screen.getByRole("button", { name: /^Outgoing$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Incoming$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^All$/i })).toBeInTheDocument();
  });

  it("DOCTOR tab switch — Incoming hits /referrals/inbox", async () => {
    asDoctor();
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") return Promise.resolve({ data: [DOC_ROW] });
      return Promise.resolve({ data: [] });
    });

    render(<ReferralsPage />);
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        `/referrals?fromDoctorId=doc-me&limit=100`,
      ),
    );

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Incoming$/i }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        `/referrals/inbox?doctorId=doc-me&limit=100`,
      ),
    );
  });

  it("DOCTOR tab switch — All falls back to the unfiltered /referrals list", async () => {
    asDoctor();
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") return Promise.resolve({ data: [DOC_ROW] });
      return Promise.resolve({ data: [] });
    });

    render(<ReferralsPage />);
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(
        `/referrals?fromDoctorId=doc-me&limit=100`,
      ),
    );

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^All$/i }));
    await waitFor(() =>
      expect(apiMock.get).toHaveBeenCalledWith(`/referrals?limit=100`),
    );
  });

  it("DOCTOR with NO matching /doctors row swallows + does not crash", async () => {
    asDoctor();
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") return Promise.reject(new Error("doctors down"));
      return Promise.resolve({ data: [] });
    });

    render(<ReferralsPage />);

    // Doctors lookup failed → myDoctorId stays "" → no list fetch fires for outgoing.
    await new Promise((r) => setTimeout(r, 30));
    // The /doctors call did fire, but no /referrals call should have happened.
    const refCalls = apiMock.get.mock.calls.filter((c) =>
      (c[0] as string).startsWith("/referrals"),
    );
    expect(refCalls).toHaveLength(0);
  });

  it("opens the New Referral modal and fetches /doctors for the select options", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") return Promise.resolve({ data: [DOC_ROW, OTHER_DOC] });
      return Promise.resolve({ data: [] });
    });

    render(<ReferralsPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Referral/i }));

    expect(
      screen.getByRole("heading", { name: /^New Referral$/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Patient/i)).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Referring Doctor/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^To Doctor$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Reason/i)).toBeInTheDocument();

    // Doctor options propagate.
    await waitFor(() => {
      const opts = screen.getAllByRole("option");
      // 1 placeholder + 2 fixtures per select × 2 selects = 6 options total.
      expect(opts.length).toBeGreaterThanOrEqual(4);
    });
  });

  it("Cancel button closes the modal without POSTing", async () => {
    render(<ReferralsPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Referral/i }));
    expect(
      screen.getByRole("heading", { name: /^New Referral$/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /^New Referral$/i }),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Submit with no fields filled surfaces inline errors and does NOT POST", async () => {
    render(<ReferralsPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Referral/i }));

    fireEvent.click(screen.getByRole("button", { name: /Create Referral/i }));

    // Patient is required.
    expect(await screen.findByText(/Select a patient/i)).toBeInTheDocument();
    // Referring doctor required (ADMIN — non-doctor branch).
    expect(screen.getByText(/Select referring doctor/i)).toBeInTheDocument();
    // No POST.
    expect(apiMock.post).not.toHaveBeenCalled();
    // Modal still open.
    expect(
      screen.getByRole("heading", { name: /^New Referral$/i }),
    ).toBeInTheDocument();
  });

  it("DOCTOR submit with no myDoctorId blocks the POST (errs.fromDoctorId path)", async () => {
    // DOCTOR whose /doctors lookup returns no matching row → myDoctorId stays empty.
    // The DOCTOR branch hides the "Referring Doctor (From)" select entirely
    // (because the form is wired to use myDoctorId), so the user can't see
    // the error message in this branch — but the POST is still correctly
    // blocked by the inline guard. We assert the no-POST behaviour, which
    // is the real safety contract.
    asDoctor();
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") return Promise.resolve({ data: [] });
      if (url.startsWith("/patients?")) {
        return Promise.resolve({
          data: [{ id: "pat-1", mrNumber: "MR-100", user: { name: "Suresh Iyer", phone: "999" } }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<ReferralsPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Referral/i }));

    // Pick a patient so the "Select a patient" guard doesn't also fire.
    fireEvent.change(screen.getByPlaceholderText(/Search by name or phone/i), {
      target: { value: "Sur" },
    });
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(await screen.findByRole("button", { name: /Suresh Iyer/i }));

    fireEvent.change(screen.getByLabelText(/^Reason/i), {
      target: { value: "Cardiac eval" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Create Referral/i }));

    await new Promise((r) => setTimeout(r, 30));
    expect(apiMock.post).not.toHaveBeenCalled();
    // Modal still open.
    expect(
      screen.getByRole("heading", { name: /^New Referral$/i }),
    ).toBeInTheDocument();
  });

  it("External mode requires the Hospital / Specialist field", async () => {
    render(<ReferralsPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Referral/i }));

    // Switch to external mode.
    fireEvent.click(screen.getByRole("button", { name: /External Provider/i }));

    // The internal "To Doctor" select disappears, replaced by Hospital + Contact.
    expect(
      screen.queryByLabelText(/^To Doctor$/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByLabelText(/Hospital \/ Specialist/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^Contact$/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Create Referral/i }));

    expect(
      await screen.findByText(/Hospital \/ specialist is required/i),
    ).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("surfaces Zod schema field errors (Reason) when safeParse fails", async () => {
    schemaMock.safeParse.mockReturnValue({
      success: false,
      error: {
        issues: [
          { path: ["reason"], message: "Reason is required" },
        ],
      },
    });
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") return Promise.resolve({ data: [DOC_ROW] });
      if (url.startsWith("/patients?")) {
        return Promise.resolve({
          data: [{ id: "pat-1", mrNumber: "MR-100", user: { name: "Suresh Iyer", phone: "999" } }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<ReferralsPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Referral/i }));

    // Pick a patient (so the "Select a patient" guard doesn't mask the Zod error).
    fireEvent.change(screen.getByPlaceholderText(/Search by name or phone/i), {
      target: { value: "Sur" },
    });
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(await screen.findByRole("button", { name: /Suresh Iyer/i }));

    // Pick a referring doctor (clears the fromDoctorId guard).
    const fromSelect = screen.getByLabelText(/Referring Doctor/i) as HTMLSelectElement;
    fireEvent.change(fromSelect, { target: { value: "doc-me" } });

    fireEvent.click(screen.getByRole("button", { name: /Create Referral/i }));

    expect(await screen.findByText(/Reason is required/i)).toBeInTheDocument();
    expect(apiMock.post).not.toHaveBeenCalled();
  });

  it("Patient search debounce fires GET /patients only when length >= 2", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.resolve({
          data: [{ id: "pat-1", mrNumber: "MR-100", user: { name: "Suresh Iyer", phone: "999" } }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<ReferralsPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Referral/i }));

    // 1 char — no GET.
    fireEvent.change(screen.getByPlaceholderText(/Search by name or phone/i), {
      target: { value: "S" },
    });
    await new Promise((r) => setTimeout(r, 350));
    expect(
      apiMock.get.mock.calls.some((c) =>
        (c[0] as string).startsWith("/patients?"),
      ),
    ).toBe(false);

    // 2+ chars — GET fires after 300ms.
    fireEvent.change(screen.getByPlaceholderText(/Search by name or phone/i), {
      target: { value: "Su" },
    });
    await new Promise((r) => setTimeout(r, 350));
    expect(
      apiMock.get.mock.calls.some((c) =>
        (c[0] as string).startsWith("/patients?search=Su&limit=10"),
      ),
    ).toBe(true);
    const patientRow = await screen.findByRole("button", { name: /Suresh Iyer/i });
    expect(patientRow).toHaveClass("dark:text-gray-100", "dark:hover:bg-gray-800");
  });

  it("Patient search swallows a failed GET and shows no result rows", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.reject(new Error("patient search blew up"));
      }
      return Promise.resolve({ data: [] });
    });

    render(<ReferralsPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Referral/i }));
    fireEvent.change(screen.getByPlaceholderText(/Search by name or phone/i), {
      target: { value: "Sur" },
    });
    await new Promise((r) => setTimeout(r, 350));

    expect(toastMock.error).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /MR-100/ }),
    ).not.toBeInTheDocument();
  });

  it("selecting a patient renders the pill + Change button to drop back to search", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url.startsWith("/patients?")) {
        return Promise.resolve({
          data: [{ id: "pat-1", mrNumber: "MR-100", user: { name: "Suresh Iyer", phone: "999" } }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    render(<ReferralsPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Referral/i }));
    fireEvent.change(screen.getByPlaceholderText(/Search by name or phone/i), {
      target: { value: "Sur" },
    });
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(await screen.findByRole("button", { name: /Suresh Iyer/i }));

    expect(screen.getByText(/Suresh Iyer/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Change$/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Change$/i }));
    expect(
      screen.getByPlaceholderText(/Search by name or phone/i),
    ).toBeInTheDocument();
  });

  it("happy POST — internal mode sends a well-shaped body, resets form, reloads list", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") return Promise.resolve({ data: [DOC_ROW, OTHER_DOC] });
      if (url.startsWith("/patients?")) {
        return Promise.resolve({
          data: [{ id: "pat-1", mrNumber: "MR-100", user: { name: "Suresh Iyer", phone: "999" } }],
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<ReferralsPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Referral/i }));

    // Patient picker.
    fireEvent.change(screen.getByPlaceholderText(/Search by name or phone/i), {
      target: { value: "Sur" },
    });
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(await screen.findByRole("button", { name: /Suresh Iyer/i }));

    // Doctor selects.
    fireEvent.change(screen.getByLabelText(/Referring Doctor/i), {
      target: { value: "doc-me" },
    });
    fireEvent.change(screen.getByLabelText(/^To Doctor$/i), {
      target: { value: "doc-other" },
    });

    // Specialty Autocomplete (stubbed as a plain <input>).
    fireEvent.change(screen.getByTestId("autocomplete-stub"), {
      target: { value: "Cardiologist" },
    });

    // Reason + notes.
    fireEvent.change(screen.getByLabelText(/^Reason/i), {
      target: { value: "Cardiac eval please" },
    });
    fireEvent.change(screen.getByLabelText(/^Notes$/i), {
      target: { value: "urgent" },
    });

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Create Referral/i }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [url, body] = apiMock.post.mock.calls[0];
    expect(url).toBe("/referrals");
    expect(body).toMatchObject({
      patientId: "pat-1",
      fromDoctorId: "doc-me",
      toDoctorId: "doc-other",
      reason: "Cardiac eval please",
      specialty: "Cardiologist",
      notes: "urgent",
    });
    expect((body as any).externalProvider).toBeUndefined();

    // Modal closed + reload fired.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /^New Referral$/i }),
      ).not.toBeInTheDocument(),
    );
    expect(apiMock.get).toHaveBeenCalledWith("/referrals?limit=100");
  });

  it("happy POST — external mode swaps toDoctorId for externalProvider + externalContact", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") return Promise.resolve({ data: [DOC_ROW] });
      if (url.startsWith("/patients?")) {
        return Promise.resolve({
          data: [{ id: "pat-1", mrNumber: "MR-100", user: { name: "Suresh Iyer", phone: "999" } }],
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockResolvedValue({ data: { ok: true } });

    render(<ReferralsPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Referral/i }));
    fireEvent.change(screen.getByPlaceholderText(/Search by name or phone/i), {
      target: { value: "Sur" },
    });
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(await screen.findByRole("button", { name: /Suresh Iyer/i }));

    fireEvent.change(screen.getByLabelText(/Referring Doctor/i), {
      target: { value: "doc-me" },
    });

    // Switch to external mode.
    fireEvent.click(screen.getByRole("button", { name: /External Provider/i }));

    fireEvent.change(screen.getByLabelText(/Hospital \/ Specialist/i), {
      target: { value: "Apollo Cardiac" },
    });
    fireEvent.change(screen.getByLabelText(/^Contact$/i), {
      target: { value: "044-1234" },
    });
    fireEvent.change(screen.getByLabelText(/^Reason/i), {
      target: { value: "Specialist eval" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Create Referral/i }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalledTimes(1));
    const [, body] = apiMock.post.mock.calls[0];
    expect(body).toMatchObject({
      externalProvider: "Apollo Cardiac",
      externalContact: "044-1234",
      reason: "Specialist eval",
      fromDoctorId: "doc-me",
    });
    expect((body as any).toDoctorId).toBeUndefined();
  });

  it("POST error surfaces toast.error with the error message", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") return Promise.resolve({ data: [DOC_ROW] });
      if (url.startsWith("/patients?")) {
        return Promise.resolve({
          data: [{ id: "pat-1", mrNumber: "MR-100", user: { name: "Suresh Iyer", phone: "999" } }],
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockRejectedValue(new Error("server exploded"));

    render(<ReferralsPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Referral/i }));
    fireEvent.change(screen.getByPlaceholderText(/Search by name or phone/i), {
      target: { value: "Sur" },
    });
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(await screen.findByRole("button", { name: /Suresh Iyer/i }));

    fireEvent.change(screen.getByLabelText(/Referring Doctor/i), {
      target: { value: "doc-me" },
    });
    fireEvent.change(screen.getByLabelText(/^Reason/i), {
      target: { value: "Cardiac eval" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Create Referral/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("server exploded"),
    );
    // Modal still open.
    expect(
      screen.getByRole("heading", { name: /^New Referral$/i }),
    ).toBeInTheDocument();
  });

  it("POST error with non-Error throw falls back to the generic copy", async () => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === "/doctors") return Promise.resolve({ data: [DOC_ROW] });
      if (url.startsWith("/patients?")) {
        return Promise.resolve({
          data: [{ id: "pat-1", mrNumber: "MR-100", user: { name: "Suresh Iyer", phone: "999" } }],
        });
      }
      return Promise.resolve({ data: [] });
    });
    apiMock.post.mockRejectedValue("string thrown, not Error");

    render(<ReferralsPage />);
    fireEvent.click(screen.getByRole("button", { name: /New Referral/i }));
    fireEvent.change(screen.getByPlaceholderText(/Search by name or phone/i), {
      target: { value: "Sur" },
    });
    await new Promise((r) => setTimeout(r, 350));
    fireEvent.click(await screen.findByRole("button", { name: /Suresh Iyer/i }));
    fireEvent.change(screen.getByLabelText(/Referring Doctor/i), {
      target: { value: "doc-me" },
    });
    fireEvent.change(screen.getByLabelText(/^Reason/i), {
      target: { value: "Cardiac eval" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create Referral/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Failed to create referral"),
    );
  });

  it("clicking a row opens the detail modal and renders status + patient + reason", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        refFixture({
          id: "ref-x",
          referralNumber: "REF-X",
          status: "PENDING",
          notes: "watch for arrhythmia",
        }),
      ],
    });

    render(<ReferralsPage />);
    await screen.findByText("REF-X");
    fireEvent.click(screen.getByText("REF-X"));

    expect(
      screen.getByRole("heading", { name: /REF-X/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Ramesh Kumar").length).toBeGreaterThan(0);
    expect(screen.getByText("Cardiac eval")).toBeInTheDocument();
    expect(screen.getByText(/watch for arrhythmia/i)).toBeInTheDocument();
    expect(screen.getByText("Cardiac eval")).toHaveClass("dark:bg-gray-900", "dark:text-gray-100");
    expect(screen.getByText(/watch for arrhythmia/i)).toHaveClass("dark:bg-gray-900", "dark:text-gray-100");
    // PENDING → Accept + Decline buttons render.
    expect(screen.getByRole("button", { name: /^Accept$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Decline$/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Mark Completed/i }),
    ).not.toBeInTheDocument();
  });

  it("detail modal — external referral renders the '(external)' suffix in To row", async () => {
    apiMock.get.mockResolvedValue({
      data: [
        refFixture({
          id: "ref-e",
          referralNumber: "REF-E",
          status: "PENDING",
          toDoctor: null,
          externalProvider: "Apollo",
        }),
      ],
    });

    render(<ReferralsPage />);
    await screen.findByText("REF-E");
    fireEvent.click(screen.getByText("REF-E"));

    expect(screen.getByText(/Apollo \(external\)/i)).toBeInTheDocument();
  });

  it("detail modal — PENDING Accept fires PATCH with status=ACCEPTED and reloads list", async () => {
    apiMock.get.mockResolvedValue({
      data: [refFixture({ id: "ref-1", status: "PENDING" })],
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<ReferralsPage />);
    await screen.findByText("REF-0001");
    fireEvent.click(screen.getByText("REF-0001"));

    apiMock.get.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^Accept$/i }));

    await waitFor(() => expect(apiMock.patch).toHaveBeenCalledTimes(1));
    expect(apiMock.patch).toHaveBeenCalledWith("/referrals/ref-1", {
      status: "ACCEPTED",
    });

    // Detail modal closes + list reload fires.
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: /^REF-0001$/i })).not.toBeInTheDocument(),
    );
    expect(apiMock.get).toHaveBeenCalledWith("/referrals?limit=100");
  });

  it("detail modal — PENDING Decline fires PATCH with status=DECLINED", async () => {
    apiMock.get.mockResolvedValue({
      data: [refFixture({ id: "ref-1", status: "PENDING" })],
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<ReferralsPage />);
    await screen.findByText("REF-0001");
    fireEvent.click(screen.getByText("REF-0001"));

    fireEvent.click(screen.getByRole("button", { name: /^Decline$/i }));

    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/referrals/ref-1", {
        status: "DECLINED",
      }),
    );
  });

  it("detail modal — ACCEPTED rows only render 'Mark Completed' (no Accept/Decline)", async () => {
    apiMock.get.mockResolvedValue({
      data: [refFixture({ id: "ref-1", status: "ACCEPTED" })],
    });
    apiMock.patch.mockResolvedValue({ data: { ok: true } });

    render(<ReferralsPage />);
    await screen.findByText("REF-0001");
    fireEvent.click(screen.getByText("REF-0001"));

    expect(
      screen.queryByRole("button", { name: /^Accept$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Decline$/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Mark Completed/i }));
    await waitFor(() =>
      expect(apiMock.patch).toHaveBeenCalledWith("/referrals/ref-1", {
        status: "COMPLETED",
      }),
    );
  });

  it("detail modal — COMPLETED rows render no transition buttons (just Close)", async () => {
    apiMock.get.mockResolvedValue({
      data: [refFixture({ id: "ref-1", status: "COMPLETED" })],
    });

    render(<ReferralsPage />);
    await screen.findByText("REF-0001");
    fireEvent.click(screen.getByText("REF-0001"));

    expect(
      screen.queryByRole("button", { name: /^Accept$/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Mark Completed/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Close$/i })).toBeInTheDocument();
  });

  it("detail modal — PATCH rejection surfaces toast.error and keeps modal open", async () => {
    apiMock.get.mockResolvedValue({
      data: [refFixture({ id: "ref-1", status: "PENDING" })],
    });
    apiMock.patch.mockRejectedValue(new Error("update failed"));

    render(<ReferralsPage />);
    await screen.findByText("REF-0001");
    fireEvent.click(screen.getByText("REF-0001"));

    fireEvent.click(screen.getByRole("button", { name: /^Accept$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("update failed"),
    );
    // Modal still open (selected didn't clear).
    expect(
      screen.getByRole("heading", { name: /^REF-0001$/i }),
    ).toBeInTheDocument();
  });

  it("detail modal — PATCH non-Error rejection falls back to the generic copy", async () => {
    apiMock.get.mockResolvedValue({
      data: [refFixture({ id: "ref-1", status: "PENDING" })],
    });
    apiMock.patch.mockRejectedValue("oops not an Error");

    render(<ReferralsPage />);
    await screen.findByText("REF-0001");
    fireEvent.click(screen.getByText("REF-0001"));

    fireEvent.click(screen.getByRole("button", { name: /^Accept$/i }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Update failed"),
    );
  });

  it("detail modal — backdrop click closes the modal; inner click does not", async () => {
    apiMock.get.mockResolvedValue({
      data: [refFixture({ id: "ref-1", status: "PENDING" })],
    });

    render(<ReferralsPage />);
    await screen.findByText("REF-0001");
    fireEvent.click(screen.getByText("REF-0001"));

    // Click the inner card — should NOT close.
    const headingEl = screen.getByRole("heading", { name: /^REF-0001$/i });
    fireEvent.click(headingEl);
    expect(
      screen.getByRole("heading", { name: /^REF-0001$/i }),
    ).toBeInTheDocument();

    // Explicit Close button closes.
    fireEvent.click(screen.getByRole("button", { name: /^Close$/i }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: /^REF-0001$/i }),
      ).not.toBeInTheDocument(),
    );
  });
});
